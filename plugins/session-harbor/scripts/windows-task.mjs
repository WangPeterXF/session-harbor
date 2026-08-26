#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { loadConfig } from "./lib/archive-core.mjs";
import { policyArguments } from "./launchagent.mjs";

const execFileAsync = promisify(execFile);
export const WINDOWS_TASK_NAME = "SessionHarbor Backup";
const LEGACY_WINDOWS_TASK_NAME = "SessionHarbor Daily Retention";

export function renderWindowsTask({
  nodePath,
  cliPath,
  configPath,
  hour = 3,
  minute = 30,
  weekday = 1,
  onMount = true,
  weekly = true,
  pollMinutes = 15,
  publish = false,
  reclaim = false,
  confirmDeleteLocal = false,
}) {
  const [command, ...args] = policyArguments({
    nodePath,
    cliPath,
    configPath,
    publish,
    reclaim,
    confirmDeleteLocal,
  });
  const start = `2026-01-01T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  const triggers = [
    weekly
      ? `    <CalendarTrigger>\n      <StartBoundary>${start}</StartBoundary>\n      <Enabled>true</Enabled>\n      <ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><${windowsWeekday(weekday)}/></DaysOfWeek></ScheduleByWeek>\n    </CalendarTrigger>`
      : "",
    onMount
      ? `    <TimeTrigger>\n      <StartBoundary>2026-01-01T00:00:00</StartBoundary>\n      <Enabled>true</Enabled>\n      <Repetition><Interval>PT${pollMinutes}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>\n    </TimeTrigger>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>SessionHarbor all-session incremental backup and optional verified local cleanup.</Description></RegistrationInfo>
  <Triggers>
${triggers}
  </Triggers>
  <Principals>
    <Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT4H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(command)}</Command>
      <Arguments>${xml(args.map(quoteWindowsArgument).join(" "))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export async function writeWindowsTaskXml(xmlPath, xmlText) {
  const bom = Buffer.from([0xff, 0xfe]);
  const encoded = Buffer.from(xmlText, "utf16le");
  await writeFile(xmlPath, Buffer.concat([bom, encoded]), { mode: 0o600 });
}

export async function main(argv = process.argv.slice(2), io = console) {
  const command = argv[0] || "help";
  const options = parseOptions(argv.slice(1));
  if (command === "render" || command === "install") {
    if (!options.config) throw new Error(`${command} requires --config <path>.`);
    const configPath = path.resolve(expandHome(options.config));
    const config = await loadConfig(configPath);
    const hour = parseClock(options.hour ?? "3", 0, 23, "hour");
    const minute = parseClock(options.minute ?? "30", 0, 59, "minute");
    const weekday = parseClock(options.weekday ?? "1", 0, 7, "weekday");
    const pollMinutes = parseClock(options["poll-minutes"] ?? "15", 1, 1440, "poll-minutes");
    const onMount = options["no-on-mount"] ? false : true;
    const weekly = options["no-weekly"] ? false : true;
    if (!onMount && !weekly) {
      throw new Error("At least one trigger is required; use the CLI directly for manual-only mode.");
    }
    const publish = options.publish ?? config.exchange.autoPublish;
    const reclaim = options.reclaim ?? config.retention.autoReclaim;
    if (reclaim && config.retention.reclaimAction === "delete" && !options["confirm-delete-local"]) {
      throw new Error(
        "A delete scheduler requires --confirm-delete-local in addition to retention.autoReclaim.",
      );
    }
    const cliPath = fileURLToPath(new URL("./session-harbor.mjs", import.meta.url));
    const xmlText = renderWindowsTask({
      nodePath: process.execPath,
      cliPath,
      configPath,
      hour,
      minute,
      weekday,
      onMount,
      weekly,
      pollMinutes,
      publish,
      reclaim,
      confirmDeleteLocal: Boolean(options["confirm-delete-local"]),
    });
    if (command === "render" || !options.apply) {
      io.log(xmlText);
      if (command === "install") io.log(`Dry-run: would install Windows task "${WINDOWS_TASK_NAME}".`);
      return 0;
    }
    if (process.platform !== "win32") {
      throw new Error("Windows Task Scheduler installation is available only on Windows.");
    }
    const taskDir = path.join(path.dirname(configPath), "scheduler");
    const xmlPath = path.join(taskDir, "session-harbor-task.xml");
    await mkdir(taskDir, { recursive: true, mode: 0o700 });
    await writeWindowsTaskXml(xmlPath, xmlText);
    await ignoreFailure(() =>
      execFileAsync("schtasks.exe", ["/Delete", "/TN", LEGACY_WINDOWS_TASK_NAME, "/F"]),
    );
    await execFileAsync("schtasks.exe", ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", xmlPath, "/F"]);
    io.log(`Installed Windows task "${WINDOWS_TASK_NAME}".`);
    return 0;
  }

  if (command === "uninstall") {
    if (!options.apply) {
      io.log(`Dry-run: would remove Windows task "${WINDOWS_TASK_NAME}".`);
      return 0;
    }
    if (process.platform !== "win32") {
      throw new Error("Windows Task Scheduler removal is available only on Windows.");
    }
    await ignoreFailure(() =>
      execFileAsync("schtasks.exe", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]),
    );
    await ignoreFailure(() =>
      execFileAsync("schtasks.exe", ["/Delete", "/TN", LEGACY_WINDOWS_TASK_NAME, "/F"]),
    );
    return 0;
  }

  io.log(`Usage:
  node windows-task.mjs render --config <path> [--weekday 1] [--hour 3] [--minute 30]
    [--poll-minutes 15] [--no-on-mount] [--no-weekly]
  node windows-task.mjs install --config <path> [--publish] [--reclaim]
    [--confirm-delete-local] [--apply]
  node windows-task.mjs uninstall [--apply]

Without --apply, install and uninstall are dry-runs.`);
  return 0;
}

function parseOptions(argv) {
  const options = {};
  const booleans = new Set([
    "apply",
    "publish",
    "reclaim",
    "confirm-delete-local",
    "no-on-mount",
    "no-weekly",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (booleans.has(key)) options[key] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value.`);
      options[key] = value;
    }
  }
  return options;
}

function quoteWindowsArgument(value) {
  const string = String(value);
  if (!/[\s"]/.test(string)) return string;
  return `"${string.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

function parseClock(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function windowsWeekday(value) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
    Number(value) === 7 ? 0 : Number(value)
  ];
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
    // Removal is idempotent when the current or legacy task is absent.
  }
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
