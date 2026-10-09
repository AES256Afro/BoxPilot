/**
 * How an evaluation grades an answer (M37, M40): whether it states a fact BoxPilot read from this
 * server when the evaluation began, allowing the ways a small model writes it - "43%", "two apps",
 * "Ubuntu 24.04" - and nothing more generous than that. No model is involved.
 */
import { claimsOf } from "../../packages/harness/src/index.mjs";

/**
 * "Which drives are connected" (M40): right when every drive is named, none is called the system
 * (primary, root, boot) disk that is not, and none is said to be attached the way it is not - the
 * owner's agent called a USB drive the primary drive. Each sentence is read on its own.
 */
export function gradeDrives(value, answer) {
  const drives = Array.isArray(value) ? value : [];
  if (!drives.length) return { passed: false, found: "No drives could be read on this server, so the answer cannot be checked" };
  const short = (device) => String(device).replace(/^\/dev\//, "");
  const mentions = (text, device) => new RegExp(`(?<![\\w/-])(?:/dev/)?${short(device).replace(/[.+]/g, "\\$&")}(?![\\w-])`, "i").test(text);
  // Each sentence, and within it each clause, so "sda is the primary drive and nvme0n1 holds data"
  // is read as two statements.
  const sentences = claimsOf(answer).flatMap((claim) => claim.text.split(/;|,\s+(?:and|but|while)\s+|\s+(?:and|but|while)\s+(?=(?:\/dev\/|nvme|sd[a-z]|vd[a-z]|mmcblk))/i));
  const missing = drives.filter((drive) => !mentions(answer, drive.device));
  const systemWords = /\b(primary|system|root|boot|main|os)\s+(drive|disk|ssd|device)\b|\bthe system disk\b|\bholds? (the )?(root|operating system|os)\b/i;
  const transports = { usb: /\busb\b/i, nvme: /\bnvme\b/i, sata: /\bsata\b/i };
  const wrong = [];
  for (const sentence of sentences) {
    const named = drives.filter((drive) => mentions(sentence, drive.device));
    if (named.length !== 1) continue;
    const [drive] = named;
    if (!drive.system && systemWords.test(sentence) && !/\bnot (the )?(primary|system|root|boot|main|os)\b/i.test(sentence)) wrong.push(`calls ${drive.device} the system disk`);
    const said = Object.entries(transports).filter(([, pattern]) => pattern.test(sentence)).map(([name]) => name);
    if (said.length === 1 && drive.transport && transports[drive.transport] && said[0] !== drive.transport) wrong.push(`calls ${drive.device} ${said[0].toUpperCase()}; it is ${drive.transport.toUpperCase()}`);
  }
  if (missing.length) return { passed: false, found: `Missing: ${missing.map((drive) => drive.device).join(", ")}` };
  if (wrong.length) return { passed: false, found: `Wrong: ${[...new Set(wrong)].join("; ")}` };
  return { passed: true, found: `Names ${drives.map((drive) => drive.device).join(" and ")}` };
}

/** Whether an answer states a fact's value, allowing the ways a model writes it. */
export function gradeFact(fact, value, answer) {
  const text = String(answer ?? "").toLowerCase();
  if (value === null || value === undefined) return { passed: false, found: "The fact could not be read on this server, so the answer cannot be checked" };
  if (fact === "installedApps" || fact === "rootDiskPercent") {
    const numbers = [...text.matchAll(/\b(\d{1,4})(?:\.\d+)?\b/g)].map((match) => Number(match[1]));
    const words = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
    words.forEach((word, index) => { if (new RegExp(`\\b${word}\\b`).test(text)) numbers.push(index); });
    const tolerance = fact === "rootDiskPercent" ? 2 : 0;
    const passed = numbers.some((number) => Math.abs(number - value) <= tolerance);
    return { passed, found: passed ? `Says ${value}` : `Expected ${value}` };
  }
  if (fact === "operatingSystem") {
    const [name, version] = String(value).toLowerCase().match(/^(\S+)\s+([\d.]+)/)?.slice(1) ?? [String(value).toLowerCase(), ""];
    const short = version.split(".").slice(0, 2).join(".");
    const passed = text.includes(name) && (!short || text.includes(short));
    return { passed, found: passed ? `Says ${value}` : `Expected ${value}` };
  }
  if (fact === "piholePlacement") {
    // "not natively on the host" says where it is not: those words are not read as an answer.
    const said = text.replace(/\bnot (?:natively|on the host|in a container|a container|installed by boxpilot)\b[^.;)]*/g, " ");
    const words = { "boxpilot-app": ["boxpilot app", "boxpilot's app", "bp-pi-hole", "installed by boxpilot", "boxpilot container"], container: ["docker container", "a container", "another container"], host: ["natively", "on the host", "systemd", "pihole-ftl.service", "host service"], absent: ["not installed", "isn't installed", "is not running here", "no pi-hole", "nothing called"] }[value] ?? [];
    const passed = words.some((word) => (value === "absent" ? text : said).includes(word));
    return { passed, found: passed ? `Says ${value}` : `Expected ${value}` };
  }
  if (fact === "piholeBlocking") {
    const passed = value === "on" ? /\b(on|enabled|active|is blocking)\b/.test(text) && !/\b(off|disabled|not blocking)\b/.test(text) : /\b(off|disabled|not blocking)\b/.test(text);
    return { passed, found: passed ? `Says ${value}` : `Expected ${value}` };
  }
  if (fact === "firewallEnabled") {
    // M47: on, off, or not installed at all; "not enabled" says off, so the words of off are read first.
    const off = /\b(off|disabled|inactive|not (enabled|on|active|turned on))\b/.test(text);
    const passed = value === "on" ? /\b(on|enabled|active|turned on)\b/.test(text) && !off
      : value === "off" ? off && !/\bnot installed\b/.test(text)
        : /\b(not installed|isn't installed|no (host )?firewall|ufw is (missing|absent))\b/.test(text);
    return { passed, found: passed ? `Says ${value}` : `Expected ${value}` };
  }
  if (fact === "drives") return gradeDrives(value, answer);
  if (Object.hasOwn(namedFacts, fact)) return gradeNames(namedFacts[fact], value, text);
  const passed = text.includes(String(value).toLowerCase());
  return { passed, found: passed ? `Says ${value}` : `Expected ${value}` };
}

/**
 * The facts that are lists of names - which apps are stopped, unhealthy or have an update (M43),
 * which services failed - and how an answer says the list is empty. A unit is named with or
 * without ".service", as a person would.
 */
const namedFacts = {
  stoppedApps: { what: "stopped", none: [/\b(none|no (boxpilot )?apps?|nothing|all (of them |the apps |apps )?(are )?running|every app is running)\b/, /\bstopped( or not running)?: none\b/] },
  unhealthyApps: { what: "unhealthy", none: [/\b(none|no (boxpilot )?apps?|nothing|all (of them |the apps |apps )?(are )?(healthy|running)|every app is (healthy|running))\b/, /\bunhealthy: none\b/] },
  appUpdates: { what: "waiting for an update", none: [/\b(none|nothing|no (app )?updates?|no apps?|all (of them |the apps |apps )?(are )?up to date|every app is up to date)\b/] },
  failedServices: { what: "failed", none: [/\b(none|nothing has failed|no (systemd )?(services?|units?)( have| has)? failed|no failed|0 failed)\b/], name: (unit) => String(unit).replace(/\.service$/, "") },
};

function gradeNames({ what, none, name = (entry) => entry }, value, text) {
  const names = Array.isArray(value) ? value : [];
  const loose = (words) => String(words).toLowerCase().replace(/[\s_-]+/g, "");
  if (!names.length) {
    const passed = none.some((pattern) => pattern.test(text));
    return { passed, found: passed ? `Says none is ${what}` : `Expected: none is ${what}` };
  }
  const missing = names.filter((entry) => !loose(text).includes(loose(name(entry))));
  return { passed: !missing.length, found: missing.length ? `Missing: ${missing.join(", ")}` : `Names ${names.join(", ")}` };
}
