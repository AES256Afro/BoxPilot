import { describe, expect, it, vi } from "vitest";
import { createVmCreationService } from "./vm-creation.mjs";

const input = { name: "ubuntu-lab", osProfile: "ubuntu-24.04", vcpus: 2, memoryMiB: 4096, diskGiB: 40, isoFile: "ubuntu.iso", network: "default", firmware: "uefi", autostart: false };

function setup() {
  const planner = { createPlan: vi.fn(async () => ({ ok: true, plan: { revision: "adapter-revision", executable: true, stageable: true, input, profile: { label: "Ubuntu", osVariant: "ubuntu24.04" }, media: { name: "ubuntu.iso", sizeBytes: 4096 }, warnings: [], command: { display: "virt-install" }, gates: [] } })) };
  const libvirt = {
    getDomain: vi.fn(async () => null),
    listResources: vi.fn(async () => ({ connected: true, networks: [{ name: "default", active: true }], pools: [{ name: "default", active: true, availableBytes: 100 * 1024 ** 3 }] })),
  };
  return { planner, libvirt, service: createVmCreationService({ store: {}, planner, libvirt }) };
}

describe("guarded VM creation", () => {
  it("previews a full host-checked plan without storing anything", async () => {
    const { service, planner } = setup();
    const result = await service.preview(input);
    expect(result.plan).toMatchObject({ stageable: true, input, command: { display: "virt-install" } });
    expect(planner.createPlan).toHaveBeenCalledWith(input, expect.objectContaining({ existingDomainNames: [] }));
  });

  it("refuses a preview when the exact domain name already exists", async () => {
    const { service, libvirt } = setup();
    libvirt.getDomain.mockResolvedValue({ name: input.name });
    expect(await service.preview(input)).toMatchObject({ ok: false, errors: [expect.stringContaining("already exists")] });
  });

  it("pins the revalidated plan input for the registry operation", async () => {
    const { service } = setup();
    expect(await service.prepareOperation(input)).toEqual(input);
  });

  it("rejects preparation when the plan is not executable or the host changed", async () => {
    const { service, planner, libvirt } = setup();
    planner.createPlan.mockResolvedValueOnce({ ok: true, plan: { revision: "windows", executable: false, stageable: false, blockers: ["Windows profile needs extra host checks"], input: { ...input, osProfile: "windows-11" } } });
    await expect(service.prepareOperation({ ...input, osProfile: "windows-11" })).rejects.toThrow("Windows profile needs extra host checks");
    libvirt.listResources.mockResolvedValueOnce({ connected: true, networks: [{ name: "default", active: false }], pools: [{ name: "default", active: true }] });
    await expect(service.prepareOperation(input)).rejects.toThrow("default libvirt network is not active");
  });
});
