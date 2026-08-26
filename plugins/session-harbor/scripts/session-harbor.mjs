#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  ColdStorageError,
  archiveSessions,
  defaultConfigPath,
  doctor,
  formatBytes,
  initializeStorage,
  loadConfig,
  pathExists,
  reclaimSessions,
  restoreSession,
  runCodexSlim,
  scanSessions,
  verifyArchive,
} from "./lib/archive-core.mjs";
import { runBackup } from "./lib/backup-runner.mjs";
import {
  bridgeDoctor,
  initializeDevice,
  showDevice,
} from "./lib/device-registry.mjs";
import {
  planSessionPush,
  pushSessionSnapshot,
} from "./lib/session-snapshot.mjs";
import {
  exportPeerSession,
  peerStatus,
  pullPeers,
} from "./lib/peer-discovery.mjs";
import { listProjects, mapProject } from "./lib/project-map.mjs";
import { runRetentionPolicy } from "./lib/retention-runner.mjs";
import { buildManagementDashboard } from "./lib/management-dashboard.mjs";
import { createOperationTracker } from "./lib/operation-state.mjs";
import { settingsView, updateSettings } from "./lib/settings.mjs";
import {
  approveMemoryDraft,
  createMemoryDraft,
  diffPeerMemory,
  memoryStatus,
  stagePeerMemory,
} from "./lib/memory-exchange.mjs";
import { migrateLayout } from "./lib/migration.mjs";

const CLI_VERSION = "0.3.0";

