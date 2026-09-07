/**
 * BoxPilot as an OpenID Connect provider (M19.3), so an app can offer "Sign in with BoxPilot"
 * instead of its own password.
 *
 * The flow is authorization code with PKCE, and only that: it needs no client secret, so nothing
 * secret is stored for a client — a registered client is just a name and its allowed redirect URIs.
 * The one secret the provider does hold is its signing keypair, an EC P-256 key kept in the state
 * directory like the TLS key, never leaving the box; the public half is published at the JWKS
 * endpoint for apps to verify tokens with. Tokens are ES256 JWTs. The issuer is whatever BoxPilot
 * URL the app reached, so an install that lives on the tailnet issues tailnet-URL tokens and one on
 * the LAN issues LAN-URL tokens, with no configuration.
 */
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { publicJwk, signJwt, verifyJwt } from "./jwt.mjs";
import { loadOidcSigningKeys } from "./oidc-signing-keys.mjs";

const CODE_TTL_MS = 60_000;
const ACCESS_TTL_SECONDS = 3600;
const ID_TTL_SECONDS = 3600;
const MAX_CODES = 1024;
const MAX_CLIENT_CODES = 64;
const clientNamePattern = /^[\p{L}\p{N} ._-]{1,64}$/u;

/** An error carrying the OIDC error code and whether it is safe to redirect back to the client. */
export class OidcError extends Error {
  constructor(code, description, { redirectUri = null, state = null } = {}) {
    super(description);
    this.code = code;
    this.description = description;
    this.redirectUri = redirectUri;
    this.state = state;
  }
}

