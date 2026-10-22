import { afterEach, describe, expect, it, vi } from "vitest";
import { deletePasskey, generateRecoveryCodes, registerPasskey, signInWithPasskey } from "./passkey";

/*
 * The passkey client: what it hands the browser, what it sends the server, and how it says a
 * refusal. Bytes cross as base64url (no padding, no + or /), the challenge goes back exactly as
 * the server gave it, and requests that change something carry the CSRF token.
 */

afterEach(() => { vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const text = (buffer: ArrayBuffer | BufferSource | undefined) => Array.from(new Uint8Array(buffer as ArrayBuffer));

/** Every request made, with its parsed body and headers, answered from `answers` by path. */
function server(answers: Record<string, () => Response>) {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    requests.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null });
    return answers[url]?.() ?? json({ error: `unexpected ${url}` }, 500);
  }));
  return requests;
}
const credentials = (methods: { create?: (options: CredentialCreationOptions) => unknown; get?: (options: CredentialRequestOptions) => unknown }) => vi.stubGlobal("navigator", { ...navigator, credentials: methods });

// Challenge bytes 0xfb 0xff 0xfe encode as "-__-": both base64url substitutions, and no padding.
const registerOptions = { challenge: "-__-", rp: { id: "box.example", name: "BoxPilot" }, user: { id: "AQID", name: "alex", displayName: "alex" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [{ type: "public-key", id: "BAU", transports: ["usb"] }], authenticatorSelection: { residentKey: "preferred" }, timeout: 60_000 };

describe("registering a passkey", () => {
  it("hands the browser the server's bytes and sends back the key as base64url, with the CSRF token", async () => {
    const requests = server({
      "/api/v1/auth/passkey/register/options": () => json(registerOptions),
      "/api/v1/auth/passkey/register/verify": () => json({ passkey: { id: "pk1", label: "Laptop" } }),
    });
    let handed: CredentialCreationOptions | null = null;
    credentials({ create: async (options) => {
      handed = options;
      return { rawId: bytes(0xfb, 0xef), response: { getPublicKey: () => bytes(1, 2, 3), getPublicKeyAlgorithm: () => -7, getAuthenticatorData: () => bytes(9), clientDataJSON: bytes(0x7b, 0x7d), getTransports: () => ["internal"] } };
    } });
    await expect(registerPasskey("csrf-token", "Laptop")).resolves.toEqual({ id: "pk1", label: "Laptop" });
    const publicKey = (handed as unknown as CredentialCreationOptions).publicKey!;
    expect(text(publicKey.challenge)).toEqual([0xfb, 0xff, 0xfe]);
    expect(text(publicKey.user.id)).toEqual([1, 2, 3]);
    expect(text(publicKey.excludeCredentials![0].id)).toEqual([4, 5]);
    expect(publicKey.attestation).toBe("none");
    expect(requests.map((request) => request.headers["X-BoxPilot-CSRF"])).toEqual(["csrf-token", "csrf-token"]);
    expect(requests[1].body).toEqual({ origin: window.location.origin, credential: { challenge: "-__-", id: "--8", label: "Laptop", algorithm: -7, publicKey: "AQID", authenticatorData: "CQ", clientDataJSON: "e30", transports: ["internal"] } });
  });

  it("says why the browser refused, and refuses a browser that cannot export the key", async () => {
    server({ "/api/v1/auth/passkey/register/options": () => json(registerOptions) });
    credentials({ create: async () => { throw new DOMException("x", "InvalidStateError"); } });
    await expect(registerPasskey("csrf", "Laptop")).rejects.toMatchObject({ message: "A passkey for this account is already on this device.", code: "passkey_cancelled" });
    credentials({ create: async () => { throw new DOMException("x", "NotAllowedError"); } });
    await expect(registerPasskey("csrf", "Laptop")).rejects.toThrow("Passkey setup was cancelled or timed out.");
    credentials({ create: async () => null });
    await expect(registerPasskey("csrf", "Laptop")).rejects.toThrow("No passkey was created");
    credentials({ create: async () => ({ rawId: bytes(1), response: { getAuthenticatorData: () => bytes(1), clientDataJSON: bytes(1) } }) });
    await expect(registerPasskey("csrf", "Laptop")).rejects.toMatchObject({ code: "passkey_unsupported" });
  });
});

describe("signing in with a passkey", () => {
  it("sends the assertion as base64url without a CSRF token, and a missing user handle as null", async () => {
    const requests = server({
      "/api/v1/auth/passkey/options": () => json({ challenge: "AAEC", rpId: "box.example", allowCredentials: [{ type: "public-key", id: "Bw" }], userVerification: "required", timeout: 60_000 }),
      "/api/v1/auth/passkey/verify": () => json({ authenticated: true, owner: { id: "alex" } }),
    });
    let handed: CredentialRequestOptions | null = null;
    credentials({ get: async (options) => { handed = options; return { rawId: bytes(7), response: { authenticatorData: bytes(1), clientDataJSON: bytes(2), signature: bytes(0xff, 0xff), userHandle: null } }; } });
    await expect(signInWithPasskey()).resolves.toMatchObject({ authenticated: true, bootstrapRequired: false });
    const publicKey = (handed as unknown as CredentialRequestOptions).publicKey!;
    expect(text(publicKey.challenge)).toEqual([0, 1, 2]);
    expect(text(publicKey.allowCredentials![0].id)).toEqual([7]);
    expect(requests[1].headers["X-BoxPilot-CSRF"]).toBeUndefined();
    expect(requests[1].body).toEqual({ origin: window.location.origin, response: { challenge: "AAEC", id: "Bw", authenticatorData: "AQ", clientDataJSON: "Ag", signature: "__8", userHandle: null } });
  });

  it("says when the browser's chooser was cancelled, and passes on the server's refusal and its code", async () => {
    server({ "/api/v1/auth/passkey/options": () => json({ challenge: "AA", rpId: "box.example", allowCredentials: [], userVerification: "required", timeout: 1 }), "/api/v1/auth/passkey/verify": () => json({ error: "That passkey is not registered here", code: "passkey_unknown" }, 401) });
    credentials({ get: async () => { throw new DOMException("x", "NotAllowedError"); } });
    await expect(signInWithPasskey()).rejects.toThrow("Passkey sign-in was cancelled or timed out.");
    credentials({ get: async () => ({ rawId: bytes(1), response: { authenticatorData: bytes(1), clientDataJSON: bytes(1), signature: bytes(1), userHandle: bytes(5) } }) });
    await expect(signInWithPasskey()).rejects.toMatchObject({ message: "That passkey is not registered here", code: "passkey_unknown" });
  });
});

describe("removing passkeys and making recovery codes", () => {
  it("sends the password with the CSRF token, and passes on a refusal", async () => {
    const requests = server({
      "/api/v1/auth/passkey/pk%2F1": () => json({ error: "Wrong password", code: "reauthentication_required" }, 401),
      "/api/v1/auth/passkey/recovery-codes": () => json({ codes: ["a-b"], count: 1 }),
    });
    await expect(deletePasskey("csrf", "pk/1", "pw")).rejects.toMatchObject({ message: "Wrong password", code: "reauthentication_required" });
    await expect(generateRecoveryCodes("csrf", "pw")).resolves.toEqual({ codes: ["a-b"], count: 1 });
    expect(requests.map((request) => [request.method, request.headers["X-BoxPilot-CSRF"], request.body])).toEqual([["DELETE", "csrf", { password: "pw" }], ["POST", "csrf", { password: "pw" }]]);
  });
});
