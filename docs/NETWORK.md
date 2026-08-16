# Network and DNS Center

BoxPilot `0.22.0` uses the Network and DNS Center as the authorization boundary for guarded Pi-hole staging and fixed direct DNS acceptance. It provides a local Pi-hole configuration backup and isolated restore drill after staging, followed by a separate password-approved controller-path test and a signed second-device test. It is designed to answer the questions that must be settled before starting Pi-hole, enabling Flint 2 AdGuard Home, changing a router DNS advertisement, or placing another router in the forwarding path.

This release can start only the curated Pi-hole Docker stack after a fresh assessment and separate approval. Once exact staging and recovery evidence exist, it can send four fixed DNS queries to the helper-reported managed Pi-hole address. It cannot log in to a router, store a router password, change DHCP, advertise DNS to clients, enable AdGuard Home, reconfigure Tailscale, probe an operator-supplied address, or cut over traffic.

## Live collectors

The unprivileged web service runs five fixed read-only commands:

```text
ip -j -4 address show
ip -j -4 route show default
resolvectl status --json=short
ss -H -l -n -t -u
tailscale status --json
```

BoxPilot returns only:

- Validated IPv4 default gateways and interface names
- Host LAN addresses and CIDR values
- Sanitized resolver addresses reported by systemd-resolved
- TCP and UDP port 53 listener addresses, protocols, interface matches, and scopes
- Tailscale connected state, this machine's DNS name, and whether the Tailscale resolver is observed as the default resolver
- A fixed device catalog with official documentation links

It does not return neighbor tables, MAC addresses, ARP entries, process ids, command lines, environment values, Tailscale peer details, router sessions, or credentials. Collector failures degrade their own section instead of inventing a ready state.

## Recommended three-device topology

For the current equipment, the simplest initial layout is:

```text
Internet
   |
GL.iNet Flint 2
  one edge router, NAT, DHCP, optional AdGuard Home
   |
LAN or switch
   +-- Bigbox at its reserved LAN address
   +-- TP-Link Archer BE400 in access-point mode
   +-- Omada ER707-M2 disconnected, in a lab segment, or kept as a future replacement
```

Do not place Flint 2, the TP-Link, and the ER707-M2 in series as three active routers. That creates multiple NAT and DHCP boundaries and makes DNS recovery harder. If the ER707-M2 later becomes the edge router, Flint 2 and the TP-Link should have explicitly reviewed access-point or bridge roles. Router-level AdGuard Home on Flint 2 then needs a separate design because Flint is no longer the client DHCP authority.

BoxPilot recognizes these declarations:

