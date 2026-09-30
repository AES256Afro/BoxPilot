import { useState, type ReactNode } from "react";
import { CodeBlock, Segmented } from "../../ui";

/*
 * What the owner does on their router so the house keeps its DNS while this server is off (M39.2,
 * ADR-007): the router becomes the only DNS server devices are given, asks the DNS server here first,
 * and falls back to a public resolver only when that does not answer. Written for GL.iNet's firmware
 * 4.x, for OpenWrt's LuCI, and for any other router. BoxPilot never signs in to the router for this;
 * each path ends at "Check again" here, which reads the result, and the rehearsal, which proves it.
 * docs/NETWORK.md carries the same steps.
 */

export type RouterKind = "glinet" | "openwrt" | "any";

export interface RouterStepsProps {
  /** This server's LAN address, the DNS server the router should ask first. */
  server: string | null;
  /** The router's address, where its admin page is. */
  router: string | null;
  /** Whether BoxPilot's app names end in .lan, which the router answers itself and will not pass on. */
  lanNames?: boolean;
  /** Which router's steps to show first. */
  initial?: RouterKind;
}

/** The fallback suggested: Quad9, the upstream Pi-hole's manifest offers first. */
export const fallbackResolver = "9.9.9.9";

const kinds: Array<{ value: RouterKind; label: string }> = [
  { value: "glinet", label: "GL.iNet" },
  { value: "openwrt", label: "OpenWrt" },
  { value: "any", label: "Any router" },
];

function Steps({ children }: { children: ReactNode }) {
  return <ol className="network-steps">{children}</ol>;
}

export function RouterSteps({ server, router, lanNames = false, initial = "glinet" }: RouterStepsProps) {
  const [kind, setKind] = useState<RouterKind>(initial);
  const here = server ?? "this server's address";
  const admin = router ? <code>{router}</code> : "your router's address";
  const names = lanNames
    ? <li>Your app names end in <code>.lan</code>, which the router answers itself and never passes on. Switch them to <code>.home.arpa</code> first, under Local names on this tab.</li>
    : null;

  const uci = [
    `uci del_list dhcp.lan.dhcp_option='6,${here}'`,
    `uci add_list dhcp.@dnsmasq[0].server='${here}'`,
    `uci add_list dhcp.@dnsmasq[0].server='${fallbackResolver}'`,
    "uci set dhcp.@dnsmasq[0].noresolv='1'",
    "uci set dhcp.@dnsmasq[0].strictorder='1'",
    "uci add_list dhcp.@dnsmasq[0].rebind_domain='/home.arpa/'",
    "uci commit dhcp && /etc/init.d/dnsmasq restart",
  ].join("\n");

  return (
    <div className="network-sheet-part">
      <Segmented<RouterKind> label="Your router" options={kinds} value={kind} onChange={setKind} />
      {kind === "glinet" && (
        <>
          <p className="network-note">GL.iNet firmware 4.x, in the router&apos;s admin page at {admin}. The router becomes the one DNS server your devices use; it asks <code>{here}</code> first and <code>{fallbackResolver}</code> only when this server does not answer.</p>
          <Steps>
            {names}
            <li><b>NETWORK, LAN, DHCP Server, Advanced:</b> empty <em>DNS Server 1</em> and <em>DNS Server 2</em>, then Apply. Devices are then given the router itself.</li>
            <li><b>NETWORK, DNS:</b> set the mode to <em>Manual DNS</em>, <em>DNS Server 1</em> to <code>{here}</code> and <em>DNS Server 2</em> to <code>{fallbackResolver}</code>.</li>
            <li>On the same page, turn <em>Override DNS Settings for All Clients</em> off: it would send this server&apos;s own lookups back to itself. Turn <em>DNS Rebinding Attack Protection</em> off if you use app names, or they will not resolve.</li>
            <li>Make the router ask this server first. GL.iNet does not promise an order between its two servers, so from a computer run <code>ssh root@{router ?? "<router>"}</code> (the admin password), then: <CodeBlock label="Ask the servers in order">{"uci set dhcp.@dnsmasq[0].strictorder='1'\nuci commit dhcp && /etc/init.d/dnsmasq restart"}</CodeBlock></li>
            <li>Reconnect a device to Wi-Fi (or wait for its lease to renew), and on this server run <code>sudo networkctl renew</code> with its network interface, so it reads the new lease too.</li>
            <li>Press <b>Check again</b> here. Blocking should still work through the router; if it does not, swap the two servers in step 2. Then <b>Rehearse</b>: it stops the DNS app here for half a minute and proves the router falls back.</li>
          </Steps>
          <p className="network-note">Using the router&apos;s own AdGuard Home instead? Leave <em>Handle Client Requests</em> off, and in AdGuard Home&apos;s settings page under DNS settings put only <code>{here}</code> in <em>Upstream DNS servers</em> and <code>{fallbackResolver}</code> in <em>Fallback DNS servers</em>. Its own blocklists then only matter while this server is off.</p>
        </>
      )}
      {kind === "openwrt" && (
        <>
          <p className="network-note">OpenWrt 21.02 or later, in LuCI at {admin}. The names of tabs moved in 23.05; both are given.</p>
          <Steps>
            {names}
            <li><b>Network, Interfaces, LAN, Edit, DHCP Server, Advanced Settings:</b> remove any <em>DHCP-Options</em> entry starting <code>6,</code>, so devices are given the router itself.</li>
            <li><b>Network, DHCP and DNS:</b> under <em>DNS Forwards</em> (the Forwards tab; <em>DNS forwardings</em> on General Settings in 21.02) list <code>{here}</code> first and <code>{fallbackResolver}</code> second.</li>
            <li>Tick <em>Strict order</em> and <em>Ignore resolv file</em> (the Resolv &amp; Hosts Files tab; Advanced Settings in 21.02), so this server is always asked first and your provider&apos;s DNS is not.</li>
            <li>If you use app names, add <code>home.arpa</code> to <em>Domain whitelist</em> under rebind protection. Save &amp; Apply.</li>
            <li>Reconnect a device, renew this server&apos;s lease (<code>sudo networkctl renew</code> with its interface), and press <b>Check again</b> here, then <b>Rehearse</b>.</li>
          </Steps>
          <CodeBlock label="The same over SSH">{uci}</CodeBlock>
          <p className="network-note">dnsmasq 2.88 or later can retry by itself instead of waiting for the device to: add <code>fast-dns-retry</code> to <code>/etc/dnsmasq.conf</code> for a quicker switch while this server is off.</p>
        </>
      )}
      {kind === "any" && (
        <>
          <p className="network-note">Every router has one of two settings. The first keeps the blocking; the second is the last resort.</p>
          <Steps>
            <li><b>If the router lets you set its own DNS</b> (often under Internet or WAN) and hands itself out to devices: set the primary to <code>{here}</code> and the secondary to <code>{fallbackResolver}</code>, and leave the LAN&apos;s DHCP DNS on automatic. Press <b>Check again</b>: if ads get through, the router asks both at once, and the second way is no worse.</li>
            <li><b>Otherwise</b>, in the router&apos;s DHCP or LAN settings hand out two DNS servers: <code>{here}</code> and a second one. The best second is another blocker that is always on (a second Pi-hole on a small computer, or a blocker built into the router). A public resolver such as <code>{fallbackResolver}</code> keeps names working, but devices use it some of the time and skip the blocking; BoxPilot says so when it sees it.</li>
            <li>Reconnect a device and press <b>Check again</b> here.</li>
          </Steps>
        </>
      )}
    </div>
  );
}
