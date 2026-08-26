import { constants as fsConstants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CATALOG_VERSION = 1;
export const DESTINATION_MARKER_VERSION = 1;
export const DESTINATION_MARKER_FILENAME = ".session-harbor-destination.json";
export const CONFIG_VERSION = 4;
export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  codexHome: "~/.codex",
  destination: "",
  destinationId: "",
  roots: ["sessions", "archived_sessions"],
  olderThanDays: 30,
  minimumSizeMB: 5,
  graceDays: 7,
  mode: "linked",
  compression: "none",
  compressionLevel: 19,
  strictOpenFileCheck: true,
  backup: Object.freeze({
    scope: "all",
    allowPartial: true,
    verifyExistingObjects: false,
  }),
  retention: Object.freeze({
    cleanupAfterInactiveDays: 30,
    minimumBackupAgeDays: 7,
    reclaimAction: "keep",
    autoReclaim: false,
  }),
  device: Object.freeze({
    id: "",
    displayName: "",
    platform: platformName(),
  }),
  exchange: Object.freeze({
    adapter: "filesystem",
    storageClass: "stable-mounted",
    autoPublish: false,
  }),
  projects: Object.freeze({}),
  memory: Object.freeze({
    autoDraft: true,
    autoPublish: false,
    requireEvidence: true,
  }),
});

export class ColdStorageError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ColdStorageError";
    this.code = code;
    this.details = details;
  }
}

export function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function defaultConfigPath() {
  return expandHome(
    process.env.SESSION_HARBOR_CONFIG || "~/.config/session-harbor/config.json",
  );
}

export function normalizeConfig(input = {}) {
  const sourceVersion = input.version ?? CONFIG_VERSION;
  if (![1, 2, 3, CONFIG_VERSION].includes(sourceVersion)) {
    throw new ColdStorageError(
      "CONFIG_VERSION_UNSUPPORTED",
      `Config version ${sourceVersion} is unsupported; supported versions are 1, 2, 3, and ${CONFIG_VERSION}.`,
    );
  }
  for (const key of ["backup", "retention", "device", "exchange", "projects", "memory"]) {
    if (input[key] !== undefined && !isPlainObject(input[key])) {
      throw new ColdStorageError(
        `CONFIG_${key.toUpperCase()}_INVALID`,
        `${key} must be a JSON object.`,
      );
    }
  }
  const providedRetention = input.retention || {};
  const retentionInput = {
    ...DEFAULT_CONFIG.retention,
    ...providedRetention,
    cleanupAfterInactiveDays:
      input.olderThanDays ??
      providedRetention.cleanupAfterInactiveDays ??
      providedRetention.archiveAfterDays ??
      DEFAULT_CONFIG.retention.cleanupAfterInactiveDays,
    minimumBackupAgeDays:
      input.graceDays ??
      providedRetention.minimumBackupAgeDays ??
      providedRetention.localGraceDays ??
      DEFAULT_CONFIG.retention.minimumBackupAgeDays,
  };
  delete retentionInput.archiveAfterDays;
  delete retentionInput.localGraceDays;
  if (input.mode !== undefined) {
    if (!new Set(["linked", "copy-only", "link", "keep", "delete"]).has(input.mode)) {
      throw new ColdStorageError(
        "CONFIG_MODE_INVALID",
        "mode/reclaim action must be linked, copy-only, link, keep, or delete.",
      );
    }
    retentionInput.reclaimAction =
      input.mode === "copy-only" || input.mode === "keep"
        ? "keep"
        : input.mode === "delete"
          ? "delete"
          : "link";
  }
  if (input.autoReclaim !== undefined) retentionInput.autoReclaim = input.autoReclaim;
  const merged = {
    ...DEFAULT_CONFIG,
    ...input,
    version: CONFIG_VERSION,
    backup: { ...DEFAULT_CONFIG.backup, ...(input.backup || {}) },
    retention: retentionInput,
    device: { ...DEFAULT_CONFIG.device, ...(input.device || {}) },
    exchange: { ...DEFAULT_CONFIG.exchange, ...(input.exchange || {}) },
    projects: { ...DEFAULT_CONFIG.projects, ...(input.projects || {}) },
    memory: { ...DEFAULT_CONFIG.memory, ...(input.memory || {}) },
  };
  merged.codexHome = path.resolve(expandHome(merged.codexHome));
  merged.destination = merged.destination
    ? path.resolve(expandHome(merged.destination))
    : "";
  merged.destinationId = String(merged.destinationId || "").trim();
  merged.roots = Array.isArray(merged.roots) ? [...new Set(merged.roots)] : [];

  normalizeDeviceConfig(merged.device);
  normalizeBackupConfig(merged.backup);
  normalizeRetentionConfig(merged.retention);
  normalizeExchangeConfig(merged.exchange);
  normalizeProjectMap(merged.projects, merged.device.platform);
  normalizeMemoryConfig(merged.memory);
  if (
    merged.exchange.storageClass === "client-synced" &&
    merged.retention.reclaimAction !== "keep"
  ) {
    throw new ColdStorageError(
      "CONFIG_SYNCED_RECLAIM_UNSAFE",
      "Client-synchronized folders require retention.reclaimAction=keep because files may be evicted.",
    );
  }
  for (const root of merged.roots) {
    if (!/^[A-Za-z0-9_-]+$/.test(root)) {
      throw new ColdStorageError("CONFIG_ROOT_INVALID", `Unsafe source root: ${root}`);
    }
  }
  // Compatibility aliases for v1-v3 callers. Config v4 persists only the canonical names.
  merged.olderThanDays = merged.retention.cleanupAfterInactiveDays;
  merged.graceDays = merged.retention.minimumBackupAgeDays;
  merged.mode =
    merged.retention.reclaimAction === "keep"
      ? "copy-only"
      : merged.retention.reclaimAction === "delete"
        ? "delete"
        : "linked";
  for (const key of ["minimumSizeMB"]) {
    const value = Number(merged[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw new ColdStorageError("CONFIG_NUMBER_INVALID", `${key} must be a non-negative number.`);
    }
    merged[key] = value;
  }
  const compressionLevel = Number(merged.compressionLevel);
  if (!Number.isInteger(compressionLevel) || compressionLevel < 1 || compressionLevel > 22) {
    throw new ColdStorageError(
      "CONFIG_COMPRESSION_LEVEL_INVALID",
      "compressionLevel must be an integer from 1 to 22.",
    );
  }
  merged.compressionLevel = compressionLevel;
  if (!new Set(["none", "codex-slim"]).has(merged.compression)) {
    throw new ColdStorageError(
      "CONFIG_COMPRESSION_INVALID",
      "compression must be either 'none' or 'codex-slim'.",
    );
  }
  merged.strictOpenFileCheck = Boolean(merged.strictOpenFileCheck);
  return merged;
}

export async function loadConfig(configPath = defaultConfigPath(), overrides = {}) {
  let stored = {};
  try {
    stored = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof SyntaxError) {
        throw new ColdStorageError("CONFIG_JSON_INVALID", `Invalid JSON in ${configPath}.`);
      }
      throw error;
    }
  }
  return normalizeConfig({ ...stored, ...overrides });
}

