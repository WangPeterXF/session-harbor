import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  archiveSessions,
  initializeStorage,
  normalizeConfig,
  pathExists,
  reclaimSessions,
  restoreSession,
} from "../plugins/session-harbor/scripts/lib/archive-core.mjs";
import { buildManagementDashboard } from "../plugins/session-harbor/scripts/lib/management-dashboard.mjs";
import {
  createOperationTracker,
  readOperationState,
} from "../plugins/session-harbor/scripts/lib/operation-state.mjs";
import { updateSettings } from "../plugins/session-harbor/scripts/lib/settings.mjs";

const SESSION_A = "019f4000-1111-7111-8111-111111111111";
const SESSION_B = "019f4000-2222-7222-8222-222222222222";
const SESSION_C = "019f4000-3333-7333-8333-333333333333";

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-dashboard-"));
  const codexHome = path.join(base, ".codex");
  const destination = path.join(base, "vault");
  const configPath = path.join(base, "config", "config.json");
  const day = path.join(codexHome, "sessions", "2026", "06", "01");
  await mkdir(day, { recursive: true });
  const files = new Map();
  for (const [sessionId, suffix] of [
    [SESSION_A, "a"],
    [SESSION_B, "b"],
    [SESSION_C, "c"],
  ]) {
    const filePath = path.join(day, `rollout-2026-06-01T00-00-0${suffix}-${sessionId}.jsonl`);
    const content = `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`;
    await writeFile(filePath, content);
    await utimes(filePath, new Date("2026-06-01T00:00:00Z"), new Date("2026-06-01T00:00:00Z"));
    files.set(sessionId, { filePath, content });
  }
  const input = normalizeConfig({
    codexHome,
    destination,
    roots: ["sessions"],
    minimumSizeMB: 0,
    strictOpenFileCheck: false,
    retention: {
      cleanupAfterInactiveDays: 30,
      minimumBackupAgeDays: 7,
      reclaimAction: "delete",
      autoReclaim: false,
    },
  });
  const initialized = await initializeStorage(configPath, input, { apply: true });
  return { base, configPath, config: initialized.config, files };
}

test("dashboard separates current backups, waiting grace, unbacked, deleted, and restored sessions", async () => {
  const item = await fixture();
  await archiveSessions(item.config, {
    selection: "all",
    selector: SESSION_A,
    apply: true,
    skipOpenCheck: true,
    now: "2026-08-01T00:00:00Z",
    nowMs: Date.parse("2026-08-01T00:00:00Z"),
  });
  await archiveSessions(item.config, {
    selection: "all",
    selector: SESSION_B,
    apply: true,
    skipOpenCheck: true,
    now: "2026-08-08T00:00:00Z",
    nowMs: Date.parse("2026-08-08T00:00:00Z"),
  });

  let dashboard = await buildManagementDashboard(item.config, item.configPath, {
    nowMs: Date.parse("2026-08-10T00:00:00Z"),
    limit: "all",
  });
  assert.equal(dashboard.counts.localInventory, 3);
  assert.equal(dashboard.counts.catalogEntries, 2);
  assert.equal(dashboard.counts.backedCurrentLocal, 2);
  assert.equal(dashboard.counts.backupPending, 1);
  assert.equal(dashboard.counts.cleanupReady, 1);
  assert.equal(dashboard.counts.waitingBackupAge, 1);
  assert.equal(
    dashboard.sessions.find((entry) => entry.sessionId === SESSION_C).backupStatus,
    "unbacked",
  );

  const reclaimed = await reclaimSessions(item.config, {
    selector: SESSION_A,
    apply: true,
    confirmDeleteLocal: true,
    skipOpenCheck: true,
    now: "2026-08-10T00:01:00Z",
    nowMs: Date.parse("2026-08-10T00:01:00Z"),
  });
  assert.equal(reclaimed.candidates, 1);
  assert.equal(reclaimed.reclaimed, 1);
  assert.equal(await pathExists(item.files.get(SESSION_A).filePath), false);
  assert.equal(await pathExists(item.files.get(SESSION_B).filePath), true);

  dashboard = await buildManagementDashboard(item.config, item.configPath, {
    nowMs: Date.parse("2026-08-10T00:02:00Z"),
    filter: "deleted",
    limit: "all",
  });
  assert.equal(dashboard.counts.vaultOnly, 1);
  assert.equal(dashboard.matchCount, 1);
  assert.equal(dashboard.sessions[0].sessionId, SESSION_A);

  await restoreSession(item.config, SESSION_A, { apply: true, skipOpenCheck: true });
  assert.equal(
    await readFile(item.files.get(SESSION_A).filePath, "utf8"),
    item.files.get(SESSION_A).content,
  );
  dashboard = await buildManagementDashboard(item.config, item.configPath, {
    nowMs: Date.now(),
    limit: "all",
  });
  const restoredSession = dashboard.sessions.find((entry) => entry.sessionId === SESSION_A);
  assert.equal(restoredSession.catalogState, "restored");
  assert.equal(restoredSession.backupStatus, "current");
  assert.equal(restoredSession.localStatus, "present");
});

test("operation tracker exposes running progress and a completed last operation", async () => {
  const item = await fixture();
  const tracker = createOperationTracker(item.configPath, "backup", {
    startedAt: "2026-08-10T00:00:00Z",
    runId: "run-dashboard-test",
  });
  await tracker.start({ stage: "inventory" });
  await tracker.progress({ stage: "backup", processed: 2, total: 5 });
  let state = await readOperationState(item.configPath, {
    nowMs: Date.parse("2026-08-10T00:01:00Z"),
  });
  assert.equal(state.current.runId, "run-dashboard-test");
  assert.equal(state.current.processed, 2);
  assert.equal(state.currentStale, false);

  await tracker.finish("succeeded", { stage: "completed", processed: 5, total: 5 });
  state = await readOperationState(item.configPath);
  assert.equal(state.current, null);
  assert.equal(state.last.status, "succeeded");
  assert.equal(state.last.processed, 5);
});

test("settings updates are dry-run by default and persist only with apply", async () => {
  const item = await fixture();
  const planned = await updateSettings(
    item.configPath,
    item.config,
    {
      retention: {
        cleanupAfterInactiveDays: "45",
        minimumBackupAgeDays: "10",
        reclaimAction: "keep",
      },
    },
  );
  assert.equal(planned.apply, false);
  assert.equal(planned.after.retention.cleanupAfterInactiveDays, 45);
  assert.equal(planned.after.retention.minimumBackupAgeDays, 10);

  const applied = await updateSettings(
    item.configPath,
    item.config,
    { retention: { cleanupAfterInactiveDays: "45", minimumBackupAgeDays: "10" } },
    { apply: true },
  );
  assert.equal(applied.apply, true);
  const stored = JSON.parse(await readFile(item.configPath, "utf8"));
  assert.equal(stored.retention.cleanupAfterInactiveDays, 45);
  assert.equal(stored.retention.minimumBackupAgeDays, 10);
});
