import { randomUUID } from "node:crypto";
import { keelArtifactSpec } from "./keel-artifact-spec.mjs";

function provenanceMatches(provenance, spec = keelArtifactSpec) {
  const repository = provenance?.repositories?.find((item) => item.id === "keel");
  const release = repository?.latestRelease;
  const asset = release?.assets?.find((item) => item.name === spec.name);
  return repository?.status === "available"
    && release?.tagName === spec.releaseTag
    && release?.commit?.sha === spec.releaseCommitSha
    && asset?.digest === spec.digest
    && asset?.sizeBytes === spec.sizeBytes;
}

export function createKeelArtifactService({
  store,
  helper,
  prerequisites,
  githubProvenance,
  hostPlatform = process.platform,
  hostArchitecture = process.arch,
  spec = keelArtifactSpec,
} = {}) {
  async function inspect() {
    return helper.request("application.keel.artifact.inspect", {});
  }

  async function inspectPlanningState() {
    const [artifact, discovery, prerequisiteInventory, provenance] = await Promise.all([
      inspect(),
      helper.request("application.keel.inspect", {}),
      prerequisites.inspect(),
      githubProvenance.inspect(),
    ]);
    const blockers = [];
    const required = new Set(["runtime.node", "storage.state", "helper.boundary"]);
    for (const item of prerequisiteInventory.checks.filter((check) => required.has(check.id) && check.status !== "ready")) {
      blockers.push({ id: item.id, summary: item.summary, repair: item.repair });
    }
    if (hostPlatform !== spec.platform || hostArchitecture !== spec.architecture) blockers.push({ id: "keel.platform", summary: `Pinned Keel artifact requires ${spec.platform}-${spec.architecture}; this host reports ${hostPlatform}-${hostArchitecture}`, repair: { kind: "manual", description: "Use a separately reviewed artifact for this host architecture" } });
    if (!provenanceMatches(provenance, spec)) blockers.push({ id: "github.provenance", summary: "Pinned Keel release tag, commit, asset size, or digest does not match live public provenance", repair: { kind: "guided", description: "Restore GitHub release evidence and create a new plan" } });
    if (discovery.state === "discovery-unavailable" || discovery.listener === "unknown" || discovery.risks?.length) blockers.push({ id: "keel.discovery", summary: discovery.risks?.length ? `Keel discovery reported: ${discovery.risks.join(", ")}` : "Keel discovery is incomplete", repair: { kind: "manual", description: "Resolve discovery ambiguity before acquiring application bytes" } });
    if (discovery.installed || discovery.state === "ambiguous") blockers.push({ id: "keel.existing-install", summary: discovery.detail, repair: { kind: "guided", description: "Review the existing installation before staging a separate artifact" } });
    if (!["absent", "partial"].includes(artifact.state) || artifact.readyToAcquire !== true) blockers.push({ id: "keel.artifact-state", summary: artifact.detail, repair: artifact.state === "verified" ? { kind: "none", description: "The exact artifact is already locally verified" } : { kind: "manual", description: "Inspect the fixed root-only artifact state from the server before retrying" } });
    return { artifact, discovery, provenance, blockers };
  }

  async function plan(ownerId, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) throw new Error("Keel artifact planning accepts only an empty object");
    const state = await inspectPlanningState();
    const acquisitionId = randomUUID();
    return store.createPlan({
      type: "application.keel.artifact.acquire",
      subjectId: "keel",
      input: { acquisitionId, expectedArtifactState: state.artifact.state },
      output: {
        executable: state.blockers.length === 0,
        artifact: { ...spec, locallyVerifiedByBoxPilot: false },
        currentState: state.artifact.state,
        partialPresent: state.artifact.partialPresent,
        provenanceMatched: provenanceMatches(state.provenance, spec),
        blockers: state.blockers,
        changes: [
          `Download only ${spec.name} from the fixed ${spec.releaseTag} GitHub release through a separately sandboxed one-shot unit`,
          `Require exactly ${spec.sizeBytes} bytes and compute the complete ${spec.digest} digest before publishing the root-only archive`,
          "Record immutable acquisition evidence without returning archive bytes or redirect credentials to the browser",
          "Leave the archive unextracted, unexecuted, uninstalled, and disconnected from any service or registration flow",
        ],
        recovery: {
          automaticRollback: true,
          summary: "A failed acquisition removes only its fixed partial files. A verified archive is retained as inert root-only evidence and is never extracted or run by this workflow.",
        },
        networkAccess: true,
        extractionPerformed: false,
        applicationInstalled: false,
      },
      createdBy: ownerId,
    });
  }

  async function validatePlan(plan, ownerId) {
    if (!plan || plan.createdBy !== ownerId || plan.type !== "application.keel.artifact.acquire" || plan.subjectId !== "keel") throw new Error("Keel artifact plan not found");
    const state = await inspectPlanningState();
    if (state.blockers.length > 0 || state.artifact.state !== plan.input.expectedArtifactState) throw new Error("Host or release state changed: create a new Keel artifact plan");
    return state;
  }

  async function stage(planId, revision, ownerId) {
    const plan = store.getPlan(planId);
    if (!plan || plan.createdBy !== ownerId || plan.type !== "application.keel.artifact.acquire" || plan.subjectId !== "keel") throw new Error("Keel artifact plan not found");
    if (plan.revision !== revision) throw new Error("Keel artifact plan revision does not match");
    if (!plan.output.executable || plan.output.blockers?.length) throw new Error("Keel artifact plan has unresolved blockers");
    await validatePlan(plan, ownerId);
    store.stagePlan(plan.id, ownerId);
    return store.createJob({
      type: "application.keel.artifact.acquire",
      title: "Acquire and locally verify Keel 1.2.6 artifact",
      risk: "networked-artifact",
      parameters: { planId: plan.id, revision: plan.revision, acquisitionId: plan.input.acquisitionId, expectedArtifactState: plan.input.expectedArtifactState },
      recovery: {
        automaticRollback: true,
        reason: "Digest or transport failure removes only fixed helper-owned partial files. No archive is published until complete byte and SHA-256 verification passes.",
        manual: "If a mismatched final archive or non-regular file is reported, inspect /var/lib/boxpilot-managed/artifacts/keel from the server terminal. BoxPilot will not overwrite it automatically.",
      },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: `The exact ${spec.releaseTag} commit, ${spec.name}, ${spec.sizeBytes}-byte length, and SHA-256 matched live public GitHub metadata` },
        { name: "checkpoint", state: "completed", detail: "Only a fixed root-only partial archive and evidence file may be created; extraction, execution, installation, service control, registration, and browser-selected URLs or paths are unavailable" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "application.keel.artifact.acquire") throw new Error("Unsupported Keel artifact job");
    const plan = store.getPlan(job.parameters.planId);
    if (!plan || plan.status !== "staged" || plan.type !== "application.keel.artifact.acquire" || plan.subjectId !== "keel" || plan.revision !== job.parameters.revision) throw new Error("The staged Keel artifact plan is unavailable or changed");
    if (plan.input.acquisitionId !== job.parameters.acquisitionId || plan.input.expectedArtifactState !== job.parameters.expectedArtifactState) throw new Error("The staged Keel artifact plan does not match the job");
    await validatePlan(plan, job.createdBy);
    return plan;
  }

  return { inspect, plan, stage, validateJob };
}

export const keelArtifactServiceInternals = { provenanceMatches };
