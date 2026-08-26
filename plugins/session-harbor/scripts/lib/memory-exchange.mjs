import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  ColdStorageError,
  assertDestinationIdentity,
  hashFile,
  pathExists,
} from "./archive-core.mjs";
import {
  hashCanonicalJson,
  publishImmutableJson,
  publishMutableJson,
  readRegularJson,
  resolvePortablePath,
} from "./atomic-store.mjs";
import { CONTRACT_VERSION, validateContract } from "./bridge-contracts.mjs";
import { readSessionHead } from "./session-snapshot.mjs";

const STAGED_MEMORY_VERSION = 1;
const STAGED_MEMORY_FILENAME = "staged-memory-v1.json";

export function memoryHeadPath(deviceId, projectId) {
  return `devices/${deviceId}/heads/memory/${projectId}.json`;
}

export function memorySnapshotPath(deviceId, projectId, snapshotId, at = new Date()) {
  return (
    `devices/${deviceId}/memory/projects/${projectId}/snapshots/` +
    `${String(at.getUTCFullYear()).padStart(4, "0")}/` +
    `${String(at.getUTCMonth() + 1).padStart(2, "0")}/${snapshotId}.json`
  );
}

export async function createMemoryDraft(config, configPath, projectId, input, options = {}) {
  requireDeviceAndProject(config, projectId);
  const now = normalizeTime(options.now);
  const localSessions = await readSessionHead(config, config.device.id, { verifyObjects: true });
  if (!localSessions) {
    throw new ColdStorageError(
      "MEMORY_EVIDENCE_SNAPSHOT_REQUIRED",
      "Publish a verified local session snapshot before drafting shared memory.",
    );
  }
  const sourceEntries = Array.isArray(input) ? input : input?.entries;
  if (!Array.isArray(sourceEntries) || sourceEntries.length === 0) {
    throw new ColdStorageError("MEMORY_ENTRIES_REQUIRED", "A memory draft requires at least one entry.");
  }
  const entries = sourceEntries.map((entry) => ({
    entryId: entry.entryId || randomUUID(),
    operation: entry.operation || "upsert",
    scope: entry.scope || "project",
    key: entry.key,
    text: entry.text,
    observedAt: entry.observedAt || now.toISOString(),
    sensitivity: entry.sensitivity || "normal",
    evidence: entry.evidence,
  }));
  verifyMemoryEvidence(entries, localSessions.manifest);
  const draft = {
    contractVersion: CONTRACT_VERSION,
    kind: "memory-snapshot",
    snapshotId: options.snapshotId || randomUUID(),
    projectId,
    deviceId: config.device.id,
    createdAt: now.toISOString(),
    parents: uniqueUuids(input?.parents || []),
    review: { status: "draft", reviewedAt: null, reviewerDeviceId: null },
    entries,
  };
  validateContract(draft, { expectedKind: "memory-snapshot" });
  const relativePath = draftRelativePath(projectId, draft.snapshotId);
  const result = {
    ok: true,
    action: "memory-draft",
    apply: false,
    projectId,
    draftId: draft.snapshotId,
    relativePath,
    draft,
  };
  if (!options.apply) return result;
  const localRoot = privateMemoryRoot(configPath);
  await mkdir(localRoot, { recursive: true, mode: 0o700 });
  await publishImmutableJson(localRoot, relativePath, draft, {
    runId: options.runId || randomUUID(),
    conflictCode: "MEMORY_DRAFT_CONFLICT",
  });
  return { ...result, apply: true };
}

