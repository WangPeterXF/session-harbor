import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  initializeStorage,
  loadCatalog,
  normalizeConfig,
  pathExists,
  reclaimSessions,
  restoreSession,
  verifyArchive,
} from "../plugins/session-harbor/scripts/lib/archive-core.mjs";
import { runBackup } from "../plugins/session-harbor/scripts/lib/backup-runner.mjs";
import { initializeDevice } from "../plugins/session-harbor/scripts/lib/device-registry.mjs";
import { buildManagementDashboard } from "../plugins/session-harbor/scripts/lib/management-dashboard.mjs";
import {
  inventoryCatalogSessions,
  readSessionHead,
} from "../plugins/session-harbor/scripts/lib/session-snapshot.mjs";

const OLD_ID = "019f8000-1111-7111-8111-111111111111";
const RECENT_ID = "019f8000-2222-7222-8222-222222222222";

test("config v3 migrates to v4 full-backup and independent cleanup semantics", () => {
  const config = normalizeConfig({
    version: 3,
    minimumSizeMB: 99,
    retention: {
      archiveAfterDays: 45,
      localGraceDays: 3,
      reclaimAction: "delete",
      autoReclaim: false,
    },
  });
  assert.equal(config.version, 4);
  assert.deepEqual(config.backup, {
    scope: "all",
    allowPartial: true,
    verifyExistingObjects: false,
  });
  assert.equal(config.retention.cleanupAfterInactiveDays, 45);
  assert.equal(config.retention.minimumBackupAgeDays, 3);
  assert.equal(config.retention.reclaimAction, "delete");
});

test("all-session backup is incremental; verified cleanup is age-based and restorable", async () => {
  const item = await fixture();
  const plan = await runBackup(item.config, {
    now: "2026-08-26T00:00:00Z",
    nowMs: Date.parse("2026-08-26T00:00:00Z"),
    skipOpenCheck: true,
  });
  assert.equal(plan.backup.candidates, 2, "backup ignores cleanup age and minimum size");
  assert.equal(plan.sync.counts.discovered, 2);
  assert.equal(await pathExists(path.join(item.destination, "catalog-v1.json")), false);
  assert.equal(await readSessionHead(item.config), null);

  const first = await runBackup(item.config, {
    apply: true,
    now: "2026-08-26T00:01:00Z",
    nowMs: Date.parse("2026-08-26T00:01:00Z"),
    skipOpenCheck: true,
  });
  assert.equal(first.complete, true);
  assert.equal(first.backup.copied, 2);
  assert.equal((await loadCatalog(item.config)).entries.length, 2);
  const firstHead = await readSessionHead(item.config, item.config.device.id, {
    verifyObjects: true,
  });
  assert.equal(firstHead.manifest.objects.length, 2);

  const unchanged = await runBackup(item.config, {
    apply: true,
    now: "2026-08-26T00:01:30Z",
    nowMs: Date.parse("2026-08-26T00:01:30Z"),
    skipOpenCheck: true,
  });
  assert.equal(unchanged.backup.copied, 0);
  assert.equal(unchanged.backup.skipped, 2);
  assert.equal(unchanged.sync.unchanged, true);

  const continued = sessionContent(RECENT_ID, "recent continued");
  await writeFile(item.recentSource, continued);
  await utimes(
    item.recentSource,
    new Date("2026-08-26T00:02:00Z"),
    new Date("2026-08-26T00:02:00Z"),
  );
  const second = await runBackup(item.config, {
    apply: true,
    now: "2026-08-26T00:03:00Z",
    nowMs: Date.parse("2026-08-26T00:03:00Z"),
    skipOpenCheck: true,
  });
  assert.equal(second.backup.copied, 1, "only the changed session gets a new immutable revision");
  const catalog = await loadCatalog(item.config);
  const recentEntry = catalog.entries.find((entry) => entry.sessionId === RECENT_ID);
  assert.equal(recentEntry.revisions.length, 1);
  const secondHead = await readSessionHead(item.config, item.config.device.id, {
    verifyObjects: true,
  });
  assert.notEqual(secondHead.manifest.snapshotId, firstHead.manifest.snapshotId);

  const cleaned = await reclaimSessions(item.config, {
    apply: true,
    confirmDeleteLocal: true,
    now: "2026-08-26T00:04:00Z",
    nowMs: Date.parse("2026-08-26T00:04:00Z"),
    skipOpenCheck: true,
  });
  assert.equal(cleaned.candidates, 1, "only the inactive old session is eligible for cleanup");
  assert.equal(cleaned.reclaimed, 1);
  assert.equal(await pathExists(item.oldSource), false);
  assert.equal((await stat(item.recentSource)).isFile(), true);

  await restoreSession(item.config, OLD_ID, { apply: true, skipOpenCheck: true });
  assert.equal(await readFile(item.oldSource, "utf8"), item.oldContent);
});

