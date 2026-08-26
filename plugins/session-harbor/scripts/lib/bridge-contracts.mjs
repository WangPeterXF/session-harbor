const DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

export const CONTRACT_VERSION = 1;
export const CONTRACT_KINDS = Object.freeze([
  "vault-protocol",
  "device-manifest",
  "head-pointer",
  "session-snapshot",
  "memory-snapshot",
  "run-record",
]);

export class ContractValidationError extends Error {
  constructor(issues) {
    super(`SessionHarbor contract validation failed with ${issues.length} issue(s).`);
    this.name = "ContractValidationError";
    this.code = "CONTRACT_INVALID";
    this.issues = issues;
  }
}

export function validateContract(value, options = {}) {
  const issues = [];
  if (!isObject(value)) {
    throw new ContractValidationError([issue("$", "TYPE_OBJECT", "contract must be a JSON object")]);
  }

  requireExact(value.contractVersion, CONTRACT_VERSION, "$.contractVersion", issues);
  requireEnum(value.kind, CONTRACT_KINDS, "$.kind", issues);
  if (options.expectedKind) requireExact(value.kind, options.expectedKind, "$.kind", issues);

  if (CONTRACT_KINDS.includes(value.kind)) {
    const validators = {
      "vault-protocol": validateVaultProtocol,
      "device-manifest": validateDeviceManifest,
      "head-pointer": validateHeadPointer,
      "session-snapshot": validateSessionSnapshot,
      "memory-snapshot": validateMemorySnapshot,
      "run-record": validateRunRecord,
    };
    validators[value.kind](value, issues);
  }

  if (issues.length > 0) throw new ContractValidationError(issues);
  return value;
}

export function validateVaultProtocol(value) {
  const issues = arguments[1] || [];
  allowedKeys(
    value,
    [
      "contractVersion",
      "kind",
      "protocolVersion",
      "minReaderVersion",
      "volumeId",
      "createdAt",
    ],
    "$",
    issues,
  );
  requireExact(value.protocolVersion, 1, "$.protocolVersion", issues);
  requireExact(value.minReaderVersion, 1, "$.minReaderVersion", issues);
  requireUuid(value.volumeId, "$.volumeId", issues);
  requireTimestamp(value.createdAt, "$.createdAt", issues);
  return finish(value, issues, arguments.length === 1);
}

export function validateHeadPointer(value) {
  const issues = arguments[1] || [];
  allowedKeys(
    value,
    [
      "contractVersion",
      "kind",
      "deviceId",
      "stream",
      "projectId",
      "snapshotId",
      "manifestPath",
      "manifestSha256",
      "publishedAt",
    ],
    "$",
    issues,
  );
  requireDeviceId(value.deviceId, "$.deviceId", issues);
  requireEnum(value.stream, ["sessions", "memory"], "$.stream", issues);
  if (value.stream === "sessions") {
    requireNull(value.projectId, "$.projectId", issues);
  } else {
    requireProjectId(value.projectId, "$.projectId", issues);
  }
  requireUuid(value.snapshotId, "$.snapshotId", issues);
  requirePortablePath(value.manifestPath, "$.manifestPath", issues);
  requireSha256(value.manifestSha256, "$.manifestSha256", issues);
  requireTimestamp(value.publishedAt, "$.publishedAt", issues);

  if (DEVICE_ID_RE.test(value.deviceId || "") && UUID_RE.test(value.snapshotId || "")) {
    const expectedPrefix =
      value.stream === "memory" && PROJECT_ID_RE.test(value.projectId || "")
        ? `devices/${value.deviceId}/memory/projects/${value.projectId}/snapshots/`
        : `devices/${value.deviceId}/sessions/manifests/`;
    if (
      typeof value.manifestPath === "string" &&
      (!value.manifestPath.startsWith(expectedPrefix) || !value.manifestPath.endsWith(`/${value.snapshotId}.json`))
    ) {
      issues.push(
        issue(
          "$.manifestPath",
          "HEAD_PATH_MISMATCH",
          `manifestPath must point to this device's ${value.stream} snapshot`,
        ),
      );
    }
  }
  return finish(value, issues, arguments.length === 1);
}

