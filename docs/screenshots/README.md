# BoxPilot screenshots

These images include historical local captures and explicitly disclosed release mockups. Each caption in the repository README identifies whether a surface is connected to host APIs or uses demonstration data.

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
- `pihole-backup-approval-mock.png`: explicitly disclosed `0.20.0` guarded Pi-hole backup and isolated-restore mock rendered from `docs/mockups/pihole-backup-approval.html`; no container was stopped, archive or secret was read, restore was started, or network setting was changed
- `pihole-dns-acceptance-mock.png`: explicitly disclosed `0.21.0` fixed direct Pi-hole DNS acceptance mock rendered from `docs/mockups/pihole-dns-acceptance.html`; no DNS query was sent, no job was approved, and no network setting was changed
- `signed-fleet-agent-mock.png`: explicitly disclosed `0.22.0` signed agent enrollment and second-device DNS evidence mock rendered from `docs/mockups/signed-fleet-agent.html`; no device was enrolled, key or token was generated, DNS query was sent, or network setting was changed
- `router-checkpoint-mock.png`: explicitly disclosed `0.23.0` browser-local router checkpoint mock rendered from `docs/mockups/router-checkpoint.html`; no file was selected, hashed, uploaded, or recorded, and no router or network setting was read or changed
- `router-readiness-mock.png`: explicitly disclosed `0.27.0` fixed-model router-readiness mock rendered from `docs/mockups/router-readiness.html`; no router was contacted, identified, logged in to, probed, uploaded from, or changed
- `github-provenance-mock.png`: explicitly disclosed `0.24.0` credential-free GitHub provenance mock rendered from `docs/mockups/github-provenance.html`; no credential was accepted, repository or workflow was changed, asset was downloaded, digest was locally verified, or software was installed
- `keel-plan-mock.png`: explicitly disclosed `0.25.0` Keel exact-release planning mock rendered from `docs/mockups/keel-plan.html`; no Keel asset was downloaded by BoxPilot, no local digest was computed by BoxPilot, and no service, account, state, backup, restore, port, or application installation was changed
- `recovery-kit-mock.png`: explicitly disclosed `0.26.0` disaster recovery readiness mock rendered from `docs/mockups/recovery-kit.html`; no database, application data, backup payload, router configuration, credential, key, signature, arbitrary log, host, VM, application, network, or router state was copied or changed

Do not crop out the data-source notice when replacing these screenshots. It is part of the product's capability disclosure.
