// @vitest-environment node
/**
 * Every route, every role, every casing (M29.4).
 *
 * Direct operations are checked by the registry. Composite routes - the Overview, the catalog,
 * Repair, the evidence lists, the support bundle - assemble their answers from several sources and
 * never ask an operation's question, so this file asks it for them: with the owner's and the
 * operator's work on record, no route may hand a viewer or an operator another account's job
 * metadata (its id, title, parameters, error, or who created it), and no route may run an
 * operator-gated read (ADR-003) on a viewer's behalf and pass on what it found. The inventory
 * summaries those routes exist for must still arrive.
 *
 * The routers are mounted as server/index.mjs mounts them, with the same role policy, against a real
 * state store and a stub helper, and driven over a socket. Each request is made as written, in upper
 * case and with a trailing slash, because Express routes all three to the same handler.
 *
 * Every route index.mjs mounts must appear in one of the tables below. A new route, or a new
 * router, fails "every route is accounted for" until it is given an entry.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStateStore } from "../state.mjs";
import { createAuthService, hashPassword } from "../security.mjs";
import { createIdentityService } from "../identity.mjs";
import { createPasskeyService } from "../passkeys.mjs";
import { createJobService } from "../jobs.mjs";
import { createSchedulerService } from "../scheduler.mjs";
import { createFlowService } from "../flows.mjs";
import { createNotificationService } from "../notifications.mjs";
import { createWeeklyReport } from "../weekly-report.mjs";
import { createRecoveryKitService } from "../recovery-kit.mjs";
import { createActionCenterService } from "../action-center.mjs";
import { createSupportBundleService } from "../support-bundle.mjs";
import { createAuditLog } from "../audit.mjs";
import { createSetupService } from "../setup-profiles.mjs";
import { createControllerProtectionService } from "../controller-protection.mjs";
import { createControllerRetentionService } from "../controller-retention.mjs";
import { createVmExportService } from "../vm-export.mjs";
import { createVmProtectionService } from "../vm-protection.mjs";
import { createVmRetentionService } from "../vm-retention.mjs";
import { createVmRecoveryService } from "../vm-recovery.mjs";
import { createStreamBudget } from "../event-stream.mjs";
import { foldVerdict, verdictFrom } from "../backup-verdicts.mjs";
import { securityHeaders } from "../security-headers.mjs";
import { apiRolePolicy } from "./access.mjs";
import { createIdentityRouter } from "./identity.mjs";
import { createPasskeyRouter } from "./passkeys.mjs";
import { createPeopleRouter } from "./people.mjs";
import { createOperationsRouter } from "./operations.mjs";
import { createJobsRouter } from "./jobs.mjs";
import { createVirtualizationRouter } from "./virtualization.mjs";
import { createSettingsRouter } from "./settings.mjs";
import { createFirewallRouter } from "./firewall.mjs";
import { createStorageRouter } from "./storage.mjs";
import { createPowerRouter } from "./power.mjs";
import { createChecklistRouter } from "./checklist.mjs";
import { createHostRouter } from "./host.mjs";
import { createOidcAdminRouter, createOidcRouter } from "./oidc.mjs";
import { createRunbookRouter } from "./runbook.mjs";
import { createRunbookService } from "../runbook-service.mjs";
import { createAssistantRouter } from "./assistant.mjs";
import { createAutoReconnect } from "../auto-reconnect.mjs";
import { createAssistantService } from "../assistant/index.mjs";
import { registry } from "../ops/index.mjs";
import { createRedactor } from "../redaction.mjs";
import { startFakeOllama } from "../../test/fake-ollama.mjs";
import { createAgentsRouter } from "./agents.mjs";
import { createAgentRunnerRouter } from "./agent-runner.mjs";
import { createAgentStore } from "../agents/store.mjs";
import { createAgentService } from "../agents/service.mjs";
import { generateKeyPairSync } from "node:crypto";
import { createPushApprovals } from "../push-approvals.mjs";
import { vapidKeysFrom } from "../web-push.mjs";
import { createPushRouter } from "./push.mjs";

const password = "correct horse battery";
const roles = ["viewer", "operator", "owner"];
const day = 24 * 60 * 60 * 1000;
let directory;
let server;
let base;
let state;
const accounts = {};
const sessions = {};
const fixtures = {};
// Agents (M37): the service the routes answer from, and the runner's key.
let agents;
let runnerToken;
let agentStore;
const routers = {};
// The assistant's model (M34): a stand-in on a loopback port, so each test can read what it was shown.
let fakeModel;
// Push approvals (M25.2).
let pushApprovals;

// ---- the helper: canned answers per operation, and a record of what each request asked for ----

const helperCalls = [];
const helperAnswers = {
  "app.inspect": () => ({ applications: [{ id: "jellyfin", installed: true, container: { state: "running" }, urls: [], folderProblems: [], state: { values: { ports: {}, env: {}, volumes: {} } } }] }),
  "samba.inspect": () => ({
    installed: true, running: true, configured: true, users: ["alex"], discovery: { running: true },
    config: { managed: true, workgroup: "WORKGROUP", scope: "tailscale", interfaces: [], shares: [{ name: "media", path: "/srv/media", comment: null, readOnly: false, guest: false, users: [], recycle: true, recycleBytes: 734003200, ownerUid: 0 }] },
  }),
  "storage.usb.events": () => ({ available: true, days: 30, ports: [{ port: "2-1", drops: [{ at: "2026-09-20T10:00:00Z" }, { at: "2026-09-25T10:00:00Z" }], lastDropAt: "2026-09-25T10:00:00Z", vendorId: "1a2b", productId: "3c4d", powerFaults: 1, resets: 0 }] }),
  "storage.unclean.events": () => ({ available: true, events: [] }),
  "storage.volumes.state": () => ({ available: true, readAt: "2026-09-28T12:00:00.000Z", drives: [] }),
  "housekeeping.inspect": () => ({ groups: [{ id: "docker-unused", safe: true, bytes: 40 * 1024 ** 3 }] }),
  "apt.upgradable.inspect": () => ({ packages: [] }),
  "logs.read": () => ({ lines: ["a journal line"] }),
  "controller.database.protection.retention.inspect": () => ({ repositoryId: "c".repeat(64), destinationRevision: "d".repeat(64), snapshotSetRevision: "e".repeat(64), snapshots: [], ready: false, blockers: ["The controller repository is not mounted"] }),
  "virtualization.export.backup.retention.inspect": () => ({ repositoryId: "b".repeat(64), destinationRevision: "d".repeat(64), snapshotSetRevision: "e".repeat(64), snapshots: [], ready: false, blockers: ["The VM repository is not mounted"] }),
};
const helper = {
  request: async (operation) => {
    helperCalls.push(operation);
    return helperAnswers[operation]?.() ?? { ok: true };
  },
};

// ---- requests ----

async function call(method, url, session, { body } = {}) {
  helperCalls.length = 0;
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(session ? { Cookie: session.cookie, "X-BoxPilot-CSRF": session.csrfToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let text = "";
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    // A stream stays open: read up to its first snapshot, or to the job's final state, then hang up.
    const reader = response.body.getReader();
    try {
      while (!/event: (snapshot|state)\ndata: [^\n]*\n\n/.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString("utf8");
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } else {
    text = await response.text();
  }
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: response.status, headers: response.headers, text, body: parsed, calls: [...helperCalls] };
}

async function signIn(username) {
  const response = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  const body = await response.json();
  const cookie = String(response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie")).split(";")[0];
  return { cookie, csrfToken: body.csrfToken };
}

/** The same route three ways: as written, in upper case (parameters left alone), with a trailing slash. */
function variantsOf(template, params = {}, query = "") {
  const fill = (text) => text.replace(/:(\w+)/g, (_match, name) => encodeURIComponent(params[name] ?? "x"));
  const upper = template.split("/").map((segment) => (segment.startsWith(":") ? segment : segment.toUpperCase())).join("/");
  return [
    { name: "as written", url: `${fill(template)}${query}` },
    { name: "in upper case", url: `${fill(upper)}${query}` },
    { name: "with a trailing slash", url: `${fill(template)}/${query}` },
  ];
}

/** What each role must never be shown: the other accounts, their jobs, and what those jobs carried. */
const foreign = {
  viewer: () => [accounts.owner.id, accounts.operator.id, fixtures.ownerJob.id, fixtures.operatorJob.id, "owner-marker", "operator-marker"],
  operator: () => [accounts.owner.id, fixtures.ownerJob.id, "owner-marker"],
  owner: () => [],
};

// ---- the tables ----