export function validateDeviceManifest(value) {
  const issues = arguments[1] || [];
  allowedKeys(
    value,
    [
      "contractVersion",
      "kind",
      "deviceId",
      "displayName",
      "platform",
      "createdAt",
      "capabilities",
    ],
    "$",
    issues,
  );
  requireDeviceId(value.deviceId, "$.deviceId", issues);
  requireString(value.displayName, "$.displayName", issues, { min: 1, max: 120 });
  requireEnum(value.platform, ["macos", "windows", "linux"], "$.platform", issues);
  requireTimestamp(value.createdAt, "$.createdAt", issues);
  requireStringArray(
    value.capabilities,
    ["session-archive", "session-exchange", "memory-exchange"],
    "$.capabilities",
    issues,
  );
  return finish(value, issues, arguments.length === 1);
}

export function validateSessionSnapshot(value) {
  const issues = arguments[1] || [];
  allowedKeys(
    value,
    [
      "contractVersion",
      "kind",
      "snapshotId",
      "deviceId",
      "createdAt",
      "parentSnapshotId",
      "source",
      "objects",
    ],
    "$",
    issues,
  );
  requireUuid(value.snapshotId, "$.snapshotId", issues);
  requireDeviceId(value.deviceId, "$.deviceId", issues);
  requireTimestamp(value.createdAt, "$.createdAt", issues);
  requireNullableUuid(value.parentSnapshotId, "$.parentSnapshotId", issues);

  if (!isObject(value.source)) {
    issues.push(issue("$.source", "TYPE_OBJECT", "source must be an object"));
  } else {
    allowedKeys(value.source, ["type", "roots"], "$.source", issues);
    requireExact(value.source.type, "codex-local", "$.source.type", issues);
    requireStringArray(value.source.roots, ["sessions", "archived_sessions"], "$.source.roots", issues);
  }

  if (!Array.isArray(value.objects)) {
    issues.push(issue("$.objects", "TYPE_ARRAY", "objects must be an array"));
  } else {
    const sourceKeys = new Set();
    for (const [index, object] of value.objects.entries()) {
      const at = `$.objects[${index}]`;
      if (!isObject(object)) {
        issues.push(issue(at, "TYPE_OBJECT", "session object must be an object"));
        continue;
      }
      allowedKeys(
        object,
        ["sessionId", "sourceKey", "sha256", "sizeBytes", "modifiedAt", "objectPath", "encoding"],
        at,
        issues,
      );
      requireUuid(object.sessionId, `${at}.sessionId`, issues);
      requirePortablePath(object.sourceKey, `${at}.sourceKey`, issues);
      if (
        typeof object.sourceKey === "string" &&
        !/^(sessions|archived_sessions)\/.+\.jsonl(?:\.zst)?$/.test(object.sourceKey)
      ) {
        issues.push(
          issue(
            `${at}.sourceKey`,
            "SESSION_SOURCE_KEY",
            "sourceKey must be below sessions/ or archived_sessions/ and name a JSONL object",
          ),
        );
      }
      requireSha256(object.sha256, `${at}.sha256`, issues);
      requireInteger(object.sizeBytes, `${at}.sizeBytes`, issues, { min: 0 });
      requireTimestamp(object.modifiedAt, `${at}.modifiedAt`, issues);
      requirePortablePath(object.objectPath, `${at}.objectPath`, issues);
      requireEnum(object.encoding, ["identity", "zstd"], `${at}.encoding`, issues);

      if (DEVICE_ID_RE.test(value.deviceId || "") && SHA256_RE.test(object.sha256 || "")) {
        const suffix = object.encoding === "zstd" ? ".jsonl.zst" : ".jsonl";
        const expected =
          `devices/${value.deviceId}/sessions/objects/sha256/` +
          `${object.sha256.slice(0, 2)}/${object.sha256}${suffix}`;
        if (object.objectPath !== expected) {
          issues.push(
            issue(
              `${at}.objectPath`,
              "OBJECT_PATH_MISMATCH",
              `objectPath must be the content-addressed path ${expected}`,
            ),
          );
        }
      }
      if (sourceKeys.has(object.sourceKey)) {
        issues.push(issue(`${at}.sourceKey`, "DUPLICATE_SOURCE_KEY", "sourceKey must be unique"));
      }
      sourceKeys.add(object.sourceKey);
    }
  }
  return finish(value, issues, arguments.length === 1);
}

