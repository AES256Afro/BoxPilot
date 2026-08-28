/**
 * WebAuthn verification, with node:crypto only (M19.1).
 *
 * BoxPilot deliberately runs on four npm dependencies, and the sign-in path is exactly where a
 * subtle bug is worst, so rather than vendor a WebAuthn library this verifies the ceremonies
 * directly. The one thing that would otherwise force a CBOR decoder — reading the credential public
 * key out of the attestation object at registration — is avoided by having the browser hand us the
 * key already in DER form via the WebAuthn Level 2 accessors (`getPublicKey`, `getAuthenticatorData`).
 * So the server only ever parses authenticator-data bytes and the JSON client-data, and verifies an
 * ordinary signature. Attestation is not checked (we request `attestation: "none"`): proving the
 * make and model of an authenticator is not something a single-owner home server needs, and skipping
 * it removes the one part that needs CBOR and a trust store.
 */
import { createHash, createPublicKey, verify as cryptoVerify, timingSafeEqual } from "node:crypto";

/** Authenticator-data flag bits (WebAuthn §6.1). */
const FLAG_UP = 0x01; // user present
const FLAG_UV = 0x04; // user verified
const FLAG_AT = 0x40; // attested credential data included
const FLAG_ED = 0x80; // extension data included

/**
 * COSE signature algorithms mapped to how node verifies them. `hash` is the digest node applies to
 * the signed data; EC signatures from WebAuthn are ASN.1 DER (node's default), which we state
 * explicitly. Ed25519 hashes internally, so its node hash is null.
 */
const algorithms = new Map([
  [-7, { name: "ES256", hash: "sha256", dsaEncoding: "der" }],
  [-35, { name: "ES384", hash: "sha384", dsaEncoding: "der" }],
  [-36, { name: "ES512", hash: "sha512", dsaEncoding: "der" }],
  [-257, { name: "RS256", hash: "sha256" }],
  [-258, { name: "RS384", hash: "sha384" }],
  [-259, { name: "RS512", hash: "sha512" }],
  [-8, { name: "Ed25519", hash: null }],
]);

export function isSupportedAlgorithm(alg) {
  return algorithms.has(Number(alg));
}

export function base64urlToBuffer(value) {
  if (typeof value !== "string") throw new Error("expected a base64url string");
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function bufferToBase64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest();
}

/** Constant-time compare for two base64url strings that should be equal (challenge, etc.). */
export function equalStrings(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Parse the fixed header of authenticator data: the RP ID hash, the flag byte, and the signature
 * counter. The attested-credential-data and extensions that may follow are not needed here (the
 * client sends the public key separately) so they are left unparsed.
 */
export function parseAuthenticatorData(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 37) throw new Error("authenticator data is too short");
  const rpIdHash = buffer.subarray(0, 32);
  const flagBits = buffer[32];
  const signCount = buffer.readUInt32BE(33);
  return {
    rpIdHash,
    signCount,
    flags: {
      userPresent: Boolean(flagBits & FLAG_UP),
      userVerified: Boolean(flagBits & FLAG_UV),
      attestedCredentialData: Boolean(flagBits & FLAG_AT),
      extensionData: Boolean(flagBits & FLAG_ED),
    },
  };
}

/** Parse and sanity-check the client data JSON the browser signed over. */
export function decodeClientData(clientDataJSON) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(clientDataJSON).toString("utf8"));
  } catch {
    throw new Error("client data is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("client data is not an object");
  return parsed;
}

/**
 * The origin the ceremony must have happened at is only "secure" — the precondition WebAuthn and the
 * whole passkey story rest on — when it is HTTPS, or plain HTTP to localhost (the browser's own
 * exception for local development). This is what makes M18.2's LAN certificate the thing that lights
 * passkeys up off the tailnet.
 */
export function isSecureOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1");
  } catch {
    return false;
  }
}

/** The RP ID for an origin is its host (no port). WebAuthn forbids an IP-address RP ID. */
export function relyingPartyId(origin) {
  const url = new URL(origin);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    if (host !== "localhost") throw new Error("passkeys need a host name, not an IP address (use boxpilot.lan or Tailscale)");
  }
  return host;
}