export async function approveMemoryDraft(config, configPath, projectId, draftId, options = {}) {
  requireDeviceAndProject(config, projectId);
  await assertDestinationIdentity(config);
  const localRoot = privateMemoryRoot(configPath);
  const draft = validateContract(
    await readRegularJson(localRoot, draftRelativePath(projectId, draftId)),
    { expectedKind: "memory-snapshot" },
  );
  if (
    draft.deviceId !== config.device.id ||
    draft.projectId !== projectId ||
    draft.review.status !== "draft"
  ) {
    throw new ColdStorageError("MEMORY_DRAFT_IDENTITY_MISMATCH", "The selected draft is not local and reviewable.");
  }
  const restricted = draft.entries.filter((entry) => entry.sensitivity === "restricted");
  if (restricted.length > 0 && !options.includeRestricted) {
    throw new ColdStorageError(
      "MEMORY_RESTRICTED_APPROVAL_REQUIRED",
      `The draft contains ${restricted.length} restricted entry or entries.`,
    );
  }
  const localSessions = await readSessionHead(config, config.device.id, { verifyObjects: true });
  verifyMemoryEvidence(draft.entries, localSessions.manifest);
  const current = await readMemoryHead(config, config.device.id, projectId);
  const now = normalizeTime(options.now);
  const approved = {
    ...draft,
    snapshotId: options.snapshotId || randomUUID(),
    createdAt: now.toISOString(),
    parents: uniqueUuids([
      ...(draft.parents || []),
      ...(current?.manifest.snapshotId ? [current.manifest.snapshotId] : []),
    ]),
    review: {
      status: "approved",
      reviewedAt: now.toISOString(),
      reviewerDeviceId: config.device.id,
    },
  };
  validateContract(approved, { expectedKind: "memory-snapshot" });
  const snapshotPath = memorySnapshotPath(
    config.device.id,
    projectId,
    approved.snapshotId,
    now,
  );
  const plan = {
    ok: true,
    action: "memory-approve",
    apply: false,
    projectId,
    draftId,
    snapshotId: approved.snapshotId,
    snapshotPath,
    headPath: memoryHeadPath(config.device.id, projectId),
    approved,
  };
  if (!options.apply) return plan;

  const runId = options.runId || randomUUID();
  const snapshotResult = await publishImmutableJson(config.destination, snapshotPath, approved, {
    runId,
    conflictCode: "MEMORY_SNAPSHOT_CONFLICT",
  });
  const head = {
    contractVersion: CONTRACT_VERSION,
    kind: "head-pointer",
    deviceId: config.device.id,
    stream: "memory",
    projectId,
    snapshotId: approved.snapshotId,
    manifestPath: snapshotPath,
    manifestSha256: snapshotResult.sha256,
    publishedAt: now.toISOString(),
  };
  validateContract(head, { expectedKind: "head-pointer" });
  await publishMutableJson(config.destination, plan.headPath, head, {
    runId,
    expectedCurrentSha256: current?.headSha256,
    expectedAbsent: !current,
    concurrentCode: "MEMORY_HEAD_CONCURRENT_UPDATE",
    beforePublish: options.beforeHeadPublish,
  });
  const runPath = runRecordPath(config.device.id, runId, now);
  const runRecord = createRunRecord({
    runId,
    deviceId: config.device.id,
    operation: "memory-approve",
    at: now,
    inputRefs: [draftRelativePath(projectId, draftId)],
    outputRefs: [snapshotPath, plan.headPath, runPath],
    counts: { entriesApproved: approved.entries.length, restrictedEntries: restricted.length },
  });
  await publishImmutableJson(config.destination, runPath, runRecord, {
    runId,
    conflictCode: "RUN_RECORD_CONFLICT",
  });
  return { ...plan, apply: true, head, runRecord, runPath };
}

export async function readMemoryHead(config, deviceId, projectId) {
  const headPath = memoryHeadPath(deviceId, projectId);
  if (!(await pathExists(resolvePortablePath(config.destination, headPath)))) return null;
  const head = validateContract(await readRegularJson(config.destination, headPath), {
    expectedKind: "head-pointer",
  });
  if (head.deviceId !== deviceId || head.stream !== "memory" || head.projectId !== projectId) {
    throw new ColdStorageError("MEMORY_HEAD_IDENTITY_MISMATCH", `Invalid memory head: ${headPath}`);
  }
  const actualHash = await hashFile(resolvePortablePath(config.destination, head.manifestPath));
  if (actualHash !== head.manifestSha256) {
    throw new ColdStorageError("MEMORY_HEAD_HASH_MISMATCH", `Memory head hash mismatch: ${headPath}`);
  }
  const manifest = validateContract(await readRegularJson(config.destination, head.manifestPath), {
    expectedKind: "memory-snapshot",
  });
  if (
    manifest.deviceId !== deviceId ||
    manifest.projectId !== projectId ||
    manifest.snapshotId !== head.snapshotId ||
    manifest.review.status !== "approved"
  ) {
    throw new ColdStorageError(
      "MEMORY_SNAPSHOT_NOT_APPROVED",
      "A peer-visible memory head must reference an approved matching snapshot.",
    );
  }
  return { head, manifest, headPath, headSha256: hashCanonicalJson(head) };
}