export function validateMemorySnapshot(value) {
  const issues = arguments[1] || [];
  allowedKeys(
    value,
    [
      "contractVersion",
      "kind",
      "snapshotId",
      "projectId",
      "deviceId",
      "createdAt",
      "parents",
      "review",
      "entries",
    ],
    "$",
    issues,
  );
  requireUuid(value.snapshotId, "$.snapshotId", issues);
  requireProjectId(value.projectId, "$.projectId", issues);
  requireDeviceId(value.deviceId, "$.deviceId", issues);
  requireTimestamp(value.createdAt, "$.createdAt", issues);
  requireUuidArray(value.parents, "$.parents", issues);

  if (!isObject(value.review)) {
    issues.push(issue("$.review", "TYPE_OBJECT", "review must be an object"));
  } else {
    allowedKeys(value.review, ["status", "reviewedAt", "reviewerDeviceId"], "$.review", issues);
    requireEnum(value.review.status, ["draft", "approved"], "$.review.status", issues);
    if (value.review.status === "approved") {
      requireTimestamp(value.review.reviewedAt, "$.review.reviewedAt", issues);
      requireDeviceId(value.review.reviewerDeviceId, "$.review.reviewerDeviceId", issues);
    } else {
      requireNull(value.review.reviewedAt, "$.review.reviewedAt", issues);
      requireNull(value.review.reviewerDeviceId, "$.review.reviewerDeviceId", issues);
    }
  }

  if (!Array.isArray(value.entries)) {
    issues.push(issue("$.entries", "TYPE_ARRAY", "entries must be an array"));
  } else {
    const entryIds = new Set();
    const entryKeys = new Set();
    for (const [index, entry] of value.entries.entries()) {
      const at = `$.entries[${index}]`;
      if (!isObject(entry)) {
        issues.push(issue(at, "TYPE_OBJECT", "memory entry must be an object"));
        continue;
      }
      allowedKeys(
        entry,
        ["entryId", "operation", "scope", "key", "text", "observedAt", "sensitivity", "evidence"],
        at,
        issues,
      );
      requireUuid(entry.entryId, `${at}.entryId`, issues);
      requireEnum(entry.operation, ["upsert", "retract"], `${at}.operation`, issues);
      requireEnum(entry.scope, ["global", "project", "thread"], `${at}.scope`, issues);
      requireMemoryKey(entry.key, `${at}.key`, issues);
      requireString(entry.text, `${at}.text`, issues, { min: 1, max: 8000 });
      requireTimestamp(entry.observedAt, `${at}.observedAt`, issues);
      requireEnum(entry.sensitivity, ["normal", "restricted"], `${at}.sensitivity`, issues);
      validateEvidence(entry.evidence, `${at}.evidence`, issues);
      if (entryIds.has(entry.entryId)) {
        issues.push(issue(`${at}.entryId`, "DUPLICATE_ENTRY_ID", "entryId must be unique"));
      }
      if (entryKeys.has(entry.key)) {
        issues.push(issue(`${at}.key`, "DUPLICATE_MEMORY_KEY", "memory key must be unique per snapshot"));
      }
      entryIds.add(entry.entryId);
      entryKeys.add(entry.key);
    }
  }
  return finish(value, issues, arguments.length === 1);
}

