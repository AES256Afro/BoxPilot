import { useCallback, useEffect, useState } from "react";
import { useOperation } from "./ApproveDialog";

interface VpnProfile {
  configured: boolean;
  provider?: string;
  type?: "wireguard" | "openvpn";
  wireguardAddresses?: string;
  openvpnUser?: string;
  countries?: string;
  portForwarding?: "on" | "off";
  dot?: "on" | "off";
  blockMalicious?: "on" | "off";
  blockAds?: "on" | "off";
  blockSurveillance?: "on" | "off";
  dnsAddress?: string;
  outboundSubnets?: string;
  healthTargetAddress?: string;
  hasWireguardKey?: boolean;
  hasOpenvpnPassword?: boolean;
  updatedAt?: string;
}
interface Payload { profile: VpnProfile | null; providers: string[]; protocols: string[] }

const toggleOn = (value: string | undefined) => value === "on";

/**
 * The shared VPN profile (M17.4): one VPN connection, configured once, that any VPN-capable app
 * (qBittorrent, Stremio) can be routed through with a single switch on its own page. The key lives
 * in a root-owned file on the server; this panel only ever sees the redacted description.
 */
export default function VpnProfilePanel({ csrfToken }: { csrfToken: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [provider, setProvider] = useState("mullvad");
  const [type, setType] = useState<"wireguard" | "openvpn">("wireguard");
  const [wireguardPrivateKey, setWgKey] = useState("");
  const [wireguardAddresses, setWgAddr] = useState("");
  const [openvpnUser, setOvpnUser] = useState("");
  const [openvpnPassword, setOvpnPass] = useState("");
  const [countries, setCountries] = useState("");
  const [portForwarding, setPortForwarding] = useState(false);
  const [dot, setDot] = useState(true);
  const [blockMalicious, setBlockMalicious] = useState(true);
  const [blockAds, setBlockAds] = useState(false);
  const [blockSurveillance, setBlockSurveillance] = useState(false);
  const [dnsAddress, setDnsAddress] = useState("");
  const [outboundSubnets, setOutboundSubnets] = useState("");

  const refresh = useCallback(() => fetch("/api/v1/settings/vpn-profile")
    .then((response) => (response.ok ? response.json() : null))
    .then((body: Payload | null) => setData(body))
    .catch(() => setError("Could not read the VPN profile")), []);
  useEffect(() => { void refresh(); }, [refresh]);
  const { start, dialog } = useOperation(csrfToken, () => { setEditing(false); setWgKey(""); setOvpnPass(""); void refresh(); });

  const profile = data?.profile ?? null;
  const configured = Boolean(profile?.configured);

  const beginEdit = () => {
    if (profile?.configured) {
      setProvider(profile.provider ?? "mullvad");
      setType(profile.type ?? "wireguard");
      setWgAddr(profile.wireguardAddresses ?? "");
      setOvpnUser(profile.openvpnUser ?? "");
      setCountries(profile.countries ?? "");
      setPortForwarding(toggleOn(profile.portForwarding));
      setDot(toggleOn(profile.dot));
      setBlockMalicious(toggleOn(profile.blockMalicious));
      setBlockAds(toggleOn(profile.blockAds));
      setBlockSurveillance(toggleOn(profile.blockSurveillance));
      setDnsAddress(profile.dnsAddress ?? "");
      setOutboundSubnets(profile.outboundSubnets ?? "");
    }
    setWgKey(""); setOvpnPass(""); setEditing(true);
  };

  const save = () => {
    const parameters: Record<string, string> = {
      provider, type, countries, wireguardAddresses, openvpnUser,
      portForwarding: portForwarding ? "on" : "off",
      dot: dot ? "on" : "off",
      blockMalicious: blockMalicious ? "on" : "off",
      blockAds: blockAds ? "on" : "off",
      blockSurveillance: blockSurveillance ? "on" : "off",
      dnsAddress, outboundSubnets,
    };
    if (wireguardPrivateKey) parameters.wireguardPrivateKey = wireguardPrivateKey;
    if (openvpnPassword) parameters.openvpnPassword = openvpnPassword;
    start({
      operationId: "vpn.profile.set",
      title: "Save the VPN profile",
      parameters,
      preview: <span>Saves this VPN connection to a root-owned file on the server. Apps you route through the profile use it at their next deploy; the key never appears in a job record or the database.</span>,
    });
  };

  const providers = data?.providers ?? ["mullvad"];

  return (
    <section className="panel">
      <header className="panel-header">
        <div><strong>VPN profile</strong><span>One VPN connection, set up once, that any VPN app can be routed through with a single switch instead of entering the key per app.</span></div>
        <span className={`status-pill ${configured ? "status-good" : "status-neutral"}`}>{configured ? `${profile?.provider} · ${profile?.type}` : "Not set up"}</span>
      </header>
      {error && <div className="auth-error" role="alert">{error}</div>}

      {configured && !editing && (
        <>
          <div className="vpn-profile-summary">
            <div><span className="eyebrow">Provider</span><strong>{profile?.provider}</strong></div>
            <div><span className="eyebrow">Protocol</span><strong>{profile?.type}</strong></div>
            <div><span className="eyebrow">Countries</span><strong>{profile?.countries || "Provider's choice"}</strong></div>
            <div><span className="eyebrow">Key</span><strong>{profile?.hasWireguardKey || profile?.hasOpenvpnPassword ? "Stored" : "Missing"}</strong></div>
          </div>
          <div className="vpn-profile-tags">
            {toggleOn(profile?.dot) && <span className="chip">DNS over TLS</span>}
            {toggleOn(profile?.blockMalicious) && <span className="chip">Block malware</span>}
            {toggleOn(profile?.blockAds) && <span className="chip">Block ads</span>}
            {toggleOn(profile?.blockSurveillance) && <span className="chip">Block trackers</span>}
            {toggleOn(profile?.portForwarding) && <span className="chip">Port forwarding</span>}
            {profile?.outboundSubnets && <span className="chip">LAN: {profile.outboundSubnets}</span>}
          </div>
          <p className="muted">Turn on "Use my VPN profile" on any VPN app (qBittorrent, Stremio) to route it through this connection. Changing the profile reaches each app the next time it deploys.</p>
          <div className="recovery-actions">
            <button className="secondary-button" type="button" onClick={beginEdit}>Change</button>
            <button className="text-button" type="button" onClick={() => start({ operationId: "vpn.profile.clear", title: "Remove the VPN profile", parameters: {}, preview: <span>Deletes the saved profile. Apps already routed through it keep running, but refuse to redeploy until it is saved again or given their own connection.</span> })}>Remove</button>
          </div>
        </>
      )}

      {(!configured || editing) && (
        <div className="vpn-profile-form">
          {!configured && !editing && (
            <button className="primary-button" type="button" onClick={beginEdit}>Set up a VPN profile</button>
          )}
          {(editing || configured) && editing && (
            <>
              <div className="field-grid">
                <label>VPN provider
                  <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                    {providers.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
                <label>Protocol
                  <select value={type} onChange={(event) => setType(event.target.value as "wireguard" | "openvpn")}>
                    <option value="wireguard">wireguard</option>
                    <option value="openvpn">openvpn</option>
                  </select>
                </label>
                {type === "wireguard" ? (
                  <>
                    <label>WireGuard private key {profile?.hasWireguardKey && <span className="muted">(stored; leave blank to keep)</span>}
                      <input type="password" autoComplete="off" value={wireguardPrivateKey} onChange={(event) => setWgKey(event.target.value)} placeholder="the PrivateKey line" />
                    </label>
                    <label>WireGuard address
                      <input value={wireguardAddresses} onChange={(event) => setWgAddr(event.target.value)} placeholder="10.64.222.21/32" />
                    </label>
                  </>
                ) : (
                  <>
                    <label>OpenVPN username
                      <input value={openvpnUser} onChange={(event) => setOvpnUser(event.target.value)} />
                    </label>
                    <label>OpenVPN password {profile?.hasOpenvpnPassword && <span className="muted">(stored; leave blank to keep)</span>}
                      <input type="password" autoComplete="off" value={openvpnPassword} onChange={(event) => setOvpnPass(event.target.value)} />
                    </label>
                  </>
                )}
                <label>Preferred countries
                  <input value={countries} onChange={(event) => setCountries(event.target.value)} placeholder="Netherlands, Switzerland" />
                </label>
              </div>

              <p className="muted vpn-security-heading">Security. The kill switch is always on: if the tunnel drops, apps lose all network rather than leaking.</p>
              <div className="vpn-toggle-grid">
                <label><input type="checkbox" checked={dot} onChange={(event) => setDot(event.target.checked)} /> DNS over TLS</label>
                <label><input type="checkbox" checked={blockMalicious} onChange={(event) => setBlockMalicious(event.target.checked)} /> Block malware domains</label>
                <label><input type="checkbox" checked={blockAds} onChange={(event) => setBlockAds(event.target.checked)} /> Block ads</label>
                <label><input type="checkbox" checked={blockSurveillance} onChange={(event) => setBlockSurveillance(event.target.checked)} /> Block trackers</label>
                <label><input type="checkbox" checked={portForwarding} onChange={(event) => setPortForwarding(event.target.checked)} /> Ask for a forwarded port (Proton)</label>
              </div>
              <div className="field-grid">
                <label>Custom DNS server <span className="muted">(optional)</span>
                  <input value={dnsAddress} onChange={(event) => setDnsAddress(event.target.value)} placeholder="leave blank for the provider's DNS" />
                </label>
                <label>Reachable LAN subnets <span className="muted">(kill switch still allows these)</span>
                  <input value={outboundSubnets} onChange={(event) => setOutboundSubnets(event.target.value)} placeholder="192.168.0.0/16, 10.0.0.0/8" />
                </label>
              </div>

              <div className="recovery-actions">
                <button className="primary-button" type="button" onClick={save} disabled={type === "wireguard" && !wireguardPrivateKey && !profile?.hasWireguardKey}>Save profile</button>
                <button className="text-button" type="button" onClick={() => { setEditing(false); setError(null); }}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}
      {dialog}
    </section>
  );
}
