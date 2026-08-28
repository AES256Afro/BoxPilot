/**
 * The shared VPN profile (M17.4): configure one VPN connection, then route any VPN-capable app
 * through it instead of re-entering the provider and keys per app.
 *
 * The profile lives in a root-owned file (see vpn-profile.mjs); these operations are the only way to
 * write it. The private key and OpenVPN password ride the ordinary secret-parameter machinery, so
 * they never reach a job record or the database. The non-secret description is mirrored to the
 * `vpnProfile` setting by a record hook so the interface can show what is configured.
 */
import { defineOperation } from "./registry.mjs";
import { vpnProviders, vpnProtocols } from "../vpn-profile.mjs";

const minutes = (count) => count * 60_000;
const onOff = { type: "string", optional: true, enum: ["on", "off"] };
const text = (maxLength) => ({ type: "string", optional: true, maxLength });

export function vpnOperations() {
  return [
    defineOperation({
      id: "vpn.profile.set", title: "Save the VPN profile", risk: "medium", timeoutMs: minutes(1), minimumRole: "owner",
      description: "Saves one VPN connection (provider, keys, and security options) in a root-owned file on this server. Apps you route through it read the connection from here at deploy, so the key is entered once rather than per app. The private key and OpenVPN password are never returned to the interface.",
      parameters: { fields: {
        provider: { type: "string", enum: vpnProviders },
        type: { type: "string", enum: vpnProtocols },
        wireguardPrivateKey: { type: "string", optional: true, maxLength: 4096, secret: true },
        wireguardAddresses: text(512),
        openvpnUser: text(512),
        openvpnPassword: { type: "string", optional: true, maxLength: 4096, secret: true },
        countries: text(512),
        portForwarding: onOff,
        dot: onOff,
        blockMalicious: onOff,
        blockAds: onOff,
        blockSurveillance: onOff,
        dnsAddress: text(512),
        outboundSubnets: text(1024),
        healthTargetAddress: text(512),
      } },
      run: (parameters, { vpnProfile }) => vpnProfile.set(parameters),
    }),
    defineOperation({
      id: "vpn.profile.clear", title: "Remove the VPN profile", risk: "medium", timeoutMs: minutes(1), minimumRole: "owner",
      description: "Deletes the saved VPN profile. Apps still routed through it keep running on the connection they already have, but will refuse to redeploy until the profile is saved again or the app is given its own connection.",
      parameters: { fields: {} },
      run: (parameters, { vpnProfile }) => vpnProfile.clear(),
    }),
    defineOperation({
      id: "vpn.profile.inspect", title: "Show the VPN profile", risk: "low", readOnly: true, timeoutMs: 30_000, minimumRole: "owner",
      description: "The saved VPN profile without its secrets: provider, protocol, countries, and security options, plus whether a key is stored.",
      parameters: { fields: {} },
      run: (parameters, { vpnProfile }) => vpnProfile.describe(),
    }),
  ];
}
