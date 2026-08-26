import { ColdStorageError, normalizeConfig, saveConfig } from "./archive-core.mjs";

export function settingsView(config) {
  return {
    backup: { ...config.backup },
    retention: { ...config.retention },
    exchange: { ...config.exchange },
  };
}

export async function updateSettings(configPath, config, changes, options = {}) {
  const nextInput = {
    ...config,
    backup: { ...config.backup },
    retention: { ...config.retention },
    exchange: { ...config.exchange },
  };
  delete nextInput.olderThanDays;
  delete nextInput.graceDays;
  delete nextInput.mode;
  delete nextInput.autoReclaim;
  let changed = false;
  for (const [key, value] of Object.entries(changes.retention || {})) {
    if (value === undefined) continue;
    nextInput.retention[key] = value;
    changed = true;
  }
  for (const [key, value] of Object.entries(changes.backup || {})) {
    if (value === undefined) continue;
    nextInput.backup[key] = value;
    changed = true;
  }
  for (const [key, value] of Object.entries(changes.exchange || {})) {
    if (value === undefined) continue;
    nextInput.exchange[key] = value;
    changed = true;
  }
  if (!changed) {
    throw new ColdStorageError(
      "SETTINGS_CHANGE_REQUIRED",
      "settings set requires at least one supported setting option.",
    );
  }
  const normalized = normalizeConfig(nextInput);
  const result = {
    ok: true,
    action: "settings-update",
    apply: Boolean(options.apply),
    before: settingsView(config),
    after: settingsView(normalized),
  };
  if (options.apply) await saveConfig(configPath, normalized);
  return result;
}
