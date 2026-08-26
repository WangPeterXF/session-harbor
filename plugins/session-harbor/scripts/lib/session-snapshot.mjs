import { randomUUID } from "node:crypto";
import { open, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  ColdStorageError,
  assertDestinationIdentity,
  catalogEntryBelongsToDevice,
  copyVerified,
  hashFile,
  loadCatalog,
  pathExists,
  scanSessions,
} from "./archive-core.mjs";
import {
  canonicalJson,
  hashCanonicalJson,
  publishImmutableJson,
  publishMutableJson,
  readRegularJson,
  resolvePortablePath,
} from "./atomic-store.mjs";
import { CONTRACT_VERSION, validateContract } from "./bridge-contracts.mjs";
import { showDevice } from "./device-registry.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPPORTED_ROOTS = new Set(["sessions", "archived_sessions"]);
const MAX_SESSION_META_BYTES = 1024 * 1024;

export function sessionHeadPath(deviceId) {
  return `devices/${deviceId}/heads/sessions.json`;
}

export function sessionManifestPath(deviceId, snapshotId, at = new Date()) {
  return (
    `devices/${deviceId}/sessions/manifests/` +
    `${String(at.getUTCFullYear()).padStart(4, "0")}/` +
    `${String(at.getUTCMonth() + 1).padStart(2, "0")}/${snapshotId}.json`
  );
}

export function sessionObjectPath(deviceId, sha256, encoding = "identity") {
  const suffix = encoding === "zstd" ? ".jsonl.zst" : ".jsonl";
  return `devices/${deviceId}/sessions/objects/sha256/${sha256.slice(0, 2)}/${sha256}${suffix}`;
}

export async function inventoryLocalSessions(config, options = {}) {
  const scanned = await scanSessions(config, { nowMs: options.nowMs ?? Date.now() });
  const inventory = [];
  const errors = [];
  for (const item of scanned) {
    if (!SUPPORTED_ROOTS.has(item.sourceRoot)) continue;
    if (item.reason === "broken-link") {
      errors.push({
        sourceKey: item.sourceKey,
        code: "SESSION_SOURCE_BROKEN_LINK",
        message: "The local rollout link target is unavailable.",
      });
      continue;
    }
    if (options.eligibleOnly && !item.eligible) continue;
    try {
      const snapshot = await stableFileSnapshot(item.sourcePath);
      const sessionId = item.sessionId || (await extractNativeSessionId(item.sourcePath, item.format));
      if (!sessionId) {
        throw new ColdStorageError(
          "SESSION_ID_NOT_FOUND",
          `No native session UUID was found in ${item.sourceKey}.`,
        );
      }
      const sha256 = await stableHash(item.sourcePath, snapshot);
      const encoding = item.format === "jsonl.zst" ? "zstd" : "identity";
      inventory.push({
        sessionId,
        sourceKey: item.sourceKey,
        sourcePath: item.sourcePath,
        sha256,
        sizeBytes: Number(snapshot.size),
        modifiedAt: new Date(Number(snapshot.mtimeMs)).toISOString(),
        objectPath: sessionObjectPath(config.device.id, sha256, encoding),
        encoding,
      });
    } catch (error) {
      errors.push({
        sourceKey: item.sourceKey,
        code: error?.code || "SESSION_INVENTORY_FAILED",
        message: error.message,
      });
    }
  }
  inventory.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
  return { objects: inventory, errors };
}