/** A redirect URI must be an absolute http/https URL with no fragment (OIDC forbids a fragment). */
export function isValidRedirectUri(value) {
  try {
    if (typeof value !== "string" || value.length > 2048) return false;
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

export function createOidcService({
  store,
  keyDir = process.env.BOXPILOT_OIDC_DIR ?? path.join(process.env.BOXPILOT_STATE_DIRECTORY ?? "/var/lib/boxpilot", "oidc"),
  now = () => Date.now(),
  keys = null,
} = {}) {
  let signingKeys = keys;
  try { signingKeys ??= loadOidcSigningKeys(keyDir); } catch { /* Keep ordinary BoxPilot login and recovery available. */ }
  const { privateKey, publicKey, kid } = signingKeys ?? {};
  const status = () => ({ ready: Boolean(signingKeys), detail: signingKeys ? null : "Single sign-on is unavailable because its signing key could not be loaded. Preserve the key file and restore a verified key backup, then restart BoxPilot. Ordinary BoxPilot sign-in remains available." });
  const requireKeys = () => { if (!signingKeys) throw new OidcError("temporarily_unavailable", status().detail); };
  const codes = new Map(); // code -> { clientId, ownerId, redirectUri, codeChallenge, scope, nonce, expiresAt }
  let expiryTimer = null;

  function pruneCodes() {
    const at = now();
    for (const [key, record] of codes) if (record.expiresAt <= at) codes.delete(key);
    if (!codes.size && expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
  }
  function scheduleExpiry() {
    if (expiryTimer || !codes.size) return;
    const next = Math.min(...Array.from(codes.values(), (record) => record.expiresAt));
    expiryTimer = setTimeout(() => { expiryTimer = null; pruneCodes(); scheduleExpiry(); }, Math.max(1, next - now()));
    expiryTimer.unref?.();
  }
  function close() { clearTimeout(expiryTimer); expiryTimer = null; codes.clear(); }

  function metadata(issuer) {
    requireKeys();
    return {
      issuer,
      authorization_endpoint: `${issuer}/oidc/authorize`,
      token_endpoint: `${issuer}/oidc/token`,
      userinfo_endpoint: `${issuer}/oidc/userinfo`,
      jwks_uri: `${issuer}/oidc/jwks`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["ES256"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "profile", "groups"],
      claims_supported: ["sub", "iss", "aud", "exp", "iat", "nonce", "preferred_username", "name", "groups"],
    };
  }

  function jwks() { requireKeys(); return { keys: [publicJwk(publicKey, kid)] }; }

  // ---- Client registration -------------------------------------------------------------------
  function registerClient({ name, redirectUris, ownerId = null }) {
    if (typeof name !== "string" || !clientNamePattern.test(name.trim())) throw new Error("A client name is 1 to 64 letters, numbers, spaces, dots, dashes, or underscores");
    const uris = Array.isArray(redirectUris) ? [...new Set(redirectUris.map((uri) => String(uri).trim()).filter(Boolean))] : [];
    if (!uris.length) throw new Error("At least one redirect URI is required");
    if (uris.length > 16) throw new Error("Too many redirect URIs (16 maximum)");
    const bad = uris.find((uri) => !isValidRedirectUri(uri));
    if (bad) throw new Error(`Not a valid redirect URI: ${bad}`);
    // A readable but unguessable id: a slug from the name plus random, so it reads well in app config.
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "client";
    const id = `${slug}-${randomBytes(6).toString("hex")}`;
    return store.addOidcClient({ id, name: name.trim(), redirectUris: uris, createdBy: ownerId });
  }

  function listClients() { return store.listOidcClients(); }
  function removeClient(id, ownerId = null) {
    const result = store.removeOidcClient(id, { actorId: ownerId });
    for (const [code, record] of codes) if (record.clientId === id) codes.delete(code);
    pruneCodes();
    return result;
  }

  // ---- Authorization -------------------------------------------------------------------------
  /** Validate an authorization request. Throws OidcError; redirectUri/state are attached when it is safe to bounce the error back. */
  function validateAuthorization(params) {
    requireKeys();
    if (typeof params.client_id !== "string" || params.client_id.length > 128) throw new OidcError("invalid_client", "A registered client id is required.");
    const client = store.getOidcClient(params.client_id);
    if (!client) throw new OidcError("invalid_client", "Unknown client. Register this app under Settings, Single sign-on.");
    const redirectUri = params.redirect_uri;
    if (!isValidRedirectUri(redirectUri) || !client.redirectUris.includes(redirectUri)) {
      throw new OidcError("invalid_request", "redirect_uri is not one this client registered.");
    }
    if (params.state != null && (typeof params.state !== "string" || params.state.length > 2048)) throw new OidcError("invalid_request", "state must be one string of at most 2048 characters.", { redirectUri });
    const bounce = { redirectUri, state: params.state ?? null };
    if (params.response_type !== "code") throw new OidcError("unsupported_response_type", "Only response_type=code is supported.", bounce);
    if (typeof params.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)) throw new OidcError("invalid_request", "A valid S256 PKCE code_challenge is required.", bounce);
    if (params.code_challenge_method !== "S256") throw new OidcError("invalid_request", "Set code_challenge_method=S256.", bounce);
    if (params.scope != null && (typeof params.scope !== "string" || params.scope.length > 256)) throw new OidcError("invalid_scope", "scope must be one string of at most 256 characters.", bounce);
    if (params.nonce != null && (typeof params.nonce !== "string" || params.nonce.length > 512)) throw new OidcError("invalid_request", "nonce must be one string of at most 512 characters.", bounce);
    const scope = (params.scope ?? "openid").trim() || "openid";
    if (!scope.split(/\s+/).includes("openid")) throw new OidcError("invalid_scope", "The openid scope is required.", bounce);
    return { client, redirectUri, scope, state: params.state ?? null, nonce: params.nonce ?? null, codeChallenge: params.code_challenge };
  }

  /** After the owner consents, mint a single-use authorization code. */
  function issueCode({ clientId, ownerId, redirectUri, codeChallenge, scope, nonce }) {
    requireKeys();
    const validated = validateAuthorization({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", code_challenge: codeChallenge, code_challenge_method: "S256", scope, nonce });
    pruneCodes();
    let clientCodes = 0;
    for (const record of codes.values()) if (record.clientId === clientId) clientCodes += 1;
    if (codes.size >= MAX_CODES || clientCodes >= MAX_CLIENT_CODES) throw new OidcError("temporarily_unavailable", "Too many sign-in requests are waiting. Retry in one minute.");
    const code = randomBytes(32).toString("base64url");
    codes.set(code, { clientId, ownerId, redirectUri, codeChallenge, scope: validated.scope, nonce: nonce ?? null, expiresAt: now() + CODE_TTL_MS });
    scheduleExpiry();
    return code;
  }

  // ---- Token + userinfo ----------------------------------------------------------------------
  function exchangeCode({ code, codeVerifier, clientId, redirectUri, issuer }) {
    requireKeys();
    const record = codes.get(code);
    codes.delete(code); // single use, whether or not it checks out
    pruneCodes();
    if (!record || record.expiresAt <= now()) throw new OidcError("invalid_grant", "The authorization code is invalid or expired.");
    if (record.clientId !== clientId) throw new OidcError("invalid_grant", "The code was issued to a different client.");
    if (record.redirectUri !== redirectUri) throw new OidcError("invalid_grant", "redirect_uri does not match the one used to get the code.");
    const client = store.getOidcClient(clientId);
    if (!client || !client.redirectUris.includes(redirectUri)) throw new OidcError("invalid_grant", "The app is no longer registered for this redirect URI.");
    if (typeof codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new OidcError("invalid_grant", "PKCE verification failed.");
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
    if (challenge !== record.codeChallenge) throw new OidcError("invalid_grant", "PKCE verification failed.");
    const owner = store.findOwnerById(record.ownerId);
    if (!owner || owner.role === "disabled") throw new OidcError("invalid_grant", "That account can no longer sign in.");
    const nowSeconds = Math.floor(now() / 1000);
    const scopes = record.scope.split(/\s+/);
    const claims = claimsFor(owner, scopes);
    const idToken = signJwt({ iss: issuer, sub: owner.id, aud: clientId, ...(record.nonce ? { nonce: record.nonce } : {}), ...claims }, { privateKey, kid, now: nowSeconds, expiresInSeconds: ID_TTL_SECONDS });
    const accessToken = signJwt({ iss: issuer, sub: owner.id, aud: `${issuer}/oidc/userinfo`, scope: record.scope, token_use: "access" }, { privateKey, kid, now: nowSeconds, expiresInSeconds: ACCESS_TTL_SECONDS });
    return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, id_token: idToken, scope: record.scope };
  }

  function userinfo(accessToken, issuer) {
    requireKeys();
    let payload;
    try { payload = verifyJwt(accessToken, { publicKey, now: Math.floor(now() / 1000) }); } catch { throw new OidcError("invalid_token", "The access token is invalid or expired."); }
    if (payload.token_use !== "access" || payload.iss !== issuer) throw new OidcError("invalid_token", "Not an access token for this issuer.");
    const owner = store.findOwnerById(payload.sub);
    if (!owner || owner.role === "disabled") throw new OidcError("invalid_token", "That account can no longer sign in.");
    return { sub: owner.id, ...claimsFor(owner, String(payload.scope ?? "").split(/\s+/)) };
  }

  /** The profile/groups claims allowed by the granted scopes. `sub` is always the stable owner id. */
  function claimsFor(owner, scopes) {
    return {
      ...(scopes.includes("profile") ? { preferred_username: owner.username, name: owner.username } : {}),
      ...(scopes.includes("groups") ? { groups: [owner.role ?? "owner"] } : {}),
    };
  }

  return { close, status, metadata, jwks, registerClient, listClients, removeClient, validateAuthorization, issueCode, exchangeCode, userinfo, internals: { kid, publicKey, pendingCodeCount: () => codes.size } };
}
