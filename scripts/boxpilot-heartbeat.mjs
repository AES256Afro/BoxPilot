#!/usr/local/bin/node
/**
 * One heartbeat (M39.3), as boxpilot-heartbeat.service runs it from its timer: read the address the
 * owner saved, send one bare GET, record what happened in /var/lib/boxpilot-heartbeat/last.json.
 * See server/heartbeat.mjs. It exits 0 whether or not the ping got through: a failed ping is shown
 * in Settings, and a unit left "failed" every few minutes while the internet is down would read as
 * a broken service on Home.
 */
import { pingOnce } from "../server/heartbeat.mjs";

try {
  const status = await pingOnce();
  console.log(status.ok ? `Heartbeat taken: HTTP ${status.status} in ${status.ms} ms` : `Heartbeat not taken: ${status.error}`);
} catch (error) {
  // The status file itself could not be written: say so, without the address, and still exit 0.
  console.error(`Heartbeat not recorded: ${error.message}`);
}
