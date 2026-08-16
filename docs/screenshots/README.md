# BoxPilot screenshots

These images are captured from the local `0.3.0` build. Each caption in the repository README identifies whether a surface is connected to host APIs or uses demonstration data.

- `overview-demo.jpg`: workflow mockup with visible sample-data labeling
- `virtualization-preflight.jpg`: host-backed QEMU/KVM and libvirt readiness view captured on a non-Linux development host
- `vm-planner.jpg`: historical `0.3.0` server-validated, non-executable VM planner captured with a local ISO fixture; `0.9.0` can stage supported Linux plans for guarded approval
- `vm-creation-approval-mock.png`: explicitly disclosed `0.9.0` mock state rendered from `docs/mockups/vm-creation-approval.html`; no VM was executed
- `vm-lifecycle-approval-mock.png`: explicitly disclosed `0.10.0` lifecycle-plan mock rendered from `docs/mockups/vm-lifecycle-approval.html`; no VM was changed
- `vm-snapshot-approval-mock.png`: explicitly disclosed `0.11.0` stopped-VM snapshot-plan mock rendered from `docs/mockups/vm-snapshot-approval.html`; no VM or disk was changed
- `vm-export-approval-mock.png`: explicitly disclosed `0.12.0` stopped-VM local-export mock rendered from `docs/mockups/vm-export-approval.html`; no VM or disk was changed, and the mock states that the artifact is not yet a protected backup
- `vm-protection-approval-mock.png`: explicitly disclosed `0.13.0` encrypted independent-copy mock rendered from `docs/mockups/vm-protection-approval.html`; no VM, export, repository, or disk was changed, and the mock states that isolated restore validation remains pending
- `vm-restore-drill-approval-mock.png`: explicitly disclosed `0.14.0` isolated no-network VM restore-drill mock rendered from `docs/mockups/vm-restore-drill-approval.html`; no snapshot was restored and no VM was booted
- `vm-recovery-approval-mock.png`: explicitly disclosed `0.15.0` guarded recovery-clone mock rendered from `docs/mockups/vm-recovery-approval.html`; no snapshot was restored and no recovery VM was defined
- `vm-retention-approval-mock.png`: explicitly disclosed `0.16.0` exact no-prune retention mock rendered from `docs/mockups/vm-retention-approval.html`; no restic snapshot was forgotten or pruned
- `migration-transfer-approval-mock.png`: explicitly disclosed `0.17.0` guarded local migration-staging mock rendered from `docs/mockups/migration-transfer-approval.html`; no source workload or file was changed, no real bundle was copied, and no Compose project was activated
- `network-dns-assessment-mock.png`: explicitly disclosed `0.18.0` read-only network and DNS assessment mock rendered from `docs/mockups/network-dns-assessment.html`; no router, DNS, DHCP, firewall, Tailscale, or application setting was read from a real browser session or changed
- `pihole-staging-approval-mock.png`: explicitly disclosed `0.19.0` guarded Pi-hole staging mock rendered from `docs/mockups/pihole-staging-approval.html`; no container, router, DNS client, DHCP service, firewall, Tailscale setting, or traffic path was changed

Do not crop out the data-source notice when replacing these screenshots. It is part of the product's capability disclosure.
