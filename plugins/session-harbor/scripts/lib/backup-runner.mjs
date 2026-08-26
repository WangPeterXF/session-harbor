import { backupSessions } from "./archive-core.mjs";
import {
  inventoryCatalogSessions,
  planSessionPush,
  pushSessionSnapshot,
} from "./session-snapshot.mjs";

export async function runBackup(config, options = {}) {
  const apply = Boolean(options.apply);
  const backup = await backupSessions(config, {
    apply,
    now: options.now,
    nowMs: options.nowMs,
    skipOpenCheck: options.skipOpenCheck,
    onProgress: options.onProgress,
  });
  if (typeof options.afterBackup === "function") await options.afterBackup(backup);
  if (typeof options.onProgress === "function") {
    await options.onProgress({
      stage: "publish",
      status: "running",
      processed: backup.candidates,
      total: backup.candidates,
      copied: backup.copied,
      skipped: backup.skipped,
      errors: backup.errors.length,
    });
  }
  const syncOptions = {
    now: options.now,
    nowMs: options.nowMs,
    failOnInventoryError: !config.backup.allowPartial,
    operation: "backup",
    verifyExistingObjects: config.backup.verifyExistingObjects,
    ...(apply
      ? {
          inventoryOverride: await inventoryCatalogSessions(config, {
            verifyObjects: config.backup.verifyExistingObjects,
          }),
        }
      : {}),
  };
  const sync = apply
    ? await pushSessionSnapshot(config, { ...syncOptions, apply: true })
    : await planSessionPush(config, syncOptions);
  const inventoryErrors = sync.errors || [];
  return {
    ok: backup.errors.length === 0 && inventoryErrors.length === 0,
    complete: backup.errors.length === 0 && inventoryErrors.length === 0,
    action: apply ? "backup" : "backup-plan",
    apply,
    scope: "all",
    backup,
    sync,
  };
}
