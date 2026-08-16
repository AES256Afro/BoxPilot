# Router checkpoint center

BoxPilot `0.37.0` combines credential-free router-readiness guidance, the recovery-checkpoint metadata introduced in `0.23.0`, a separately approved fixed-query Flint 2 direct DNS acceptance workflow, and its signed one-shot second-device follow-up for three fixed devices:

- GL.iNet Flint 2
- Omada ER707-M2
- TP-Link Archer BE400

This remains a bounded router integration gate. It does not log in to a router, accept credentials, call a vendor API, upload a configuration, discover firmware, change a setting, advertise DNS, or perform a restore. Bigbox can query only its one observed gateway after a separate immutable plan and password approval. A separately enrolled agent can repeat only the fixed query contract after matching that target to its own one local default gateway.

## Recommended topology

The default recommendation for this home network is:

1. **GL.iNet Flint 2** in Router mode as the only edge router, NAT authority, DHCP authority, and optional AdGuard Home host.
2. **TP-Link Archer BE400/BE6500** in Access Point mode for Wi-Fi only.
3. **Omada ER707-M2** disconnected from the production forwarding path as a cold spare or isolated lab gateway.

This avoids double NAT and competing DHCP servers while keeping Flint 2's built-in AdGuard Home feature available. The supported alternative is an explicitly planned migration to the ER707-M2 as the only edge router, with both wireless routers acting only as access points or bridges. GL.iNet documents that AdGuard Home, DHCP, DNS, VPN, and Tailscale features are unavailable when Flint 2 is in a non-router mode, so the alternate topology needs a different reviewed DNS host.

## Live correlation and operator checks

Authenticated `GET /api/v1/network/router-readiness` runs the same fixed route, address, resolver, DNS-listener, and Tailscale collectors used by Network Center. It can state that Bigbox observes a gateway address and interface. It cannot prove which physical device owns that address.

The response therefore keeps these as explicit operator checks:

- Compare the observed gateway address with the Flint 2 LAN address.
- Confirm Flint 2 is the only production NAT and DHCP authority.
- Confirm the TP-Link interface reports Access Point mode.
- Confirm the ER707-M2 is outside the production forwarding path.
- Preserve console access and the existing Tailscale recovery path during physical changes.

No ARP or neighbor table is read, no MAC address or vendor fingerprint is returned, no arbitrary target is probed, and no router page or session is opened. “Address observed” never means “model verified.”

## Vendor-grounded handoff

The built-in checklists point to current official documentation reviewed on 2026-08-16:

