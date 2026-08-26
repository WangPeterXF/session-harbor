import { readFile } from "node:fs/promises";

import {
  assertDestinationIdentity,
  catalogEntryBelongsToDevice,
  ColdStorageError,
  loadCatalog,
  pathExists,
  safeJoin,
  scanSessions,
} from "./archive-core.mjs";
import { readOperationState } from "./operation-state.mjs";
import { sessionHeadPath } from "./session-snapshot.mjs";

const DAY_MS = 86_400_000;
const DASHBOARD_FILTERS = new Set([
  "all",
  "backed",
  "unbacked",
  "changed",
  "deleted",
  "linked",
  "restored",
  "cleanup-ready",
  "waiting-inactivity",
  "waiting-backup-age",
]);

export async function buildManagementDashboard(config, configPath, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const filter = String(options.filter || "all").trim();
  if (!DASHBOARD_FILTERS.has(filter)) {
    throw new ColdStorageError(
      "DASHBOARD_FILTER_INVALID",
      `Unknown dashboard filter: ${filter}. Use ${[...DASHBOARD_FILTERS].join(", ")}.`,
    );
  }
  const limit = normalizeLimit(options.limit);
  await assertDestinationIdentity(config);
  const [catalog, localSessions, operation] = await Promise.all([
    loadCatalog(config),
    scanSessions(config, { nowMs }),
    readOperationState(configPath, { nowMs }),
  ]);
  const localCatalogEntries = catalog.entries.filter((entry) =>
    catalogEntryBelongsToDevice(config, entry),
  );
  const localBySourceKey = new Map(localSessions.map((item) => [item.sourceKey, item]));
  const catalogBySourceKey = new Map(localCatalogEntries.map((item) => [item.sourceKey, item]));
  const sessions = [];

  for (const entry of localCatalogEntries) {
    sessions.push(classifyCatalogEntry(config, entry, localBySourceKey.get(entry.sourceKey), nowMs));
  }
  for (const local of localSessions) {
    if (!catalogBySourceKey.has(local.sourceKey)) sessions.push(classifyUnbacked(local));
  }
  sessions.sort(compareSessions);

  const matching = sessions.filter((item) => matchesFilter(item, filter));
  const counts = {
    localInventory: localSessions.length,
    catalogEntries: localCatalogEntries.length,
    backedCurrentLocal: sessions.filter((item) => item.backupStatus === "current").length,
    backupPending: sessions.filter((item) =>
      new Set(["unbacked", "local-changed"]).has(item.backupStatus),
    ).length,
    vaultOnly: sessions.filter((item) => item.localStatus === "deleted").length,
    linked: sessions.filter((item) => item.localStatus === "linked").length,
    restored: sessions.filter((item) => item.catalogState === "restored").length,
    inactiveEligible: sessions.filter((item) => item.inactiveEligible).length,
    waitingBackupAge: sessions.filter((item) => item.cleanupStatus === "waiting-backup-age").length,
    cleanupReady: sessions.filter((item) => item.cleanupStatus === "ready").length,
    eligiblePolicyKeep: sessions.filter((item) => item.cleanupStatus === "eligible-policy-keep").length,
    restoreAvailable: localCatalogEntries.length,
  };
  const nextCleanupEligibility = sessions
    .filter((item) => item.cleanupStatus === "waiting-backup-age" && item.cleanupEligibleAt)
    .map((item) => item.cleanupEligibleAt)
    .sort()[0] || null;

  return {
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    verificationMode: "catalog-and-local-metadata",
    verificationNote:
      "Dashboard is a fast inventory view. Run verify for a full SHA-256 check before cleanup or restore.",
    device: { ...config.device },
    destination: {
      path: config.destination,
      destinationId: config.destinationId,
      available: await pathExists(config.destination),
    },
    policy: {
      backupScope: config.backup.scope,
      cleanupAfterInactiveDays: config.retention.cleanupAfterInactiveDays,
      minimumBackupAgeDays: config.retention.minimumBackupAgeDays,
      reclaimAction: config.retention.reclaimAction,
      autoReclaim: config.retention.autoReclaim,
    },
    catalogUpdatedAt: catalog.updatedAt,
    latestPublication: await readLatestPublication(config),
    operation,
    counts,
    nextCleanupEligibility,
    filter,
    matchCount: matching.length,
    returnedCount: limit === null ? matching.length : Math.min(limit, matching.length),
    truncated: limit !== null && matching.length > limit,
    sessions: limit === null ? matching : matching.slice(0, limit),
  };
}