export async function inventoryCatalogSessions(config, options = {}) {
  const catalog = await loadCatalog(config);
  const inventory = [];
  const errors = [];
  for (const entry of catalog.entries) {
    if (!SUPPORTED_ROOTS.has(entry.sourceRoot)) continue;
    if (!catalogEntryBelongsToDevice(config, entry)) continue;
    try {
      const encoding = entry.format === "jsonl.zst" ? "zstd" : "identity";
      const expectedObjectPath = sessionObjectPath(config.device.id, entry.sha256, encoding);
      if (entry.targetRelativePath !== expectedObjectPath) {
        throw new ColdStorageError(
          "SESSION_CATALOG_OBJECT_PATH_INVALID",
          `Catalog target is not the canonical device object: ${entry.sourceKey}`,
        );
      }
      const targetPath = resolvePortablePath(config.destination, entry.targetRelativePath);
      if (options.verifyObjects !== false) {
        const digest = await hashFile(targetPath);
        if (digest !== entry.sha256) {
          throw new ColdStorageError(
            "SESSION_OBJECT_HASH_MISMATCH",
            `Catalog object hash mismatch: ${entry.targetRelativePath}`,
          );
        }
      } else {
        const targetInfo = await stat(targetPath);
        if (!targetInfo.isFile() || Number(targetInfo.size) !== Number(entry.sizeBytes)) {
          throw new ColdStorageError(
            "SESSION_OBJECT_SIZE_MISMATCH",
            `Catalog object size mismatch: ${entry.targetRelativePath}`,
          );
        }
      }
      const modifiedAt = new Date(Number(entry.sourceMtimeMs));
      if (Number.isNaN(modifiedAt.getTime())) {
        throw new ColdStorageError(
          "SESSION_CATALOG_MTIME_INVALID",
          `Catalog source time is invalid: ${entry.sourceKey}`,
        );
      }
      inventory.push({
        sessionId: entry.sessionId,
        sourceKey: entry.sourceKey,
        sourcePath: null,
        sha256: entry.sha256,
        sizeBytes: Number(entry.sizeBytes),
        modifiedAt: modifiedAt.toISOString(),
        objectPath: entry.targetRelativePath,
        encoding,
      });
    } catch (error) {
      errors.push({
        sourceKey: entry.sourceKey,
        code: error?.code || "SESSION_CATALOG_INVENTORY_FAILED",
        message: error.message,
      });
    }
  }
  inventory.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
  return { objects: inventory, errors };
}

export async function readSessionHead(config, deviceId = config.device.id, options = {}) {
  const headPath = sessionHeadPath(deviceId);
  const absoluteHeadPath = resolvePortablePath(config.destination, headPath);
  if (!(await pathExists(absoluteHeadPath))) return null;
  const head = validateContract(await readRegularJson(config.destination, headPath), {
    expectedKind: "head-pointer",
  });
  if (head.deviceId !== deviceId || head.stream !== "sessions" || head.projectId !== null) {
    throw new ColdStorageError("SESSION_HEAD_IDENTITY_MISMATCH", `Invalid session head: ${headPath}`);
  }
  const manifestPath = resolvePortablePath(config.destination, head.manifestPath);
  const actualManifestHash = await hashFile(manifestPath);
  if (actualManifestHash !== head.manifestSha256) {
    throw new ColdStorageError(
      "SESSION_HEAD_HASH_MISMATCH",
      `Session head manifest hash mismatch: ${head.manifestPath}`,
    );
  }
  const manifest = validateContract(await readRegularJson(config.destination, head.manifestPath), {
    expectedKind: "session-snapshot",
  });
  if (manifest.deviceId !== deviceId || manifest.snapshotId !== head.snapshotId) {
    throw new ColdStorageError(
      "SESSION_MANIFEST_IDENTITY_MISMATCH",
      `Session manifest does not match its head: ${head.manifestPath}`,
    );
  }
  if (options.verifyObjects) await verifySnapshotObjects(config, manifest);
  return {
    head,
    manifest,
    headPath,
    headSha256: hashCanonicalJson(head),
  };
}

