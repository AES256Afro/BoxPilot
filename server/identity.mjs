/**
 * External identities for sign-in (ADR-001 / M5): Tailscale tailnet identity and GitHub (OAuth
 * device flow). Both map onto the single BoxPilot owner account; the owner must link an identity
 * once (with their password) before it can sign in on its own.
 *
 * Settings keys: tailscaleLogins (string[]), githubLogins (string[]), githubClientId (string).
 */
import { randomUUID } from "node:crypto";
import { fixedRun } from "./exec.mjs";
import { productVersion } from "./version.mjs";

const tailnetV4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
// Anchored at both ends: the old prefix-only test accepted the marker followed by anything at all,
// so a caller could mint unlimited distinct "addresses", each one a whois subprocess and a cache entry.
const tailnetV6 = /^fd7a:115c:a1e0(?::[0-9a-f]{0,4}){1,6}$/i;
const loopbacks = new Set(["127.0.0.1", "::1"]);
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const clientIdPattern = /^[A-Za-z0-9._-]{6,128}$/;

export function normalizeAddress(value) {
  if (typeof value !== "string" || value.length > 64) return null; // an address is never this long
  const trimmed = value.trim().replace(/^::ffff:/i, "").replace(/%.*$/, "");
  return trimmed || null;
}

export function isTailnetAddress(value) {
  const address = normalizeAddress(value);
  return Boolean(address && (tailnetV4.test(address) || tailnetV6.test(address)));
}

/**
 * Which tailnet address (if any) stands behind a request.
 *
 * A request that arrives *from* a tailnet address speaks for itself. A request from loopback
 * carrying X-Forwarded-For only speaks for that address when Tailscale Serve is the thing in
 * front of us — and "loopback" is not evidence of that: the installer's local mode, an SSH tunnel
 * (which the installer itself recommends), and every container BoxPilot deploys can all reach
 * loopback and set any header they like. `trustForwarded` is decided by asking Serve whether it
 * is proxying this port, which an unprivileged local process cannot arrange.
 */
export function tailnetClientAddress(request, { trustForwarded = false } = {}) {
  const remote = normalizeAddress(request.socket?.remoteAddress ?? request.ip ?? null);
  if (isTailnetAddress(remote)) return remote;
  if (trustForwarded && remote && loopbacks.has(remote)) {
    // Tailscale Serve sets exactly one hop. A chain means someone forged the header, so it is ignored.
    const forwarded = String(request.get?.("x-forwarded-for") ?? request.headers?.["x-forwarded-for"] ?? "").split(",").map((part) => normalizeAddress(part)).filter(Boolean);
    if (forwarded.length === 1 && isTailnetAddress(forwarded[0])) return forwarded[0];
  }
  return null;
}

