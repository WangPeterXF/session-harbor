import {
  backupSessions,
  ColdStorageError,
  reclaimSessions,
} from "./archive-core.mjs";
import {
  inventoryCatalogSessions,
  planSessionPush,
  pushSessionSnapshot,
} from "./session-snapshot.mjs";

export async function runRetentionPolicy(config, options = {}) {
  const apply = Boolean(options.apply);
  const publish = Boolean(options.publish);
  const reclaim = Boolean(options.reclaim);
  if (options.confirmDeleteLocal && !reclaim) {
    throw new ColdStorageError(
      "DELETE_CONFIRMATION_WITHOUT_RECLAIM",
      "--confirm-delete-local is valid only together with --reclaim.",
    );
  }

  const archive = await backupSessions(config, {
    apply,
    now: options.now,
    nowMs: options.nowMs,
    skipOpenCheck: options.skipOpenCheck,
  });
  const sync = publish
    ? apply
      ? await pushSessionSnapshot(config, {
          apply: true,
          inventoryOverride: await inventoryCatalogSessions(config),
          now: options.now,
          failOnInventoryError: !config.backup.allowPartial,
        })
      : await planSessionPush(config, {
          now: options.now,
          nowMs: options.nowMs,
          failOnInventoryError: !config.backup.allowPartial,
        })
    : null;
  const localReclaim = reclaim
    ? await reclaimSessions(config, {
        apply,
        now: options.now,
        nowMs: options.nowMs,
        skipOpenCheck: options.skipOpenCheck,
        confirmDeleteLocal: Boolean(options.confirmDeleteLocal),
      })
    : null;

  return {
    ok:
      archive.errors.length === 0 &&
      (!localReclaim || localReclaim.errors.length === 0) &&
      (!sync || sync.ok !== false),
    action: apply ? "policy-run" : "policy-plan",
    apply,
    scopes: { archive: true, publish, reclaim },
    retention: { ...config.retention },
    archive,
    sync,
    reclaim: localReclaim,
  };
}
