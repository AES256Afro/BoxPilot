/**
 * The shared VPN profile (M17.4): one VPN connection, configured once, that any catalog app can be
 * routed through instead of re-typing the provider and keys for every app.
 *
 * BoxPilot's VPN apps (qBittorrent, Stremio, and any manifest that opts in) each run their own
 * Gluetun sidecar. Left to themselves that means entering the same WireGuard key once per app. This
 * store holds that connection once, in a root-owned file (0600) beside the credential store, and the
 * app helper injects it into a linked app's sidecar at deploy. The web process never reads the file;
 * it sees only the redacted description, mirrored to a setting when the profile is saved.
 *
 * The private key and OpenVPN password are secrets and live only here. Everything else is a knob for
 * tightening what the tunnel allows: which countries, DNS-over-TLS, malware/ad/tracker blocklists,
 * which LAN subnets an app may still reach with the kill switch on, and where the health check pings.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const defaultVpnProfileFile = process.env.BOXPILOT_VPN_PROFILE_FILE ?? "/var/lib/boxpilot-managed/vpn-profile.json";

// The providers Gluetun knows by name, plus "custom" for a hand-supplied WireGuard config. Kept in
// step with the options offered on the VPN-capable manifests.
export const vpnProviders = Object.freeze(["mullvad", "protonvpn", "nordvpn", "surfshark", "private internet access", "airvpn", "windscribe", "ivpn", "custom"]);
export const vpnProtocols = Object.freeze(["wireguard", "openvpn"]);
const onOff = Object.freeze(["on", "off"]);

const secretLimit = 4096;
const textLimit = 512;
const listLimit = 1024;

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  return value;
}

function optionalText(value, field, limit = textLimit) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > limit) throw new Error(`${field} must be text, ${limit} characters at most`);
  return value.trim();
}

function optionalSecret(value, field) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > secretLimit) throw new Error(`${field} must be text, ${secretLimit} characters at most`);
  return value;
}

/**
 * Validate and normalise the profile a request supplies into the shape stored on disk. Secrets that
 * the request leaves blank keep whatever the previous profile held, so a settings save that only
 * changes the country list does not wipe the key.
 */
export function normalizeVpnProfile(input = {}, previous = null) {
  if (typeof input !== "object" || input === null) throw new Error("A VPN profile is an object");
  const provider = requireEnum(input.provider ?? "mullvad", vpnProviders, "provider");
  const type = requireEnum(input.type ?? "wireguard", vpnProtocols, "protocol");
  const wireguardPrivateKey = optionalSecret(input.wireguardPrivateKey, "WireGuard private key") || previous?.wireguardPrivateKey || "";
  const openvpnPassword = optionalSecret(input.openvpnPassword, "OpenVPN password") || previous?.openvpnPassword || "";
  if (type === "wireguard" && !wireguardPrivateKey) throw new Error("WireGuard needs a private key");
  if (type === "openvpn" && !(optionalText(input.openvpnUser, "OpenVPN username") && openvpnPassword)) throw new Error("OpenVPN needs a username and password");
  const outboundSubnets = optionalText(input.outboundSubnets, "Reachable LAN subnets", listLimit);
  if (outboundSubnets && !/^[0-9./,\s]+$/.test(outboundSubnets)) throw new Error("Reachable LAN subnets is a comma-separated list of CIDR ranges");
  return {
    provider,
    type,
    wireguardPrivateKey,
    wireguardAddresses: optionalText(input.wireguardAddresses, "WireGuard address"),
    openvpnUser: optionalText(input.openvpnUser, "OpenVPN username"),
    openvpnPassword,
    countries: optionalText(input.countries, "Preferred countries"),
    portForwarding: requireEnum(input.portForwarding ?? "off", onOff, "port forwarding"),
    dot: requireEnum(input.dot ?? "on", onOff, "DNS over TLS"),
    blockMalicious: requireEnum(input.blockMalicious ?? "on", onOff, "block malware"),
    blockAds: requireEnum(input.blockAds ?? "off", onOff, "block ads"),
    blockSurveillance: requireEnum(input.blockSurveillance ?? "off", onOff, "block trackers"),
    dnsAddress: optionalText(input.dnsAddress, "Custom DNS address"),
    outboundSubnets,
    healthTargetAddress: optionalText(input.healthTargetAddress, "Health-check address"),
  };
}

/** The env a linked app's connection fields take: keyed by the Gluetun variable names the manifests use. */
export function profileConnectionEnv(profile) {
  if (!profile) return {};
  return {
    VPN_SERVICE_PROVIDER: profile.provider,
    VPN_TYPE: profile.type,
    WIREGUARD_PRIVATE_KEY: profile.wireguardPrivateKey,
    WIREGUARD_ADDRESSES: profile.wireguardAddresses,
    OPENVPN_USER: profile.openvpnUser,
    OPENVPN_PASSWORD: profile.openvpnPassword,
    SERVER_COUNTRIES: profile.countries,
    VPN_PORT_FORWARDING: profile.portForwarding,
  };
}

/** The extra security env merged into a linked app's Gluetun sidecar. Empty optional fields are left out. */
export function profileSecurityEnv(profile) {
  if (!profile) return {};
  const env = {
    DOT: profile.dot,
    BLOCK_MALICIOUS: profile.blockMalicious,
    BLOCK_ADS: profile.blockAds,
    BLOCK_SURVEILLANCE: profile.blockSurveillance,
  };
  if (profile.dnsAddress) env.DNS_ADDRESS = profile.dnsAddress;
  if (profile.outboundSubnets) env.FIREWALL_OUTBOUND_SUBNETS = profile.outboundSubnets;
  if (profile.healthTargetAddress) env.HEALTH_TARGET_ADDRESS = profile.healthTargetAddress;
  return env;
}

/** The non-secret view the interface is allowed to see: booleans stand in for the two secrets. */
export function describeVpnProfile(profile) {
  if (!profile) return { configured: false };
  const { wireguardPrivateKey, openvpnPassword, ...rest } = profile;
  return {
    configured: true,
    ...rest,
    hasWireguardKey: Boolean(wireguardPrivateKey),
    hasOpenvpnPassword: Boolean(openvpnPassword),
  };
}

export function createVpnProfileStore({ file = defaultVpnProfileFile, now = () => new Date() } = {}) {
  async function load() {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function save(profile) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
    // Write-then-rename with a unique temp name, so a crash mid-write can never truncate the profile
    // and two concurrent writers cannot rename a half-written blend of both over it.
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(profile, null, 2), { mode: 0o600 });
    await rename(temp, file);
  }

  /** Save the profile; returns the redacted description for the record hook to mirror to a setting. */
  async function set(input, { updatedBy = null } = {}) {
    const previous = await load();
    const normalized = normalizeVpnProfile(input, previous);
    const profile = { ...normalized, updatedAt: now().toISOString(), updatedBy };
    await save(profile);
    return describeVpnProfile(profile);
  }

  async function clear() {
    // Remove the file outright rather than keeping a copy: it holds the private key, and the profile
    // is re-enterable, so a stale copy on disk would be the bigger hazard.
    await rm(file, { force: true });
    return { configured: false };
  }

  /** The full profile, read only inside the root task that deploys a linked app. */
  async function read() {
    return load();
  }

  async function describe() {
    return describeVpnProfile(await load());
  }

  return { set, clear, read, describe };
}
