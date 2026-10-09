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
 * Every operation that ends in the deployer re-rendering an app's compose file. Each gets the
 * resolver as its prepare hook: one left out re-resolves inside the helper, finds nothing, and
 * drops an optional device (Jellyfin's GPU) or refuses a required one (Zigbee2MQTT's stick).
 */
export const deviceResolvingOperations = Object.freeze(["app.install", "app.update", "app.reconfigure", "app.reinstall", "app.rollback", "app.exposure.set", "app.password.set"]);

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

/**
 * The same for a machine snapshot restore (host.snapshot.restore), which installs every app it
 * brings back: `devicesByApp`, app id to the devices found here, for each catalog app that globs for
 * one (only those named in `apps` when it names them). The web process cannot read the snapshot to
 * know which apps are in it, and asking /dev for the handful that want a device costs nothing. Its
 * own list replaces whatever the request carried, so a browser cannot name devices for an app.
 */
export function createSnapshotDeviceResolver({ catalog, listDirectory = (directory) => readdir(directory) }) {
  return async function withDevicesByApp(parameters) {
    const { manifests = [] } = await catalog.all().catch(() => ({ manifests: [] }));
    const chosen = Array.isArray(parameters?.apps) ? new Set(parameters.apps) : null;
    const devicesByApp = {};
    for (const manifest of manifests) {
      if (chosen && !chosen.has(manifest.id)) continue;
      const patterns = [...(manifest.devices ?? []), ...(manifest.optionalDevices ?? [])];
      if (!patterns.some((pattern) => globCharacters.test(pattern))) continue;
      devicesByApp[manifest.id] = await resolveDevices(patterns, listDirectory);
    }
    return { ...parameters, devicesByApp };
  };
}
