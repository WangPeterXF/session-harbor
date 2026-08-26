import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ColdStorageError,
  CONFIG_VERSION,
  assertDestinationIdentity,
  assertNoSymlinkComponents,
  pathExists,
  safeJoin,
  saveConfig,
} from "./archive-core.mjs";
import {
  inspectFilesystem,
  publishImmutableJson,
  readRegularJson,
} from "./atomic-store.mjs";
import {
  CONTRACT_VERSION,
  ContractValidationError,
  validateContract,
} from "./bridge-contracts.mjs";

export const VAULT_PROTOCOL_VERSION = 1;
export const VAULT_PROTOCOL_PATH = "protocol.json";

export async function initializeDevice(configPath, config, options = {}) {
  const apply = Boolean(options.apply);
  const now = options.now ? new Date(options.now) : new Date();
  const nowIso = now.toISOString();
  if (Number.isNaN(now.getTime())) {
    throw new ColdStorageError("DEVICE_TIME_INVALID", "Device initialization time is invalid.");
  }

  const marker = await assertDestinationIdentity(config);
  const identity = resolveIdentity(config, options, apply);
  const protocol = await ensureVaultProtocol(config, marker.destinationId, {
    apply,
    now: nowIso,
    runId: options.runId,
  });

  if (!apply) {
    const manifest = identity.id ? deviceManifest(identity, nowIso) : null;
    if (manifest) validateContractOrThrow(manifest, "device-manifest");
    return {
      ok: true,
      action: "device-init",
      apply: false,
      device: identity.id ? identity : null,
      willGenerateDeviceId: !identity.id,
      protocol: protocol.value,
      plan: {
        protocol: protocol.exists ? "keep" : "create",
        config: config.device.id ? "keep" : "save-device-identity",
        manifest: identity.id ? (await deviceManifestExists(config, identity.id) ? "verify" : "create") : "create",
        runRecord: "create",
      },
      warnings: protocol.warnings,
    };
  }

  const appliedIdentity = identity.id ? identity : generateIdentity(config, options);
  const nextConfig = {
    ...config,
    device: { ...appliedIdentity },
  };
  const configUpdated =
    !sameIdentity(config.device, appliedIdentity) || config.version !== CONFIG_VERSION;
  await saveConfig(configPath, nextConfig);
  if (typeof options.afterConfigSaved === "function") await options.afterConfigSaved(nextConfig);

  const manifestResult = await ensureDeviceManifest(nextConfig, appliedIdentity, nowIso, options);
  if (typeof options.afterManifestPublished === "function") {
    await options.afterManifestPublished(manifestResult);
  }

  const runId = options.runRecordId || randomUUID();
  const runRelativePath = runRecordPath(appliedIdentity.id, runId, now);
  const runRecord = {
    contractVersion: CONTRACT_VERSION,
    kind: "run-record",
    runId,
    deviceId: appliedIdentity.id,
    operation: "device-init",
    dryRun: false,
    status: "succeeded",
    startedAt: nowIso,
    completedAt: nowIso,
    inputRefs: [VAULT_PROTOCOL_PATH],
    outputRefs: [deviceManifestPath(appliedIdentity.id), runRelativePath],
    counts: {
      protocolCreated: protocol.created ? 1 : 0,
      deviceManifestCreated: manifestResult.created ? 1 : 0,
      configUpdated: configUpdated ? 1 : 0,
    },
    warnings: [...protocol.warnings, ...manifestResult.warnings].map((item) => item.code),
    errors: [],
  };
  validateContractOrThrow(runRecord, "run-record");
  const runResult = await publishImmutableJson(config.destination, runRelativePath, runRecord, {
    runId,
    conflictCode: "RUN_RECORD_CONFLICT",
  });

  return {
    ok: true,
    action: "device-init",
    apply: true,
    device: appliedIdentity,
    protocol: protocol.value,
    manifest: manifestResult.value,
    runRecord,
    paths: {
      protocol: VAULT_PROTOCOL_PATH,
      manifest: deviceManifestPath(appliedIdentity.id),
      runRecord: runRelativePath,
    },
    created: {
      protocol: protocol.created,
      manifest: manifestResult.created,
      runRecord: runResult.created,
    },
    warnings: [...protocol.warnings, ...manifestResult.warnings],
  };
}

export async function showDevice(config) {
  await assertDestinationIdentity(config);
  if (!config.device?.id) {
    throw new ColdStorageError(
      "DEVICE_NOT_INITIALIZED",
      "No stable device identity is stored. Run device init as a dry-run first.",
    );
  }
  const protocol = await readVaultProtocol(config);
  const manifest = await readDeviceManifest(config, config.device.id);
  assertIdentityMatches(config.device, manifest);
  return {
    ok: true,
    device: { ...config.device },
    protocol,
    manifest,
    paths: {
      protocol: VAULT_PROTOCOL_PATH,
      manifest: deviceManifestPath(config.device.id),
    },
  };
}