- [Flint 2 user guide](https://docs.gl-inet.com/router/en/4/user_guide/gl-mt6000/), [GL.iNet network modes](https://docs.gl-inet.com/router/en/4/interface_guide/network_mode/), and [GL.iNet AdGuard Home](https://docs.gl-inet.com/router/en/4/interface_guide/adguardhome/)
- [Archer BE400 user guide](https://static.tp-link.com/upload/manual/2025/202505/20250514/1910013703_Archer%20BE400_UG_REV1.0.0.pdf) and [TP-Link access-point mode guide](https://www.tp-link.com/us/support/faq/3774/)
- [ER707-M2 support](https://support.omadanetworks.com/en/product/er707-m2/v1/) and [ER707-M2 installation guide](https://static.tp-link.com/upload/manual/2025/202509/20250905/7100001295_ER707-M2_IG_REV1.30.0.pdf)

Firmware menus can change. The guide tells the operator what to verify and links to the vendor rather than automating a login or treating a menu label as live evidence.

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

## Flint 2 AdGuard Home direct DNS acceptance

Version `0.36.0` adds a guided acceptance workflow after the checkpoint exists. BoxPilot accepts only six boolean declarations. The operator must confirm that:

1. AdGuard Home is enabled in the Flint 2 interface.
2. The emergency resolver was tested independently.
3. The effect of **Handle Client Requests** was reviewed.
4. Flint 2 remains in Router mode.
5. Flint 2 is the single production DHCP authority.
6. Domain-based VPN and parental-control impact was reviewed.

The server then requires exactly one live IPv4 default gateway, connected Tailscale recovery, and the latest retained Flint 2 checkpoint. The browser cannot provide an address, hostname, query, port, command, credential, cookie, or router setting. The immutable plan expires after 15 minutes and must be staged and approved with the BoxPilot owner password.

The unprivileged BoxPilot controller sends exactly four A-record queries to the observed gateway on port 53:

1. `example.com` over UDP with a successful answer required.
2. `example.com` over TCP with a successful answer required.
3. `example.net` over UDP with a successful answer required.
4. `boxpilot.invalid` over UDP with an NXDOMAIN response required.

A passing run stores the checkpoint id, plan id, job id, observed resolver address, fixed declarations, protocol, response code, answer count, recursion flag, truncation flag, latency, owner, and timestamp. It proves only that Bigbox reached a DNS service at the one observed gateway and received the expected fixed responses. It does not prove the gateway is physically a Flint 2, that AdGuard Home produced the response, that **Handle Client Requests** or upstream filtering is configured correctly, that DHCP advertises the gateway, or that another client uses the same path.

The root helper is never invoked. No router, AdGuard Home, DHCP, DNS advertisement, VPN, firewall, client, or Tailscale setting is read or changed. If any query fails, no passing acceptance record is created. Keep or restore the independently tested resolver and inspect Flint 2 locally before creating a new plan.

## Signed second-device Flint 2 acceptance

Version `0.37.0` can create one signed agent task from a passing direct gateway acceptance no more than 30 minutes old. The owner selects only an active `dns-probe-v1` agent and an immediate, 5-minute, or 10-minute delay, then re-enters the BoxPilot password. The server derives the router acceptance id, checkpoint id, gateway, and four-query contract. The form accepts no address, name, port, command, credential, schedule expression, or task payload.

The Ed25519 agent accepts `dns.flint2-adguard.acceptance.v1` only on Linux or macOS. Before querying DNS, it runs one fixed node-local default-route read. Exactly one IPv4 gateway must exist and equal the controller target. The agent rejects changed query names, protocols, expected response codes, port, checkpoint boundary, arbitrary-target flag, router-write flag, model-attestation flag, or gateway mismatch. A signed result is linked to the exact controller acceptance and checkpoint.

A passing result proves only that the enrolled key reported the fixed agent contract passed from a device whose locally derived gateway matched the fresh Bigbox target. It is not device or hardware attestation and does not prove physical Flint 2 identity, AdGuard Home state, filtering, DHCP advertisement, every client, or recovery. No router, AdGuard Home, DHCP, DNS advertisement, VPN, client, firewall, or Tailscale write exists.

## Why configuration files are not uploaded

Router backups may contain wireless credentials, VPN keys, DNS settings, device names, account material, and network topology. Version `0.23.0` deliberately avoids making BoxPilot a vault for that data. Secret storage, encryption-at-rest, export controls, and vendor-specific sanitization must exist before any later release considers ingesting a configuration.

## Future Flint 2 write-integration gate

A safe Flint 2 adapter still needs:

1. Exact model and firmware compatibility declarations
2. Model-attested read-only discovery with a dedicated least-privilege credential if the platform supports one
3. Credential encryption separate from ordinary SQLite job records
4. A bounded configuration diff that cannot contain a command or arbitrary path
5. Owner-password approval immediately before apply
6. An independent Tailscale or console recovery path
7. Post-change Bigbox and signed second-device DNS evidence
8. A timed observation window
9. One tested rollback operation tied to the exact checkpoint

The same gates apply to an ER707-M2 adapter. The TP-Link BE400 should remain an access point in the recommended Flint 2 topology, so its future adapter should prioritize mode and management-plane verification rather than edge-router DNS mutation.
