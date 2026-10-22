/**
 * The tiny bit of JWT/JOSE the OIDC provider needs (M19.3), with node:crypto only.
 *
 * Only ES256 is supported: an EC P-256 signature in the JOSE raw form (r||s, 64 bytes), which node
 * produces with dsaEncoding "ieee-p1363". That is the one place a JWT differs from an ordinary
 * signature — the default node EC signature is ASN.1 DER, which verifiers reject. The public half is
 * published as a JWK straight from node's own JWK export.
 */
import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Sign a JWT with ES256. `now` is seconds since the epoch (injected for tests). */
export function signJwt(claims, { privateKey, kid, now, expiresInSeconds = 300 }) {
  const issuedAt = Math.floor(now);
  const payload = { iat: issuedAt, exp: issuedAt + expiresInSeconds, ...claims };
  const header = { alg: "ES256", typ: "JWT", ...(kid ? { kid } : {}) };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = cryptoSign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * Verify an ES256 JWT against a public key and check its expiry. Returns the payload or throws.
 * The userinfo endpoint verifies access tokens with it; apps verify against the published JWKS.
 */
export function verifyJwt(token, { publicKey, now, clockToleranceSeconds = 60 }) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header;
  try { header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")); } catch { throw new Error("bad JWT header"); }
  if (header.alg !== "ES256") throw new Error(`unexpected alg ${header.alg}`);
  // RFC 7515 §4.1.11: an extension the verifier does not understand must be refused. None is.
  if (header.crit !== undefined) throw new Error("unsupported critical header");
  const ok = cryptoVerify("sha256", Buffer.from(`${encodedHeader}.${encodedPayload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(encodedSignature, "base64url"));
  if (!ok) throw new Error("signature does not verify");
  let payload;
  try { payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")); } catch { throw new Error("bad JWT payload"); }
  // Every token BoxPilot signs expires; one that does not was never ours to accept.
  if (!Number.isFinite(payload?.exp)) throw new Error("token has no expiry");
  if (now > payload.exp + clockToleranceSeconds) throw new Error("token expired");
  return payload;
}

/** The public JWK for a key, as JWKS wants it: node's JWK export plus the signing metadata. */
export function publicJwk(publicKey, kid) {
  const key = (publicKey instanceof Object && publicKey.export) ? publicKey : createPublicKey(publicKey);
  return { ...key.export({ format: "jwk" }), use: "sig", alg: "ES256", kid };
}
