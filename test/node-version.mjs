import { readFileSync } from "node:fs";

/**
 * Refuse to run the suite on a Node older than package.json's engines. An older Node still runs
 * most of it, and node:sqlite is there from 22, so the run looks fine until a script that checks
 * the version itself (the upgrade script) fails for a reason that has nothing to do with the code.
 */
export default function requireEnginesNode() {
  const { engines } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const wanted = Number(/(\d+)/.exec(engines?.node ?? "")?.[1] ?? 0);
  const running = Number(process.versions.node.split(".")[0]);
  if (running < wanted) throw new Error(`The tests need Node ${wanted} or newer (package.json engines); this is Node ${process.versions.node} at ${process.execPath}`);
}
