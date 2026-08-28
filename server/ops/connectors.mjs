/**
 * Reaching outward (M13.7): named credentials, and the HTTP request they unlock.
 *
 * An HTTP step is an ordinary registered operation, which is the whole design: run by hand it
 * carries a medium confirmation, in a flow it inherits ADR-002's consent (the clock, or another
 * flow completing, under the creator's authority). Credentials are owner-only to manage, live in
 * a root-owned file, are referenced by name everywhere else, and the interface can only ever see
 * names and dates.
 */
import { defineOperation } from "./registry.mjs";
import { credentialNamePattern } from "../credentials.mjs";

const minutes = (count) => count * 60_000;
const credentialNameField = { type: "string", pattern: credentialNamePattern };

export function connectorOperations() {
  return [
    defineOperation({
      id: "credentials.set", title: "Save a credential", risk: "medium", timeoutMs: minutes(1), minimumRole: "owner",
      description: "Saves a token or password under a short name, in a root-owned file on this server. Steps and requests then reference the name; the value itself never appears in a flow, a job record, or the database, and cannot be read back from the interface.",
      parameters: { fields: { name: credentialNameField, value: { type: "string", maxLength: 4096, secret: true } } },
      run: (parameters, { credentials }) => credentials.set({ name: parameters.name, value: parameters.value }),
    }),
    defineOperation({
      id: "credentials.remove", title: "Remove a credential", risk: "medium", timeoutMs: minutes(1), minimumRole: "owner",
      description: "Deletes a saved credential by name. Requests that reference the name will refuse to run until it is saved again.",
      parameters: { fields: { name: credentialNameField } },
      run: (parameters, { credentials }) => credentials.remove({ name: parameters.name }),
    }),
    defineOperation({
      id: "credentials.inspect", title: "List saved credentials", risk: "low", readOnly: true, timeoutMs: 30_000, minimumRole: "owner",
      description: "The names and dates of saved credentials. Values are never returned.",
      parameters: { fields: {} },
      run: async (parameters, { credentials }) => ({ credentials: await credentials.listNames() }),
    }),
    defineOperation({
      id: "http.request", title: "Send an HTTP request", risk: "medium", timeoutMs: minutes(2), minimumRole: "owner",
      description: "Sends one request from this server: a webhook, an ntfy push, an API call. A saved credential can ride along by name in a header of your choosing; the response's status, body, and parsed JSON become the result, which later automation steps can read. Owner-run. Sent from this server; a redirect is never followed when a credential rides along.",
      parameters: { fields: {
        url: { type: "string", maxLength: 2048, pattern: /^https?:\/\/\S+$/ },
        method: { type: "string", optional: true, enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
        body: { type: "string", optional: true, maxLength: 16384 },
        contentType: { type: "string", optional: true, maxLength: 120, pattern: /^[!-~][ -~]*$/ },
        credentialName: { ...credentialNameField, optional: true },
        credentialHeader: { type: "string", optional: true, maxLength: 60, pattern: /^[A-Za-z][A-Za-z0-9-]*$/ },
        credentialPrefix: { type: "string", optional: true, maxLength: 40, pattern: /^[ -~]*$/ },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("http.request", parameters, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null }),
    }),
  ];
}