export function validateRunRecord(value) {
  const issues = arguments[1] || [];
  allowedKeys(
    value,
    [
      "contractVersion",
      "kind",
      "runId",
      "deviceId",
      "operation",
      "dryRun",
      "status",
      "startedAt",
      "completedAt",
      "inputRefs",
      "outputRefs",
      "counts",
      "warnings",
      "errors",
    ],
    "$",
    issues,
  );
  requireUuid(value.runId, "$.runId", issues);
  requireDeviceId(value.deviceId, "$.deviceId", issues);
  requireEnum(
    value.operation,
    [
      "doctor",
      "archive",
      "backup",
      "verify",
      "restore",
      "sync-plan",
      "sync-push",
      "sync-pull",
      "memory-draft",
      "memory-approve",
      "memory-diff",
      "memory-stage",
      "migration",
      "device-init",
    ],
    "$.operation",
    issues,
  );
  requireBoolean(value.dryRun, "$.dryRun", issues);
  requireEnum(value.status, ["planned", "succeeded", "failed", "partial"], "$.status", issues);
  requireTimestamp(value.startedAt, "$.startedAt", issues);
  if (value.completedAt !== null) requireTimestamp(value.completedAt, "$.completedAt", issues);
  if (value.status !== "planned" && value.completedAt === null) {
    issues.push(issue("$.completedAt", "RUN_NOT_COMPLETED", "a non-planned run requires completedAt"));
  }
  requirePortablePathArray(value.inputRefs, "$.inputRefs", issues);
  requirePortablePathArray(value.outputRefs, "$.outputRefs", issues);
  validateCounts(value.counts, "$.counts", issues);
  requireFreeStringArray(value.warnings, "$.warnings", issues);
  requireFreeStringArray(value.errors, "$.errors", issues);
  return finish(value, issues, arguments.length === 1);
}

export function isPortableRelativePath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) return false;
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  const segments = value.split("/");
  return !segments.some((segment) => segment === "" || segment === "." || segment === "..");
}

function validateEvidence(value, at, issues) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue(at, "EVIDENCE_REQUIRED", "evidence must be a non-empty array"));
    return;
  }
  for (const [index, evidence] of value.entries()) {
    const itemAt = `${at}[${index}]`;
    if (!isObject(evidence)) {
      issues.push(issue(itemAt, "TYPE_OBJECT", "evidence item must be an object"));
      continue;
    }
    allowedKeys(evidence, ["sessionId", "sha256", "locator"], itemAt, issues);
    requireUuid(evidence.sessionId, `${itemAt}.sessionId`, issues);
    requireSha256(evidence.sha256, `${itemAt}.sha256`, issues);
    requireString(evidence.locator, `${itemAt}.locator`, issues, { min: 1, max: 512 });
  }
}

function validateCounts(value, at, issues) {
  if (!isObject(value)) {
    issues.push(issue(at, "TYPE_OBJECT", "counts must be an object"));
    return;
  }
  for (const [key, count] of Object.entries(value)) {
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(key)) {
      issues.push(issue(`${at}.${key}`, "COUNT_KEY", "count keys must be lower camel case"));
    }
    requireInteger(count, `${at}.${key}`, issues, { min: 0 });
  }
}

function allowedKeys(value, keys, at, issues) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) issues.push(issue(`${at}.${key}`, "UNKNOWN_FIELD", "field is not in contract v1"));
  }
  for (const key of keys) {
    if (!(key in value)) issues.push(issue(`${at}.${key}`, "FIELD_REQUIRED", "field is required"));
  }
}

function requireDeviceId(value, at, issues) {
  if (typeof value !== "string" || !DEVICE_ID_RE.test(value)) {
    issues.push(issue(at, "DEVICE_ID", "deviceId must match [a-z0-9][a-z0-9-]{2,63}"));
  }
}

