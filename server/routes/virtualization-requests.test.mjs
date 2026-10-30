import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createVirtualizationRouter } from "./virtualization.mjs";

/*
 * What the virtualization routes take from a request before anything reaches the host: one ISO
 * upload per account at a time, a VM plan checked before the host is asked, the planner recorded as
 * the caller, and which account made each recorded export or recovery shown only to the owner.
 */

const accounts = { alex: { id: "alex", role: "owner" }, olly: { id: "olly", role: "operator" }, otto: { id: "otto", role: "operator" } };
const servers = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } });

const plan = { name: "dev-box", osProfile: "ubuntu-24.04", vcpus: 2, memoryMiB: 4096, diskGiB: 40, isoFile: "ubuntu-24.04.iso", network: "default", firmware: "uefi", autostart: false };

async function serve({ upload = async () => ({ name: "disk.iso" }), preview = async (input) => ({ ok: true, plan: { input, revision: "r1", media: { name: input.isoFile }, warnings: [] } }) } = {}) {
  const recorded = [];
  const previewed = [];
  const csrfChecked = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.boxpilotSession = { owner: accounts[request.get("x-test-session")] }; next(); });
  app.use(createVirtualizationRouter({
    vmMedia: { upload },
    vmCreation: { preview: async (input) => { previewed.push(input); return preview(input); } },
    vmExports: { list: () => ({ exports: [{ id: "e1", createdBy: "olly" }, { id: "e2", createdBy: "otto" }] }) },
    vmRecoveries: { list: () => [{ id: "r1", actorId: "otto", steps: [{ by: "olly" }] }] },
    audit: { record: async (type, details) => { recorded.push([type, details.actorId, details.domain]); } },
    auth: { requireCsrf: (request, response, next) => { csrfChecked.push(request.path); return request.get("x-boxpilot-csrf") === "csrf" ? next() : response.status(403).json({ code: "csrf_required" }); } },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { as = "alex", body, csrf = true } = {}) => {
    const response = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", "x-test-session": as, ...(csrf ? { "x-boxpilot-csrf": "csrf" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  return { call, recorded, previewed, csrfChecked };
}

describe("ISO uploads", () => {
  it("lets each account run one upload at a time, and frees the slot when it ends, whatever the outcome", async () => {
    const pending = [];
    const { call } = await serve({ upload: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }) });
    // Wait until the route has handed the nth upload to the media service, however slow the runner.
    const started = async (count) => { while (pending.length < count) await new Promise((resolve) => setTimeout(resolve, 5)); };
    const first = call("POST", "/virtualization/media/uploads", { as: "olly" });
    await started(1);
    expect(await call("POST", "/virtualization/media/uploads", { as: "olly" })).toMatchObject({ status: 409, body: { code: "vm_media_upload_busy" } });
    const other = call("POST", "/virtualization/media/uploads", { as: "otto" });
    await started(2);
    pending[0].reject(new Error("Not enough space in the media pool"));
    expect(await first).toMatchObject({ status: 507 });
    pending[1].resolve({ name: "otto.iso" });
    expect((await other).status).toBe(201);
    const again = call("POST", "/virtualization/media/uploads", { as: "olly" });
    await started(3);
    pending[2].resolve({ name: "again.iso" });
    expect(await again).toMatchObject({ status: 201, body: { upload: { name: "again.iso" } } });
  });

  it("names a duplicate and a refused file, and needs the CSRF token", async () => {
    expect(await (await serve({ upload: async () => { throw new Error("disk.iso already exists"); } })).call("POST", "/virtualization/media/uploads")).toMatchObject({ status: 409 });
    expect(await (await serve({ upload: async () => { throw new Error("Only .iso files can be uploaded"); } })).call("POST", "/virtualization/media/uploads")).toMatchObject({ status: 400, body: { error: "Only .iso files can be uploaded" } });
    expect((await (await serve()).call("POST", "/virtualization/media/uploads", { csrf: false })).status).toBe(403);
  });
});

describe("VM plans", () => {
  it("checks the plan before asking the host, and records who planned it", async () => {
    const { call, recorded, previewed } = await serve();
    for (const bad of [{ ...plan, name: "../etc" }, { ...plan, name: "boxpilot-drill-x" }, { ...plan, isoFile: "../../etc/shadow" }, { ...plan, network: "host" }, { ...plan, vcpus: 999 }, null]) {
      expect((await call("POST", "/virtualization/plans", { as: "olly", body: bad })).status).toBe(400);
    }
    expect(previewed).toEqual([]);
    expect(recorded).toEqual([]);
    expect(await call("POST", "/virtualization/plans", { as: "olly", body: plan })).toMatchObject({ status: 200, body: { ok: true } });
    expect(recorded).toEqual([["vm.plan.created", "olly", "dev-box"]]);
  });

  it("says when the host cannot check it, and records nothing for a plan the host refused", async () => {
    expect(await (await serve({ preview: async () => { throw new Error("libvirt is not running"); } })).call("POST", "/virtualization/plans", { body: plan })).toEqual({ status: 503, body: { ok: false, errors: ["libvirt is not running"] } });
    const refused = await serve({ preview: async () => ({ ok: false, errors: ["Not enough memory"] }) });
    expect((await refused.call("POST", "/virtualization/plans", { body: plan })).status).toBe(400);
    expect(refused.recorded).toEqual([]);
  });
});

describe("recorded VM work", () => {
  it("shows each account its own name on what it made, and every name to the owner", async () => {
    const { call } = await serve();
    expect((await call("GET", "/virtualization/exports", { as: "olly" })).body).toEqual({ exports: [{ id: "e1", createdBy: "olly" }, { id: "e2", createdBy: null }] });
    expect((await call("GET", "/virtualization/exports")).body.exports[1].createdBy).toBe("otto");
    expect((await call("GET", "/virtualization/recoveries", { as: "olly" })).body).toEqual({ recoveries: [{ id: "r1", actorId: null, steps: [{ by: "olly" }] }] });
  });
});
