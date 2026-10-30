import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { CloudVmSheet, PlanVmSheet } from "./NewVmSheets";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("a VM from a cloud image", () => {
  it("imports GitHub keys, then stages the cloud VM with exactly what was asked", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/operations/vm.cloud.images/inspect")) return json({ operation: "vm.cloud.images", result: { images: [{ id: "ubuntu-24.04", label: "Ubuntu 24.04 LTS", defaultUser: "ubuntu", cached: true, digest: null }, { id: "debian-12", label: "Debian 12", defaultUser: "debian", cached: false, digest: null }] } });
      if (url.endsWith("/api/v1/ssh-keys/github/octocat")) return json({ keys: ["ssh-ed25519 AAAAC3 octocat"] });
      return json({ error: `unexpected ${url}` }, 404);
    }));
    const start = vi.fn<(operation: PendingOperation) => void>();
    const onClose = vi.fn();
    render(<CloudVmSheet onClose={onClose} start={start} />);
    expect(await screen.findByRole("option", { name: "Ubuntu 24.04 LTS · cached" })).toBeTruthy();
    const create = screen.getByRole("button", { name: /Review and create/ });
    expect(create.getAttribute("data-risk")).toBe("medium");
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "dev-1" } });
    fireEvent.change(screen.getByLabelText("GitHub user"), { target: { value: "octocat" } });
    fireEvent.click(screen.getByRole("button", { name: "Import keys from GitHub" }));
    await waitFor(() => expect((screen.getByLabelText(/SSH public keys/) as HTMLTextAreaElement).value).toBe("ssh-ed25519 AAAAC3 octocat"));
    fireEvent.change(screen.getByLabelText(/Extra packages/), { target: { value: "git, curl" } });
    fireEvent.click(screen.getByRole("button", { name: /Review and create/ }));
    expect(onClose).toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "vm.cloud.create",
      title: "Create VM dev-1",
      parameters: { name: "dev-1", image: "ubuntu-24.04", vcpus: 2, memoryMiB: 2048, diskGiB: 20, sshKeys: ["ssh-ed25519 AAAAC3 octocat"], autostart: false, packages: ["git", "curl"] },
    }));
  });

  it("says why a GitHub import did not work", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (input.toString().includes("/ssh-keys/github/") ? json({ keys: [] }) : json({ operation: "vm.cloud.images", result: { images: [] } }))));
    render(<CloudVmSheet onClose={vi.fn()} start={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("GitHub user"), { target: { value: "nobody" } });
    fireEvent.click(screen.getByRole("button", { name: "Import keys from GitHub" }));
    expect(await screen.findByText("GitHub user nobody has no public keys")).toBeTruthy();
  });
});

describe("a VM planned from an ISO", () => {
  it("says there is no media to plan from, and where the library is", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      mediaRoot: "/var/lib/libvirt/boot", mediaError: null, isoImages: [], hostCapacity: { cpuThreads: 8, memoryMiB: 32768 },
      limits: { vcpus: { minimum: 1, maximum: 32 }, memoryMiB: { minimum: 1024, maximum: 131072 }, diskGiB: { minimum: 8, maximum: 4096 } },
      profiles: [{ id: "ubuntu-24.04", label: "Ubuntu 24.04 LTS", osVariant: "ubuntu24.04", minimumMemoryMiB: 2048, minimumDiskGiB: 20 }], networks: [{ name: "default", kind: "NAT", recommended: true }], firmware: ["uefi", "bios"],
    })));
    render(<PlanVmSheet csrfToken="csrf" onClose={vi.fn()} onStage={vi.fn()} />);
    expect(await screen.findByText("No managed ISO images found")).toBeTruthy();
    expect(screen.getByText("/var/lib/libvirt/boot")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Generate reviewed plan" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // A slow plan answer arrived after the form was changed, was shown as the plan, and the VM was
  // staged with the values from before the change.
  it("drops a plan answered for values that have since been changed", async () => {
    const options = {
      mediaRoot: "/var/lib/libvirt/boot", mediaError: null, isoImages: [{ name: "ubuntu.iso", sizeBytes: 1, modifiedAt: "2026-08-14T12:00:00Z" }], hostCapacity: { cpuThreads: 8, memoryMiB: 32768 },
      limits: { vcpus: { minimum: 1, maximum: 32 }, memoryMiB: { minimum: 1024, maximum: 131072 }, diskGiB: { minimum: 8, maximum: 4096 } },
      profiles: [{ id: "ubuntu-24.04", label: "Ubuntu 24.04 LTS", osVariant: "ubuntu24.04", minimumMemoryMiB: 2048, minimumDiskGiB: 20 }], networks: [{ name: "default", kind: "NAT", recommended: true }], firmware: ["uefi", "bios"],
    };
    const planFor = (input: Record<string, unknown>) => ({ ok: true, plan: { id: "plan-1", revision: "revision12345678", stageable: true, input, profile: { label: "Ubuntu 24.04 LTS", osVariant: "ubuntu24.04" }, media: { name: "ubuntu.iso", sizeBytes: 1, modifiedAt: "" }, warnings: [], command: { program: "virt-install", arguments: [], display: `virt-install --name ${String(input.name)}` }, gates: [] } });
    const answers: Array<() => void> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!input.toString().endsWith("/virtualization/plans")) return json(options);
      const asked = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Promise<Response>((resolve) => { answers.push(() => resolve(json(planFor(asked)))); });
    }));
    const onStage = vi.fn();
    render(<PlanVmSheet csrfToken="csrf" onClose={vi.fn()} onStage={onStage} />);
    await screen.findByText("Host CPU threads");
    fireEvent.change(screen.getByLabelText(/VM name/), { target: { value: "old-lab" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate reviewed plan" }));
    await waitFor(() => expect(answers).toHaveLength(1));
    fireEvent.change(screen.getByLabelText(/VM name/), { target: { value: "new-lab" } });
    answers[0]();
    await waitFor(() => expect((screen.getByRole("button", { name: "Generate reviewed plan" }) as HTMLButtonElement).getAttribute("aria-busy")).not.toBe("true"));
    expect(screen.queryByText("virt-install --name old-lab")).toBeNull();
    expect(screen.queryByRole("button", { name: /Continue to approval/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Generate reviewed plan" }));
    await waitFor(() => expect(answers).toHaveLength(2));
    answers[1]();
    fireEvent.click(await screen.findByRole("button", { name: /Continue to approval/ }));
    expect(onStage).toHaveBeenCalledWith(expect.objectContaining({ name: "new-lab" }));
  });

  it("takes focus, closes on Escape and hands focus back", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const { unmount } = render(<PlanVmSheet csrfToken="csrf" onClose={onClose} onStage={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Plan from an ISO" });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