export function createIdentityService({
  store,
  run = fixedRun,
  tailscaleBinary = process.env.BOXPILOT_TAILSCALE_BINARY ?? "/usr/bin/tailscale",
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  whoisTtlMs = 30_000,
  webPort = Number.parseInt(process.env.BOXPILOT_PORT ?? "8787", 10),
  serveTtlMs = 60_000,
} = {}) {
  const whoisCache = new Map();
  const githubFlows = new Map();
  let serveState = null; // { at, proxying }

  /**
   * Is Tailscale Serve proxying this port? That is what makes a loopback request carrying
   * X-Forwarded-For trustworthy — Serve's configuration needs privilege to change, so an ordinary
   * local process cannot arrange to be believed.
   */
  /** True when a Serve proxy target is this service on loopback at our own port. */
  function proxiesThisService(target) {
    if (typeof target !== "string" || !Number.isInteger(webPort)) return false;
    try {
      const url = new URL(target);
      return Number(url.port) === webPort && loopbacks.has(url.hostname.replace(/^\[|\]$/g, ""));
    } catch { return false; }
  }

  async function serveProxiesUs() {
    if (serveState && now() - serveState.at < serveTtlMs) return serveState.proxying;
    let proxying = false;
    const result = await run(tailscaleBinary, ["serve", "status", "--json"], { timeout: 5_000 }).catch(() => ({ ok: false }));
    if (result.ok) {
      try {
        const web = JSON.parse(result.stdout || "{}")?.Web ?? {};
        // The target has to be *this* service: a substring match also accepted another machine's
        // port, or a handler on some unrelated path, and either would have granted blanket trust.
        proxying = Object.values(web).some((entry) => Object.values(entry?.Handlers ?? {}).some((handler) => proxiesThisService(handler?.Proxy)));
      } catch { proxying = false; }
    }
    serveState = { at: now(), proxying };
    return proxying;
  }

  /** The login Tailscale Serve says a proxied request came from, when it says anything. */
  function proxyClaimedLogin(request) {
    return String(request.get?.("tailscale-user-login") ?? request.headers?.["tailscale-user-login"] ?? "").trim().toLowerCase();
  }

  /**
   * The tailnet address behind a request.
   *
   * A connection *from* a tailnet address speaks for itself. A loopback connection speaks only for
   * what the proxy in front says: Serve labels every request it forwards with the tailnet user, so
   * an address forwarded without that label did not come through Serve — it came from something on
   * this box, which is the one thing loopback cannot distinguish on its own.
   */
  async function addressFor(request) {
    const direct = tailnetClientAddress(request);
    if (direct) return direct;
    if (!proxyClaimedLogin(request)) return null;
    return tailnetClientAddress(request, { trustForwarded: await serveProxiesUs() });
  }

  function setting(key, fallback) { return store.getSetting(key, fallback); }
  function logins(key) { const value = setting(key, []); return Array.isArray(value) ? value.filter((item) => typeof item === "string") : []; }
  function links(key) { const value = setting(key, {}); return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}; }

  // ---- Tailscale ---------------------------------------------------------------------------
  const whoisCacheLimit = 500;
  async function whois(address) {
    const cached = whoisCache.get(address);
    if (cached && now() - cached.at < whoisTtlMs) return cached.value;
    // Bounded: the key comes from the request, so an unbounded map is something a caller can grow.
    if (whoisCache.size >= whoisCacheLimit) {
      for (const [key, entry] of whoisCache) if (now() - entry.at >= whoisTtlMs) whoisCache.delete(key);
      while (whoisCache.size >= whoisCacheLimit) whoisCache.delete(whoisCache.keys().next().value);
    }
    const result = await run(tailscaleBinary, ["whois", "--json", address], { timeout: 5_000 });
    let value = null;
    if (result.ok) {
      try {
        const parsed = JSON.parse(result.stdout);
        const login = parsed?.UserProfile?.LoginName ?? null;
        if (login) value = { login, displayName: parsed.UserProfile?.DisplayName ?? login, node: String(parsed?.Node?.Name ?? "").replace(/\.$/, ""), address };
      } catch { value = null; }
    }
    whoisCache.set(address, { at: now(), value });
    return value;
  }

  async function tailscaleIdentity(request) {
    const address = await addressFor(request);
    if (!address) return { available: false, reason: "not-tailnet", login: null, displayName: null, node: null, linked: false };
    const identity = await whois(address).catch(() => null);
    if (!identity) return { available: false, reason: "whois-unavailable", login: null, displayName: null, node: null, linked: false, address };
    // Tailscale Serve labels a proxied request with the tailnet user it came from. When it is
    // there it is a second, independent statement about who is calling, so it has to agree with
    // what whois says about the address; a local process can set one header but not both
    // consistently, because it does not know which address Serve would have reported.
    const claimed = proxyClaimedLogin(request);
    if (claimed && claimed !== String(identity.login).toLowerCase()) {
      return { available: false, reason: "identity-mismatch", login: null, displayName: null, node: null, linked: false, address };
    }
    // Whether the proxy itself vouched for this identity, rather than it resting on a forwarded
    // address alone. Reported so the sign-in screen can say which it is.
    return { available: true, ...identity, proxyVerified: Boolean(claimed), linked: Boolean(tailscaleAccountFor(identity.login)) };
  }

  /**
   * Which account a Tailscale login signs in as. Links made before per-account links existed
   * (a bare login in `tailscaleLogins`) belong to the first owner, which is who made them.
   */
  function tailscaleAccountFor(login) {
    if (typeof login !== "string") return null;
    const map = links("tailscaleLinks");
    if (typeof map[login] === "string") return map[login];
    return logins("tailscaleLogins").includes(login) ? store.findFirstOwner()?.id ?? null : null;
  }

  function linkTailscale(ownerId, login) {
    if (typeof login !== "string" || !login.includes("@") || login.length > 254) throw new Error("Tailscale login must be an email-style login name");
    const map = links("tailscaleLinks");
    if (typeof map[login] === "string" && map[login] !== ownerId) throw new Error("That Tailscale identity is already linked to another account");
    map[login] = ownerId;
    store.setSetting("tailscaleLinks", map, { updatedBy: ownerId });
    const next = [...new Set([...logins("tailscaleLogins"), login])];
    store.setSetting("tailscaleLogins", next, { updatedBy: ownerId });
    store.recordAudit("identity.tailscale.linked", { actorId: ownerId, subjectId: ownerId, details: { login } });
    return next;
  }

  function unlinkTailscale(ownerId, login, { force = false } = {}) {
    const map = links("tailscaleLinks");
    // Links made before per-account links existed have no map entry but still belong to the first owner.
    const belongsTo = tailscaleAccountFor(login);
    if (belongsTo && belongsTo !== ownerId && !force) throw new Error("Only the owner can unlink another person's identity");
    delete map[login];
    store.setSetting("tailscaleLinks", map, { updatedBy: ownerId });
    const next = logins("tailscaleLogins").filter((item) => item !== login);
    store.setSetting("tailscaleLogins", next, { updatedBy: ownerId });
    store.recordAudit("identity.tailscale.unlinked", { actorId: ownerId, subjectId: ownerId, details: { login } });
    return next;
  }

  // ---- GitHub device flow ------------------------------------------------------------------
  function githubConfigured() { return clientIdPattern.test(String(setting("githubClientId", "") ?? "")); }

  function setGithubClientId(ownerId, clientId) {
    if (clientId !== null && clientId !== "" && !clientIdPattern.test(String(clientId))) throw new Error("Client ID looks invalid");
    store.setSetting("githubClientId", clientId ? String(clientId) : "", { updatedBy: ownerId });
    store.recordAudit("identity.github.client-id", { actorId: ownerId, subjectId: ownerId, details: { configured: Boolean(clientId) } });
  }

  const abandonedFlowMs = 3 * 60_000;
  function pruneFlows() {
    for (const [id, flow] of githubFlows) {
      // A flow the browser stopped polling is abandoned, and holding it for its full fifteen
      // minutes let two unanswered requests occupy the sign-in cap for that whole time.
      const abandoned = flow.status === "pending" && now() - (flow.lastPolledAt ?? flow.startedAt ?? 0) > abandonedFlowMs;
      if (now() > flow.expiresAt || abandoned) githubFlows.delete(id);
    }
  }

  async function githubStart({ purpose = "signin", ownerId = null, client = null } = {}) {
    pruneFlows();
    if (!githubConfigured()) throw new Error("GitHub sign-in is not configured: add an OAuth App client ID in Settings");
    // Anonymous sign-in flows are capped separately (and per client) so nobody can fill the table
    // and lock the owner out of linking or signing in.
    const flows = [...githubFlows.values()];
    if (purpose === "signin") {
      if (flows.filter((flow) => flow.purpose === "signin").length >= 5) throw new Error("Too many GitHub sign-in attempts in progress; try again in a minute");
      if (client && flows.filter((flow) => flow.purpose === "signin" && flow.client === client).length >= 2) throw new Error("Too many GitHub sign-in attempts from this device; try again in a minute");
    } else if (flows.filter((flow) => flow.purpose === "link").length >= 5) {
      throw new Error("Too many GitHub link attempts in progress; try again in a minute");
    }
    const clientId = setting("githubClientId", "");
    const response = await fetchImpl("https://github.com/login/device/code", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": `BoxPilot/${productVersion}` }, body: JSON.stringify({ client_id: clientId, scope: "read:user" }), signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.device_code) throw new Error(body.error_description ?? body.error ?? `GitHub returned ${response.status}`);
    const flowId = randomUUID();
    githubFlows.set(flowId, { deviceCode: body.device_code, clientId, purpose, ownerId, client, startedAt: now(), lastPolledAt: now(), intervalMs: Math.max(5, Number(body.interval) || 5) * 1000, nextPollAt: 0, expiresAt: now() + Math.min(Number(body.expires_in) || 900, 900) * 1000, status: "pending" });
    return { flowId, userCode: body.user_code, verificationUri: body.verification_uri, expiresIn: Number(body.expires_in) || 900, intervalSeconds: Math.max(5, Number(body.interval) || 5) };
  }

  /** Poll once. Returns { status: pending|complete|expired|denied|error, login?, githubId?, purpose }. */
  async function githubPoll(flowId) {
    pruneFlows();
    const flow = githubFlows.get(flowId);
    if (!flow) return { status: "expired" };
    flow.lastPolledAt = now(); // a flow being polled is not abandoned
    if (flow.status !== "pending") { githubFlows.delete(flowId); return { status: flow.status, login: flow.login ?? null, githubId: flow.githubId ?? null, purpose: flow.purpose, ownerId: flow.ownerId };
    }
    if (now() < flow.nextPollAt) return { status: "pending", purpose: flow.purpose };
    flow.nextPollAt = now() + flow.intervalMs;
    const response = await fetchImpl("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": `BoxPilot/${productVersion}` }, body: JSON.stringify({ client_id: flow.clientId, device_code: flow.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }), signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({}));
    if (body.error === "authorization_pending") return { status: "pending", purpose: flow.purpose };
    if (body.error === "slow_down") { flow.intervalMs += 5000; flow.nextPollAt = now() + flow.intervalMs; return { status: "pending", purpose: flow.purpose }; }
    if (body.error === "expired_token") { githubFlows.delete(flowId); return { status: "expired", purpose: flow.purpose }; }
    if (body.error === "access_denied") { githubFlows.delete(flowId); return { status: "denied", purpose: flow.purpose }; }
    if (!body.access_token) { githubFlows.delete(flowId); return { status: "error", error: body.error_description ?? body.error ?? "GitHub did not return a token", purpose: flow.purpose }; }
    const user = await fetchImpl("https://api.github.com/user", { headers: { Authorization: `Bearer ${body.access_token}`, Accept: "application/vnd.github+json", "User-Agent": `BoxPilot/${productVersion}` }, signal: AbortSignal.timeout(10_000) });
    const profile = await user.json().catch(() => ({}));
    githubFlows.delete(flowId);
    if (!user.ok || typeof profile.login !== "string") return { status: "error", error: "Could not read the GitHub profile", purpose: flow.purpose };
    return { status: "complete", login: profile.login, githubId: profile.id ?? null, purpose: flow.purpose, ownerId: flow.ownerId };
  }

  /** Which account a GitHub login signs in as; a stored account id must match when both sides have one (logins are renameable). */
  function githubAccountFor(login, githubId = null) {
    if (typeof login !== "string") return null;
    const entry = links("githubLinks")[login.toLowerCase()];
    if (!entry || typeof entry.ownerId !== "string") return null;
    // Links made before ids were recorded are not an authentication source: GitHub releases a
    // name when an account is renamed or deleted, and whoever registers it next is a different
    // person. Those entries need re-linking from Settings.
    if (entry.id === undefined || entry.id === null) return null;
    return String(entry.id) === String(githubId ?? "") ? entry.ownerId : null;
  }

  /**
   * Which account a GitHub login is *administered* by, ignoring the id.
   *
   * githubAccountFor answers "may this login sign in", which needs the immutable id. Asking that
   * question without an id always says no — so using it for ownership made unlinkGithub's guard
   * dead code, and hid every operator's own link from their settings page.
   */
  function githubOwnerFor(login) {
    if (typeof login !== "string") return null;
    const entry = links("githubLinks")[login.toLowerCase()];
    return entry && typeof entry.ownerId === "string" ? entry.ownerId : null;
  }

  function githubLinked(login, githubId = null) { return Boolean(githubAccountFor(login, githubId)); }

  function linkGithub(ownerId, login, githubId = null) {
    if (typeof login !== "string" || !githubLoginPattern.test(login)) throw new Error("GitHub login looks invalid");
    const map = links("githubLinks");
    const existing = map[login.toLowerCase()];
    if (existing && existing.ownerId !== ownerId) throw new Error("That GitHub account is already linked to another account");
    map[login.toLowerCase()] = { ownerId, id: githubId ?? null, login };
    store.setSetting("githubLinks", map, { updatedBy: ownerId });
    const next = [...new Set([...logins("githubLogins"), login])];
    store.setSetting("githubLogins", next, { updatedBy: ownerId });
    store.recordAudit("identity.github.linked", { actorId: ownerId, subjectId: ownerId, details: { login } });
    return next;
  }

  function unlinkGithub(ownerId, login, { force = false } = {}) {
    const map = links("githubLinks");
    const belongsTo = githubOwnerFor(String(login));
    if (belongsTo && belongsTo !== ownerId && !force) throw new Error("Only the owner can unlink another person's identity");
    delete map[String(login).toLowerCase()];
    store.setSetting("githubLinks", map, { updatedBy: ownerId });
    const next = logins("githubLogins").filter((item) => item.toLowerCase() !== String(login).toLowerCase());
    store.setSetting("githubLogins", next, { updatedBy: ownerId });
    store.recordAudit("identity.github.unlinked", { actorId: ownerId, subjectId: ownerId, details: { login } });
    return next;
  }

  /** Identities linked to one account (all of them when `ownerId` is null, for the owner's view). */
  function summary(ownerId = null) {
    const mine = (list, accountFor) => (ownerId ? list.filter((login) => accountFor(login) === ownerId) : list);
    const githubMap = links("githubLinks");
    // A login recorded before BoxPilot kept GitHub's numeric id cannot sign anyone in any more,
    // and silently dropping it from the list would leave the owner wondering where it went.
    const needsRelink = logins("githubLogins").filter((login) => {
      const entry = githubMap[login.toLowerCase()];
      if (entry && typeof entry.ownerId === "string" && ownerId && entry.ownerId !== ownerId) return false;
      // A login with no entry at all belongs to whoever made it before per-account links existed,
      // which is the first owner; show it to them rather than to everyone.
      if (!entry && ownerId && store.findFirstOwner()?.id !== ownerId) return false;
      return !entry || entry.id === null || entry.id === undefined;
    });
    return {
      tailscaleLogins: mine(logins("tailscaleLogins"), tailscaleAccountFor),
      githubLogins: mine(logins("githubLogins"), githubOwnerFor),
      githubRelinkNeeded: needsRelink,
      githubConfigured: githubConfigured(),
      githubClientId: githubConfigured() ? String(setting("githubClientId", "")) : "",
    };
  }

  return { clientAddress: addressFor, tailscaleIdentity, tailscaleAccountFor, githubAccountFor, githubOwnerFor, linkTailscale, unlinkTailscale, githubConfigured, setGithubClientId, githubStart, githubPoll, githubLinked, linkGithub, unlinkGithub, summary, internals: { whois, flows: githubFlows } };
}