export async function saveConfig(configPath, input) {
  const config = normalizeConfig(input);
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await atomicWriteJson(configPath, {
    version: CONFIG_VERSION,
    codexHome: input.codexHome || DEFAULT_CONFIG.codexHome,
    destination: input.destination || config.destination,
    destinationId: config.destinationId,
    roots: [...config.roots],
    minimumSizeMB: config.minimumSizeMB,
    compression: config.compression,
    compressionLevel: config.compressionLevel,
    strictOpenFileCheck: config.strictOpenFileCheck,
    backup: { ...config.backup },
    retention: { ...config.retention },
    device: { ...config.device },
    exchange: { ...config.exchange },
    projects: { ...config.projects },
    memory: { ...config.memory },
  });
  await chmod(configPath, 0o600);
  return config;
}

export async function initializeStorage(configPath, input, options = {}) {
  let config = normalizeConfig(input);
  requireDestination(config);
  const markerPath = destinationMarkerPath(config);

  if (!options.apply) {
    return {
      apply: false,
      action: "init",
      configPath,
      markerPath,
      config,
    };
  }

  await mkdir(config.destination, { recursive: true, mode: 0o700 });
  await requireDestinationAvailable(config);
  let marker;
  try {
    marker = await readDestinationMarker(config.destination);
  } catch (error) {
    if (error?.code !== "DESTINATION_MARKER_MISSING") throw error;
    if (config.destinationId) {
      throw new ColdStorageError(
        "DESTINATION_MARKER_MISSING",
        `The configured destination identity is missing at ${config.destination}. Refusing to replace it.`,
      );
    }
    marker = {
      version: DESTINATION_MARKER_VERSION,
      destinationId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await atomicWriteJson(markerPath, marker);
  }

  if (config.destinationId && config.destinationId !== marker.destinationId) {
    throw new ColdStorageError(
      "DESTINATION_ID_MISMATCH",
      `The mounted destination does not match this config: ${config.destination}`,
    );
  }
  config = normalizeConfig({ ...config, destinationId: marker.destinationId });
  await saveConfig(configPath, config);
  return {
    apply: true,
    action: "init",
    configPath,
    markerPath,
    config,
  };
}

export function destinationMarkerPath(config) {
  requireDestination(config);
  return path.join(config.destination, DESTINATION_MARKER_FILENAME);
}

export async function assertDestinationIdentity(config) {
  requireDestination(config);
  await requireDestinationAvailable(config);
  if (!config.destinationId) {
    throw new ColdStorageError(
      "DESTINATION_ID_REQUIRED",
      "The config has no destination identity. Re-run init --apply for this destination.",
    );
  }
  const marker = await readDestinationMarker(config.destination);
  if (marker.destinationId !== config.destinationId) {
    throw new ColdStorageError(
      "DESTINATION_ID_MISMATCH",
      `The mounted destination does not match this config: ${config.destination}`,
      { expected: config.destinationId, actual: marker.destinationId },
    );
  }
  return marker;
}

export function catalogPath(config) {
  requireDestination(config);
  return path.join(config.destination, "catalog-v1.json");
}

export function catalogEntryBelongsToDevice(config, entry) {
  if (!config.device?.id) return true;
  const deviceRoot = `devices/${config.device.id}/`;
  return (
    typeof entry?.targetRelativePath === "string" &&
    entry.targetRelativePath.startsWith(deviceRoot)
  );
}

export async function loadCatalog(config) {
  const file = catalogPath(config);
  try {
    await assertNoSymlinkComponents(config.destination, file);
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value.version !== CATALOG_VERSION || !Array.isArray(value.entries)) {
      throw new ColdStorageError("CATALOG_INVALID", `Unsupported or invalid catalog: ${file}`);
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { version: CATALOG_VERSION, updatedAt: null, entries: [] };
    }
    if (error instanceof SyntaxError) {
      throw new ColdStorageError("CATALOG_JSON_INVALID", `Invalid JSON in ${file}.`);
    }
    throw error;
  }
}

export async function saveCatalog(config, catalog) {
  await assertDestinationIdentity(config);
  await assertNoSymlinkComponents(config.destination, catalogPath(config));
  catalog.version = CATALOG_VERSION;
  catalog.updatedAt = new Date().toISOString();
  catalog.entries.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
  await atomicWriteJson(catalogPath(config), catalog);
}

export function sessionIdFromFilename(filename) {
  const match = filename.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i,
  );
  return match?.[1]?.toLowerCase() || null;
}

export async function scanSessions(config, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const cleanupAgeMs = config.retention.cleanupAfterInactiveDays * 86_400_000;
  const minimumBytes = Math.floor(config.minimumSizeMB * 1024 * 1024);
  const results = [];

  for (const rootName of config.roots) {
    const rootPath = safeJoin(config.codexHome, rootName);
    if (!(await pathExists(rootPath))) continue;
    await assertNoSymlinkComponents(config.codexHome, rootPath);
    for await (const filePath of walkRollouts(rootPath)) {
      const relativePath = safeRelative(rootPath, filePath);
      const info = await lstat(filePath, { bigint: true });
      const filename = path.basename(filePath);
      const base = {
        sessionId: sessionIdFromFilename(filename),
        sourceRoot: rootName,
        sourceRelativePath: relativePath,
        sourceKey: `${rootName}/${toPosix(relativePath)}`,
        sourcePath: filePath,
        filename,
        format: filename.endsWith(".jsonl.zst") ? "jsonl.zst" : "jsonl",
        isSymlink: info.isSymbolicLink(),
      };

      if (info.isSymbolicLink()) {
        let linkTarget = null;
        let targetAvailable = false;
        try {
          linkTarget = await readlink(filePath);
          targetAvailable = await pathExists(path.resolve(path.dirname(filePath), linkTarget));
        } catch {
          // A damaged link remains visible in status output.
        }
        results.push({
          ...base,
          sizeBytes: 0,
          mtimeMs: null,
          ageDays: null,
          eligible: false,
          backupEligible: false,
          cleanupEligible: false,
          reason: targetAvailable ? "already-linked" : "broken-link",
          linkTarget,
          targetAvailable,
        });
        continue;
      }

      if (!info.isFile()) continue;
      const sizeBytes = Number(info.size);
      const mtimeMs = Number(info.mtimeMs);
      const ctimeMs = Number(info.ctimeMs);
      const age = Math.max(0, nowMs - mtimeMs);
      let reason = "eligible";
      if (sizeBytes < minimumBytes) reason = "below-size-threshold";
      else if (age < cleanupAgeMs) reason = "too-recent";
      results.push({
        ...base,
        sizeBytes,
        mtimeMs,
        ctimeMs,
        ageDays: age / 86_400_000,
        eligible: reason === "eligible",
        backupEligible: true,
        cleanupEligible: age >= cleanupAgeMs,
        reason,
      });
    }
  }

  results.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
  return results;
}

