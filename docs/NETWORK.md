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
| Devices on your LAN | the ARP neighbour table. Machines this server has spoken to recently |
| Tailscale | `tailscale status` for this node (peers are not fetched) |

The neighbour table is not a scan: it lists what the server already knows about, so a device that
has been quiet may not appear.

## Tailscale

Two switches, each one tick:

- **Use this server as an exit node**: route a device's whole internet connection through your
  home line while you are away.
- **Share my home network with my tailnet** (subnet router). Reach every device on your LAN from
  anywhere without installing Tailscale on each of them.

Both need approval in the Tailscale admin console once, and BoxPilot links you straight to it.
Turning either on writes a sysctl drop-in for IP forwarding.

## Where an installed app is reachable from

Every app in the catalog carries one of two settings, switched from its card on the App catalog
page.

**Home network** publishes its ports on this server's network address. Anything on your LAN can
reach them and the firewall is the only thing deciding who does, which matters, because several
catalog apps have no login of their own.

**Tailnet only** stops the app listening on your home network. What happens to each port depends on
what the port speaks, because Tailscale Serve terminates HTTPS and proxies HTTP and so can only
front a web interface:

| The port speaks | Where it goes | Who can reach it |
| --- | --- | --- |
| HTTP (the app's web UI) | bound to this server only; Tailscale Serve publishes it as `https://<host>.ts.net:<port>` | anyone Tailscale authenticates, with a real certificate |
| something else. Git over SSH, Syncthing's sync port, RTSP, a game protocol | bound to this server's tailnet address | anything on your tailnet |
| a service the home network depends on. DNS on 53, a reverse proxy's 80 and 443, UniFi's inform port | left on the LAN address | unchanged |

The confirmation names which ports fall into the last two rows before you commit, so switching
Pi-hole to tailnet-only moves its admin page and leaves the house's DNS answering.

## Wake-on-LAN

Each device in the neighbour list has a **Wake** button, which sends a magic packet. The device
must have Wake-on-LAN enabled in its own firmware; BoxPilot cannot turn it on remotely.

## Running DNS for your LAN

Install Pi-hole, AdGuard Home or Technitium from the catalog. Pi-hole ships a bundled Unbound recursive resolver and uses it by default; AdGuard Home ships one you point it at during setup; Technitium resolves recursively on its own. Either way queries are answered from the root servers rather than forwarded to a public service.
Unbound resolver, so queries are resolved directly rather than forwarded to a public service, and
Pi-hole's manifest offers a blocklist picker at install time.

Once one is running, point your router's DHCP settings at this server's LAN address. BoxPilot does
not change your router. That step is yours, and it is the one to undo first if the network
misbehaves.

Before you switch, the page can record an assessment of the current resolver path so you have a
written note of what it looked like beforehand. Do not hand this server out as the only DNS server:
if it is, it is a single point of failure for every device in the house. The next section is how.

## When this server is off

If Pi-hole on this server is the only DNS server your devices know, then while this server is off
(a power cut, a reboot, a crash) no device in the house can look a name up, and the whole internet
looks down. The shape that avoids it (ADR-008): **the router is the one DNS server devices are
given, it asks this server first, and it asks a public resolver only when this server does not
answer.** Blocking and app names keep working while the server is up; names keep resolving while
it is down.

Network, Names & DNS, **If this server is off** checks it, read-only:

| It reads | From |
| --- | --- |
| What the router hands out | this server's own DHCP lease (`networkctl`, networkd's lease file, NetworkManager, dhclient), since the router gives every device the same DNS options |
| The same, on a server with a hand-set address | who asks Pi-hole, from its own query database (read-only, no admin password): three or more devices asking it directly means the router hands this server out; only the router asking means the router passes lookups on. Counts only; no device's address or domain is kept or shown |
| Whether each of those answers without this server | a lookup sent straight to each one, as a device sends it when this server is off |
| Whether the router passes lookups here | a made-up name asked of the router, looked for in Pi-hole's query log |
| Whether the router falls back | the last rehearsal (below) |

It says "If this server goes down, every device on your network loses the internet" (on Network, and
on Home through Repair) only when the lease names nothing but this server, devices ask Pi-hole
directly on a server with no lease, a second server does not answer, or a rehearsal showed the
router answering nothing. A router nobody has rehearsed is "not known yet". When neither the lease
nor Pi-hole's log can tell (no Pi-hole of BoxPilot's, its log unreadable, too few askers), the answer
is "not known": look on a device instead (Windows: `ipconfig /all`; iPhone: Settings, Wi-Fi, the (i)).

**Rehearse** (medium risk) proves the fallback: it stops the DNS app for about half a minute, asks the
router three names it cannot have cached, starts the app again and waits until it answers. A
transient systemd timer starts the app within three minutes if the job is cut off. With a fallback
nothing on the network notices more than a slower lookup; without one, nothing resolves for up to a
minute. The verdict stands for ninety days.

### The router's steps

BoxPilot does not sign in to the router for this. **Router steps…** on the panel shows these with
your addresses filled in; below, `<server>` is this server's LAN address and `<router>` the router's.

**GL.iNet (firmware 4.x)**, in the admin page at `<router>`:

1. If BoxPilot's app names end in `.lan`, switch them to `.home.arpa` first (Local names on the same
   tab): the router answers `.lan` itself and never passes it on.