/** No session needed: signing in, discovery, the OIDC protocol, health, the CA certificate, the flow webhook. */
const publicRoutes = [
  "GET /api/v1/health", "GET /ca.crt", "POST /api/v1/hooks/flows/:id/:token", "POST /api/v1/hooks/agents/:id/:token",
  "GET /api/v1/auth/status", "POST /api/v1/auth/bootstrap", "POST /api/v1/auth/login",
  "GET /api/v1/auth/identity", "POST /api/v1/auth/tailscale", "POST /api/v1/auth/github/start", "POST /api/v1/auth/github/poll",
  "POST /api/v1/auth/passkey/options", "POST /api/v1/auth/passkey/verify", "POST /api/v1/auth/passkey/recovery",
  "GET /.well-known/openid-configuration", "GET /oidc/jwks", "GET /oidc/authorize", "POST /oidc/authorize", "POST /oidc/token", "GET /oidc/userinfo",
  "OPTIONS /oidc/token", "OPTIONS /oidc/userinfo", "OPTIONS /oidc/jwks",
];

/** The caller's own account and nothing else: sign-out, elevation, password, sessions, passkeys, linked identities. */
const selfRoutes = [
  "POST /api/v1/auth/logout", "POST /api/v1/auth/elevate", "DELETE /api/v1/auth/elevate", "POST /api/v1/auth/password",
  "DELETE /api/v1/auth/sessions/:id", "POST /api/v1/auth/sessions/revoke-others",
  "POST /api/v1/auth/passkey/register/options", "POST /api/v1/auth/passkey/register/verify", "PUT /api/v1/auth/passkey/:id", "DELETE /api/v1/auth/passkey/:id", "POST /api/v1/auth/passkey/recovery-codes",
  "POST /api/v1/auth/identity/tailscale", "DELETE /api/v1/auth/identity/tailscale", "POST /api/v1/auth/identity/github/start", "DELETE /api/v1/auth/identity/github",
  // M36: the notification centre's "mark seen", which only moves the caller's own marker.
  "POST /api/v1/notifications/seen",
];

/** Registered operations: the registry decides (minimumRole, ADR-003, elevation). Tested below and in authorization.test.mjs. */
const directRoutes = ["POST /api/v1/operations/:id/run", "POST /api/v1/operations/:id/jobs"];

/** Everything else that is not a GET: refused to a viewer before it runs, and settings and people changes to an operator. */
const changeRoutes = [
  "POST /api/v1/catalog/:id/precheck", "POST /api/v1/setup/autoinstall", "POST /api/v1/network/plans",
  "POST /api/v1/jobs/:id/approve", "POST /api/v1/jobs/:id/more-time", "POST /api/v1/jobs/:id/dismiss", "DELETE /api/v1/jobs/:id",
  // M38: what a job showed once (Zulip's organization link), to the person who ran it.
  "POST /api/v1/jobs/:id/once",
  "POST /api/v1/flows", "PUT /api/v1/flows/:id", "DELETE /api/v1/flows/:id", "POST /api/v1/flows/:id/webhook", "DELETE /api/v1/flows/:id/webhook", "POST /api/v1/flows/:id/run",
  "POST /api/v1/schedules", "PUT /api/v1/schedules/:id", "DELETE /api/v1/schedules/:id",
  "POST /api/v1/drives/:name/auto-reconnect", "DELETE /api/v1/drives/:name/auto-reconnect",
  // Repair's memory (M35): a finding or failed job set aside, and which job was fixing which finding.
  "POST /api/v1/remediations/dismissals", "DELETE /api/v1/remediations/dismissals/:id", "POST /api/v1/remediations/attempts",
  "POST /api/v1/oidc/clients", "DELETE /api/v1/oidc/clients/:id",
  "POST /api/v1/people", "PUT /api/v1/people/:id", "DELETE /api/v1/people/:id",
  "PUT /api/v1/settings/weekly-report", "POST /api/v1/settings/weekly-report/send", "PUT /api/v1/settings/notifications", "POST /api/v1/settings/notifications/test",
  "PUT /api/v1/settings/approval-mode", "PUT /api/v1/settings/backup-destination", "PUT /api/v1/settings/github-client-id", "PUT /api/v1/settings/assistant",
  "POST /api/v1/storage/shares/list", "POST /api/v1/virtualization/media/uploads", "POST /api/v1/virtualization/plans",
  // Agents (M37): making, changing, running, pausing and stopping them, their cards, notes, library
  // and evaluations, and the owner's switch. None stages or runs an operation.
  "POST /api/v1/agents", "PUT /api/v1/agents/:id", "DELETE /api/v1/agents/:id", "POST /api/v1/agents/:id/rollback",
  "POST /api/v1/agents/:id/pause", "POST /api/v1/agents/:id/resume", "POST /api/v1/agents/:id/runs",
  "DELETE /api/v1/agents/:id/notes/:noteId", "PUT /api/v1/agents/:id/evaluation", "POST /api/v1/agents/:id/evaluation/run",
  "POST /api/v1/agents/proposals/:proposalId/decide", "POST /api/v1/agents/runs/:runId/cancel",
  "POST /api/v1/agents/module/pause", "POST /api/v1/agents/module/resume", "POST /api/v1/agents/module/kill",
  "POST /api/v1/agents/knowledge/documents", "PUT /api/v1/agents/knowledge/documents/:documentId", "DELETE /api/v1/agents/knowledge/documents/:documentId", "POST /api/v1/agents/knowledge/relearn",
  "PUT /api/v1/agents/knowledge/documents/:documentId/pin", "POST /api/v1/agents/knowledge/upload", "POST /api/v1/agents/knowledge/folder/sync", "POST /api/v1/agents/knowledge/reindex",
  // M38: read #agent-files now (the owner's; refused while Zulip is not connected).
  "POST /api/v1/agents/zulip/poll",
  // M40.5: who in Zulip may ask, as which account (the owner's, with the password).
  "PUT /api/v1/agents/zulip/people",
  "POST /api/v1/agents/import", "POST /api/v1/agents/:id/webhook", "DELETE /api/v1/agents/:id/webhook",
  "PUT /api/v1/agents/:id/memory/notes/:noteId", "DELETE /api/v1/agents/:id/memory/notes/:noteId", "DELETE /api/v1/agents/:id/memory/episodes/:episodeId",
  "PUT /api/v1/settings/agents",
  // Push approvals (M25.2): a device's subscription, its removal, a test push, and the owner's choices.
  "POST /api/v1/push/subscriptions", "DELETE /api/v1/push/subscriptions/:id", "POST /api/v1/push/test", "PUT /api/v1/settings/push",
];

/**
 * The agents runner's own routes (M37): no session, one scoped key, loopback only. Refused to a
 * person's session and to anyone without the key; the key opens nothing else (tested below).
 */
const runnerRoutes = [
  "POST /api/v1/agent-runner/hello", "POST /api/v1/agent-runner/next", "POST /api/v1/agent-runner/usage",
  "POST /api/v1/agent-runner/runs/:runId/heartbeat", "POST /api/v1/agent-runner/runs/:runId/steps",
  "POST /api/v1/agent-runner/runs/:runId/tools", "POST /api/v1/agent-runner/runs/:runId/finish", "POST /api/v1/agent-runner/runs/:runId/vectors",
];

/** Asking an agent someone may borrow (M37): a POST that only reads, as the asker, like the assistant. */
const agentAskRoutes = ["POST /api/v1/agents/:id/ask"];
/**
 * A person's own with an agent (M37): whether an answer was right, and forgetting the conversation
 * with them. Open to viewers by the role policy; the service allows each only on the caller's own.
 */
const agentOwnRoutes = ["POST /api/v1/agents/runs/:runId/feedback", "DELETE /api/v1/agents/:id/memory/thread"];
const ownerOnlyChange = /^\/api\/v1\/(settings|people|oidc\/clients)(\/|$)/;

/**
 * Questions: a POST that only reads, open to every role (M34). What each role's answer is built
 * from - the model's prompt as well as the response - is checked below like a data route's body.
 */
const questionRoutes = ["POST /api/v1/assistant/ask"];

const open = { viewer: 200, operator: 200, owner: 200 };
const operatorUp = { viewer: 403, operator: 200, owner: 200 };
const ownerOnly = { viewer: 403, operator: 403, owner: 200 };
const ownersJob = { viewer: 404, operator: 404, owner: 200, params: () => ({ id: fixtures.ownerJob.id }) };
const operatorsJob = { viewer: 404, operator: 200, owner: 200, params: () => ({ id: fixtures.operatorJob.id }) };

/**
 * Every GET behind the session: the status each role gets, and what else must hold. `check` runs on
 * every role and casing with the response, the role, and the helper operations the request ran.
 */
