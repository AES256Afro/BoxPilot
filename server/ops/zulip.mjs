/**
 * Zulip (M38), the team chat the owner chose for the agents: what BoxPilot does inside the Zulip
 * app it installed from the catalog (catalog/zulip.yaml). App-specific because Zulip's own setup
 * is a management command run inside its container, not a setting.
 *
 * No account is ever made by BoxPilot with a password. The first organization, and its owner, come
 * from Zulip's own single-use creation link (`manage.py generate_realm_creation_link`, run as the
 * zulip user): the owner opens it and chooses their own name and password. The link is shown once,
 * to the person who ran the job, and never stored with it (the registry's oneTimeFields).
 */
import { defineOperation } from "./registry.mjs";

export const zulipAppId = "zulip";
export const zulipManagePy = "/home/zulip/deployments/current/manage.py";
/** Zulip's default for CAN_CREATE_REALM_LINK_VALIDITY_DAYS. */
export const creationLinkDays = 7;

const minutes = (count) => count * 60_000;
const withoutColours = (text) => String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");

/** The single-use link generate_realm_creation_link printed, without its colours; null if none. */
export function readCreationLink(stdout) {
  const match = /https:\/\/[^\s"'<>]+\/new\/[a-z0-9]{16,64}/i.exec(withoutColours(stdout));
  return match ? match[0] : null;
}

/**
 * The organizations `manage.py list_realms` names, without Zulip's own internal one (its system
 * bots) and without deactivated ones (printed in colour).
 */
export function readRealms(stdout) {
  const realms = [];
  for (const line of String(stdout ?? "").split("\n")) {
    if (/\u001b\[/.test(line)) continue;
    const match = /^\s*(\d+)\s+(\S+)\s+(.*?)\s+(https?:\/\/\S+)\s*$/.exec(line);
    if (!match || match[2] === "zulipinternal") continue;
    realms.push({ id: Number(match[1]), stringId: match[2] === "''" ? "" : match[2], name: match[3].trim(), url: match[4] });
  }
  return realms;
}

/** Why a manage.py call failed, in a sentence, from the end of what it printed; never its output. */
function failure(result, what) {
  if (result?.timedOut) return new Error(`${what} did not finish in time; Zulip may still be starting. Try again in a minute.`);
  const tail = withoutColours(result?.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean).slice(-1)[0] ?? "";
  return new Error(`${what} failed${tail ? `: ${tail.slice(0, 300)}` : ""}`);
}

export function zulipOperations() {
  return [
    defineOperation({
      // medium, owner: whoever opens the link becomes the owner of the organization.
      id: "app.zulip.organization.link", title: "Create your Zulip organization", risk: "medium", minimumRole: "owner", timeoutMs: minutes(3),
      description: "Runs Zulip's own manage.py generate_realm_creation_link inside the Zulip container, as the zulip user, and shows you the single-use link it prints: open it to create your organization and your own account, with a name and password you choose. BoxPilot creates no account. The link is shown to you once, is not kept by BoxPilot, works once and expires after 7 days. Refused when Zulip already has an organization.",
      parameters: { exact: true, fields: { id: { type: "string", enum: [zulipAppId] } } },
      oneTimeFields: ["link"],
      run: async (_parameters, { apps, progress }) => {
        progress?.("Checking whether Zulip already has an organization", "stdout");
        const listed = await apps.execIn({ id: zulipAppId, user: "zulip", argv: [zulipManagePy, "list_realms"], timeoutMs: minutes(1) });
        if (!listed.ok) throw failure(listed, "Asking Zulip for its organizations");
        const existing = readRealms(listed.stdout);
        if (existing.length) throw new Error(`Zulip already has an organization, ${existing[0].name}: sign in at ${existing[0].url}. More organizations are made from Zulip's own settings, not here.`);
        progress?.("Asking Zulip for a single-use link to create your organization (the link is not written to this log)", "stdout");
        const made = await apps.execIn({ id: zulipAppId, user: "zulip", argv: [zulipManagePy, "generate_realm_creation_link"], timeoutMs: minutes(1) });
        if (!made.ok) throw failure(made, "generate_realm_creation_link");
        const link = readCreationLink(made.stdout);
        if (!link) throw new Error("Zulip ran generate_realm_creation_link but printed no link BoxPilot recognises; check the Zulip app's logs");
        progress?.(`Zulip made the link: it works once and expires after ${creationLinkDays} days`, "stdout");
        return { link, expiresInDays: creationLinkDays, host: new URL(link).host };
      },
    }),
  ];
}
