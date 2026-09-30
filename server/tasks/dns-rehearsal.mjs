/**
 * Rehearse this server going down, for DNS only (M39.2, ADR-008).
 *
 * When devices ask the router and the router passes their lookups to the DNS app here, whether the
 * house keeps working while this server is off depends on one setting on the router that BoxPilot
 * cannot read: a fallback resolver. The only way to know is to take the DNS app away and ask the
 * router, so this does exactly that, for as short a time as it can:
 *
 *   1. The router must answer now, and the app must be running, or there is nothing to rehearse.
 *   2. A dead man's switch goes in first: a transient systemd timer that starts the app again in
 *      three minutes whatever happens to this task, so a crash half-way cannot leave the house on
 *      its fallback (or with no DNS at all) until somebody notices.
 *   3. The app's container is stopped, and its address checked to be silent.
 *   4. The router is asked three names nobody has asked before (so its cache cannot answer), each
 *      the way a device asks: a few seconds, then once more.
 *   5. The app is started again, and this waits until it answers on the LAN address.
 *
 * With a fallback, devices notice nothing but a slower first lookup. Without one, nothing on the
 * network resolves names for that half minute or so, which is what the confirmation says before
 * anybody approves it. A task, not helper work: it needs the network (the helper has none) and
 * Docker.
 */
import { randomBytes } from "node:crypto";
import { fixedRun } from "../exec.mjs";
import { askName } from "../dns-resilience.mjs";
import { controlDomain } from "./dns-check.mjs";

export const rehearsalApps = Object.freeze({ "pi-hole": "Pi-hole", "adguard-home": "AdGuard Home", "technitium-dns": "Technitium DNS" });
const addressPattern = /^\d{1,3}(\.\d{1,3}){3}$/;
const dockerBinary = () => process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker";
const systemdRunBinary = () => process.env.BOXPILOT_SYSTEMD_RUN_BINARY ?? "/usr/bin/systemd-run";
const systemctlBinary = () => process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";

/** A name no resolver has cached: random, under the domain reserved for examples. */
export const freshName = (bytes = randomBytes(6)) => `bp-rehearsal-${bytes.toString("hex")}.${controlDomain}`;

/**
 * The rehearsal itself, with its hands passed in: `stop` and `start` take the DNS app away and bring
 * it back, `ask(server, name)` is one lookup. Kept apart from Docker so the same steps run against
 * real dnsmasq in CI (tests/ubuntu/dns-fallback.sh).
 */
export async function rehearseFallback({ router, lanAddress, label = "Pi-hole", names = 3 }, { stop, start, ask = (server, name) => askName(server, name, { timeoutMs: 4000, tries: 2 }), log = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), backWithinMs = 90_000 } = {}) {
  const before = await ask(router, controlDomain);
  if (!before.answered) throw new Error(`The router at ${router} does not answer DNS right now (${before.error ?? "no answer"}), so there is nothing to rehearse. Nothing was stopped.`);
  log(`The router answers now (${before.ms} ms). Stopping ${label}.`, "stdout");

  const stoppedAt = now();
  await stop();
  const results = [];
  let silent = null;
  try {
    // With the app stopped its address must be silent, or the router could still be reaching it.
    if (lanAddress) {
      const direct = await ask(lanAddress, freshName());
      silent = !direct.answered;
      log(silent ? `${label} no longer answers on ${lanAddress}.` : `Something still answers on ${lanAddress} with ${label} stopped.`, silent ? "stdout" : "stderr");
    }
    for (let index = 0; index < names; index += 1) {
      const name = freshName();
      const answer = await ask(router, name);
      results.push({ answered: answer.answered, ms: answer.ms, error: answer.answered ? null : answer.error });
      log(answer.answered ? `The router answered ${name} in ${answer.ms} ms.` : `The router did not answer ${name} (${answer.error ?? "no answer"} after ${answer.ms} ms).`, answer.answered ? "stdout" : "stderr");
    }
  } finally {
    log(`Starting ${label} again.`, "stdout");
    await start();
  }
  const stoppedForMs = now() - stoppedAt;

  // Back means answering on the LAN, not merely a running container: the house is not whole until then.
  let back = false;
  const deadline = now() + backWithinMs;
  while (!back && now() < deadline) {
    back = lanAddress ? (await ask(lanAddress, controlDomain)).answered : true;
    if (!back) await sleep(2000);
  }
  if (!back) throw new Error(`${label} was started again but did not answer on ${lanAddress} within ${Math.round(backWithinMs / 1000)} seconds. Open Apps and start it; until it answers, devices that use it have no DNS.`);
  log(`${label} answers on ${lanAddress ?? "this server"} again.`, "stdout");

  const answered = results.filter((entry) => entry.answered);
  return {
    router, label,
    // Something else answering on this server's address with the app stopped means the router may
    // have been reaching that instead: then the rehearsal proves nothing either way.
    passed: silent === false ? null : answered.length === results.length && results.length > 0,
    answered: answered.length, total: results.length,
    slowestMs: answered.length ? Math.max(...answered.map((entry) => entry.ms)) : null,
    silent, stoppedForMs, results,
  };
}

