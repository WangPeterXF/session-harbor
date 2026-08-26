#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { loadConfig } from "./lib/archive-core.mjs";

const execFileAsync = promisify(execFile);
export const LAUNCH_AGENT_LABEL = "io.github.xiaofanwang.session-harbor.archive";

export function renderLaunchAgent({
  nodePath,
  cliPath,
  configPath,
  hour = 3,
  minute = 30,
  weekday = 1,
  onMount = true,
  weekly = true,
  publish = false,
  reclaim = false,
  confirmDeleteLocal = false,
}) {
  const logPath = path.join(os.homedir(), "Library", "Logs", `${LAUNCH_AGENT_LABEL}.log`);
  const argumentsXml = policyArguments({
    nodePath,
    cliPath,
    configPath,
    publish,
    reclaim,
    confirmDeleteLocal,
  })
    .map((value) => `    <string>${xml(value)}</string>`)
    .join("\n");
  const triggersXml = [
    onMount ? "  <key>StartOnMount</key><true/>" : "",
    weekly
      ? `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Weekday</key><integer>${weekday}</integer>\n    <key>Hour</key><integer>${hour}</integer>\n    <key>Minute</key><integer>${minute}</integer>\n  </dict>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LAUNCH_AGENT_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
${triggersXml}
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

export async function main(argv = process.argv.slice(2), io = console) {
  if (process.platform !== "darwin") {
    throw new Error("LaunchAgent installation is available only on macOS.");
  }
  const command = argv[0] || "help";
  const options = parseOptions(argv.slice(1));
  const plistPath = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${LAUNCH_AGENT_LABEL}.plist`,
  );
  const domain = `gui/${process.getuid()}`;

  if (command === "install") {
    if (!options.config) throw new Error("install requires --config <path>.");
    const configPath = path.resolve(expandHome(options.config));
    const config = await loadConfig(configPath);
    const hour = parseClock(options.hour ?? "3", 0, 23, "hour");
    const minute = parseClock(options.minute ?? "30", 0, 59, "minute");
    const weekday = parseClock(options.weekday ?? "1", 0, 7, "weekday");
    const onMount = options["no-on-mount"] ? false : true;
    const weekly = options["no-weekly"] ? false : true;
    if (!onMount && !weekly) {
      throw new Error("At least one trigger is required; use the CLI directly for manual-only mode.");
    }
    const cliPath = fileURLToPath(new URL("./session-harbor.mjs", import.meta.url));
    const plist = renderLaunchAgent({
      nodePath: process.execPath,
      cliPath,
      configPath,
      hour,
      minute,
      weekday,
      onMount,
      weekly,
      publish: options.publish ?? config.exchange.autoPublish,
      reclaim: options.reclaim ?? config.retention.autoReclaim,
      confirmDeleteLocal: Boolean(options["confirm-delete-local"]),
    });
    if (
      (options.reclaim ?? config.retention.autoReclaim) &&
      config.retention.reclaimAction === "delete" &&
      !options["confirm-delete-local"]
    ) {
      throw new Error(
        "A delete scheduler requires --confirm-delete-local in addition to retention.autoReclaim.",
      );
    }
    if (!options.apply) {
      io.log(plist);
      io.log(`Dry-run: would install ${plistPath}`);
      return 0;
    }
    await mkdir(path.dirname(plistPath), { recursive: true, mode: 0o700 });
    await mkdir(path.join(os.homedir(), "Library", "Logs"), { recursive: true });
    await writeFile(plistPath, plist, { encoding: "utf8", mode: 0o600 });
    await ignoreFailure(() => execFileAsync("launchctl", ["bootout", domain, plistPath]));
    await execFileAsync("launchctl", ["bootstrap", domain, plistPath]);
    io.log(`Installed ${LAUNCH_AGENT_LABEL} at ${plistPath}`);
    return 0;
  }

  if (command === "uninstall") {
    if (!options.apply) {
      io.log(`Dry-run: would unload and remove ${plistPath}`);
      return 0;
    }
    await ignoreFailure(() => execFileAsync("launchctl", ["bootout", domain, plistPath]));
    await rm(plistPath, { force: true });
    io.log(`Removed ${LAUNCH_AGENT_LABEL}`);
    return 0;
  }

  io.log(`Usage:
  node launchagent.mjs install --config <path> [--weekday 1] [--hour 3] [--minute 30]
    [--no-on-mount] [--no-weekly]
    [--publish] [--reclaim] [--confirm-delete-local] [--apply]
  node launchagent.mjs uninstall [--apply]

Without --apply, both commands are dry-runs.`);
  return 0;
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (
      new Set([
        "apply",
        "publish",
        "reclaim",
        "confirm-delete-local",
        "no-on-mount",
        "no-weekly",
      ]).has(key)
    ) {
      options[key] = true;
    }
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value.`);
      options[key] = value;
    }
  }
  return options;
}

function parseClock(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function ignoreFailure(action) {
  try {
    await action();
  } catch {
    // bootout reports an error when the service is not loaded; this is idempotent.
  }
}

export function policyArguments({
  nodePath,
  cliPath,
  configPath,
  publish = false,
  reclaim = false,
  confirmDeleteLocal = false,
}) {
  const args = reclaim
    ? [nodePath, cliPath, "policy", "run", "--apply", "--publish", "--reclaim", "--config", configPath]
    : [nodePath, cliPath, "backup", "run", "--apply", "--if-available", "--config", configPath];
  if (publish && reclaim && !args.includes("--publish")) args.push("--publish");
  if (confirmDeleteLocal && reclaim) args.push("--confirm-delete-local");
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
