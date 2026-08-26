import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  ColdStorageError,
  assertDestinationIdentity,
  copyVerified,
  hashFile,
  pathExists,
  safeJoin,
} from "./archive-core.mjs";
import {
  publishMutableJson,
  readRegularJson,
  resolvePortablePath,
} from "./atomic-store.mjs";
import { validateContract } from "./bridge-contracts.mjs";
import { readSessionHead, verifySnapshotObjects } from "./session-snapshot.mjs";

const PEER_STATE_VERSION = 1;
const PEER_STATE_FILENAME = "peer-state-v1.json";

export function peerStatePath(configPath) {
  return path.join(path.dirname(configPath), PEER_STATE_FILENAME);
}

export async function loadPeerState(configPath) {
  const file = peerStatePath(configPath);
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value?.version !== PEER_STATE_VERSION || !isObject(value.peers)) {
      throw new ColdStorageError("PEER_STATE_INVALID", `Invalid peer state: ${file}`);
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { version: PEER_STATE_VERSION, updatedAt: null, peers: {} };
    }
    if (error instanceof SyntaxError) {
      throw new ColdStorageError("PEER_STATE_JSON_INVALID", `Invalid peer state JSON: ${file}`);
    }
    throw error;
  }
}

export async function discoverPeers(config, options = {}) {
  await assertDestinationIdentity(config);
  if (!config.device?.id) {
    throw new ColdStorageError("DEVICE_NOT_INITIALIZED", "Initialize this device before discovering peers.");
  }
  const previousState = options.previousState || { peers: {} };
  const devicesRoot = safeJoin(config.destination, "devices");
  if (!(await pathExists(devicesRoot))) return [];
  const entries = await readdir(devicesRoot, { withFileTypes: true });
  const peers = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === config.device.id) continue;
    const peerId = entry.name;
    try {
      const manifestPath = `devices/${peerId}/device.json`;
      const device = validateContract(await readRegularJson(config.destination, manifestPath), {
        expectedKind: "device-manifest",
      });
      if (device.deviceId !== peerId) {
        throw new ColdStorageError(
          "PEER_DEVICE_IDENTITY_MISMATCH",
          `Peer directory and device manifest disagree: ${peerId}`,
        );
      }
      const session = await readSessionHead(config, peerId, {
        verifyObjects: options.verifyObjects !== false,
      });
      const previous = previousState.peers?.[peerId] || null;
      const comparison = await comparePeerSnapshot(config, peerId, session, previous);
      peers.push({
        ok: true,
        device,
        sessionHead: session?.head || null,
        sessionManifest: session?.manifest || null,
        status: comparison.status,
        rollbackWarning: comparison.rollbackWarning,
        counts: {
          sessions: session?.manifest.objects.length || 0,
          newOrChangedSincePull: comparison.newOrChanged,
        },
      });
    } catch (error) {
      peers.push({
        ok: false,
        device: { deviceId: peerId, displayName: peerId, platform: "unknown" },
        sessionHead: null,
        sessionManifest: null,
        status: "invalid",
        rollbackWarning: false,
        counts: { sessions: 0, newOrChangedSincePull: 0 },
        error: { code: error?.code || "PEER_DISCOVERY_FAILED", message: error.message },
      });
    }
  }
  return peers;
}

export async function peerStatus(config, configPath, options = {}) {
  const state = await loadPeerState(configPath);
  try {
    const peers = await discoverPeers(config, {
      previousState: state,
      verifyObjects: options.verifyObjects !== false,
    });
    return {
      ok: peers.every((peer) => peer.ok),
      connected: true,
      stale: false,
      checkedAt: new Date().toISOString(),
      peers: peers.map(publicPeer),
      warnings: [],
    };
  } catch (error) {
    if (!isDestinationUnavailable(error)) throw error;
    const cachedPeers = Object.values(state.peers).map((peer) => ({
      ok: true,
      device: peer.device,
      sessionHead: peer.sessionHead,
      status: "cached-stale",
      rollbackWarning: false,
      counts: { sessions: peer.sessionManifest?.objects?.length || 0, newOrChangedSincePull: 0 },
      verifiedAt: peer.verifiedAt,
    }));
    return {
      ok: cachedPeers.length > 0,
      connected: false,
      stale: true,
      checkedAt: new Date().toISOString(),
      peers: cachedPeers,
      warnings: [{ code: error.code, message: error.message }],
    };
  }
}

