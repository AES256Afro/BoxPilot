import { access, readFile } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { cloudProviderIds, cloudProviders, validateCloudDestination } from "../backup-cloud.mjs";

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
  key: { type: "string", optional: true, nullable: true, maxLength: 512, secret: true },
  secretAccessKey: { type: "string", optional: true, nullable: true, maxLength: 512, secret: true },
  password: { type: "string", optional: true, nullable: true, maxLength: 512, secret: true },
  token: { type: "string", optional: true, nullable: true, maxLength: 8192, secret: true },
};
const pick = (parameters) => Object.fromEntries(Object.entries(parameters).filter(([key, value]) => key in destinationFields && value !== null && value !== undefined && value !== ""));
const validate = (parameters) => { const errors = validateCloudDestination(pick(parameters)); return errors.length ? errors.join("; ") : null; };

/** Cloud backup destination through rclone: setup (secrets in memory only), test, mirror. */
export function backupCloudOperations() {
  return [
    defineOperation({
      id: "backup.cloud.inspect", title: "Read the cloud backup destination state", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "Whether rclone is installed and a destination has been saved (provider only; secrets are never read back).",
      run: async () => {
        const rcloneInstalled = await access("/usr/bin/rclone").then(() => true, () => false);
        const config = await readFile(`${secretsDirectory()}/rclone.conf`, "utf8").catch(() => null);
        const provider = config?.match(/^type = (\S+)$/m)?.[1] ?? null;
        return { rcloneInstalled, configured: Boolean(config), provider, providers: Object.fromEntries(Object.entries(cloudProviders).map(([id, entry]) => [id, { label: entry.label, fields: entry.fields, secrets: entry.secrets, help: entry.help }])) };
      },
    }),
    defineOperation({
      id: "backup.cloud.setup", title: "Save the cloud backup destination", risk: "medium", timeoutMs: minutes(2),
      description: "Writes the rclone configuration for the destination under /etc/boxpilot/secrets (root only). Keys and tokens are kept in memory until this job runs and are never stored in the database.",
      parameters: { fields: { ...destinationFields, ...secretFields, provider: { ...destinationFields.provider, validate: (_value, parameters) => validate(parameters) } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("backup.cloud.setup", parameters, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "backup.cloud.test", title: "Test the cloud backup destination", risk: "medium", timeoutMs: minutes(5),
      description: "Creates the destination folder and lists it with the saved credentials; reports free space when the provider tells.",
      parameters: { fields: { ...destinationFields, provider: { ...destinationFields.provider, validate: (_value, parameters) => validate(parameters) } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("backup.cloud.test", pick(parameters), { timeoutMs: minutes(4), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "backup.cloud.sync", title: "Mirror local backups to the cloud destination", risk: "medium", timeoutMs: 6 * 60 * 60_000,
      description: "rclone copies the controller backups, application backups, and machine snapshots to the destination with checksum verification. Nothing is ever deleted there.",
      parameters: { fields: { ...destinationFields, provider: { ...destinationFields.provider, validate: (_value, parameters) => validate(parameters) } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("backup.cloud.sync", pick(parameters), { timeoutMs: 6 * 60 * 60_000 - 60_000, logPath: jobLog?.path ?? null }),
    }),
  ];
}
