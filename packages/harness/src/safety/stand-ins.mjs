/**
 * Stand-ins for what identifies a house (M45.3, docs/HARNESS.md "What may leave the box"). Before a
 * conversation leaves for a remote model, the names that say whose house this is are replaced with
 * stable stand-ins: `host-1` for a host name, `site-1.example` for a domain (the host's own, and any
 * tailnet, .local, .lan, .home.arpa or .internal name), `user-1` for an account, an address from
 * the documentation ranges for a private address, a locally administered MAC for a MAC. The map
 * stays here; the answer is turned back before anyone reads it.
 *
 * Stable for the run: the same name gets the same stand-in on every call, so the remote model's cache
 * and its reasoning stay consistent. The stand-ins are chosen from what never appears in a real
 * house's data (RFC 5737 addresses, the .example domain, locally administered MACs), so turning them
 * back cannot mistake a real value for one.
 *
 * Secrets are not this module's: they are redacted before anything reaches it.
 */

const privateIpv4 = /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})(?![\d.]*\d)/g;
const mac = /(?<![0-9A-Fa-f:-])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:-])/g;
/** Names only a house's own network answers: a tailnet's, mDNS's, a router's. Each label bounded, so it reads in linear time. */
const localDomain = /(?<![A-Za-z0-9.-])[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,6}\.(?:ts\.net|local|lan|home\.arpa|internal)(?![A-Za-z0-9-])/gi;
/** Stand-ins, as they come back: what show() looks for. */
const standInShape = /\b(?:host-\d+|user-\d+|site-\d+\.example|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+|02:00:00:00:[0-9a-f]{2}:[0-9a-f]{2})\b/gi;

/** Account names too common to replace as words: they say nothing about whose house it is. */
const commonNames = new Set(["root", "admin", "user", "users", "pi", "ubuntu", "test", "guest", "nobody", "daemon", "www-data", "docker", "boxpilot", "home", "media", "backup", "data", "share", "public"]);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The nth address from the documentation ranges: 192.0.2.1 to .254, then 198.51.100.x, then 203.0.113.x. */
function documentationAddress(index) {
  const ranges = ["192.0.2", "198.51.100", "203.0.113"];
  const range = ranges[Math.floor(index / 254)];
  if (!range) throw new RangeError("More private addresses than stand-ins for them");
  return `${range}.${(index % 254) + 1}`;
}

function documentationMac(index) {
  if (index > 0xffff) throw new RangeError("More MAC addresses than stand-ins for them");
  const hex = index.toString(16).padStart(4, "0");
  return `02:00:00:00:${hex.slice(0, 2)}:${hex.slice(2)}`;
}

/**
 * `names`: what identifies this house, as the host knows it: `{ hosts, domains, users }`, each a
 * list of strings. Private addresses and MACs are found by their shape.
 */
export function createStandIns({ hosts = [], domains = [], users = [] } = {}) {
  const forward = new Map();
  const backward = new Map();
  const counts = { host: 0, site: 0, user: 0, address: 0, mac: 0 };
  const assign = (original, kind, make) => {
    const known = forward.get(original);
    if (known) return known;
    const standIn = make(counts[kind]);
    counts[kind] += 1;
    forward.set(original, standIn);
    backward.set(standIn.toLowerCase(), original);
    return standIn;
  };

  const clean = (list) => [...new Set(list.map((value) => String(value ?? "").trim()).filter((value) => value.length >= 2))];
  // Longest first, so `nas.home.lan` is replaced whole before `nas` is.
  const literals = [
    ...clean(domains).map((value) => ({ value, kind: "site", make: (n) => `site-${n + 1}.example` })),
    ...clean(hosts).map((value) => ({ value, kind: "host", make: (n) => `host-${n + 1}` })),
    ...clean(users).filter((value) => !commonNames.has(value.toLowerCase())).map((value) => ({ value, kind: "user", make: (n) => `user-${n + 1}` })),
  ].sort((a, b) => b.value.length - a.value.length);
  const literalPattern = literals.length
    ? new RegExp(`(?<![A-Za-z0-9_-])(?:${literals.map((entry) => escape(entry.value)).join("|")})(?![A-Za-z0-9_-])`, "gi")
    : null;
  const byLower = new Map(literals.map((entry) => [entry.value.toLowerCase(), entry]));

  /** The text with every name that identifies the house replaced. */
  function hide(text) {
    if (typeof text !== "string" || !text) return text;
    // Local domains first: a tailnet name is one stand-in, not a host stand-in inside a tailnet's name.
    let out = text.replace(localDomain, (found) => assign(found.toLowerCase(), "site", (n) => `site-${n + 1}.example`));
    if (literalPattern) {
      out = out.replace(literalPattern, (found) => {
        const entry = byLower.get(found.toLowerCase());
        return entry ? assign(entry.value, entry.kind, entry.make) : found;
      });
    }
    out = out.replace(privateIpv4, (found) => assign(found, "address", documentationAddress));
    out = out.replace(mac, (found) => assign(found.toLowerCase().replaceAll("-", ":"), "mac", documentationMac));
    return out;
  }

  /** The text with every stand-in turned back into what it stood for. */
  function show(text) {
    if (typeof text !== "string" || !text || !backward.size) return text;
    return text.replace(standInShape, (found) => backward.get(found.toLowerCase()) ?? found);
  }

  return {
    hide,
    show,
    /** How many names have a stand-in so far, by kind: what a run's trace says. */
    counts: () => ({ ...counts }),
  };
}

/**
 * A chat request with its words hidden: every message's text and every tool call's arguments. A
 * remote provider's own blocks are left as they are: they hold stand-ins already, as the model wrote
 * them, and must go back unchanged.
 */
export function hideRequest(request, standIns) {
  const message = (entry) => {
    const next = { ...entry };
    if (typeof next.content === "string") next.content = standIns.hide(next.content);
    else if (Array.isArray(next.content)) next.content = next.content.map((part) => (part?.type === "text" ? { ...part, text: standIns.hide(part.text) } : part));
    if (Array.isArray(next.tool_calls)) next.tool_calls = next.tool_calls.map((call) => ({ ...call, function: { ...call.function, arguments: standIns.hide(call.function.arguments) } }));
    return next;
  };
  return { ...request, messages: (request.messages ?? []).map(message) };
}

/** A chat result with its stand-ins turned back: the text and the tool calls' arguments. */
export function showResult(result, standIns) {
  return {
    ...result,
    content: standIns.show(result.content),
    toolCalls: (result.toolCalls ?? []).map((call) => ({ ...call, arguments: standIns.show(call.arguments) })),
  };
}
