import { opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  ColdStorageError,
  assertNoSymlinkComponents,
  hashFile,
  pathExists,
  safeJoin,
  sessionIdFromFilename,
} from "./archive-core.mjs";
import {
  extractNativeSessionId,
  pushSessionSnapshot,
  sessionObjectPath,
} from "./session-snapshot.mjs";

export async function migrateLayout(config, sourceRoot, layout, options = {}) {
  if (!new Set(["codexbridge", "v01"]).has(layout)) {
    throw new ColdStorageError("MIGRATION_LAYOUT_UNKNOWN", `Unknown migration layout: ${layout}`);
  }
  if (!sourceRoot) {
    throw new ColdStorageError("MIGRATION_SOURCE_REQUIRED", "Migration requires --source <path>.");
  }
  const root = path.resolve(sourceRoot);
  const inventory =
    layout === "codexbridge"
      ? await inventoryCodexBridge(config, root)
      : await inventoryV01(config, root);
  const plan = {
    ok: inventory.failures.length === 0,
    action: "migration-plan",
    apply: false,
    layout,
    sourceRoot: root,
    counts: {
      discovered: inventory.discovered,
      importable: inventory.objects.length,
      duplicates: inventory.duplicates,
      failed: inventory.failures.length,
      bytes: inventory.objects.reduce((sum, object) => sum + object.sizeBytes, 0),
    },
    failures: inventory.failures,
    sourceRefs: inventory.sourceRefs,
  };
  if (!options.apply) return plan;
  if (inventory.failures.length > 0 && !options.allowPartial) {
    throw new ColdStorageError(
      "MIGRATION_INVENTORY_INCOMPLETE",
      `Migration inventory has ${inventory.failures.length} failure(s).`,
      { failures: inventory.failures },
    );
  }
  const result = await pushSessionSnapshot(config, {
    apply: true,
    operation: "migration",
    inventoryOverride: { objects: inventory.objects, errors: inventory.failures },
    failOnInventoryError: !options.allowPartial,
    inputRefs: inventory.sourceRefs.length > 0 ? inventory.sourceRefs : [`legacy/${layout}/inventory`],
    now: options.now,
    runId: options.runId,
  });
  return { ...plan, ok: result.ok, apply: true, publication: result };
}

export async function inventoryCodexBridge(config, root) {
  if (!(await pathExists(root))) {
    throw new ColdStorageError("MIGRATION_SOURCE_MISSING", `CodexBridge source is missing: ${root}`);
  }
  const candidates = [];
  for await (const file of walkRegularFiles(root)) {
    const relative = portableRelative(root, file);
    if (!relative.split("/").includes("payload")) continue;
    if (!isRollout(path.basename(file))) continue;
    candidates.push({ file, relative });
  }
  return inventoryCandidates(config, candidates, "codexbridge");
}

export async function inventoryV01(config, root) {
  const catalogPath = safeJoin(root, "catalog-v1.json");
  let catalog;
  try {
    catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ColdStorageError("MIGRATION_CATALOG_MISSING", `Missing v0.1 catalog: ${catalogPath}`);
    }
    if (error instanceof SyntaxError) {
      throw new ColdStorageError("MIGRATION_CATALOG_JSON_INVALID", `Invalid v0.1 catalog: ${catalogPath}`);
    }
    throw error;
  }
  if (catalog?.version !== 1 || !Array.isArray(catalog.entries)) {
    throw new ColdStorageError("MIGRATION_CATALOG_INVALID", "Unsupported SessionHarbor v0.1 catalog.");
  }
  const candidates = [];
  const failures = [];
  for (const entry of catalog.entries) {
    try {
      const file = safeJoin(root, ...String(entry.targetRelativePath || "").split("/"));
      await assertNoSymlinkComponents(root, file);
      const digest = await hashFile(file);
      if (digest !== entry.sha256) {
        throw new ColdStorageError(
          "MIGRATION_SOURCE_HASH_MISMATCH",
          `Legacy target hash mismatch: ${entry.targetRelativePath}`,
        );
      }
      candidates.push({
        file,
        relative: String(entry.targetRelativePath),
        sessionId: entry.sessionId || null,
        knownHash: digest,
        knownSize: entry.sizeBytes,
        stableToken: entry.id || digest.slice(0, 16),
      });
    } catch (error) {
      failures.push({
        sourceRef: portableLegacyRef("v01", String(entry.targetRelativePath || "unknown")),
        code: error?.code || "MIGRATION_SOURCE_INVALID",
        message: error.message,
      });
    }
  }
  const result = await inventoryCandidates(config, candidates, "v01");
  result.discovered += failures.length;
  result.failures.push(...failures);
  result.sourceRefs.unshift("legacy/v01/catalog-v1.json");
  return result;
}

