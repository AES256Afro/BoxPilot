# BoxPilot virtualization milestones

This plan turns the current QEMU/KVM module into a dependable home-server virtualization control plane. Milestones are dependency ordered. A later milestone cannot ship merely because its interface is complete.

## Current baseline: 0.12.0

Shipped:

- Live QEMU, KVM, libvirt, default network, default storage pool, and Tailscale preflight
- Live VM inventory with power state, CPU, memory, autostart, and lease-reported addresses
- Durable password-approved start, graceful shutdown, reboot request, and autostart jobs
- Fixed `virsh` argument arrays with no shell execution
- Loopback-only native service and private Tailscale Serve guidance
- Durable owner sessions, CSRF protection, immutable SQLite plans, password approvals, jobs, steps, and audit attribution
- Guarded Linux VM creation through the typed root helper with live revalidation, post-create verification, and exact-domain rollback
- Fixed helper lifecycle arguments with expected-state checks before and after execution
- Read-only libvirt, guest-agent, and snapshot inventory through the restricted helper
- No direct `libvirt` or `kvm` group access in the web service
- Durable offline internal snapshot creation for stopped VMs with unchained managed qcow2 disks
- Durable stopped-VM local export with standalone qcow2 conversion, structural checks, content comparison, SHA-256 evidence, confined cleanup, and honest unprotected status

Known boundary:

- AppArmor, Windows TPM/Secure Boot, cloud-init, console proxy, online snapshots, snapshot revert/delete, encrypted independent VM backup, isolated restore, restore execution, bridge management, passthrough, and fleet placement remain pending.
- The safe Docker preview cannot inspect host libvirt.

## Milestone V1: guided creation planning

Target: `0.3.0`

Status: shipped.

- New VM planning wizard for name, operating system, vCPU, memory, disk, install media, network, firmware, and autostart
- Server-side validation and host-capacity warnings
- Read-only ISO library discovery under a configured libvirt media directory
- Structured `virt-install` argument preview that is never executed by the planning route
- Richer VM detail inventory for disks, interfaces, and snapshot count

Acceptance:

- Invalid names, paths, numeric ranges, firmware, networks, and OS variants are rejected server-side.
- Planning cannot create a disk, define a domain, start a VM, or invoke `virt-install`.
- ISO discovery cannot traverse outside the configured media root and does not follow symlinks.
- Every validation rule has positive and negative tests.
- The interface clearly labels the plan as non-executing.

## Milestone V2: durable owner, jobs, and audit

Target: `0.4.0`

Status: redacted JSONL event foundation included in `0.3.0`; owner identity, SQLite jobs, approval reauthentication, and fail-closed interrupted-job handling are included in `0.4.0`. Migration of VM events into the durable executor and tamper evidence remain pending.

- Server-local owner bootstrap
- Password and WebAuthn-ready session model
- CSRF protection and short-lived approval reauthentication
- SQLite schema for plans, jobs, job steps, approvals, and audit events
- Restart-safe lifecycle jobs with current-state preconditions
- Redacted journal and support-bundle export

Acceptance:

- A fresh server cannot be claimed without a terminal-local bootstrap action.
- Every mutation is attributable to an authenticated owner and an immutable plan revision.
- A restart cannot silently repeat or lose an in-progress mutation.
- Tokens, environment values, ISO credentials, and guest secrets never enter logs.

## Milestone V3: restricted libvirt helper

Target: `0.5.0`

Status: VM creation uses the root-owned Unix socket, fixed binaries, fixed local libvirt URI, fixed managed-media root, an exact typed schema, durable steps, and rollback in `0.9.0`. Start, graceful shutdown, reboot requests, and autostart move into typed helper jobs in `0.10.0`. Read-only inventory moves to fixed helper scopes and the web service loses direct `libvirt` and `kvm` groups in `0.11.0`. AppArmor remains pending.

- Root-owned Unix socket with a versioned typed protocol
- Separate helper user and AppArmor/systemd confinement
- Domain lifecycle operations moved out of the web process
- Exact path roots, numeric ranges, resource ceilings, and operation allowlists
- Preflight, apply, verify, and recovery results stored as durable job steps

Acceptance:

