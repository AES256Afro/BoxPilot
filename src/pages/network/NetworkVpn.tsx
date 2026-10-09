import { useCallback, useEffect, useState } from "react";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { relativeTime } from "../../home/format";
import { readJson } from "../../http";
import { Button, Checkbox, EmptyState, Field, KeyValue, Notice, Panel, SecretInput, Select, Sheet, Tag, TextInput, mayStart, riskOf } from "../../ui";

/*
 * The Network page's VPN tab (M33.10): the shared VPN profile (M17.4), one VPN connection set up
 * once that any VPN-capable app (qBittorrent, Stremio) is routed through with a switch on its own
 * page. The key lives in a root-owned file on the server; this page only ever sees the redacted
 * description, and only the owner reads or changes it.
 */

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

const on = (value: string | undefined) => value === "on";

export interface NetworkVpnProps {
  role: string;
  start: (operation: PendingOperation) => void;
  refreshKey: number;
  now: number;
}

export function NetworkVpn({ role, start, refreshKey, now }: NetworkVpnProps) {
  const isOwner = role === "owner";
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

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

  const refresh = useCallback(async () => {
    if (!isOwner) return;
    try {
      const body = await readJson<Payload>(await fetch("/api/v1/settings/vpn-profile"));
      if (!Array.isArray(body.providers)) throw new Error("The VPN profile came back in a shape this page cannot read.");
      setData(body);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The VPN profile could not be read");
    }
  }, [isOwner]);
  // A finished job bumps refreshKey. The secrets typed are forgotten once a save completes (below),
  // not on any job's end: a failed save used to empty the key along with it.
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  if (!isOwner) return <Notice tone="info" title="The VPN profile is the owner's">It holds the VPN's key, so only the owner reads or changes it.</Notice>;

  const profile = data?.profile ?? null;
  const configured = Boolean(profile?.configured);
  const providers = data?.providers?.length ? data.providers : ["mullvad"];
  const protocols = data?.protocols?.length ? data.protocols : ["wireguard", "openvpn"];

  const beginEdit = () => {
    if (profile?.configured) {
      setProvider(profile.provider ?? "mullvad");
      setType(profile.type ?? "wireguard");
      setWgAddr(profile.wireguardAddresses ?? "");
      setOvpnUser(profile.openvpnUser ?? "");
      setCountries(profile.countries ?? "");
      setPortForwarding(on(profile.portForwarding));
      setDot(on(profile.dot));
      setBlockMalicious(on(profile.blockMalicious));
      setBlockAds(on(profile.blockAds));
      setBlockSurveillance(on(profile.blockSurveillance));
      setDnsAddress(profile.dnsAddress ?? "");
      setOutboundSubnets(profile.outboundSubnets ?? "");
    }
    setWgKey(""); setOvpnPass("");
    setEditing(true);
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
    setEditing(false);
    start({
      operationId: "vpn.profile.set",
      title: "Save the VPN profile",
      parameters,
      preview: <span>Saves this VPN connection to a root-owned file on the server. Apps you route through the profile use it at their next deploy; the key never appears in a job record or the database.</span>,
      // The sheet closes for the approval. It comes back as it was filled in, key and all, unless the
      // save completed; then the key typed for it is forgotten.
      onClosed: (job) => {
        if (job?.state === "completed") { setWgKey(""); setOvpnPass(""); } else setEditing(true);
      },
    });
  };

  const remove = () => start({ operationId: "vpn.profile.clear", title: "Remove the VPN profile", parameters: {}, preview: <span>Deletes the saved profile. Apps already routed through it keep running, but refuse to redeploy until it is saved again or given their own connection.</span> });
  const canSave = mayStart(role, "vpn.profile.set");
  const canClear = mayStart(role, "vpn.profile.clear");
  const keyStored = Boolean(profile?.hasWireguardKey || profile?.hasOpenvpnPassword);
  const keyMissing = type === "wireguard" && !wireguardPrivateKey && !profile?.hasWireguardKey;
  const features = profile ? [
    on(profile.dot) && "DNS over TLS",
    on(profile.blockMalicious) && "Block malware",
    on(profile.blockAds) && "Block ads",
    on(profile.blockSurveillance) && "Block trackers",
    on(profile.portForwarding) && "Port forwarding",
  ].filter((entry): entry is string => Boolean(entry)) : [];

  return (
    <>
      {error && <Notice tone="danger" live title="The VPN profile could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}

      <Panel
        padded={configured}
        className="network-vpn"
        title="VPN profile"
        count={!data ? undefined : configured ? { status: "good", label: "set up" } : { status: "neutral", label: "not set up" }}
        meta={configured ? <><b>{profile?.provider}</b> · {profile?.type}</> : undefined}
        actions={configured ? <>
          {canSave && <Button onClick={beginEdit}>Change…</Button>}
          {canClear && <Button risk={riskOf("vpn.profile.clear")} onClick={remove}>Remove</Button>}
        </> : undefined}
        footer={configured ? <>Apps with &ldquo;Use my VPN profile&rdquo; on (qBittorrent, Stremio) use it; a change reaches each at its next deploy.</> : undefined}
      >
        {!data ? <p className="network-dim network-pad">{error ? "Not read." : "Reading…"}</p>
          : !configured ? (
            <EmptyState title="No VPN profile" action={canSave ? <Button variant="primary" onClick={beginEdit}>Set up a VPN profile…</Button> : undefined}>
              One VPN connection, set up once, that any VPN app can be routed through with one switch instead of entering the key per app.
            </EmptyState>
          ) : (
            <>
              <KeyValue layout="columns" items={[
                { id: "provider", label: "Provider", value: profile?.provider ?? "—" },
                { id: "protocol", label: "Protocol", value: profile?.type ?? "—", mono: true },
                { id: "countries", label: "Countries", value: profile?.countries || "Provider's choice" },
                { id: "key", label: "Key", value: keyStored ? "Stored" : "Missing", status: keyStored ? "good" : "danger" },
                ...(profile?.outboundSubnets ? [{ id: "lan", label: "LAN still reachable", value: profile.outboundSubnets, mono: true }] : []),
                ...(profile?.dnsAddress ? [{ id: "dns", label: "DNS server", value: profile.dnsAddress, mono: true }] : []),
                ...(profile?.updatedAt ? [{ id: "updated", label: "Saved", value: relativeTime(profile.updatedAt, now) ?? profile.updatedAt, mono: true }] : []),
              ]} />
              <p className="network-tags" aria-label="Security options">
                <Tag tone="good">kill switch</Tag>
                {features.map((feature) => <Tag key={feature}>{feature}</Tag>)}
              </p>
            </>
          )}
      </Panel>

      {editing && (
        <Sheet
          kicker="VPN profile"
          title={configured ? "Change the VPN profile" : "Set up a VPN profile"}
          size="lg"
          onClose={() => setEditing(false)}
          footer={<>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" risk={riskOf("vpn.profile.set")} disabled={keyMissing} onClick={save}>Save profile</Button>
          </>}
        >
          <div className="network-form">
            <Field label="VPN provider"><Select value={provider} onValueChange={setProvider} options={providers.map((name) => ({ value: name, label: name }))} /></Field>
            <Field label="Protocol"><Select mono value={type} onValueChange={(value) => setType(value as "wireguard" | "openvpn")} options={protocols.map((name) => ({ value: name, label: name }))} /></Field>
            {type === "wireguard" ? (
              <>
                <Field label="WireGuard private key" required={!profile?.hasWireguardKey} hint={profile?.hasWireguardKey ? "Stored: leave it blank to keep it." : "The PrivateKey line from the provider's configuration."}>
                  <SecretInput value={wireguardPrivateKey} onValueChange={setWgKey} placeholder={profile?.hasWireguardKey ? "stored" : "PrivateKey"} revealLabel="Show the key" />
                </Field>
                <Field label="WireGuard address"><TextInput mono value={wireguardAddresses} onValueChange={setWgAddr} placeholder="10.64.222.21/32" /></Field>
              </>
            ) : (
              <>
                <Field label="OpenVPN username"><TextInput mono value={openvpnUser} onValueChange={setOvpnUser} autoComplete="off" /></Field>
                <Field label="OpenVPN password" hint={profile?.hasOpenvpnPassword ? "Stored: leave it blank to keep it." : undefined}>
                  <SecretInput value={openvpnPassword} onValueChange={setOvpnPass} revealLabel="Show the password" />
                </Field>
              </>
            )}
            <Field label="Preferred countries" optional><TextInput value={countries} onValueChange={setCountries} placeholder="Netherlands, Switzerland" /></Field>
          </div>
          <section className="network-sheet-part" aria-label="Security">
            <h3 className="network-sheet-heading">Security</h3>
            <p className="network-note">The kill switch is always on: if the tunnel drops, apps lose all network rather than leaking.</p>
            <div className="network-checks">
              <Checkbox label="DNS over TLS" checked={dot} onChange={setDot} />
              <Checkbox label="Block malware domains" checked={blockMalicious} onChange={setBlockMalicious} />
              <Checkbox label="Block ads" checked={blockAds} onChange={setBlockAds} />
              <Checkbox label="Block trackers" checked={blockSurveillance} onChange={setBlockSurveillance} />
              <Checkbox label="Ask for a forwarded port" description="Proton" checked={portForwarding} onChange={setPortForwarding} />
            </div>
          </section>
          <div className="network-form">
            <Field label="Custom DNS server" optional hint="Leave it blank for the provider's DNS."><TextInput mono value={dnsAddress} onValueChange={setDnsAddress} /></Field>
            <Field label="Reachable LAN subnets" optional hint="The kill switch still lets these through."><TextInput mono value={outboundSubnets} onValueChange={setOutboundSubnets} placeholder="192.168.0.0/16, 10.0.0.0/8" /></Field>
          </div>
        </Sheet>
      )}
    </>
  );
}