export async function bridgeDoctor(config) {
  const checks = [];
  const warnings = [];
  let identityReady = false;
  let destinationReady = false;

  try {
    const marker = await assertDestinationIdentity(config);
    destinationReady = true;
    checks.push(check("Destination identity", true, "OK", marker.destinationId));
  } catch (error) {
    checks.push(checkFromError("Destination identity", error));
  }

  if (destinationReady) {
    try {
      const protocol = await readVaultProtocol(config);
      checks.push(
        check(
          "Vault protocol",
          true,
          "OK",
          `protocol=${protocol.protocolVersion}, reader>=${protocol.minReaderVersion}`,
        ),
      );
    } catch (error) {
      checks.push(checkFromError("Vault protocol", error));
    }
  } else {
    checks.push(check("Vault protocol", false, "DESTINATION_UNAVAILABLE", "not checked"));
  }

  if (!config.device?.id) {
    checks.push(check("Local device config", false, "DEVICE_NOT_INITIALIZED", "device.id is not configured"));
  } else {
    identityReady = true;
    checks.push(
      check(
        "Local device config",
        true,
        "OK",
        `${config.device.id} (${config.device.platform}; ${config.device.displayName})`,
      ),
    );
  }

  if (destinationReady && identityReady) {
    try {
      const manifest = await readDeviceManifest(config, config.device.id);
      assertIdentityMatches(config.device, manifest);
      checks.push(check("Device manifest", true, "OK", deviceManifestPath(config.device.id)));
    } catch (error) {
      checks.push(checkFromError("Device manifest", error));
    }

    try {
      const writerRoot = safeJoin(config.destination, "devices", config.device.id);
      await assertNoSymlinkComponents(config.destination, writerRoot);
      const info = await lstat(writerRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new ColdStorageError(
          "DEVICE_WRITER_ROOT_INVALID",
          "The device writer root is not a real directory.",
        );
      }
      checks.push(check("Device writer root", true, "OK", `devices/${config.device.id}`));
    } catch (error) {
      checks.push(checkFromError("Device writer root", error));
    }
  } else {
    checks.push(check("Device manifest", false, "DEVICE_NOT_READY", "not checked"));
    checks.push(check("Device writer root", false, "DEVICE_NOT_READY", "not checked"));
  }

  if (destinationReady) {
    try {
      const filesystem = await inspectFilesystem(config.destination);
      checks.push(
        check(
          "Filesystem access",
          filesystem.writableCheck,
          filesystem.writableCheck ? "OK" : "FILESYSTEM_NOT_WRITABLE",
          filesystem.detail,
        ),
      );
      warnings.push(...filesystem.warnings);
    } catch (error) {
      checks.push(checkFromError("Filesystem access", error));
    }
  }

  return {
    ok: checks.every((item) => item.ok || item.optional),
    checks,
    warnings,
  };
}

export async function readVaultProtocol(config) {
  const value = await readRegularJson(config.destination, VAULT_PROTOCOL_PATH);
  if (value?.protocolVersion !== VAULT_PROTOCOL_VERSION || value?.minReaderVersion > VAULT_PROTOCOL_VERSION) {
    throw new ColdStorageError(
      "PROTOCOL_VERSION_UNSUPPORTED",
      `Vault protocol ${value?.protocolVersion} requires reader ${value?.minReaderVersion}.`,
    );
  }
  validateContractOrThrow(value, "vault-protocol");
  if (value.volumeId !== config.destinationId) {
    throw new ColdStorageError(
      "PROTOCOL_VOLUME_MISMATCH",
      "protocol.json belongs to a different destination identity.",
      { expected: config.destinationId, actual: value.volumeId },
    );
  }
  return value;
}

export function deviceManifestPath(deviceId) {
  return `devices/${deviceId}/device.json`;
}

async function ensureVaultProtocol(config, volumeId, options) {
  if (await pathExists(safeJoin(config.destination, VAULT_PROTOCOL_PATH))) {
    const value = await readVaultProtocol(config);
    return { exists: true, created: false, value, warnings: [] };
  }
  const value = {
    contractVersion: CONTRACT_VERSION,
    kind: "vault-protocol",
    protocolVersion: VAULT_PROTOCOL_VERSION,
    minReaderVersion: VAULT_PROTOCOL_VERSION,
    volumeId,
    createdAt: options.now,
  };
  validateContractOrThrow(value, "vault-protocol");
  if (!options.apply) return { exists: false, created: false, value, warnings: [] };
  const result = await publishImmutableJson(config.destination, VAULT_PROTOCOL_PATH, value, {
    runId: options.runId,
    conflictCode: "PROTOCOL_CONFLICT",
  });
  const warnings = durabilityWarnings(result, VAULT_PROTOCOL_PATH);
  return { exists: false, created: result.created, value, warnings };
}

