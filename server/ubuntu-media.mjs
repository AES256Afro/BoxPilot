import { randomUUID } from "node:crypto";
import { getUbuntuMediaSpec, ubuntuMediaCatalog, ubuntuMediaCatalogRevision } from "./ubuntu-media-spec.mjs";

export function createUbuntuMediaService({ store, helper } = {}) {
  async function catalog() {
    const media = await helper.request("virtualization.media.inspect", {});
    return {
      revision: ubuntuMediaCatalogRevision,
      images: ubuntuMediaCatalog.map((image) => ({
        ...image,
        state: media.library.images.some((item) => item.name === image.name) ? "managed"
          : media.inbox.candidates.some((item) => item.name === image.name) ? "staged" : "available",
      })),
      boundary: { officialHostOnly: "releases.ubuntu.com", arbitraryUrlAccepted: false, browserDigestAccepted: false, automaticDownload: false, importAutomatic: false },
    };
  }

  async function plan(imageId, ownerId) {
    const spec = getUbuntuMediaSpec(imageId);
    if (!spec) throw new Error("Select one image from the fixed Ubuntu Server catalog");
    const current = await catalog();
    const image = current.images.find((item) => item.id === imageId);
    if (image.state !== "available") throw new Error(`The fixed Ubuntu ISO is already ${image.state}`);
    const input = { acquisitionId: randomUUID(), expectedCatalogRevision: current.revision, imageId: spec.id };
    const output = {
      executable: true,
      artifact: spec,
      changes: ["Download one exact Ubuntu Server ISO from releases.ubuntu.com", "Publish it into the fixed private VM media staging inbox only after complete size and SHA-256 verification"],
      verification: ["Require the exact HTTPS host, path, response length, byte count, and pinned SHA-256", "Record immutable acquisition evidence, then require a separate media-import approval before libvirt can use the ISO"],
      boundaries: ["No browser URL, path, filename, size, digest, mirror, redirect, command, or argument is accepted", "No existing staged or managed media is overwritten", "No VM, libvirt resource, firewall, Tailscale, DNS, router, or client setting changes"],
      recovery: "Failure removes only this acquisition's generated partial or newly published staging pair. Existing media and all VM state remain unchanged.",
      catalogRevision: current.revision,
    };
    const draft = store.createPlan({ type: "virtualization.media.acquire", subjectId: spec.id, input, output, createdBy: ownerId });
    return { ...draft.output, id: draft.id, revision: draft.revision, status: draft.status, expiresAt: draft.expiresAt, input: draft.input };
  }

  async function validateDraft(draft) {
    const current = await catalog();
    const spec = getUbuntuMediaSpec(draft.input.imageId);
    const image = current.images.find((item) => item.id === draft.input.imageId);
    if (!spec || draft.input.expectedCatalogRevision !== current.revision || image?.state !== "available") throw new Error("Host or catalog state changed: the reviewed Ubuntu media acquisition is no longer available");
    return draft;
  }

  async function stage(planId, revision, ownerId) {
    const draft = store.getPlan(planId);
    if (!draft || draft.createdBy !== ownerId || draft.type !== "virtualization.media.acquire") throw new Error("Ubuntu media acquisition plan not found");
    if (draft.revision !== revision) throw new Error("Ubuntu media acquisition plan revision does not match");
    await validateDraft(draft);
    store.stagePlan(draft.id, ownerId);
    return store.createJob({
      type: "virtualization.media.acquire",
      title: `Acquire ${draft.output.artifact.label}`,
      risk: "networked-artifact",
      parameters: { planId: draft.id, revision: draft.revision, input: draft.input },
      recovery: { automaticRollback: true, reason: draft.output.recovery, manual: "Inspect only the fixed VM media staging and acquisition-evidence directories before retrying." },
      createdBy: ownerId,
      initialSteps: [
        { name: "preflight", state: "completed", detail: "Fixed catalog id, source host, filename, byte count, SHA-256, empty destination, and free-space reserve reviewed" },
        { name: "checkpoint", state: "completed", detail: "Existing staging media, managed media, libvirt, VMs, and network configuration are immutable for this job" },
      ],
    });
  }

  async function validateJob(job) {
    if (job.type !== "virtualization.media.acquire") throw new Error("Unsupported Ubuntu media acquisition job");
    const draft = store.getPlan(job.parameters.planId);
    if (!draft || draft.status !== "staged" || draft.revision !== job.parameters.revision || draft.createdBy !== job.createdBy) throw new Error("The staged Ubuntu media acquisition plan is unavailable or changed");
    if (JSON.stringify(job.parameters.input) !== JSON.stringify(draft.input)) throw new Error("The Ubuntu media acquisition job inputs do not match the approved plan");
    return validateDraft(draft);
  }

  return { catalog, plan, stage, validateJob };
}
