/**
 * Where a tunneled app's traffic actually leaves (M17.1), read from the tunnel's own log.
 *
 * Gluetun prints the public IP it obtained, with the location, every time the tunnel comes up.
 * That line is better evidence than asking again: it is what the tunnel itself verified. Reading
 * the log also needs no network and no control-server credentials, which the helper does not have.
 */

const exitLine = /^(?<at>\S+)?\s*INFO \[ip getter] Public IP address is (?<ip>[0-9a-fA-F.:]+)(?: \((?<location>[^)]*)\))?/;

/** The newest exit the log admits to, or null when the tunnel has not reported one yet. */
export function parseExit(logText) {
  let found = null;
  for (const raw of String(logText ?? "").split("\n")) {
    const match = exitLine.exec(raw.trim());
    if (!match) continue;
    const location = match.groups.location ?? "";
    // "Netherlands, North Brabant, Breda - source: ipinfo+..." keeps only the place.
    const place = location.split(" - ")[0].trim() || null;
    found = { ip: match.groups.ip, location: place, at: match.groups.at ?? null };
  }
  return found;
}