async function ensureDeviceManifest(config, identity, nowIso, options) {
  const relativePath = deviceManifestPath(identity.id);
  if (await deviceManifestExists(config, identity.id)) {
    const existing = await readDeviceManifest(config, identity.id);
    assertIdentityMatches(identity, existing);
    return { created: false, value: existing, warnings: [] };
  }
  const value = deviceManifest(identity, nowIso);
  validateContractOrThrow(value, "device-manifest");
  const result = await publishImmutableJson(config.destination, relativePath, value, {
    runId: options.runId,
    conflictCode: "DEVICE_IDENTITY_CONFLICT",
  });
  return { created: result.created, value, warnings: durabilityWarnings(result, relativePath) };
}

async function readDeviceManifest(config, deviceId) {
  const value = await readRegularJson(config.destination, deviceManifestPath(deviceId));
  validateContractOrThrow(value, "device-manifest");
  return value;
}

async function deviceManifestExists(config, deviceId) {
  return pathExists(safeJoin(config.destination, ...deviceManifestPath(deviceId).split("/")));
}

function resolveIdentity(config, options, apply) {
  const stored = config.device || {};
  const requested = {
    id: String(options.deviceId || "").trim(),
    displayName: String(options.displayName || "").trim(),
    platform: String(options.platform || "").trim(),
  };
  if (stored.id && requested.id && stored.id !== requested.id) {
    throw new ColdStorageError(
      "DEVICE_IDENTITY_CONFLICT",
      `Config is already bound to device ${stored.id}; refusing ${requested.id}.`,
    );
  }
  if (stored.id && requested.displayName && stored.displayName !== requested.displayName) {
    throw new ColdStorageError(
      "DEVICE_IDENTITY_CONFLICT",
      "The requested display name conflicts with the stored device identity.",
    );
  }
  if (stored.id && requested.platform && stored.platform !== requested.platform) {
    throw new ColdStorageError(
      "DEVICE_IDENTITY_CONFLICT",
      "The requested platform conflicts with the stored device identity.",
    );
  }
  const identity = {
    id: stored.id || requested.id || "",
    displayName: stored.id
      ? stored.displayName
      : requested.displayName || stored.displayName || os.hostname(),
    platform: stored.id ? stored.platform : requested.platform || stored.platform || platformName(),
  };
  if (!identity.id && apply) return generateIdentity(config, options, identity);
  if (identity.id) validateContractOrThrow(deviceManifest(identity, new Date().toISOString()), "device-manifest");
  return identity;
}

function generateIdentity(config, options, defaults = {}) {
  const displayName = defaults.displayName || String(options.displayName || "").trim() || os.hostname();
  const platform = defaults.platform || String(options.platform || "").trim() || platformName();
  const suffix = (options.randomUUID || randomUUID)().replaceAll("-", "").slice(0, 8);
  const base = slug(displayName).slice(0, 44) || "device";
  const identity = {
    id: `${platform}-${base}-${suffix}`.slice(0, 64).replace(/-+$/g, ""),
    displayName,
    platform,
  };
  validateContractOrThrow(deviceManifest(identity, new Date().toISOString()), "device-manifest");
  return identity;
}

function deviceManifest(identity, createdAt) {
  return {
    contractVersion: CONTRACT_VERSION,
    kind: "device-manifest",
    deviceId: identity.id,
    displayName: identity.displayName,
    platform: identity.platform,
    createdAt,
    capabilities: ["session-archive", "session-exchange", "memory-exchange"],
  };
}

function assertIdentityMatches(identity, manifest) {
  if (
    identity.id !== manifest.deviceId ||
    identity.displayName !== manifest.displayName ||
    identity.platform !== manifest.platform
  ) {
    throw new ColdStorageError(
      "DEVICE_IDENTITY_CONFLICT",
      "The device manifest conflicts with the stable local device identity.",
      { local: identity, manifest },
    );
  }
}

function sameIdentity(left = {}, right = {}) {
  return left.id === right.id && left.displayName === right.displayName && left.platform === right.platform;
}

function runRecordPath(deviceId, runId, now) {
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `devices/${deviceId}/runs/${year}/${month}/${runId}.json`;
}

function validateContractOrThrow(value, expectedKind) {
  try {
    return validateContract(value, { expectedKind });
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new ColdStorageError(
        "BRIDGE_CONTRACT_INVALID",
        `Invalid ${expectedKind} contract.`,
        { issues: error.issues },
      );
    }
    throw error;
  }
}

function durabilityWarnings(result, relativePath) {
  if (result.durability !== "file-only") return [];
  return [
    {
      code: "DIRECTORY_FSYNC_UNAVAILABLE",
      message: `File read-back passed but directory fsync was unavailable for ${relativePath}.`,
    },
  ];
}

function check(name, ok, code, detail, optional = false) {
  return { name, ok, optional, code, detail };
}

function checkFromError(name, error) {
  return check(name, false, error.code || "UNEXPECTED_ERROR", error.message);
}

function platformName(nodePlatform = process.platform) {
  if (nodePlatform === "darwin") return "macos";
  if (nodePlatform === "win32") return "windows";
  return "linux";
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "device";
}