export async function archiveSessions(config, options = {}) {
  requireDestination(config);
  await assertDestinationIdentity(config);
  const catalog = await loadCatalog(config);
  const sessions = await scanSessions(config, options);
  const selection = options.selection || "policy";
  const selectedSessions = options.selector
    ? selectOneSession(sessions, options.selector)
    : sessions;
  const eligible = selectedSessions.filter((item) => {
    if (selection === "all") return item.backupEligible;
    if (selection === "cleanup") return item.cleanupEligible;
    return item.eligible;
  });
  const summary = {
    apply: Boolean(options.apply),
    finalize: Boolean(options.finalize),
    candidates: eligible.length,
    candidateBytes: eligible.reduce((sum, item) => sum + item.sizeBytes, 0),
    copied: 0,
    copiedBytes: 0,
    linked: 0,
    linkedBytes: 0,
    reclaimed: 0,
    reclaimedBytes: 0,
    readyForReclaim: 0,
    deferredForGrace: 0,
    skipped: 0,
    errors: [],
    items: [],
    selector: options.selector || null,
  };

  await emitProgress(options, {
    stage: options.reclaim ? "cleanup" : "backup",
    status: "running",
    processed: 0,
    total: eligible.length,
    candidateBytes: summary.candidateBytes,
  });

  for (let index = 0; index < eligible.length; index += 1) {
    const item = eligible[index];
    let itemStatus = "completed";
    try {
      const outcome = await archiveOne(config, catalog, item, options);
      summary.items.push(outcome);
      if (outcome.action === "copy") {
        summary.copied += 1;
        summary.copiedBytes += item.sizeBytes;
      } else if (outcome.action === "link") {
        summary.linked += 1;
        summary.linkedBytes += item.sizeBytes;
      } else if (outcome.action === "delete-local") {
        summary.reclaimed += 1;
        summary.reclaimedBytes += item.sizeBytes;
      } else if (outcome.action === "ready") {
        summary.readyForReclaim += 1;
      } else if (outcome.action === "defer") {
        summary.deferredForGrace += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      itemStatus = "error";
      summary.errors.push(errorRecord(item, error));
    }
    await emitProgress(options, {
      stage: options.reclaim ? "cleanup" : "backup",
      status: "running",
      processed: index + 1,
      total: eligible.length,
      sourceKey: item.sourceKey,
      itemStatus,
      copied: summary.copied,
      reclaimed: summary.reclaimed,
      linked: summary.linked,
      skipped: summary.skipped,
      errors: summary.errors.length,
    });
  }

  return summary;
}

function selectOneSession(sessions, selector) {
  const normalized = String(selector).trim();
  const matches = sessions.filter(
    (item) =>
      item.sessionId === normalized ||
      item.sessionId?.startsWith(normalized) ||
      item.sourceKey === normalized ||
      item.sourceKey.endsWith(normalized),
  );
  if (matches.length !== 1) {
    throw new ColdStorageError(
      matches.length === 0 ? "SESSION_SELECTOR_NOT_FOUND" : "SESSION_SELECTOR_AMBIGUOUS",
      matches.length === 0
        ? `No local session matches: ${normalized}`
        : `More than one local session matches: ${normalized}`,
    );
  }
  return matches;
}

async function emitProgress(options, event) {
  if (typeof options.onProgress === "function") await options.onProgress(event);
}

export async function reclaimSessions(config, options = {}) {
  return archiveSessions(config, { ...options, reclaim: true, selection: "cleanup" });
}

export async function backupSessions(config, options = {}) {
  return archiveSessions(config, { ...options, selection: "all" });
}

async function archiveOne(config, catalog, item, options) {
  const apply = Boolean(options.apply);
  const now = options.now ? new Date(options.now) : new Date();
  const nowIso = now.toISOString();
  let entry = catalog.entries.find(
    (candidate) =>
      candidate.sourceKey === item.sourceKey && catalogEntryBelongsToDevice(config, candidate),
  );
  let plannedSourceDigest = null;
  let targetRelativePath = entry?.targetRelativePath;
  if (!targetRelativePath) {
    if (config.device.id) {
      const before = await stableStat(item.sourcePath);
      plannedSourceDigest = await hashFile(item.sourcePath);
      await assertSameFileSnapshot(item.sourcePath, before, "SOURCE_CHANGED_DURING_HASH");
      targetRelativePath = contentObjectRelativePath(
        config.device.id,
        plannedSourceDigest,
        item.format,
      );
    } else {
      targetRelativePath = toPosix(path.join("files", item.sourceRoot, item.sourceRelativePath));
    }
  }
  const targetPath = safeJoin(config.destination, targetRelativePath);
  await assertNoSymlinkComponents(config.destination, targetPath);

  if (!entry) {
    if (options.reclaim) {
      return { sourceKey: item.sourceKey, action: "skip", state: "not-archived" };
    }
    if (!apply) {
      return {
        sourceKey: item.sourceKey,
        action: "copy",
        state: "planned",
        sizeBytes: item.sizeBytes,
        targetRelativePath,
      };
    }

    const snapshot = await copyVerified(item.sourcePath, targetPath, {
      ...options,
      destinationRoot: config.destination,
    });
    if (plannedSourceDigest && snapshot.sha256 !== plannedSourceDigest) {
      await rm(targetPath, { force: true });
      throw new ColdStorageError(
        "SOURCE_CHANGED_DURING_COPY",
        `Source changed after its content-addressed path was planned: ${item.sourceKey}`,
      );
    }
    entry = {
      id: randomUUID(),
      sessionId: item.sessionId,
      sourceRoot: item.sourceRoot,
      sourceRelativePath: toPosix(item.sourceRelativePath),
      sourceKey: item.sourceKey,
      targetRelativePath,
      format: item.format,
      sizeBytes: snapshot.sizeBytes,
      sha256: snapshot.sha256,
      sourceMtimeMs: snapshot.sourceMtimeMs,
      sourceCtimeMs: snapshot.sourceCtimeMs,
      copiedAt: nowIso,
      linkedAt: null,
      restoredAt: null,
      reclaimedAt: null,
      state: "copied",
    };
    catalog.entries.push(entry);
    await saveCatalog(config, catalog);
    return {
      sourceKey: item.sourceKey,
      action: "copy",
      state: "copied",
      sizeBytes: item.sizeBytes,
      sha256: snapshot.sha256,
      targetRelativePath,
    };
  }

  if (entry.state === "linked" || entry.state === "reclaimed") {
    return {
      sourceKey: item.sourceKey,
      action: "skip",
      state: entry.state === "linked" ? "already-linked" : "already-reclaimed",
    };
  }

  const metadataMatches =
    Number(entry.sizeBytes) === item.sizeBytes &&
    Number(entry.sourceMtimeMs) === item.mtimeMs &&
    (entry.sourceCtimeMs === undefined || Number(entry.sourceCtimeMs) === item.ctimeMs);
  if (
    metadataMatches &&
    !config.backup.verifyExistingObjects &&
    options.selection === "all" &&
    !options.reclaim &&
    !options.finalize
  ) {
    try {
      const targetInfo = await stat(targetPath, { bigint: true });
      if (targetInfo.isFile() && Number(targetInfo.size) === Number(entry.sizeBytes)) {
        return { sourceKey: item.sourceKey, action: "skip", state: "unchanged-metadata" };
      }
    } catch {
      // Fall through to full verification for a missing or unreadable target.
    }
  }

  const targetDigest = await hashFile(targetPath);
  if (targetDigest !== entry.sha256) {
    throw new ColdStorageError(
      "TARGET_HASH_MISMATCH",
      `Archived copy failed verification: ${entry.targetRelativePath}`,
    );
  }
  const sourceDigest = await hashFile(item.sourcePath);
  if (sourceDigest !== entry.sha256 && !options.reclaim) {
    const revisionRelativePath = config.device.id
      ? contentObjectRelativePath(config.device.id, sourceDigest, item.format)
      : toPosix(
          path.join(
            "versions",
            entry.id,
            `${nowIso.replace(/[:.]/g, "-")}-${sourceDigest.slice(0, 12)}-${item.filename}`,
          ),
        );
    if (!apply) {
      return {
        sourceKey: item.sourceKey,
        action: "copy",
        state: "planned-revision",
        sizeBytes: item.sizeBytes,
        targetRelativePath: revisionRelativePath,
      };
    }
    const revisionTargetPath = safeJoin(config.destination, revisionRelativePath);
    const snapshot = await copyVerified(item.sourcePath, revisionTargetPath, {
      ...options,
      destinationRoot: config.destination,
    });
    entry.revisions ||= [];
    entry.revisions.push({
      targetRelativePath: entry.targetRelativePath,
      format: entry.format,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      sourceMtimeMs: entry.sourceMtimeMs,
      sourceCtimeMs: entry.sourceCtimeMs,
      copiedAt: entry.copiedAt,
      linkedAt: entry.linkedAt,
      restoredAt: entry.restoredAt,
      reclaimedAt: entry.reclaimedAt || null,
    });
    entry.targetRelativePath = revisionRelativePath;
    entry.format = item.format;
    entry.sizeBytes = snapshot.sizeBytes;
    entry.sha256 = snapshot.sha256;
    entry.sourceMtimeMs = snapshot.sourceMtimeMs;
    entry.sourceCtimeMs = snapshot.sourceCtimeMs;
    entry.copiedAt = nowIso;
    entry.linkedAt = null;
    entry.reclaimedAt = null;
    entry.state = "copied";
    await saveCatalog(config, catalog);
    return {
      sourceKey: item.sourceKey,
      action: "copy",
      state: "copied-revision",
      sizeBytes: item.sizeBytes,
      sha256: snapshot.sha256,
      targetRelativePath: revisionRelativePath,
    };
  }
  if (sourceDigest !== entry.sha256) {
    throw new ColdStorageError(
      "SOURCE_CHANGED_AFTER_COPY",
      `Source changed after the verified copy: ${item.sourceKey}`,
    );
  }

  if (config.retention.reclaimAction === "keep") {
    return { sourceKey: item.sourceKey, action: "skip", state: "verified-copy-only" };
  }

  const copiedAtMs = Date.parse(entry.copiedAt);
  const graceElapsed =
    now.getTime() - copiedAtMs >= config.retention.minimumBackupAgeDays * 86_400_000;
  if (!options.finalize && !graceElapsed) {
    return {
      sourceKey: item.sourceKey,
      action: "defer",
      state: "copied",
      eligibleAt: new Date(
        copiedAtMs + config.retention.minimumBackupAgeDays * 86_400_000,
      ).toISOString(),
    };
  }
  if (!options.reclaim && !options.finalize) {
    return {
      sourceKey: item.sourceKey,
      action: "ready",
      state: "verified-ready",
      eligibleAt: new Date(
        copiedAtMs + config.retention.minimumBackupAgeDays * 86_400_000,
      ).toISOString(),
      reclaimAction: config.retention.reclaimAction,
    };
  }
  if (!apply) {
    return {
      sourceKey: item.sourceKey,
      action: config.retention.reclaimAction === "delete" ? "delete-local" : "link",
      state: "planned",
    };
  }

  await assertNotOpen(item.sourcePath, config, options);
  if (config.retention.reclaimAction === "delete") {
    if (!options.confirmDeleteLocal) {
      throw new ColdStorageError(
        "LOCAL_DELETE_CONFIRMATION_REQUIRED",
        "Deleting local rollout files requires --confirm-delete-local in addition to --apply.",
      );
    }
    await removeVerifiedLocalSource(item.sourcePath, targetPath, entry.sha256);
    entry.state = "reclaimed";
    entry.reclaimedAt = nowIso;
  } else {
    await replaceWithVerifiedSymlink(item.sourcePath, targetPath, entry.sha256);
    entry.state = "linked";
    entry.linkedAt = nowIso;
  }
  await saveCatalog(config, catalog);
  return {
    sourceKey: item.sourceKey,
    action: config.retention.reclaimAction === "delete" ? "delete-local" : "link",
    state: entry.state,
    sizeBytes: item.sizeBytes,
    targetRelativePath,
  };
}

export async function verifyArchive(config) {
  requireDestination(config);
  await assertDestinationIdentity(config);
  const catalog = await loadCatalog(config);
  const results = [];
  for (const entry of catalog.entries.filter((item) => catalogEntryBelongsToDevice(config, item))) {
    const targetPath = safeJoin(config.destination, entry.targetRelativePath);
    const sourcePath = safeJoin(config.codexHome, entry.sourceRoot, entry.sourceRelativePath);
    let targetStatus = "missing";
    let sourceStatus = "missing";
    try {
      await assertNoSymlinkComponents(config.destination, targetPath);
      targetStatus = (await hashFile(targetPath)) === entry.sha256 ? "verified" : "hash-mismatch";
    } catch (error) {
      if (error?.code !== "ENOENT") targetStatus = `error:${error.code || "unknown"}`;
    }
    try {
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) {
        const resolved = path.resolve(path.dirname(sourcePath), await readlink(sourcePath));
        sourceStatus = resolved === targetPath ? "linked" : "linked-elsewhere";
      } else if (info.isFile()) {
        sourceStatus = (await hashFile(sourcePath)) === entry.sha256 ? "local-copy" : "local-changed";
      } else {
        sourceStatus = "unexpected-type";
      }
    } catch (error) {
      if (error?.code !== "ENOENT") sourceStatus = `error:${error.code || "unknown"}`;
    }
    const revisionStatuses = [];
    for (const revision of entry.revisions || []) {
      const revisionPath = safeJoin(config.destination, revision.targetRelativePath);
      let status = "missing";
      try {
        await assertNoSymlinkComponents(config.destination, revisionPath);
        status = (await hashFile(revisionPath)) === revision.sha256 ? "verified" : "hash-mismatch";
      } catch (error) {
        if (error?.code !== "ENOENT") status = `error:${error.code || "unknown"}`;
      }
      revisionStatuses.push({ targetRelativePath: revision.targetRelativePath, status });
    }
    results.push({
      id: entry.id,
      sessionId: entry.sessionId,
      sourceKey: entry.sourceKey,
      state: entry.state,
      targetStatus,
      sourceStatus,
      sizeBytes: entry.sizeBytes,
      revisionStatuses,
    });
  }
  return {
    ok: results.every(
      (item) =>
        item.targetStatus === "verified" &&
        sourceStatusMatchesState(item.state, item.sourceStatus) &&
        item.revisionStatuses.every((revision) => revision.status === "verified"),
    ),
    entries: results,
  };
}

