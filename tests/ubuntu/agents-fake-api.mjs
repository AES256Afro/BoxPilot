#!/usr/bin/env node
/**
 * A stand-in for BoxPilot's web service, for tests/ubuntu/agents-caps.sh (M37): it answers the
 * agents runner's routes (/api/v1/agent-runner/...) with the runner's key, hands out one run when
 * told to, and says what happened on /control/state. The run asks for the fake model, which the
 * runner's unit is told to make busy (BOXPILOT_AGENTS_FAKE_BUSY_*), so the test can watch the
 * runner's cgroup under load and then idle.
 *
 *   node tests/ubuntu/agents-fake-api.mjs <port> <token>
 *   POST /control/start   arm one run for the runner's next poll
 *   GET  /control/state   { hello, polls, claimed, heartbeats, finished, outcome, usage }
 */
import http from "node:http";

const [port = "18787", token = ""] = process.argv.slice(2);
const state = { hello: false, polls: 0, armed: false, claimed: false, heartbeats: 0, finished: false, outcome: null, usage: null, refused: 0 };
const runId = "11111111-2222-4333-8444-555555555555";
const lease = "lease-for-the-cap-test-0123456789";

function claim() {
  const now = new Date();
  return {
    run: { id: runId, kind: "manual", question: "Work hard for a while", trigger: {}, readRole: "owner", startedAt: now.toISOString(), deadlineAt: new Date(now.getTime() + 600_000).toISOString() },
    lease,
    agent: { id: "agent", name: "Cap test", version: 1, outputs: {} },
    messages: [{ role: "system", content: "You are a test." }, { role: "user", content: "Work hard for a while." }],
    tools: [],
    runtime: { driver: "fake", model: null, contextTokens: 2048, threads: 4, idleStopMs: 5_000, maxTokens: 64, temperature: 0.2, extra: {} },
    limits: { steps: 1, tokens: 4_000, runSeconds: 600, remainingModelMs: 600_000, toolCallsPerStep: 3, maxToolCalls: 3, heartbeatMs: 5_000 },
  };
}

const json = (response, status, value) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };

const server = http.createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  const path = request.url.split("?")[0];
  if (path === "/control/state") return json(response, 200, state);
  // Each start arms one more run (the M40 section asks for a second, while someone waits).
  if (path === "/control/start") { Object.assign(state, { armed: true, claimed: false, finished: false, outcome: null }); return json(response, 200, { armed: true }); }
  if (!path.startsWith("/api/v1/agent-runner/")) return json(response, 404, { error: "not found" });
  if (request.headers.authorization !== `Bearer ${token}`) { state.refused += 1; return json(response, 401, { error: "wrong key" }); }
  if (body.usage) state.usage = body.usage;
  if (path.endsWith("/hello")) { state.hello = true; return json(response, 200, { interrupted: 0 }); }
  if (path.endsWith("/next")) {
    state.polls += 1;
    if (state.armed && !state.claimed) { state.claimed = true; return json(response, 200, { claim: claim(), stopModel: false, enabled: true, paused: false }); }
    // A long poll, as BoxPilot holds it, so an idle runner makes one request every few seconds.
    await new Promise((resolve) => setTimeout(resolve, Math.min(Number(body.waitMs) || 0, 10_000)));
    return json(response, 200, { claim: null, stopModel: false, enabled: true, paused: false });
  }
  if (path.endsWith("/heartbeat")) { state.heartbeats += 1; return json(response, 200, { continue: true }); }
  if (path.endsWith("/steps")) return json(response, 200, { saved: 1 });
  if (path.endsWith("/tools")) return json(response, 200, { ok: false, index: null, title: "none", content: "<tool_output>no tools here</tool_output>", flags: {} });
  if (path.endsWith("/finish")) { state.finished = true; state.outcome = body.outcome ?? null; return json(response, 200, { state: body.outcome }); }
  if (path.endsWith("/usage")) return json(response, 200, { stopModel: false });
  return json(response, 404, { error: "not found" });
});
server.listen(Number(port), "127.0.0.1", () => process.stdout.write(`fake BoxPilot API on 127.0.0.1:${port}\n`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