export async function pullPeers(config, configPath, options = {}) {
  const state = await loadPeerState(configPath);
  const peers = await discoverPeers(config, { previousState: state, verifyObjects: true });
  const selected = options.peerId
    ? peers.filter((peer) => peer.device.deviceId === options.peerId)
    : peers;
  if (options.peerId && selected.length === 0) {
    throw new ColdStorageError("PEER_NOT_FOUND", `No peer device matches: ${options.peerId}`);
  }
  const invalid = selected.filter((peer) => !peer.ok);
  if (invalid.length > 0) {
    throw new ColdStorageError(
      "PEER_PULL_INVALID",
      `Refusing to cache ${invalid.length} invalid peer(s).`,
      { peers: invalid.map(publicPeer) },
    );
  }

  const objectCount = selected.reduce(
    (sum, peer) => sum + (peer.sessionManifest?.objects.length || 0),
    0,
  );
  const plan = {
    ok: true,
    action: "sync-pull",
    apply: false,
    includeObjects: Boolean(options.includeObjects),
    peers: selected.map(publicPeer),
    counts: {
      peers: selected.length,
      sessionObjectsVerified: objectCount,
      sessionObjectsCached: 0,
    },
  };
  if (!options.apply) return plan;

  const nextState = structuredClone(state);
  nextState.version = PEER_STATE_VERSION;
  nextState.updatedAt = new Date().toISOString();
  let cached = 0;
  for (const peer of selected) {
    const peerId = peer.device.deviceId;
    const objectCache = {};
    if (options.includeObjects && peer.sessionManifest) {
      const cacheRoot = path.join(path.dirname(configPath), "peer-cache");
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      for (const object of peer.sessionManifest.objects) {
        const source = resolvePortablePath(config.destination, object.objectPath);
        const relative = `${peerId}/${object.sha256.slice(0, 2)}/${object.sha256}${object.encoding === "zstd" ? ".jsonl.zst" : ".jsonl"}`;
        const target = resolvePortablePath(cacheRoot, relative);
        const existed = await pathExists(target);
        const copied = await copyVerified(source, target, { destinationRoot: cacheRoot });
        if (copied.sha256 !== object.sha256) {
          throw new ColdStorageError(
            "PEER_CACHE_HASH_MISMATCH",
            `Peer cache verification failed: ${object.objectPath}`,
          );
        }
        if (!existed) cached += 1;
        objectCache[object.objectPath] = relative;
      }
    }
    nextState.peers[peerId] = {
      device: peer.device,
      sessionHead: peer.sessionHead,
      sessionManifest: peer.sessionManifest,
      verifiedAt: nextState.updatedAt,
      objectCache,
    };
  }
  const stateRoot = path.dirname(configPath);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await publishMutableJson(stateRoot, PEER_STATE_FILENAME, nextState, {
    runId: options.runId || randomUUID(),
  });
  return {
    ...plan,
    apply: true,
    statePath: peerStatePath(configPath),
    counts: { ...plan.counts, sessionObjectsCached: cached },
  };
}

export async function exportPeerSession(config, configPath, peerId, selector, outputPath, options = {}) {
  if (!peerId || !selector || !outputPath) {
    throw new ColdStorageError(
      "PEER_EXPORT_ARGUMENT_REQUIRED",
      "Peer export requires a peer ID, session selector, and output path.",
    );
  }
  const state = await loadPeerState(configPath);
  let peer = state.peers[peerId] || null;
  let connected = false;
  try {
    await assertDestinationIdentity(config);
    const live = (await discoverPeers(config, { previousState: state, verifyObjects: true })).find(
      (candidate) => candidate.ok && candidate.device.deviceId === peerId,
    );
    if (live) {
      peer = {
        device: live.device,
        sessionHead: live.sessionHead,
        sessionManifest: live.sessionManifest,
        objectCache: peer?.objectCache || {},
      };
      connected = true;
    }
  } catch (error) {
    if (!isDestinationUnavailable(error)) throw error;
  }
  if (!peer?.sessionManifest) {
    throw new ColdStorageError("PEER_NOT_CACHED", `No verified peer snapshot is available for ${peerId}.`);
  }
  const matches = peer.sessionManifest.objects.filter(
    (object) =>
      object.sessionId === selector ||
      object.sessionId.startsWith(selector) ||
      object.sourceKey === selector ||
      object.sourceKey.endsWith(selector),
  );
  if (matches.length !== 1) {
    throw new ColdStorageError(
      matches.length === 0 ? "PEER_SESSION_NOT_FOUND" : "PEER_SESSION_AMBIGUOUS",
      matches.length === 0
        ? `No peer session matches: ${selector}`
        : `More than one peer session matches: ${selector}`,
    );
  }
  const object = matches[0];
  const cacheRelative = peer.objectCache?.[object.objectPath];
  const cacheRoot = path.join(path.dirname(configPath), "peer-cache");
  const sourcePath = connected
    ? resolvePortablePath(config.destination, object.objectPath)
    : cacheRelative
      ? resolvePortablePath(cacheRoot, cacheRelative)
      : null;
  if (!sourcePath || !(await pathExists(sourcePath))) {
    throw new ColdStorageError(
      "PEER_OBJECT_UNAVAILABLE",
      "The verified peer object is not available; reconnect the vault or cache raw objects first.",
    );
  }
  if ((await hashFile(sourcePath)) !== object.sha256) {
    throw new ColdStorageError("PEER_OBJECT_HASH_MISMATCH", "Peer export source failed verification.");
  }
  const target = path.resolve(outputPath);
  const plan = {
    ok: true,
    action: "peer-export",
    apply: false,
    peerId,
    sessionId: object.sessionId,
    sourceKey: object.sourceKey,
    sha256: object.sha256,
    sizeBytes: object.sizeBytes,
    outputPath: target,
    from: connected ? "vault" : "local-cache",
  };
  if (!options.apply) return plan;
  const copied = await copyVerified(sourcePath, target);
  if (copied.sha256 !== object.sha256) {
    throw new ColdStorageError("PEER_EXPORT_HASH_MISMATCH", "Exported peer session failed verification.");
  }
  return { ...plan, apply: true };
}