const dataRoutes = {
  "GET /api/v1/auth/sessions": [open],
  "GET /api/v1/auth/passkey": [open],
  "GET /api/v1/auth/identity/links": [operatorUp],
  "GET /api/v1/people": [ownerOnly],
  "GET /api/v1/operations": [open],
  "GET /api/v1/operations/:id/inspect": [{ ...operatorUp, params: () => ({ id: "samba.inspect" }) }, { ...open, params: () => ({ id: "app.inspect" }) }],
  "GET /api/v1/operations/prerequisites": [open],
  "GET /api/v1/operations/recovery-kit": [ownerOnly],
  "GET /api/v1/operations/action-center": [{
    ...open,
    // The owner's failed job is the owner's to count; nobody else has a failed job of their own.
    check: ({ role, body }) => expect(body.notices.some((notice) => notice.id === "jobs.failed"), role).toBe(role === "owner"),
  }],
  "GET /api/v1/jobs": [{ ...open, check: ({ role, body }) => expect(body.jobs.length, role).toBe({ viewer: 0, operator: 1, owner: 2 }[role]) }],
  "GET /api/v1/events": [{ ...open, check: ({ role, text }) => expect(text, role).toContain("event: snapshot") }],
  "GET /api/v1/jobs/:id/output": [ownersJob, operatorsJob],
  "GET /api/v1/jobs/:id/stream": [ownersJob, operatorsJob],
  "GET /api/v1/jobs/:id": [ownersJob, operatorsJob],
  "GET /api/v1/jobs/:id/approval": [ownersJob, operatorsJob],
  // What is armed and what waits for a person (M26.5): flow ids and hold state, no account or job ids.
  "GET /api/v1/drives/auto-reconnect": [{ ...open, check: ({ role, body }) => expect(body.limits, role).toMatchObject({ maxAttempts: 3 }) }],
  "GET /api/v1/flows": [{
    ...open,
    check: ({ role, body }) => {
      const flow = (id) => body.flows.find((entry) => entry.id === id);
      // Everyone sees both flows; a run is shown in full only to whoever ran it, and to the owner.
      expect(body.flows.length, role).toBe(2);
      if (role === "owner") expect(flow(fixtures.ownerFlow.id)).toMatchObject({ createdBy: accounts.owner.id, lastJobIds: [fixtures.ownerJob.id] });
      else expect(flow(fixtures.ownerFlow.id)).toMatchObject({ createdBy: null, lastJobIds: [], lastRunElsewhere: true, lastResult: "stopped at step 1 (Refresh package lists)" });
      // A request's address is cut to where it goes, and an owner-only step keeps only its name.
      const [, request, removal] = flow(fixtures.ownerFlow.id).steps;
      if (role === "owner") {
        expect(request.parameters).toMatchObject({ url: "https://ntfy.example/owner-marker-topic", credentialName: "ntfy-token" });
        expect(removal.parameters).toEqual({ name: "ntfy-old" });
      } else {
        expect(request).toMatchObject({ operationId: "http.request", parameters: { url: "https://ntfy.example", method: "POST" }, parametersHidden: true });
        expect(removal).toMatchObject({ operationId: "credentials.remove", parameters: {}, parametersHidden: true });
      }
      if (role === "viewer") expect(flow(fixtures.operatorFlow.id)).toMatchObject({ createdBy: null, lastJobIds: [], lastRunElsewhere: true, lastResult: "completed" });
      else expect(flow(fixtures.operatorFlow.id)).toMatchObject({ createdBy: accounts.operator.id, lastJobIds: [fixtures.operatorJob.id] });
    },
  }],
  "GET /api/v1/flows/suggestions": [{ ...open, check: ({ role, calls }) => expect(calls.includes("housekeeping.inspect"), role).toBe(role !== "viewer") }],
  "GET /api/v1/schedules": [{ ...open, check: ({ role, body }) => expect(body.schedules.length, role).toBe({ viewer: 0, operator: 1, owner: 2 }[role]) }],
  "GET /api/v1/virtualization/status": [open],
  "GET /api/v1/virtualization/domains": [open],
  "GET /api/v1/virtualization/setup-plan": [open],
  "GET /api/v1/virtualization/resources": [open],
  "GET /api/v1/virtualization/foundation": [open],
  "GET /api/v1/virtualization/console-guidance": [open],
  "GET /api/v1/virtualization/planning-options": [open],
  "GET /api/v1/virtualization/media": [open],
  "GET /api/v1/virtualization/exports": [{ ...open, check: ({ role, body }) => expect(body.exports[0].createdBy, role).toBe(role === "owner" ? accounts.owner.id : null) }],
  "GET /api/v1/virtualization/protection": [{ ...open, check: ({ role, body }) => expect(body.backups.length, role).toBe(3) }],
  "GET /api/v1/virtualization/retention": [{ ...open, check: ({ role, body }) => expect(body.retentionRuns.length, role).toBe(1) }],
  "GET /api/v1/virtualization/recoveries": [{ ...open, check: ({ role, body }) => expect(body.recoveries.length, role).toBe(1) }],
  "GET /api/v1/settings/notifications": [open],
  "GET /api/v1/settings/watch": [{
    ...open,
    check: ({ role, body }) => {
      // Every role counts the same live conditions and unheard news; the words differ.
      expect(body.activeCount, role).toBe(4);
      expect(body.unannouncedCount, role).toBe(6);
      const interrupted = body.notices.find((notice) => notice.key === "job.interrupted");
      expect(interrupted.title, role).toBe(role === "owner" ? "Refresh package lists (owner-marker) was interrupted" : "A job was cut off by a restart");
      const failedSchedules = body.conditions.find((condition) => condition.key === "schedule.failed").details.map((detail) => detail.title).sort();
      expect(failedSchedules, role).toEqual({
        viewer: ["A scheduled task failed or did not run", "A scheduled task failed or did not run"],
        operator: ["A scheduled task failed or did not run", "Scheduled task failed: operator-marker"],
        owner: ["Scheduled task failed: operator-marker", "Scheduled task failed: owner-marker"],
      }[role]);
    },
  }],
  // M36: what BoxPilot said lately. Every role reads that it said something; the words of another
  // account's job or schedule are the kind only, and no message goes with them.
  "GET /api/v1/notifications": [{
    ...open,
    check: ({ role, body }) => {
      expect(body.entries.map((entry) => entry.kind), role).toEqual(["job", "job", "alert", "notice"]);
      const [operatorsFailure, ownersFailure, schedule, interrupted] = body.entries;
      expect(ownersFailure.title, role).toBe(role === "owner" ? "Refresh package lists (owner-marker) failed" : "A job failed");
      expect(ownersFailure.message === null, role).toBe(role !== "owner");
      expect(operatorsFailure.title, role).toBe(role === "viewer" ? "A job failed" : "Refresh package lists (operator-marker) failed");
      expect(schedule.title, role).toBe(role === "owner" ? "Scheduled task failed: owner-marker" : "A scheduled task failed or did not run");
      expect(schedule.live, role).toBe(true);
      expect(interrupted.title, role).toBe(role === "owner" ? "Refresh package lists (owner-marker) was interrupted" : "A job was cut off by a restart");
      expect(JSON.stringify(body).includes(role === "owner" ? "no-such-marker" : "owner-marker"), role).toBe(false);
    },
  }],
  "GET /api/v1/settings/weekly-report": [open],
  // Push approvals (M25.2): the key to subscribe with and your own devices, for whoever can approve;
  // where the pushes link to, for the owner alone.
  "GET /api/v1/push": [{
    ...open,
    check: ({ role, body }) => {
      expect(body.canSubscribe, role).toBe(role !== "viewer");
      expect(body.publicKey === null, role).toBe(role === "viewer");
      expect(body.devices.map((device) => device.label), role).toEqual(role === "owner" ? ["owner-marker phone"] : []);
      expect(body.settings.openAt, role).toBe(role === "owner" ? "https://homebox.example.ts.net" : null);
      expect(JSON.stringify(body), role).not.toContain("push.apple.com");
    },
  }],
  "GET /api/v1/settings/weekly-report/preview": [ownerOnly],
  "GET /api/v1/settings/approval-mode": [open],
  "GET /api/v1/settings/vpn-profile": [ownerOnly],
  "GET /api/v1/settings/cloud-destination": [open],
  "GET /api/v1/settings/backup-destination": [open],
  "GET /api/v1/firewall/overview": [{ ...open, check: ({ role, body }) => expect(body.current, role).toMatchObject({ id: "home-server", appliedBy: role === "owner" ? accounts.owner.id : null }) }],
  "GET /api/v1/firewall/plan": [{ ...open, query: "?profile=home-server" }],
  "GET /api/v1/storage/overview": [{ ...open, check: ({ role, body }) => expect(body.snapshots[0], role).toMatchObject({ name: "data-snap", createdBy: role === "owner" ? accounts.owner.id : null }) }],
  "GET /api/v1/storage/forecast": [{
    ...open,
    check: ({ role, body }) => {
      // Drive forecasts are df's; what each app's folders hold is app.data.usage's, an operator read.
      expect(body.forecasts.length, role).toBe(1);
      expect(body.usage.length, role).toBe(role === "viewer" ? 0 : 1);
      expect(body.lastMeasured === null, role).toBe(role === "viewer");
    },
  }],
  "GET /api/v1/storage/shares/discover": [open],
  "GET /api/v1/storage/nfs": [open],
  "GET /api/v1/storage/samba": [{
    ...open,
    check: ({ role, body }) => {
      const [share] = body.config.shares;
      expect(share, role).toMatchObject({ name: "media", path: "/srv/media", recycle: true });
      expect("recycleBytes" in share && "ownerUid" in share, role).toBe(role !== "viewer");
    },
  }],
  "GET /api/v1/power/ups/detect": [open],
  "GET /api/v1/setup/checklist": [{ ...open, check: ({ role, body }) => expect(body.items.find((item) => item.id === "shares").done, role).toBe(true) }],
  "GET /api/v1/diagnostics/runtime": [open],
  "GET /api/v1/catalog": [{
    ...open,
    check: ({ role, body }) => {
      const live = body.applications.find((entry) => entry.manifest.id === "jellyfin").live;
      const who = role === "owner" ? accounts.owner.id : null;
      expect(live.backupVerification, role).toMatchObject({ verified: true, by: who });
      expect(live.backupVerification.history[0].by, role).toBe(who);
      expect(live.killSwitchDrill, role).toMatchObject({ held: true, by: who });
    },
  }],
  "GET /api/v1/ssh-keys/github/:user": [{ viewer: 400, operator: 400, owner: 400, params: () => ({ user: "-not-a-user-" }) }],
  "GET /api/v1/remediations": [{
    ...open,
    check: ({ role, body, calls }) => {
      // File sharing, USB history and unclean unmounts are operator reads; a viewer's scan names
      // them as left to one.
      const operatorReads = role !== "viewer";
      expect(calls.includes("samba.inspect") && calls.includes("storage.usb.events") && calls.includes("storage.unclean.events") && calls.includes("storage.volumes.state"), role).toBe(operatorReads);
      expect(body.findings.some((finding) => finding.id === "flaky-drive:2-1"), role).toBe(operatorReads);
      expect(body.unavailableChecks, role).toEqual(operatorReads ? [] : ["File sharing (needs an operator)", "USB history (needs an operator)", "Unclean unmounts (needs an operator)", "Drive filesystems (needs an operator)"]);
    },
  }],
  "GET /api/v1/tls/ca.crt": [open],
  "GET /api/v1/capabilities": [open],
  "GET /api/v1/integrations/github": [open],
  "GET /api/v1/system/update": [open],
  "GET /api/v1/setup": [open],
  "GET /api/v1/support-bundle": [{
    ...operatorUp,
    check: ({ role, body }) => {
      if (role === "viewer") return;
      const events = body.sources.audit.data;
      expect(events.length, role).toBeGreaterThan(0);
      expect(events.every((event) => event.actorId === accounts[role].id), role).toBe(role === "operator");
    },
  }],
  "GET /api/v1/inventory": [open],
  "GET /api/v1/network/topology": [open],
  "GET /api/v1/network/tailnet": [open],
  "GET /api/v1/network/dns-resilience": [open],
  "GET /api/v1/network/reachability": [open],
  "GET /api/v1/backups": [{
    ...open,
    check: ({ role, body }) => {
      expect(body.backups.length, role).toBe(2);
      expect(body.backups.map((backup) => backup.createdBy), role).toEqual(role === "owner" ? [accounts.owner.id, accounts.owner.id] : [null, null]);
    },
  }],
  "GET /api/v1/controller-backup-protection": [{ ...open, check: ({ role, body }) => expect(body.protections.length, role).toBe(2) }],
  "GET /api/v1/controller-backup-retention": [{ ...open, check: ({ role, body }) => expect(body.retentionRuns.length, role).toBe(1) }],
  "GET /api/v1/audit": [{ ...open, check: ({ role, body }) => expect(body.events.length, role).toBe({ viewer: 0, operator: 1, owner: 2 }[role]) }],
  "GET /api/v1/oidc/clients": [ownerOnly],
  // The server runbook (M34.4). Generating it needs an operator (ADR-003): it lays out private
  // paths and is built from operator reads. The full download, which names where every second copy
  // is kept and carries every account's schedules and alerts, is the owner's, like the recovery kit.
  "GET /api/v1/runbook": [{
    ...operatorUp,
    check: ({ role, body }) => {
      expect(body.audience, role).toBe(role);
      expect(body.markdown, role).toContain("## 7. How to restore");
      // Where the second copy is kept is in the owner's copy only.
      expect(body.markdown.includes("backup.example:/srv/boxpilot"), role).toBe(role === "owner");
      expect(body.markdown.includes("This is an operator's copy"), role).toBe(role === "operator");
    },
  }],
  "GET /api/v1/runbook/status": [{ ...operatorUp, check: ({ role, body }) => expect(body.canDownload, role).toBe(role === "owner") }],
  "GET /api/v1/runbook/download": [{
    ...ownerOnly,
    check: ({ role, headers, text }) => {
      expect(headers.get("content-type"), role).toContain("text/markdown");
      expect(headers.get("content-disposition"), role).toMatch(/^attachment; filename="boxpilot-runbook-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md"$/);
      expect(text, role).toContain("backup.example:/srv/boxpilot");
    },
  }],
  // Whether the local model answers, for everyone; which models it holds and where, like
  // app.models.inspect, for an operator (M29.6); the saved choices for the owner.
  "GET /api/v1/assistant/status": [{
    ...open,
    check: ({ role, body }) => {
      expect(body, role).toMatchObject({ ready: true, chatModel: "hermes3:8b" });
      expect("models" in body && "endpoint" in body, role).toBe(role !== "viewer");
      expect("settings" in body, role).toBe(role === "owner");
    },
  }],
  // Agents (M37). The module's state, the usage and the catalog are everyone's; a viewer sees only
  // the agents they may borrow. Runs, cards and notes follow the jobs rule: another account's work
  // is the owner's to see. The runtime's host read is an operator read (ADR-003).
  "GET /api/v1/agents": [{
    ...open,
    check: ({ role, body }) => {
      expect(body.module.enabled, role).toBe(true);
      expect(body.agents.map((agent) => agent.name).sort(), role).toEqual(role === "viewer" ? ["IT Support helper"] : ["IT Support helper", "Server Keeper"]);
      expect(body.cardsWaiting, role).toBe(role === "owner" ? 1 : 0);
    },
  }],
  "GET /api/v1/agents/catalog": [{ ...open, check: ({ role, body }) => expect(body.templates.length, role).toBe(10) }],
  "GET /api/v1/agents/usage": [{ ...open, check: ({ role, body }) => expect(body.caps.cpuQuotaPercent, role).toBe(400) }],
  "GET /api/v1/agents/runtime": [{
    ...open,
    check: ({ role, body, calls }) => {
      expect(calls.includes("agents.runtime.inspect"), role).toBe(role !== "viewer");
      expect("endpoint" in body.settings, role).toBe(role === "owner");
    },
  }],
  "GET /api/v1/agents/glance": [operatorUp],
  "GET /api/v1/agents/proposals": [{ ...open, check: ({ role, body }) => expect(body.proposals.length, role).toBe(role === "owner" ? 1 : 0) }],
  "GET /api/v1/agents/knowledge": [operatorUp],
  // M38: the team chat's panel; the posts themselves only for the owner.
  "GET /api/v1/agents/zulip": [{ ...operatorUp, check: ({ role, body }) => { if (role !== "viewer") expect(Array.isArray(body.recent), role).toBe(true); } }],
  "GET /api/v1/agents/runs/:runId": [
    { viewer: 404, operator: 404, owner: 200, params: () => ({ runId: fixtures.ownerRun }) },
    { viewer: 404, operator: 200, owner: 200, params: () => ({ runId: fixtures.operatorRun }) },
  ],
  "GET /api/v1/agents/runs/:runId/stream": [
    { viewer: 404, operator: 404, owner: 200, params: () => ({ runId: fixtures.ownerRun }) },
    { viewer: 404, operator: 200, owner: 200, params: () => ({ runId: fixtures.operatorRun }) },
  ],
  "GET /api/v1/agents/:id": [
    { viewer: 404, operator: 200, owner: 200, params: () => ({ id: fixtures.keeper.id }) },
    { ...open, params: () => ({ id: fixtures.helper.id }) },
  ],
  "GET /api/v1/agents/:id/versions/:version": [{ viewer: 403, operator: 200, owner: 200, params: () => ({ id: fixtures.helper.id, version: "1" }) }],
  "GET /api/v1/agents/:id/runs": [{
    ...open,
    params: () => ({ id: fixtures.helper.id }),
    check: ({ role, body }) => expect(body.runs.map((run) => run.id), role).toEqual(role === "viewer" ? [] : [fixtures.operatorRun]),
  }, {
    viewer: 404, operator: 200, owner: 200,
    params: () => ({ id: fixtures.keeper.id }),
    check: ({ role, body }) => expect(body.runs.map((run) => run.id), role).toEqual(role === "owner" ? [fixtures.ownerRun] : []),
  }],
  "GET /api/v1/agents/:id/notes": [{ viewer: 404, operator: 403, owner: 200, params: () => ({ id: fixtures.keeper.id }), check: ({ role, body }) => expect(body.notes.length, role).toBe(1) }],
  "GET /api/v1/agents/:id/evaluation": [{ viewer: 403, operator: 200, owner: 200, params: () => ({ id: fixtures.helper.id }) }],
  // What an agent remembers is for the owner and the person who made it; a definition to export too.
  "GET /api/v1/agents/:id/memory": [{ viewer: 404, operator: 403, owner: 200, params: () => ({ id: fixtures.keeper.id }), check: ({ body }) => expect(body.facts.map((note) => note.title)).toEqual(["Owner note"]) }],
  "GET /api/v1/agents/:id/export": [{ viewer: 403, operator: 403, owner: 200, params: () => ({ id: fixtures.keeper.id }), check: ({ body }) => expect(body).toMatchObject({ format: "boxpilot-agent", version: 1 }) }],
};

