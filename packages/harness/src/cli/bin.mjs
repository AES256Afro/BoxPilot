#!/usr/bin/env node
/**
 * boxpilot-harness: the harness's command line (M45.8). Ctrl-C stops the run in progress; what it
 * did so far is kept.
 */
import { main } from "./main.mjs";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.exitCode = await main(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, cwd: process.cwd(), env: process.env, signal: controller.signal });
