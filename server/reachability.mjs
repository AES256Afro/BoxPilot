/**
 * The reachability doctor's reasoning (M15.1): which addresses an app should answer on, and what
 * each probe's outcome means.
 *
 * "Unable to reach the panel" once took six rounds of live diagnosis: a firewall inside a VPN
 * sidecar, an app validating the port in the Host header, a browser HSTS preload covering all of
 * ts.net, an exposure mode that had moved the binding. Every one of those checks was mechanical.
 * This module plans them and reads their results; the probing itself happens in a task, because
 * the helper runs with PrivateNetwork=true and cannot open a connection at all.
 *
 * Pure on purpose: facts in, probe plan out; probe results in, verdicts out. The security surface
 * is that probe URLs are built here, from the app's own recorded ports and this host's own
 * addresses, never from anything a browser sent.
 */

/** Everything the planner needs to know, gathered by the helper from its own records. */
export function planProbes(facts, serves = []) {
  const addresses = [];
  for (const port of facts.ports ?? []) {
    if (port.protocol === "udp") continue;
    const served = serves.find((serve) => serve.port === port.host);
    if (served) {
      addresses.push({
        portId: port.id, portLabel: port.label, kind: "serve",
        url: `https://${served.dnsName}:${served.port}`, probe: true,
        note: "Tailscale Serve holds this address with a real certificate; it works in any browser on your tailnet.",
      });
    }
    // Bound to the box itself: either genuinely private, or the local end of a Serve proxy.
    if (port.exposure === "loopback") {
      addresses.push({ portId: port.id, portLabel: port.label, kind: "loopback", url: `http://127.0.0.1:${port.host}`, probe: true, note: served ? "The local end of the Serve address above." : "Reachable from this server only." });
      continue;
    }
    if (port.exposure === "tailnet") {
      if (facts.tailnetAddress) addresses.push({ portId: port.id, portLabel: port.label, kind: "tailnet", url: `http://${facts.tailnetAddress}:${port.host}`, probe: true, note: shortNameNote(facts) });
      continue;
    }
    if (facts.lanAddress) addresses.push({ portId: port.id, portLabel: port.label, kind: "lan", url: `http://${facts.lanAddress}:${port.host}`, probe: true, note: null });
    if (facts.tailnetAddress) addresses.push({ portId: port.id, portLabel: port.label, kind: "tailnet", url: `http://${facts.tailnetAddress}:${port.host}`, probe: true, note: shortNameNote(facts) });
  }
  // The form browsers refuse no matter what the server does, explained rather than probed:
  // Tailscale registered all of ts.net on the browsers' HSTS preload list.
  if (facts.tailnetDnsName && addresses.some((address) => address.kind === "tailnet")) {
    addresses.push({
      portId: null, portLabel: null, kind: "browser-rule", url: `http://${facts.tailnetDnsName}:<port>`, probe: false,
      note: "Browsers refuse this form outright: ts.net is on their built-in HSTS preload list, so plain http on the full name is rewritten to https and nothing answers. Use the short name or the Serve address.",
    });
  }
  return addresses.map((address, index) => ({ id: `probe-${index}`, ...address }));
}

function shortNameNote(facts) {
  const short = facts.tailnetDnsName ? facts.tailnetDnsName.split(".")[0] : null;
  return short ? `In a browser on your tailnet, use http://${short}:<port> (the short name; the full ts.net name only works for https through Serve).` : null;
}

/**
 * One verdict per planned address, and a headline when the app cannot answer anywhere.
 * Probes ran on the server itself, and the wording says so: a timeout from here is the server's
 * own path, not proof about yours.
 */
export function composeVerdicts(addresses, probeResults, facts) {
  const byId = new Map((probeResults ?? []).map((result) => [result.id, result]));
  const troubled = (facts.sidecars ?? []).find((sidecar) => !sidecar.running || sidecar.status === "restarting");
  const headline = !facts.installed ? "The app is not installed."
    : troubled ? `The ${troubled.id} container is ${troubled.status === "restarting" ? "restarting over and over" : "not running"}; nothing will answer on any address until it runs. Its log says why.`
    : !facts.running ? "The app's container is not running, so nothing answers on any address."
    : null;

  const verdicts = addresses.map((address) => {
    if (!address.probe) return { ...address, outcome: "not-probed", verdict: address.note };
    const result = byId.get(address.id);
    if (!result) return { ...address, outcome: "not-probed", verdict: "The probe did not run." };
    if (result.outcome === "answered") {
      const warning = result.tls === "unverified" ? "; the certificate is self-signed, so a browser shows a warning first" : "";
      return { ...address, outcome: "answered", status: result.status, ms: result.ms, verdict: `Answers (HTTP ${result.status} in ${result.ms}ms${warning}).` };
    }
    if (result.outcome === "refused") {
      return { ...address, outcome: "refused", verdict: "Nothing is listening on this address. If the app was just moved between home network and Tailscale-only, this side is switched off on purpose." };
    }
    if (result.outcome === "timeout") {
      return { ...address, outcome: "timeout", verdict: "The connection was silently dropped, which is what a firewall in the path looks like. The probe ran from the server itself, so the block is on this machine or inside the app's own network." };
    }
    return { ...address, outcome: "error", verdict: `The probe failed: ${result.error ?? "unknown error"}.` };
  });
  return { headline, addresses: verdicts, probedFrom: "this server" };
}
