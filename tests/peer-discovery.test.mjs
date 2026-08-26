import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  initializeStorage,
  normalizeConfig,
  pathExists,
} from "../plugins/session-harbor/scripts/lib/archive-core.mjs";
import { canonicalJson, resolvePortablePath } from "../plugins/session-harbor/scripts/lib/atomic-store.mjs";
import { initializeDevice } from "../plugins/session-harbor/scripts/lib/device-registry.mjs";
import {
  discoverPeers,
  exportPeerSession,
  loadPeerState,
  peerStatePath,
  peerStatus,
  pullPeers,
} from "../plugins/session-harbor/scripts/lib/peer-discovery.mjs";
import { pushSessionSnapshot, readSessionHead } from "../plugins/session-harbor/scripts/lib/session-snapshot.mjs";

const MAC_SESSION = "019f2000-1111-7111-8111-111111111111";
const WIN_SESSION = "019f2000-2222-7222-8222-222222222222";

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "session-harbor-m3-"));
  const destination = path.join(base, "vault");
  const mac = await createDevice(base, destination, {
    id: "mac-synthetic",
    displayName: "Synthetic Mac",
    platform: "macos",
    sessionId: MAC_SESSION,
    markerId: null,
    initRunId: "019f2000-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  });
  const windows = await createDevice(base, destination, {
    id: "windows-synthetic",
    displayName: "Synthetic Windows",
    platform: "windows",
    sessionId: WIN_SESSION,
    markerId: mac.config.destinationId,
    initRunId: "019f2000-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
  });
  await pushSessionSnapshot(mac.config, {
    apply: true,
    now: "2026-08-22T00:00:00Z",
    runId: "019f2000-cccc-7ccc-8ccc-cccccccccccc",
  });
  await pushSessionSnapshot(windows.config, {
    apply: true,
    now: "2026-08-22T00:01:00Z",
    runId: "019f2000-dddd-7ddd-8ddd-dddddddddddd",
  });
  return { base, destination, mac, windows };
}

test("Mac and Windows discover only the verified peer-owned tree", async () => {
  const item = await fixture();
  const macPeers = await discoverPeers(item.mac.config);
  assert.equal(macPeers.length, 1);
  assert.equal(macPeers[0].ok, true);
  assert.equal(macPeers[0].device.deviceId, "windows-synthetic");
  assert.equal(macPeers[0].counts.sessions, 1);
  assert.equal(macPeers[0].status, "unseen");

  const winPeers = await discoverPeers(item.windows.config);
  assert.deepEqual(winPeers.map((peer) => peer.device.deviceId), ["mac-synthetic"]);
});

test("sync pull is dry-run by default and applied metadata remains readable offline", async () => {
  const item = await fixture();
  const planned = await pullPeers(item.mac.config, item.mac.configPath);
  assert.equal(planned.apply, false);
  assert.equal(await pathExists(peerStatePath(item.mac.configPath)), false);

  const applied = await pullPeers(item.mac.config, item.mac.configPath, { apply: true });
  assert.equal(applied.counts.peers, 1);
  assert.equal(await pathExists(peerStatePath(item.mac.configPath)), true);
  const stored = await loadPeerState(item.mac.configPath);
  assert.equal(stored.peers["windows-synthetic"].sessionManifest.objects.length, 1);

  await rm(path.join(item.destination, ".session-harbor-destination.json"));
  const offline = await peerStatus(item.mac.config, item.mac.configPath);
  assert.equal(offline.connected, false);
  assert.equal(offline.stale, true);
  assert.equal(offline.peers[0].status, "cached-stale");
});

test("raw object cache supports verified peer export while the vault is disconnected", async () => {
  const item = await fixture();
  const pulled = await pullPeers(item.mac.config, item.mac.configPath, {
    apply: true,
    includeObjects: true,
  });
  assert.equal(pulled.counts.sessionObjectsCached, 1);
  await rm(path.join(item.destination, ".session-harbor-destination.json"));

  const output = path.join(item.base, "exports", "windows-session.jsonl");
  const planned = await exportPeerSession(
    item.mac.config,
    item.mac.configPath,
    "windows-synthetic",
    WIN_SESSION.slice(0, 12),
    output,
  );
  assert.equal(planned.apply, false);
  assert.equal(planned.from, "local-cache");
  assert.equal(await pathExists(output), false);

  const applied = await exportPeerSession(
    item.mac.config,
    item.mac.configPath,
    "windows-synthetic",
    WIN_SESSION,
    output,
    { apply: true },
  );
  assert.equal(applied.apply, true);
  assert.equal(await readFile(output, "utf8"), await readFile(item.windows.source, "utf8"));
});

test("new peer snapshots are peer-ahead and a rolled-back head is rejected visibly", async () => {
  const item = await fixture();
  await pullPeers(item.mac.config, item.mac.configPath, { apply: true });
  const old = await readSessionHead(item.windows.config);
  await writeFile(item.windows.source, sessionContent(WIN_SESSION, "continued on Windows"));
  await utimes(item.windows.source, new Date("2026-08-23T00:00:00Z"), new Date("2026-08-23T00:00:00Z"));
  await pushSessionSnapshot(item.windows.config, {
    apply: true,
    now: "2026-08-24T00:00:00Z",
    runId: "019f2001-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  });
  let status = await peerStatus(item.mac.config, item.mac.configPath);
  assert.equal(status.peers[0].status, "peer-ahead");

  await pullPeers(item.mac.config, item.mac.configPath, { apply: true });
  await writeFile(resolvePortablePath(item.destination, old.headPath), canonicalJson(old.head));
  status = await peerStatus(item.mac.config, item.mac.configPath);
  assert.equal(status.peers[0].status, "diverged");
  assert.equal(status.peers[0].rollbackWarning, true);
});

test("a peer head hash mismatch is reported invalid and never cached", async () => {
  const item = await fixture();
  const peerHead = await readSessionHead(item.windows.config);
  const tampered = { ...peerHead.head, manifestSha256: "f".repeat(64) };
  await writeFile(resolvePortablePath(item.destination, peerHead.headPath), canonicalJson(tampered));
  const status = await peerStatus(item.mac.config, item.mac.configPath);
  assert.equal(status.ok, false);
  assert.equal(status.peers[0].status, "invalid");
  assert.equal(status.peers[0].error.code, "SESSION_HEAD_HASH_MISMATCH");
  await assert.rejects(
    () => pullPeers(item.mac.config, item.mac.configPath, { apply: true }),
    (error) => error.code === "PEER_PULL_INVALID",
  );
  assert.equal(await pathExists(peerStatePath(item.mac.configPath)), false);
});

async function createDevice(base, destination, options) {
  const home = path.join(base, options.id, ".codex");
  const configPath = path.join(base, options.id, "config", "config.json");
  const day = path.join(home, "sessions", "2026", "08", "20");
  await mkdir(day, { recursive: true });
  const source = path.join(
    day,
    `rollout-2026-08-20T00-00-00-${options.sessionId}.jsonl`,
  );
  await writeFile(source, sessionContent(options.sessionId, `work from ${options.id}`));
  await utimes(source, new Date("2026-08-20T00:00:00Z"), new Date("2026-08-20T00:00:00Z"));
  const input = normalizeConfig({
    codexHome: home,
    destination,
    destinationId: options.markerId || "",
    roots: ["sessions", "archived_sessions"],
    olderThanDays: 1,
    minimumSizeMB: 0,
    strictOpenFileCheck: false,
    device: { id: options.id, displayName: options.displayName, platform: options.platform },
  });
  const initialized = await initializeStorage(configPath, input, { apply: true });
  await initializeDevice(configPath, initialized.config, {
    apply: true,
    now: "2026-08-21T00:00:00Z",
    runRecordId: options.initRunId,
  });
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  return { home, configPath, config, source };
}

function sessionContent(sessionId, message) {
  return `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: "C:/synthetic/project" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message } })}\n`;
}