/**
 * Checks common to both ceremonies: the type is what we asked for, the challenge is the one we
 * issued, the origin is exactly the expected one and is secure, and the signed RP ID hash matches
 * the RP ID derived from that origin. The RP ID hash is signed by the authenticator, so this is the
 * binding that makes trusting the browser-reported origin safe.
 */
function verifyCommon({ clientDataJSON, authenticatorData, expected, expectedType }) {
  const clientData = decodeClientData(clientDataJSON);
  if (clientData.type !== expectedType) throw new Error(`unexpected ceremony type ${clientData.type}`);
  if (!equalStrings(clientData.challenge, expected.challenge)) throw new Error("challenge does not match");
  if (clientData.origin !== expected.origin) throw new Error("origin does not match");
  if (clientData.crossOrigin === true) throw new Error("cross-origin ceremony refused");
  if (!isSecureOrigin(expected.origin)) throw new Error("origin is not a secure context");
  const auth = parseAuthenticatorData(authenticatorData);
  const expectedRpIdHash = sha256(Buffer.from(expected.rpId, "utf8"));
  if (!timingSafeEqual(auth.rpIdHash, expectedRpIdHash)) throw new Error("RP ID hash does not match");
  if (!auth.flags.userPresent) throw new Error("the authenticator did not confirm user presence");
  if (expected.requireUserVerification && !auth.flags.userVerified) throw new Error("this action needs user verification (a PIN or biometric)");
  return auth;
}

/**
 * Verify a registration ceremony. The public key itself comes from the client (DER, via
 * `getPublicKey`), so this validates the client data, RP ID and flags, and confirms the key/alg are
 * usable; it returns nothing to store beyond what the caller already holds.
 */
export function verifyRegistration({ clientDataJSON, authenticatorData, publicKeyDer, algorithm, expected }) {
  verifyCommon({ clientDataJSON, authenticatorData, expected, expectedType: "webauthn.create" });
  if (!isSupportedAlgorithm(algorithm)) throw new Error(`unsupported key algorithm ${algorithm}`);
  // A key node cannot import is worthless later; fail now, at registration, not at the first sign-in.
  try {
    createPublicKey({ key: Buffer.from(publicKeyDer), format: "der", type: "spki" });
  } catch {
    throw new Error("the credential public key could not be read");
  }
  return { ok: true };
}

/**
 * Verify a signature over `authenticatorData || sha256(clientDataJSON)` with the stored public key.
 * Returns true/false and never throws for an ordinary bad signature.
 */
export function verifySignature({ algorithm, publicKeyDer, authenticatorData, clientDataJSON, signature }) {
  const spec = algorithms.get(Number(algorithm));
  if (!spec) return false;
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(publicKeyDer), format: "der", type: "spki" });
  } catch {
    return false;
  }
  const signedData = Buffer.concat([Buffer.from(authenticatorData), sha256(clientDataJSON)]);
  try {
    const keyInput = spec.dsaEncoding ? { key, dsaEncoding: spec.dsaEncoding } : key;
    return cryptoVerify(spec.hash, signedData, keyInput, Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Verify an authentication ceremony and decide the new signature counter. A counter that goes
 * backwards (and is not simply always zero, as many platform authenticators report) is the signal
 * for a possibly-cloned credential; it is surfaced, not swallowed.
 */
export function verifyAssertion({ clientDataJSON, authenticatorData, signature, credential, expected }) {
  const auth = verifyCommon({ clientDataJSON, authenticatorData, expected, expectedType: "webauthn.get" });
  const good = verifySignature({
    algorithm: credential.algorithm,
    publicKeyDer: base64urlToBuffer(credential.publicKey),
    authenticatorData,
    clientDataJSON,
    signature,
  });
  if (!good) throw new Error("the passkey signature did not verify");
  const previous = Number(credential.signCount) || 0;
  const cloned = auth.signCount !== 0 && previous !== 0 && auth.signCount <= previous;
  return { ok: true, newSignCount: auth.signCount, cloned, userVerified: auth.flags.userVerified };
}
