/**
 * Registering the service worker (M25.1). Only over HTTPS - Tailscale Serve's address, or the LAN
 * listener with BoxPilot's certificate trusted - since a browser refuses a worker anywhere else but
 * localhost, and localhost is the developer's server or the demo. Never in the demo, whose fictional
 * worlds share one address and must not be kept. A failure changes nothing: the app works as before.
 */
export interface RegisterOptions {
  location?: Pick<Location, "protocol">;
  container?: Pick<ServiceWorkerContainer, "register"> | null;
  fetcher?: (url: string) => Promise<Response>;
}

export async function registerServiceWorker({
  location = window.location,
  container = typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : null,
  fetcher = (url) => fetch(url),
}: RegisterOptions = {}): Promise<ServiceWorkerRegistration | null> {
  if (!container || location.protocol !== "https:") return null;
  const health = await fetcher("/api/v1/health").then((response) => response.json() as Promise<{ mode?: string }>).catch(() => null);
  if (health?.mode === "demo") return null;
  try {
    return await container.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

/** Whether BoxPilot is running as the installed app (from the home screen), not in a browser tab. */
export function runningInstalled(): boolean {
  if (typeof window === "undefined") return false;
  const standalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
}