function requireProjectId(value, at, issues) {
  if (typeof value !== "string" || !PROJECT_ID_RE.test(value)) {
    issues.push(issue(at, "PROJECT_ID", "projectId must be a portable lowercase slug"));
  }
}

function requireMemoryKey(value, at, issues) {
  if (typeof value !== "string" || value.length < 3 || value.length > 192 || !isPortableRelativePath(value)) {
    issues.push(issue(at, "MEMORY_KEY", "memory key must be a portable relative key"));
  }
}

function requireUuid(value, at, issues) {
  if (typeof value !== "string" || !UUID_RE.test(value)) issues.push(issue(at, "UUID", "value must be a UUID"));
}

function requireNullableUuid(value, at, issues) {
  if (value !== null) requireUuid(value, at, issues);
}

function requireUuidArray(value, at, issues) {
  if (!Array.isArray(value)) {
    issues.push(issue(at, "TYPE_ARRAY", "value must be an array"));
    return;
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    requireUuid(item, `${at}[${index}]`, issues);
    if (seen.has(item)) issues.push(issue(`${at}[${index}]`, "DUPLICATE_UUID", "UUID must be unique"));
    seen.add(item);
  }
}

function requireSha256(value, at, issues) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    issues.push(issue(at, "SHA256", "value must be a lowercase SHA-256 digest"));
  }
}

function requireTimestamp(value, at, issues) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    issues.push(issue(at, "TIMESTAMP_UTC", "timestamp must be an RFC 3339 UTC value ending in Z"));
  }
}

function requirePortablePath(value, at, issues) {
  if (!isPortableRelativePath(value)) {
    issues.push(issue(at, "PORTABLE_PATH", "path must be relative, slash-separated, and traversal-free"));
  }
}

function requirePortablePathArray(value, at, issues) {
  if (!Array.isArray(value)) {
    issues.push(issue(at, "TYPE_ARRAY", "value must be an array"));
    return;
  }
  for (const [index, item] of value.entries()) requirePortablePath(item, `${at}[${index}]`, issues);
}

function requireStringArray(value, allowed, at, issues) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue(at, "TYPE_ARRAY", "value must be a non-empty array"));
    return;
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    requireEnum(item, allowed, `${at}[${index}]`, issues);
    if (seen.has(item)) issues.push(issue(`${at}[${index}]`, "DUPLICATE_VALUE", "value must be unique"));
    seen.add(item);
  }
}

function requireFreeStringArray(value, at, issues) {
  if (!Array.isArray(value)) {
    issues.push(issue(at, "TYPE_ARRAY", "value must be an array"));
    return;
  }
  for (const [index, item] of value.entries()) {
    requireString(item, `${at}[${index}]`, issues, { min: 1, max: 2000 });
  }
}

function requireString(value, at, issues, { min, max }) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    issues.push(issue(at, "STRING_LENGTH", `value must be a string between ${min} and ${max} characters`));
  }
}

function requireInteger(value, at, issues, { min }) {
  if (!Number.isSafeInteger(value) || value < min) {
    issues.push(issue(at, "INTEGER_RANGE", `value must be a safe integer greater than or equal to ${min}`));
  }
}

function requireBoolean(value, at, issues) {
  if (typeof value !== "boolean") issues.push(issue(at, "TYPE_BOOLEAN", "value must be boolean"));
}

function requireNull(value, at, issues) {
  if (value !== null) issues.push(issue(at, "TYPE_NULL", "value must be null"));
}

function requireEnum(value, allowed, at, issues) {
  if (!allowed.includes(value)) {
    issues.push(issue(at, "ENUM", `value must be one of: ${allowed.join(", ")}`));
  }
}

function requireExact(value, expected, at, issues) {
  if (value !== expected) issues.push(issue(at, "EXACT_VALUE", `value must equal ${JSON.stringify(expected)}`));
}

function issue(path, code, message) {
  return { path, code, message };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finish(value, issues, shouldThrow) {
  if (shouldThrow && issues.length > 0) throw new ContractValidationError(issues);
  return value;
}
