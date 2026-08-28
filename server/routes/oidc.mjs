/**
 * OpenID Connect endpoints (M19.3). Mounted at the site root (not under /api/v1), because the
 * discovery, JWKS, token, and userinfo endpoints are public by design — an app fetches them without
 * a BoxPilot session. Only /oidc/authorize needs a session, since it is the owner in their browser
 * consenting; it reads the session itself rather than sitting behind the API session wall.
 *
 * The issuer is derived from the URL the request arrived on, so tokens name the same BoxPilot URL the
 * app is configured with, with nothing to set.
 */
import express, { Router } from "express";
import { OidcError } from "../oidc.mjs";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

/** The external origin this request came in on: the app-facing BoxPilot URL, used as the issuer. */
function originFrom(request) {
  const proto = String(request.get("x-forwarded-proto") ?? "").split(",")[0].trim() || (request.secure ? "https" : "http");
  const host = String(request.get("x-forwarded-host") ?? request.get("host") ?? "").split(",")[0].trim();
  return `${proto}://${host}`;
}

const scopeDescriptions = {
  openid: "confirm who you are",
  profile: "see your username",
  groups: "see your role (owner, operator, or viewer)",
};

/** The public endpoints are meant to be fetched cross-origin by apps; they carry no cookie secrets. */
function allowCrossOrigin(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cache-Control", "no-store");
}

export function createOidcRouter({ oidc, auth, store }) {
  const router = Router();
  // OIDC token and consent bodies are application/x-www-form-urlencoded.
  router.use(express.urlencoded({ extended: false, limit: "16kb" }));

  router.get("/.well-known/openid-configuration", (request, response) => {
    allowCrossOrigin(response);
    response.json(oidc.metadata(originFrom(request)));
  });

  router.get("/oidc/jwks", (_request, response) => {
    allowCrossOrigin(response);
    response.json(oidc.jwks());
  });

  router.options(["/oidc/token", "/oidc/userinfo", "/oidc/jwks"], (_request, response) => {
    allowCrossOrigin(response);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.status(204).end();
  });

  // The consent screen. The owner must be signed in to BoxPilot; if not, send them to sign in and
  // come back here afterwards.
  router.get("/oidc/authorize", (request, response) => {
    const session = auth.requestSession(request);
    if (!session) {
      const next = encodeURIComponent(request.originalUrl);
      return response.redirect(`/?next=${next}`);
    }
    let validated;
    try {
      validated = oidc.validateAuthorization(request.query);
    } catch (error) {
      return renderAuthorizationError(response, error);
    }
    response.status(200).type("html").setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; img-src 'self' data:; base-uri 'none'");
    response.send(consentPage({ session, validated, query: request.query }));
  });

  // The consent decision. Owner session + a CSRF token carried in the form.
  router.post("/oidc/authorize", (request, response) => {
    const session = auth.requestSession(request);
    if (!session) return response.status(401).type("html").send(simplePage("Session expired", "Sign in to BoxPilot again, then retry from the app."));
    const body = request.body ?? {};
    if (!body.csrf || body.csrf !== session.csrfToken) return response.status(403).type("html").send(simplePage("Could not confirm the request", "Go back to the app and try signing in again."));
    let validated;
    try {
      validated = oidc.validateAuthorization(body);
    } catch (error) {
      return renderAuthorizationError(response, error);
    }
    if (body.decision !== "approve") {
      return response.redirect(redirectWith(validated.redirectUri, { error: "access_denied", state: validated.state }));
    }
    const code = oidc.issueCode({ clientId: validated.client.id, ownerId: session.owner.id, redirectUri: validated.redirectUri, codeChallenge: validated.codeChallenge, scope: validated.scope, nonce: validated.nonce });
    store.recordAudit("oidc.authorized", { actorId: session.owner.id, subjectId: validated.client.id, details: { client: validated.client.name, scope: validated.scope } });
    return response.redirect(redirectWith(validated.redirectUri, { code, state: validated.state }));
  });

  router.post("/oidc/token", (request, response) => {
    allowCrossOrigin(response);
    const body = request.body ?? {};
    if (body.grant_type !== "authorization_code") return response.status(400).json({ error: "unsupported_grant_type", error_description: "Only authorization_code is supported" });
    try {
      response.json(oidc.exchangeCode({ code: body.code, codeVerifier: body.code_verifier, clientId: body.client_id, redirectUri: body.redirect_uri, issuer: originFrom(request) }));
    } catch (error) {
      const status = error instanceof OidcError ? 400 : 500;
      response.status(status).json({ error: error.code ?? "server_error", error_description: error.description ?? "Token request failed" });
    }
  });

  router.get("/oidc/userinfo", (request, response) => {
    allowCrossOrigin(response);
    const header = String(request.get("authorization") ?? "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token) { response.setHeader("WWW-Authenticate", "Bearer"); return response.status(401).json({ error: "invalid_token", error_description: "A Bearer access token is required" }); }
    try {
      response.json(oidc.userinfo(token, originFrom(request)));
    } catch (error) {
      response.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
      response.status(401).json({ error: error.code ?? "invalid_token", error_description: error.description ?? "The access token is invalid" });
    }
  });

  return router;
}

/** Owner-only client management, mounted under /api/v1 behind the session wall. */
export function createOidcAdminRouter({ oidc, auth }) {
  const router = Router();
  const ownerOnly = auth.requireRole("owner");
  router.get("/oidc/clients", ownerOnly, (request, response) => {
    const issuer = originFrom(request);
    response.json({ issuer, discovery: `${issuer}/.well-known/openid-configuration`, clients: oidc.listClients() });
  });
  router.post("/oidc/clients", ownerOnly, (request, response) => {
    try {
      response.status(201).json(oidc.registerClient({ name: request.body?.name, redirectUris: request.body?.redirectUris, ownerId: request.boxpilotSession.owner.id }));
    } catch (error) {
      response.status(400).json({ error: error.message, code: "invalid_client" });
    }
  });
  router.delete("/oidc/clients/:id", ownerOnly, (request, response) => {
    try {
      oidc.removeClient(request.params.id, request.boxpilotSession.owner.id);
      response.json({ removed: true });
    } catch (error) {
      response.status(404).json({ error: error.message, code: "client_not_found" });
    }
  });
  return router;
}

function redirectWith(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, value);
  return url.toString();
}

