/**
 * Resolve a manifest's device globs (`/dev/sd?`, `/dev/ttyUSB?`) in the web process.
 *
 * The root helper runs with `PrivateDevices=yes` and `DevicePolicy=closed`, so its /dev holds
 * only a handful of pseudo-devices: resolving there matched nothing and every app that declares
 * a device (Scrutiny, ESPHome, Zigbee2MQTT, Z-Wave JS UI, OctoPrint) refused to install. The web
 * service sees the real /dev, so an install/update/reconfigure job carries the concrete paths and
 * the deployer keeps only the ones its manifest actually asked for.
 */
import { readdir } from "node:fs/promises";
import { resolveDevices } from "./compose.mjs";

const globCharacters = /[?*[]/;

/**
 * Add a `devices` list to the parameters when the app's manifest globs for devices.
 * Unknown apps and manifests without globs pass through untouched.
 */
export function createDeviceResolver({ catalog, listDirectory = (directory) => readdir(directory) }) {
  return async function withResolvedDevices(parameters) {
    const manifest = await catalog.get(parameters?.id).catch(() => null);
    const patterns = [...(manifest?.devices ?? []), ...(manifest?.optionalDevices ?? [])];
    if (!patterns.some((pattern) => globCharacters.test(pattern))) return parameters;
    return { ...parameters, devices: await resolveDevices(patterns, listDirectory) };
  };
}
