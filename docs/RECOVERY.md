# Disaster recovery readiness kit

BoxPilot `0.26.0` adds an authenticated read-only recovery kit to Repair Center. It answers two questions before an outage becomes an emergency:

1. Which recovery claims are supported by current BoxPilot evidence?
2. Which independent items must the operator still keep outside the server?

The kit is available from `GET /api/v1/operations/recovery-kit` after owner authentication. The browser can download the structured response as JSON or the included ordered runbook as Markdown. Generation performs no write and requires no privileged helper mutation.

## Evidence correlated by the kit

The service reads and sanitizes:

- Recent durable job identity, type, risk, state, and creation time
- Managed application installed state and restore-verified backup state
- Application backup checksum, size, downtime, destination class, and restore result
- Libvirt domain name, state, and autostart plus retained protected VM backup evidence
- Encrypted independent VM-copy identity, repository reference, snapshot reference, size, repository check, and isolated restore result
- Router model, firmware, browser-reported checksum, size, and external-file retention assertion
- Verified migration transfer size, file count, source-preservation, and no-activation evidence
- Fleet agent counts and passing signed evidence counts
- Passing direct server-side DNS acceptance counts
- Fixed prerequisite status, summary, and guided repair description

It turns those observations into eight explicit checks:

1. Independent BoxPilot database copy
2. Exact BoxPilot source and install notes
3. Managed application recovery
4. Virtual-machine recovery
5. Router configuration checkpoint
6. Migration source preservation
7. Independent DNS proof
8. Host prerequisite review

Check states are `verified`, `action-required`, `operator-check`, `not-applicable`, or `unavailable`. Feature-specific prerequisite warnings are not automatically described as whole-server failure.

## Ordered recovery sequence

The Markdown runbook always preserves this order:

1. Stabilize the host through local console and filesystem checks.
2. Restore Tailscale and loopback-only BoxPilot access with Funnel off.
3. Restore an independently held BoxPilot SQLite copy only while the web service is stopped, then verify integrity and ownership.
4. Run Repair Center and live inventory before any mutation.
5. Restore applications only with adapter-aware artifacts and isolated tests.
6. Restore VMs only from exact protected snapshots into stopped no-network clones.
7. Re-establish DNS only after direct server-side and signed second-device proof while the independent resolver remains active.
8. Verify health and rollback, regenerate the kit, and store it outside the server.

The kit does not execute these instructions. It supplies an ordering contract to reduce improvised recovery changes.

## Deliberately excluded

The JSON and Markdown omit:

- Owner names and password hashes
- Sessions and CSRF tokens
- Agent public keys and request signatures
- Application databases, uploads, secrets, and backup payloads
- Backup artifact paths
- Router configuration bytes
- Arbitrary logs and environment values

The route also never reads a router file, application backup archive, restic repository payload, password file, Keel workspace, or BoxPilot database copy into the response.

## External items the operator must maintain

BoxPilot cannot prove items that must survive outside its own failure domain:

- A consistent independent copy of `/var/lib/boxpilot/boxpilot.sqlite3`, with checksum and restore notes
- The exact BoxPilot source archive and file manifest used for the installation
- Original router configuration files matching checkpoint hashes
- The restic password and recovery media stored separately from the restic repository
- Tailscale account recovery access and a physical or local-console path
- Application credentials and encryption keys stored outside recovery-kit exports

The first two controller checks therefore remain `operator-check` until a future external destination and attestation design exists. The recovery kit must never call itself a backup.

## Recovery readiness does not grant mutation authority

The kit adds no helper operation, shell command, path parameter, credential input, scheduler, restore executor, router session, DNS change, or application installer. Existing high-impact workflows still require immutable plans, password approval, typed operations, and post-change verification. A green evidence check does not bypass those controls.
