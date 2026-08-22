# Network and DNS

The Network page answers three questions: how this server reaches the internet, what it answers
DNS for, and what else is on your LAN. Everything it shows is read from the server; the page
changes nothing until you ask it to.

## What it reads

| Panel | Source |
| --- | --- |
| Gateway and interfaces | `ip route`, the kernel's interface list |
| Resolvers | `systemd-resolved`, `/etc/resolv.conf` |
| DNS listeners | the sockets actually listening on port 53, with the interface each is bound to |
| Devices on your LAN | the ARP neighbour table — machines this server has spoken to recently |
| Tailscale | `tailscale status` for this node (peers are not fetched) |

The neighbour table is not a scan: it lists what the server already knows about, so a device that
has been quiet may not appear.

## Tailscale

Two switches, each one tick:

- **Use this server as an exit node** — route a device's whole internet connection through your
  home line while you are away.
- **Share my home network with my tailnet** (subnet router) — reach every device on your LAN from
  anywhere without installing Tailscale on each of them.

Both need approval in the Tailscale admin console once, and BoxPilot links you straight to it.
Turning either on writes a sysctl drop-in for IP forwarding.

## Wake-on-LAN

Each device in the neighbour list has a **Wake** button, which sends a magic packet. The device
must have Wake-on-LAN enabled in its own firmware; BoxPilot cannot turn it on remotely.

## Running DNS for your LAN

Install Pi-hole, AdGuard Home or Technitium from the catalog. Pi-hole ships a bundled Unbound recursive resolver and uses it by default; AdGuard Home ships one you point it at during setup; Technitium resolves recursively on its own. Either way queries are answered from the root servers rather than forwarded to a public service.
Unbound resolver, so queries are resolved directly rather than forwarded to a public service, and
Pi-hole's manifest offers a blocklist picker at install time.

Once one is running, point your router's DHCP settings at this server's LAN address. BoxPilot does
not change your router — that step is yours, and it is the one to undo first if the network
misbehaves.

Before you switch, the page can record an assessment of the current resolver path so you have a
written note of what it looked like beforehand. Keep a second resolver configured on the router
where possible: if this server is the only DNS on the network, it is a single point of failure for
every device in the house.

## Firewall interaction

DNS needs port 53 open to the LAN (TCP and UDP). The Firewall page has a *DNS server* service
preset that opens exactly that, and Docker-published ports follow the firewall's rules — see
[the Firewall section of the README](../README.md#firewall).
