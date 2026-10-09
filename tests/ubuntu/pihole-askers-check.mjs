/**
 * M39.2 for a server with a hand-set address, against the real Pi-hole image the catalog pins.
 * tests/ubuntu/pihole-askers.sh starts it as BoxPilot names it (bp-pi-hole), on the host's network,
 * answering on a dummy interface with a "server", a "router" and eight "devices":
 *
 *   10.54.0.2          this server (Pi-hole answers here)
 *   10.54.0.1          the router
 *   10.54.0.11 to .18  eight devices, each asking Pi-hole directly, as the owner's PC did
 *
 * Each device's lookups really leave from its own address (node's resolver, setLocalAddress), so
 * Pi-hole's FTL writes them to its own database as it would on a LAN. Then the product's code reads
 * that database the way the helper does (`docker exec bp-pi-hole pihole-FTL sqlite3 -readonly`),
 * and the DNS check, given a static link and no lease, must say the house goes down with the server.
 *
 *   sudo node tests/ubuntu/pihole-askers-check.mjs
 */
import { Resolver } from "node:dns/promises";
import { canarySeen, piholeAskers } from "../../server/ops/dns-resilience.mjs";
import { askServer, createDnsResilienceService, newCanary } from "../../server/dns-resilience.mjs";
import { fixedRun } from "../../server/exec.mjs";

const server = "10.54.0.2";
const router = "10.54.0.1";
const devices = Array.from({ length: 8 }, (_, index) => `10.54.0.${11 + index}`);
const lanCidr = `${server}/24`;
const docker = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker";

let failures = 0;
const results = [];
function check(what, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` (${detail})` : ""}`);
  console.log(results.at(-1));
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One lookup from a given source address, as that device would send it. */
async function askFrom(source, name) {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  resolver.setLocalAddress(source);
  resolver.setServers([server]);
  return resolver.resolve4(name).then(() => true, (error) => ["ENOTFOUND", "ENODATA"].includes(error.code));
}

// As the helper finds it: BoxPilot's Pi-hole, running, with its query log where the catalog puts it.
const localDns = { internals: { platform: async () => ({ id: "pi-hole", label: "Pi-hole", running: true, queryLog: "/var/log/pihole/pihole.log" }) } };
const context = { router, lanCidr, selfAddresses: [server] };

async function main() {
  console.log("\n==== Pi-hole answers on the LAN address ====");
  let up = false;
  for (let attempt = 0; attempt < 90 && !up; attempt += 1) {
    up = (await askServer(server, { timeoutMs: 2000 })).answering;
    if (!up) await sleep(2000);
  }
  check("Pi-hole answers on 10.54.0.2", up);
  if (!up) return;

  console.log("\n==== Eight devices ask it directly, the router a little, the server itself once ====");
  let sent = 0;
  for (const device of devices) for (const name of ["example.com", "example.org"]) sent += (await askFrom(device, name)) ? 1 : 0;
  for (const name of ["example.net", "example.edu"]) sent += (await askFrom(router, name)) ? 1 : 0;
  sent += (await askFrom(server, "example.com")) ? 1 : 0;
  check(`every lookup was answered (${sent} of ${devices.length * 2 + 3})`, sent === devices.length * 2 + 3);

  console.log("\n==== Pi-hole's database, read the way the helper reads it ====");
  let askers = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    askers = await piholeAskers(context, { localDns, run: fixedRun });
    if (askers.available && askers.lanClients >= devices.length) break;
    await sleep(3000);
  }
  console.log(`    ${JSON.stringify(askers)}`);
  check("the database was read, read-only, with no password", askers?.available === true, askers?.reason ?? "");
  check("eight devices asked directly", askers?.lanClients === 8, String(askers?.lanClients));
  check("the router asked too", askers?.routerAsks === true);
  check("the server's own lookup is its own", (askers?.selfQueries ?? 0) >= 1, String(askers?.selfQueries));
  check("no device's address comes back", !/10\.54\.0\.1[1-8]/.test(JSON.stringify(askers)));
  const write = await fixedRun(docker, ["exec", "bp-pi-hole", "pihole-FTL", "sqlite3", "-readonly", "/etc/pihole/pihole-FTL.db", "CREATE TABLE boxpilot_probe (a INTEGER);"], { timeout: 30_000 });
  check("-readonly refuses a write", !write.ok, (write.stderr || "").split("\n")[0]);

  console.log("\n==== The canary is found in the real query log ====");
  const canary = newCanary();
  await askFrom(devices[0], canary);
  await sleep(1500);
  const seen = await canarySeen([canary], { localDns, run: fixedRun });
  check("a made-up name asked a moment ago is in /var/log/pihole/pihole.log", seen.available && seen.seen[canary] === true, JSON.stringify(seen));

  console.log("\n==== The DNS check on a server with a hand-set address ====");
  const topology = {
    addresses: [{ interface: "bpask0", address: server }],
    eligibleLanAddresses: [{ interface: "bpask0", address: server, cidr: lanCidr }],
    defaultRoutes: [{ gateway: router, interface: "bpask0", protocol: "static" }],
    resolverLinks: [], dnsListeners: [{ protocol: "udp", address: "0.0.0.0", port: 53, scope: "wildcard" }],
  };
  const staticLink = async () => ({ ok: true, stdout: JSON.stringify({ DNS: [{ Family: 2, Address: server.split(".").map(Number), ConfigSource: "static" }] }) });
  const helper = { request: async (operation, parameters) => (operation === "dns.blocker.askers" ? piholeAskers(parameters, { localDns, run: fixedRun }) : canarySeen(parameters.names, { localDns, run: fixedRun })) };
  const verdict = await createDnsResilienceService({ network: { inspect: async () => topology }, helper, run: staticLink, readFile: async () => { throw new Error("ENOENT"); }, hostname: () => "testbox" }).check();
  console.log(`    ${verdict.state}: ${verdict.detail}`);
  check("no lease, and still: the house goes down with this server", verdict.state === "single-point" && verdict.source === "pihole-log", verdict.headline);
}

try {
  await main();
} catch (error) {
  check("the test ran to the end", false, error.stack);
}
console.log(`\n${results.join("\n")}`);
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