2. **NETWORK, LAN, DHCP Server, Advanced**: empty *DNS Server 1* and *DNS Server 2*, Apply. Devices
   are then given the router.
3. **NETWORK, DNS**: mode *Manual DNS*, *DNS Server 1* `<server>`, *DNS Server 2* `9.9.9.9`.
4. On the same page: *Override DNS Settings for All Clients* off (it would send this server's own
   lookups back to itself); *DNS Rebinding Attack Protection* off if you use app names.
5. GL.iNet does not promise an order between its two servers, so make this server first:
   `ssh root@<router>`, then
   ```sh
   uci set dhcp.@dnsmasq[0].strictorder='1'
   uci commit dhcp && /etc/init.d/dnsmasq restart
   ```
6. Reconnect a device (or wait for its lease), run `sudo networkctl renew <interface>` on this
   server, press **Check again**: blocking should still work through the router (if not, swap the two
   servers in step 3). Then **Rehearse**.

Using the router's AdGuard Home instead: leave *Handle Client Requests* off, and in AdGuard Home's
DNS settings put only `<server>` under *Upstream DNS servers* and `9.9.9.9` under *Fallback DNS
servers*.

**OpenWrt (LuCI, 21.02 and later)**:

1. **Network, Interfaces, LAN, Edit, DHCP Server, Advanced Settings**: remove any *DHCP-Options* entry
   starting `6,`.
2. **Network, DHCP and DNS**: *DNS Forwards* (Forwards tab; *DNS forwardings* on General Settings in
   21.02) lists `<server>` then `9.9.9.9`.
3. Tick *Strict order* and *Ignore resolv file* (Resolv & Hosts Files tab; Advanced Settings in
   21.02). If you use app names, add `home.arpa` to the rebind protection's *Domain whitelist*.
4. Save & Apply, reconnect a device, **Check again**, **Rehearse**. Over SSH instead:
   ```sh
   uci del_list dhcp.lan.dhcp_option='6,<server>'
   uci add_list dhcp.@dnsmasq[0].server='<server>'
   uci add_list dhcp.@dnsmasq[0].server='9.9.9.9'
   uci set dhcp.@dnsmasq[0].noresolv='1'
   uci set dhcp.@dnsmasq[0].strictorder='1'
   uci add_list dhcp.@dnsmasq[0].rebind_domain='/home.arpa/'
   uci commit dhcp && /etc/init.d/dnsmasq restart
   ```
   dnsmasq 2.88 or later switches faster with `fast-dns-retry` in `/etc/dnsmasq.conf`.

**Any other router**: if it lets you set its own (WAN) DNS and hands itself out to devices, set
`<server>` first and a public resolver second, then check that blocking still works (routers that ask
both at once let ads through). Otherwise hand out two DNS servers in its DHCP settings: this server
and a second one. Best is a second blocker that is always on; a public resolver keeps names working
but devices use it some of the time and skip the blocking, and the check says so.

### After a power cut

A few minutes after a boot that followed an unclean end (the power-loss check says which), BoxPilot
asks the DNS app on the LAN address and resolves a name through the system's resolver, as updates
and image pulls do. Both lines go on the outage's record and on this panel.

## Hearing that this server is down

Nothing on a server that is off can say so, and ntfy on the same server goes down with it. Settings,
Notifications, **Heartbeat** (off until you turn it on, owner only) has this server send a bare
request every few minutes to a dead man's switch you choose; the switch alerts your phone when the
requests stop.

- **healthchecks.io** (free plan): make a check, set its *Period* to the heartbeat's interval and its
  *Grace Time* to at least as long again, add your phone as an integration (ntfy, Pushover, Telegram
  and more), and paste the check's ping URL (`https://hc-ping.com/<uuid>`) into Settings.
- **Healthchecks** or **Uptime Kuma** on another machine (not this one: it would go down with it). In
  Uptime Kuma make a *Push* monitor with a heartbeat interval a little longer than the heartbeat's,
  and paste its push URL (`http://<host>:3001/api/push/<token>?status=up&msg=OK&ping=`).

What is sent: one `GET` to that address, no body, no header of BoxPilot's, no hostname or status; the
switch sees the time and the address it came from. One try each tick, ten seconds at most, never
retried in a loop. The address is kept in the root-only credential store and never shown again, only
its host. It runs from `boxpilot-heartbeat.timer`, so a BoxPilot restart or upgrade does not trip
your alarm. **Send a test ping** sends one at once, through the same unit.

Tailscale cannot do this: its webhooks have no "device offline" event. Its admin console does show
when this server was last seen, and Network, Tailnet shows the same for your other devices.

An alternative with no account at all is a cron line on an OpenWrt router (`/etc/crontabs/root`)
that pings this server's address with the router's own `ping` and, when it gets no answer, posts
to an ntfy.sh topic you keep secret (`wget -q -O /dev/null --post-data "<server> is not answering"
https://ntfy.sh/<topic>`). BoxPilot does not install or check it, and without a state file it
alerts every time it runs while the server is down.

## Firewall interaction

DNS needs port 53 open to the LAN (TCP and UDP). The Firewall page has a *DNS server* service
preset that opens exactly that, and Docker-published ports follow the firewall's rules, see
[the Firewall section of the README](../README.md#firewall).
