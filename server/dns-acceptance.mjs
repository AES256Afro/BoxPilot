import { randomInt, randomUUID } from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";

const acceptanceChecks = Object.freeze([
  { id: "local-udp", protocol: "udp", name: "pi.hole", expectedRcode: 0, requireAnswers: true },
  { id: "local-tcp", protocol: "tcp", name: "pi.hole", expectedRcode: 0, requireAnswers: true },
  { id: "upstream-udp", protocol: "udp", name: "example.com", expectedRcode: 0, requireAnswers: true },
  { id: "negative-udp", protocol: "udp", name: "boxpilot.invalid", expectedRcode: 3, requireAnswers: false },
]);

const flint2AdguardChecks = Object.freeze([
  { id: "gateway-public-udp", protocol: "udp", name: "example.com", expectedRcode: 0, requireAnswers: true },
  { id: "gateway-public-tcp", protocol: "tcp", name: "example.com", expectedRcode: 0, requireAnswers: true },
  { id: "gateway-second-public-udp", protocol: "udp", name: "example.net", expectedRcode: 0, requireAnswers: true },
  { id: "gateway-negative-udp", protocol: "udp", name: "boxpilot.invalid", expectedRcode: 3, requireAnswers: false },
]);

function encodeDnsName(name) {
  const labels = name.split(".");
  if (!labels.length || labels.some((label) => !/^[a-z0-9-]{1,63}$/i.test(label))) throw new Error("DNS acceptance uses only fixed valid names");
  return Buffer.concat([...labels.map((label) => {
    const value = Buffer.from(label, "ascii");
    return Buffer.concat([Buffer.from([value.length]), value]);
  }), Buffer.from([0])]);
}

function buildDnsQuery(name, id) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(1, 0);
  question.writeUInt16BE(1, 2);
  return Buffer.concat([header, encodeDnsName(name), question]);
}

function parseDnsResponse(packet, expectedId) {
  if (!Buffer.isBuffer(packet) || packet.length < 12) throw new Error("DNS response was truncated");
  const id = packet.readUInt16BE(0);
  const flags = packet.readUInt16BE(2);
  if (id !== expectedId) throw new Error("DNS response transaction id did not match");
  if ((flags & 0x8000) === 0) throw new Error("DNS packet was not a response");
  if ((flags & 0x7800) !== 0) throw new Error("DNS response used an unexpected opcode");
  return {
    rcode: flags & 0x000f,
    truncated: (flags & 0x0200) !== 0,
    recursionAvailable: (flags & 0x0080) !== 0,
    questions: packet.readUInt16BE(4),
    answers: packet.readUInt16BE(6),
  };
}

function udpExchange(server, packet, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(net.isIP(server) === 6 ? "udp6" : "udp4");
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Preserve the original timeout or socket error if the datagram socket never bound.
      }
      if (error) reject(error);
      else resolve(response);
    };
    const timer = setTimeout(() => finish(new Error("UDP DNS query timed out")), timeoutMs);
    socket.once("error", (error) => finish(error));
    socket.once("message", (response) => finish(null, response));
    socket.connect(53, server, () => {
      socket.send(packet, (error) => {
        if (error) finish(error);
      });
    });
  });
}

function tcpExchange(server, packet, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: server, port: 53 });
    const length = Buffer.alloc(2);
    length.writeUInt16BE(packet.length, 0);
    let response = Buffer.alloc(0);
    let expectedLength = null;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("TCP DNS query timed out")));
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => socket.write(Buffer.concat([length, packet])));
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 65537) {
        finish(new Error("TCP DNS response exceeded the maximum message size"));
        return;
      }
      if (response.length >= 2 && expectedLength === null) {
        expectedLength = response.readUInt16BE(0);
        if (expectedLength < 12 || expectedLength > 65535) finish(new Error("TCP DNS response length was invalid"));
      }
      if (expectedLength !== null && response.length >= expectedLength + 2) finish(null, response.subarray(2, expectedLength + 2));
    });
    socket.once("end", () => {
      if (!settled) finish(new Error("TCP DNS response ended before the complete message"));
    });
  });
}

