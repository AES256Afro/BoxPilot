import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { defaultThrottle as throttle, defaultSprayThrottle as sprayThrottle } from "./login-throttle.mjs";
import { normalizeAddress, tailnetClientAddress } from "./identity.mjs";
import { promisify } from "node:util";
import { elevationTtlMs } from "./ops/risk.mjs";

const scrypt = promisify(scryptCallback);
const usernamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/;
const passwordOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const cookieName = "boxpilot_session";
/**
 * Over HTTPS the session cookie carries the __Host- prefix, which pins it to this exact host: a
 * ts.net tailnet shares a registrable domain, so another node on it could otherwise set a Domain
 * cookie of the same name. The prefix requires Secure, so a LAN-only HTTP install keeps the plain
 * name, and both names are read so nobody is signed out by an upgrade.
 */
const hostCookieName = `__Host-${cookieName}`;

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function parseCookies(header = "") {
  const parsed = {};
  const duplicated = new Set();
  for (const part of String(header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    let value;
    try { value = decodeURIComponent(part.slice(separator + 1).trim()); } catch { continue; }
    // Two cookies of one name mean somebody set a second at a broader scope. Taking the last one
    // silently picks whichever the browser happened to send first; neither is trustworthy.
    if (name in parsed) { duplicated.add(name); continue; }
    parsed[name] = value;
  }
  for (const name of duplicated) delete parsed[name];
  return parsed;
}

function validateCredentials(username, password) {
  const errors = [];
  if (typeof username !== "string" || !usernamePattern.test(username)) errors.push("Username must be 3 to 32 letters, numbers, dots, dashes, or underscores");
  if (typeof password !== "string" || password.length < 12 || password.length > 128) errors.push("Password must be 12 to 128 characters");
  return errors;
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const derived = await scrypt(password, salt, 64, passwordOptions);
  return `scrypt$${passwordOptions.N}$${passwordOptions.r}$${passwordOptions.p}$${salt}$${Buffer.from(derived).toString("base64url")}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || typeof encoded !== "string") return false;
  const [algorithm, n, r, p, salt, expected] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  const derived = await scrypt(password, salt, 64, {
    N: Number.parseInt(n, 10), r: Number.parseInt(r, 10), p: Number.parseInt(p, 10), maxmem: 64 * 1024 * 1024,
  });
  return safeEqual(Buffer.from(derived).toString("base64url"), expected);
}

export function createAuthService(store, { sessionTtlMs = 12 * 60 * 60 * 1000, resolveClientAddress = null } = {}) {
  /**
   * Best-effort "from where" for the session list: the tailnet peer if there is one, otherwise the
   * forwarded or socket address, plus the user agent. This is display metadata shown to the owner
   * about their own sessions, not a trust decision, so a forged header at worst mislabels a row.
   */
  function clientDescriptor(request) {
    const direct = tailnetClientAddress(request);
    const forwarded = String(request.get?.("x-forwarded-for") ?? "").split(",")[0].trim();
    const raw = direct || forwarded || request.socket?.remoteAddress || request.ip || null;
    return {
      address: raw ? (normalizeAddress(raw) ?? String(raw).slice(0, 64)) : null,
      userAgent: (request.get?.("user-agent") ?? "").slice(0, 300) || null,
    };
  }

  function requestSession(request) {
    const cookies = parseCookies(request.get("cookie"));
    // The host-pinned name wins; the plain one keeps sessions issued before this alive.
    const token = cookies[hostCookieName] ?? cookies[cookieName];
    const session = store.getSession(token);
    return session ? { ...session, token } : null;
  }

  function cookieHeader(request, token, maxAgeSeconds) {
    const forwardedHttps = request.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
    const secure = process.env.BOXPILOT_COOKIE_SECURE === "true" || (process.env.BOXPILOT_COOKIE_SECURE !== "false" && (request.secure || forwardedHttps));
    return `${secure ? hostCookieName : cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
  }

  /** Add a cookie without dropping one an earlier step already set (device cookie + session). */
  function appendCookie(request, response, value) {
    const earlier = response.getHeader("Set-Cookie");
    response.setHeader("Set-Cookie", [...(Array.isArray(earlier) ? earlier : earlier ? [String(earlier)] : []), value]);
  }

  function requireSession(request, response, next) {
    const session = requestSession(request);
    if (!session) {
      response.status(401).json({ error: "Authentication required", code: "authentication_required" });
      return;
    }
    request.boxpilotSession = session;
    next();
  }

  /** Any signed-in account changes its own password with the current one; other sessions end. */
  async function changePassword(request, response) {
    const session = request.boxpilotSession ?? requestSession(request);
    const owner = session ? store.findOwnerById(session.owner.id) : null;
    const { currentPassword, newPassword } = request.body ?? {};
    const verdict = await checkPassword(request, owner, currentPassword);
    if (verdict.blocked) return rejectThrottled(response, verdict);
    if (!verdict.ok) {
      response.status(401).json({ error: "Current password is wrong", code: "invalid_credentials" });
      return;
    }
    if (typeof newPassword !== "string" || newPassword.length < 12 || newPassword.length > 256) {
      response.status(400).json({ error: "The new password must be 12 to 256 characters", code: "invalid_password" });
      return;
    }
    if (newPassword === currentPassword) {
      response.status(400).json({ error: "Choose a different password", code: "invalid_password" });
      return;
    }
    store.setOwnerPassword(owner.id, await hashPassword(newPassword), { keepSessionTokenHash: session.tokenHash });
    response.json({ changed: true });
  }

  /** Route guard for a role set; the session must already be attached by requireSession. */
  function requireRole(...roles) {
    return (request, response, next) => {
      // No session, no role. This used to default to "owner", so a route mounted ahead of
      // requireSession would have granted anonymous callers everything.
      if (!request.boxpilotSession?.owner) {
        response.status(401).json({ error: "Sign in to do that", code: "unauthenticated" });
        return;
      }
      const role = request.boxpilotSession.owner.role ?? "disabled";
      if (!roles.includes(role)) {
        response.status(403).json({ error: `This needs the ${roles.join(" or ")} role`, code: "forbidden" });
        return;
      }
      next();
    };
  }

  function requireCsrf(request, response, next) {
    const session = request.boxpilotSession ?? requestSession(request);
    if (!session || !safeEqual(request.get("x-boxpilot-csrf") ?? "", session.csrfToken)) {
      response.status(403).json({ error: "Valid CSRF token required", code: "csrf_required" });
      return;
    }
    request.boxpilotSession = session;
    next();
  }

  async function bootstrap(request, response) {
    if (store.ownerCount() > 0) {
      response.status(409).json({ error: "Owner bootstrap is already complete", code: "already_bootstrapped" });
      return;
    }
    const { username, password, bootstrapToken } = request.body ?? {};
    const errors = validateCredentials(username, password);
    if (typeof bootstrapToken !== "string" || bootstrapToken.length < 20) errors.push("A valid server-generated bootstrap token is required");
    if (errors.length) {
      response.status(400).json({ error: errors.join(". "), code: "invalid_bootstrap" });
      return;
    }
    // Check the token before hashing. scrypt costs ~16 MiB and ~100 ms on the shared thread pool,
    // and this route has no session to throttle against, so hashing first let anyone who could
    // reach the port stall the setup screen with junk tokens.
    if (!store.bootstrapTokenUsable(bootstrapToken)) {
      response.status(401).json({ error: "Bootstrap token is invalid or expired", code: "bootstrap_rejected" });
      return;
    }
    try {
      const passwordHash = await hashPassword(password);
      const owner = store.consumeBootstrapToken(bootstrapToken, { username, passwordHash });
      const session = store.createSession(owner.id, { ttlMs: sessionTtlMs, ...clientDescriptor(request), method: "password" });
      appendCookie(request, response, cookieHeader(request, session.token, Math.floor(sessionTtlMs / 1000)));
      response.status(201).json({ authenticated: true, owner: { id: owner.id, username: owner.username, role: owner.role ?? "owner" }, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
    } catch (error) {
      response.status(401).json({ error: error.message, code: "bootstrap_rejected" });
    }
  }

  /**
   * A hash of a random value, used to spend the same work on an account that does not exist as on
   * one that does. Computed once, lazily, with the production scrypt parameters.
   */
  let decoy = null;
  function decoyHash() {
    decoy ??= hashPassword(randomBytes(24).toString("base64url"));
    return decoy;
  }

  /**
   * Who is asking: the tailnet peer when BoxPilot is served over Tailscale, otherwise the socket
   * address. Behind Serve every socket is 127.0.0.1, so without the peer the throttle would treat
   * every tailnet user as one caller — which is exactly the lock-out this key exists to avoid.
   */
  async function clientKeyFor(request) {
    const peer = resolveClientAddress ? await resolveClientAddress(request).catch(() => null) : tailnetClientAddress(request);
    return `ip:${peer ?? request.socket?.remoteAddress ?? request.ip ?? "unknown"}`;
  }

  /**
   * Verify a password with throttling: five consecutive failures pause further attempts, doubling
   * each time up to fifteen minutes. Failures are audited.
   *
   * The key is the *pair* of account and caller. Keying on the account alone made the throttle a
   * lock-out weapon — anyone who could reach the port could hold the owner's account blocked
   * indefinitely with one wrong guess every fifteen minutes, and password approval for jobs went
   * with it. Keying on the address alone is no good either: behind `tailscale serve` every request
   * arrives from 127.0.0.1, so every caller would share one counter. A separate, far higher
   * per-account ceiling still slows an attack spread across many callers.
   */
  async function checkPassword(request, owner, password) {
    const caller = await clientKeyFor(request);
    // One key per caller either way. The bare caller key alongside it only doubled the entries an
    // attacker needs to create, and the two were perfectly correlated.
    const keys = [`user:${owner ? owner.id : "unknown"}|${caller}`];
    const gate = throttle.check(keys);
    if (gate.blocked) return { ok: false, blocked: true, retryAfterMs: gate.retryAfterMs };
    const account = owner ? [`user:${owner.id}`] : [];
    const spread = owner ? sprayThrottle.check(account) : { blocked: false, retryAfterMs: 0 };
    if (spread.blocked) return { ok: false, blocked: true, retryAfterMs: spread.retryAfterMs };
    // Verify against a decoy hash when there is no account, so a username that does not exist —
    // or one that has been disabled — takes the same ~20 ms as one that does. Short-circuiting
    // here made the two distinguishable by timing alone, and made a flood of attempts against
    // made-up usernames free for an attacker.
    const ok = typeof password === "string"
      ? await verifyPassword(password, owner ? owner.passwordHash : await decoyHash())
      : false;
    throttle.record(keys, ok);
    if (owner) sprayThrottle.record(account, ok);
    if (!ok) store.recordAudit("auth.failed", { actorId: owner?.id ?? null, subjectId: owner?.id ?? null, details: { client: caller.slice(3) } });
    return { ok, blocked: false, retryAfterMs: 0 };
  }

  function rejectThrottled(response, verdict) {
    response.setHeader("Retry-After", String(Math.ceil(verdict.retryAfterMs / 1000)));
    response.status(429).json({ error: `Too many wrong passwords; try again in ${Math.ceil(verdict.retryAfterMs / 1000)} s`, code: "too_many_attempts" });
  }

  async function login(request, response) {
    const { username, password } = request.body ?? {};
    const owner = typeof username === "string" ? store.findOwnerByUsername(username) : null;
    const verdict = await checkPassword(request, owner && owner.role !== "disabled" ? owner : null, password);
    if (verdict.blocked) return rejectThrottled(response, verdict);
    if (!verdict.ok) {
      response.status(401).json({ error: "Invalid username or password", code: "invalid_credentials" });
      return;
    }
    const session = store.createSession(owner.id, { ttlMs: sessionTtlMs, ...clientDescriptor(request), method: "password" });
    store.recordAudit("session.created", { actorId: owner.id, subjectId: owner.id });
    appendCookie(request, response, cookieHeader(request, session.token, Math.floor(sessionTtlMs / 1000)));
    response.json({ authenticated: true, owner: { id: owner.id, username: owner.username, role: owner.role ?? "owner" }, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  }

  /** Issue a session for an owner authenticated by an external identity (Tailscale, GitHub). */
  function issueSession(request, response, owner, { method = "identity", detail = null } = {}) {
    if (owner?.role === "disabled") throw new Error("This account is disabled");
    const session = store.createSession(owner.id, { ttlMs: sessionTtlMs, ...clientDescriptor(request), method });
    store.recordAudit("session.created", { actorId: owner.id, subjectId: owner.id, details: { method, ...(detail ? { detail } : {}) } });
    appendCookie(request, response, cookieHeader(request, session.token, Math.floor(sessionTtlMs / 1000)));
    return { authenticated: true, owner: { id: owner.id, username: owner.username, role: owner.role ?? "owner" }, csrfToken: session.csrfToken, expiresAt: session.expiresAt, elevatedUntil: null, method };
  }

  const deviceCookieName = "boxpilot_device";
  const deviceTtlSeconds = 365 * 24 * 3600;
  const deviceDigest = (token) => createHash("sha256").update(token).digest("hex");

  /** A browser that confirmed the password once for this account (see rememberDevice). */
  function trustedDevice(request, owner) {
    const token = parseCookies(request.headers?.cookie ?? "")[deviceCookieName];
    if (typeof token !== "string" || token.length < 20 || !owner) return false;
    const devices = store.getSetting("trustedDevices", []);
    const hash = deviceDigest(token);
    return Array.isArray(devices) && devices.some((entry) => entry && entry.hash === hash && entry.ownerId === owner.id);
  }

  /** Mark this browser as trusted for identity sign-in: a long-lived cookie whose hash is kept in settings (newest 50). */
  function rememberDevice(request, response, owner) {
    const token = randomBytes(32).toString("base64url");
    const devices = (store.getSetting("trustedDevices", []) ?? []).filter((entry) => entry && typeof entry.hash === "string").slice(-49);
    devices.push({ hash: deviceDigest(token), ownerId: owner.id, createdAt: new Date().toISOString() });
    store.setSetting("trustedDevices", devices, { updatedBy: owner.id });
    store.recordAudit("session.device-trusted", { actorId: owner.id, subjectId: owner.id });
    const forwardedHttps = request.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
    const secure = process.env.BOXPILOT_COOKIE_SECURE === "true" || (process.env.BOXPILOT_COOKIE_SECURE !== "false" && (request.secure || forwardedHttps));
    appendCookie(request, response, `${deviceCookieName}=${token}; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age=${deviceTtlSeconds}${secure ? "; Secure" : ""}`);
  }

  function status(request, response) {
    const session = requestSession(request);
    response.json({
      bootstrapRequired: store.ownerCount() === 0,
      authenticated: Boolean(session),
      owner: session?.owner ?? null,
      csrfToken: session?.csrfToken ?? null,
      expiresAt: session?.expiresAt ?? null,
      elevatedUntil: session?.elevatedUntil ?? null,
    });
  }

  /** Re-enter the owner password to unlock a short elevated window for high-risk approvals. */
  async function elevate(request, response) {
    const session = request.boxpilotSession;
    const owner = store.findOwnerById(session.owner.id);
    const password = request.body?.password;
    if (owner?.role === "viewer") {
      response.status(403).json({ error: "Viewers can look but not unlock high-risk actions or secrets", code: "forbidden" });
      return;
    }
    const verdict = await checkPassword(request, owner, password);
    if (verdict.blocked) return rejectThrottled(response, verdict);
    if (!verdict.ok) {
      response.status(401).json({ error: "Invalid password", code: "invalid_credentials" });
      return;
    }
    const elevatedUntil = store.elevateSession(session.tokenHash, new Date(Date.now() + elevationTtlMs));
    store.recordAudit("session.elevated", { actorId: owner.id, subjectId: owner.id });
    response.json({ elevatedUntil });
  }

  function dropElevation(request, response) {
    store.clearSessionElevation(request.boxpilotSession.tokenHash);
    response.status(204).end();
  }

  function logout(request, response) {
    const session = request.boxpilotSession;
    store.deleteSession(session.token);
    store.recordAudit("session.deleted", { actorId: session.owner.id, subjectId: session.owner.id });
    // Clear both names: whichever one this browser holds, signing out must end it.
    response.setHeader("Set-Cookie", [cookieHeader(request, "", 0), `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`]);
    response.status(204).end();
  }

  // ---- Session list (M19.4): what is signed in, from where, and cut any of it off ------------
  function listSessions(request, response) {
    const session = request.boxpilotSession;
    response.json({ currentId: session.id, sessions: store.listSessions(session.owner.id) });
  }

  function revokeSession(request, response) {
    const session = request.boxpilotSession;
    const id = request.params.id;
    if (!store.revokeSession(session.owner.id, id)) {
      response.status(404).json({ error: "That session was not found", code: "session_not_found" });
      return;
    }
    const wasCurrent = id === session.id;
    store.recordAudit("session.revoked", { actorId: session.owner.id, subjectId: session.owner.id, details: { self: wasCurrent } });
    // Ending your own session is a sign-out, so clear the cookie in that one case.
    if (wasCurrent) response.setHeader("Set-Cookie", [cookieHeader(request, "", 0), `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`]);
    response.json({ revoked: true, wasCurrent });
  }

  function revokeOtherSessions(request, response) {
    const session = request.boxpilotSession;
    const count = store.revokeOtherSessions(session.owner.id, session.id);
    store.recordAudit("session.revoked-others", { actorId: session.owner.id, subjectId: session.owner.id, details: { count } });
    response.json({ revoked: count });
  }

  return { bootstrap, login, status, logout, elevate, dropElevation, changePassword, issueSession, requestSession, requireSession, requireCsrf, requireRole, trustedDevice, rememberDevice, checkPassword, rejectThrottled, listSessions, revokeSession, revokeOtherSessions };
}

export const securityInternals = { cookieName, parseCookies, safeEqual, validateCredentials };