export async function restoreSession(config, selector, options = {}) {
  requireDestination(config);
  await assertDestinationIdentity(config);
  const catalog = await loadCatalog(config);
  const matches = catalog.entries.filter(
    (entry) =>
      catalogEntryBelongsToDevice(config, entry) &&
      (entry.id === selector ||
        entry.sessionId === selector ||
        entry.sessionId?.startsWith(selector) ||
        entry.sourceKey === selector ||
        entry.sourceKey.endsWith(selector)),
  );
  if (matches.length !== 1) {
    throw new ColdStorageError(
      matches.length === 0 ? "RESTORE_NOT_FOUND" : "RESTORE_AMBIGUOUS",
      matches.length === 0
        ? `No archived session matches: ${selector}`
        : `More than one archived session matches: ${selector}`,
    );
  }
  const entry = matches[0];
  const targetPath = safeJoin(config.destination, entry.targetRelativePath);
  const sourcePath = safeJoin(config.codexHome, entry.sourceRoot, entry.sourceRelativePath);
  await assertNoSymlinkComponents(config.destination, targetPath);
  const targetDigest = await hashFile(targetPath);
  if (targetDigest !== entry.sha256) {
    throw new ColdStorageError("TARGET_HASH_MISMATCH", "Restore refused: target hash mismatch.");
  }

  if (!options.apply) {
    return { apply: false, action: "restore", sourceKey: entry.sourceKey, state: entry.state };
  }
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await assertNotOpen(sourcePath, config, options, { allowMissing: true });
  await replaceSymlinkWithVerifiedCopy(sourcePath, targetPath, entry.sha256, options);
  const restoredInfo = await stat(sourcePath, { bigint: true });
  entry.state = "restored";
  entry.restoredAt = new Date().toISOString();
  entry.sizeBytes = Number(restoredInfo.size);
  entry.sourceMtimeMs = Number(restoredInfo.mtimeMs);
  entry.sourceCtimeMs = Number(restoredInfo.ctimeMs);
  await saveCatalog(config, catalog);
  return { apply: true, action: "restore", sourceKey: entry.sourceKey, state: "restored" };
}