- [GL.iNet Flint 2 AdGuard Home documentation](https://docs.gl-inet.com/router/en/4/interface_guide/adguardhome/)
- [Omada ER707-M2 product documentation](https://www.omadanetworks.com/us/business-networking/omada-router-wired-router/er707-m2/)
- [TP-Link Archer BE400 product documentation](https://www.tp-link.com/us/home-networking/wifi-router/archer-be400/)

The links identify the intended devices. BoxPilot does not claim API support for them in `0.22.0`.

## Change-window assessment

An authenticated operator can create an immutable assessment with only these typed fields:

- Intended topology
- DNS role
- Observed gateway and Bigbox LAN IPv4 addresses
- Proposed primary and emergency DNS IPv4 addresses
- Whether a router backup was recorded
- Whether the emergency resolver was independently tested
- Whether a second LAN device is ready
- The operator-declared Tailscale DNS override state

The service re-reads live topology before it creates the plan. It blocks readiness when the declared gateway or Bigbox address does not match live state, recovery checks are missing, DNS addresses collide, a dedicated VM address is outside the LAN subnet, or a planned Bigbox port 53 binding is occupied.

Loopback and libvirt DNS listeners are shown separately. They do not automatically prove that a specific LAN address is unavailable. The Pi-hole adapter binds only the exact reviewed Bigbox LAN address and never treats a wildcard or same-address port 53 listener as safe.

The saved assessment remains non-executable and makes no change. When it is ready, the Applications page can reference its id in a separate immutable Pi-hole plan. Planning, staging, and approval rebuild the live assessment and require exact evidence equality. The resulting application job can start Pi-hole only. There is still no router mutation or DNS cutover handler.

## Tailscale DNS boundary

BoxPilot reports observed resolver routing and separately asks for the operator's declared Tailscale DNS override state. This distinction matters because systemd-resolved can use the Tailscale resolver only for tailnet names while another interface remains the default DNS path.

Before making a network-critical resolver authoritative:

1. Keep Tailscale Serve working and Funnel disabled.
2. Keep an emergency resolver that does not depend on the new appliance.
3. Record the router configuration outside BoxPilot.
4. Verify ordinary DNS from Bigbox and a second LAN device.
5. Keep the old DNS service available through the rollback window.
6. If Tailscale DNS override is enabled, document the control-plane change needed when the DNS appliance is unavailable.

## Pi-hole staging boundary

The restricted helper accepts only a private RFC1918 LAN address and a high web port from the server-validated plan. It owns the image digest, paths, Compose source, capabilities, secret generation, Docker arguments, health checks, and rollback. See [Curated applications](APPLICATIONS.md).

Starting Pi-hole does not make it authoritative. Keep current external AdGuard DNS or Flint 2 AdGuard Home active. BoxPilot reports the staged application as backup-required until the separate local configuration backup and isolated no-network restore pass. Even then, it does not tell any client or router to use Pi-hole, and the artifact is not independent of Bigbox.

## Direct DNS acceptance boundary

Version `0.21.0` adds a separate `network.dns.acceptance` plan and `network.dns.acceptance.run` job. Planning accepts no target address, query name, port, command, or router credential. BoxPilot derives the resolver from the latest completed managed Pi-hole deployment whose exact address and TCP and UDP bindings still match the live helper inventory. It also requires:

- The original owner-attributable Pi-hole network assessment
- A live matching default gateway and Bigbox LAN address
- Exact non-wildcard TCP and UDP listeners on the reviewed resolver address
- A connected Tailscale recovery path with the same declared default-DNS boundary
- A completed Pi-hole configuration backup with a passing isolated restore drill
- Password reauthentication after staging an immutable 15-minute plan

The unprivileged web service sends exactly these A-record queries to port 53:

1. `pi.hole` over UDP, requiring a successful answer
2. `pi.hole` over TCP, requiring a successful answer
3. `example.com` over UDP, requiring a successful answer
4. `boxpilot.invalid` over UDP, requiring the reserved negative response code

The root helper keeps `PrivateNetwork=true` and `RestrictAddressFamilies=AF_UNIX`. It performs no DNS probe. A passing controller job stores the exact deployment, assessment, backup, resolver, per-query protocol, response code, answer count, recursion flag, truncation flag, and latency. It explicitly records `secondDeviceTested: false`, `routerMutationPerformed: false`, `dnsCutoverPerformed: false`, and `clientSettingsChanged: false`.

A passing result proves only that Bigbox can query its managed resolver directly. It does not prove ordinary client routing, DHCP advertisement, router configuration, or another LAN device. Failed probes leave the independent DNS path untouched and create no passing acceptance record.

## Signed second-device acceptance boundary

Version `0.22.0` adds one signed agent task after a passing direct Bigbox result. The operator chooses only an enrolled agent. BoxPilot derives the resolver and the four tests from the fresh controller record, accepts no address, hostname, port, or command, and expires the task after ten minutes.

The device owns an Ed25519 private key and signs each poll and evidence submission with a timestamp and strictly increasing sequence number. BoxPilot rejects stale requests, replayed sequences, forged signatures, changed test contracts, arbitrary capabilities, and revoked devices. The fixed task repeats the four queries above. Evidence records the linked controller acceptance, exact resolver, per-query result, agent identity, signature, and `secondDeviceTested: true` while still recording every network mutation flag as false.

A passing signed result proves only the direct path from that enrolled device to Pi-hole during the task window. It does not prove router advertisement, DHCP behavior, use by every client, or fallback recovery. See [Signed fleet agents](FLEET.md).

## Next gates

Router writes remain blocked until an adapter has exact model and firmware compatibility, secret storage, read-only discovery, a downloadable configuration checkpoint, a bounded diff, password reauthentication, post-change tests from a second device, and an out-of-band recovery path.

Pi-hole router cutover remains blocked. Version `0.22.0` implements configuration backup, isolated restore, guarded Bigbox direct checks, and signed second-device checks. Passing live runs are still operator-triggered. A model-specific router checkpoint and advertisement adapter, a bounded diff, an observation window, and an approval-based rollback sequence are still required.
