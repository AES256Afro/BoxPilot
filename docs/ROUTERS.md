# Router checkpoint center

BoxPilot `0.23.0` adds recovery-checkpoint metadata for the three devices already represented in its topology catalog:

- GL.iNet Flint 2
- Omada ER707-M2
- TP-Link Archer BE400

This is the first router integration gate. It does not log in to a router, accept credentials, call a vendor API, upload a configuration, discover firmware, change a setting, advertise DNS, or perform a restore.

## Record a checkpoint

1. Export the router configuration from the vendor interface.
2. Store the original file somewhere that does not depend on Bigbox or that router.
3. Open **Routers** in BoxPilot.
4. Choose the fixed model declaration and enter the firmware version shown by the router.
5. Select the exported configuration file. Files must be between 64 bytes and 64 MiB.
6. Confirm that the original file is retained outside BoxPilot.
7. Select **Hash locally and record metadata**.

The browser reads the file and computes SHA-256 with Web Crypto. It sends only:

- Fixed model id
- Operator-entered firmware version
- Lowercase SHA-256 digest
- Byte count
- Confirmation that the original remains outside BoxPilot

The filename, configuration bytes, password, router address, cookies, tokens, and settings are not included in the request. BoxPilot stores the metadata, owner attribution, and server receipt time in SQLite. The selected file remains on the browser device.

## Evidence boundary

This is operator-attributable evidence, not remote attestation. An authenticated client could submit a digest without using the displayed file control, so the server does not claim it independently observed the hashing operation. The record proves only that BoxPilot retained a specific checksum declaration at a specific time.

It also does not prove:

- The file is complete or decryptable
- The firmware version is accurate
- The file belongs to the selected model
- The router can restore the file
- A restore would preserve the current network path
- The file is still available outside BoxPilot

Keep the original file and vendor recovery instructions together. A future router-write adapter must require a fresh checkpoint and separately test restore or rollback behavior.

## Why configuration files are not uploaded

Router backups may contain wireless credentials, VPN keys, DNS settings, device names, account material, and network topology. Version `0.23.0` deliberately avoids making BoxPilot a vault for that data. Secret storage, encryption-at-rest, export controls, and vendor-specific sanitization must exist before any later release considers ingesting a configuration.

## Future Flint 2 integration gate

A safe Flint 2 adapter still needs:

1. Exact model and firmware compatibility declarations
2. Read-only discovery with a dedicated least-privilege credential if the platform supports one
3. Credential encryption separate from ordinary SQLite job records
4. A bounded configuration diff that cannot contain a command or arbitrary path
5. Owner-password approval immediately before apply
6. An independent Tailscale or console recovery path
7. Post-change Bigbox and signed second-device DNS evidence
8. A timed observation window
9. One tested rollback operation tied to the exact checkpoint

The same gates apply to an ER707-M2 adapter. The TP-Link BE400 should remain an access point in the recommended Flint 2 topology, so its future adapter should prioritize mode and management-plane verification rather than edge-router DNS mutation.
