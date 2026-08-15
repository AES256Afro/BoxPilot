#!/usr/bin/env node
import { createMigrationBundle } from "../server/migration-bundle.mjs";

function usage() {
  console.error("Usage: sudo node scripts/boxpilot-migration-pack.mjs --source /absolute/compose/project --name workload-slug --source-fingerprint sha256:<64 hex>");
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!["--source", "--name", "--source-fingerprint"].includes(key) || !value) throw new Error("Arguments are incomplete or unsupported");
    result[key.slice(2)] = value;
  }
  if (Object.keys(result).length !== 3) throw new Error("All arguments are required exactly once");
  return result;
}

try {
  const input = parseArguments(process.argv.slice(2));
  const result = await createMigrationBundle({
    sourceDirectory: input.source,
    workloadName: input.name,
    sourceFingerprint: input["source-fingerprint"],
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  usage();
  console.error(`Bundle creation failed: ${error.message}`);
  process.exitCode = 1;
}
