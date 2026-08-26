/**
 * Local names for installed apps, served by the DNS server already running here.
 * See server/local-dns.mjs for why the records live in a file of BoxPilot's own.
 */
import { defineOperation } from "./registry.mjs";
import { localDomains } from "../local-dns.mjs";

export function localDnsOperations() {
  return [
    defineOperation({
      id: "dns.names.inspect", title: "Read local names for apps", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "Which DNS server can hold local names, the names in force now, and the apps that could have one.",
      run: (_parameters, { localDns }) => localDns.inspect(),
    }),
    defineOperation({
      id: "dns.names.apply", title: "Give every app a local name", risk: "medium", timeoutMs: 5 * 60_000,
      description: "Writes one name per installed app into the DNS server, pointing at this server's address. Records added by hand are in a separate file and are untouched.",
      parameters: { fields: {
        address: { type: "string", maxLength: 45, pattern: /^\d{1,3}(\.\d{1,3}){3}$/ },
        domain: { type: "string", optional: true, validate: (value) => (localDomains.includes(value) ? null : `must be one of ${localDomains.join(", ")}`) },
        ids: { type: "array", optional: true, nullable: true, validate: (value) => (value.length <= 200 && value.every((entry) => typeof entry === "string") ? null : "must be app ids") },
      } },
      run: (parameters, { localDns, progress }) => localDns.apply({ address: parameters.address, domain: parameters.domain ?? "lan", ids: parameters.ids ?? null }, { progress }),
    }),
    defineOperation({
      id: "dns.names.clear", title: "Remove the local names", risk: "medium", timeoutMs: 2 * 60_000,
      description: "Deletes the file of names BoxPilot wrote. Records you added yourself live elsewhere and stay.",
      run: (_parameters, { localDns, progress }) => localDns.clear({ progress }),
    }),
    defineOperation({
      id: "dns.blocker.verify", title: "Check the DNS blocker is being used", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "Sends two ordinary DNS queries to this server's LAN address, the way a laptop on your network would, and reports whether anything answered, whether it can still resolve names, and whether it refused a domain its blocklists should cover. Nothing is changed.",
      parameters: { fields: { address: { type: "string", maxLength: 45, pattern: /^\d{1,3}(\.\d{1,3}){3}$/ } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("dns.blocker.verify", parameters, { timeoutMs: 45_000, logPath: jobLog?.path ?? null }),
    }),
  ];
}
