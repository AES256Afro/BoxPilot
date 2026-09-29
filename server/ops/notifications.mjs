import { randomBytes } from "node:crypto";
import { defineOperation } from "./registry.mjs";

const minutes = (value) => value * 60_000;

/**
 * A topic nobody can guess. On ntfy a topic is the whole of the access control: whoever knows it
 * can read what is sent there and send fake alerts, so it is random, like a password, and it is the
 * owner's to see (M29.4).
 */
export function newTopic(bytes = randomBytes(12)) {
  return `boxpilot-${bytes.toString("base64url")}`;
}

/** The test message: what arrives on the phone the moment the owner subscribes. */
export const connectMessage = "BoxPilot can reach you here. Failing disks, drives that drop off, filling filesystems, crash-looping apps, backups that stopped and failed jobs arrive on this topic.";

/**
 * Where BoxPilot's alerts go, pointed at the ntfy on this very server (M35).
 *
 * "Nothing BoxPilot notices can reach you" used to say only "set a target under Settings", on a
 * server that was already running ntfy from the catalog. This is the one-click version: it finds
 * that ntfy, makes a topic nobody can guess, and sends a test to it from this server. The web
 * service saves the target once the test was accepted (its record hook, server/index.mjs), so the
 * alerts take the path the test took. Changing where alerts go needs the owner's password in
 * Settings, so this is high risk and the owner's: the same password, asked once.
 */
export function notificationOperations() {
  return [
    defineOperation({
      id: "notifications.ntfy.connect", title: "Send alerts to the ntfy on this server", risk: "high", minimumRole: "owner", timeoutMs: minutes(2),
      description: "Finds the ntfy app installed on this server, makes a new topic nobody can guess, sends a test message to it from this server, and once ntfy accepts it makes that topic BoxPilot's notification target. Subscribe to the topic in the ntfy app on your phone to receive the alerts. Refused when a notification target is already set: change that one under Settings, Notifications.",
      parameters: { fields: {} },
      run: async (_parameters, { apps, runUnit, jobLog, progress }) => {
        const { applications = [] } = await apps.inspect({ id: "ntfy" });
        const app = applications.find((entry) => entry.id === "ntfy");
        if (!app?.installed) throw new Error("ntfy is not installed on this server; install it from the App catalog first");
        if (!app.container?.running) throw new Error("ntfy is installed but not running; start it, then try again");
        const port = app.urls?.[0]?.host;
        if (!Number.isInteger(port)) throw new Error("ntfy has no web port BoxPilot can send to");
        // Loopback reaches its web port however it is exposed: a LAN app listens on every address,
        // and a tailnet one on 127.0.0.1 behind Tailscale Serve.
        const url = `http://127.0.0.1:${port}`;
        const topic = newTopic();
        progress?.(`Sending a test message to ${url}, on a new private topic`, "stdout");
        const answer = await runUnit.runTask("http.request", { url: `${url}/${topic}`, method: "POST", body: connectMessage, contentType: "text/plain" }, { timeoutMs: 45_000, logPath: jobLog?.path ?? null });
        if (!answer?.ok) {
          const refused = answer?.status === 401 || answer?.status === 403;
          throw new Error(refused
            ? `ntfy on this server asks for a login (it answered ${answer.status}), so BoxPilot cannot post to it without a token. Set the target with an access token under Settings, Notifications.`
            : `ntfy on this server did not accept the test (it answered ${answer?.status ?? "nothing"}). Nothing was changed.`);
        }
        progress?.("ntfy accepted the test message", "stdout");
        return { connected: true, kind: "ntfy", url, port, topic, exposure: app.urls?.[0]?.exposure ?? null };
      },
    }),
  ];
}