export async function main(argv = process.argv.slice(2), io = console) {
  const parsed = parseArgs(argv);
  const command = parsed.positionals.shift() || "help";

  if (command === "version" || parsed.options.version) {
    io.log(`session-harbor ${CLI_VERSION}`);
    return 0;
  }
  if (command === "help" || parsed.options.help) {
    io.log(helpText());
    return 0;
  }

  const configPath = path.resolve(expandCliPath(parsed.options.config || defaultConfigPath()));
  const overrides = new Set(["settings", "config"]).has(command)
    ? {}
    : configOverrides(parsed.options);

  if (command === "init") {
    const destination = parsed.options.destination;
    if (!destination) {
      throw new ColdStorageError(
        "DESTINATION_REQUIRED",
        "init requires --destination <path>; no files were written.",
      );
    }
    const existing = await loadConfig(configPath);
    const resolvedDestination = path.resolve(expandCliPath(destination));
    const sameDestination = existing.destination === resolvedDestination;
    const input = {
      ...existing,
      ...overrides,
      destination,
      destinationId: sameDestination ? existing.destinationId : "",
    };
    const result = await initializeStorage(configPath, input, {
      apply: Boolean(parsed.options.apply),
    });
    printResult(io, parsed.options.json, {
      ok: true,
      action: "init",
      apply: result.apply,
      configPath,
      markerPath: result.markerPath,
      config: publicConfig(result.config),
    });
    if (!parsed.options.json && !result.apply) {
      io.log("Dry-run only. Re-run init with --apply to create the marker and config.");
    }
    return 0;
  }

  const config = await loadConfig(configPath, overrides);
  const operationOptions = {
    apply: Boolean(parsed.options.apply),
    finalize: Boolean(parsed.options.finalize),
    overwrite: Boolean(parsed.options.overwrite),
    skipOpenCheck: Boolean(parsed.options["skip-open-check"]),
  };

  if (command === "device") {
    const subcommand = parsed.positionals.shift() || "show";
    if (subcommand === "init") {
      const result = await initializeDevice(configPath, config, {
        apply: operationOptions.apply,
        deviceId: parsed.options["device-id"],
        displayName: parsed.options["device-name"],
        platform: parsed.options.platform,
      });
      printResult(io, parsed.options.json, result);
      if (!parsed.options.json && !operationOptions.apply) {
        io.log("Dry-run only. Re-run device init with --apply after reviewing the stable identity.");
      }
      return 0;
    }
    if (subcommand === "show") {
      printResult(io, parsed.options.json, await showDevice(config));
      return 0;
    }
    throw new ColdStorageError("DEVICE_COMMAND_UNKNOWN", `Unknown device command: ${subcommand}`);
  }

  if (command === "bridge") {
    const subcommand = parsed.positionals.shift() || "doctor";
    if (subcommand !== "doctor") {
      throw new ColdStorageError("BRIDGE_COMMAND_UNKNOWN", `Unknown bridge command: ${subcommand}`);
    }
    const result = await bridgeDoctor(config);
    printBridgeDoctor(io, parsed.options.json, result, configPath);
    return result.ok ? 0 : 2;
  }

  if (command === "sync") {
    const subcommand = parsed.positionals.shift() || "plan";
    const syncOptions = {
      eligibleOnly: Boolean(parsed.options["eligible-only"]),
      failOnInventoryError: !parsed.options["allow-partial"],
    };
    if (subcommand === "plan") {
      printResult(io, parsed.options.json, await planSessionPush(config, syncOptions));
      return 0;
    }
    if (subcommand === "push") {
      const result = await pushSessionSnapshot(config, {
        ...syncOptions,
        apply: operationOptions.apply,
      });
      printResult(io, parsed.options.json, result);
      if (!parsed.options.json && !operationOptions.apply) {
        io.log("Dry-run only. Re-run sync push with --apply after reviewing the snapshot plan.");
      }
      return 0;
    }
    if (subcommand === "status") {
      printResult(io, parsed.options.json, await peerStatus(config, configPath));
      return 0;
    }
    if (subcommand === "pull") {
      const result = await pullPeers(config, configPath, {
        apply: operationOptions.apply,
        peerId: parsed.options.peer,
        includeObjects: Boolean(parsed.options["include-objects"]),
      });
      printResult(io, parsed.options.json, result);
      if (!parsed.options.json && !operationOptions.apply) {
        io.log("Dry-run only. Re-run sync pull with --apply to cache verified peer state.");
      }
      return 0;
    }
    if (subcommand === "export") {
      const peerId = parsed.options.peer || parsed.positionals.shift();
      const selector = parsed.positionals.shift();
      const output = parsed.options.output;
      const result = await exportPeerSession(
        config,
        configPath,
        peerId,
        selector,
        output ? path.resolve(expandCliPath(output)) : output,
        { apply: operationOptions.apply },
      );
      printResult(io, parsed.options.json, result);
      if (!parsed.options.json && !operationOptions.apply) {
        io.log("Dry-run only. Re-run sync export with --apply to materialize the verified copy.");
      }
      return 0;
    }
    throw new ColdStorageError("SYNC_COMMAND_UNKNOWN", `Unknown sync command: ${subcommand}`);
  }

  if (command === "project") {
    const subcommand = parsed.positionals.shift() || "list";
    if (subcommand === "list") {
      printResult(io, parsed.options.json, listProjects(config));
      return 0;
    }
    if (subcommand === "map") {
      const projectId = parsed.positionals.shift();
      const localPath = parsed.positionals.shift();
      const result = await mapProject(
        configPath,
        config,
        projectId,
        localPath ? expandCliPath(localPath) : localPath,
        { apply: operationOptions.apply },
      );
      printResult(io, parsed.options.json, result);
      if (!parsed.options.json && !operationOptions.apply) {
        io.log("Dry-run only. Re-run project map with --apply to update private local config.");
      }
      return 0;
    }
    throw new ColdStorageError("PROJECT_COMMAND_UNKNOWN", `Unknown project command: ${subcommand}`);
  }

  if (command === "backup") {
    const subcommand = parsed.positionals.shift() || (operationOptions.apply ? "run" : "plan");
    if (!new Set(["plan", "run"]).has(subcommand)) {
      throw new ColdStorageError("BACKUP_COMMAND_UNKNOWN", `Unknown backup command: ${subcommand}`);
    }
    if (parsed.options["if-available"] && !(await pathExists(config.destination))) {
      printResult(io, parsed.options.json, {
        ok: true,
        action: "backup-skipped",
        reason: "destination-unavailable",
        destination: config.destination,
      });
      return 0;
    }
    const appliedBackup = subcommand === "run" && operationOptions.apply;
    const tracker = appliedBackup ? createOperationTracker(configPath, "backup") : null;
    if (tracker) await tracker.start({ stage: "inventory" });
    let result;
    try {
      result = await runBackup(config, {
        apply: appliedBackup,
        skipOpenCheck: operationOptions.skipOpenCheck,
        onProgress: tracker ? (event) => tracker.progress(event) : undefined,
      });
      if (tracker) {
        await tracker.finish(result.ok ? "succeeded" : "partial", {
          stage: "completed",
          processed: result.backup.candidates,
          total: result.backup.candidates,
          copied: result.backup.copied,
          skipped: result.backup.skipped,
          errors: result.backup.errors.length + (result.sync.errors?.length || 0),
        });
      }
    } catch (error) {
      if (tracker) {
        await tracker.finish("failed", {
          stage: "failed",
          error: { code: error?.code || "UNEXPECTED_ERROR", message: error.message },
        });
      }
      throw error;
    }
    printBackup(io, parsed.options.json, result);
    if (!parsed.options.json && !result.apply) {
      io.log("No files were changed. Re-run backup run --apply after reviewing this plan.");
    }
    return result.ok ? 0 : 2;
  }

  if (command === "dashboard" || command === "manage") {
    const result = await buildManagementDashboard(config, configPath, {
      filter: parsed.options.state,
      limit: parsed.options.limit,
    });
    printDashboard(io, parsed.options.json, result);
    return 0;
  }

  if (command === "settings" || command === "config") {
    const subcommand = parsed.positionals.shift() || "show";
    if (subcommand === "show") {
      printResult(io, parsed.options.json, {
        ok: true,
        action: "settings-show",
        configPath,
        settings: settingsView(config),
      });
      return 0;
    }
    if (subcommand === "set") {
      const result = await updateSettings(configPath, config, settingsChanges(parsed.options), {
        apply: operationOptions.apply,
      });
      printResult(io, parsed.options.json, result);
      if (!parsed.options.json && !operationOptions.apply) {
        io.log("No settings were changed. Re-run settings set with --apply after review.");
      }
      return 0;
    }
    throw new ColdStorageError("SETTINGS_COMMAND_UNKNOWN", `Unknown settings command: ${subcommand}`);
  }

  if (command === "policy") {
    const subcommand = parsed.positionals.shift() || "plan";
    if (!new Set(["plan", "run"]).has(subcommand)) {
      throw new ColdStorageError("POLICY_COMMAND_UNKNOWN", `Unknown policy command: ${subcommand}`);
    }
    const result = await runRetentionPolicy(config, {
      apply: subcommand === "run" && operationOptions.apply,
      publish: Boolean(parsed.options.publish),
      reclaim: Boolean(parsed.options.reclaim),
      confirmDeleteLocal: Boolean(parsed.options["confirm-delete-local"]),
      skipOpenCheck: operationOptions.skipOpenCheck,
    });
    printPolicy(io, parsed.options.json, result);
    if (!parsed.options.json && !result.apply) {
      io.log("No files were changed. Use policy run --apply with explicit --publish/--reclaim scopes.");
    }
    return result.ok ? 0 : 2;
  }

  if (command === "memory") {
    const subcommand = parsed.positionals.shift() || "status";
    const projectId = parsed.options.project;
    if (subcommand === "draft") {
      if (!parsed.options.input) {
        throw new ColdStorageError("MEMORY_INPUT_REQUIRED", "memory draft requires --input <json>.");
      }
      const inputPath = path.resolve(expandCliPath(parsed.options.input));
      let input;
      try {
        input = JSON.parse(await readFile(inputPath, "utf8"));
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new ColdStorageError("MEMORY_INPUT_JSON_INVALID", `Invalid JSON: ${inputPath}`);
        }
        throw error;
      }
      const result = await createMemoryDraft(config, configPath, projectId, input, {
        apply: operationOptions.apply,
      });
      printResult(io, parsed.options.json, result);
      return 0;
    }
    if (subcommand === "approve") {
      const draftId = parsed.positionals.shift();
      const result = await approveMemoryDraft(config, configPath, projectId, draftId, {
        apply: operationOptions.apply,
        includeRestricted: Boolean(parsed.options["include-restricted"]),
      });
      printResult(io, parsed.options.json, result);
      return 0;
    }
    if (subcommand === "diff") {
      printResult(
        io,
        parsed.options.json,
        await diffPeerMemory(config, configPath, parsed.options.peer, projectId),
      );
      return 0;
    }
    if (subcommand === "stage") {
      const result = await stagePeerMemory(
        config,
        configPath,
        parsed.options.peer,
        projectId,
        {
          apply: operationOptions.apply,
          includeRestricted: Boolean(parsed.options["include-restricted"]),
        },
      );
      printResult(io, parsed.options.json, result);
      return 0;
    }
    if (subcommand === "status") {
      printResult(io, parsed.options.json, await memoryStatus(configPath, { projectId }));
      return 0;
    }
    throw new ColdStorageError("MEMORY_COMMAND_UNKNOWN", `Unknown memory command: ${subcommand}`);
  }

  if (command === "migrate") {
    const layout = parsed.positionals.shift();
    const subcommand = parsed.positionals.shift() || "plan";
    if (!new Set(["codexbridge", "v01"]).has(layout)) {
      throw new ColdStorageError("MIGRATION_LAYOUT_UNKNOWN", `Unknown migration layout: ${layout}`);
    }
    if (!new Set(["plan", "apply"]).has(subcommand)) {
      throw new ColdStorageError("MIGRATION_COMMAND_UNKNOWN", `Unknown migration command: ${subcommand}`);
    }
    const source = parsed.options.source
      ? path.resolve(expandCliPath(parsed.options.source))
      : parsed.options.source;
    const result = await migrateLayout(config, source, layout, {
      apply: subcommand === "apply" && operationOptions.apply,
      allowPartial: Boolean(parsed.options["allow-partial"]),
    });
    printResult(io, parsed.options.json, result);
    if (!parsed.options.json && !result.apply) {
      io.log("No legacy files were changed. Use migrate ... apply --apply to publish verified copies.");
    }
    return result.ok ? 0 : 2;
  }

  if (command === "doctor") {
    const result = await doctor(config);
    printDoctor(io, parsed.options.json, result, configPath, config);
    return result.ok ? 0 : 2;
  }

  if (command === "scan") {
    const sessions = await scanSessions(config);
    printScan(io, parsed.options.json, sessions, config);
    return 0;
  }

  if (command === "archive") {
    const result = await archiveSessions(config, operationOptions);
    printArchive(io, parsed.options.json, result, config);
    return result.errors.length === 0 ? 0 : 2;
  }

  if (command === "reclaim" || command === "cleanup") {
    const result = await reclaimSessions(config, {
      ...operationOptions,
      selector: parsed.options.session,
      confirmDeleteLocal: Boolean(parsed.options["confirm-delete-local"]),
    });
    printArchive(io, parsed.options.json, result, config, { reclaim: true });
    return result.errors.length === 0 ? 0 : 2;
  }

  if (command === "verify" || command === "status") {
    const result = await verifyArchive(config);
    printVerify(io, parsed.options.json, result);
    return result.ok ? 0 : 2;
  }

  if (command === "restore") {
    const selector = parsed.positionals.shift();
    if (!selector) {
      throw new ColdStorageError("RESTORE_SELECTOR_REQUIRED", "restore requires a session ID or source path.");
    }
    const result = await restoreSession(config, selector, operationOptions);
    printResult(io, parsed.options.json, result);
    if (!parsed.options.json && !operationOptions.apply) {
      io.log("Dry-run only. Re-run with --apply after reviewing the selected session.");
    }
    return 0;
  }

  if (command === "compress") {
    const result = await runCodexSlim(config, {
      ...operationOptions,
      force: Boolean(parsed.options.force),
    });
    printResult(io, parsed.options.json, result);
    if (!parsed.options.json && !operationOptions.apply) {
      io.log("codex-slim ran in dry-run mode. Re-run with --apply only after review.");
    }
    return 0;
  }

  throw new ColdStorageError("COMMAND_UNKNOWN", `Unknown command: ${command}`);
}

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  const booleanFlags = new Set([
    "apply",
    "finalize",
    "force",
    "help",
    "json",
    "overwrite",
    "eligible-only",
    "allow-partial",
    "include-objects",
    "confirm-delete-local",
    "auto-reclaim",
    "verify-existing-objects",
    "auto-publish",
    "publish",
    "reclaim",
    "include-restricted",
    "if-available",
    "skip-open-check",
    "version",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    const key = token.slice(2, equal === -1 ? undefined : equal);
    if (booleanFlags.has(key)) {
      options[key] = equal === -1 ? true : token.slice(equal + 1) !== "false";
      continue;
    }
    const value = equal === -1 ? argv[++index] : token.slice(equal + 1);
    if (value === undefined || value.startsWith("--")) {
      throw new ColdStorageError("ARGUMENT_VALUE_REQUIRED", `--${key} requires a value.`);
    }
    options[key] = value;
  }
  return { positionals, options };
}

