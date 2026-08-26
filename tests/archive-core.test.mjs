import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ColdStorageError,
  archiveSessions,
  copyVerified,
  hashFile,
  initializeStorage,
  loadCatalog,
  normalizeConfig,
  restoreSession,
  safeJoin,
  scanSessions,
  verifyArchive,
} from "../plugins/session-harbor/scripts/lib/archive-core.mjs";
import { renderLaunchAgent } from "../plugins/session-harbor/scripts/launchagent.mjs";

const SESSION_ID = "019d0000-1111-7222-8333-444455556666";

async function fixture(options = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-test-"));
  const codexHome = path.join(base, ".codex");
  const destination = path.join(base, "archive");
  const day = path.join(codexHome, "sessions", "2026", "01", "02");
  await mkdir(day, { recursive: true });
  await mkdir(destination, { recursive: true });
  const source = path.join(day, `rollout-2026-01-02T03-04-05-${SESSION_ID}.jsonl`);
  const content = `${JSON.stringify({
    timestamp: "2026-01-02T03:04:05Z",
    type: "session_meta",
    payload: { id: SESSION_ID, cwd: "/synthetic/project" },
  })}\n${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "synthetic" } })}\n`;
  await writeFile(source, options.content || content);
  const old = new Date("2026-01-02T03:04:05Z");
  await utimes(source, old, old);
  const initialConfig = normalizeConfig({
    codexHome,
    destination,
    roots: ["sessions"],
    olderThanDays: 1,
    minimumSizeMB: 0,
    graceDays: 0,
    strictOpenFileCheck: false,
    retention: {
      cleanupAfterInactiveDays: 1,
      minimumBackupAgeDays: 0,
      reclaimAction: "link",
      autoReclaim: false,
    },
  });
  const initialized = await initializeStorage(path.join(base, "config.json"), initialConfig, {
    apply: true,
  });
  const config = initialized.config;
  return { base, codexHome, destination, source, content, config };
}

test("init is a dry-run unless apply creates a matching destination identity", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-init-test-"));
  const codexHome = path.join(base, ".codex");
  const destination = path.join(base, "archive");
  const configPath = path.join(base, "config.json");
  await mkdir(codexHome, { recursive: true });
  const planned = await initializeStorage(configPath, { codexHome, destination }, { apply: false });
  assert.equal(planned.apply, false);
  await assert.rejects(() => stat(destination), { code: "ENOENT" });
  await assert.rejects(() => stat(configPath), { code: "ENOENT" });

  const applied = await initializeStorage(configPath, { codexHome, destination }, { apply: true });
  assert.match(applied.config.destinationId, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).destinationId, applied.config.destinationId);
});

test("archive refuses an available path with the wrong destination identity", async () => {
  const item = await fixture();
  const marker = path.join(item.destination, ".session-harbor-destination.json");
  const value = JSON.parse(await readFile(marker, "utf8"));
  value.destinationId = "00000000-0000-4000-8000-000000000000";
  await writeFile(marker, `${JSON.stringify(value)}\n`);
  await assert.rejects(
    () => archiveSessions(item.config, { apply: false }),
    (error) => error instanceof ColdStorageError && error.code === "DESTINATION_ID_MISMATCH",
  );
});

test("archive refuses a destination whose identity marker disappeared", async () => {
  const item = await fixture();
  await rm(path.join(item.destination, ".session-harbor-destination.json"));
  await assert.rejects(
    () => archiveSessions(item.config, { apply: false }),
    (error) => error instanceof ColdStorageError && error.code === "DESTINATION_MARKER_MISSING",
  );
});

test("scan classifies old regular rollouts as eligible", async () => {
  const item = await fixture();
  const sessions = await scanSessions(item.config, { nowMs: Date.parse("2026-02-01T00:00:00Z") });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].eligible, true);
  assert.equal(sessions[0].sessionId, SESSION_ID);
  assert.equal(sessions[0].sourceKey.includes(item.base), false, "portable source key must not expose local root");
});