export async function doctor(config) {
  const checks = [];
  checks.push(await checkPath("Codex home", config.codexHome, "directory"));
  for (const rootName of config.roots) {
    checks.push(await checkPath(`Codex root: ${rootName}`, safeJoin(config.codexHome, rootName), "directory", true));
  }
  if (config.destination) {
    checks.push(await checkPath("Destination", config.destination, "directory", true));
    checks.push(await checkDestinationIdentity(config));
  } else {
    checks.push({ name: "Destination", ok: false, optional: false, detail: "not configured" });
  }
  checks.push(
    await checkCommand(
      "lsof",
      ["-v"],
      !config.strictOpenFileCheck || config.device.platform === "windows",
    ),
  );
  if (config.device.platform === "windows") {
    checks.push({
      name: "Windows open-file protection",
      ok: true,
      optional: false,
      detail: "stable-copy checks plus rename-enforced reclamation; lsof is not required",
    });
  }
  checks.push(await checkCommand("codex-slim", ["--version"], config.compression !== "codex-slim"));
  return { ok: checks.every((check) => check.ok || check.optional), checks };
}

export async function runCodexSlim(config, options = {}) {
  if (config.compression !== "codex-slim" && !options.force) {
    throw new ColdStorageError(
      "COMPRESSION_DISABLED",
      "Set compression to 'codex-slim' or pass --force to run the optional compressor.",
    );
  }
  const scans = await scanSessions(config, options);
  const openFiles = [];
  if (options.apply) {
    for (const item of scans.filter((candidate) => candidate.eligible && candidate.format === "jsonl")) {
      const state = await fileOpenState(item.sourcePath);
      if (state === "open") openFiles.push(item.sourceKey);
      if (
        state === "unknown" &&
        config.strictOpenFileCheck &&
        config.device.platform !== "windows" &&
        !options.skipOpenCheck
      ) {
        throw new ColdStorageError(
          "OPEN_FILE_CHECK_UNAVAILABLE",
          "Cannot prove candidate files are inactive because lsof is unavailable.",
        );
      }
    }
  }
  if (openFiles.length > 0) {
    throw new ColdStorageError(
      "ACTIVE_SESSION_DETECTED",
      `Compression refused because ${openFiles.length} candidate file(s) are open.`,
      { openFiles },
    );
  }

  const runs = [];
  for (const rootName of config.roots) {
    const rootPath = safeJoin(config.codexHome, rootName);
    if (!(await pathExists(rootPath))) continue;
    const args = [
      "--dir",
      rootPath,
      "--threshold-mb",
      String(config.minimumSizeMB),
      "--min-age-days",
      String(config.olderThanDays),
      "--level",
      String(config.compressionLevel),
      "--quiet",
    ];
    if (!options.apply) args.push("--dry-run");
    try {
      const result = await execFileAsync("codex-slim", args, { maxBuffer: 16 * 1024 * 1024 });
      runs.push({ root: rootName, ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
    } catch (error) {
      throw new ColdStorageError(
        error?.code === "ENOENT" ? "CODEX_SLIM_NOT_FOUND" : "CODEX_SLIM_FAILED",
        error?.code === "ENOENT"
          ? "codex-slim is not installed. Install @milisp/codex-slim or set compression to 'none'."
          : `codex-slim failed for ${rootName}: ${error.message}`,
      );
    }
  }
  return { apply: Boolean(options.apply), runs };
}

export async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function copyVerified(sourcePath, targetPath, options = {}) {
  if (options.destinationRoot) {
    await assertNoSymlinkComponents(options.destinationRoot, targetPath);
  }
  const before = await stableStat(sourcePath);
  const sourceDigest = await hashFile(sourcePath);
  await assertSameFileSnapshot(sourcePath, before, "SOURCE_CHANGED_DURING_HASH");

  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  if (options.destinationRoot) {
    await assertNoSymlinkComponents(options.destinationRoot, targetPath);
  }
  if (await pathExists(targetPath)) {
    const existingDigest = await hashFile(targetPath);
    if (existingDigest !== sourceDigest) {
      throw new ColdStorageError(
        "TARGET_CONFLICT",
        `Target exists with different bytes: ${targetPath}`,
      );
    }
    await assertSameFileSnapshot(sourcePath, before, "SOURCE_CHANGED_DURING_COPY");
    return {
      sha256: sourceDigest,
      sizeBytes: Number(before.size),
      sourceMtimeMs: Number(before.mtimeMs),
      sourceCtimeMs: Number(before.ctimeMs),
    };
  }

  const partialPath = `${targetPath}.partial-${randomUUID()}`;
  let published = false;
  try {
    await copyFile(sourcePath, partialPath, fsConstants.COPYFILE_EXCL);
    const handle = await open(partialPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (typeof options.afterCopy === "function") await options.afterCopy(sourcePath, partialPath);
    await assertSameFileSnapshot(sourcePath, before, "SOURCE_CHANGED_DURING_COPY");
    const targetDigest = await hashFile(partialPath);
    if (targetDigest !== sourceDigest) {
      throw new ColdStorageError("COPY_HASH_MISMATCH", `Copy verification failed: ${targetPath}`);
    }
    await rename(partialPath, targetPath);
    published = true;
    if (typeof options.afterPublish === "function") await options.afterPublish(sourcePath, targetPath);
    await assertSameFileSnapshot(sourcePath, before, "SOURCE_CHANGED_BEFORE_PUBLISH");
    return {
      sha256: sourceDigest,
      sizeBytes: Number(before.size),
      sourceMtimeMs: Number(before.mtimeMs),
      sourceCtimeMs: Number(before.ctimeMs),
    };
  } catch (error) {
    await rm(partialPath, { force: true });
    if (published) await rm(targetPath, { force: true });
    throw error;
  }
}

async function replaceWithVerifiedSymlink(sourcePath, targetPath, expectedDigest) {
  const sourceDigest = await hashFile(sourcePath);
  if (sourceDigest !== expectedDigest) {
    throw new ColdStorageError("SOURCE_HASH_MISMATCH", "Source changed before link replacement.");
  }
  const targetDigest = await hashFile(targetPath);
  if (targetDigest !== expectedDigest) {
    throw new ColdStorageError("TARGET_HASH_MISMATCH", "Target changed before link replacement.");
  }

  const token = randomUUID();
  const backupPath = `${sourcePath}.cold-backup-${token}`;
  const linkPath = `${sourcePath}.cold-link-${token}`;
  try {
    await symlink(targetPath, linkPath);
  } catch (error) {
    if (process.platform === "win32" && error?.code === "EPERM") {
      throw new ColdStorageError(
        "WINDOWS_SYMLINK_PRIVILEGE_REQUIRED",
        "Windows file-link reclamation requires Developer Mode or elevation; the local source was not changed.",
      );
    }
    throw error;
  }
  let sourceMoved = false;
  try {
    await rename(sourcePath, backupPath);
    sourceMoved = true;
    await rename(linkPath, sourcePath);
    if ((await hashFile(sourcePath)) !== expectedDigest) {
      throw new ColdStorageError("LINK_READBACK_MISMATCH", "Symlink read-back verification failed.");
    }
    await unlink(backupPath);
  } catch (error) {
    await rm(linkPath, { force: true });
    try {
      const sourceInfo = await lstat(sourcePath);
      if (sourceInfo.isSymbolicLink()) await unlink(sourcePath);
    } catch {
      // Best-effort rollback continues below.
    }
    if (sourceMoved && (await pathExists(backupPath))) await rename(backupPath, sourcePath);
    throw error;
  }
}

async function removeVerifiedLocalSource(sourcePath, targetPath, expectedDigest) {
  const sourceDigest = await hashFile(sourcePath);
  if (sourceDigest !== expectedDigest) {
    throw new ColdStorageError("SOURCE_HASH_MISMATCH", "Source changed before local reclamation.");
  }
  const targetDigest = await hashFile(targetPath);
  if (targetDigest !== expectedDigest) {
    throw new ColdStorageError("TARGET_HASH_MISMATCH", "Target changed before local reclamation.");
  }

  const backupPath = `${sourcePath}.reclaim-backup-${randomUUID()}`;
  let sourceMoved = false;
  try {
    await rename(sourcePath, backupPath);
    sourceMoved = true;
    if ((await hashFile(backupPath)) !== expectedDigest) {
      throw new ColdStorageError(
        "LOCAL_RECLAIM_BACKUP_MISMATCH",
        "Temporary local rollback copy failed verification.",
      );
    }
    if ((await hashFile(targetPath)) !== expectedDigest) {
      throw new ColdStorageError(
        "TARGET_HASH_MISMATCH",
        "Archive target changed during local reclamation.",
      );
    }
    await unlink(backupPath);
    sourceMoved = false;
  } catch (error) {
    if (sourceMoved && (await pathExists(backupPath)) && !(await pathExists(sourcePath))) {
      await rename(backupPath, sourcePath);
    }
    throw error;
  }
}

async function replaceSymlinkWithVerifiedCopy(sourcePath, targetPath, expectedDigest, options = {}) {
  let sourceInfo = null;
  try {
    sourceInfo = await lstat(sourcePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (sourceInfo && !sourceInfo.isSymbolicLink()) {
    const localDigest = await hashFile(sourcePath);
    if (localDigest === expectedDigest) return;
    if (!options.overwrite) {
      throw new ColdStorageError(
        "RESTORE_SOURCE_CONFLICT",
        "A different local source file already exists; pass --overwrite only after review.",
      );
    }
  }

  const partialPath = `${sourcePath}.restore-partial-${randomUUID()}`;
  const backupPath = `${sourcePath}.restore-backup-${randomUUID()}`;
  await copyFile(targetPath, partialPath, fsConstants.COPYFILE_EXCL);
  if ((await hashFile(partialPath)) !== expectedDigest) {
    await rm(partialPath, { force: true });
    throw new ColdStorageError("RESTORE_COPY_HASH_MISMATCH", "Local restore copy failed verification.");
  }
  let movedExisting = false;
  try {
    if (sourceInfo) {
      await rename(sourcePath, backupPath);
      movedExisting = true;
    }
    await rename(partialPath, sourcePath);
    if ((await hashFile(sourcePath)) !== expectedDigest) {
      throw new ColdStorageError("RESTORE_READBACK_MISMATCH", "Restored source failed verification.");
    }
    if (movedExisting) await rm(backupPath, { force: true });
  } catch (error) {
    await rm(partialPath, { force: true });
    if (await pathExists(sourcePath)) await rm(sourcePath, { force: true });
    if (movedExisting && (await pathExists(backupPath))) await rename(backupPath, sourcePath);
    throw error;
  }
}

async function assertNotOpen(filePath, config, options = {}, extra = {}) {
  if (options.skipOpenCheck) return;
  if (!(await pathExists(filePath)) && extra.allowMissing) return;
  const state = await fileOpenState(filePath);
  if (state === "open") {
    throw new ColdStorageError("ACTIVE_SESSION_DETECTED", `File is open and will not be changed: ${filePath}`);
  }
  if (state === "unknown" && config.strictOpenFileCheck) {
    if (config.device.platform === "windows") {
      return;
    }
    throw new ColdStorageError(
      "OPEN_FILE_CHECK_UNAVAILABLE",
      "Cannot prove the source is inactive because lsof is unavailable.",
    );
  }
}

export async function fileOpenState(filePath) {
  if (process.platform === "win32") return "unknown";
  try {
    await execFileAsync("lsof", ["--", filePath], { maxBuffer: 2 * 1024 * 1024 });
    return "open";
  } catch (error) {
    if (error?.code === 1) return "closed";
    if (error?.code === "ENOENT") return "unknown";
    return "unknown";
  }
}

async function* walkRollouts(root) {
  const directory = await opendir(root);
  for await (const entry of directory) {
    const itemPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkRollouts(itemPath);
    } else if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      entry.name.startsWith("rollout-") &&
      (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst"))
    ) {
      yield itemPath;
    }
  }
}

async function stableStat(filePath) {
  const info = await stat(filePath, { bigint: true });
  if (!info.isFile()) {
    throw new ColdStorageError("SOURCE_NOT_FILE", `Source is not a regular file: ${filePath}`);
  }
  return info;
}

async function assertSameFileSnapshot(filePath, before, code) {
  const after = await stableStat(filePath);
  const same =
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.size === before.size &&
    after.mtimeNs === before.mtimeNs &&
    after.ctimeNs === before.ctimeNs;
  if (!same) {
    throw new ColdStorageError(code, `Source changed while it was being archived: ${filePath}`);
  }
}

async function checkPath(name, itemPath, expected, optional = false) {
  try {
    const info = await lstat(itemPath);
    const ok = expected === "directory" ? info.isDirectory() : info.isFile();
    return { name, ok, optional, detail: ok ? itemPath : `unexpected type: ${itemPath}` };
  } catch (error) {
    return { name, ok: false, optional, detail: error?.code === "ENOENT" ? "missing" : error.message };
  }
}

async function checkCommand(name, args, optional) {
  try {
    await execFileAsync(name, args, { maxBuffer: 1024 * 1024 });
    return { name, ok: true, optional, detail: "available" };
  } catch (error) {
    return { name, ok: false, optional, detail: error?.code === "ENOENT" ? "not found" : "unavailable" };
  }
}

async function requireDestinationAvailable(config) {
  const destination = config.destination;
  try {
    await access(destination, fsConstants.R_OK | fsConstants.W_OK);
    const info = await lstat(destination);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("not a real directory");
    }
  } catch (error) {
    throw new ColdStorageError(
      "DESTINATION_UNAVAILABLE",
      `Archive destination is not available and writable: ${destination}`,
      { cause: error.message },
    );
  }
}

async function readDestinationMarker(destination) {
  const markerPath = path.join(destination, DESTINATION_MARKER_FILENAME);
  let marker;
  try {
    await assertNoSymlinkComponents(destination, markerPath);
    const markerInfo = await lstat(markerPath);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
      throw new ColdStorageError(
        "DESTINATION_MARKER_INVALID",
        `Destination marker is not a regular file: ${markerPath}`,
      );
    }
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ColdStorageError(
        "DESTINATION_MARKER_MISSING",
        `Destination identity marker is missing: ${markerPath}`,
      );
    }
    if (error instanceof SyntaxError) {
      throw new ColdStorageError("DESTINATION_MARKER_INVALID", `Invalid marker JSON: ${markerPath}`);
    }
    throw error;
  }
  if (
    marker?.version !== DESTINATION_MARKER_VERSION ||
    typeof marker.destinationId !== "string" ||
    !marker.destinationId
  ) {
    throw new ColdStorageError("DESTINATION_MARKER_INVALID", `Invalid destination marker: ${markerPath}`);
  }
  return marker;
}

export async function assertNoSymlinkComponents(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = safeJoin(resolvedRoot, path.relative(resolvedRoot, candidate));
  const rootInfo = await lstat(resolvedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new ColdStorageError(
      "PATH_SYMLINK_UNSAFE",
      `Root must be a real directory, not a symbolic link: ${resolvedRoot}`,
    );
  }

  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative) return;
  let current = resolvedRoot;
  const components = relative.split(path.sep);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new ColdStorageError(
        "PATH_SYMLINK_UNSAFE",
        `Refusing a path containing a symbolic link: ${current}`,
      );
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new ColdStorageError("PATH_COMPONENT_INVALID", `Path component is not a directory: ${current}`);
    }
  }
}

