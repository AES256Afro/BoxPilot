/**
 * M39.2 against real dnsmasq, the resolver GL.iNet and OpenWrt routers run. tests/ubuntu/dns-fallback.sh
 * gives it a dummy interface with four addresses and dnsmasq installed; this starts the resolvers:
 *
 *   10.53.0.2  "Pi-hole": blocks doubleclick.net, answers example.com, logs every query
 *   10.53.0.3  "a public resolver": answers both, blocks nothing
 *   10.53.0.1  "the router" with a fallback: Pi-hole first, the public one after (strict order)
 *   10.53.0.4  "the router" without one: Pi-hole only
 *
 * and then runs the product's own code against them: each server asked directly (askServer), the
 * verdict (judgeResilience), the canary through the router read from Pi-hole's real query log
 * (createDnsResilienceService), the rehearsal with Pi-hole's dnsmasq really killed and started
 * again (rehearseFallback), and the lease reader on this runner's own network interface
 * (readHandedOut), which gets its address and DNS from DHCP. No dig, ping or tcpdump anywhere.
 *
 *   sudo node tests/ubuntu/dns-fallback-check.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { askServer, createDnsResilienceService, judgeResilience, readHandedOut } from "../../server/dns-resilience.mjs";
import { rehearseFallback } from "../../server/tasks/dns-rehearsal.mjs";

const pihole = "10.53.0.2";
const publicResolver = "10.53.0.3";
const router = "10.53.0.1";
const routerOnly = "10.53.0.4";
const log = "/tmp/bp-dns-fallback-pihole.log";

let failures = 0;
const results = [];
function check(what, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` (${detail})` : ""}`);
  console.log(results.at(-1));
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const running = new Map();
function dnsmasq(name, address, extra) {
  // A pid file each. Four started at once all reached for /var/run/dnsmasq.pid, and whichever found
  // it taken exited ("failed to open pidfile: File exists"): on 2026-09-30 that was the router, and
  // every check through it failed.
  const pidFile = `/tmp/bp-dns-fallback-${name}.pid`;
  rmSync(pidFile, { force: true });
  const args = ["--keep-in-foreground", "--conf-file=/dev/null", "--no-hosts", "--bind-interfaces", `--listen-address=${address}`, "--port=53", "--user=root", "--cache-size=150", `--pid-file=${pidFile}`, ...extra];
  const child = spawn("dnsmasq", args, { stdio: ["ignore", "inherit", "inherit"] });
  running.set(name, child);
  return child;
}
async function stop(name) {
  const child = running.get(name);
  if (!child) return;
  running.delete(name);
  // One that has exited already will not say so again: waiting for it held the job until CI's
  // ten-minute limit cancelled it, after a failure the test had already reported.
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}
const startPihole = () => dnsmasq("pihole", pihole, ["--no-resolv", "--address=/doubleclick.net/0.0.0.0", "--address=/example.com/192.0.2.10", "--log-queries", `--log-facility=${log}`]);

async function main() {
  rmSync(log, { force: true });
  startPihole();
  dnsmasq("public", publicResolver, ["--no-resolv", "--address=/example.com/192.0.2.10", "--address=/doubleclick.net/192.0.2.99"]);
  dnsmasq("router", router, ["--no-resolv", "--strict-order", `--server=${pihole}`, `--server=${publicResolver}`]);
  dnsmasq("router-only", routerOnly, ["--no-resolv", `--server=${pihole}`]);
  await sleep(1500);

  console.log("\n==== Each server asked directly, as a device asks it ====");
  const answers = Object.fromEntries(await Promise.all([pihole, publicResolver, router, routerOnly].map(async (address) => [address, await askServer(address)])));
  check("Pi-hole answers, resolves and blocks", answers[pihole].answering && answers[pihole].resolving && answers[pihole].blocking, JSON.stringify(answers[pihole]));
  check("the public resolver answers and resolves, without blocking", answers[publicResolver].answering && answers[publicResolver].resolving && !answers[publicResolver].blocking, JSON.stringify(answers[publicResolver]));
  check("the router asks Pi-hole first, so it blocks too (strict order)", answers[router].blocking === true, JSON.stringify(answers[router]));

  console.log("\n==== The verdict from what was asked ====");
  const context = { selfAddresses: [pihole], gateway: router, servesDns: true, answers };
  const lease = (servers) => ({ source: "dhcp", via: "test", servers, dhcpServer: router });
  const alone = judgeResilience({ ...context, handedOut: lease([pihole]) }, { hostname: "testbox" });
  check("a lease naming only this server is the single point", alone.state === "single-point", alone.headline);
  const withPublic = judgeResilience({ ...context, handedOut: lease([pihole, publicResolver]) }, { hostname: "testbox" });
  check("a public second server keeps the house resolving, and skips the blocking", withPublic.state === "resilient" && withPublic.skipsBlocking === true, withPublic.detail);

  console.log("\n==== The canary through the router, found in Pi-hole's own log ====");
  const topology = { addresses: [{ interface: "bpdns0", address: pihole }], eligibleLanAddresses: [{ interface: "bpdns0", address: pihole, cidr: `${pihole}/24` }], defaultRoutes: [{ gateway: router, interface: "bpdns0" }], resolverLinks: [], dnsListeners: [{ protocol: "udp", address: pihole, port: 53, scope: "host-address" }] };
  const helper = { request: async (operation, { names }) => {
    const text = readFileSync(log, "utf8");
    return { available: true, seen: Object.fromEntries(names.map((name) => [name, text.includes(name)])) };
  } };
  const leaseOf = (servers) => async () => ({ ok: true, stdout: JSON.stringify({ DNS: servers.map((address) => ({ Family: 2, Address: address.split(".").map(Number), ConfigSource: "DHCPv4", ConfigProvider: router.split(".").map(Number) })) }) });
  const viaRouter = await createDnsResilienceService({ network: { inspect: async () => topology }, helper, run: leaseOf([router]), hostname: () => "testbox" }).check();
  check("the router passes a made-up name on to Pi-hole", viaRouter.canary?.forwards === true, JSON.stringify(viaRouter.canary));
  check("so its fallback is not proven until rehearsed", viaRouter.state === "unproven", viaRouter.headline);

  console.log("\n==== The rehearsal: Pi-hole's dnsmasq killed, the router asked, Pi-hole back ====");
  const hands = { stop: () => stop("pihole"), start: async () => { startPihole(); await sleep(500); } };
  const kept = await rehearseFallback({ router, lanAddress: pihole, label: "Pi-hole" }, hands);
  check("the router with a fallback kept answering", kept.passed === true, `${kept.answered} of ${kept.total}, slowest ${kept.slowestMs} ms, Pi-hole silent: ${kept.silent}`);
  const lost = await rehearseFallback({ router: routerOnly, lanAddress: pihole, label: "Pi-hole" }, hands);
  check("the router without one answered nothing", lost.passed === false && lost.answered === 0, `${lost.answered} of ${lost.total}`);
  check("Pi-hole answers again afterwards", (await askServer(pihole)).answering === true);
  const judged = judgeResilience({ ...context, handedOut: lease([router]), canary: viaRouter.canary, rehearsal: { router, passed: kept.passed, at: new Date().toISOString(), appName: "Pi-hole" } }, { hostname: "testbox" });
  check("a passed rehearsal makes the house resilient", judged.state === "resilient", judged.detail);

  console.log("\n==== This runner's own lease ====");
  const route = JSON.parse(execFileSync("ip", ["-j", "-4", "route", "show", "default"], { encoding: "utf8" }))[0];
  const handedOut = await readHandedOut({ interface: route?.dev });
  console.log(`    ${route?.dev}: ${JSON.stringify(handedOut)}`);
  check(`what DHCP hands out on ${route?.dev} is read from its lease`, handedOut.source === "dhcp" && handedOut.servers.length > 0, `${handedOut.via}: ${handedOut.servers.join(", ")}`);

  writeFileSync("/tmp/dns-fallback-results.json", `${JSON.stringify({ rehearsal: { kept, lost }, lease: handedOut, canary: viaRouter.canary })}\n`);
}

try {
  await main();
} catch (error) {
  check("the test ran to the end", false, error.stack);
} finally {
  for (const name of [...running.keys()]) await stop(name);
}
console.log(`\n${results.join("\n")}`);
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