async function queryDns(server, check, { udp = udpExchange, tcp = tcpExchange, clock = () => Date.now() } = {}) {
  if (net.isIP(server) !== 4) throw new Error("DNS acceptance target must be an exact IPv4 address");
  if (![...acceptanceChecks, ...flint2AdguardChecks].some((candidate) => candidate.id === check.id
    && candidate.protocol === check.protocol
    && candidate.name === check.name
    && candidate.expectedRcode === check.expectedRcode
    && candidate.requireAnswers === check.requireAnswers)) throw new Error("DNS acceptance check is not allowlisted");
  const transactionId = randomInt(0, 65536);
  const packet = buildDnsQuery(check.name, transactionId);
  const startedAt = clock();
  const response = check.protocol === "tcp" ? await tcp(server, packet) : await udp(server, packet);
  const parsed = parseDnsResponse(response, transactionId);
  const passed = !parsed.truncated
    && parsed.questions === 1
    && parsed.rcode === check.expectedRcode
    && (!check.requireAnswers || parsed.answers > 0);
  return {
    id: check.id,
    protocol: check.protocol,
    name: check.name,
    type: "A",
    expectedRcode: check.expectedRcode,
    rcode: parsed.rcode,
    answers: parsed.answers,
    recursionAvailable: parsed.recursionAvailable,
    truncated: parsed.truncated,
    latencyMs: Math.max(0, clock() - startedAt),
    passed,
  };
}

function passingEvidenceMatches(result, expected) {
  return result?.id === expected.id
    && result?.protocol === expected.protocol
    && result?.name === expected.name
    && result?.type === "A"
    && result?.expectedRcode === expected.expectedRcode
    && result?.rcode === expected.expectedRcode
    && Number.isInteger(result?.answers)
    && result.answers >= 0
    && (!expected.requireAnswers || result.answers > 0)
    && typeof result?.recursionAvailable === "boolean"
    && result?.truncated === false
    && Number.isFinite(result?.latencyMs)
    && result.latencyMs >= 0
    && result?.passed === true;
}

export async function runDnsAcceptanceProbeSuite(server, dependencies = {}) {
  const results = [];
  for (const check of acceptanceChecks) results.push(await queryDns(server, check, dependencies));
  return results;
}

export async function runFlint2AdguardProbeSuite(server, dependencies = {}) {
  const results = [];
  for (const check of flint2AdguardChecks) results.push(await queryDns(server, check, dependencies));
  return results;
}

