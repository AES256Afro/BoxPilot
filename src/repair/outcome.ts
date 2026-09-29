import type { Job } from "../operations";
import type { Finding } from "./types";

/*
 * What a fix did, in a sentence, and what to do when it did not work (M35). Read from the job's own
 * result, so "Fixed" says what changed rather than only that something ran.
 */

type Result = Record<string, unknown>;
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
const joined = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
const apps = (names: string[]) => joined(names.map((name) => name.replace(/^bp-/, "")));

/** One sentence: what the job changed, from its result, or its own last words when there is nothing better. */
export function whatChanged(job: Pick<Job, "type" | "result" | "steps">): string {
  const result = (job.result && typeof job.result === "object" ? job.result : {}) as Result;
  const operation = job.type.replace(/^op:/, "");
  const restarted = list(result.restarted);
  const closed = list(result.sharingClosedFor);
  const afterApps = restarted.length ? ` ${apps(restarted)} ${restarted.length === 1 ? "was" : "were"} started again.` : "";
  const afterSharing = closed.length ? ` File sharing from ${joined(closed)} was disconnected and reconnects by itself.` : "";
  if (operation === "storage.remount" && result.remounted) {
    const moved = result.deviceChanged ? ` from ${String(result.source)} (it was ${String(result.previousSource)})` : result.source ? ` from ${String(result.source)}` : "";
    return `${String(result.mountpoint ?? "The drive")} is mounted again${moved}, reads, and is writable.${afterApps}${afterSharing}`;
  }
  if (operation === "storage.writable" && result.writable) return `${String(result.mountpoint)} now belongs to ${String(result.owner)}, so apps and file shares can write there.${afterApps}${afterSharing}`;
  if (operation === "share.reconnect" && result.reconnected) return `${String(result.mountpoint)} is mounted again, read-write.${afterApps}`;
  if (operation === "samba.share.writable" && result.writable) return `${String(result.path)} now belongs to ${String(result.owner)}, and the ${String(result.share)} share writes as ${String(result.forceUser)}.`;
  if (operation === "app.reinstall" && result.reinstalled) {
    const from = result.projectRewritten ? "from its saved settings" : "from its saved compose project";
    return result.started === false
      ? `${String(result.name ?? result.id)} has its container back, ${from}, and is stopped as you left it. Start it whenever you want it.`
      : `${String(result.name ?? result.id)} has a container again and is running, ${from}.`;
  }
  if (operation === "app.uninstall" && result.uninstalled) return `${String(result.id)} is no longer listed as installed; its data folder is kept.`;
  if (operation === "app.backup.many" && Array.isArray(result.apps)) return `Backed up ${joined((result.apps as Array<{ id?: string }>).map((entry) => String(entry.id)))}.`;
  if (operation === "app.backup" && result.backedUp) return `Backed up to ${String(result.artifact ?? "a new archive")}.`;
  if (operation === "notifications.ntfy.connect" && result.connected) {
    const where = typeof result.subscribeUrl === "string" && result.subscribeUrl ? result.subscribeUrl : "the address you open ntfy's page at";
    return `ntfy on this server accepted a test message, and BoxPilot's alerts now go to it. To get them on your phone: install the ntfy app, add a subscription, turn on "Use another server" and enter ${where}, then subscribe to the topic ${String(result.topic)}. The topic works like a password: keep it to yourself.`;
  }
  if (operation === "storage.check" && result.checked) return result.clean ? `${String(result.mountpoint)} checked clean.${afterApps}` : `The check found problems on ${String(result.mountpoint)}: ${String(result.summary ?? "see the log")}`;
  if (operation === "storage.docker-order.apply") return result.changed ? "The drives are ordered around Docker now: it waits for them at boot and stops before they are unmounted." : "The drives were already ordered around Docker.";
  if (operation === "app.action") return `${String(result.id ?? "The app")}${result.recreated ? "'s container was built again, and it" : ""} is ${String(result.status ?? "running")} now.`;
  // The port-conflict fixes (Dockge, 2026-09-29): say which address the app keeps and which one ended.
  const withdrawn = (typeof result.withdrawn === "string" ? [result.withdrawn] : list(result.withdrawn));
  if (operation === "app.exposure.set" && result.mode === "tailnet") return `${String(result.id ?? "The app")} answers only through Tailscale now${typeof result.url === "string" ? `, at ${result.url}` : ""}, and no longer on your home network.`;
  if (operation === "app.exposure.set" && result.mode === "lan") return `${String(result.id ?? "The app")} is on your home network now${withdrawn.length ? `; Tailscale Serve no longer publishes ${joined(withdrawn)}` : ""}.`;
  if (operation === "app.serve.set" && result.enabled === false) {
    const started = result.started ? ` It is ${String(result.status ?? "running")} now${result.recreated ? ", its container built again" : ""}.` : "";
    return `Tailscale Serve no longer publishes ${withdrawn[0] ?? `port ${String(result.port)}`}, so port ${String(result.port)} is ${String(result.id ?? "the app")}'s alone.${started}`;
  }
  if (operation === "app.serve.withdraw" && result.withdrawn) return `Tailscale Serve no longer publishes port ${String(result.port)}.`;
  if (operation === "app.reconfigure" && result.reconfigured) {
    const ports = Array.isArray(result.hostPorts) ? (result.hostPorts as Array<{ host?: unknown; protocol?: unknown }>).map((entry) => `${String(entry.host)}${entry.protocol === "udp" ? "/udp" : ""}`) : [];
    return `${String(result.id ?? "The app")} was recreated with its new settings${ports.length ? ` and publishes port ${joined(ports)}` : ""}.`;
  }
  const verified = [...(job.steps ?? [])].reverse().find((step) => step.name === "verify" && step.state === "completed");
  return verified?.detail ? `${verified.detail}.` : "The job finished.";
}

/** A job that stopped because something holds one of the app's ports, as the helper says it. */
export const portConflictPattern = /\bPort \d+(?:\/udp)? (?:is taken|is also claimed|is already in use)\b/;

/** What to do next when a fix did not clear its finding: its own words when it has them. */
export function nextStep(finding: Pick<Finding, "manual" | "fixes" | "fix"> | null, failed: boolean, error: string | null = null): string {
  if (finding?.manual) return finding.manual;
  // The error already names what holds the port; the next step is to free it, not to read a log.
  if (failed && error && portConflictPattern.test(error)) return "Free the port first: the sentence above names what holds it. The app's port finding on this page offers the choices in one click; run one, and it starts the app too.";
  return failed
    ? "Read the job's log below: it says where it stopped. Fix what it names, then try again."
    : "The fix ran, but the scan still finds this. Read the evidence and the job's log, then try again or dismiss it with a reason.";
}
