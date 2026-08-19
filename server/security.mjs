import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { elevationTtlMs } from "./ops/risk.mjs";

const scrypt = promisify(scryptCallback);
const usernamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/;
const passwordOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const cookieName = "boxpilot_session";

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    try {
      return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
    } catch {
      return [];
    }
  }));
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

export function createAuthService(store, { sessionTtlMs = 12 * 60 * 60 * 1000 } = {}) {
  function requestSession(request) {
    const token = parseCookies(request.get("cookie"))[cookieName];
    const session = store.getSession(token);
    return session ? { ...session, token } : null;
  }

  function cookieHeader(request, token, maxAgeSeconds) {
    const forwardedHttps = request.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
    const secure = process.env.BOXPILOT_COOKIE_SECURE === "true" || (process.env.BOXPILOT_COOKIE_SECURE !== "false" && (request.secure || forwardedHttps));
    return `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
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
    try {
      const passwordHash = await hashPassword(password);
      const owner = store.consumeBootstrapToken(bootstrapToken, { username, passwordHash });
      const session = store.createSession(owner.id, { ttlMs: sessionTtlMs });
      response.setHeader("Set-Cookie", cookieHeader(request, session.token, Math.floor(sessionTtlMs / 1000)));
      response.status(201).json({ authenticated: true, owner: { id: owner.id, username: owner.username }, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
    } catch (error) {
      response.status(401).json({ error: error.message, code: "bootstrap_rejected" });
    }
  }

  async function login(request, response) {
    const { username, password } = request.body ?? {};
    const owner = typeof username === "string" ? store.findOwnerByUsername(username) : null;
    if (!owner || !(await verifyPassword(password, owner.passwordHash))) {
      response.status(401).json({ error: "Invalid username or password", code: "invalid_credentials" });
      return;
    }
    const session = store.createSession(owner.id, { ttlMs: sessionTtlMs });
    store.recordAudit("session.created", { actorId: owner.id, subjectId: owner.id });
    response.setHeader("Set-Cookie", cookieHeader(request, session.token, Math.floor(sessionTtlMs / 1000)));
    response.json({ authenticated: true, owner: { id: owner.id, username: owner.username }, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  }

  /** Issue a session for an owner authenticated by an external identity (Tailscale, GitHub). */
  function issueSession(request, response, owner, { method = "identity", detail = null } = {}) {
    const session = store.createSession(owner.id, { ttlMs: sessionTtlMs });
    store.recordAudit("session.created", { actorId: owner.id, subjectId: owner.id, details: { method, ...(detail ? { detail } : {}) } });
    response.setHeader("Set-Cookie", cookieHeader(request, session.token, Math.floor(sessionTtlMs / 1000)));
    return { authenticated: true, owner: { id: owner.id, username: owner.username }, csrfToken: session.csrfToken, expiresAt: session.expiresAt, elevatedUntil: null, method };
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
    if (!owner || typeof password !== "string" || !(await verifyPassword(password, owner.passwordHash))) {
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
    response.setHeader("Set-Cookie", cookieHeader(request, "", 0));
    response.status(204).end();
  }

  return { bootstrap, login, status, logout, elevate, dropElevation, issueSession, requestSession, requireSession, requireCsrf };
}

export const securityInternals = { cookieName, parseCookies, safeEqual, validateCredentials };
