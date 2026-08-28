import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign as cryptoSign, createHash, randomBytes } from "node:crypto";
import { createStateStore } from "./state.mjs";
import { createPasskeyService, canonicalCode, makeRecoveryCode } from "./passkeys.mjs";
import { bufferToBase64url } from "./webauthn.mjs";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest();
const origin = "https://boxpilot.lan:8443";
const rpId = "boxpilot.lan";

/** A software passkey that produces exactly what the browser accessors hand the server. */
function softwareAuthenticator({ rp = rpId } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = bufferToBase64url(randomBytes(16));
  let counter = 0;
  const authData = () => {
    counter += 1;
    const flags = 0x01 | 0x04 | 0x40; // UP, UV, AT
    const buffer = Buffer.concat([sha256(Buffer.from(rp, "utf8")), Buffer.from([flags]), Buffer.alloc(4)]);
    buffer.writeUInt32BE(counter, 33);
    return buffer;
  };
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
  return {
    credentialId,
    publicKeyDer: publicKey.export({ format: "der", type: "spki" }),
    create(challenge, label = "My phone") {
      const authenticatorData = authData();
      return {
        challenge, id: credentialId, label, algorithm: -7,
        publicKey: bufferToBase64url(publicKey.export({ format: "der", type: "spki" })),
        authenticatorData: bufferToBase64url(authenticatorData),
        clientDataJSON: bufferToBase64url(clientData("webauthn.create", challenge)),
        transports: ["internal"],
      };
    },
    get(challenge) {
      const authenticatorData = authData();
      const clientDataJSON = clientData("webauthn.get", challenge);
      const signature = cryptoSign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), { key: privateKey, dsaEncoding: "der" });
      return {
        challenge, id: credentialId,
        authenticatorData: bufferToBase64url(authenticatorData),
        clientDataJSON: bufferToBase64url(clientDataJSON),
        signature: bufferToBase64url(signature),
        userHandle: null,
      };
    },
  };
}

describe("passkey service", () => {
  let dir; let store; let owner; let passkeys;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "boxpilot-passkeys-"));
    store = createStateStore({ databasePath: path.join(dir, "state.sqlite3") });
    const { token } = store.createBootstrapToken();
    owner = store.consumeBootstrapToken(token, { username: "alex", passwordHash: "scrypt$1$1$1$x$y" });
    passkeys = createPasskeyService({ store });
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it("registers a passkey and then signs in with it", () => {
    const authenticator = softwareAuthenticator();
    const options = passkeys.registerOptions({ owner, origin });
    expect(options.rp.id).toBe(rpId);
    expect(options.authenticatorSelection.residentKey).toBe("required");

    const stored = passkeys.registerVerify({ owner, origin, credential: authenticator.create(options.challenge, "My phone") });
    expect(stored.label).toBe("My phone");
    expect(store.countPasskeys(owner.id)).toBe(1);

    const authOptions = passkeys.authenticateOptions({ origin });
    const result = passkeys.authenticateVerify({ origin, response: authenticator.get(authOptions.challenge) });
    expect(result.owner.id).toBe(owner.id);
    expect(result.cloned).toBe(false);
    // The counter advanced and was recorded.
    expect(store.findPasskeyById(authenticator.credentialId).signCount).toBeGreaterThan(0);
  });

  it("refuses an insecure origin before any ceremony", () => {
    expect(() => passkeys.registerOptions({ owner, origin: "http://boxpilot.lan:8787" })).toThrow(/secure connection/);
    expect(() => passkeys.authenticateOptions({ origin: "http://192.168.50.20:8787" })).toThrow(/secure connection/);
  });

  it("spends a challenge only once", () => {
    const authenticator = softwareAuthenticator();
    const options = passkeys.registerOptions({ owner, origin });
    const credential = authenticator.create(options.challenge);
    passkeys.registerVerify({ owner, origin, credential });
    // Same challenge again: rejected as expired/used.
    expect(() => passkeys.registerVerify({ owner, origin, credential: softwareAuthenticator().create(options.challenge) })).toThrow(/expired or was already used/);
  });

  it("does not sign in with a passkey registered for a different RP ID", () => {
    // Register at boxpilot.lan.
    const authenticator = softwareAuthenticator();
    const options = passkeys.registerOptions({ owner, origin });
    passkeys.registerVerify({ owner, origin, credential: authenticator.create(options.challenge) });
    // Try to use it from the tailnet origin: no passkey is registered for that RP ID.
    const tailnetOrigin = "https://homebox.tail0a1b.ts.net";
    const authOptions = passkeys.authenticateOptions({ origin: tailnetOrigin });
    expect(() => passkeys.authenticateVerify({ origin: tailnetOrigin, response: authenticator.get(authOptions.challenge) })).toThrow(/not registered here/);
  });

  it("rejects an unknown credential id", () => {
    const authenticator = softwareAuthenticator();
    const authOptions = passkeys.authenticateOptions({ origin });
    expect(() => passkeys.authenticateVerify({ origin, response: authenticator.get(authOptions.challenge) })).toThrow(/not registered here/);
  });

  it("lists, renames and removes passkeys", () => {
    const authenticator = softwareAuthenticator();
    const options = passkeys.registerOptions({ owner, origin });
    const stored = passkeys.registerVerify({ owner, origin, credential: authenticator.create(options.challenge) });
    expect(passkeys.list(owner.id)).toHaveLength(1);
    passkeys.rename(owner.id, stored.id, "Yubikey");
    expect(passkeys.list(owner.id)[0].label).toBe("Yubikey");
    expect(() => passkeys.rename(owner.id, stored.id, "")).toThrow(/1 to 48/);
    passkeys.remove(owner.id, stored.id);
    expect(passkeys.list(owner.id)).toHaveLength(0);
  });

  it("issues recovery codes that each work exactly once", () => {
    const { codes, count } = passkeys.generateRecoveryCodes(owner.id);
    expect(count).toBe(10);
    expect(new Set(codes.map(canonicalCode)).size).toBe(10); // all distinct
    expect(store.countRecoveryCodes(owner.id)).toBe(10);

    // First use authenticates; second use of the same code fails.
    expect(passkeys.useRecoveryCode(codes[0]).id).toBe(owner.id);
    expect(passkeys.useRecoveryCode(codes[0])).toBeNull();
    expect(store.countRecoveryCodes(owner.id)).toBe(9);

    // Dashes and case do not matter.
    const messy = codes[1].toLowerCase().replace(/-/g, " ");
    expect(passkeys.useRecoveryCode(messy).id).toBe(owner.id);
    // Garbage returns null without a lookup.
    expect(passkeys.useRecoveryCode("nope")).toBeNull();
  });

  it("regenerating recovery codes invalidates the old set", () => {
    const first = passkeys.generateRecoveryCodes(owner.id).codes;
    passkeys.generateRecoveryCodes(owner.id);
    expect(passkeys.useRecoveryCode(first[0])).toBeNull();
  });
});

// A format sanity check on the generated codes, independent of the service.
describe("recovery code format", () => {
  it("is four groups of five characters with no ambiguous letters", () => {
    const code = makeRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(code).not.toMatch(/[ILOU]/);
  });
});
