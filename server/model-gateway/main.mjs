/**
 * boxpilot-model-gateway.service (M45.3, ADR-013): the one process that holds the Claude key.
 *
 * - The key arrives by systemd's LoadCredential from a root-owned file the owner set with
 *   `agents.cloud.connect`; it is read once, here, and never written anywhere.
 * - The monthly cap is read from /etc/boxpilot/model-gateway.json on every call, so a new cap holds
 *   at once; the month's spend is kept in the service's own state folder.
 * - It listens on a Unix socket in its runtime folder that only the web service's group may open,
 *   and sends to api.anthropic.com alone (the client refuses redirects and takes no address from
 *   the environment).
 */
import { chmod, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createAnthropicClient, createAnthropicProvider } from "../../packages/harness/src/providers/anthropic.mjs";
import { productVersion } from "../version.mjs";
import { createGateway } from "./gateway.mjs";
import { createLedger } from "./ledger.mjs";
import { createGatewayServer, defaultGatewaySocket } from "./socket.mjs";

export const credentialName = "anthropic-api-key";
export const settingsFile = "/etc/boxpilot/model-gateway.json";

const socketPath = process.env.BOXPILOT_MODEL_GATEWAY_SOCKET ?? defaultGatewaySocket;
const settingsPath = process.env.BOXPILOT_MODEL_GATEWAY_SETTINGS ?? settingsFile;
const stateDirectory = process.env.STATE_DIRECTORY ?? "/var/lib/boxpilot-model-gateway";
const credentials = process.env.CREDENTIALS_DIRECTORY ?? null;

const key = credentials ? (await readFile(path.join(credentials, credentialName), "utf8").catch(() => "")).trim() : "";
const provider = key ? createAnthropicProvider({ client: createAnthropicClient({ apiKey: key }) }) : null;

const ledger = createLedger({ file: path.join(stateDirectory, "spend.json") });
const settings = async () => {
  const saved = JSON.parse(await readFile(settingsPath, "utf8"));
  return { capUsd: Number(saved?.capUsd) > 0 ? Number(saved.capUsd) : 0 };
};
const log = (entry) => console.log(JSON.stringify(entry));

const gateway = createGateway({ provider, ledger, settings, log });
const server = createGatewayServer({ gateway });

await unlink(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
server.listen(socketPath, async () => {
  await chmod(socketPath, 0o660);
  console.log(`BoxPilot model gateway ${productVersion} listening on ${socketPath}; ${provider ? "a key is set" : "no key is set"}`);
});

function shutdown() {
  server.close(async () => {
    await unlink(socketPath).catch(() => {});
    process.exit(0);
  });
  // Calls in flight have systemd's stop timeout to finish; the socket takes no new ones meanwhile.
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
