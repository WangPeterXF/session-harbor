import path from "node:path";

import { ColdStorageError, normalizeConfig, saveConfig } from "./archive-core.mjs";

export function listProjects(config) {
  return {
    ok: true,
    action: "project-list",
    projects: Object.entries(config.projects)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, localPath]) => ({ projectId, localPath })),
  };
}

export async function mapProject(configPath, config, projectId, localPath, options = {}) {
  if (!projectId || !localPath) {
    throw new ColdStorageError(
      "PROJECT_MAP_ARGUMENT_REQUIRED",
      "Project mapping requires a portable project ID and an absolute local path.",
    );
  }
  const resolved = path.resolve(localPath);
  const next = normalizeConfig({
    ...config,
    projects: { ...config.projects, [projectId]: resolved },
  });
  const result = {
    ok: true,
    action: "project-map",
    apply: false,
    projectId,
    localPath: next.projects[projectId],
    replaced: Object.hasOwn(config.projects, projectId),
  };
  if (!options.apply) return result;
  await saveConfig(configPath, next);
  return { ...result, apply: true };
}