// ---- the app, as index.mjs assembles it ----

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-route-matrix-"));
  state = createStateStore({ stateDirectory: directory });
  const passwordHash = await hashPassword(password);
  accounts.owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "owner", passwordHash });
  accounts.operator = state.createOwnerAccount({ username: "operator", passwordHash, role: "operator", createdBy: accounts.owner.id });
  accounts.viewer = state.createOwnerAccount({ username: "viewer", passwordHash, role: "viewer", createdBy: accounts.owner.id });

  const tlsDir = path.join(directory, "tls");
  await mkdir(tlsDir, { recursive: true });
  await writeFile(path.join(tlsDir, "ca.crt"), "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");

  const auth = createAuthService(state);
  const identity = createIdentityService({ store: state, run: async () => ({ ok: false, stdout: "", stderr: "" }) });
  const jobs = createJobService(state, helper);
  const scheduler = createSchedulerService({ store: state, jobs });
  const flows = createFlowService({ store: state, jobs, library: [] });
  const notifications = createNotificationService({ store: state });
  const weeklyReport = createWeeklyReport({ store: state, alerts: null, notifications });
  const inventory = { inspect: async () => ({ network: { addresses: [], tailscale: { dnsName: null } }, storage: { filesystems: { available: true, summary: {}, errors: {} }, smart: { available: true, status: "ok" } }, power: null, maintenance: null }) };
  const network = { inspect: async () => ({ tailscale: { connected: false, dnsName: null }, eligibleLanAddresses: [] }), tailnet: async () => ({ devices: [] }) };
  const prerequisites = { inspect: async () => ({ checks: [] }) };
  const libvirt = { getStatus: async () => ({ connected: true }), listDomains: async () => ({ connected: true, domains: [] }), listResources: async () => ({ connected: true }), getConsoleGuidance: async () => ({}) };
  const recoveryKit = createRecoveryKitService({ store: state, prerequisites, helper, libvirt });
  const actionCenter = createActionCenterService({ recoveryKit, inventory, listJobs: (createdBy) => state.listJobs(100, { createdBy }) });
  const audit = createAuditLog({ stateDirectory: directory });
  const supportBundle = createSupportBundleService({ inventory, prerequisites, actionCenter, audit, helper, store: state, loadPolicy: async () => { throw new Error("no policy file in a test"); } });
  const manifest = { id: "jellyfin", name: "Jellyfin", category: "media", description: "Media server", ports: [], volumes: [] };
  const catalogService = { all: async () => ({ manifests: [manifest], problems: [] }), get: async (id) => (id === manifest.id ? manifest : null) };
  const oidc = { status: () => ({ available: true }), listClients: () => [] };

  routers.createIdentityRouter = createIdentityRouter({ store: state, auth, identity });
  routers.createPasskeyRouter = createPasskeyRouter({ store: state, auth, passkeys: createPasskeyService({ store: state }), identity });
  routers.createPeopleRouter = createPeopleRouter({ state, auth });
  routers.createOperationsRouter = createOperationsRouter({ state, helper, jobs, prerequisites, recoveryKit, actionCenter, auth });
  routers.createJobsRouter = createJobsRouter({ state, jobs, scheduler, flows, autoReconnect: createAutoReconnect({ store: state, flows }), helper, jobLogReader: { read: async (_id, offset) => ({ text: "", offset, exists: false }) }, auth, streamBudget: createStreamBudget({ perAccount: 1_000, total: 1_000 }) });
  routers.createVirtualizationRouter = createVirtualizationRouter({
    libvirt, libvirtFoundation: { inspect: async () => ({ connectionReady: true }) }, vmPlanner: { getOptions: async () => ({}) }, vmMedia: { inspect: async () => ({ media: [] }) }, vmCreation: { preview: async () => ({ ok: false, errors: [] }) },
    vmExports: createVmExportService({ store: state, libvirt, helper }), vmProtection: createVmProtectionService({ store: state, helper }), vmRetention: createVmRetentionService({ store: state, helper }), vmRecoveries: createVmRecoveryService({ store: state, helper }), audit,
  });
  routers.createSettingsRouter = createSettingsRouter({ state, notifications, weeklyReport, auth });
  routers.createFirewallRouter = createFirewallRouter({ state, helper, catalogService, webPort: 8787, webHost: "127.0.0.1", listeners: async () => [] });
  routers.createStorageRouter = createStorageRouter({
    auth, helper, inventory, state,
    run: async () => ({ ok: true, stdout: "[]", stderr: "" }), probe: async () => false, reverse: async () => [],
    collect: async () => ({ devices: [], mounts: [], fstab: [], snapshots: [{ path: "/dev/vg0/data-snap", name: "data-snap" }] }),
  });
  routers.createPowerRouter = createPowerRouter({ detect: async () => [], exists: async () => false });
  routers.createChecklistRouter = createChecklistRouter({ state, helper, notifications, inventory, network, driveChecks: async () => null });
  routers.createHostRouter = createHostRouter({
    state, helper, catalogService, inventory, network, notifications,
    dnsResilience: { check: async () => ({ state: "unknown", status: "unknown", headline: "Not known what your router hands out", detail: "", source: "none", servers: [] }) },
    controllerProtection: createControllerProtectionService({ store: state, helper }), controllerRetention: createControllerRetentionService({ store: state, helper }),
    githubProvenance: { inspect: async () => ({ repositories: [] }) }, releaseUpdates: { inspect: async () => ({ current: "0.0.0" }) },
    setup: createSetupService({ helper, scheduler }), supportBundle, audit, auth, identity, tlsDir,
    collect: async () => ({ devices: [], mounts: [], fstab: [] }),
  });
  routers.createOidcAdminRouter = createOidcAdminRouter({ oidc, auth });
  const runbook = createRunbookService({
    store: state, helper, catalogService, inventory, network, notifications, identity, tlsDir,
    collect: async () => ({ availability: { devices: true, mounts: true, fstab: true }, devices: [], mounts: [], fstab: [], shares: [] }),
  });
  routers.createRunbookRouter = createRunbookRouter({ runbook, auth });
  // Mounted at the site root in index.mjs; built here only so its routes can be accounted for.
  routers.createOidcRouter = createOidcRouter({ oidc, auth, store: state });
  fakeModel = await startFakeOllama({
    models: ["hermes3:8b"],
    answer: 'Refresh package lists failed [S1].\n\n```plan\n[{"operationId": "apt.refresh", "parameters": {}, "why": "Try it again."}]\n```',
  });
  state.setSetting("assistant", { endpoint: fakeModel.url, model: null, embedModel: null });
  const assistant = createAssistantService({ state, registry, catalog: catalogService, helper, inventory, redactor: createRedactor() });
  routers.createAssistantRouter = createAssistantRouter({ assistant, state, auth });
  // Agents (M37), with the runner's key issued the way turning Agents on issues it.
  agentStore = createAgentStore({ databasePath: state.databasePath });
  // A machine of 16 processors on 8 cores, whatever runs the test: agents may use at most processors less two (M40).
  agents = createAgentService({ state, store: agentStore, registry, helper, inventory, redactor: createRedactor(), tokenPath: path.join(directory, "agents", "runner.token"), hostLoad: () => 0, processors: 16, physicalCoreCount: 8 });
  routers.createAgentsRouter = createAgentsRouter({ agents, state, auth });
  routers.createAgentRunnerRouter = createAgentRunnerRouter({ agents });
  // Push approvals (M25.2), with a VAPID key made here rather than read from the state directory.
  const vapid = vapidKeysFrom(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
  pushApprovals = createPushApprovals({ store: state, loadVapid: () => vapid });
  routers.createPushRouter = createPushRouter({ push: pushApprovals, auth });

  const app = express();
  app.use(securityHeaders({}));
  app.use(express.json({ limit: "256kb", strict: true }));
  app.use("/api/v1", routers.createAgentRunnerRouter);
  app.use("/api/v1", routers.createIdentityRouter);
  app.use("/api/v1", routers.createPasskeyRouter);
  app.get("/api/v1/auth/status", auth.status);
  app.post("/api/v1/auth/login", auth.login);
  app.get("/api/v1/auth/sessions", auth.requireSession, auth.listSessions);
  app.use("/api/v1", auth.requireSession);
  app.use("/api/v1", (request, response, next) => (["GET", "HEAD", "OPTIONS"].includes(request.method) ? next() : auth.requireCsrf(request, response, next)));
  app.use("/api/v1", apiRolePolicy());
  app.use("/api/v1/people", auth.requireRole("owner"));
  for (const name of ["createPeopleRouter", "createOperationsRouter", "createJobsRouter", "createVirtualizationRouter", "createSettingsRouter", "createFirewallRouter", "createStorageRouter", "createPowerRouter", "createChecklistRouter", "createHostRouter", "createOidcAdminRouter", "createRunbookRouter", "createAssistantRouter", "createAgentsRouter", "createPushRouter"]) {
    app.use("/api/v1", routers[name]);
  }
  app.use((_request, response) => { response.status(404).json({ error: "Not found" }); });
  app.use((error, _request, response, _next) => {
    if (response.headersSent) { response.destroy(); return; }
    response.status(500).json({ error: `Something went wrong: ${error?.message ?? error}`, code: "internal_error" });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  // ---- the owner's and the operator's work, on record everywhere a composite route reads ----

  const { owner, operator } = accounts;
  fixtures.ownerJob = state.createJob({ type: "op:apt.refresh", title: "Refresh package lists owner-marker", parameters: { note: "owner-marker-parameter" }, createdBy: owner.id });
  state.transitionJob(fixtures.ownerJob.id, "awaiting_approval", "failed", { error: "owner-marker failure" });
  state.saveJobOutput(fixtures.ownerJob.id, "owner-marker output\n");
  fixtures.operatorJob = state.createJob({ type: "op:apt.refresh", title: "Refresh package lists operator-marker", parameters: { note: "operator-marker-parameter" }, createdBy: operator.id });
  state.transitionJob(fixtures.operatorJob.id, "awaiting_approval", "cancelled", { error: "operator-marker withdrawn" });

  const ownerSchedule = state.createSchedule({ operationId: "apt.refresh", parameters: { note: "owner-marker-schedule" }, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id, nextDueAt: new Date(Date.now() + day).toISOString() });
  const operatorSchedule = state.createSchedule({ operationId: "apt.refresh", parameters: { note: "operator-marker-schedule" }, frequency: "daily", minute: 0, hour: 4, createdBy: operator.id, nextDueAt: new Date(Date.now() + day).toISOString() });

  // A push to a topic whose path is the password (ntfy), and an owner-only step: both the owner's to read (sweep 1).
  fixtures.ownerFlow = state.createFlow({ name: "Nightly", steps: [{ operationId: "apt.refresh", parameters: {} }, { operationId: "http.request", parameters: { url: "https://ntfy.example/owner-marker-topic", method: "POST", body: "owner-marker body", credentialName: "ntfy-token" } }, { operationId: "credentials.remove", parameters: { name: "ntfy-old" } }], createdBy: owner.id });
  state.markFlowRun(fixtures.ownerFlow.id, { result: "stopped at step 1 (Refresh package lists): owner-marker failure", jobIds: [fixtures.ownerJob.id] });
  fixtures.operatorFlow = state.createFlow({ name: "Tidy", steps: [{ operationId: "apt.refresh", parameters: {} }], createdBy: operator.id });
  state.markFlowRun(fixtures.operatorFlow.id, { result: "completed", jobIds: [fixtures.operatorJob.id] });

  const controllerBackup = (id) => state.recordBackup({ id, applicationId: "boxpilot-controller", destination: "local-managed", artifactPath: `/var/lib/boxpilot-managed/backups/boxpilot-controller/${id}/boxpilot.sqlite3`, checksumSha256: "a".repeat(64), sizeBytes: 8192, downtimeMs: 0, restoreDrill: { passed: true, mode: "isolated-copy-open" }, createdBy: owner.id });
  const protect = (backupId, snapshotId) => state.recordControllerBackupProtection({ id: randomUUID(), backupId, destination: "mounted-restic-controller", repositoryId: "c".repeat(64), snapshotId, sizeBytes: 8192, encrypted: true, independent: true, repositoryVerified: true, protected: true, restoreDrill: { passed: true }, createdBy: owner.id });
  const first = controllerBackup(randomUUID());
  const second = controllerBackup(randomUUID());
  const forgotten = protect(first.id, "1".repeat(64));
  protect(second.id, "2".repeat(64));
  state.recordControllerRetention({ id: randomUUID(), repositoryId: "c".repeat(64), beforeSnapshotSetRevision: "e".repeat(64), afterSnapshotSetRevision: "f".repeat(64), beforeCount: 2, afterCount: 1, forgotten: [{ protectionId: forgotten.id, backupId: first.id, snapshotId: forgotten.snapshotId }], keptSnapshotIds: ["2".repeat(64)], repositoryVerified: true, complete: true, prunePerformed: false, createdBy: owner.id });

  const domainUuid = randomUUID();
  const vmExport = state.recordVmExport({ id: randomUUID(), domainName: "lab", domainUuid, destination: "local-managed", artifactPath: "/var/lib/boxpilot-managed/vm-exports/lab", manifestChecksumSha256: "a".repeat(64), sizeBytes: 8192, protected: false, encrypted: false, restoreDrill: { passed: false }, createdBy: owner.id });
  const vmBackup = (snapshotId) => state.recordVmBackup({ id: randomUUID(), exportId: vmExport.id, domainName: "lab", domainUuid, destination: "mounted-restic", repositoryId: "b".repeat(64), snapshotId, sizeBytes: 8192, encrypted: true, independent: true, repositoryVerified: true, protected: false, restoreDrill: { passed: false }, createdBy: owner.id });
  const recovered = vmBackup("3".repeat(64));
  const retired = vmBackup("4".repeat(64));
  vmBackup("5".repeat(64));
  state.recordVmRecovery({ id: randomUUID(), backupId: recovered.id, sourceDomainName: "lab", sourceDomainUuid: domainUuid, domainName: "lab-recovered", domainUuid: randomUUID(), destination: "managed-libvirt-recovery", sizeBytes: 4096, state: "stopped", network: "none", autostart: false, createdBy: owner.id });
  state.recordVmRetention({ id: randomUUID(), repositoryId: "b".repeat(64), beforeSnapshotSetRevision: "d".repeat(64), afterSnapshotSetRevision: "e".repeat(64), beforeCount: 3, afterCount: 2, forgotten: [{ backupId: retired.id, snapshotId: retired.snapshotId, domainName: "lab" }], keptSnapshotIds: ["3".repeat(64), "5".repeat(64)], repositoryVerified: true, prunePerformed: false, createdBy: owner.id });

  const checkedAt = new Date(Date.now() - day).toISOString();
  state.setSetting("appBackupVerifications", foldVerdict({}, "jellyfin", verdictFrom({ verified: true, backup: "jellyfin-backup.tar.zst", checkedAt }, owner.id)));
  state.setSetting("killSwitchDrills", { jellyfin: { held: true, leaked: false, downForMs: 1200, exitAfter: null, at: checkedAt, by: owner.id } });
  state.setSetting("lvmSnapshots", [{ path: "/dev/vg0/data-snap", name: "data-snap", origin: "data", volumeGroup: "vg0", sizeGiB: 5, createdAt: checkedAt, createdBy: owner.id, suffix: "snap" }]);
  state.setSetting("firewallProfile", { id: "home-server", services: [], sshRateLimit: false, appliedAt: checkedAt, appliedBy: owner.id });
  state.setSetting("backupDestination", { host: "backup.example", port: 22, user: "mirror", path: "/srv/boxpilot" });
  state.setSetting("diskUsageHistory", { "/srv": [0, 1, 2, 3].map((index) => ({ at: new Date(Date.now() - (4 - index) * day).toISOString(), availableBytes: 400e9 - index * 50e9, totalBytes: 1e12 })) });
  state.setSetting("appDataUsageHistory", { "jellyfin:/srv/media": [2, 1].map((ago, index) => ({ appId: "jellyfin", path: "/srv/media", mount: "/srv", bytes: (index + 1) * 1e9, at: new Date(Date.now() - ago * day).toISOString() })) });
  state.setSetting("appDataUsageLastRun", { at: checkedAt, sampled: 1, unmeasured: 0, error: null });
  state.setSetting("healthAlertsState", {
    "system.reboot": { title: "A reboot is required", since: checkedAt, notified: true },
    [`schedule.failed:${ownerSchedule.id}`]: { title: "Scheduled task failed: owner-marker", since: checkedAt, notified: false },
    [`schedule.failed:${operatorSchedule.id}`]: { title: "Scheduled task failed: operator-marker", since: checkedAt, notified: false },
    "record.failed:apt.refresh": { title: "Result not saved: Refresh package lists (owner-marker)", since: checkedAt, notified: false },
    "job.interrupted:apt.refresh:owner-marker": { title: "Refresh package lists (owner-marker) was interrupted", since: checkedAt, notified: false },
    [`signin.new:${owner.id}:192.0.2.10`]: { title: "New sign-in from 192.0.2.10 (owner-marker)", since: checkedAt, notified: false },
    [`signin.new:${operator.id}:192.0.2.11`]: { title: "New sign-in from 192.0.2.11 (operator-marker)", since: checkedAt, notified: false },
  });
  state.setSetting("notificationHistory", [
    { id: "n1", key: "job.interrupted:apt.refresh:owner-marker", kind: "notice", title: "Refresh package lists (owner-marker) was interrupted", message: "owner-marker detail", at: new Date(Date.now() - 4 * 60_000).toISOString(), delivered: false, reason: "no-target" },
    { id: "n2", key: `schedule.failed:${ownerSchedule.id}`, kind: "alert", title: "Scheduled task failed: owner-marker", message: "owner-marker detail", at: new Date(Date.now() - 3 * 60_000).toISOString(), delivered: false, reason: "no-target" },
    { id: "n3", key: `job.failed:${fixtures.ownerJob.id}`, kind: "job", title: "Refresh package lists (owner-marker) failed", message: "owner-marker error", at: new Date(Date.now() - 2 * 60_000).toISOString(), delivered: true, deliveredAt: checkedAt },
    { id: "n4", key: `job.failed:${fixtures.operatorJob.id}`, kind: "job", title: "Refresh package lists (operator-marker) failed", message: "operator-marker error", at: new Date(Date.now() - 60_000).toISOString(), delivered: true, deliveredAt: checkedAt },
  ]);
  await audit.record("vm.plan.created", { actorId: owner.id, domain: "owner-marker-vm" });
  await audit.record("vm.plan.created", { actorId: operator.id, domain: "operator-marker-vm" });

  // Agents (M37): the owner's Server Keeper (not borrowable) with a run, a card and a note that
  // carry the owner's marker, and the IT helper (anyone may ask it) with the operator's question.
  const ownerCaller = { id: owner.id, role: "owner" };
  const operatorCaller = { id: operator.id, role: "operator" };
  agents.saveModule(ownerCaller, { enabled: true });
  await agents.ensureRunnerToken();
  runnerToken = (await readFile(path.join(directory, "agents", "runner.token"), "utf8")).trim();
  fixtures.keeper = agents.createAgent(ownerCaller, { template: "server-keeper" });
  fixtures.helper = agents.createAgent(ownerCaller, { template: "it-support" });
  const runnerId = randomUUID();
  agents.startRun(ownerCaller, fixtures.keeper.id, { kind: "ask", question: "owner-marker question" });
  const ownerClaim = await agents.runnerNext(runnerId, { waitMs: 0 });
  await agents.runnerTool(ownerClaim.run.id, ownerClaim.lease, "notes_write", JSON.stringify({ title: "Owner note", body: "owner-marker note" }));
  await agents.runnerTool(ownerClaim.run.id, ownerClaim.lease, "plan_propose", JSON.stringify({ title: "Refresh owner-marker", reason: "owner-marker reason", steps: [{ operationId: "apt.refresh", parameters: {} }] }));
  await agents.runnerFinish(ownerClaim.run.id, ownerClaim.lease, { outcome: "completed", answer: "owner-marker answer" });
  fixtures.ownerRun = ownerClaim.run.id;
  agents.startRun(operatorCaller, fixtures.helper.id, { kind: "ask", question: "operator-marker question" });
  const operatorClaim = await agents.runnerNext(runnerId, { waitMs: 0 });
  await agents.runnerFinish(operatorClaim.run.id, operatorClaim.lease, { outcome: "completed", answer: "operator-marker answer" });
  fixtures.operatorRun = operatorClaim.run.id;

  // The owner's phone, with pushes on (M25.2); nobody else's devices, and no endpoint, may be shown.
  const p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
  pushApprovals.subscribe({ id: owner.id, role: "owner" }, { subscription: { endpoint: "https://web.push.apple.com/owner-marker-endpoint", keys: { p256dh, auth: Buffer.alloc(16, 1).toString("base64url") } }, origin: "https://homebox.example.ts.net", label: "owner-marker phone" });

  for (const role of roles) sessions[role] = await signIn(role);
});

afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await fakeModel?.close();
  agentStore?.close();
  state.close();
  await rm(directory, { recursive: true, force: true });
});

