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
const tailnetV6 = /^fd7a:115c:a1e0:/i;
const loopbacks = new Set(["127.0.0.1", "::1"]);
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const clientIdPattern = /^[A-Za-z0-9._-]{6,128}$/;

export function normalizeAddress(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^::ffff:/i, "").replace(/%.*$/, "");
  return trimmed || null;
}

export function isTailnetAddress(value) {
  const address = normalizeAddress(value);
  return Boolean(address && (tailnetV4.test(address) || tailnetV6.test(address)));
}

/** Work out which tailnet address (if any) stands behind a request. Loopback + X-Forwarded-For is only trusted because only local proxies (Tailscale Serve) can reach loopback. */
export function tailnetClientAddress(request) {
  const remote = normalizeAddress(request.socket?.remoteAddress ?? request.ip ?? null);
  if (isTailnetAddress(remote)) return remote;
  if (remote && loopbacks.has(remote)) {
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
} = {}) {
  const whoisCache = new Map();
  const githubFlows = new Map();

  function setting(key, fallback) { return store.getSetting(key, fallback); }
  function logins(key) { const value = setting(key, []); return Array.isArray(value) ? value.filter((item) => typeof item === "string") : []; }
  function links(key) { const value = setting(key, {}); return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}; }

  // ---- Tailscale ---------------------------------------------------------------------------
  async function whois(address) {
    const cached = whoisCache.get(address);
    if (cached && now() - cached.at < whoisTtlMs) return cached.value;
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
    const address = tailnetClientAddress(request);
    if (!address) return { available: false, reason: "not-tailnet", login: null, displayName: null, node: null, linked: false };
    const identity = await whois(address).catch(() => null);
    if (!identity) return { available: false, reason: "whois-unavailable", login: null, displayName: null, node: null, linked: false, address };
    return { available: true, ...identity, linked: Boolean(tailscaleAccountFor(identity.login)) };
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
    if (typeof map[login] === "string" && map[login] !== ownerId && !force) throw new Error("Only the owner can unlink another person's identity");
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

  function pruneFlows() {
    for (const [id, flow] of githubFlows) if (now() > flow.expiresAt) githubFlows.delete(id);
  }

  async function githubStart({ purpose = "signin", ownerId = null } = {}) {
    pruneFlows();
    if (!githubConfigured()) throw new Error("GitHub sign-in is not configured: add an OAuth App client ID in Settings");
    if (githubFlows.size >= 10) throw new Error("Too many GitHub sign-in attempts in progress; try again in a minute");
    const clientId = setting("githubClientId", "");
    const response = await fetchImpl("https://github.com/login/device/code", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": `BoxPilot/${productVersion}` }, body: JSON.stringify({ client_id: clientId, scope: "read:user" }), signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.device_code) throw new Error(body.error_description ?? body.error ?? `GitHub returned ${response.status}`);
    const flowId = randomUUID();
    githubFlows.set(flowId, { deviceCode: body.device_code, clientId, purpose, ownerId, intervalMs: Math.max(5, Number(body.interval) || 5) * 1000, nextPollAt: 0, expiresAt: now() + Math.min(Number(body.expires_in) || 900, 900) * 1000, status: "pending" });
    return { flowId, userCode: body.user_code, verificationUri: body.verification_uri, expiresIn: Number(body.expires_in) || 900, intervalSeconds: Math.max(5, Number(body.interval) || 5) };
  }

  /** Poll once. Returns { status: pending|complete|expired|denied|error, login?, githubId?, purpose }. */
  async function githubPoll(flowId) {
    pruneFlows();
    const flow = githubFlows.get(flowId);
    if (!flow) return { status: "expired" };
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
    if (entry && typeof entry.ownerId === "string") {
      if (entry.id !== null && entry.id !== undefined && githubId !== null && githubId !== undefined && String(entry.id) !== String(githubId)) return null;
      return entry.ownerId;
    }
    return logins("githubLogins").some((item) => item.toLowerCase() === login.toLowerCase()) ? store.findFirstOwner()?.id ?? null : null;
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
    const existing = map[String(login).toLowerCase()];
    if (existing && existing.ownerId !== ownerId && !force) throw new Error("Only the owner can unlink another person's identity");
    delete map[String(login).toLowerCase()];
    store.setSetting("githubLinks", map, { updatedBy: ownerId });
    const next = logins("githubLogins").filter((item) => item.toLowerCase() !== String(login).toLowerCase());
    store.setSetting("githubLogins", next, { updatedBy: ownerId });
    store.recordAudit("identity.github.unlinked", { actorId: ownerId, subjectId: ownerId, details: { login } });
    return next;
  }

  function summary() {
    return { tailscaleLogins: logins("tailscaleLogins"), githubLogins: logins("githubLogins"), githubConfigured: githubConfigured(), githubClientId: githubConfigured() ? String(setting("githubClientId", "")) : "" };
  }

  return { tailscaleIdentity, tailscaleAccountFor, githubAccountFor, linkTailscale, unlinkTailscale, githubConfigured, setGithubClientId, githubStart, githubPoll, githubLinked, linkGithub, unlinkGithub, summary, internals: { whois, flows: githubFlows } };
}
