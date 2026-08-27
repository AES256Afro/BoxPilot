/**
 * The reachability doctor's hands: open real connections to the addresses the planner chose.
 *
 * A task rather than helper work, because the helper runs with PrivateNetwork=true and cannot
 * open a connection at all. Every probe is a single GET with a short timeout; a certificate that
 * would not verify is reported, not refused, because "answers, but a browser will warn" is
 * exactly the evidence the owner needs.
 *
 * The URLs come from the planner, which builds them from the app's own recorded ports and this
 * host's own addresses. Validation here still pins the shape: http(s) only, a bounded count.
 */
import http from "node:http";
import https from "node:https";

const probeLimit = 12;

function probeOne(url, timeoutMs, sourceAddress = null) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch { return resolve({ outcome: "error", error: "not a valid address" }); }
    if (!["http:", "https:"].includes(target.protocol)) return resolve({ outcome: "error", error: "only http and https are probed" });
    const started = Date.now();
    const transport = target.protocol === "https:" ? https : http;
    // Binding the source to the host's own LAN address makes the kernel present this connection
    // the way a device on the network would arrive, instead of via the bridge address that
    // container firewalls quietly whitelist. The difference between those two vantages is
    // exactly how a tunnel's inbound firewall hid from every on-host check.
    const request = transport.request(target, { method: "GET", timeout: timeoutMs, rejectUnauthorized: false, ...(sourceAddress ? { localAddress: sourceAddress } : {}) }, (response) => {
      const socket = response.socket;
      const tls = target.protocol === "https:" ? (socket.authorized ? "verified" : "unverified") : null;
      response.resume();
      resolve({ outcome: "answered", status: response.statusCode, ms: Date.now() - started, ...(tls ? { tls } : {}) });
    });
    request.on("timeout", () => { request.destroy(new Error("timeout")); });
    request.on("error", (error) => {
      if (error.message === "timeout") return resolve({ outcome: "timeout", ms: Date.now() - started });
      if (error.code === "ECONNREFUSED") return resolve({ outcome: "refused", ms: Date.now() - started });
      resolve({ outcome: "error", error: error.code ?? error.message, ms: Date.now() - started });
    });
    request.end();
  });
}

export async function probeAddresses({ probes } = {}, { timeoutMs = 4000 } = {}) {
  if (!Array.isArray(probes) || probes.length === 0) return { results: [] };
  if (probes.length > probeLimit) throw new Error(`At most ${probeLimit} addresses are probed at once`);
  const results = await Promise.all(probes.map(async (probe) => {
    if (!probe || typeof probe.id !== "string" || typeof probe.url !== "string") return { id: String(probe?.id ?? "?"), outcome: "error", error: "malformed probe" };
    return { id: probe.id, url: probe.url, ...(await probeOne(probe.url, timeoutMs, typeof probe.sourceAddress === "string" ? probe.sourceAddress : null)) };
  }));
  return { results };
}