export async function diffPeerMemory(config, configPath, peerId, projectId) {
  requireDeviceAndProject(config, projectId);
  if (!peerId || peerId === config.device.id) {
    throw new ColdStorageError("MEMORY_PEER_REQUIRED", "Select a different peer device.");
  }
  await assertDestinationIdentity(config);
  const peer = await readMemoryHead(config, peerId, projectId);
  if (!peer) {
    throw new ColdStorageError("MEMORY_PEER_HEAD_MISSING", `No approved memory exists for ${peerId}/${projectId}.`);
  }
  await verifyPeerMemoryEvidence(config, peerId, peer.manifest);
  const staged = await loadStagedMemory(configPath);
  const previous = staged.projects?.[projectId]?.peers?.[peerId] || null;
  const diff = diffEntries(previous?.entries || [], peer.manifest.entries);
  return {
    ok: true,
    action: "memory-diff",
    peerId,
    projectId,
    snapshotId: peer.manifest.snapshotId,
    previousSnapshotId: previous?.snapshotId || null,
    ...diff,
  };
}

export async function stagePeerMemory(config, configPath, peerId, projectId, options = {}) {
  const diff = await diffPeerMemory(config, configPath, peerId, projectId);
  const peer = await readMemoryHead(config, peerId, projectId);
  const included = peer.manifest.entries.filter(
    (entry) => options.includeRestricted || entry.sensitivity !== "restricted",
  );
  const excludedRestricted = peer.manifest.entries.length - included.length;
  const plan = {
    ...diff,
    action: "memory-stage",
    apply: false,
    entries: included,
    excludedRestricted,
  };
  if (!options.apply) return plan;
  const state = await loadStagedMemory(configPath);
  state.version = STAGED_MEMORY_VERSION;
  state.updatedAt = new Date().toISOString();
  state.projects ||= {};
  state.projects[projectId] ||= { peers: {} };
  state.projects[projectId].peers[peerId] = {
    snapshotId: peer.manifest.snapshotId,
    stagedAt: state.updatedAt,
    sourceHead: peer.head,
    entries: included,
    excludedRestricted,
    adoptionState: "staged",
  };
  const root = path.dirname(configPath);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await publishMutableJson(root, STAGED_MEMORY_FILENAME, state, {
    runId: options.runId || randomUUID(),
  });
  return { ...plan, apply: true, statePath: path.join(root, STAGED_MEMORY_FILENAME) };
}

export async function memoryStatus(configPath, options = {}) {
  const state = await loadStagedMemory(configPath);
  const projects = [];
  for (const [projectId, project] of Object.entries(state.projects || {})) {
    for (const [peerId, peer] of Object.entries(project.peers || {})) {
      if (options.projectId && options.projectId !== projectId) continue;
      projects.push({
        projectId,
        peerId,
        snapshotId: peer.snapshotId,
        stagedAt: peer.stagedAt,
        adoptionState: peer.adoptionState,
        entryCount: peer.entries.length,
        excludedRestricted: peer.excludedRestricted,
        entries: peer.entries,
      });
    }
  }
  return { ok: true, action: "memory-status", updatedAt: state.updatedAt, projects };
}

