/**
 * The last known state (M25.1): what a page showed the last time it could read BoxPilot, kept on this
 * device so it can be shown, marked stale, when BoxPilot cannot be reached. It is the one exception to
 * "no private data is kept offline", so it is narrow on purpose:
 *
 * - explicit: a page saves a summary it built (Today's), never an API answer as it came;
 * - short-lived: a day, after which it is thrown away unread;
 * - per account: it is filed under the signed-in account and read back only by that account;
 * - cleared on sign-out, and whenever a session ends (src/auth.ts forgetSession).
 *
 * The service worker never keeps anything from the API (src/pwa/swRules.js).
 */
const prefix = "boxpilot:last-known:";
export const lastKnownTtlMs = 24 * 60 * 60_000;

export interface LastKnown<T> { savedAt: number; value: T }

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

const keyFor = (accountId: string, name: string) => `${prefix}${accountId}:${name}`;

export function saveLastKnown<T>(accountId: string | null | undefined, name: string, value: T, now = Date.now()): void {
  const store = storage();
  if (!store || !accountId) return;
  try { store.setItem(keyFor(accountId, name), JSON.stringify({ savedAt: now, expiresAt: now + lastKnownTtlMs, value })); } catch { /* full or refused: nothing kept */ }
}

export function readLastKnown<T>(accountId: string | null | undefined, name: string, now = Date.now()): LastKnown<T> | null {
  const store = storage();
  if (!store || !accountId) return null;
  const key = keyFor(accountId, name);
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: number; expiresAt?: number; value?: T };
    if (typeof parsed?.savedAt !== "number" || typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now || parsed.savedAt > now + 60_000) {
      store.removeItem(key);
      return null;
    }
    return { savedAt: parsed.savedAt, value: parsed.value as T };
  } catch {
    try { store.removeItem(key); } catch { /* nothing to remove */ }
    return null;
  }
}

/** Forget every account's last known state on this device: signing out, a session that ended. */
export function clearLastKnown(): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch { /* nothing kept */ }
}
