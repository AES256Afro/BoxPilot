import { getSetupPlan, validateDomainName } from "./libvirt.mjs";

export function buildConsoleGuidanceResponse(guidance) {
  const reportedDnsName = guidance?.tailscaleDnsName ?? null;
  const dnsName = typeof reportedDnsName === "string" && reportedDnsName.length <= 253 && /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(reportedDnsName) ? reportedDnsName : null;
  const cockpitActive = guidance?.cockpit?.active === true && guidance?.cockpit?.port === 9090;
  return {
    ...guidance,
    privateUrl: cockpitActive && dnsName ? `https://${dnsName}:9090/` : null,
    accessNote: cockpitActive
      ? "Cockpit is a separate service with its own authentication and TLS. Use only the Tailscale hostname and verify its exposure before opening it."
      : "No web console handoff is active. Use guest SSH, a physical console, or install and secure Cockpit separately.",
  };
}

export function createHelperLibvirtService({ helper }) {
  async function inspect(scope) {
    try {
      return await helper.request("virtualization.inventory.inspect", { scope });
    } catch {
      throw new Error("Restricted virtualization helper is unavailable");
    }
  }

  async function getStatus() {
    try {
      return await inspect("status");
    } catch (error) {
      return {
        platform: process.platform,
        architecture: process.arch,
        connectionUri: "qemu:///system",
        ready: false,
        checks: [{ id: "helper", label: "Restricted helper libvirt access", ok: false, detail: error.message }],
        resources: { network: { exists: false, active: false }, pool: { exists: false, active: false } },
        tailscale: { installed: false, connected: false, dnsName: null, serveUrls: [] },
        setupPlan: getSetupPlan(),
      };
    }
  }

  async function listDomains() {
    try {
      return await inspect("domains");
    } catch (error) {
      return { connected: false, domains: [], error: error.message };
    }
  }

  async function listResources() {
    try {
      return await inspect("resources");
    } catch (error) {
      return { connected: false, networks: [], pools: [], errors: [error.message] };
    }
  }

  async function getDomain(name) {
    if (!validateDomainName(name)) return null;
    const result = await listDomains();
    if (!result.connected) throw new Error(result.error ?? "Restricted virtualization helper is unavailable");
    return result.domains.find((domain) => domain.name === name) ?? null;
  }

  async function getConsoleGuidance() {
    try {
      return await helper.request("virtualization.console.inspect", {});
    } catch {
      return { nativeProxyAvailable: false, cockpit: { installed: false, active: false, enabled: false, port: 9090 }, tailscaleDnsName: null };
    }
  }

  return { getStatus, listDomains, listResources, getDomain, getConsoleGuidance };
}