async function checkDestinationIdentity(config) {
  try {
    const marker = await assertDestinationIdentity(config);
    return {
      name: "Destination identity",
      ok: true,
      optional: false,
      detail: marker.destinationId,
    };
  } catch (error) {
    return {
      name: "Destination identity",
      ok: false,
      optional: false,
      detail: `${error.code || "ERROR"}: ${error.message}`,
    };
  }
}

function sourceStatusMatchesState(state, sourceStatus) {
  if (state === "linked") return sourceStatus === "linked";
  if (state === "reclaimed") return sourceStatus === "missing";
  if (state === "copied") return sourceStatus === "local-copy";
  if (state === "restored") {
    return sourceStatus === "local-copy" || sourceStatus === "local-changed";
  }
  return false;
}

function requireDestination(config) {
  if (!config.destination) {
    throw new ColdStorageError("DESTINATION_REQUIRED", "Configure an archive destination first.");
  }
  const codexHome = path.resolve(config.codexHome);
  const destination = path.resolve(config.destination);
  if (destination === codexHome || destination.startsWith(`${codexHome}${path.sep}`)) {
    throw new ColdStorageError(
      "DESTINATION_INSIDE_CODEX_HOME",
      "Archive destination must not be inside the Codex data directory.",
    );
  }
}