/**
 * The task: validate, arm the dead man's switch, rehearse with the app's container, and disarm.
 */
export async function dnsFallbackRehearse(parameters = {}, { run = fixedRun, log = () => {}, ask, now = () => Date.now(), sleep } = {}) {
  const { router, app, lanAddress } = parameters;
  if (typeof router !== "string" || !addressPattern.test(router)) throw new Error("The router's address is required");
  if (typeof lanAddress !== "string" || !addressPattern.test(lanAddress)) throw new Error("This server's LAN address is required");
  if (!Object.hasOwn(rehearsalApps, app)) throw new Error(`app must be one of ${Object.keys(rehearsalApps).join(", ")}`);
  const label = rehearsalApps[app];
  const container = `bp-${app}`;

  const state = await run(dockerBinary(), ["inspect", "--format", "{{.State.Running}}", container], { timeout: 20_000 });
  if (!state.ok || state.stdout.trim() !== "true") throw new Error(`${label} is not running here, so there is nothing to rehearse. Nothing was stopped.`);

  // Armed before anything stops: if this task dies half-way, systemd starts the app in three minutes.
  // `docker start` on a running container does nothing, so it firing after a clean finish is harmless.
  const unit = `boxpilot-dns-rehearsal-${randomBytes(4).toString("hex")}`;
  const armed = await run(systemdRunBinary(), ["--on-active=180", `--unit=${unit}`, "--description=BoxPilot: start the DNS app again after a rehearsal", "--collect", dockerBinary(), "start", container], { timeout: 20_000 });
  if (!armed.ok) throw new Error("Could not set the safety timer that starts the DNS app again if this rehearsal is cut off, so nothing was stopped.");
  log(`Safety timer ${unit}.timer will start ${label} in three minutes if this rehearsal is cut off.`, "stdout");

  try {
    return {
      ...(await rehearseFallback({ router, lanAddress, label }, {
        ask, log, now, sleep,
        stop: async () => {
          const stopped = await run(dockerBinary(), ["stop", "--time", "5", container], { timeout: 45_000 });
          if (!stopped.ok) throw new Error(`Could not stop ${label}: ${stopped.stderr || `exit ${stopped.code ?? "?"}`}`);
        },
        start: async () => {
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            const started = await run(dockerBinary(), ["start", container], { timeout: 60_000 });
            if (started.ok) return;
            log(`Starting ${label} failed (attempt ${attempt}): ${started.stderr || `exit ${started.code ?? "?"}`}`, "stderr");
          }
          throw new Error(`${label} did not start again. The safety timer tries once more within three minutes; otherwise start it from Apps.`);
        },
      })),
      app,
      appName: label,
      at: new Date(now()).toISOString(),
    };
  } finally {
    await run(systemctlBinary(), ["stop", `${unit}.timer`], { timeout: 20_000 }).catch(() => null);
  }
}
