#!/usr/bin/env node
/**
 * Zulip on a real Docker host (M38), for .github/workflows/zulip-host.yml. It installs
 * catalog/zulip.yaml with BoxPilot's own deployer and its registered install operation, as the
 * helper does on the owner's server - tailnet only, then published with Tailscale Serve (a stand-in,
 * tests/zulip/fake-tailscale.mjs) - and then asks for the organization link with the registered
 * operation and opens it as Serve would forward a browser to it. What each container uses is
 * written to the job's summary.
 *
 *   BOXPILOT_TAILSCALE_BINARY=tests/zulip/fake-tailscale.mjs node tests/zulip/zulip-host.mjs <workdir>
 *
 * It stops at the first thing that is not as the owner's server needs it, and says which.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createAppHelper } from "../../server/app-helper.mjs";
import { fixedRun } from "../../server/exec.mjs";
import { appOperations } from "../../server/ops/apps.mjs";
import { zulipOperations } from "../../server/ops/zulip.mjs";

const workdir = path.resolve(process.argv[2] ?? "zulip-host");
const catalogRoot = path.join(workdir, "catalog");
const backupRoot = path.join(workdir, "backups");
mkdirSync(catalogRoot, { recursive: true });
mkdirSync(backupRoot, { recursive: true });

const operations = Object.fromEntries([...appOperations(), ...zulipOperations()].map((operation) => [operation.id, operation]));
const apps = createAppHelper({ catalogRoot, backupRoot, lanAddress: "127.0.0.1", tailscaleBinary: process.env.BOXPILOT_TAILSCALE_BINARY });
const progress = (line) => console.error(`  ${line}`);
const summary = [];
const say = (line = "") => { console.log(line); summary.push(line); };
const fail = (message) => { say(`FAILED: ${message}`); flush(); process.exit(1); };
function flush() { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`); }
const docker = (args, timeout = 60_000) => fixedRun("/usr/bin/docker", args, { timeout, maxBuffer: 8 * 1024 * 1024 });

/** A request to Zulip's port as Tailscale Serve sends one: HTTPS forwarded, under Zulip's own name. */
function throughServe(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET", headers: { Host: host, "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.9" }, timeout: 30_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
    request.end();
  });
}

export async function resourceUse() {
  const stats = await docker(["stats", "--no-stream", "--format", "json"]);
  const rows = String(stats.stdout).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => /^bp-zulip/.test(row.Name));
  const images = await docker(["image", "ls", "--format", "json"]);
  const sizes = String(images.stdout).split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => /zulip|memcached|rabbitmq|redis/.test(row.Repository));
  const disk = await fixedRun("/usr/bin/du", ["-sh", path.join(catalogRoot, "zulip")], { timeout: 60_000 });
  return { rows, sizes, disk: String(disk.stdout).split("\t")[0] || "unknown" };
}

export function describeUse({ rows, sizes, disk }) {
  const lines = ["| Container | Memory | CPU |", "| --- | --- | --- |", ...rows.map((row) => `| ${row.Name} | ${String(row.MemUsage).split("/")[0].trim()} | ${row.CPUPerc} |`)];
  lines.push("", "| Image | Size |", "| --- | --- |", ...sizes.map((row) => `| ${row.Repository}:${row.Tag} | ${row.Size} |`), "", `Zulip's project folder (database, uploads, queue): ${disk}`);
  return lines;
}

say("## Zulip on a real Docker host");
say();
const started = Date.now();
let installed;
try {
  installed = await operations["app.install"].run({ id: "zulip", values: { env: { SETTING_ZULIP_ADMINISTRATOR: "owner@example.com" } } }, { apps, run: fixedRun, progress, timeScale: 2 });
} catch (error) {
  const logs = await docker(["compose", "--project-name", "bp-zulip", "--file", path.join(catalogRoot, "zulip", "compose.yaml"), "--env-file", path.join(catalogRoot, "zulip", ".env"), "logs", "--tail", "80"], 120_000).catch(() => ({ stdout: "" }));
  console.error(logs.stdout);
  fail(`the install failed: ${error.message}`);
}
say(`Installed in ${Math.round((Date.now() - started) / 1000)} s: ${installed.health} (${installed.hostPorts.map((port) => `${port.id} ${port.host} ${port.exposure}`).join(", ")}).`);
if (installed.exposure !== "tailnet") fail(`it was installed for ${installed.exposure}, not the tailnet only`);
if (!installed.served || installed.warnings) fail(`it was not published with Serve: ${JSON.stringify(installed.warnings ?? installed.urls)}`);
say(`Published at ${installed.urls.join(", ")} (Serve stand-in).`);

// #323: the port Serve fronts is on 127.0.0.1 and nothing else.
const port = installed.hostPorts[0].host;
const bound = await docker(["port", "bp-zulip"]);
say(`docker port bp-zulip: ${String(bound.stdout).trim().replace(/\n/g, "; ")}`);
if (!/^80\/tcp -> 127\.0\.0\.1:\d+$/m.test(String(bound.stdout)) || /0\.0\.0\.0|\[::\]/.test(String(bound.stdout))) fail("Zulip's web port is published somewhere other than 127.0.0.1");

const health = await throughServe(port, "/health", `boxpilot-ci.example-tailnet.ts.net:${port}`);
say(`/health through Serve's headers: ${health.status}`);
if (health.status !== 200) fail(`Zulip's health endpoint answered ${health.status}: ${health.body.slice(0, 200)}`);

const made = await operations["app.zulip.organization.link"].run({ id: "zulip" }, { apps, progress }).catch((error) => fail(`Create your organization failed: ${error.message}`));
const link = new URL(made.link);
say(`Create your organization: a link to https://${link.host}/new/… (${made.expiresInDays} days).`);
if (link.host !== `boxpilot-ci.example-tailnet.ts.net:${port}`) fail(`the link is for ${link.host}, not Zulip's Serve address`);
const form = await throughServe(port, link.pathname, link.host);
say(`Opening it through Serve's headers: ${form.status}${/organization/i.test(form.body) ? ", the organization form" : ""}.`);
if (form.status !== 200 || !/organization/i.test(form.body)) fail(`the creation link answered ${form.status} without the organization form`);

// Settle a minute, then say what it costs.
await new Promise((resolve) => setTimeout(resolve, 60_000));
say();
say("### What it uses, a minute after it came up");
say();
for (const line of describeUse(await resourceUse())) say(line);
flush();