test("a session that grows after its verified copy does not block snapshot publication", async () => {
  const item = await fixture();
  const result = await runBackup(item.config, {
    apply: true,
    now: "2026-08-26T00:01:00Z",
    nowMs: Date.parse("2026-08-26T00:01:00Z"),
    skipOpenCheck: true,
    afterBackup: async () => {
      await writeFile(item.recentSource, sessionContent(RECENT_ID, "grew after backup"));
    },
  });
  assert.equal(result.complete, true);
  assert.equal((await readSessionHead(item.config)).manifest.objects.length, 2);
  const catalog = await loadCatalog(item.config);
  const recent = catalog.entries.find((entry) => entry.sessionId === RECENT_ID);
  assert.notEqual(await readFile(item.recentSource, "utf8"), item.recentSourceContent);
  assert.equal(
    (await readSessionHead(item.config)).manifest.objects.find(
      (object) => object.sessionId === RECENT_ID,
    ).sha256,
    recent.sha256,
  );
});

test("applied backup refreshes stable NTFS metadata drift when bytes still match", async () => {
  const item = await fixture();
  await runBackup(item.config, {
    apply: true,
    now: "2026-08-26T00:01:00Z",
    nowMs: Date.parse("2026-08-26T00:01:00Z"),
    skipOpenCheck: true,
  });

  await utimes(
    item.recentSource,
    new Date("2026-08-26T00:02:00Z"),
    new Date("2026-08-26T00:02:00Z"),
  );
  const drifted = await stat(item.recentSource);
  const refreshed = await runBackup(item.config, {
    apply: true,
    now: "2026-08-26T00:03:00Z",
    nowMs: Date.parse("2026-08-26T00:03:00Z"),
    skipOpenCheck: true,
  });
  assert.equal(refreshed.backup.copied, 0, "matching bytes do not create a revision");

  const catalog = await loadCatalog(item.config);
  const recent = catalog.entries.find((entry) => entry.sessionId === RECENT_ID);
  assert.equal(recent.sourceMtimeMs, Math.trunc(drifted.mtimeMs));
  assert.equal(recent.sourceCtimeMs, Math.trunc(drifted.ctimeMs));
  const dashboard = await buildManagementDashboard(item.config, item.configPath, { limit: 0 });
  assert.equal(dashboard.counts.backedCurrentLocal, 2);
  assert.equal(dashboard.counts.backupPending, 0);
  assert.equal((await verifyArchive(item.config)).ok, true);
});

test("shared catalog operations ignore objects owned by peer devices", async () => {
  const item = await fixture();
  const backed = await runBackup(item.config, {
    apply: true,
    now: "2026-08-26T00:01:00Z",
    nowMs: Date.parse("2026-08-26T00:01:00Z"),
    skipOpenCheck: true,
  });
  assert.equal(backed.complete, true);
  const peerConfig = normalizeConfig({
    ...item.config,
    device: { id: "win-v4-test", displayName: "V4 Test Windows", platform: "windows" },
  });
  const peerInventory = await inventoryCatalogSessions(peerConfig, { verifyObjects: false });
  assert.deepEqual(peerInventory, { objects: [], errors: [] });
  assert.deepEqual(await verifyArchive(peerConfig), { ok: true, entries: [] });
  const dashboard = await buildManagementDashboard(peerConfig, item.configPath, { limit: 0 });
  assert.equal(dashboard.counts.localInventory, 2);
  assert.equal(dashboard.counts.catalogEntries, 0);
  assert.equal(dashboard.counts.backupPending, 2);
  assert.equal(dashboard.counts.restoreAvailable, 0);
});

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-v4-"));
  const codexHome = path.join(base, ".codex");
  const destination = path.join(base, "vault");
  const configPath = path.join(base, "config.json");
  const oldDay = path.join(codexHome, "sessions", "2026", "07", "01");
  const recentDay = path.join(codexHome, "sessions", "2026", "08", "26");
  await mkdir(oldDay, { recursive: true });
  await mkdir(recentDay, { recursive: true });
  const oldSource = path.join(oldDay, `rollout-old-${OLD_ID}.jsonl`);
  const recentSource = path.join(recentDay, `rollout-recent-${RECENT_ID}.jsonl`);
  const oldContent = sessionContent(OLD_ID, "old");
  await writeFile(oldSource, oldContent);
  await writeFile(recentSource, sessionContent(RECENT_ID, "recent"));
  const recentSourceContent = sessionContent(RECENT_ID, "recent");
  await utimes(oldSource, new Date("2026-07-01T00:00:00Z"), new Date("2026-07-01T00:00:00Z"));
  await utimes(
    recentSource,
    new Date("2026-08-26T00:00:00Z"),
    new Date("2026-08-26T00:00:00Z"),
  );
  const initialized = await initializeStorage(
    configPath,
    normalizeConfig({
      version: 4,
      codexHome,
      destination,
      roots: ["sessions", "archived_sessions"],
      minimumSizeMB: 99,
      strictOpenFileCheck: false,
      backup: { scope: "all", allowPartial: true },
      retention: {
        cleanupAfterInactiveDays: 30,
        minimumBackupAgeDays: 0,
        reclaimAction: "delete",
        autoReclaim: false,
      },
      device: { id: "mac-v4-test", displayName: "V4 Test Mac", platform: "macos" },
    }),
    { apply: true },
  );
  await initializeDevice(configPath, initialized.config, {
    apply: true,
    now: "2026-08-26T00:00:00Z",
    runRecordId: "019f8000-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  });
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  return {
    config,
    configPath,
    destination,
    oldSource,
    recentSource,
    oldContent,
    recentSourceContent,
  };
}

function sessionContent(sessionId, message) {
  return `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n${JSON.stringify({ type: "event_msg", payload: { message } })}\n`;
}
