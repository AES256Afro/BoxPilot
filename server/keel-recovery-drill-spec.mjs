import path from "node:path";
import { validUuid } from "./keel-artifact-spec.mjs";

export const keelRecoveryDrillPaths = Object.freeze({
  root: "/var/lib/boxpilot-managed/keel-recovery-drills",
  approval: "/run/boxpilot/keel-recovery-drill-approval.json",
});

export const keelRecoveryDrillIdentity = Object.freeze({
  schemaVersion: 1,
  applicationId: "keel",
  releaseVersion: "1.2.6",
  port: 3100,
  bindAddress: "127.0.0.1",
  network: "private-loopback-only",
  unitName: "boxpilot-keel-recovery-drill.service",
});

export function pathsForKeelRecoveryDrill(drillId, paths = keelRecoveryDrillPaths) {
  if (!validUuid(drillId)) throw new Error("Keel recovery drill id must be a UUID");
  const root = path.resolve(paths.root);
  const partial = path.join(root, `.${drillId}.partial`);
  const result = path.join(root, `${drillId}.result.json`);
  if (path.dirname(partial) !== root || path.dirname(result) !== root) throw new Error("Keel recovery drill paths escaped their fixed root");
  return { root, partial, state: path.join(partial, "state"), result };
}

export function keelRecoveryDrillEnvironment(statePath) {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    KEEL_HOME: statePath,
    KEEL_ENV_FILE: path.join(statePath, ".env"),
    DATABASE_URL: `file:${path.join(statePath, "keel.db")}`,
    PORT: String(keelRecoveryDrillIdentity.port),
    HOST: keelRecoveryDrillIdentity.bindAddress,
    HOSTNAME: keelRecoveryDrillIdentity.bindAddress,
    NOPIN_UPLOAD_DIR: path.join(statePath, "uploads"),
    KEEL_BACKUP_DIR: path.join(statePath, "backups"),
    KEEL_CLAIM_REQUIRED: "1",
    KEEL_SUPERVISED: "1",
    KEEL_PUBLIC_URL: `http://${keelRecoveryDrillIdentity.bindAddress}:${keelRecoveryDrillIdentity.port}`,
  };
}
