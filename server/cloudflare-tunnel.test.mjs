import { describe, expect, it } from "vitest";
import { cloudflarePreviousTunnelCredential, tunnelOfKey } from "./cloudflare-tunnel.mjs";
import { credentialNamePattern } from "./credentials.mjs";

const tunnelId = "3f1c9a52-7b1e-4d0a-9c55-0a1b2c3d4e5f";
const accountTag = "0123456789abcdef0123456789abcdef";
const secret = "c2VjcmV0LW9mLXRoZS10dW5uZWw=";
const keyOf = (fields, encoding = "base64") => Buffer.from(JSON.stringify(fields)).toString(encoding);

// M65.3: Connect gave the Cloudflare Tunnel app a new tunnel's key without looking at the one it ran.
describe("which tunnel a connector's key runs", () => {
  it("reads the tunnel's id and its account from the key, and never gives the secret back", () => {
    const key = keyOf({ a: accountTag, t: tunnelId, s: secret });
    const named = tunnelOfKey(key);
    expect(named).toEqual({ tunnelId, accountTag });
    expect(JSON.stringify(named)).not.toContain(secret);
    expect(JSON.stringify(named)).not.toContain(key);
  });

  it("takes the key with or without its padding, in either base64 alphabet, and with space around it", () => {
    // A secret chosen so the encoding has both padding and the two characters the alphabets differ in.
    const fields = { a: accountTag, t: tunnelId, s: "??>>~~??>>" };
    const padded = keyOf(fields);
    expect(padded).toMatch(/=+$/);
    expect(padded).toMatch(/[+/]/);
    for (const key of [padded, padded.replace(/=+$/, ""), keyOf(fields, "base64url"), ` ${padded}\n`]) {
      expect(tunnelOfKey(key), key).toEqual({ tunnelId, accountTag });
    }
    expect(tunnelOfKey(keyOf({ a: accountTag.toUpperCase(), t: tunnelId.toUpperCase(), s: secret }))).toEqual({ tunnelId, accountTag });
  });

  it("answers null for anything that is not such a key, and never throws", () => {
    const notKeys = [
      null, undefined, 42, {}, [], "", "   ", "not base64 at all!", "eyJhIjoiZmFrZS1ydW4ta2V5LWZvci10ZXN0cyJ9", "A".repeat(5000),
      keyOf("a string"), keyOf([accountTag, tunnelId]), keyOf(null), keyOf({ a: accountTag, s: secret }), keyOf({ t: tunnelId, s: secret }),
      keyOf({ a: accountTag, t: 7, s: secret }), keyOf({ a: accountTag, t: "../../zones", s: secret }), keyOf({ a: "an account/../x", t: tunnelId, s: secret }),
      keyOf({ a: accountTag, t: tunnelId, s: secret }).slice(0, 40),
    ];
    for (const value of notKeys) expect(tunnelOfKey(value), String(value).slice(0, 40)).toBeNull();
  });

  it("keeps a replaced key under a name the credential store takes", () => {
    expect(cloudflarePreviousTunnelCredential).toMatch(credentialNamePattern);
  });
});
