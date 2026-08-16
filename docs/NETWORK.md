# Network and DNS Center

BoxPilot `0.18.0` adds a read-only network intelligence and planning surface. It is designed to answer the questions that must be settled before deploying Pi-hole, enabling Flint 2 AdGuard Home, changing a router DNS advertisement, or placing another router in the forwarding path.

This release cannot log in to a router, store a router password, change DHCP, change DNS, enable AdGuard Home, reconfigure Tailscale, probe an operator-supplied address, or cut over traffic.

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

The links identify the intended devices. BoxPilot does not claim API support for them in `0.18.0`.

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

Loopback and libvirt DNS listeners are shown separately. They do not automatically prove that a specific LAN address is unavailable. A future Pi-hole adapter must bind only the exact reviewed LAN address and must never assume that wildcard port 53 is safe.

The saved plan is attributable and revisioned in Operations Core, but it is deliberately not executable. There is no stage route, approval job, router mutation, or DNS cutover handler.

## Tailscale DNS boundary

BoxPilot reports observed resolver routing and separately asks for the operator's declared Tailscale DNS override state. This distinction matters because systemd-resolved can use the Tailscale resolver only for tailnet names while another interface remains the default DNS path.

Before making a network-critical resolver authoritative:

1. Keep Tailscale Serve working and Funnel disabled.
2. Keep an emergency resolver that does not depend on the new appliance.
3. Record the router configuration outside BoxPilot.
4. Verify ordinary DNS from Bigbox and a second LAN device.
5. Keep the old DNS service available through the rollback window.
6. If Tailscale DNS override is enabled, document the control-plane change needed when the DNS appliance is unavailable.

## Next gates

Router writes remain blocked until an adapter has exact model and firmware compatibility, secret storage, read-only discovery, a downloadable configuration checkpoint, a bounded diff, password reauthentication, post-change tests from a second device, and an out-of-band recovery path.

Pi-hole execution remains blocked until BoxPilot also has an exact-address deployment adapter, managed secret handling, configuration backup, isolated restore validation, DNS query tests, router checkpoint evidence, and an approval-based cutover with rollback.