// ---- the tests ----

describe("every route is accounted for", () => {
  it("classifies every route index.mjs mounts, and nothing that is not mounted", async () => {
    const index = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.mjs"), "utf8");
    const factories = new Set([...index.matchAll(/(create\w+Router)\(/g)].map((match) => match[1]));
    // A router mounted in index.mjs and not here is a set of routes nobody has classified.
    expect([...factories].sort()).toEqual(Object.keys(routers).sort());
    const inline = [...index.matchAll(/app\.(get|post|put|delete|patch|options|all)\("([^"]+)"/g)].map((match) => `${match[1].toUpperCase()} ${match[2]}`);
    // A route may be declared for several paths at once (the OIDC preflight is), and `all` answers every method.
    const mounted = Object.entries(routers).flatMap(([name, router]) => router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => [layer.route.path].flat().flatMap((routePath) => Object.keys(layer.route.methods)
        .map((method) => `${method === "_all" ? "ALL" : method.toUpperCase()} ${name === "createOidcRouter" ? "" : "/api/v1"}${routePath}`))));
    const routes = [...new Set([...inline, ...mounted])].sort();
    const classified = [...publicRoutes, ...selfRoutes, ...directRoutes, ...changeRoutes, ...questionRoutes, ...agentAskRoutes, ...agentOwnRoutes, ...runnerRoutes, ...Object.keys(dataRoutes)];
    expect(new Set(classified).size, "a route is in two tables").toBe(classified.length);
    const unclassified = routes.filter((route) => !classified.includes(route));
    expect(unclassified, "routes with no entry in route-matrix.test.mjs").toEqual([]);
    expect(classified.filter((route) => !routes.includes(route)), "entries for routes that no longer exist").toEqual([]);
    // Only reads are in the data table; everything that changes something is refused to viewers below.
    expect(Object.keys(dataRoutes).filter((route) => !route.startsWith("GET "))).toEqual([]);
  });
});

describe("every data route, for every role, as written, in upper case and with a trailing slash", () => {
  for (const [route, cases] of Object.entries(dataRoutes)) {
    for (const [index, entry] of cases.entries()) {
      it(`${route}${cases.length > 1 ? ` (case ${index + 1})` : ""}`, async () => {
        const [method, template] = route.split(" ");
        for (const role of roles) {
          for (const variant of variantsOf(template, entry.params?.() ?? {}, entry.query ?? "")) {
            const where = `${role}, ${variant.name}: ${method} ${variant.url}`;
            const result = await call(method, variant.url, sessions[role]);
            expect(result.status, where).toBe(entry[role]);
            expect(result.headers.get("cache-control"), where).toBe("no-store");
            const text = result.text.toLowerCase();
            for (const needle of foreign[role]()) expect(text.includes(String(needle).toLowerCase()), `${where} shows ${needle}`).toBe(false);
            if (entry.check && result.status === 200) entry.check({ role, ...result });
          }
        }
      });
    }
  }
});

describe("changes", () => {
  it("refuses every change to a viewer, and settings, people and sign-in clients to an operator, whatever the casing", async () => {
    for (const route of changeRoutes) {
      const [method, template] = route.split(" ");
      for (const variant of variantsOf(template)) {
        expect((await call(method, variant.url, sessions.viewer, { body: {} })).status, `viewer ${method} ${variant.url}`).toBe(403);
        if (ownerOnlyChange.test(template)) expect((await call(method, variant.url, sessions.operator, { body: {} })).status, `operator ${method} ${variant.url}`).toBe(403);
      }
    }
  });

  it("lets every role ask the assistant, which only reads", async () => {
    for (const route of questionRoutes) {
      const [method, template] = route.split(" ");
      for (const variant of variantsOf(template)) {
        for (const role of roles) expect((await call(method, variant.url, sessions[role], { body: { question: "Is everything all right?" } })).status, `${role} ${method} ${variant.url}`).toBe(200);
      }
    }
  });

  it("leaves a direct read to the registry, whatever the casing", async () => {
    const run = (id) => variantsOf("/api/v1/operations/:id/run", { id });
    for (const variant of run("samba.inspect")) {
      expect((await call("POST", variant.url, sessions.viewer, { body: { parameters: {} } })).status, variant.url).toBe(403);
      expect((await call("POST", variant.url, sessions.operator, { body: { parameters: {} } })).status, variant.url).toBe(200);
    }
    // A read open to viewers stays open at every spelling of its path, trailing slash included.
    for (const variant of run("app.inspect")) expect((await call("POST", variant.url, sessions.viewer, { body: { parameters: {} } })).status, variant.url).toBe(200);
    for (const variant of variantsOf("/api/v1/operations/:id/jobs", { id: "apt.refresh" })) {
      expect((await call("POST", variant.url, sessions.viewer, { body: { parameters: {} } })).status, variant.url).toBe(403);
    }
  });
});

describe("the assistant, for every role, as written, in upper case and with a trailing slash", () => {
  const question = { question: "Why did Refresh package lists fail, and what should I do?", context: { appId: "jellyfin" } };

  it("builds each role's answer only from what that role may read, and plans only for a role that could approve", async () => {
    for (const role of roles) {
      for (const variant of variantsOf("/api/v1/assistant/ask")) {
        const where = `${role}, ${variant.name}`;
        fakeModel.reset();
        const result = await call("POST", variant.url, sessions[role], { body: question });
        expect(result.status, where).toBe(200);
        expect(result.headers.get("cache-control"), where).toBe("no-store");
        // The model's context is checked as a response body is: another account's ids, jobs and
        // what they carried are in neither.
        expect(fakeModel.prompts(), where).toHaveLength(1);
        const prompt = JSON.stringify(fakeModel.prompts()).toLowerCase();
        const text = result.text.toLowerCase();
        for (const needle of foreign[role]()) {
          expect(prompt.includes(String(needle).toLowerCase()), `${where}: the model was shown ${needle}`).toBe(false);
          expect(text.includes(String(needle).toLowerCase()), `${where}: the answer shows ${needle}`).toBe(false);
        }
        // What the role may read still arrives: the owner's failed job, the operator's own
        // schedule by name, and for a viewer the kind of thing that failed.
        expect(prompt, where).toContain({ owner: "owner-marker failure", operator: "scheduled task failed: operator-marker", viewer: "a scheduled task failed or did not run" }[role]);
        // An app's container log is an operator read (ADR-003), not run for a viewer.
        expect(result.calls.includes("app.logs"), where).toBe(role !== "viewer");
        expect(result.body.plan === null, where).toBe(role === "viewer");
        if (role !== "viewer") expect(result.body.plan.steps.map((step) => step.operationId), where).toEqual(["apt.refresh"]);
        expect(result.body.sources.length, where).toBeGreaterThan(0);
      }
    }
  });

  it("answers about a job only for someone who may open it", async () => {
    const ask = (role, jobId) => call("POST", "/api/v1/assistant/ask", sessions[role], { body: { question: "What happened to this job?", context: { jobId } } });
    for (const [role, job] of [["viewer", "ownerJob"], ["operator", "ownerJob"], ["viewer", "operatorJob"]]) {
      fakeModel.reset();
      const result = await ask(role, fixtures[job].id);
      expect(result.status, `${role} asking about the ${job}`).toBe(404);
      expect(fakeModel.prompts(), `${role} asking about the ${job}`).toEqual([]);
    }
    const own = await ask("operator", fixtures.operatorJob.id);
    expect(own.status).toBe(200);
    expect(own.body.sources[0]).toMatchObject({ kind: "job", ref: { jobId: fixtures.operatorJob.id } });
    expect((await ask("owner", fixtures.operatorJob.id)).status).toBe(200);
  });

  it("streams sources, then the answer, then the result, to a viewer as to anyone", async () => {
    const response = await fetch(`${base}/api/v1/assistant/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", Cookie: sessions.viewer.cookie, "X-BoxPilot-CSRF": sessions.viewer.csrfToken },
      body: JSON.stringify({ question: "How do I restore a backup?" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = [...(await response.text()).matchAll(/event: (\w+)\ndata: ([^\n]*)\n\n/g)].map((match) => [match[1], JSON.parse(match[2])]);
    expect(events[0][0]).toBe("sources");
    expect(events.some(([event]) => event === "delta")).toBe(true);
    expect(events.at(-1)[0]).toBe("done");
    expect(events.at(-1)[1]).toMatchObject({ plan: null, model: "hermes3:8b", degraded: null });
    expect(events.at(-1)[1].answer).not.toContain("```");
  });
});

describe("the agents runner's own door (M37)", () => {
  const runnerId = randomUUID();
  const post = (url, { token = null, session = null, headers = {} } = {}) => fetch(`${base}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(session ? { Cookie: session.cookie, "X-BoxPilot-CSRF": session.csrfToken } : {}), ...headers },
    body: JSON.stringify({ runnerId, waitMs: 0 }),
  });

  it("refuses anyone without its key - a person's session included - and its key through a proxy", async () => {
    for (const route of runnerRoutes) {
      const [, template] = route.split(" ");
      for (const variant of variantsOf(template, { runId: fixtures.ownerRun })) {
        expect((await post(variant.url)).status, `no key ${variant.url}`).toBe(401);
        expect((await post(variant.url, { session: sessions.owner })).status, `the owner's session ${variant.url}`).toBe(401);
        expect((await post(variant.url, { token: "x".repeat(43) })).status, `a wrong key ${variant.url}`).toBe(401);
        expect((await post(variant.url, { token: runnerToken, headers: { "X-Forwarded-For": "100.64.0.9" } })).status, `through a proxy ${variant.url}`).toBe(401);
      }
    }
  });

  it("opens with its key: it says hello, waits for work, reports usage, and cannot touch a run it does not hold", async () => {
    expect((await post("/api/v1/agent-runner/hello", { token: runnerToken })).status).toBe(200);
    const next = await post("/api/v1/agent-runner/next", { token: runnerToken });
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ claim: null, enabled: true, paused: false });
    expect((await post("/api/v1/agent-runner/usage", { token: runnerToken })).status).toBe(200);
    for (const action of ["tools", "steps", "finish"]) expect((await post(`/api/v1/agent-runner/runs/${fixtures.ownerRun}/${action}`, { token: runnerToken })).status, action).toBe(409);
  });

  it("opens nothing else: every other route treats its key as no one", async () => {
    const withKey = (method, url) => fetch(`${base}${url}`, { method, headers: { Authorization: `Bearer ${runnerToken}`, "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
    for (const route of [...Object.keys(dataRoutes), ...changeRoutes, ...directRoutes, ...questionRoutes, ...agentAskRoutes, ...agentOwnRoutes, ...selfRoutes]) {
      const [method, template] = route.split(" ");
      const response = await withKey(method, variantsOf(template, { id: fixtures.helper.id, runId: fixtures.ownerRun })[0].url);
      expect(response.status, route).toBe(401);
      await response.body?.cancel();
    }
  });
});

describe("asking an agent (M37), for every role, as written, in upper case and with a trailing slash", () => {
  it("takes a question from anyone the agent may be borrowed by, and from nobody else", async () => {
    for (const role of roles) {
      const caller = { id: accounts[role].id, role };
      for (const variant of variantsOf("/api/v1/agents/:id/ask", { id: fixtures.helper.id })) {
        const result = await call("POST", variant.url, sessions[role], { body: { question: `${role} asks the helper` } });
        expect(result.status, `${role} ${variant.url}`).toBe(202);
        agents.cancelRun(caller, result.body.id);
      }
      for (const variant of variantsOf("/api/v1/agents/:id/ask", { id: fixtures.keeper.id })) {
        const result = await call("POST", variant.url, sessions[role], { body: { question: `${role} asks the keeper` } });
        expect(result.status, `${role} ${variant.url}`).toBe(role === "viewer" ? 404 : 202);
        if (result.status === 202) agents.cancelRun(caller, result.body.id);
      }
    }
  });

  it("lets a person say whether their own answer was right and forget their own conversation, and nothing of anyone else's", async () => {
    for (const variant of variantsOf("/api/v1/agents/runs/:runId/feedback", { runId: fixtures.operatorRun })) {
      expect((await call("POST", variant.url, sessions.viewer, { body: { verdict: "up" } })).status, `viewer ${variant.url}`).toBe(404);
      expect((await call("POST", variant.url, sessions.operator, { body: { verdict: "up" } })).status, `operator ${variant.url}`).toBe(200);
      expect((await call("POST", variant.url, sessions.owner, { body: { verdict: "down" } })).status, `owner ${variant.url}`).toBe(200);
    }
    for (const variant of variantsOf("/api/v1/agents/runs/:runId/feedback", { runId: fixtures.ownerRun })) {
      for (const role of ["viewer", "operator"]) expect((await call("POST", variant.url, sessions[role], { body: { verdict: "up" } })).status, `${role} ${variant.url}`).toBe(404);
    }
    // Forgetting is of the caller's own conversation only: the operator asked the helper, so has one
    // to forget, once; the viewer and the owner never talked to it, so have nothing to forget.
    const statuses = { viewer: [], operator: [], owner: [] };
    for (const variant of variantsOf("/api/v1/agents/:id/memory/thread", { id: fixtures.helper.id })) {
      for (const role of roles) statuses[role].push((await call("DELETE", variant.url, sessions[role])).status);
    }
    expect(statuses.operator[0]).toBe(200);
    expect([...statuses.viewer, ...statuses.operator.slice(1), ...statuses.owner].every((status) => status === 404)).toBe(true);
    for (const variant of variantsOf("/api/v1/agents/:id/memory/thread", { id: fixtures.keeper.id })) {
      expect((await call("DELETE", variant.url, sessions.viewer)).status, `viewer ${variant.url}`).toBe(404);
    }
  });
});
