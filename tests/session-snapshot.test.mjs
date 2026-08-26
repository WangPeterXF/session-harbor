import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  archiveSessions,
  initializeStorage,
  loadCatalog,
  normalizeConfig,
  pathExists,
} from "../plugins/session-harbor/scripts/lib/archive-core.mjs";
import { initializeDevice } from "../plugins/session-harbor/scripts/lib/device-registry.mjs";
import {
  inventoryLocalSessions,
  planSessionPush,
  pushSessionSnapshot,
  readSessionHead,
  sessionHeadPath,
  verifySnapshotObjects,
} from "../plugins/session-harbor/scripts/lib/session-snapshot.mjs";
import { resolvePortablePath } from "../plugins/session-harbor/scripts/lib/atomic-store.mjs";

const SESSION_A = "019f1000-1111-7111-8111-111111111111";
const SESSION_B = "019f1000-2222-7222-8222-222222222222";

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-m2-"));
  const codexHome = path.join(base, ".codex");
  const destination = path.join(base, "vault");
  const configPath = path.join(base, "config.json");
  const day = path.join(codexHome, "sessions", "2026", "08", "20");
  await mkdir(day, { recursive: true });
  const source = path.join(day, `rollout-2026-08-20T00-00-00-${SESSION_A}.jsonl`);
  const content = sessionContent(SESSION_A, "first");
  await writeFile(source, content);
  await utimes(source, new Date("2026-08-20T00:00:00Z"), new Date("2026-08-20T00:00:00Z"));
  const input = normalizeConfig({
    codexHome,
    destination,
    roots: ["sessions", "archived_sessions"],
    olderThanDays: 1,
    minimumSizeMB: 0,
    strictOpenFileCheck: false,
    device: { id: "mac-synthetic", displayName: "Synthetic Mac", platform: "macos" },
  });
  const initialized = await initializeStorage(configPath, input, { apply: true });
  await initializeDevice(configPath, initialized.config, {
    apply: true,
    now: "2026-08-21T00:00:00Z",
    runRecordId: "019f1000-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  });
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  return { base, codexHome, destination, configPath, config, day, source, content };
}

test("sync plan is read-only and reports a content-addressed publication", async () => {
  const item = await fixture();
  const plan = await planSessionPush(item.config, { now: "2026-08-22T00:00:00Z" });
  assert.equal(plan.counts.discovered, 1);
  assert.equal(plan.counts.newObjects, 1);
  assert.equal(plan.counts.newSnapshot, 1);
  assert.equal(
    await pathExists(resolvePortablePath(item.destination, sessionHeadPath(item.config.device.id))),
    false,
  );
  assert.equal(await pathExists(path.join(item.destination, "devices", "mac-synthetic", "sessions")), false);
});

test("sync push publishes object, manifest, head, and run record then reruns idempotently", async () => {
  const item = await fixture();
  const first = await pushSessionSnapshot(item.config, {
    apply: true,
    now: "2026-08-22T00:00:00Z",
    runId: "019f1000-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
  });
  assert.equal(first.counts.objectsPublished, 1);
  assert.equal(first.counts.snapshotsPublished, 1);
  const current = await readSessionHead(item.config, item.config.device.id, { verifyObjects: true });
  assert.equal(current.manifest.objects.length, 1);
  assert.equal(await readFile(resolvePortablePath(item.destination, current.manifest.objects[0].objectPath), "utf8"), item.content);

  const second = await pushSessionSnapshot(item.config, {
    apply: true,
    now: "2026-08-22T01:00:00Z",
    runId: "019f1000-cccc-7ccc-8ccc-cccccccccccc",
  });
  assert.equal(second.unchanged, true);
  assert.equal(second.counts.objectsPublished, 0);
  assert.equal(second.counts.snapshotsPublished, 0);
  assert.equal((await readSessionHead(item.config)).manifest.snapshotId, current.manifest.snapshotId);
});

test("age-based archive and session snapshot reuse the same device-owned content object", async () => {
  const item = await fixture();
  const archived = await archiveSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-08-22T00:00:00Z"),
    now: "2026-08-22T00:00:00Z",
  });
  assert.equal(archived.copied, 1);
  const catalog = await loadCatalog(item.config);
  assert.match(
    catalog.entries[0].targetRelativePath,
    /^devices\/mac-synthetic\/sessions\/objects\/sha256\//,
  );
  const pushed = await pushSessionSnapshot(item.config, {
    apply: true,
    now: "2026-08-22T00:01:00Z",
    runId: "019f1000-bbba-7bbb-8bbb-bbbbbbbbbbbb",
  });
  assert.equal(pushed.counts.objectsPublished, 0);
  assert.equal(pushed.counts.objectsReused, 1);
});

test("same bytes deduplicate while distinct source keys remain in the manifest", async () => {
  const item = await fixture();
  const secondPath = path.join(item.day, `rollout-2026-08-20T00-01-00-${SESSION_B}.jsonl`);
  await writeFile(secondPath, item.content);
  await utimes(secondPath, new Date("2026-08-20T00:01:00Z"), new Date("2026-08-20T00:01:00Z"));
  const result = await pushSessionSnapshot(item.config, {
    apply: true,
    now: "2026-08-22T00:00:00Z",
    runId: "019f1000-dddd-7ddd-8ddd-dddddddddddd",
  });
  assert.equal(result.counts.objectsDiscovered, 2);
  assert.equal(result.counts.objectsPublished, 1);
  const current = await readSessionHead(item.config, item.config.device.id, { verifyObjects: true });
  assert.equal(current.manifest.objects.length, 2);
  assert.equal(new Set(current.manifest.objects.map((entry) => entry.objectPath)).size, 1);
});