function settingsChanges(options) {
  return {
    retention: {
      cleanupAfterInactiveDays: options["cleanup-after-inactive-days"],
      minimumBackupAgeDays: options["minimum-backup-age-days"],
      reclaimAction: options["reclaim-action"],
      autoReclaim: options["auto-reclaim"],
    },
    backup: {
      allowPartial: options["allow-partial"],
      verifyExistingObjects: options["verify-existing-objects"],
    },
    exchange: {
      autoPublish: options["auto-publish"],
    },
  };
}

function configOverrides(options) {
  const map = {
    "codex-home": "codexHome",
    destination: "destination",
    "older-than-days": "olderThanDays",
    "minimum-size-mb": "minimumSizeMB",
    "grace-days": "graceDays",
    compression: "compression",
    "compression-level": "compressionLevel",
    mode: "mode",
  };
  const result = {};
  for (const [option, key] of Object.entries(map)) {
    if (options[option] !== undefined) result[key] = options[option];
  }
  if (options["archive-after-days"] !== undefined) {
    result.olderThanDays = options["archive-after-days"];
  }
  if (options["cleanup-after-inactive-days"] !== undefined) {
    result.olderThanDays = options["cleanup-after-inactive-days"];
  }
  if (options["local-grace-days"] !== undefined) {
    result.graceDays = options["local-grace-days"];
  }
  if (options["minimum-backup-age-days"] !== undefined) {
    result.graceDays = options["minimum-backup-age-days"];
  }
  if (options["reclaim-action"] !== undefined) {
    const value = options["reclaim-action"];
    result.mode = value === "keep" ? "copy-only" : value === "delete" ? "delete" : value;
  }
  if (options["auto-reclaim"] !== undefined) result.autoReclaim = options["auto-reclaim"];
  if (options.roots) {
    result.roots = options.roots
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return result;
}

function printScan(io, asJson, sessions, config) {
  const eligible = sessions.filter((item) => item.eligible);
  const summary = {
    ok: true,
    eligibleCount: eligible.length,
    eligibleBytes: eligible.reduce((sum, item) => sum + item.sizeBytes, 0),
    linkedCount: sessions.filter((item) => item.reason === "already-linked").length,
    brokenLinkCount: sessions.filter((item) => item.reason === "broken-link").length,
    sessions,
  };
  if (asJson) return printResult(io, true, summary);
  io.log(
    `Eligible: ${summary.eligibleCount} session(s), ${formatBytes(summary.eligibleBytes)} ` +
      `(older than ${config.olderThanDays} day(s), at least ${config.minimumSizeMB} MiB)`,
  );
  io.log(`Linked: ${summary.linkedCount}; broken links: ${summary.brokenLinkCount}`);
  for (const item of eligible.slice(0, 50)) {
    io.log(`  ${formatBytes(item.sizeBytes).padStart(11)}  ${item.sourceKey}`);
  }
  if (eligible.length > 50) io.log(`  … ${eligible.length - 50} more`);
}

function printArchive(io, asJson, result, config, options = {}) {
  if (asJson) return printResult(io, true, result);
  io.log(
    result.apply
      ? options.reclaim
        ? "Local reclaim apply result:"
        : "Archive apply result:"
      : options.reclaim
        ? "Local reclaim dry-run result:"
        : "Archive dry-run result:",
  );
  io.log(`  candidates: ${result.candidates} (${formatBytes(result.candidateBytes)})`);
  io.log(`  copied: ${result.copied} (${formatBytes(result.copiedBytes)})`);
  io.log(`  linked: ${result.linked} (${formatBytes(result.linkedBytes)})`);
  io.log(`  deleted locally: ${result.reclaimed} (${formatBytes(result.reclaimedBytes)})`);
  io.log(`  ready for reclaim: ${result.readyForReclaim}`);
  io.log(`  waiting for ${config.graceDays}-day grace: ${result.deferredForGrace}`);
  io.log(`  skipped: ${result.skipped}; errors: ${result.errors.length}`);
  for (const error of result.errors) io.error(`  ${error.code}: ${error.sourceKey}: ${error.message}`);
  if (!result.apply) io.log("No files were changed. Re-run with --apply after reviewing this plan.");
}

function printBackup(io, asJson, result) {
  if (asJson) return printResult(io, true, result);
  const backup = result.backup;
  const sync = result.sync;
  io.log(result.apply ? "All-session incremental backup result:" : "All-session backup plan:");
  io.log(
    `  local inventory: ${backup.candidates} session(s) (${formatBytes(backup.candidateBytes)}), ` +
      `${backup.copied} copied, ${backup.skipped} unchanged, ${backup.errors.length} error(s)`,
  );
  io.log(
    `  vault snapshot: ${sync.counts.discovered ?? sync.counts.objectsDiscovered} session object(s), ` +
      `${sync.counts.newObjects ?? sync.counts.objectsPublished ?? 0} new, ` +
      `${sync.counts.existingObjects ?? sync.counts.objectsReused ?? 0} reused, ` +
      `${sync.counts.inventoryErrors ?? sync.errors?.length ?? 0} inventory error(s)`,
  );
  io.log(`  completeness: ${result.complete ? "complete" : "partial; retry on the next trigger"}`);
  for (const error of backup.errors) {
    io.error(`  ${error.code}: ${error.sourceKey}: ${error.message}`);
  }
}

function printDashboard(io, asJson, result) {
  if (asJson) return printResult(io, true, result);
  const counts = result.counts;
  io.log("SessionHarbor management dashboard:");
  io.log(
    `  local: ${counts.localInventory}; cataloged: ${counts.catalogEntries}; ` +
      `current: ${counts.backedCurrentLocal}; pending backup: ${counts.backupPending}`,
  );
  io.log(
    `  deleted locally: ${counts.vaultOnly}; linked: ${counts.linked}; restored: ${counts.restored}; ` +
      `restore available: ${counts.restoreAvailable}`,
  );
  io.log(
    `  cleanup: ${counts.cleanupReady} ready, ${counts.waitingBackupAge} waiting for backup age, ` +
      `${counts.eligiblePolicyKeep} eligible but policy=keep`,
  );
  io.log(
    `  policy: inactive ${result.policy.cleanupAfterInactiveDays} day(s) + backup age ` +
      `${result.policy.minimumBackupAgeDays} day(s), action=${result.policy.reclaimAction}, ` +
      `auto=${result.policy.autoReclaim}`,
  );
  if (result.operation.current) {
    const current = result.operation.current;
    io.log(
      `  running: ${current.operation}/${current.stage} ${current.processed ?? 0}/` +
        `${current.total ?? "?"}${result.operation.currentStale ? " (stale)" : ""}`,
    );
  } else if (result.operation.last) {
    io.log(
      `  last operation: ${result.operation.last.operation} ${result.operation.last.status} at ` +
        `${result.operation.last.completedAt || result.operation.last.updatedAt}`,
    );
  }
  io.log(
    `  showing ${result.returnedCount}/${result.matchCount} session(s), filter=${result.filter}`,
  );
  for (const item of result.sessions) {
    io.log(
      `  ${formatBytes(item.sizeBytes).padStart(11)}  ${item.backupStatus.padEnd(13)} ` +
        `${item.localStatus.padEnd(12)} ${item.cleanupStatus.padEnd(20)} ${item.sourceKey}`,
    );
  }
  if (result.truncated) io.log("  … use --limit all or a narrower --state filter to see more");
  io.log(`  note: ${result.verificationNote}`);
}

function printVerify(io, asJson, result) {
  if (asJson) return printResult(io, true, result);
  io.log(result.ok ? "Archive verification: OK" : "Archive verification: ATTENTION REQUIRED");
  for (const entry of result.entries) {
    io.log(`  ${entry.targetStatus.padEnd(14)} ${entry.sourceStatus.padEnd(16)} ${entry.sourceKey}`);
  }
}

function printDoctor(io, asJson, result, configPath, config) {
  if (asJson) return printResult(io, true, { ...result, configPath, config: publicConfig(config) });
  io.log(`Config: ${configPath}`);
  for (const check of result.checks) {
    io.log(`  ${check.ok ? "OK" : check.optional ? "OPTIONAL" : "FAIL"}  ${check.name}: ${check.detail}`);
  }
}

function printBridgeDoctor(io, asJson, result, configPath) {
  if (asJson) return printResult(io, true, { ...result, configPath });
  io.log(`Config: ${configPath}`);
  io.log(result.ok ? "Bridge doctor: OK" : "Bridge doctor: ATTENTION REQUIRED");
  for (const check of result.checks) {
    io.log(
      `  ${check.ok ? "OK" : check.optional ? "OPTIONAL" : "FAIL"}  ${check.name}: ` +
        `${check.code}: ${check.detail}`,
    );
  }
  for (const warning of result.warnings) io.log(`  WARNING  ${warning.code}: ${warning.message}`);
}

function printPolicy(io, asJson, result) {
  if (asJson) return printResult(io, true, result);
  const archive = result.archive;
  const sync = result.sync;
  const reclaim = result.reclaim;
  io.log(result.apply ? "Retention policy apply result:" : "Retention policy dry-run result:");
  io.log(
    `  scopes: archive=yes, publish=${result.scopes.publish ? "yes" : "no"}, ` +
      `reclaim=${result.scopes.reclaim ? "yes" : "no"}`,
  );
  io.log(
    `  archive: ${archive.candidates} candidate(s) (${formatBytes(archive.candidateBytes)}), ` +
      `${archive.copied} copied, ${archive.skipped} skipped, ${archive.errors.length} error(s)`,
  );
  if (sync) {
    io.log(
      `  publish: ${sync.counts.discovered} object(s), ` +
        `${sync.counts.newObjects ?? sync.counts.objectsPublished ?? 0} new, ` +
        `${sync.counts.existingObjects ?? sync.counts.objectsReused ?? 0} reused, ` +
        `snapshot=${sync.snapshotId}${sync.unchanged ? " (unchanged)" : ""}`,
    );
  }
  if (reclaim) {
    io.log(
      `  reclaim: ${reclaim.readyForReclaim} ready, ${reclaim.deferredForGrace} waiting, ` +
        `${reclaim.reclaimed} deleted locally, ${reclaim.linked} linked, ` +
        `${reclaim.errors.length} error(s)`,
    );
  }
}

function printResult(io, asJson, result) {
  if (asJson) io.log(JSON.stringify(result, null, 2));
  else io.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
}

function publicConfig(config) {
  return {
    version: config.version,
    codexHome: config.codexHome,
    destination: config.destination,
    destinationId: config.destinationId,
    roots: config.roots,
    olderThanDays: config.olderThanDays,
    minimumSizeMB: config.minimumSizeMB,
    graceDays: config.graceDays,
    compression: config.compression,
    compressionLevel: config.compressionLevel,
    mode: config.mode,
    retention: { ...config.retention },
    strictOpenFileCheck: config.strictOpenFileCheck,
    backup: { ...config.backup },
    device: { ...config.device },
    exchange: { ...config.exchange },
    projects: { ...config.projects },
    memory: { ...config.memory },
  };
}

function expandCliPath(value) {
  if (value === "~") return process.env.HOME;
  if (value.startsWith("~/")) return path.join(process.env.HOME, value.slice(2));
  return value;
}

function helpText() {
  return `SessionHarbor

Usage:
  session-harbor init --destination <path> [options]
  session-harbor doctor [options]
  session-harbor device init [--apply] [device options]
  session-harbor device show [options]
  session-harbor bridge doctor [options]
  session-harbor backup [plan|run] [--apply] [options]
  session-harbor dashboard [--state <filter>] [--limit <n|all>] [--json]
  session-harbor settings show [--json]
  session-harbor settings set [policy options] [--apply]
  session-harbor sync plan [--eligible-only] [options]
  session-harbor sync push [--eligible-only] [--apply] [options]
  session-harbor sync status [options]
  session-harbor sync pull [--peer <device-id>] [--include-objects] [--apply]
  session-harbor sync export <peer-id> <session-id> --output <path> [--apply]
  session-harbor project map <project-id> <local-path> [--apply]
  session-harbor project list
  session-harbor policy plan [--publish] [--reclaim]
  session-harbor policy run --apply [--publish] [--reclaim] [--confirm-delete-local]
  session-harbor memory draft --project <id> --input <json> [--apply]
  session-harbor memory approve <draft-id> --project <id> [--include-restricted] [--apply]
  session-harbor memory diff --peer <device-id> --project <id>
  session-harbor memory stage --peer <device-id> --project <id> [--include-restricted] [--apply]
  session-harbor memory status [--project <id>]
  session-harbor migrate codexbridge plan --source <path>
  session-harbor migrate codexbridge apply --source <path> --apply
  session-harbor migrate v01 plan --source <path>
  session-harbor migrate v01 apply --source <path> --apply
  session-harbor scan [options]
  session-harbor archive [--apply] [--finalize] [options]
  session-harbor reclaim [--apply] [--confirm-delete-local] [options]
  session-harbor cleanup [--session <id-or-path>] [--apply] [--confirm-delete-local] [options]
  session-harbor verify [options]
  session-harbor restore <session-id-or-path> [--apply] [--overwrite]
  session-harbor compress [--apply] [--force]

Safety:
  Every command is dry-run/read-only unless its documented applied form includes --apply.
  backup covers every local rollout incrementally and never reclaims local files by itself.
  cleanup/reclaim is separate, inactivity-based, and requires a verified backup. --finalize is the
  explicit compatibility override for early reclamation.

Options:
  --config <path>             Config JSON (default: ~/.config/session-harbor/config.json)
  --codex-home <path>         Override Codex data directory
  --destination <path>        Override archive destination
  --device-id <id>            Stable lowercase device ID (generated on applied init if omitted)
  --device-name <name>        Human-readable device name
  --platform <platform>       macos | windows | linux
  --roots <a,b>               Source roots (default: sessions,archived_sessions)
  --eligible-only             Sync only sessions passing the age and size policy
  --allow-partial             Publish a snapshot despite separately reported inventory errors
  --peer <device-id>          Select one peer device
  --include-objects           Cache verified raw peer objects for offline export
  --publish                   Add verified session snapshot publication to a policy run
  --reclaim                   Add grace-respecting local reclamation to a policy run
  --output <path>             Explicit export destination
  --project <project-id>      Portable project ID for project memory
  --input <path>              JSON input for a private memory draft
  --source <path>             Read-only legacy migration source
  --session <id-or-path>      Restrict cleanup to exactly one local session
  --state <filter>            Dashboard: all | backed | unbacked | changed | deleted | linked |
                              restored | cleanup-ready | waiting-inactivity | waiting-backup-age
  --limit <n|all>             Dashboard result limit (default: 50; 0/all means unlimited)
  --include-restricted        Explicitly include restricted reviewed entries
  --cleanup-after-inactive-days <n>  Minimum idle age for local cleanup (default: 30)
  --older-than-days <n>       Legacy alias for cleanup inactivity age
  --archive-after-days <n>    Legacy alias for cleanup inactivity age
  --minimum-size-mb <n>       Minimum file size (default: 5)
  --minimum-backup-age-days <n>  Safety wait after the latest verified backup (default: 7)
  --grace-days <n>            Legacy alias for minimum backup age
  --local-grace-days <n>      Legacy alias for minimum backup age
  --reclaim-action <mode>     keep | link | delete
  --auto-reclaim              Allow an explicitly installed scheduler to run reclaim
  --verify-existing-objects   Full-hash existing objects during normal backups
  --auto-publish              Publish exchange snapshots when explicitly scheduled
  --compression <mode>        none | codex-slim
  --compression-level <1-22>  codex-slim zstd level (default: 19)
  --mode <mode>               Legacy alias: linked | copy-only | delete
  --json                      Machine-readable output
  --apply                     Authorize this command's filesystem changes
  --finalize                  Finalize verified copies before grace expires
  --confirm-delete-local      Required with --apply when reclaimAction is delete
  --overwrite                 Allow restore to replace a conflicting local file
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const code = error instanceof ColdStorageError ? error.code : "UNEXPECTED_ERROR";
      console.error(`${code}: ${error.message}`);
      if (error?.details) console.error(JSON.stringify(error.details, null, 2));
      process.exitCode = 1;
    });
}