async function comparePeerSnapshot(config, peerId, current, previous) {
  if (!current) {
    return { status: previous?.sessionHead ? "invalid" : "unseen", rollbackWarning: false, newOrChanged: 0 };
  }
  if (!previous?.sessionHead) {
    return {
      status: "unseen",
      rollbackWarning: false,
      newOrChanged: current.manifest.objects.length,
    };
  }
  if (previous.sessionHead.snapshotId === current.head.snapshotId) {
    return { status: "up-to-date", rollbackWarning: false, newOrChanged: 0 };
  }
  const descendant = await isDescendantSnapshot(
    config,
    peerId,
    current.manifest,
    previous.sessionHead.snapshotId,
  );
  return {
    status: descendant ? "peer-ahead" : "diverged",
    rollbackWarning: !descendant,
    newOrChanged: countChanged(previous.sessionManifest?.objects || [], current.manifest.objects),
  };
}

async function isDescendantSnapshot(config, peerId, manifest, ancestorId) {
  let current = manifest;
  const seen = new Set();
  while (current?.parentSnapshotId) {
    if (current.parentSnapshotId === ancestorId) return true;
    if (seen.has(current.parentSnapshotId)) return false;
    seen.add(current.parentSnapshotId);
    current = await findSnapshot(config, peerId, current.parentSnapshotId);
  }
  return false;
}

async function findSnapshot(config, peerId, snapshotId) {
  const root = safeJoin(config.destination, "devices", peerId, "sessions", "manifests");
  if (!(await pathExists(root))) return null;
  for (const year of await readdir(root, { withFileTypes: true })) {
    if (!year.isDirectory() || year.isSymbolicLink()) continue;
    const yearPath = path.join(root, year.name);
    for (const month of await readdir(yearPath, { withFileTypes: true })) {
      if (!month.isDirectory() || month.isSymbolicLink()) continue;
      const candidate = path.join(yearPath, month.name, `${snapshotId}.json`);
      if (!(await pathExists(candidate))) continue;
      const relative = path.relative(config.destination, candidate).split(path.sep).join("/");
      const snapshot = validateContract(await readRegularJson(config.destination, relative), {
        expectedKind: "session-snapshot",
      });
      return snapshot.deviceId === peerId && snapshot.snapshotId === snapshotId ? snapshot : null;
    }
  }
  return null;
}

function countChanged(previous, current) {
  const known = new Set(previous.map((object) => `${object.sourceKey}\0${object.sha256}`));
  return current.filter((object) => !known.has(`${object.sourceKey}\0${object.sha256}`)).length;
}

function publicPeer(peer) {
  return {
    ok: peer.ok,
    device: peer.device,
    sessionHead: peer.sessionHead,
    status: peer.status,
    rollbackWarning: peer.rollbackWarning,
    counts: peer.counts,
    ...(peer.error ? { error: peer.error } : {}),
  };
}

function isDestinationUnavailable(error) {
  return new Set([
    "DESTINATION_UNAVAILABLE",
    "DESTINATION_MARKER_MISSING",
    "DESTINATION_ID_MISMATCH",
  ]).has(error?.code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