export async function planSessionPush(config, options = {}) {
  await assertDestinationIdentity(config);
  await showDevice(config);
  const startedAt = normalizeTime(options.now);
  const current = await readSessionHead(config, config.device.id, { verifyObjects: false });
  const inventory = options.inventoryOverride || (await inventoryLocalSessions(config, options));
  if (inventory.errors.length > 0 && options.failOnInventoryError !== false) {
    throw new ColdStorageError(
      "SESSION_INVENTORY_INCOMPLETE",
      `Session inventory failed for ${inventory.errors.length} file(s).`,
      { errors: inventory.errors },
    );
  }
  const mergedObjects = new Map(
    (current?.manifest.objects || []).map((object) => [object.sourceKey, { ...object, sourcePath: null }]),
  );
  for (const object of inventory.objects) mergedObjects.set(object.sourceKey, object);
  const privateObjects = [...mergedObjects.values()].sort((left, right) =>
    left.sourceKey.localeCompare(right.sourceKey),
  );
  const objects = privateObjects.map(({ sourcePath: _sourcePath, ...portable }) => portable);
  const unchanged = current ? sameObjectSet(current.manifest.objects, objects) : false;
  const newObjects = [];
  const existingObjects = [];
  for (const object of privateObjects) {
    const targetPath = resolvePortablePath(config.destination, object.objectPath);
    if (!(await pathExists(targetPath))) {
      newObjects.push(object);
      continue;
    }
    if (options.verifyExistingObjects !== false) {
      const digest = await hashFile(targetPath);
      if (digest !== object.sha256) {
        throw new ColdStorageError(
          "SESSION_OBJECT_HASH_MISMATCH",
          `Existing content object is corrupt or conflicting: ${object.objectPath}`,
        );
      }
    }
    existingObjects.push(object);
  }
  const snapshotId = options.snapshotId || randomUUID();
  const createdAt = startedAt.toISOString();
  const manifest = unchanged
    ? null
    : {
        contractVersion: CONTRACT_VERSION,
        kind: "session-snapshot",
        snapshotId,
        deviceId: config.device.id,
        createdAt,
        parentSnapshotId: current?.manifest.snapshotId || null,
        source: {
          type: "codex-local",
          roots: configuredRoots(config),
        },
        objects,
      };
  if (manifest) validateContract(manifest, { expectedKind: "session-snapshot" });
  return {
    ok: true,
    action: options.operation === "migration" ? "migration-plan" : "sync-plan",
    apply: false,
    deviceId: config.device.id,
    unchanged,
    currentSnapshotId: current?.manifest.snapshotId || null,
    snapshotId: manifest?.snapshotId || current?.manifest.snapshotId || null,
    manifest,
    manifestPath: manifest ? sessionManifestPath(config.device.id, snapshotId, startedAt) : null,
    headPath: sessionHeadPath(config.device.id),
    counts: {
      discovered: privateObjects.length,
      inventoryErrors: inventory.errors.length,
      newObjects: newObjects.length,
      existingObjects: existingObjects.length,
      newSnapshot: manifest ? 1 : 0,
    },
    errors: inventory.errors,
    privateObjects,
    current,
  };
}

export async function pushSessionSnapshot(config, options = {}) {
  const plan = await planSessionPush(config, options);
  if (!options.apply) return publicPlan(plan);
  const runId = options.runId || randomUUID();
  const startedAt = normalizeTime(options.now);
  const publishedObjects = [];

  for (const object of plan.privateObjects) {
    const targetPath = resolvePortablePath(config.destination, object.objectPath);
    const existed = await pathExists(targetPath);
    if (existed) continue;
    if (!object.sourcePath) {
      throw new ColdStorageError(
        "SESSION_REFERENCED_OBJECT_MISSING",
        `A previously published snapshot object is missing: ${object.objectPath}`,
      );
    }
    const copied = await copyVerified(object.sourcePath, targetPath, {
      destinationRoot: config.destination,
      afterCopy: options.afterObjectCopy,
      afterPublish: options.afterObjectPublish,
    });
    if (copied.sha256 !== object.sha256) {
      await rm(targetPath, { force: true });
      throw new ColdStorageError(
        "SESSION_SOURCE_CHANGED_DURING_PUSH",
        `Source bytes changed after planning: ${object.sourceKey}`,
      );
    }
    publishedObjects.push(object.objectPath);
  }

  let manifestResult = null;
  let headResult = null;
  let head = plan.current?.head || null;
  if (plan.manifest) {
    if (typeof options.beforeManifestPublish === "function") await options.beforeManifestPublish(plan);
    manifestResult = await publishImmutableJson(
      config.destination,
      plan.manifestPath,
      plan.manifest,
      { runId, conflictCode: "SESSION_MANIFEST_CONFLICT" },
    );
    head = {
      contractVersion: CONTRACT_VERSION,
      kind: "head-pointer",
      deviceId: config.device.id,
      stream: "sessions",
      projectId: null,
      snapshotId: plan.manifest.snapshotId,
      manifestPath: plan.manifestPath,
      manifestSha256: manifestResult.sha256,
      publishedAt: startedAt.toISOString(),
    };
    validateContract(head, { expectedKind: "head-pointer" });
    headResult = await publishMutableJson(config.destination, plan.headPath, head, {
      runId,
      expectedCurrentSha256: plan.current?.headSha256,
      expectedAbsent: !plan.current,
      concurrentCode: "SESSION_HEAD_CONCURRENT_UPDATE",
      beforePublish: options.beforeHeadPublish,
    });
  }

  const completedAt = normalizeTime(options.completedAt || options.now).toISOString();
  const runPath = sessionRunPath(config.device.id, runId, startedAt);
  const outputRefs = [
    ...publishedObjects,
    ...(plan.manifestPath ? [plan.manifestPath, plan.headPath] : []),
    runPath,
  ];
  const runRecord = {
    contractVersion: CONTRACT_VERSION,
    kind: "run-record",
    runId,
    deviceId: config.device.id,
    operation: options.operation || "sync-push",
    dryRun: false,
    status: "succeeded",
    startedAt: startedAt.toISOString(),
    completedAt,
    inputRefs: options.inputRefs || (plan.current?.head ? [plan.current.head.manifestPath] : []),
    outputRefs,
    counts: {
      objectsDiscovered: plan.counts.discovered,
      objectsPublished: publishedObjects.length,
      objectsReused: plan.counts.existingObjects,
      snapshotsPublished: manifestResult?.created ? 1 : 0,
      headsUpdated: headResult?.changed ? 1 : 0,
      inventoryErrors: plan.counts.inventoryErrors,
    },
    warnings: [],
    errors: plan.errors.map((error) => error.code),
  };
  validateContract(runRecord, { expectedKind: "run-record" });
  await publishImmutableJson(config.destination, runPath, runRecord, {
    runId,
    conflictCode: "RUN_RECORD_CONFLICT",
  });

  return {
    ...publicPlan(plan),
    action: options.operation === "migration" ? "migration" : "sync-push",
    apply: true,
    head,
    runRecord,
    runPath,
    publishedObjects,
    counts: runRecord.counts,
  };
}

