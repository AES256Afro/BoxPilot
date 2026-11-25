import { access, readFile } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { cloudProviderIds, cloudProviders, isSealedConfig, minimumPassphraseLength, validateCloudDestination } from "../backup-cloud.mjs";
import { snapshotNamePattern } from "../machine-snapshot-helper.mjs";

const minutes = (value) => value * 60_000;
const secretsDirectory = () => process.env.BOXPILOT_SECRETS_DIRECTORY ?? "/etc/boxpilot/secrets";
const text = (pattern, extra = {}) => ({ type: "string", optional: true, nullable: true, maxLength: 300, pattern, ...extra });
const destinationFields = {
  provider: { type: "string", enum: [...cloudProviderIds] },
  account: text(/^[A-Za-z0-9_-]{1,64}$/),
  bucket: text(/^[a-z0-9][a-z0-9.-]{1,62}$/),
  path: text(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/),
  endpoint: text(/^https?:\/\/[^\s]{1,200}$/),
  region: text(/^[a-z0-9-]{1,32}$/),
  accessKeyId: text(/^[A-Za-z0-9_-]{1,128}$/),
  url: text(/^https:\/\/[^\s]{1,300}$/),
  user: text(/^[^\s:]{1,128}$/),
};
const secretFields = {
  key: { type: "string", optional: true, nullable: true, maxLength: 512, pattern: /^[^\r\n]+$/, secret: true },
  secretAccessKey: { type: "string", optional: true, nullable: true, maxLength: 512, pattern: /^[^\r\n]+$/, secret: true },
  password: { type: "string", optional: true, nullable: true, maxLength: 512, pattern: /^[^\r\n]+$/, secret: true },
  token: { type: "string", optional: true, nullable: true, maxLength: 8192, secret: true },
  // Encrypts every copy before it leaves the server (rclone crypt); required by the task, which says why.
  passphrase: { type: "string", optional: true, nullable: true, maxLength: 1024, pattern: new RegExp(`^[^\\r\\n]{${minimumPassphraseLength},}$`), secret: true },
};
const pick = (parameters) => Object.fromEntries(Object.entries(parameters).filter(([key, value]) => key in destinationFields && value !== null && value !== undefined && value !== ""));
const validate = (parameters) => { const errors = validateCloudDestination(pick(parameters)); return errors.length ? errors.join("; ") : null; };

/** Cloud backup destination through rclone: setup (secrets in memory only), test, mirror, and back again (list, fetch). */
export function backupCloudOperations() {
  return [
    defineOperation({
      id: "backup.cloud.inspect", title: "Read the cloud backup destination state", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "Whether rclone is installed, a destination has been saved and its copies are encrypted (provider only; secrets are never read back).",
      run: async () => {
        const rcloneInstalled = await access("/usr/bin/rclone").then(() => true, () => false);
        const config = await readFile(`${secretsDirectory()}/rclone.conf`, "utf8").catch(() => null);
        const provider = config?.match(/^type = (\S+)$/m)?.[1] ?? null;
        return { rcloneInstalled, configured: Boolean(config), sealed: isSealedConfig(config), provider, providers: Object.fromEntries(Object.entries(cloudProviders).map(([id, entry]) => [id, { label: entry.label, fields: entry.fields, secrets: entry.secrets, help: entry.help }])) };
      },
    }),
    defineOperation({
      id: "backup.cloud.setup", title: "Save the cloud backup destination", risk: "medium", minimumRole: "owner", timeoutMs: minutes(5),
      description: "Saves where the copies go and how to sign in there, in a file only root can read. Every copy is encrypted with your passphrase before it leaves. A key, password, token or passphrase left empty keeps the saved one. A folder that already holds encrypted copies keeps its passphrase: the newest copy there is opened with the one given first, and a passphrase that does not open it is refused. To change it, choose a new folder.",
      parameters: { fields: { ...destinationFields, ...secretFields, provider: { ...destinationFields.provider, validate: (_value, parameters) => validate(parameters) } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("backup.cloud.setup", parameters, { timeoutMs: minutes(4), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "backup.cloud.test", title: "Test the cloud backup destination", risk: "medium", minimumRole: "owner", timeoutMs: minutes(5),
      description: "Creates the destination folder and lists it with the saved credentials, writes a small marker through the encryption and reads it back, and opens the newest machine snapshot already there with the saved passphrase; reports free space when the provider tells.",
      parameters: { fields: { ...destinationFields, provider: { ...destinationFields.provider, validate: (_value, parameters) => validate(parameters) } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("backup.cloud.test", pick(parameters), { timeoutMs: minutes(4), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "backup.cloud.sync", title: "Mirror local backups to the cloud destination", risk: "medium", minimumRole: "owner", timeoutMs: 6 * 60 * 60_000,
      description: "Copies the database backups, application backups, and machine snapshots to the destination, encrypted with your passphrase before they leave. First opens the newest copy already there with the saved passphrase, and copies nothing when it does not open. A file already there is compared by size, since its contents are sealed. Refuses a destination saved without a passphrase. Nothing is ever deleted there. Afterwards the newest machine snapshot is downloaded back, decrypted and compared with the one here.",
      parameters: { fields: { ...destinationFields, provider: { ...destinationFields.provider, validate: (_value, parameters) => validate(parameters) } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("backup.cloud.sync", pick(parameters), { timeoutMs: 6 * 60 * 60_000 - 60_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      // operator (ADR-003): it runs as root with the owner's cloud credentials and lists what is in the bucket, which no
      // one could list without them; and it is a network round trip to the provider, the throughput case ADR-003 names.
      id: "backup.cloud.snapshots", title: "List the machine snapshots in the cloud", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: minutes(2),
      description: "Lists the machine snapshots in the cloud bucket, read through the encrypted remote with the saved passphrase, and which of them are already on this server. Nothing is downloaded.",
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("backup.cloud.snapshots", {}, { timeoutMs: 90_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      // medium, owner (M91): data comes onto the box rather than leaving it (ADR-015's high is for what leaves), and it
      // lands only as new files in BoxPilot's own snapshot and application backup stores under their fixed names, never
      // over one there, each checked against the checksum its sealed record names. Restoring is host.snapshot.restore,
      // high, on its own. Owner-only like every backup.cloud.* job: it uses the owner's credentials and passphrase.
      // As long as a mirror: it brings app data down, a photo library included.
      id: "backup.cloud.fetch", title: "Fetch a machine snapshot from the cloud", risk: "medium", minimumRole: "owner", timeoutMs: 6 * 60 * 60_000,
      description: "Downloads one machine snapshot and each of its apps' newest backup from the cloud bucket, decrypts them with the saved passphrase, checks each against the checksum recorded when it was taken, and puts them in this server's snapshot and app backup stores, where the Restore tab can restore them. Nothing is fetched unless all of it fits. A file already here is never replaced; run it again to fetch an app backup that failed.",
      parameters: { fields: { artifact: { type: "string", pattern: snapshotNamePattern } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("backup.cloud.fetch", { artifact: parameters.artifact }, { timeoutMs: 6 * 60 * 60_000 - 60_000, logPath: jobLog?.path ?? null }),
    }),
  ];
}