test("archive copies, verifies, then links only on a later finalize pass", async () => {
  const item = await fixture();
  const first = await archiveSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-02-01T00:00:00Z"),
    now: "2026-02-01T00:00:00Z",
  });
  assert.equal(first.copied, 1);
  assert.equal((await stat(item.source)).isFile(), true);

  const second = await archiveSessions(item.config, {
    apply: true,
    finalize: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-02-01T00:00:00Z"),
    now: "2026-02-01T00:01:00Z",
  });
  if (second.linked === 0 && process.platform === "win32") {
    assert.equal(second.errors.length, 1);
    assert.equal(second.errors[0].code, "WINDOWS_SYMLINK_PRIVILEGE_REQUIRED");
    assert.equal((await stat(item.source)).isFile(), true);
    assert.equal(await readFile(item.source, "utf8"), item.content);
    const verification = await verifyArchive(item.config);
    assert.equal(verification.ok, true);
    assert.equal(verification.entries[0].sourceStatus, "local-copy");
    assert.equal(verification.entries[0].targetStatus, "verified");
    return;
  }
  assert.equal(second.linked, 1);
  const target = await readlink(item.source);
  assert.equal(target.startsWith(item.destination), true);
  assert.equal(await readFile(item.source, "utf8"), item.content);

  const verification = await verifyArchive(item.config);
  assert.equal(verification.ok, true);
  assert.equal(verification.entries[0].sourceStatus, "linked");
  assert.equal(verification.entries[0].targetStatus, "verified");
});

test("restore materializes a verified local copy and keeps the archive", async () => {
  const item = await fixture();
  await archiveSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-02-01T00:00:00Z"),
    now: "2026-02-01T00:00:00Z",
  });
  await archiveSessions(item.config, {
    apply: true,
    finalize: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-02-01T00:00:00Z"),
    now: "2026-02-01T00:01:00Z",
  });

  const restored = await restoreSession(item.config, SESSION_ID.slice(0, 12), {
    apply: true,
    skipOpenCheck: true,
  });
  assert.equal(restored.state, "restored");
  const restoredInfo = await stat(item.source, { bigint: true });
  assert.equal(restoredInfo.isFile(), true);
  assert.equal(await readFile(item.source, "utf8"), item.content);
  const restoredEntry = (await loadCatalog(item.config)).entries[0];
  assert.equal(restoredEntry.sourceMtimeMs, Number(restoredInfo.mtimeMs));
  assert.equal(restoredEntry.sourceCtimeMs, Number(restoredInfo.ctimeMs));
  const verification = await verifyArchive(item.config);
  assert.equal(verification.ok, true);
  assert.equal(verification.entries[0].sourceStatus, "local-copy");
});

test("a restored and changed session is copied as a new verified revision", async () => {
  const item = await fixture();
  await archiveSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-02-01T00:00:00Z"),
    now: "2026-02-01T00:00:00Z",
  });
  await archiveSessions(item.config, {
    apply: true,
    finalize: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-02-01T00:00:00Z"),
    now: "2026-02-01T00:01:00Z",
  });
  await restoreSession(item.config, SESSION_ID, { apply: true, skipOpenCheck: true });
  await writeFile(item.source, `${item.content}new continuation\n`);
  await utimes(item.source, new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));

  const result = await archiveSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-02-02T00:00:00Z"),
    now: "2026-02-02T00:00:00Z",
  });
  assert.equal(result.copied, 1);
  assert.equal(result.items[0].state, "copied-revision");
  const verification = await verifyArchive(item.config);
  assert.equal(verification.ok, true);
  assert.equal(verification.entries[0].revisionStatuses.length, 1);
});

