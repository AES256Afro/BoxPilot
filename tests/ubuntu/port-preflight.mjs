/**
 * One Start of a Dockge-shaped app through the real app helper, for tests/ubuntu/port-preflight.sh.
 * The host's listeners come from the real root task, `host.listeners`, run in boxpilot-run@ exactly
 * as the helper asks for them, and `compose up` is real Docker. Tailscale is not on the runner, so
 * what `tailscale serve status` would answer is given here.
 *
 *   node port-preflight.mjs <catalog root> <bind address> <port> <image> [served]
 *
 * Writes the app's saved state and a compose file publishing <bind>:<port>, asks the helper to
 * start it, and prints one JSON line: { started, code, message }. Exit status 0 either way; the
 * script judges the outcome.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAppHelper } from "../../server/app-helper.mjs";
import { createRunUnitClient } from "../../server/run-unit.mjs";

const [catalogRoot, bind, portText, image, served] = process.argv.slice(2);
const port = Number(portText);
if (!catalogRoot || !bind || !Number.isInteger(port) || !image) {
  console.error("usage: node port-preflight.mjs <catalog root> <bind address> <port> <image> [served]");
  process.exit(64);
}

const project = path.join(catalogRoot, "dockge");
await mkdir(project, { recursive: true, mode: 0o700 });
await writeFile(path.join(project, "boxpilot.json"), JSON.stringify({ id: "dockge", installed: true, installedAt: new Date().toISOString(), values: { ports: { web: port }, env: {}, volumes: {} } }), { mode: 0o600 });
await writeFile(path.join(project, ".env"), "", { mode: 0o600 });
await writeFile(path.join(project, "compose.yaml"), [
  "name: bp-dockge",
  "services:",
  "  dockge:",
  "    container_name: bp-dockge",
  `    image: ${image}`,
  "    command: [\"httpd\", \"-f\", \"-p\", \"80\", \"-h\", \"/etc\"]",
  "    labels:",
  "      io.boxpilot.app: dockge",
  "    ports:",
  `      - ${bind}:${port}:80`,
  "",
].join("\n"), { mode: 0o600 });

const runUnit = createRunUnitClient();
const serveStatus = JSON.stringify({ Web: served ? { [`homebox.tailXXXX.ts.net:${port}`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } : {} });
const apps = createAppHelper({
  catalogRoot,
  backupRoot: path.join(catalogRoot, "..", "backups"),
  hostListeners: async () => (await runUnit.runTask("host.listeners", {}, { timeoutMs: 30_000 })).listeners,
  runCommand: async (_binary, args) => (args[0] === "serve" ? { ok: true, stdout: serveStatus, stderr: "" } : { ok: false, stdout: "", stderr: "tailscale is not on this runner" }),
});

let outcome;
try {
  const result = await apps.action({ id: "dockge", action: "start" }, { progress: (line) => console.error(`      | ${line}`) });
  outcome = { started: true, code: null, message: null, result };
} catch (error) {
  outcome = { started: false, code: error.code ?? null, message: error.message };
}
console.log(JSON.stringify(outcome));
