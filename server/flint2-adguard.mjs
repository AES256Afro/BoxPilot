import { randomUUID } from "node:crypto";
import { dnsAcceptanceInternals, runFlint2AdguardProbeSuite } from "./dns-acceptance.mjs";

const assertionKeys = ["adguardHomeEnabled", "emergencyResolverTested", "handleClientRequestsReviewed", "routerModeConfirmed", "singleDhcpAuthorityConfirmed", "vpnPolicyImpactReviewed"];

function validateAssertions(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["Flint 2 acceptance declarations are required"];
  const keys = Object.keys(input).sort();
  if (keys.length !== assertionKeys.length || keys.some((key, index) => key !== assertionKeys[index])) return ["Flint 2 acceptance accepts only the six fixed operator declarations"];
  return assertionKeys.filter((key) => input[key] !== true).map((key) => `${key} must be confirmed before direct DNS acceptance`);
}

export function createFlint2AdguardService({ store, network, routerCheckpoints, probeResolver = runFlint2AdguardProbeSuite } = {}) {
  async function buildCandidate(input) {
    const declarationErrors = validateAssertions(input);
    const [topology, checkpoints] = await Promise.all([network.inspect(), Promise.resolve(routerCheckpoints.inspect())]);
    const blockers = declarationErrors.map((summary) => ({ id: "operator-declaration", summary }));
    const route = topology.collectors?.routes === true && topology.defaultRoutes?.length === 1 ? topology.defaultRoutes[0] : null;
    const checkpoint = checkpoints.latestByModel?.["glinet-flint-2"] ?? null;
    if (!route) blockers.push({ id: "gateway", summary: "One unambiguous live default gateway is required" });
    if (!checkpoint) blockers.push({ id: "checkpoint", summary: "Record a retained Flint 2 configuration checkpoint before DNS acceptance" });
    if (topology.tailscale?.connected !== true) blockers.push({ id: "tailscale", summary: "Restore private Tailscale recovery access before testing router DNS" });
    return {
      input: Object.fromEntries(assertionKeys.map((key) => [key, input?.[key] === true])),
      output: {
        executable: blockers.length === 0,
        routerModel: "GL.iNet Flint 2 (GL-MT6000)",
        resolverAddress: route?.gateway ?? null,
        observedInterface: route?.interface ?? null,
        modelIdentityVerified: false,
        checkpointId: checkpoint?.id ?? null,
        checkpointFirmware: checkpoint?.firmwareVersion ?? null,
        blockers,
        tests: dnsAcceptanceInternals.flint2AdguardChecks.map((check) => ({ ...check, type: "A", port: 53 })),
        vendorWarnings: [
          "Flint 2 must remain in Router mode for AdGuard Home, DNS, DHCP, and Tailscale router features.",
          "GL.iNet warns that Handle Client Requests can make domain-based VPN policies and parental-control rules ineffective.",
          "A passing direct test proves the observed gateway answers DNS; it does not remotely attest the physical model, AdGuard configuration, DHCP advertisement, or every client path.",
        ],
        changes: [
          "Send four fixed DNS queries from this server directly to the one observed gateway on TCP and UDP port 53.",
          "Record only response code, answer count, protocol, latency, and immutable evidence links.",
        ],
        recovery: "The probe changes no router, AdGuard Home, DHCP, DNS advertisement, VPN, firewall, client, or Tailscale setting. On failure, keep or restore the independent resolver and review Flint 2 locally.",
        boundary: { routerCredentialsAccepted: false, routerSessionOpened: false, arbitraryTargetAccepted: false, routerMutationPerformed: false, dnsCutoverPerformed: false, dhcpChanged: false, clientSettingsChanged: false },
      },
    };
  }

  async function inspect() {
    const topology = await network.inspect();
    const checkpoints = routerCheckpoints.inspect();
    const secondDeviceEvidence = store.listFleetEvidence(200).filter((item) => item.passed === true
      && item.result?.type === "dns.flint2-adguard.acceptance.v1"
      && item.result?.secondDeviceTested === true
      && item.result?.modelIdentityVerified === false
      && item.result?.gatewayMatchedByAgentContract === true
      && item.result?.routerMutationPerformed === false
      && item.result?.dnsCutoverPerformed === false
      && item.result?.dhcpChanged === false
      && item.result?.clientSettingsChanged === false);
    return {
      observedGateway: topology.defaultRoutes?.length === 1 ? topology.defaultRoutes[0] : null,
      checkpoint: checkpoints.latestByModel?.["glinet-flint-2"] ?? null,
      acceptances: store.listRouterDnsAcceptances(),
      secondDeviceEvidence,
      sourceReviewedAt: "2026-08-16",
      officialSources: [
        "https://docs.gl-inet.com/router/en/4/interface_guide/adguardhome/",
        "https://docs.gl-inet.com/router/en/4/interface_guide/network_mode/",
      ],
      boundary: { credentialsAccepted: false, routerSessionOpened: false, arbitraryTargetAccepted: false, routerMutationSupported: false, dnsCutoverSupported: false },
    };
  }

  async function plan(ownerId, input) {
    const candidate = await buildCandidate(input);
    return store.createPlan({ type: "network.flint2-adguard.acceptance", subjectId: "glinet-flint-2", input: candidate.input, output: candidate.output, createdBy: ownerId, ttlMs: 15 * 60 * 1000 });
  }

  async function stage(planId, revision, ownerId) {
    const plan = store.getPlan(planId);
    if (!plan || plan.createdBy !== ownerId || plan.type !== "network.flint2-adguard.acceptance" || plan.subjectId !== "glinet-flint-2") throw new Error("Flint 2 AdGuard Home acceptance plan not found");
    if (plan.revision !== revision) throw new Error("Flint 2 acceptance plan revision does not match");
    if (!plan.output.executable || plan.output.blockers?.length) throw new Error("Flint 2 acceptance plan has unresolved blockers");
    const current = await buildCandidate(plan.input);
    if (!current.output.executable || JSON.stringify(current.output) !== JSON.stringify(plan.output)) throw new Error("Gateway, checkpoint, Tailscale, or operator declarations changed after planning");
    store.stagePlan(plan.id, ownerId);
    return store.createJob({
      type: "network.flint2-adguard.acceptance.run",
      title: "Verify Flint 2 gateway DNS from this server",
      risk: "network-read",
      parameters: { acceptanceId: randomUUID(), planId: plan.id, revision: plan.revision, resolverAddress: plan.output.resolverAddress, checkpointId: plan.output.checkpointId },
      recovery: { automaticRollback: false, reason: "The four fixed direct DNS queries do not mutate router or client state.", manual: "If a check fails, keep or restore the independent resolver. Review Router mode, AdGuard Home state, Handle Client Requests, VPN interaction, and upstream DNS from the Flint 2 interface." },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "One observed gateway, retained Flint 2 checkpoint, Tailscale recovery path, and six fixed operator declarations matched" },
        { name: "checkpoint", state: "completed", detail: "No credential, router session, arbitrary target, setting write, DHCP change, DNS cutover, client change, or Tailscale change is available" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "network.flint2-adguard.acceptance.run") throw new Error("Unsupported Flint 2 acceptance job");
    const plan = store.getPlan(job.parameters.planId);
    if (!plan || plan.status !== "staged" || plan.type !== "network.flint2-adguard.acceptance" || plan.revision !== job.parameters.revision || plan.createdBy !== job.createdBy) throw new Error("The staged Flint 2 acceptance plan is unavailable or changed");
    if (plan.expired) throw new Error("The staged Flint 2 acceptance plan expired");
    const current = await buildCandidate(plan.input);
    if (!current.output.executable || JSON.stringify(current.output) !== JSON.stringify(plan.output)) throw new Error("Gateway, checkpoint, Tailscale, or operator declarations changed before approval");
    if (job.parameters.resolverAddress !== plan.output.resolverAddress || job.parameters.checkpointId !== plan.output.checkpointId) throw new Error("The staged Flint 2 acceptance evidence links do not match");
    return plan;
  }

  async function executeJob(job, plan) {
    const checks = await probeResolver(plan.output.resolverAddress);
    const passed = checks.length === dnsAcceptanceInternals.flint2AdguardChecks.length && checks.every((check, index) => dnsAcceptanceInternals.passingEvidenceMatches(check, dnsAcceptanceInternals.flint2AdguardChecks[index]));
    if (!passed) throw new Error("One or more fixed gateway DNS checks failed; no router or client setting was changed");
    return {
      acceptanceId: job.parameters.acceptanceId,
      resolverAddress: plan.output.resolverAddress,
      checkpointId: plan.output.checkpointId,
      origin: "boxpilot-controller",
      checks,
      assertions: plan.input,
      passed: true,
      modelIdentityVerified: false,
      routerMutationPerformed: false,
      dnsCutoverPerformed: false,
      dhcpChanged: false,
      clientSettingsChanged: false,
      completedAt: new Date().toISOString(),
    };
  }

  function recordResult(job, result) {
    if (result.acceptanceId !== job.parameters.acceptanceId || result.resolverAddress !== job.parameters.resolverAddress || result.checkpointId !== job.parameters.checkpointId || result.origin !== "boxpilot-controller" || result.passed !== true || result.modelIdentityVerified !== false || result.routerMutationPerformed !== false || result.dnsCutoverPerformed !== false || result.dhcpChanged !== false || result.clientSettingsChanged !== false || JSON.stringify(result.assertions) !== JSON.stringify(store.getPlan(job.parameters.planId)?.input) || result.checks?.length !== dnsAcceptanceInternals.flint2AdguardChecks.length || !result.checks.every((check, index) => dnsAcceptanceInternals.passingEvidenceMatches(check, dnsAcceptanceInternals.flint2AdguardChecks[index]))) throw new Error("Flint 2 DNS acceptance result failed evidence validation");
    return store.recordRouterDnsAcceptance({ id: result.acceptanceId, jobId: job.id, planId: job.parameters.planId, checkpointId: result.checkpointId, resolverAddress: result.resolverAddress, origin: result.origin, checks: result.checks, assertions: result.assertions, passed: true, createdBy: job.createdBy });
  }

  return { inspect, plan, stage, validateJob, executeJob, recordResult };
}

export const flint2AdguardInternals = { assertionKeys, validateAssertions };
