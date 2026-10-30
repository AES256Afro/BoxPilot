import { readJson } from "../http";
import { runningInstalled } from "./register";

/*
 * Approval pushes on this device (M25.2): whether it can have them, turning them on and off, and the
 * owner's choices. The server keeps the subscription (never showing its endpoint back); this device
 * remembers only which of the account's devices it is, so signing out here can turn them off.
 */

export interface PushDevice { id: string; label: string; service: string; createdAt: string; lastSentAt: string | null; lastError: string | null }
export interface PushSettings {
  tiers: { low: boolean; medium: boolean; high: boolean };
  quietHours: { enabled: boolean; start: string; end: string };
  ntfy: "fallback" | "always" | "never";
  openAt: string | null;
  timeZone: string | null;
}
export interface PushStatus { canSubscribe: boolean; publicKey: string | null; problem: string | null; devices: PushDevice[]; settings: PushSettings }

const deviceKey = "boxpilot:push-device";
const json = { "Content-Type": "application/json" };

export const pushApi = {
  status: async (): Promise<PushStatus> => readJson<PushStatus>(await fetch("/api/v1/push")),
  saveSettings: async (csrfToken: string, settings: Pick<PushSettings, "tiers" | "quietHours" | "ntfy">): Promise<PushSettings> =>
    readJson<PushSettings>(await fetch("/api/v1/settings/push", { method: "PUT", headers: { ...json, "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify(settings) })),
  remove: async (csrfToken: string, id: string): Promise<void> => { await readJson(await fetch(`/api/v1/push/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-BoxPilot-CSRF": csrfToken } })); },
  test: async (csrfToken: string): Promise<{ devices: number; delivered: number }> => readJson(await fetch("/api/v1/push/test", { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } })),
};

export type PushSupport = "supported" | "install-first" | "blocked" | "unsupported";

const appleTouch = () => typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/**
 * What this device can do. An iPhone or iPad has Web Push only in the installed app (iOS 16.4 and
 * later): a Safari tab has no PushManager at all, so it is told to add BoxPilot to its Home Screen.
 */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const capable = window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!capable) return appleTouch() && !runningInstalled() ? "install-first" : "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return "supported";
}

export function thisDeviceId(): string | null {
  try { return window.localStorage.getItem(deviceKey); } catch { return null; }
}

/** A name for the list of devices: what kind of device, never anything that identifies it further. */
export function deviceLabel(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(userAgent)) return "Android";
  if (/Macintosh/.test(userAgent)) return "Mac";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Linux/.test(userAgent)) return "Linux";
  return "This device";
}

/**
 * Turn pushes on here. Call it straight from the button's click: Safari asks for permission only
 * inside the tap, so nothing slow may come first (the key and the worker are read beforehand).
 */
export async function turnOnPush(csrfToken: string, publicKey: string, registration: ServiceWorkerRegistration): Promise<PushDevice> {
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64urlBytes(publicKey) });
  const body = subscription.toJSON();
  const response = await fetch("/api/v1/push/subscriptions", { method: "POST", headers: { ...json, "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ subscription: { endpoint: body.endpoint, keys: body.keys }, label: deviceLabel() }) });
  const { device } = await readJson<{ device: PushDevice }>(response).catch(async (error: unknown) => { await subscription.unsubscribe().catch(() => undefined); throw error; });
  try { window.localStorage.setItem(deviceKey, device.id); } catch { /* it still works; signing out here just will not turn it off */ }
  return device;
}

/** Turn pushes off here: the server forgets the device and the browser drops the subscription. */
export async function turnOffThisDevice(csrfToken: string): Promise<void> {
  const id = thisDeviceId();
  try { window.localStorage.removeItem(deviceKey); } catch { /* nothing kept */ }
  const registration = typeof navigator !== "undefined" && "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined;
  const subscription = await registration?.pushManager?.getSubscription().catch(() => null);
  await subscription?.unsubscribe().catch(() => undefined);
  if (id) await pushApi.remove(csrfToken, id).catch(() => undefined);
}

function base64urlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