export async function verifySnapshotObjects(config, manifest) {
  const errors = [];
  for (const object of manifest.objects) {
    try {
      const objectPath = resolvePortablePath(config.destination, object.objectPath);
      const digest = await hashFile(objectPath);
      if (digest !== object.sha256) {
        throw new ColdStorageError(
          "SESSION_OBJECT_HASH_MISMATCH",
          `Session content object hash mismatch: ${object.objectPath}`,
        );
      }
    } catch (error) {
      errors.push({
        objectPath: object.objectPath,
        code: error?.code || "SESSION_OBJECT_VERIFY_FAILED",
        message: error.message,
      });
    }
  }
  if (errors.length > 0) {
    throw new ColdStorageError(
      "SESSION_SNAPSHOT_OBJECTS_INVALID",
      `Session snapshot has ${errors.length} invalid object(s).`,
      { errors },
    );
  }
  return { ok: true, verified: manifest.objects.length };
}

function publicPlan(plan) {
  const { privateObjects: _privateObjects, current: _current, ...publicValue } = plan;
  return publicValue;
}

function sameObjectSet(left, right) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => canonicalJson(item) === canonicalJson(right[index]));
}

function configuredRoots(config) {
  const roots = config.roots.filter((root) => SUPPORTED_ROOTS.has(root));
  return roots.length > 0 ? roots : ["sessions"];
}

export async function extractNativeSessionId(filePath, format) {
  if (format === "jsonl.zst") return null;
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_SESSION_META_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const candidate =
        value?.type === "session_meta" ? value?.payload?.id : value?.session_meta?.payload?.id;
      if (typeof candidate === "string" && UUID_RE.test(candidate)) return candidate.toLowerCase();
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function stableFileSnapshot(filePath) {
  const info = await stat(filePath, { bigint: true });
  if (!info.isFile()) {
    throw new ColdStorageError("SESSION_SOURCE_NOT_FILE", `Session source is not a file: ${filePath}`);
  }
  return info;
}

async function stableHash(filePath, before) {
  const digest = await hashFile(filePath);
  const after = await stableFileSnapshot(filePath);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new ColdStorageError(
      "SESSION_SOURCE_CHANGED_DURING_HASH",
      `Session source changed while hashing: ${filePath}`,
    );
  }
  return digest;
}

function sessionRunPath(deviceId, runId, at) {
  return (
    `devices/${deviceId}/runs/` +
    `${String(at.getUTCFullYear()).padStart(4, "0")}/` +
    `${String(at.getUTCMonth() + 1).padStart(2, "0")}/${runId}.json`
  );
}

function normalizeTime(value) {
  const result = value ? new Date(value) : new Date();
  if (Number.isNaN(result.getTime())) {
    throw new ColdStorageError("SESSION_TIME_INVALID", "Session publication time is invalid.");
  }
  return result;
}