async function inventoryCandidates(config, candidates, layout) {
  const objects = [];
  const failures = [];
  const sourceRefs = [];
  const seen = new Set();
  let duplicates = 0;
  for (const candidate of candidates.sort((left, right) => left.relative.localeCompare(right.relative))) {
    const sourceRef = portableLegacyRef(layout, candidate.relative);
    sourceRefs.push(sourceRef);
    try {
      const before = await stat(candidate.file, { bigint: true });
      if (!before.isFile()) throw new ColdStorageError("MIGRATION_SOURCE_NOT_FILE", "Legacy source is not a file.");
      const sha256 = candidate.knownHash || (await hashFile(candidate.file));
      const after = await stat(candidate.file, { bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        throw new ColdStorageError("MIGRATION_SOURCE_CHANGED", "Legacy source changed during inventory.");
      }
      const format = candidate.file.endsWith(".jsonl.zst") ? "jsonl.zst" : "jsonl";
      const sessionId =
        candidate.sessionId ||
        sessionIdFromFilename(path.basename(candidate.file)) ||
        (await extractNativeSessionId(candidate.file, format));
      if (!sessionId) throw new ColdStorageError("SESSION_ID_NOT_FOUND", "Legacy rollout has no native session UUID.");
      const key = `${sessionId}\0${sha256}`;
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      const encoding = format === "jsonl.zst" ? "zstd" : "identity";
      const token = sanitizeToken(candidate.stableToken || sha256.slice(0, 16));
      const filename = sanitizeFilename(path.basename(candidate.file));
      objects.push({
        sessionId: sessionId.toLowerCase(),
        sourceKey: `archived_sessions/imported/${layout}/${token}-${filename}`,
        sourcePath: candidate.file,
        sha256,
        sizeBytes: Number(before.size),
        modifiedAt: new Date(Number(before.mtimeMs)).toISOString(),
        objectPath: sessionObjectPath(config.device.id, sha256, encoding),
        encoding,
      });
    } catch (error) {
      failures.push({ sourceRef, code: error?.code || "MIGRATION_SOURCE_INVALID", message: error.message });
    }
  }
  objects.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
  return {
    discovered: candidates.length,
    objects,
    duplicates,
    failures,
    sourceRefs: [...new Set(sourceRefs)],
  };
}

async function* walkRegularFiles(root) {
  const directory = await opendir(root);
  for await (const entry of directory) {
    if (entry.isSymbolicLink()) continue;
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walkRegularFiles(child);
    else if (entry.isFile()) yield child;
  }
}

function portableRelative(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ColdStorageError("MIGRATION_PATH_ESCAPE", `Legacy file escapes source root: ${file}`);
  }
  return relative.split(path.sep).join("/");
}

function portableLegacyRef(layout, relative) {
  const segments = String(relative)
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map(sanitizeToken);
  return `legacy/${layout}/${segments.join("/") || "unknown"}`;
}

function sanitizeFilename(value) {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "-");
  return isRollout(safe) ? safe : `rollout-${safe}.jsonl`;
}

function sanitizeToken(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function isRollout(filename) {
  return filename.startsWith("rollout-") && (filename.endsWith(".jsonl") || filename.endsWith(".jsonl.zst"));
}
