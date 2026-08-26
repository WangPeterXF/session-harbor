import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  archiveSessions,
  initializeStorage,
  loadCatalog,
  normalizeConfig,
  pathExists,
  reclaimSessions,
  restoreSession,
  verifyArchive,
} from "../plugins/session-harbor/scripts/lib/archive-core.mjs";

const SESSION_ID = "019f3000-1111-7111-8111-111111111111";

async function fixture(retention = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-retention-"));
  const codexHome = path.join(base, ".codex");
  const destination = path.join(base, "vault");
  const configPath = path.join(base, "config.json");
  const day = path.join(codexHome, "sessions", "2026", "08", "01");
  await mkdir(day, { recursive: true });
  const source = path.join(day, `rollout-2026-08-01T00-00-00-${SESSION_ID}.jsonl`);
  const content = `${JSON.stringify({ type: "session_meta", payload: { id: SESSION_ID } })}\n`;
  await writeFile(source, content);
  await utimes(source, new Date("2026-08-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z"));
  const input = normalizeConfig({
    codexHome,
    destination,
    roots: ["sessions"],
    minimumSizeMB: 0,
    strictOpenFileCheck: false,
    retention: {
      archiveAfterDays: 10,
      localGraceDays: 5,
      reclaimAction: "link",
      autoReclaim: false,
      ...retention,
    },
  });
  const initialized = await initializeStorage(configPath, input, { apply: true });
  return { base, codexHome, destination, configPath, config: initialized.config, source, content };
}

test("config v3 exposes archive age and local grace as separate retention settings", () => {
  const config = normalizeConfig({
    version: 3,
    retention: {
      archiveAfterDays: 45,
      localGraceDays: 14,
      reclaimAction: "delete",
      autoReclaim: true,
    },
  });
  assert.equal(config.olderThanDays, 45);
  assert.equal(config.graceDays, 14);
  assert.equal(config.mode, "delete");
  assert.equal(config.retention.autoReclaim, true);
});

test("archive never reclaims automatically; reclaim is a separate grace-respecting command", async () => {
  const item = await fixture();
  const copied = await archiveSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-08-20T00:00:00Z"),
    now: "2026-08-20T00:00:00Z",
  });
  assert.equal(copied.copied, 1);

  const archiveAgain = await archiveSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-08-30T00:00:00Z"),
    now: "2026-08-30T00:00:00Z",
  });
  assert.equal(archiveAgain.readyForReclaim, 1);
  assert.equal((await stat(item.source)).isFile(), true);

  const planned = await reclaimSessions(item.config, {
    skipOpenCheck: true,
    nowMs: Date.parse("2026-08-30T00:00:00Z"),
    now: "2026-08-30T00:00:00Z",
  });
  assert.equal(planned.linked, 1);
  assert.equal((await stat(item.source)).isFile(), true);

  const applied = await reclaimSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-08-30T00:00:00Z"),
    now: "2026-08-30T00:00:00Z",
  });
  if (applied.linked === 0 && process.platform === "win32") {
    assert.equal(applied.errors.length, 1);
    assert.equal(applied.errors[0].code, "WINDOWS_SYMLINK_PRIVILEGE_REQUIRED");
    assert.equal((await stat(item.source)).isFile(), true);
    assert.equal((await verifyArchive(item.config)).ok, true);
    return;
  }
  assert.equal(applied.linked, 1);
  assert.equal((await stat(item.source)).isFile(), true, "stat follows the verified symlink target");
  assert.equal((await verifyArchive(item.config)).ok, true);
});

test("reclaim before the local grace period remains deferred even with apply", async () => {
  const item = await fixture();
  await archiveSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-08-20T00:00:00Z"),
    now: "2026-08-20T00:00:00Z",
  });
  const result = await reclaimSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-08-22T00:00:00Z"),
    now: "2026-08-22T00:00:00Z",
  });
  assert.equal(result.deferredForGrace, 1);
  assert.equal((await stat(item.source)).isFile(), true);
});

test("delete reclamation requires an extra confirmation and remains restorable", async () => {
  const item = await fixture({ localGraceDays: 0, reclaimAction: "delete" });
  await archiveSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-08-20T00:00:00Z"),
    now: "2026-08-20T00:00:00Z",
  });
  const refused = await reclaimSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-08-20T00:01:00Z"),
    now: "2026-08-20T00:01:00Z",
  });
  assert.equal(refused.reclaimed, 0);
  assert.equal(refused.errors[0].code, "LOCAL_DELETE_CONFIRMATION_REQUIRED");
  assert.equal(await pathExists(item.source), true);

  const applied = await reclaimSessions(item.config, {
    apply: true,
    confirmDeleteLocal: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-08-20T00:02:00Z"),
    now: "2026-08-20T00:02:00Z",
  });
  assert.equal(applied.reclaimed, 1);
  assert.equal(await pathExists(item.source), false);
  assert.equal((await verifyArchive(item.config)).ok, true);

  const restored = await restoreSession(item.config, SESSION_ID, {
    apply: true,
    skipOpenCheck: true,
  });
  assert.equal(restored.state, "restored");
  assert.equal(await readFile(item.source, "utf8"), item.content);
});

test("keep policy never schedules local reclamation", async () => {
  const item = await fixture({ localGraceDays: 0, reclaimAction: "keep", autoReclaim: true });
  await archiveSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-08-20T00:00:00Z"),
    now: "2026-08-20T00:00:00Z",
  });
  const result = await reclaimSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-09-20T00:00:00Z"),
    now: "2026-09-20T00:00:00Z",
  });
  assert.equal(result.reclaimed, 0);
  assert.equal(result.linked, 0);
  assert.equal(result.items[0].state, "verified-copy-only");
  assert.equal(await pathExists(item.source), true);
});

test("a changed local source or changed archive target blocks reclamation", async () => {
  const item = await fixture({ localGraceDays: 0, reclaimAction: "delete" });
  await archiveSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-08-20T00:00:00Z"),
    now: "2026-08-20T00:00:00Z",
  });
  await writeFile(item.source, `${item.content}continued\n`);
  await utimes(item.source, new Date("2026-08-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z"));
  let result = await reclaimSessions(item.config, {
    apply: true,
    confirmDeleteLocal: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-08-20T00:02:00Z"),
    now: "2026-08-20T00:02:00Z",
  });
  assert.equal(result.errors[0].code, "SOURCE_CHANGED_AFTER_COPY");
  assert.equal(await pathExists(item.source), true);

  await writeFile(item.source, item.content);
  await utimes(item.source, new Date("2026-08-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z"));
  const catalog = await loadCatalog(item.config);
  await writeFile(path.join(item.destination, ...catalog.entries[0].targetRelativePath.split("/")), "tampered");
  result = await reclaimSessions(item.config, {
    apply: true,
    confirmDeleteLocal: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-08-20T00:03:00Z"),
    now: "2026-08-20T00:03:00Z",
  });
  assert.equal(result.errors[0].code, "TARGET_HASH_MISMATCH");
  assert.equal(await pathExists(item.source), true);
});
