import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  initializeStorage,
  normalizeConfig,
  pathExists,
} from "../plugins/session-harbor/scripts/lib/archive-core.mjs";
import { resolvePortablePath } from "../plugins/session-harbor/scripts/lib/atomic-store.mjs";
import { initializeDevice } from "../plugins/session-harbor/scripts/lib/device-registry.mjs";
import {
  approveMemoryDraft,
  createMemoryDraft,
  diffPeerMemory,
  loadStagedMemory,
  memoryHeadPath,
  memoryStatus,
  readMemoryHead,
  stagePeerMemory,
} from "../plugins/session-harbor/scripts/lib/memory-exchange.mjs";
import { pushSessionSnapshot, readSessionHead } from "../plugins/session-harbor/scripts/lib/session-snapshot.mjs";

const MAC_SESSION = "019f5000-1111-7111-8111-111111111111";
const WIN_SESSION = "019f5000-2222-7222-8222-222222222222";

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-m4-"));
  const destination = path.join(base, "vault");
  const mac = await createDevice(base, destination, {
    id: "mac-memory",
    platform: "macos",
    sessionId: MAC_SESSION,
    destinationId: "",
    runId: "019f5000-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  });
  const windows = await createDevice(base, destination, {
    id: "windows-memory",
    platform: "windows",
    sessionId: WIN_SESSION,
    destinationId: mac.config.destinationId,
    runId: "019f5000-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
  });
  await pushSessionSnapshot(mac.config, {
    apply: true,
    now: "2026-08-22T00:00:00Z",
    runId: "019f5000-cccc-7ccc-8ccc-cccccccccccc",
  });
  await pushSessionSnapshot(windows.config, {
    apply: true,
    now: "2026-08-22T00:01:00Z",
    runId: "019f5000-dddd-7ddd-8ddd-dddddddddddd",
  });
  return { base, destination, mac, windows };
}

test("memory draft is dry-run by default and applied draft remains private", async () => {
  const item = await fixture();
  const input = await draftInput(item.mac.config, "normal");
  const planned = await createMemoryDraft(
    item.mac.config,
    item.mac.configPath,
    "session-harbor",
    input,
    { now: "2026-08-22T01:00:00Z", snapshotId: "019f5001-aaaa-7aaa-8aaa-aaaaaaaaaaaa" },
  );
  assert.equal(planned.apply, false);
  assert.equal(await pathExists(path.join(path.dirname(item.mac.configPath), "memory")), false);
  assert.equal(
    await pathExists(resolvePortablePath(item.destination, memoryHeadPath("mac-memory", "session-harbor"))),
    false,
  );

  const applied = await createMemoryDraft(
    item.mac.config,
    item.mac.configPath,
    "session-harbor",
    input,
    { apply: true, now: "2026-08-22T01:00:00Z", snapshotId: planned.draftId },
  );
  assert.equal(applied.apply, true);
  assert.equal(
    await pathExists(resolvePortablePath(item.destination, memoryHeadPath("mac-memory", "session-harbor"))),
    false,
    "draft must not become peer-visible",
  );
});

test("draft rejects missing or stale session evidence", async () => {
  const item = await fixture();
  const input = await draftInput(item.mac.config, "normal");
  input.entries[0].evidence[0].sha256 = "f".repeat(64);
  await assert.rejects(
    () => createMemoryDraft(item.mac.config, item.mac.configPath, "session-harbor", input),
    (error) => error.code === "MEMORY_EVIDENCE_NOT_FOUND",
  );
});

test("restricted memory requires explicit approval and is excluded from normal staging", async () => {
  const item = await fixture();
  const input = await draftInput(item.mac.config, "restricted");
  const draft = await createMemoryDraft(
    item.mac.config,
    item.mac.configPath,
    "session-harbor",
    input,
    { apply: true, now: "2026-08-22T01:00:00Z", snapshotId: "019f5001-bbbb-7bbb-8bbb-bbbbbbbbbbbb" },
  );
  await assert.rejects(
    () =>
      approveMemoryDraft(
        item.mac.config,
        item.mac.configPath,
        "session-harbor",
        draft.draftId,
      ),
    (error) => error.code === "MEMORY_RESTRICTED_APPROVAL_REQUIRED",
  );
  const approved = await approveMemoryDraft(
    item.mac.config,
    item.mac.configPath,
    "session-harbor",
    draft.draftId,
    {
      apply: true,
      includeRestricted: true,
      now: "2026-08-22T02:00:00Z",
      snapshotId: "019f5001-cccc-7ccc-8ccc-cccccccccccc",
      runId: "019f5001-dddd-7ddd-8ddd-dddddddddddd",
    },
  );
  assert.equal(approved.head.snapshotId, approved.snapshotId);

  const staged = await stagePeerMemory(
    item.windows.config,
    item.windows.configPath,
    "mac-memory",
    "session-harbor",
    { apply: true },
  );
  assert.equal(staged.entries.length, 0);
  assert.equal(staged.excludedRestricted, 1);
});

test("approved peer memory can be diffed, staged, and read offline with provenance", async () => {
  const item = await fixture();
  await publishNormalMemory(item.mac);
  const diff = await diffPeerMemory(
    item.windows.config,
    item.windows.configPath,
    "mac-memory",
    "session-harbor",
  );
  assert.equal(diff.counts.added, 1);
  const planned = await stagePeerMemory(
    item.windows.config,
    item.windows.configPath,
    "mac-memory",
    "session-harbor",
  );
  assert.equal(planned.apply, false);
  assert.equal((await loadStagedMemory(item.windows.configPath)).updatedAt, null);

  const applied = await stagePeerMemory(
    item.windows.config,
    item.windows.configPath,
    "mac-memory",
    "session-harbor",
    { apply: true },
  );
  assert.equal(applied.entries.length, 1);
  await rm(path.join(item.destination, ".session-harbor-destination.json"));
  const status = await memoryStatus(item.windows.configPath, { projectId: "session-harbor" });
  assert.equal(status.projects[0].adoptionState, "staged");
  assert.equal(status.projects[0].entries[0].evidence[0].sessionId, MAC_SESSION);
});

test("peer memory is rejected if its session evidence object is tampered", async () => {
  const item = await fixture();
  await publishNormalMemory(item.mac);
  const session = await readSessionHead(item.mac.config);
  await writeFile(resolvePortablePath(item.destination, session.manifest.objects[0].objectPath), "tampered");
  await assert.rejects(
    () =>
      diffPeerMemory(
        item.windows.config,
        item.windows.configPath,
        "mac-memory",
        "session-harbor",
      ),
    (error) => error.code === "SESSION_SNAPSHOT_OBJECTS_INVALID",
  );
});

test("interrupted approval leaves the previous approved head readable", async () => {
  const item = await fixture();
  await publishNormalMemory(item.mac);
  const first = await readMemoryHead(item.mac.config, "mac-memory", "session-harbor");
  const input = await draftInput(item.mac.config, "normal", "decisions/second");
  const draft = await createMemoryDraft(
    item.mac.config,
    item.mac.configPath,
    "session-harbor",
    input,
    { apply: true, snapshotId: "019f5003-aaaa-7aaa-8aaa-aaaaaaaaaaaa" },
  );
  await assert.rejects(
    () =>
      approveMemoryDraft(
        item.mac.config,
        item.mac.configPath,
        "session-harbor",
        draft.draftId,
        {
          apply: true,
          snapshotId: "019f5003-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
          beforeHeadPublish: async () => {
            throw new Error("synthetic disconnect");
          },
        },
      ),
    /synthetic disconnect/,
  );
  const after = await readMemoryHead(item.mac.config, "mac-memory", "session-harbor");
  assert.equal(after.manifest.snapshotId, first.manifest.snapshotId);
});

async function publishNormalMemory(device) {
  const input = await draftInput(device.config, "normal");
  const draft = await createMemoryDraft(
    device.config,
    device.configPath,
    "session-harbor",
    input,
    { apply: true, now: "2026-08-22T01:00:00Z", snapshotId: "019f5002-aaaa-7aaa-8aaa-aaaaaaaaaaaa" },
  );
  return approveMemoryDraft(
    device.config,
    device.configPath,
    "session-harbor",
    draft.draftId,
    {
      apply: true,
      now: "2026-08-22T02:00:00Z",
      snapshotId: "019f5002-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
      runId: "019f5002-cccc-7ccc-8ccc-cccccccccccc",
    },
  );
}

async function draftInput(config, sensitivity, key = "decisions/storage-safety") {
  const session = await readSessionHead(config);
  const object = session.manifest.objects[0];
  return {
    entries: [
      {
        key,
        text: "Keep raw session evidence verified before local reclamation.",
        observedAt: "2026-08-22T00:30:00Z",
        sensitivity,
        evidence: [
          { sessionId: object.sessionId, sha256: object.sha256, locator: "response_item:1" },
        ],
      },
    ],
  };
}

async function createDevice(base, destination, options) {
  const codexHome = path.join(base, options.id, ".codex");
  const configPath = path.join(base, options.id, "config", "config.json");
  const day = path.join(codexHome, "sessions", "2026", "08", "20");
  await mkdir(day, { recursive: true });
  const source = path.join(day, `rollout-2026-08-20T00-00-00-${options.sessionId}.jsonl`);
  await writeFile(
    source,
    `${JSON.stringify({ type: "session_meta", payload: { id: options.sessionId } })}\n`,
  );
  await utimes(source, new Date("2026-08-20T00:00:00Z"), new Date("2026-08-20T00:00:00Z"));
  const input = normalizeConfig({
    codexHome,
    destination,
    destinationId: options.destinationId,
    roots: ["sessions", "archived_sessions"],
    minimumSizeMB: 0,
    strictOpenFileCheck: false,
    device: { id: options.id, displayName: options.id, platform: options.platform },
    projects: { "session-harbor": path.join(base, options.id, "project") },
  });
  const initialized = await initializeStorage(configPath, input, { apply: true });
  await initializeDevice(configPath, initialized.config, {
    apply: true,
    now: "2026-08-21T00:00:00Z",
    runRecordId: options.runId,
  });
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  return { config, configPath, source };
}