function renderAuthorizationError(response, error) {
  // Only bounce back to the client when it is safe (a validated redirect URI); otherwise show the page.
  if (error instanceof OidcError && error.redirectUri) {
    return response.redirect(redirectWith(error.redirectUri, { error: error.code, error_description: error.description, state: error.state }));
  }
  return response.status(400).type("html").send(simplePage("This sign-in request could not be honoured", error?.description ?? "The request was invalid."));
}

const pageStyle = "body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{max-width:420px;width:calc(100% - 32px);background:#161b22;border:1px solid #30363d;border-radius:14px;padding:28px}h1{font-size:20px;margin:0 0 6px}p{color:#9da7b3;line-height:1.5}code{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:1px 6px}.scopes{list-style:none;padding:0;margin:16px 0}.scopes li{padding:6px 0;border-bottom:1px solid #21262d}.row{display:flex;gap:10px;margin-top:20px}button{flex:1;font-size:15px;font-weight:600;padding:11px;border-radius:9px;border:1px solid #30363d;cursor:pointer}.approve{background:#2f81f7;color:#fff;border-color:#2f81f7}.deny{background:transparent;color:#e6edf3}";

function simplePage(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${pageStyle}</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

function consentPage({ session, validated, query }) {
  const scopes = validated.scope.split(/\s+/).filter(Boolean);
  const fields = ["client_id", "redirect_uri", "response_type", "scope", "state", "nonce", "code_challenge", "code_challenge_method"];
  const hidden = fields.map((name) => (query[name] != null ? `<input type="hidden" name="${name}" value="${escapeHtml(query[name])}">` : "")).join("");
  const scopeList = scopes.map((scope) => `<li>${escapeHtml(scopeDescriptions[scope] ?? scope)}</li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in with BoxPilot</title><style>${pageStyle}</style></head><body><div class="card">
    <h1>Sign in to ${escapeHtml(validated.client.name)}</h1>
    <p>You are signed in to BoxPilot as <strong>${escapeHtml(session.owner.username)}</strong>. <strong>${escapeHtml(validated.client.name)}</strong> will be able to:</p>
    <ul class="scopes">${scopeList}</ul>
    <p>It will send you to <code>${escapeHtml(new URL(validated.redirectUri).host)}</code>.</p>
    <form method="post" action="/oidc/authorize">
      ${hidden}
      <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
      <div class="row">
        <button class="deny" type="submit" name="decision" value="deny">Cancel</button>
        <button class="approve" type="submit" name="decision" value="approve">Allow</button>
      </div>
    </form>
  </div></body></html>`;
}
