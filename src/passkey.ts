import type { AuthStatus } from "./auth";
import { AuthError } from "./auth";

/**
 * Passkey (WebAuthn) client (M19.1).
 *
 * The registration path leans on the WebAuthn Level 2 accessors — getPublicKey, getAuthenticatorData,
 * getPublicKeyAlgorithm — so the server is handed the key already in DER form and never needs to
 * decode CBOR. Everything is exchanged as base64url strings.
 */

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

/** Whether this browser can do passkeys at all, and is on a secure origin (HTTPS or localhost). */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && Boolean(window.PublicKeyCredential) && window.isSecureContext;
}

export interface PasskeyInfo { id: string; rpId: string; label: string; transports: string[]; createdAt: string; lastUsedAt: string | null }
export interface PasskeyStatus { passkeys: PasskeyInfo[]; recoveryCodesRemaining: number }

interface RegisterOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  excludeCredentials: Array<{ type: "public-key"; id: string; transports?: string[] }>;
  authenticatorSelection: AuthenticatorSelectionCriteria;
  timeout: number;
}

interface AuthenticateOptions { challenge: string; rpId: string; allowCredentials: Array<{ type: "public-key"; id: string }>; userVerification: UserVerificationRequirement; timeout: number }

async function postJson<T>(path: string, body: unknown, csrfToken?: string): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-BoxPilot-CSRF": csrfToken } : {}) },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!response.ok) throw new AuthError(result.error ?? "Passkey request failed", result.code ?? null);
  return result;
}

const origin = () => window.location.origin;

/** Register a new passkey for the signed-in owner. Returns the stored passkey summary. */
export async function registerPasskey(csrfToken: string, label: string): Promise<{ id: string; label: string }> {
  const options = await postJson<RegisterOptions>("/api/v1/auth/passkey/register/options", { origin: origin() }, csrfToken);
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        challenge: base64urlToBuffer(options.challenge),
        rp: options.rp,
        user: { id: base64urlToBuffer(options.user.id), name: options.user.name, displayName: options.user.displayName },
        pubKeyCredParams: options.pubKeyCredParams,
        excludeCredentials: options.excludeCredentials.map((entry) => ({ type: entry.type, id: base64urlToBuffer(entry.id), transports: entry.transports as AuthenticatorTransport[] | undefined })),
        authenticatorSelection: options.authenticatorSelection,
        timeout: options.timeout,
        attestation: "none",
      },
    })) as PublicKeyCredential | null;
  } catch (error) {
    throw new AuthError(registrationErrorMessage(error), "passkey_cancelled");
  }
  if (!credential) throw new AuthError("No passkey was created", "passkey_cancelled");
  const attestation = credential.response as AuthenticatorAttestationResponse;
  const publicKey = attestation.getPublicKey?.();
  const algorithm = attestation.getPublicKeyAlgorithm?.();
  if (!publicKey || typeof algorithm !== "number") throw new AuthError("This browser could not export the passkey's public key", "passkey_unsupported");
  const body = {
    origin: origin(),
    credential: {
      challenge: options.challenge,
      id: bufferToBase64url(credential.rawId),
      label,
      algorithm,
      publicKey: bufferToBase64url(publicKey),
      authenticatorData: bufferToBase64url(attestation.getAuthenticatorData()),
      clientDataJSON: bufferToBase64url(attestation.clientDataJSON),
      transports: attestation.getTransports?.() ?? [],
    },
  };
  const result = await postJson<{ passkey: { id: string; label: string } }>("/api/v1/auth/passkey/register/verify", body, csrfToken);
  return result.passkey;
}

/** Sign in with a passkey. Prompts the browser's passkey chooser. */
export async function signInWithPasskey(): Promise<AuthStatus> {
  const options = await postJson<AuthenticateOptions>("/api/v1/auth/passkey/options", { origin: origin() });
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: base64urlToBuffer(options.challenge),
        rpId: options.rpId,
        allowCredentials: options.allowCredentials.map((entry) => ({ type: entry.type, id: base64urlToBuffer(entry.id) })),
        userVerification: options.userVerification,
        timeout: options.timeout,
      },
    })) as PublicKeyCredential | null;
  } catch (error) {
    throw new AuthError(assertionErrorMessage(error), "passkey_cancelled");
  }
  if (!credential) throw new AuthError("No passkey was offered", "passkey_cancelled");
  const assertion = credential.response as AuthenticatorAssertionResponse;
  const body = {
    origin: origin(),
    response: {
      challenge: options.challenge,
      id: bufferToBase64url(credential.rawId),
      authenticatorData: bufferToBase64url(assertion.authenticatorData),
      clientDataJSON: bufferToBase64url(assertion.clientDataJSON),
      signature: bufferToBase64url(assertion.signature),
      userHandle: assertion.userHandle ? bufferToBase64url(assertion.userHandle) : null,
    },
  };
  return { ...(await postJson<AuthStatus>("/api/v1/auth/passkey/verify", body)), bootstrapRequired: false };
}

export async function signInWithRecoveryCode(code: string): Promise<AuthStatus> {
  return { ...(await postJson<AuthStatus>("/api/v1/auth/passkey/recovery", { code })), bootstrapRequired: false };
}

export async function fetchPasskeyStatus(): Promise<PasskeyStatus> {
  const response = await fetch("/api/v1/auth/passkey");
  if (!response.ok) throw new Error("Could not load passkeys");
  return response.json() as Promise<PasskeyStatus>;
}

export async function renamePasskey(csrfToken: string, id: string, label: string): Promise<PasskeyStatus> {
  return postJson<PasskeyStatus>(`/api/v1/auth/passkey/${encodeURIComponent(id)}`, { label }, csrfToken).catch((error) => { throw error; });
}

export async function deletePasskey(csrfToken: string, id: string, password: string): Promise<PasskeyStatus> {
  const response = await fetch(`/api/v1/auth/passkey/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
    body: JSON.stringify({ password }),
  });
  const result = (await response.json().catch(() => ({}))) as PasskeyStatus & { error?: string; code?: string };
  if (!response.ok) throw new AuthError(result.error ?? "Could not remove the passkey", result.code ?? null);
  return result;
}

export async function generateRecoveryCodes(csrfToken: string, password: string): Promise<{ codes: string[]; count: number }> {
  return postJson<{ codes: string[]; count: number }>("/api/v1/auth/passkey/recovery-codes", { password }, csrfToken);
}

// Turn the DOMExceptions the platform throws into something a person can act on.
function registrationErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "InvalidStateError") return "A passkey for this account is already on this device.";
  if (name === "NotAllowedError") return "Passkey setup was cancelled or timed out.";
  return error instanceof Error ? error.message : "Passkey setup failed.";
}

function assertionErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError") return "Passkey sign-in was cancelled or timed out.";
  return error instanceof Error ? error.message : "Passkey sign-in failed.";
}