export async function loadStagedMemory(configPath) {
  const file = path.join(path.dirname(configPath), STAGED_MEMORY_FILENAME);
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value?.version !== STAGED_MEMORY_VERSION || !isObject(value.projects)) {
      throw new ColdStorageError("STAGED_MEMORY_INVALID", `Invalid staged memory state: ${file}`);
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { version: STAGED_MEMORY_VERSION, updatedAt: null, projects: {} };
    }
    if (error instanceof SyntaxError) {
      throw new ColdStorageError("STAGED_MEMORY_JSON_INVALID", `Invalid staged memory JSON: ${file}`);
    }
    throw error;
  }
}

function verifyMemoryEvidence(entries, sessionManifest) {
  const evidence = new Set(
    sessionManifest.objects.map((object) => `${object.sessionId}\0${object.sha256}`),
  );
  for (const entry of entries) {
    for (const item of entry.evidence || []) {
      if (!evidence.has(`${item.sessionId}\0${item.sha256}`)) {
        throw new ColdStorageError(
          "MEMORY_EVIDENCE_NOT_FOUND",
          `Memory evidence is not present in the verified session snapshot: ${item.sessionId}`,
        );
      }
    }
  }
}

async function verifyPeerMemoryEvidence(config, peerId, memoryManifest) {
  const session = await readSessionHead(config, peerId, { verifyObjects: true });
  if (!session) {
    throw new ColdStorageError("MEMORY_PEER_SESSION_HEAD_MISSING", "Peer memory has no session evidence head.");
  }
  verifyMemoryEvidence(memoryManifest.entries, session.manifest);
}

function diffEntries(previous, current) {
  const oldByKey = new Map(previous.map((entry) => [entry.key, entry]));
  const newByKey = new Map(current.map((entry) => [entry.key, entry]));
  const added = [];
  const changed = [];
  const removed = [];
  for (const [key, entry] of newByKey) {
    const old = oldByKey.get(key);
    if (!old) added.push(entry);
    else if (memoryEntryFingerprint(old) !== memoryEntryFingerprint(entry)) {
      changed.push({ key, before: old, after: entry });
    }
  }
  for (const [key, entry] of oldByKey) {
    if (!newByKey.has(key)) removed.push(entry);
  }
  return { counts: { added: added.length, changed: changed.length, removed: removed.length }, added, changed, removed };
}

function memoryEntryFingerprint(entry) {
  return JSON.stringify({
    operation: entry.operation,
    scope: entry.scope,
    key: entry.key,
    text: entry.text,
    sensitivity: entry.sensitivity,
    evidence: entry.evidence,
  });
}

function draftRelativePath(projectId, draftId) {
  return `drafts/${projectId}/${draftId}.json`;
}

function privateMemoryRoot(configPath) {
  return path.join(path.dirname(configPath), "memory");
}

function runRecordPath(deviceId, runId, at) {
  return (
    `devices/${deviceId}/runs/` +
    `${String(at.getUTCFullYear()).padStart(4, "0")}/` +
    `${String(at.getUTCMonth() + 1).padStart(2, "0")}/${runId}.json`
  );
}

function createRunRecord({ runId, deviceId, operation, at, inputRefs, outputRefs, counts }) {
  const record = {
    contractVersion: CONTRACT_VERSION,
    kind: "run-record",
    runId,
    deviceId,
    operation,
    dryRun: false,
    status: "succeeded",
    startedAt: at.toISOString(),
    completedAt: at.toISOString(),
    inputRefs,
    outputRefs,
    counts,
    warnings: [],
    errors: [],
  };
  validateContract(record, { expectedKind: "run-record" });
  return record;
}

function requireDeviceAndProject(config, projectId) {
  if (!config.device?.id) {
    throw new ColdStorageError("DEVICE_NOT_INITIALIZED", "Initialize the device before using memory exchange.");
  }
  if (typeof projectId !== "string" || !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(projectId)) {
    throw new ColdStorageError("PROJECT_ID_INVALID", "A portable project ID is required.");
  }
}

function uniqueUuids(values) {
  return [...new Set(values)];
}

function normalizeTime(value) {
  const result = value ? new Date(value) : new Date();
  if (Number.isNaN(result.getTime())) {
    throw new ColdStorageError("MEMORY_TIME_INVALID", "Memory timestamp is invalid.");
  }
  return result;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
