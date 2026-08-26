import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function operationStatePaths(configPath) {
  const stateDirectory = path.join(path.dirname(configPath), "state");
  return {
    stateDirectory,
    currentPath: path.join(stateDirectory, "current-operation.json"),
    lastPath: path.join(stateDirectory, "last-operation.json"),
  };
}

export async function readOperationState(configPath, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const paths = operationStatePaths(configPath);
  const current = await readJsonIfPresent(paths.currentPath);
  const last = await readJsonIfPresent(paths.lastPath);
  const staleAfterMs = Number(options.staleAfterMs ?? 6 * 60 * 60 * 1000);
  const currentHeartbeatMs = current?.updatedAt ? Date.parse(current.updatedAt) : Number.NaN;
  const currentStale = Boolean(
    current &&
      (!Number.isFinite(currentHeartbeatMs) || nowMs - currentHeartbeatMs > staleAfterMs),
  );
  return { current, currentStale, last };
}

export function createOperationTracker(configPath, operation, options = {}) {
  const paths = operationStatePaths(configPath);
  const startedAt = options.startedAt || new Date().toISOString();
  const runId = options.runId || randomUUID();
  let latest = {
    version: 1,
    runId,
    operation,
    status: "running",
    stage: "starting",
    startedAt,
    updatedAt: startedAt,
    processed: 0,
    total: null,
  };

  return {
    runId,
    async start(extra = {}) {
      latest = { ...latest, ...extra, updatedAt: new Date().toISOString() };
      await atomicWriteJson(paths.currentPath, latest);
      return latest;
    },
    async progress(event = {}) {
      latest = {
        ...latest,
        ...event,
        status: "running",
        updatedAt: new Date().toISOString(),
      };
      await atomicWriteJson(paths.currentPath, latest);
      return latest;
    },
    async finish(status, extra = {}) {
      const completedAt = new Date().toISOString();
      latest = {
        ...latest,
        ...extra,
        status,
        updatedAt: completedAt,
        completedAt,
      };
      await atomicWriteJson(paths.lastPath, latest);
      await rm(paths.currentPath, { force: true });
      return latest;
    },
  };
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
