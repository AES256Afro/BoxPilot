# Router checkpoint center

BoxPilot `0.37.0` combines credential-free router-readiness guidance, the recovery-checkpoint metadata introduced in `0.23.0`, a separately approved fixed-query direct DNS acceptance workflow against the observed gateway, and its signed one-shot second-device follow-up. The owner declares which of their own devices plays which role:

- Edge router
- Access point
- Spare or lab device

This remains a bounded router integration gate. It does not log in to a router, accept credentials, call a vendor API, upload a configuration, discover firmware, change a setting, advertise DNS, or perform a restore. The server can query only its one observed gateway after a separate immutable plan and password approval. A separately enrolled agent can repeat only the fixed query contract after matching that target to its own one local default gateway.

## Recommended topology

The default recommendation is one router at the edge, everything else as access points:

1. **The edge router** in router mode as the only NAT authority, DHCP authority, and LAN gateway.
2. **Every other wireless device** in access-point or bridge mode, for Wi-Fi coverage only.
3. **Any spare** disconnected from the production forwarding path as a cold spare or isolated lab gateway.

This avoids double NAT and competing DHCP servers. The supported alternative is an explicitly planned migration to a different device at the edge, with every wireless router behind it acting only as an access point or bridge. Consumer routers commonly disable their DHCP, DNS, VPN, and add-on services in a non-router mode, so promoting a new edge router means anything the old one hosted needs a reviewed new home first.

## Live correlation and operator checks

Authenticated `GET /api/v1/network/router-readiness` runs the same fixed route, address, resolver, DNS-listener, and Tailscale collectors used by Network Center. It can state that the server observes a gateway address and interface. It cannot prove which physical device owns that address.

The response therefore keeps these as explicit operator checks:

- Compare the observed gateway address with the LAN address in the edge router's own admin page.
- Confirm the edge router is the only production NAT and DHCP authority.
- Confirm every device declared as an access point reports access-point or bridge mode in its own admin page.
- Confirm every device declared as a spare is outside the production forwarding path.
- Preserve console access and the existing Tailscale recovery path during physical changes.

No ARP or neighbor table is read, no MAC address or vendor fingerprint is returned, no arbitrary target is probed, and no router page or session is opened. "Address observed" never means "model verified."

## Guidance for any consumer router

The built-in checklists are written for the role, not for one vendor's menu layout: put the second router into access-point mode in its own admin page, export the configuration from the admin page before changing the forwarding path, and confirm the result from a client rather than from a menu label.

Firmware menus differ between makes and change between releases, so the guide tells the owner what to verify and leaves the exact menu path to the device's own documentation. It links to no vendor.

## Record a checkpoint

1. Export the router configuration from its own admin page.
2. Store the original file somewhere that does not depend on the server or that router.
3. Open **Routers** in BoxPilot.
4. Name the device, choose its role, and enter the firmware version shown by the router.
5. Select the exported configuration file. Files must be between 64 bytes and 64 MiB.
6. Confirm that the original file is retained outside BoxPilot.
7. Select **Hash locally and record metadata**.

The browser reads the file and computes SHA-256 with Web Crypto. It sends only:

- Owner-entered device name and its declared role
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
- The file belongs to the named device
- The router can restore the file
- A restore would preserve the current network path
- The file is still available outside BoxPilot

Keep the original file and the router's own recovery instructions together. A future router-write adapter must require a fresh checkpoint and separately test restore or rollback behavior.

## Direct DNS acceptance against the observed gateway

Version `0.36.0` adds a guided acceptance workflow after the checkpoint exists, for a resolver hosted on the edge router. BoxPilot accepts only six boolean declarations. The operator must confirm that:

1. The resolver is enabled in the edge router's admin page.
2. The emergency resolver was tested independently.
3. The effect of the router's client-request handling option was reviewed.
4. The edge router remains in router mode.
5. The edge router is the single production DHCP authority.
6. Domain-based VPN and parental-control impact was reviewed.

The server then requires exactly one live IPv4 default gateway, connected Tailscale recovery, and the latest retained edge-router checkpoint. The browser cannot provide an address, hostname, query, port, command, credential, cookie, or router setting. The immutable plan expires after 15 minutes and must be staged and approved with the BoxPilot owner password.

The unprivileged BoxPilot controller sends exactly four A-record queries to the observed gateway on port 53:

1. `example.com` over UDP with a successful answer required.
2. `example.com` over TCP with a successful answer required.
3. `example.net` over UDP with a successful answer required.
4. `boxpilot.invalid` over UDP with an NXDOMAIN response required.

A passing run stores the checkpoint id, plan id, job id, observed resolver address, fixed declarations, protocol, response code, answer count, recursion flag, truncation flag, latency, owner, and timestamp. It proves only that the server reached a DNS service at the one observed gateway and received the expected fixed responses. It does not identify the device answering, prove which resolver produced the response, prove that client-request handling or upstream filtering is configured correctly, prove that DHCP advertises the gateway, or prove that another client uses the same path.

The root helper is never invoked. No router, resolver, DHCP, DNS advertisement, VPN, firewall, client, or Tailscale setting is read or changed. If any query fails, no passing acceptance record is created. Keep or restore the independently tested resolver and inspect the router locally before creating a new plan.

## Signed second-device acceptance

Version `0.37.0` can create one signed agent task from a passing direct gateway acceptance no more than 30 minutes old. The owner selects only an active `dns-probe-v1` agent and an immediate, 5-minute, or 10-minute delay, then re-enters the BoxPilot password. The server derives the router acceptance id, checkpoint id, gateway, and four-query contract. The form accepts no address, name, port, command, credential, schedule expression, or task payload.

The Ed25519 agent accepts `dns.edge-router.acceptance.v1` only on Linux or macOS. Before querying DNS, it runs one fixed node-local default-route read. Exactly one IPv4 gateway must exist and equal the controller target. The agent rejects changed query names, protocols, expected response codes, port, checkpoint boundary, arbitrary-target flag, router-write flag, model-attestation flag, or gateway mismatch. A signed result is linked to the exact controller acceptance and checkpoint.

A passing result proves only that the enrolled key reported the fixed agent contract passed from a device whose locally derived gateway matched the fresh server target. It is not device or hardware attestation: it identifies no router model and proves nothing about resolver state, filtering, DHCP advertisement, every client, or recovery. No router, resolver, DHCP, DNS advertisement, VPN, client, firewall, or Tailscale write exists.

## Why configuration files are not uploaded

Router backups may contain wireless credentials, VPN keys, DNS settings, device names, account material, and network topology. Version `0.23.0` deliberately avoids making BoxPilot a vault for that data. Secret storage, encryption-at-rest, export controls, and per-make sanitization must exist before any later release considers ingesting a configuration.

## Future router write-integration gate

A safe router adapter still needs:

1. Exact make, model, and firmware compatibility declarations supplied by the owner
2. Read-only discovery with a dedicated least-privilege credential if the platform supports one
3. Credential encryption separate from ordinary SQLite job records
4. A bounded configuration diff that cannot contain a command or arbitrary path
5. Owner-password approval immediately before apply
6. An independent Tailscale or console recovery path
7. Post-change server and signed second-device DNS evidence
8. A timed observation window
9. One tested rollback operation tied to the exact checkpoint

The same gates apply to every adapter. A device declared as an access point stays an access point in the recommended topology, so its future adapter should prioritize mode and management-plane verification rather than edge-router DNS mutation.