function classifyCatalogEntry(config, entry, local, nowMs) {
  const copiedAtMs = Date.parse(entry.copiedAt);
  const backupAgeDays = Number.isFinite(copiedAtMs) ? Math.max(0, nowMs - copiedAtMs) / DAY_MS : null;
  const isRegularLocal = Boolean(local && !local.isSymlink);
  const metadataCurrent = Boolean(
    isRegularLocal &&
      Number(local.sizeBytes) === Number(entry.sizeBytes) &&
      Number(local.mtimeMs) === Number(entry.sourceMtimeMs) &&
      (entry.sourceCtimeMs === undefined || Number(local.ctimeMs) === Number(entry.sourceCtimeMs)),
  );
  const localStatus = !local
    ? entry.state === "reclaimed"
      ? "deleted"
      : "missing"
    : local.isSymlink
      ? local.reason === "broken-link"
        ? "broken-link"
        : "linked"
      : "present";
  const backupStatus = metadataCurrent
    ? "current"
    : localStatus === "deleted"
      ? "vault-only"
      : localStatus === "linked"
        ? "linked"
        : isRegularLocal
          ? "local-changed"
          : "catalog-only";
  const inactiveEligible = Boolean(isRegularLocal && local.cleanupEligible);
  let cleanupStatus = "not-local";
  let cleanupEligibleAt = null;
  if (localStatus === "linked") cleanupStatus = "linked";
  else if (isRegularLocal && !metadataCurrent) cleanupStatus = "backup-required";
  else if (isRegularLocal && !inactiveEligible) cleanupStatus = "waiting-inactivity";
  else if (isRegularLocal && backupAgeDays < config.retention.minimumBackupAgeDays) {
    cleanupStatus = "waiting-backup-age";
    cleanupEligibleAt = Number.isFinite(copiedAtMs)
      ? new Date(copiedAtMs + config.retention.minimumBackupAgeDays * DAY_MS).toISOString()
      : null;
  } else if (isRegularLocal && config.retention.reclaimAction === "keep") {
    cleanupStatus = "eligible-policy-keep";
  } else if (isRegularLocal) cleanupStatus = "ready";

  return {
    sessionId: entry.sessionId,
    sourceKey: entry.sourceKey,
    sizeBytes: Number(entry.sizeBytes),
    modifiedAt: local?.mtimeMs ? new Date(local.mtimeMs).toISOString() : null,
    inactiveDays: local?.ageDays ?? null,
    copiedAt: entry.copiedAt,
    backupAgeDays,
    catalogState: entry.state,
    backupStatus,
    localStatus,
    cleanupStatus,
    cleanupEligibleAt,
    inactiveEligible,
    restoreAvailable: true,
  };
}

function classifyUnbacked(local) {
  return {
    sessionId: local.sessionId,
    sourceKey: local.sourceKey,
    sizeBytes: Number(local.sizeBytes || 0),
    modifiedAt: local.mtimeMs ? new Date(local.mtimeMs).toISOString() : null,
    inactiveDays: local.ageDays,
    copiedAt: null,
    backupAgeDays: null,
    catalogState: null,
    backupStatus: "unbacked",
    localStatus: local.isSymlink ? local.reason : "present",
    cleanupStatus: "backup-required",
    cleanupEligibleAt: null,
    inactiveEligible: Boolean(local.cleanupEligible),
    restoreAvailable: false,
  };
}

function matchesFilter(item, filter) {
  if (filter === "all") return true;
  if (filter === "backed") return new Set(["current", "vault-only", "linked"]).has(item.backupStatus);
  if (filter === "unbacked") return item.backupStatus === "unbacked";
  if (filter === "changed") return item.backupStatus === "local-changed";
  if (filter === "deleted") return item.localStatus === "deleted";
  if (filter === "linked") return item.localStatus === "linked";
  if (filter === "restored") return item.catalogState === "restored";
  if (filter === "cleanup-ready") return item.cleanupStatus === "ready";
  if (filter === "waiting-inactivity") return item.cleanupStatus === "waiting-inactivity";
  if (filter === "waiting-backup-age") return item.cleanupStatus === "waiting-backup-age";
  return false;
}

function compareSessions(left, right) {
  const cleanupRank = (item) =>
    item.cleanupStatus === "ready" ? 0 : item.cleanupStatus === "waiting-backup-age" ? 1 : 2;
  return cleanupRank(left) - cleanupRank(right) || right.sizeBytes - left.sizeBytes || left.sourceKey.localeCompare(right.sourceKey);
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === "") return 50;
  if (String(value).toLowerCase() === "all" || Number(value) === 0) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new ColdStorageError(
      "DASHBOARD_LIMIT_INVALID",
      "Dashboard limit must be an integer from 1 to 10000, 0, or all.",
    );
  }
  return parsed;
}

async function readLatestPublication(config) {
  if (!config.device.id) return null;
  const filePath = safeJoin(config.destination, sessionHeadPath(config.device.id));
  try {
    const head = JSON.parse(await readFile(filePath, "utf8"));
    return {
      snapshotId: head.snapshotId,
      publishedAt: head.publishedAt,
      manifestPath: head.manifestPath,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