export function createDnsAcceptanceService({ store, helper, network, probeResolver = runDnsAcceptanceProbeSuite }) {
  async function inspectSource() {
    try {
      return await helper.request("application.pi-hole.inspect", {});
    } catch {
      return { installed: false, healthy: false, state: "unavailable", lanAddress: null, dnsTcpBound: false, dnsUdpBound: false, detail: "Pi-hole inventory is unavailable" };
    }
  }

  function latestDeploymentFor(source) {
    return store.listJobs(200).find((job) => job.type === "application.pi-hole.deploy"
      && job.state === "completed"
      && job.result?.installed === true
      && job.result?.healthy === true
      && job.result?.lanAddress === source.lanAddress
      && job.result?.dnsTcpBound === true
      && job.result?.dnsUdpBound === true) ?? null;
  }

  function latestBackup() {
    return store.listBackups(200).find((backup) => backup.applicationId === "pi-hole" && backup.restoreDrill?.passed === true) ?? null;
  }

  async function buildPlan(ownerId) {
    const source = await inspectSource();
    const deployment = latestDeploymentFor(source);
    const backup = latestBackup();
    const blockers = [];
    let assessment = null;
    let baseline = null;

    if (!source.installed) blockers.push({ id: "pi-hole-installed", summary: "Deploy the curated Pi-hole adapter before testing DNS" });
    else if (!source.healthy || !source.dnsTcpBound || !source.dnsUdpBound) blockers.push({ id: "pi-hole-health", summary: "Pi-hole must be healthy with exact TCP and UDP DNS bindings" });
    if (!deployment) blockers.push({ id: "pi-hole-deployment-evidence", summary: "A completed BoxPilot Pi-hole staging job matching the live address is required" });
    if (!backup) blockers.push({ id: "pi-hole-restore-evidence", summary: "Create a verified Pi-hole configuration backup and isolated restore drill first" });
    else if (deployment && backup.createdAt < deployment.updatedAt) blockers.push({ id: "pi-hole-backup-order", summary: "The restore-verified Pi-hole backup predates the live BoxPilot deployment" });

    if (deployment?.parameters?.networkAssessmentId) {
      assessment = store.getPlan(deployment.parameters.networkAssessmentId);
      try {
        baseline = await network.validateAcceptanceBaseline(deployment.parameters.networkAssessmentId, ownerId, source.lanAddress);
      } catch (error) {
        blockers.push({ id: "network-baseline", summary: error.message });
      }
    } else if (deployment) {
      blockers.push({ id: "network-assessment-link", summary: "The live deployment is not linked to a network assessment" });
    }

    const resolverAddress = source.lanAddress ?? assessment?.input?.dnsServiceAddress ?? null;
    const output = {
      executable: blockers.length === 0,
      applicationId: "pi-hole",
      resolverAddress,
      linkedDeploymentJobId: deployment?.id ?? null,
      linkedAssessmentId: assessment?.id ?? null,
      linkedBackupId: backup?.id ?? null,
      baseline,
      blockers,
      tests: acceptanceChecks.map((check) => ({ ...check, type: "A", port: 53 })),
      evidenceBoundary: {
        origin: "boxpilot-controller",
        provesBigboxPath: true,
        provesSecondDevicePath: false,
        routerMutationSupported: false,
        dnsCutoverSupported: false,
      },
      changes: [
        `Send four fixed DNS queries directly to ${resolverAddress ?? "the exact managed Pi-hole address"}:53`,
        "Verify the Pi-hole local name over UDP and TCP",
        "Verify one public A lookup and one reserved negative lookup over UDP",
        "Record latency, response code, answer count, and protocol as durable evidence",
      ],
      recovery: "The checks do not change Pi-hole, router, DHCP, client, firewall, or Tailscale settings. A failure records a failed job and leaves the current independent DNS path untouched.",
    };
    return { input: { applicationId: "pi-hole" }, output };
  }

  async function inspect() {
    const source = await inspectSource();
    const deployment = latestDeploymentFor(source);
    const backup = latestBackup();
    return {
      source,
      linkedDeploymentJobId: deployment?.id ?? null,
      linkedBackupId: backup?.id ?? null,
      acceptances: store.listDnsAcceptances(),
      limitations: [
        "A passing Bigbox test proves only the controller-to-resolver path.",
        "A separately enrolled device must still supply independent LAN evidence before router DNS advertisement can be unlocked.",
        "Router, DHCP, client DNS, firewall, and Tailscale settings remain read-only.",
      ],
    };
  }

  async function plan(ownerId) {
    const candidate = await buildPlan(ownerId);
    return store.createPlan({
      type: "network.dns.acceptance",
      subjectId: "pi-hole",
      input: candidate.input,
      output: candidate.output,
      createdBy: ownerId,
      ttlMs: 15 * 60 * 1000,
    });
  }

  async function stage(planId, revision, ownerId) {
    const plan = store.getPlan(planId);
    if (!plan || plan.createdBy !== ownerId || plan.type !== "network.dns.acceptance" || plan.subjectId !== "pi-hole") throw new Error("DNS acceptance plan not found");
    if (plan.revision !== revision) throw new Error("DNS acceptance plan revision does not match");
    if (!plan.output.executable || plan.output.blockers?.length) throw new Error("DNS acceptance plan has unresolved blockers");
    const current = await buildPlan(ownerId);
    if (!current.output.executable || JSON.stringify(current.output) !== JSON.stringify(plan.output)) throw new Error("Pi-hole, backup, deployment, or network baseline changed after planning");
    store.stagePlan(plan.id, ownerId);
    return store.createJob({
      type: "network.dns.acceptance.run",
      title: "Verify Pi-hole DNS directly from Bigbox",
      risk: "network-read",
      parameters: {
        acceptanceId: randomUUID(),
        planId: plan.id,
        revision: plan.revision,
        resolverAddress: plan.output.resolverAddress,
        linkedDeploymentJobId: plan.output.linkedDeploymentJobId,
        linkedAssessmentId: plan.output.linkedAssessmentId,
        linkedBackupId: plan.output.linkedBackupId,
      },
      recovery: {
        automaticRollback: false,
        reason: "The fixed direct DNS checks do not mutate network or application state.",
        manual: "If a check fails, keep router and client DNS on the independent resolver. Verify Pi-hole health and exact bindings before creating a fresh plan.",
      },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Exact managed Pi-hole address, deployment, restore-verified backup, and live network baseline matched" },
        { name: "checkpoint", state: "completed", detail: "Current router and client DNS remain unchanged; second-device proof remains a separate gate" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "network.dns.acceptance.run") throw new Error("Unsupported DNS acceptance job");
    const plan = store.getPlan(job.parameters.planId);
    if (!plan || plan.status !== "staged" || plan.type !== "network.dns.acceptance" || plan.revision !== job.parameters.revision || plan.createdBy !== job.createdBy) throw new Error("The staged DNS acceptance plan is unavailable or changed");
    if (plan.expired) throw new Error("The staged DNS acceptance plan expired; inspect the live resolver and create a new plan");
    const current = await buildPlan(job.createdBy);
    if (!current.output.executable || JSON.stringify(current.output) !== JSON.stringify(plan.output)) throw new Error("Pi-hole, backup, deployment, or network baseline changed before approval");
    if (job.parameters.resolverAddress !== plan.output.resolverAddress
      || job.parameters.linkedDeploymentJobId !== plan.output.linkedDeploymentJobId
      || job.parameters.linkedAssessmentId !== plan.output.linkedAssessmentId
      || job.parameters.linkedBackupId !== plan.output.linkedBackupId) throw new Error("The staged DNS acceptance evidence links do not match");
    return plan;
  }

  async function executeJob(job, plan) {
    const checks = await probeResolver(plan.output.resolverAddress);
    const passed = checks.length === acceptanceChecks.length && checks.every((check, index) => passingEvidenceMatches(check, acceptanceChecks[index]));
    if (!passed) throw new Error("One or more fixed DNS acceptance checks failed; router and client DNS remain unchanged");
    return {
      acceptanceId: job.parameters.acceptanceId,
      applicationId: "pi-hole",
      resolverAddress: plan.output.resolverAddress,
      linkedDeploymentJobId: plan.output.linkedDeploymentJobId,
      linkedAssessmentId: plan.output.linkedAssessmentId,
      linkedBackupId: plan.output.linkedBackupId,
      origin: "boxpilot-controller",
      checks,
      passed: true,
      secondDeviceTested: false,
      routerMutationPerformed: false,
      dnsCutoverPerformed: false,
      clientSettingsChanged: false,
      completedAt: new Date().toISOString(),
    };
  }

  function recordResult(job, result) {
    if (result.acceptanceId !== job.parameters.acceptanceId
      || result.applicationId !== "pi-hole"
      || result.resolverAddress !== job.parameters.resolverAddress
      || result.linkedDeploymentJobId !== job.parameters.linkedDeploymentJobId
      || result.linkedAssessmentId !== job.parameters.linkedAssessmentId
      || result.linkedBackupId !== job.parameters.linkedBackupId
      || result.origin !== "boxpilot-controller"
      || result.passed !== true
      || result.secondDeviceTested !== false
      || result.routerMutationPerformed !== false
      || result.dnsCutoverPerformed !== false
      || result.clientSettingsChanged !== false
      || result.checks?.length !== acceptanceChecks.length
      || !result.checks.every((check, index) => passingEvidenceMatches(check, acceptanceChecks[index]))) throw new Error("DNS acceptance result failed evidence validation");
    return store.recordDnsAcceptance({
      id: result.acceptanceId,
      jobId: job.id,
      applicationId: result.applicationId,
      resolverAddress: result.resolverAddress,
      assessmentId: result.linkedAssessmentId,
      deploymentJobId: result.linkedDeploymentJobId,
      backupId: result.linkedBackupId,
      origin: result.origin,
      checks: result.checks,
      passed: result.passed,
      secondDeviceTested: result.secondDeviceTested,
      createdBy: job.createdBy,
    });
  }

  return { inspect, plan, stage, validateJob, executeJob, recordResult };
}

export const dnsAcceptanceInternals = { acceptanceChecks, flint2AdguardChecks, buildDnsQuery, encodeDnsName, parseDnsResponse, queryDns, passingEvidenceMatches };
