import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";

import {
  ColdStorageError,
  assertNoSymlinkComponents,
  pathExists,
  safeJoin,
} from "./archive-core.mjs";

export async function publishImmutableJson(root, relativePath, value, options = {}) {
  const targetPath = portableTarget(root, relativePath);
  const data = canonicalJson(value);
  await assertNoSymlinkComponents(root, targetPath);

  if (await pathExists(targetPath)) {
    const existing = await readRegularJson(root, relativePath);
    if (canonicalJson(existing) !== data) {
      throw new ColdStorageError(
        options.conflictCode || "IMMUTABLE_CONFLICT",
        `Immutable JSON already exists with different content: ${relativePath}`,
      );
    }
    return {
      created: false,
      relativePath,
      sha256: hashText(data),
      durability: "existing",
    };
  }

  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(root, targetPath);
  const temporaryPath = `${targetPath}.tmp-${options.runId || randomUUID()}`;
  let published = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (typeof options.beforePublish === "function") {
      await options.beforePublish({ targetPath, temporaryPath });
    }
    await rename(temporaryPath, targetPath);
    published = true;
    const readBack = await readFile(targetPath, "utf8");
    if (readBack !== data) {
      throw new ColdStorageError(
        "ATOMIC_READBACK_MISMATCH",
        `Published JSON failed read-back verification: ${relativePath}`,
      );
    }
    const directorySynced = await syncDirectory(path.dirname(targetPath));
    return {
      created: true,
      relativePath,
      sha256: hashText(data),
      durability: directorySynced ? "file-and-directory" : "file-only",
    };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if (published && error?.code === "ATOMIC_READBACK_MISMATCH") {
      await rm(targetPath, { force: true });
    }
    throw error;
  }
}

export async function publishMutableJson(root, relativePath, value, options = {}) {
  const targetPath = portableTarget(root, relativePath);
  const data = canonicalJson(value);
  await assertNoSymlinkComponents(root, targetPath);

  let previous = null;
  if (await pathExists(targetPath)) {
    if (options.expectedAbsent) {
      throw new ColdStorageError(
        options.concurrentCode || "MUTABLE_CONCURRENT_UPDATE",
        `Mutable bridge file appeared after it was planned: ${relativePath}`,
      );
    }
    const info = await lstat(targetPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ColdStorageError(
        "BRIDGE_FILE_TYPE_INVALID",
        `Mutable bridge file must be a regular file: ${relativePath}`,
      );
    }
    previous = await readFile(targetPath, "utf8");
    if (
      options.expectedCurrentSha256 &&
      hashText(previous) !== options.expectedCurrentSha256
    ) {
      throw new ColdStorageError(
        options.concurrentCode || "MUTABLE_CONCURRENT_UPDATE",
        `Mutable bridge file changed after it was read: ${relativePath}`,
      );
    }
    if (previous === data) {
      return {
        created: false,
        changed: false,
        relativePath,
        sha256: hashText(data),
        durability: "existing",
      };
    }
  } else if (options.expectedCurrentSha256) {
    throw new ColdStorageError(
      options.concurrentCode || "MUTABLE_CONCURRENT_UPDATE",
      `Mutable bridge file disappeared after it was read: ${relativePath}`,
    );
  }

  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(root, targetPath);
  const temporaryPath = `${targetPath}.tmp-${options.runId || randomUUID()}`;
  let published = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (typeof options.beforePublish === "function") {
      await options.beforePublish({ targetPath, temporaryPath, previous });
    }
    if (options.expectedAbsent && (await pathExists(targetPath))) {
      throw new ColdStorageError(
        options.concurrentCode || "MUTABLE_CONCURRENT_UPDATE",
        `Mutable bridge file appeared before commit: ${relativePath}`,
      );
    }
    if (options.expectedCurrentSha256) {
      let current;
      try {
        current = await readFile(targetPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new ColdStorageError(
            options.concurrentCode || "MUTABLE_CONCURRENT_UPDATE",
            `Mutable bridge file disappeared before commit: ${relativePath}`,
          );
        }
        throw error;
      }
      if (hashText(current) !== options.expectedCurrentSha256) {
        throw new ColdStorageError(
          options.concurrentCode || "MUTABLE_CONCURRENT_UPDATE",
          `Mutable bridge file changed before commit: ${relativePath}`,
        );
      }
    }
    await rename(temporaryPath, targetPath);
    published = true;
    const readBack = await readFile(targetPath, "utf8");
    if (readBack !== data) {
      throw new ColdStorageError(
        "ATOMIC_READBACK_MISMATCH",
        `Published mutable JSON failed read-back verification: ${relativePath}`,
      );
    }
    const directorySynced = await syncDirectory(path.dirname(targetPath));
    return {
      created: previous === null,
      changed: true,
      relativePath,
      sha256: hashText(data),
      durability: directorySynced ? "file-and-directory" : "file-only",
    };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if (published && error?.code === "ATOMIC_READBACK_MISMATCH" && previous !== null) {
      const rollbackPath = `${targetPath}.rollback-${randomUUID()}`;
      try {
        const rollback = await open(rollbackPath, "wx", 0o600);
        try {
          await rollback.writeFile(previous, "utf8");
          await rollback.sync();
        } finally {
          await rollback.close();
        }
        await rename(rollbackPath, targetPath);
      } finally {
        await rm(rollbackPath, { force: true });
      }
    }
    throw error;
  }
}

export async function readRegularJson(root, relativePath) {
  const filePath = portableTarget(root, relativePath);
  await assertNoSymlinkComponents(root, filePath);
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ColdStorageError("BRIDGE_FILE_MISSING", `Bridge file is missing: ${relativePath}`);
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ColdStorageError(
      "BRIDGE_FILE_TYPE_INVALID",
      `Bridge file must be a regular file: ${relativePath}`,
    );
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ColdStorageError("BRIDGE_JSON_INVALID", `Invalid JSON: ${relativePath}`);
    }
    throw error;
  }
}

export async function inspectFilesystem(root) {
  const fileSystem = await stat(root, { bigint: true });
  let detail = `device=${fileSystem.dev.toString()}`;
  const warnings = [];
  try {
    const fileSystemStats = await statfs(root, { bigint: true });
    detail +=
      `, type=0x${fileSystemStats.type.toString(16)}` +
      `, blockSize=${fileSystemStats.bsize.toString()}`;
  } catch (error) {
    warnings.push({
      code: "FILESYSTEM_TYPE_UNAVAILABLE",
      message: `Filesystem type could not be inspected: ${error.message}`,
    });
  }
  warnings.push({
    code: "FILESYSTEM_DURABILITY_NOT_PROBED",
    message:
      "Read-only doctor does not perform a write/rename/fsync probe; applied publications still verify file read-back.",
  });
  const result = {
    writableCheck: true,
    directoryFsyncProbed: false,
    detail,
    warnings,
  };
  try {
    await access(root, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    result.writableCheck = false;
    result.detail = error.message;
  }
  return result;
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

export function hashCanonicalJson(value) {
  return hashText(canonicalJson(value));
}

export function resolvePortablePath(root, relativePath) {
  return portableTarget(root, relativePath);
}

function portableTarget(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new ColdStorageError(
      "PORTABLE_PATH_INVALID",
      `Bridge path must be portable and relative: ${relativePath}`,
    );
  }
  return safeJoin(root, ...relativePath.split("/"));
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}
