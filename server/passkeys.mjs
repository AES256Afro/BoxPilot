/**
 * Passkey (WebAuthn) sign-in and recovery codes (M19.1).
 *
 * This orchestrates the two ceremonies on top of server/webauthn.mjs: it issues single-use
 * challenges, hands the browser the options it needs, and verifies what comes back. A registered
 * passkey is bound to the RP ID of the origin it was created at (boxpilot.lan, the tailnet name,
 * localhost), because that is how WebAuthn works — a passkey made over Tailscale is offered over
 * Tailscale, one made on the LAN name is offered there. The UI says so plainly rather than pretending
 * one passkey covers every way in.
 *
 * The origin is taken from the browser (window.location.origin). Trusting it is safe: every security
 * check lives in material the authenticator signed — the single-use challenge, the origin inside the
 * signed client data, and the RP ID hash inside the signed authenticator data — so a caller that
 * lies about its origin simply cannot produce anything that verifies.
 *
 * Recovery codes are the way back in when every authenticator is lost: high-entropy, shown once,
 * stored only as hashes, each good for exactly one sign-in.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  base64urlToBuffer, bufferToBase64url, isSecureOrigin, isSupportedAlgorithm, relyingPartyId,
  verifyAssertion, verifyRegistration,
} from "./webauthn.mjs";

const labelPattern = /^[\p{L}\p{N} ._-]{1,48}$/u;
// Crockford-style base32 without I, L, O, U — no character a person will misread or spell rudely.
const codeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function hashRecoveryCode(code) {
  return createHash("sha256").update(canonicalCode(code)).digest("hex");
}

/** One canonical form for a typed code: letters only, upper-cased, dashes and spaces ignored. */
export function canonicalCode(code) {
  return String(code ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** A group of `length` characters drawn uniformly from the code alphabet. */
function codeGroup(length) {
  const bytes = randomBytes(length);
  let out = "";
  for (let index = 0; index < length; index += 1) out += codeAlphabet[bytes[index] % codeAlphabet.length];
  return out;
}

/** A recovery code: four groups of five characters, ~99 bits, formatted with dashes. */
export function makeRecoveryCode() {
  return [codeGroup(5), codeGroup(5), codeGroup(5), codeGroup(5)].join("-");
}

export function createPasskeyService({
  store,
  now = () => Date.now(),
  challengeTtlMs = 5 * 60 * 1000,
  recoveryCodeCount = 10,
  productName = "BoxPilot",
} = {}) {
  // challenge(base64url) -> { type, ownerId, rpId, origin, expiresAt }. In memory on purpose: a
  // challenge is short-lived and single-use, and losing them on a restart only asks the browser to
  // start the ceremony again.
  const challenges = new Map();

  function pruneChallenges() {
    const at = now();
    for (const [key, record] of challenges) if (record.expiresAt <= at) challenges.delete(key);
    // A hard cap so a flood of options requests cannot grow the map without bound.
    if (challenges.size > 500) for (const key of [...challenges.keys()].slice(0, challenges.size - 500)) challenges.delete(key);
  }

  /** Validate a browser-supplied origin and derive its RP ID, or throw a readable reason. */
  function relyingParty(origin) {
    if (typeof origin !== "string" || origin.length > 253 + 16) throw new Error("a valid origin is required");
    if (!isSecureOrigin(origin)) throw new Error("Passkeys need a secure connection (HTTPS, or Tailscale). Set up HTTPS on the LAN first.");
    return { origin, rpId: relyingPartyId(origin) };
  }

  function issueChallenge({ type, ownerId = null, origin, rpId }) {
    pruneChallenges();
    const challenge = bufferToBase64url(randomBytes(32));
    challenges.set(challenge, { type, ownerId, rpId, origin, expiresAt: now() + challengeTtlMs });
    return challenge;
  }

  /** Take a challenge back, once. Verifies it exists, is unexpired, and matches this ceremony. */
  function takeChallenge(challenge, { type, origin, rpId }) {
    const record = typeof challenge === "string" ? challenges.get(challenge) : null;
    challenges.delete(challenge); // single use, whether or not it checks out
    if (!record) throw new Error("This sign-in attempt expired or was already used. Try again.");
    if (record.expiresAt <= now()) throw new Error("This sign-in attempt expired. Try again.");
    if (record.type !== type || record.origin !== origin || record.rpId !== rpId) throw new Error("This sign-in attempt does not match. Try again.");
    return record;
  }

  // ---- Registration --------------------------------------------------------------------------
  function registerOptions({ owner, origin }) {
    const rp = relyingParty(origin);
    const challenge = issueChallenge({ type: "register", ownerId: owner.id, origin: rp.origin, rpId: rp.rpId });
    // Exclude the passkeys this owner already has *for this RP ID*, so the same authenticator is not
    // enrolled twice for the same way in.
    const excludeCredentials = store.listPasskeys(owner.id)
      .filter((key) => key.rpId === rp.rpId)
      .map((key) => ({ type: "public-key", id: key.id, transports: key.transports }));
    return {
      challenge,
      rp: { id: rp.rpId, name: productName },
      user: { id: bufferToBase64url(Buffer.from(owner.id)), name: owner.username, displayName: owner.username },
      pubKeyCredParams: [-7, -8, -257].map((alg) => ({ type: "public-key", alg })),
      excludeCredentials,
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
      timeout: challengeTtlMs,
      attestation: "none",
    };
  }

  function registerVerify({ owner, origin, credential }) {
    const rp = relyingParty(origin);
    takeChallenge(credential?.challenge, { type: "register", origin: rp.origin, rpId: rp.rpId });
    const label = typeof credential?.label === "string" && labelPattern.test(credential.label.trim()) ? credential.label.trim() : "Passkey";
    const id = credential?.id;
    if (typeof id !== "string" || id.length < 1 || id.length > 1024) throw new Error("the credential id is missing");
    if (!isSupportedAlgorithm(credential?.algorithm)) throw new Error("this authenticator uses a key type BoxPilot cannot verify");
    if (store.findPasskeyById(id)) throw new Error("This passkey is already registered");
    const publicKeyDer = base64urlToBuffer(credential.publicKey);
    verifyRegistration({
      clientDataJSON: base64urlToBuffer(credential.clientDataJSON),
      authenticatorData: base64urlToBuffer(credential.authenticatorData),
      publicKeyDer,
      algorithm: credential.algorithm,
      expected: { challenge: credential.challenge, origin: rp.origin, rpId: rp.rpId, requireUserVerification: false },
    });
    const transports = Array.isArray(credential.transports) ? credential.transports.filter((value) => typeof value === "string").slice(0, 8) : [];
    return store.addPasskey({ id, ownerId: owner.id, rpId: rp.rpId, publicKey: credential.publicKey, algorithm: Number(credential.algorithm), transports, label });
  }

  // ---- Authentication ------------------------------------------------------------------------
  function authenticateOptions({ origin }) {
    const rp = relyingParty(origin);
    const challenge = issueChallenge({ type: "authenticate", origin: rp.origin, rpId: rp.rpId });
    // Empty allowCredentials: the discoverable passkeys are offered by the platform, so no credential
    // id is revealed to an anonymous caller, and the owner picks an account in the browser's own UI.
    return { challenge, rpId: rp.rpId, allowCredentials: [], userVerification: "preferred", timeout: challengeTtlMs };
  }

  /** Verify a sign-in assertion and return the owner it belongs to (never a disabled account). */
  function authenticateVerify({ origin, response }) {
    const rp = relyingParty(origin);
    takeChallenge(response?.challenge, { type: "authenticate", origin: rp.origin, rpId: rp.rpId });
    const id = response?.id;
    const credential = typeof id === "string" ? store.findPasskeyById(id) : null;
    if (!credential || credential.rpId !== rp.rpId) throw new Error("This passkey is not registered here.");
    const owner = store.findOwnerById(credential.ownerId);
    if (!owner || owner.role === "disabled") throw new Error("This passkey belongs to an account that cannot sign in.");
    const verdict = verifyAssertion({
      clientDataJSON: base64urlToBuffer(response.clientDataJSON),
      authenticatorData: base64urlToBuffer(response.authenticatorData),
      signature: base64urlToBuffer(response.signature),
      credential,
      expected: { challenge: response.challenge, origin: rp.origin, rpId: rp.rpId, requireUserVerification: false },
    });
    store.updatePasskeyUse(credential.id, verdict.newSignCount);
    if (verdict.cloned) store.recordAudit("passkey.counter-regressed", { actorId: owner.id, subjectId: owner.id, details: { label: credential.label } });
    return { owner, credential, cloned: verdict.cloned };
  }

  // ---- Management + recovery -----------------------------------------------------------------
  function list(ownerId) {
    return store.listPasskeys(ownerId);
  }

  function rename(ownerId, id, label) {
    if (typeof label !== "string" || !labelPattern.test(label.trim())) throw new Error("A passkey name is 1 to 48 letters, numbers, spaces, dots, dashes, or underscores");
    return store.renamePasskey(id, ownerId, label.trim());
  }

  function remove(ownerId, id) {
    return store.deletePasskey(id, ownerId);
  }

  function generateRecoveryCodes(ownerId, { actorId = null } = {}) {
    const codes = Array.from({ length: recoveryCodeCount }, () => makeRecoveryCode());
    // Guard against the astronomically unlikely collision so no two hashes clash in the table.
    const hashes = [...new Set(codes.map(hashRecoveryCode))];
    while (hashes.length < recoveryCodeCount) { const extra = makeRecoveryCode(); if (!hashes.includes(hashRecoveryCode(extra))) { codes.push(extra); hashes.push(hashRecoveryCode(extra)); } }
    store.replaceRecoveryCodes(ownerId, hashes, { actorId });
    return { codes, count: codes.length };
  }

  /** Spend a typed recovery code, returning the owner it authenticates, or null. */
  function useRecoveryCode(code) {
    const canonical = canonicalCode(code);
    if (canonical.length < 16) return null; // far too short to be one of ours; skip the lookup
    const ownerId = store.consumeRecoveryCode(hashRecoveryCode(code));
    if (!ownerId) return null;
    const owner = store.findOwnerById(ownerId);
    return owner && owner.role !== "disabled" ? owner : null;
  }

  function status(ownerId) {
    return { passkeys: store.listPasskeys(ownerId), recoveryCodesRemaining: store.countRecoveryCodes(ownerId) };
  }

  return {
    registerOptions, registerVerify, authenticateOptions, authenticateVerify,
    list, rename, remove, generateRecoveryCodes, useRecoveryCode, status,
    internals: { challenges, hashRecoveryCode },
  };
}