function safeRelative(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ColdStorageError("PATH_ESCAPE", `Path escapes its source root: ${filePath}`);
  }
  return relative;
}

export function safeJoin(root, ...parts) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...parts);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ColdStorageError("PATH_ESCAPE", `Path escapes root: ${parts.join("/")}`);
  }
  return resolved;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function contentObjectRelativePath(deviceId, sha256, format) {
  const suffix = format === "jsonl.zst" ? ".jsonl.zst" : ".jsonl";
  return `devices/${deviceId}/sessions/objects/sha256/${sha256.slice(0, 2)}/${sha256}${suffix}`;
}

async function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.tmp-${randomUUID()}`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function pathExists(itemPath) {
  try {
    await lstat(itemPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function errorRecord(item, error) {
  return {
    sourceKey: item.sourceKey,
    code: error?.code || "UNEXPECTED_ERROR",
    message: error?.message || String(error),
  };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function normalizeBackupConfig(backup) {
  if (!isPlainObject(backup)) {
    throw new ColdStorageError("CONFIG_BACKUP_INVALID", "backup must be a JSON object.");
  }
  backup.scope = String(backup.scope || "all").trim();
  if (backup.scope !== "all") {
    throw new ColdStorageError(
      "CONFIG_BACKUP_SCOPE_INVALID",
      "backup.scope must be all; age and size filters belong only to local cleanup.",
    );
  }
  if (typeof backup.allowPartial !== "boolean") {
    throw new ColdStorageError(
      "CONFIG_BACKUP_PARTIAL_INVALID",
      "backup.allowPartial must be boolean.",
    );
  }
  if (typeof backup.verifyExistingObjects !== "boolean") {
    throw new ColdStorageError(
      "CONFIG_BACKUP_VERIFY_INVALID",
      "backup.verifyExistingObjects must be boolean.",
    );
  }
}

function normalizeRetentionConfig(retention) {
  if (!isPlainObject(retention)) {
    throw new ColdStorageError("CONFIG_RETENTION_INVALID", "retention must be a JSON object.");
  }
  for (const key of ["cleanupAfterInactiveDays", "minimumBackupAgeDays"]) {
    const value = Number(retention[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw new ColdStorageError(
        "CONFIG_RETENTION_DAYS_INVALID",
        `retention.${key} must be a non-negative number.`,
      );
    }
    retention[key] = value;
  }
  retention.reclaimAction = String(retention.reclaimAction || "keep").trim();
  if (!new Set(["keep", "link", "delete"]).has(retention.reclaimAction)) {
    throw new ColdStorageError(
      "CONFIG_RECLAIM_ACTION_INVALID",
      "retention.reclaimAction must be keep, link, or delete.",
    );
  }
  if (typeof retention.autoReclaim !== "boolean") {
    throw new ColdStorageError(
      "CONFIG_AUTO_RECLAIM_INVALID",
      "retention.autoReclaim must be boolean.",
    );
  }
}

function normalizeDeviceConfig(device) {
  if (!isPlainObject(device)) {
    throw new ColdStorageError("CONFIG_DEVICE_INVALID", "device must be a JSON object.");
  }
  device.id = String(device.id || "").trim();
  device.displayName = String(device.displayName || "").trim();
  device.platform = String(device.platform || platformName()).trim();
  if (device.id && !/^[a-z0-9][a-z0-9-]{2,63}$/.test(device.id)) {
    throw new ColdStorageError(
      "CONFIG_DEVICE_ID_INVALID",
      "device.id must match [a-z0-9][a-z0-9-]{2,63}.",
    );
  }
  if (device.displayName.length > 120) {
    throw new ColdStorageError("CONFIG_DEVICE_NAME_INVALID", "device.displayName is too long.");
  }
  if (!new Set(["macos", "windows", "linux"]).has(device.platform)) {
    throw new ColdStorageError(
      "CONFIG_DEVICE_PLATFORM_INVALID",
      "device.platform must be macos, windows, or linux.",
    );
  }
  if (device.id && !device.displayName) {
    throw new ColdStorageError(
      "CONFIG_DEVICE_NAME_REQUIRED",
      "An initialized device requires device.displayName.",
    );
  }
}

function normalizeExchangeConfig(exchange) {
  if (!isPlainObject(exchange)) {
    throw new ColdStorageError("CONFIG_EXCHANGE_INVALID", "exchange must be a JSON object.");
  }
  exchange.adapter = String(exchange.adapter || "filesystem").trim();
  if (exchange.adapter !== "filesystem") {
    throw new ColdStorageError(
      "CONFIG_EXCHANGE_ADAPTER_UNSUPPORTED",
      "Only the filesystem exchange adapter is supported in version 0.2.",
    );
  }
  exchange.storageClass = String(exchange.storageClass || "stable-mounted").trim();
  if (!new Set(["stable-mounted", "client-synced"]).has(exchange.storageClass)) {
    throw new ColdStorageError(
      "CONFIG_STORAGE_CLASS_INVALID",
      "exchange.storageClass must be stable-mounted or client-synced.",
    );
  }
  if (typeof exchange.autoPublish !== "boolean") {
    throw new ColdStorageError(
      "CONFIG_EXCHANGE_AUTOPUBLISH_INVALID",
      "exchange.autoPublish must be boolean.",
    );
  }
}

function normalizeProjectMap(projects, platform) {
  if (!isPlainObject(projects)) {
    throw new ColdStorageError("CONFIG_PROJECTS_INVALID", "projects must be a JSON object.");
  }
  for (const [projectId, localPath] of Object.entries(projects)) {
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(projectId)) {
      throw new ColdStorageError("CONFIG_PROJECT_ID_INVALID", `Invalid project ID: ${projectId}`);
    }
    if (typeof localPath !== "string") {
      throw new ColdStorageError(
        "CONFIG_PROJECT_PATH_INVALID",
        `Project path must be absolute for ${projectId}.`,
      );
    }
    const expanded = expandHome(localPath);
    const windowsAbsolute = platform === "windows" && path.win32.isAbsolute(expanded);
    const hostAbsolute = path.isAbsolute(expanded);
    if (!windowsAbsolute && !hostAbsolute) {
      throw new ColdStorageError(
        "CONFIG_PROJECT_PATH_INVALID",
        `Project path must be absolute for ${projectId}.`,
      );
    }
    projects[projectId] = windowsAbsolute ? path.win32.normalize(expanded) : path.resolve(expanded);
  }
}

function normalizeMemoryConfig(memory) {
  if (!isPlainObject(memory)) {
    throw new ColdStorageError("CONFIG_MEMORY_INVALID", "memory must be a JSON object.");
  }
  for (const key of ["autoDraft", "autoPublish", "requireEvidence"]) {
    if (typeof memory[key] !== "boolean") {
      throw new ColdStorageError(
        "CONFIG_MEMORY_BOOLEAN_INVALID",
        `memory.${key} must be boolean.`,
      );
    }
  }
  if (memory.autoPublish) {
    throw new ColdStorageError(
      "CONFIG_MEMORY_AUTOPUBLISH_UNSUPPORTED",
      "Automatic memory publication is not supported; review and approval must remain separate.",
    );
  }
}

function platformName(nodePlatform = process.platform) {
  if (nodePlatform === "darwin") return "macos";
  if (nodePlatform === "win32") return "windows";
  return "linux";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
