import { createHash } from "node:crypto";

export const keelInstallPaths = Object.freeze({
  root: "/var/lib/boxpilot-managed/apps/keel",
  release: "/var/lib/boxpilot-managed/apps/keel/releases/1.2.6",
  current: "/var/lib/boxpilot-managed/apps/keel/current",
  evidence: "/var/lib/boxpilot-managed/apps/keel/.boxpilot-install.json",
  approval: "/run/boxpilot/keel-install-approval.json",
  state: "/var/lib/keel",
  environment: "/var/lib/keel/.env",
  database: "/var/lib/keel/keel.db",
  managedSecretKey: "/var/lib/keel/.keel-server-secrets.key",
  uploads: "/var/lib/keel/uploads",
  backups: "/var/lib/keel/backups",
  unit: "/etc/systemd/system/keel.service",
});

export const keelServiceIdentity = Object.freeze({
  account: "keel",
  group: "keel",
  unitName: "keel.service",
  nodeBinary: "/usr/local/bin/node",
  port: 3000,
  bindAddress: "127.0.0.1",
  releaseVersion: "1.2.6",
});

export function keelEnvironmentContent() {
  return [
    "# Managed by BoxPilot. Keep registration private until terminal claim is complete.",
    "DATABASE_URL=file:/var/lib/keel/keel.db",
    "PORT=3000",
    "HOST=127.0.0.1",
    "HOSTNAME=127.0.0.1",
    "NOPIN_UPLOAD_DIR=/var/lib/keel/uploads",
    "KEEL_BACKUP_DIR=/var/lib/keel/backups",
    "KEEL_CLAIM_REQUIRED=1",
    "KEEL_SUPERVISED=1",
    "KEEL_PUBLIC_URL=http://127.0.0.1:3000",
    "",
  ].join("\n");
}

export function keelServiceUnitContent() {
  return `[Unit]
Description=Keel Notes private workspace
Documentation=https://github.com/AES256Afro/Keel
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=keel
Group=keel
WorkingDirectory=/var/lib/boxpilot-managed/apps/keel/current
Environment=KEEL_HOME=/var/lib/keel
EnvironmentFile=/var/lib/keel/.env
ExecStart=/usr/local/bin/node /var/lib/boxpilot-managed/apps/keel/current/bin/keel.mjs start --foreground --port 3000
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
UMask=0077

CapabilityBoundingSet=
LockPersonality=true
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectClock=true
ProtectControlGroups=true
ProtectHome=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectSystem=strict
ReadOnlyPaths=/var/lib/boxpilot-managed/apps/keel
ReadWritePaths=/var/lib/keel
RemoveIPC=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictRealtime=true
RestrictSUIDSGID=true
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
`;
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export const keelServiceUnitSha256 = sha256Text(keelServiceUnitContent());
export const keelEnvironmentSha256 = sha256Text(keelEnvironmentContent());