- The web process no longer belongs to `libvirt` or `kvm`.
- The helper accepts no shell fragments, arbitrary executables, remote libvirt URI, or unresolved broad path.
- Negative tests cover traversal, symlink escape, argument injection, stale approvals, and confused-deputy requests.
- Loss of either process leaves a recoverable, inspectable job state.

## Milestone V4: guarded VM creation

Target: `0.6.0`

Status: the approved-ISO, capacity, default-NAT, immutable-revision, helper execution, verification, and incomplete-domain cleanup slice ships in `0.9.0`. Curated cloud images, cloud-init, Windows TPM/Secure Boot profiles, and formal capacity reservation remain pending.

- Create from an approved ISO or curated cloud image
- Capacity reservation and storage-pool free-space gate
- UEFI, TPM, and Secure Boot profiles where the host supports them
- Cloud-init seed generation with secret-safe handling
- Default-NAT networking first; bridge creation remains separate
- Automatic cleanup of an incomplete, never-started VM after explicit approval

Acceptance:

- Apply uses the exact reviewed plan revision and cannot substitute new inputs.
- Disk creation is confined to the selected pool and refuses insufficient free space.
- Failed creation leaves the original host network unchanged.
- The operator receives console recovery steps before the first boot.

## Milestone V5: console, snapshots, and guest integration

Target: `0.7.0`

Status: `0.11.0` ships helper-backed guest-agent availability, agent IP discovery, filesystem-freeze status, bounded snapshot inventory, durable stopped-VM internal snapshot creation, and read-only detection plus private-hostname handoff for an already active Cockpit socket. It labels snapshots offline-consistent and not independent backups. Native private console grants, Cockpit installation/configuration, online quiesced snapshots, chain-growth estimation, revert, and delete remain pending.

- Private web console proxy with short-lived access grants
- QEMU guest-agent status, IP discovery, clean shutdown, and filesystem-freeze awareness
- Snapshot inventory and guarded create/revert/delete workflows
- Snapshot-chain health warnings and storage-growth estimates
- Cockpit handoff while BoxPilot console support is incomplete

Acceptance:

- Console access is never public and cannot be reused after its grant expires.
- BoxPilot never labels a crash-consistent snapshot as application-consistent.
- Revert requires a separate backup and an explicit explanation of data loss.
- Snapshots are never counted as independent backups.

## Milestone V6: VM backup, restore, export, and migration

Target: `0.8.0`

Status: `0.12.0` ships the first stopped-VM export slice to a fixed root-only local destination with preflight capacity, immutable state revisions, standalone qcow2 conversion, structure and source-content verification, SHA-256 evidence, background execution, and confined cleanup. It is deliberately marked unencrypted, restore-untested, and unprotected. Independent encrypted destinations, isolated restore boots, restore execution, retention, and migration transfer remain pending.

- Quiesced backup coordination when a guest agent is available
- Offline backup fallback with measured downtime
- Disk plus domain-definition export, encryption, retention, and integrity verification
- Isolated restore drills
- Resumable, checksummed migration over LAN or Tailscale
- Source preservation through cutover acceptance

Acceptance:

- A VM is not shown as protected until an isolated restore boot and health check pass.
- Snapshot-only protection is reported as unprotected.
- Migration discovery cannot modify the source.
- Source deletion is never automatic.

## Milestone V7: networks, devices, and fleet

Target: `0.9.0` and later

- Bridge planning with console recovery checkpoints
- VLAN-aware networks and router integration adapters
- USB and PCI passthrough inventory with IOMMU isolation checks
- GPU and accelerator profiles
- Multiple BoxPilot nodes and placement planning
- UPS-aware evacuation and shutdown policies

Acceptance:

- A bridge change cannot start without a second management path or physical-console recovery plan.
- Passthrough refuses unresolved IOMMU groups and explains host-driver consequences.
- Router adapters use least-privilege credentials and render a reversible diff before applying.
- Loss of the BoxPilot controller does not stop running guests.

## Immediate implementation order

1. Complete V1 as a read-only vertical slice.
2. Build V2 before adding any new disk-writing VM operation.
3. Move existing lifecycle actions behind V3.
4. Ship VM creation only after V2 and V3 acceptance gates pass.
5. Add console and snapshot workflows before calling the product a complete VM manager.
6. Treat backup and restore evidence as a prerequisite for production migration.
