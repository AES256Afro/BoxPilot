#!/usr/bin/env node
/**
 * A stand-in for the tailscale CLI on a CI runner, for tests/zulip/zulip-host.mjs (M38): this
 * machine's tailnet name, and Tailscale Serve's bookkeeping kept in a file, answering exactly the
 * commands BoxPilot's deployer and its install operation run. Nothing is published anywhere.
 *
 *   BOXPILOT_FAKE_TAILSCALE_STATE   the file Serve's entries are kept in
 *   BOXPILOT_FAKE_TAILSCALE_NAME    this machine's tailnet name
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const name = process.env.BOXPILOT_FAKE_TAILSCALE_NAME ?? "boxpilot-ci.example-tailnet.ts.net";
const stateFile = process.env.BOXPILOT_FAKE_TAILSCALE_STATE ?? "/tmp/boxpilot-fake-tailscale.json";
const args = process.argv.slice(2);
const serves = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};

if (args[0] === "status" && args.includes("--json")) {
  process.stdout.write(JSON.stringify({ Self: { DNSName: `${name}.`, TailscaleIPs: ["100.64.0.1"] } }));
} else if (args[0] === "ip") {
  process.stdout.write("100.64.0.1\n");
} else if (args[0] === "serve" && args[1] === "status") {
  const TCP = Object.fromEntries(Object.keys(serves).map((port) => [port, { HTTPS: true }]));
  const Web = Object.fromEntries(Object.entries(serves).map(([port, target]) => [`${name}:${port}`, { Handlers: { "/": { Proxy: target } } }]));
  process.stdout.write(JSON.stringify({ TCP, Web }));
} else if (args[0] === "serve") {
  const https = args.find((arg) => arg.startsWith("--https="))?.slice("--https=".length);
  if (!https) { process.stderr.write("serve: which port?\n"); process.exit(1); }
  if (args.at(-1) === "off") delete serves[https];
  else serves[https] = args.at(-1);
  writeFileSync(stateFile, JSON.stringify(serves));
} else {
  process.stderr.write(`fake tailscale: ${args.join(" ")} is not something BoxPilot runs\n`);
  process.exit(1);
}