test("changed session bytes create a child snapshot and retain both immutable objects", async () => {
  const item = await fixture();
  await pushSessionSnapshot(item.config, {
    apply: true,
    now: "2026-08-22T00:00:00Z",
    runId: "019f1001-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  });
  const first = await readSessionHead(item.config);
  await writeFile(item.source, sessionContent(SESSION_A, "continued"));
  await utimes(item.source, new Date("2026-08-23T00:00:00Z"), new Date("2026-08-23T00:00:00Z"));
  await pushSessionSnapshot(item.config, {
    apply: true,
    now: "2026-08-24T00:00:00Z",
    runId: "019f1001-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
  });
  const second = await readSessionHead(item.config, item.config.device.id, { verifyObjects: true });
  assert.equal(second.manifest.parentSnapshotId, first.manifest.snapshotId);
  assert.notEqual(second.manifest.objects[0].sha256, first.manifest.objects[0].sha256);
  assert.equal(await pathExists(resolvePortablePath(item.destination, first.manifest.objects[0].objectPath)), true);
});

test("source modification during copy fails closed without a published object or head", async () => {
  const item = await fixture();
  await assert.rejects(
    () =>
      pushSessionSnapshot(item.config, {
        apply: true,
        now: "2026-08-22T00:00:00Z",
        afterObjectCopy: async () => writeFile(item.source, `${item.content}changed\n`),
      }),
    (error) => error.code === "SOURCE_CHANGED_DURING_COPY",
  );
  const sessionTree = path.join(item.destination, "devices", item.config.device.id, "sessions");
  if (await pathExists(sessionTree)) {
    const names = await recursiveFiles(sessionTree);
    assert.equal(names.some((name) => name.endsWith(".jsonl")), false);
  }
  assert.equal(await pathExists(resolvePortablePath(item.destination, sessionHeadPath(item.config.device.id))), false);
});

test("interruption before head publication leaves the previous head valid", async () => {
  const item = await fixture();
  await pushSessionSnapshot(item.config, {
    apply: true,
    now: "2026-08-22T00:00:00Z",
    runId: "019f1002-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  });
  const first = await readSessionHead(item.config);
  await writeFile(item.source, sessionContent(SESSION_A, "new revision"));
  await utimes(item.source, new Date("2026-08-23T00:00:00Z"), new Date("2026-08-23T00:00:00Z"));
  await assert.rejects(
    () =>
      pushSessionSnapshot(item.config, {
        apply: true,
        now: "2026-08-24T00:00:00Z",
        runId: "019f1002-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
        beforeHeadPublish: async () => {
          throw new Error("synthetic disconnect");
        },
      }),
    /synthetic disconnect/,
  );
  const after = await readSessionHead(item.config, item.config.device.id, { verifyObjects: true });
  assert.equal(after.manifest.snapshotId, first.manifest.snapshotId);
});

test("a concurrently created head is never overwritten", async () => {
  const item = await fixture();
  const headPath = resolvePortablePath(item.destination, sessionHeadPath(item.config.device.id));
  await assert.rejects(
    () =>
      pushSessionSnapshot(item.config, {
        apply: true,
        now: "2026-08-22T00:00:00Z",
        runId: "019f1002-cccc-7ccc-8ccc-cccccccccccc",
        beforeHeadPublish: async () => {
          await mkdir(path.dirname(headPath), { recursive: true });
          await writeFile(headPath, "concurrent-writer\n");
        },
      }),
    (error) => error.code === "SESSION_HEAD_CONCURRENT_UPDATE",
  );
  assert.equal(await readFile(headPath, "utf8"), "concurrent-writer\n");
});

test("corrupt existing content object is never silently reused", async () => {
  const item = await fixture();
  const inventory = await inventoryLocalSessions(item.config);
  const target = resolvePortablePath(item.destination, inventory.objects[0].objectPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "corrupt");
  await assert.rejects(
    () => planSessionPush(item.config, { now: "2026-08-22T00:00:00Z" }),
    (error) => error.code === "SESSION_OBJECT_HASH_MISMATCH",
  );
  assert.equal(await readFile(target, "utf8"), "corrupt");
});

test("native session ID can be extracted from bounded JSONL metadata", async () => {
  const item = await fixture();
  const pathWithoutId = path.join(item.day, "rollout-synthetic-without-id.jsonl");
  await writeFile(pathWithoutId, sessionContent(SESSION_B, "metadata fallback"));
  await utimes(pathWithoutId, new Date("2026-08-20T00:02:00Z"), new Date("2026-08-20T00:02:00Z"));
  const inventory = await inventoryLocalSessions(item.config);
  const found = inventory.objects.find((entry) => entry.sourceKey.endsWith("rollout-synthetic-without-id.jsonl"));
  assert.equal(found.sessionId, SESSION_B);
});

test("snapshot object verification detects tampering", async () => {
  const item = await fixture();
  await pushSessionSnapshot(item.config, {
    apply: true,
    now: "2026-08-22T00:00:00Z",
    runId: "019f1003-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  });
  const current = await readSessionHead(item.config);
  await writeFile(resolvePortablePath(item.destination, current.manifest.objects[0].objectPath), "tampered");
  await assert.rejects(
    () => verifySnapshotObjects(item.config, current.manifest),
    (error) => error.code === "SESSION_SNAPSHOT_OBJECTS_INVALID",
  );
});

function sessionContent(sessionId, message) {
  return `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: "/synthetic/project" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message } })}\n`;
}

async function recursiveFiles(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...(await recursiveFiles(child)));
    else output.push(child);
  }
  return output;
}
