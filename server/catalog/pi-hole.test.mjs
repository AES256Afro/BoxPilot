/**
 * Pi-hole in the catalog: its listening mode is the owner's to choose. Fixed to `all`, pihole-FTL
 * on the host's network held port 53 on every address, and libvirt's default VM network could not
 * start, since its own dnsmasq needs port 53 on the network's gateway address. `bind` is Pi-hole's
 * own answer to another DNS server on the same machine, and the container sets every FTLCONF_*
 * value from its environment at each start, so only a catalog setting survives a restart.
 */
import { describe, expect, it } from "vitest";
import { renderCompose } from "./compose.mjs";
import { loadCatalog } from "./index.mjs";
import { resolveValues } from "./schema.mjs";

const setting = "FTLCONF_dns_listeningMode";

async function piHole() {
  const { manifests, problems } = await loadCatalog();
  expect(problems.filter((problem) => problem.file === "pi-hole.yaml")).toEqual([]);
  return manifests.find((manifest) => manifest.id === "pi-hole");
}

describe("the Pi-hole manifest", () => {
  it("offers Pi-hole's four listening modes, all by default, and says when bind is the one to pick", async () => {
    const manifest = await piHole();
    const listening = manifest.env.find((entry) => entry.name === setting);
    expect(listening).toMatchObject({ label: "Listening mode", options: ["all", "local", "single", "bind"], default: "all", fixed: false, required: false, secret: false, type: "string" });
    // Each mode is offered in words, with what it does said under the field when it is the one chosen;
    // the value stored and handed to pihole-FTL is still Pi-hole's own word.
    expect(listening.optionLabels.map((option) => [option.value, option.label])).toEqual([["all", "Everyone who asks"], ["local", "Only this network"], ["single", "The main connection only"], ["bind", "The main connection, leaving other addresses free"]]);
    for (const option of listening.optionLabels) expect(option.hint).toBeTruthy();
    const bind = listening.optionLabels.find((option) => option.value === "bind");
    expect(bind.hint).toMatch(/Pick this when another DNS server runs on this machine/);
    expect(bind.hint).toContain("libvirt");
    const upstream = manifest.env.find((entry) => entry.name === "FTLCONF_dns_upstreams");
    expect(upstream.default).toBe("9.9.9.9;149.112.112.112");
    expect(upstream.optionLabels.map((option) => [option.value, option.label])).toEqual([["9.9.9.9;149.112.112.112", "Quad9"], ["1.1.1.1;1.0.0.1", "Cloudflare"], ["8.8.8.8;8.8.4.4", "Google"], ["94.140.14.14;94.140.15.15", "AdGuard"], ["unbound#53", "The bundled resolver (Unbound)"]]);
    // The host-mode note still covers systemd-resolved, and now points at the setting.
    expect(manifest.notes).toContain("DNSStubListener=no");
    expect(manifest.notes).toContain("Listening mode setting");
  });

  it("takes a chosen mode as written, falls back to all, and refuses one Pi-hole does not offer", async () => {
    const manifest = await piHole();
    expect(resolveValues(manifest, {}).values.env[setting]).toBe("all");
    expect(resolveValues(manifest, { env: { [setting]: "" } }).values.env[setting]).toBe("all");
    for (const mode of ["local", "single", "bind"]) {
      const { values, errors } = resolveValues(manifest, { env: { [setting]: mode } });
      expect(errors).toEqual([]);
      expect(values.env[setting]).toBe(mode);
    }
    for (const bad of ["BIND", "none", "bind-interfaces"]) {
      expect(resolveValues(manifest, { env: { [setting]: bad } }).errors).toEqual([`values.env.${setting}: must be one of all, local, single, bind`]);
    }
  });

  it("hands the chosen mode to pihole-FTL on the host's network, where it matters", async () => {
    const manifest = await piHole();
    const { values, errors } = resolveValues(manifest, { networkMode: "host", env: { [setting]: "bind" } });
    expect(errors).toEqual([]);
    const { compose } = renderCompose(manifest, values, { lanAddress: "192.168.1.10" });
    expect(compose.services["pi-hole"].network_mode).toBe("host");
    expect(compose.services["pi-hole"].environment[setting]).toBe("bind");
    // Nothing else about the DNS ports changed: on the host's network they are still Pi-hole's own.
    expect(compose.services["pi-hole"].ports).toBeUndefined();
  });
});
