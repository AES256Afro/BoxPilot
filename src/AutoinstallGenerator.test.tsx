import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AutoinstallGenerator from "./AutoinstallGenerator";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("autoinstall generator", () => {
  it("suggests the release this build is, not one frozen in the source", async () => {
    // The placeholder read v0.62.5 more than a hundred releases later. It is the one field where
    // copying the example verbatim installs something ancient on a server being built from scratch.
    render(<AutoinstallGenerator csrfToken="csrf-token" />);
    const field = await screen.findByPlaceholderText(/^v\d+\.\d+\.\d+ \(current\)$/);
    expect(field).toBeTruthy();
    expect((field as HTMLInputElement).placeholder).toContain(__BOXPILOT_VERSION__);
  });

  it("imports GitHub keys, posts the request without keeping the password, and shows the user-data", async () => {
    let posted: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/ssh-keys/github/octocat")) return json({ user: "octocat", keys: ["ssh-ed25519 AAAAC3 octocat"] });
      if (url.endsWith("/api/v1/setup/autoinstall")) { posted = init?.body as string; return json({ userData: "#cloud-config\nautoinstall:\n  version: 1\n", metaData: "instance-id: boxpilot-garage-box\n", ref: "v0.62.5", filename: "garage-box-autoinstall" }); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutoinstallGenerator csrfToken="csrf" />);

    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "garage-box" } });
    fireEvent.change(screen.getByLabelText("User name"), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: "correct horse battery" } });
    fireEvent.change(screen.getByLabelText("GitHub user for keys"), { target: { value: "octocat" } });
    fireEvent.click(screen.getByRole("button", { name: "Import keys from GitHub" }));
    expect(((await screen.findByLabelText(/SSH public keys/)) as HTMLTextAreaElement).value).toContain("ssh-ed25519 AAAAC3 octocat");
    fireEvent.click(screen.getByRole("button", { name: "Generate autoinstall files" }));
    expect(await screen.findByLabelText("Generated user-data")).toBeTruthy();
    expect(JSON.parse(posted ?? "{}")).toMatchObject({ hostname: "garage-box", username: "owner", password: "correct horse battery", sshKeys: ["ssh-ed25519 AAAAC3 octocat"], network: { mode: "dhcp" }, disk: { layout: "lvm" } });
    expect((screen.getByLabelText(/Password/) as HTMLInputElement).value).toBe("");
  });
});