test("copy verification fails closed when the source changes", async () => {
  const item = await fixture();
  const target = path.join(item.destination, "changed.jsonl");
  await assert.rejects(
    () =>
      copyVerified(item.source, target, {
        afterCopy: async () => {
          await writeFile(item.source, `${item.content}changed\n`);
        },
      }),
    (error) => error instanceof ColdStorageError && error.code === "SOURCE_CHANGED_DURING_COPY",
  );
  await assert.rejects(() => stat(target), { code: "ENOENT" });
});

test("a newly published target is removed if the source changes in the final race window", async () => {
  const item = await fixture();
  const target = path.join(item.destination, "published-then-changed.jsonl");
  await assert.rejects(
    () =>
      copyVerified(item.source, target, {
        afterPublish: async () => {
          await writeFile(item.source, `${item.content}late change\n`);
        },
      }),
    (error) => error instanceof ColdStorageError && error.code === "SOURCE_CHANGED_BEFORE_PUBLISH",
  );
  await assert.rejects(() => stat(target), { code: "ENOENT" });
});

test("existing target with different bytes is never overwritten", async () => {
  const item = await fixture();
  const target = path.join(item.destination, "conflict.jsonl");
  await writeFile(target, "different");
  await assert.rejects(
    () => copyVerified(item.source, target),
    (error) => error instanceof ColdStorageError && error.code === "TARGET_CONFLICT",
  );
  assert.equal(await readFile(target, "utf8"), "different");
});

test("archive rejects a destination path redirected through a symbolic link", async () => {
  const item = await fixture();
  const outside = path.join(item.base, "outside");
  await mkdir(outside);
  await symlink(
    outside,
    path.join(item.destination, "files"),
    process.platform === "win32" ? "junction" : undefined,
  );
  const result = await archiveSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-02-01T00:00:00Z"),
    now: "2026-02-01T00:00:00Z",
  });
  assert.equal(result.copied, 0);
  assert.equal(result.errors[0].code, "PATH_SYMLINK_UNSAFE");
  assert.deepEqual(await readFile(item.source, "utf8"), item.content);
});

test("verify reports a broken source link without mutating it", async () => {
  const item = await fixture();
  await archiveSessions(item.config, {
    apply: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-02-01T00:00:00Z"),
    now: "2026-02-01T00:00:00Z",
  });
  const linked = await archiveSessions(item.config, {
    apply: true,
    finalize: true,
    skipOpenCheck: true,
    nowMs: Date.parse("2026-02-01T00:00:00Z"),
    now: "2026-02-01T00:01:00Z",
  });
  if (linked.linked === 0 && process.platform === "win32") {
    assert.equal(linked.errors.length, 1);
    assert.equal(linked.errors[0].code, "WINDOWS_SYMLINK_PRIVILEGE_REQUIRED");
    assert.equal((await stat(item.source)).isFile(), true);
    assert.equal((await verifyArchive(item.config)).ok, true);
    return;
  }
  const target = await readlink(item.source);
  await writeFile(target, "tampered");
  const verification = await verifyArchive(item.config);
  assert.equal(verification.ok, false);
  assert.equal(verification.entries[0].targetStatus, "hash-mismatch");
});

test("safeJoin rejects path traversal", () => {
  assert.throws(
    () => safeJoin("/tmp/archive", "../escape"),
    (error) => error instanceof ColdStorageError && error.code === "PATH_ESCAPE",
  );
});

test("LaunchAgent contains fixed executable paths and explicit apply", () => {
  const plist = renderLaunchAgent({
    nodePath: "/usr/local/bin/node",
    cliPath: "/opt/session-harbor.mjs",
    configPath: "/Users/example/config.json",
    hour: 4,
    minute: 15,
  });
  assert.match(plist, /io\.github\.xiaofanwang\.session-harbor\.archive/);
  assert.match(plist, /<string>--apply<\/string>/);
  assert.match(plist, /<integer>4<\/integer>/);
  assert.match(plist, /<integer>15<\/integer>/);
});

test("hashFile is stable for synthetic content", async () => {
  const item = await fixture();
  assert.equal(await hashFile(item.source), await hashFile(item.source));
});
