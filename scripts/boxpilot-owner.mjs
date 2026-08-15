#!/usr/bin/env node
import { createStateStore } from "../server/state.mjs";

const command = process.argv[2];
if (command !== "create-bootstrap-token") {
  console.error("Usage: npm run owner:token");
  process.exitCode = 2;
} else {
  const store = createStateStore();
  try {
    const result = store.createBootstrapToken();
    console.log("BoxPilot owner bootstrap token (valid for 15 minutes):");
    console.log(result.token);
    console.log(`Expires: ${result.expiresAt}`);
    console.log("Open BoxPilot and finish owner setup. Do not paste this token into chat or logs.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
