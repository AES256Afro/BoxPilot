import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CatalogPage from "./CatalogPage";
import { previewManifest, previewProblem } from "./PrivateAppsTab";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });
const json = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const reference = `ghcr.io/example/tool:1.0@${digest("a")}`;
const base = { category: "Tools", website: null, icon: null, risk: "medium", notes: null, ports: [], volumes: [], env: [], health: { kind: "running", stableSeconds: 1, timeoutSeconds: 10 }, sha256: "a" };
const builtIn = { ...base, id: "jellyfin", name: "Jellyfin", description: "Media", image: { reference: "jellyfin/jellyfin:10", version: "10", digestPinned: false }, source: "catalog" };
const tool = { ...base, id: "private-tool", name: "Own Tool", description: "Mine", image: { reference, version: "1.0", digestPinned: true }, source: "private" };
const kept = { ...base, id: "private-kept", name: "Kept Tool", description: "Mine too", image: { reference, version: "2.0", digestPinned: true }, source: "private" };
const absent = (id: string, dataPresent = false) => ({ id, installed: false, dataPresent, state: null, container: { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null }, urls: [] });

const manifestYaml = (id = "private-tool", image = reference) => [
  "schemaVersion: 2", `id: ${id}`, "name: \"Own Tool\"  # the one I wrote", "category: Tools", "description: Mine",
  "image:", `  reference: ${image}`, "  version: \"1.1\"",
].join("\n");

function serve({ registries = [{ registry: "ghcr.io", username: "someone" }] as unknown[] } = {}) {
  const staged: Record<string, { parameters: Record<string, unknown> }> = {};
  const catalog = { applications: [
    { manifest: builtIn, live: absent("jellyfin") },
    { manifest: tool, live: absent("private-tool") },
    { manifest: kept, live: absent("private-kept", true) },
  ], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url === "/api/v1/catalog") return json(catalog, 200);
    if (url === "/api/v1/operations/registry.inspect/inspect") return json({ operation: "registry.inspect", result: { registries } }, 200);
    if (url.includes("app.serve.inspect")) return json({ result: { available: true, serves: [] } }, 200);
    if (url === "/api/v1/schedules") return json({ schedules: [] }, 200);
    const match = url.match(/\/operations\/([a-z0-9.-]+)\/jobs$/);
    if (match) {
      staged[match[1]] = JSON.parse(String(init?.body));
      const tier = match[1] === "registry.signout" ? "medium" : "high";
      return json({ job: { id: `job-${match[1]}`, type: `op:${match[1]}`, title: match[1], state: "awaiting_approval", risk: tier, error: null, result: null, steps: [], approvals: [] }, approval: { tier, passwordRequired: tier === "high", elevated: false, mode: "tiered", reason: tier } });
    }
    return json({ error: `unexpected ${url}` }, 500);
  }));
  return staged;
}

async function openPrivateTab() {
  render(<CatalogPage csrfToken="csrf" role="owner" />);
  fireEvent.click(await screen.findByRole("tab", { name: /^Private apps/ }));
  return screen.findByRole("region", { name: /^Private apps/ });
}

describe("reading a manifest for its preview", () => {
  it("finds the id, name and image in block or flow style, with quotes and comments", () => {
    expect(previewManifest(manifestYaml())).toEqual({ id: "private-tool", name: "Own Tool", image: reference, version: "1.1" });
    expect(previewManifest(`id: 'private-flow'\nname: Flow\nimage: { reference: ${reference}, version: "3" }\n`)).toEqual({ id: "private-flow", name: "Flow", image: reference, version: "3" });
    expect(previewManifest("# nothing here\n")).toEqual({ id: null, name: null, image: null, version: null });
  });

  it("says what the server would refuse before anything is staged", () => {
    expect(previewProblem(previewManifest(manifestYaml("tool")))).toMatch(/must start with private-/);
    expect(previewProblem(previewManifest(manifestYaml("private-tool", "ghcr.io/example/tool:1.0")))).toMatch(/pinned by digest/);
    expect(previewProblem(previewManifest("name: x\n"))).toMatch(/No id/);
    expect(previewProblem(previewManifest(manifestYaml()))).toBeUndefined();
  });
});

describe("the Private apps tab", () => {
  it("is the owner's alone", async () => {
    serve();
    window.history.replaceState(null, "", "/?tab=private");
    render(<CatalogPage csrfToken="csrf" role="operator" />);
    expect(await screen.findByRole("tab", { name: /^On this server/ })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /^Private apps/ })).toBeNull();
    expect(screen.queryByRole("region", { name: /^Registry sign-in/ })).toBeNull();
  });

  it("tags a private app's card in the catalog", async () => {
    serve();
    render(<CatalogPage csrfToken="csrf" role="owner" />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Catalog/ }));
    const card = (await screen.findByRole("button", { name: /^Own Tool: / })).closest("li")!;
    expect(within(card).getByText("private")).toBeTruthy();
    const other = screen.getByRole("button", { name: /^Jellyfin: / }).closest("li")!;
    expect(within(other).queryByText("private")).toBeNull();
  });

  it("lists the private apps, and offers Remove only for one with nothing left on this server", async () => {
    const staged = serve();
    const panel = await openPrivateTab();
    const rows = within(panel).getAllByRole("row");
    expect(rows.map((row) => row.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Own Tool"), expect.stringContaining("Not installed, data kept")]));
    expect(within(panel).queryByRole("button", { name: "Remove Kept Tool" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Remove Own Tool" }));
    await waitFor(() => expect(staged["catalog.private.remove"]).toEqual({ parameters: { id: "private-tool" } }));
  });

  it("signs in to a registry with the token as a secret, and signs out of one", async () => {
    const staged = serve();
    await openPrivateTab();
    const signIns = await screen.findByRole("region", { name: /^Registry sign-in/ });
    expect(await within(signIns).findByText("someone")).toBeTruthy();
    fireEvent.click(within(signIns).getByRole("button", { name: "Sign out of ghcr.io" }));
    await waitFor(() => expect(staged["registry.signout"]).toEqual({ parameters: { registry: "ghcr.io" } }));
  });

  it("starts a sign-in with what was typed", async () => {
    const staged = serve({ registries: [] });
    await openPrivateTab();
    const form = await screen.findByRole("form", { name: "Sign in to a registry" });
    expect(await screen.findByText("Not signed in to any registry")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("User name"), { target: { value: "someone" } });
    fireEvent.change(within(form).getByLabelText("Token"), { target: { value: ["tok", "q".repeat(20)].join("_") } });
    fireEvent.click(within(form).getByRole("button", { name: /Sign in/ }));
    await waitFor(() => expect(staged["registry.signin"]).toEqual({ parameters: { registry: "ghcr.io", username: "someone", token: ["tok", "q".repeat(20)].join("_") } }));
  });

  it("previews a pasted manifest and saves it under its id, and will not start one the server would refuse", async () => {
    const staged = serve();
    await openPrivateTab();
    const form = await screen.findByRole("form", { name: "Add or replace a private app" });
    const box = within(form).getByLabelText("Manifest");
    fireEvent.change(box, { target: { value: manifestYaml("private-tool", "ghcr.io/example/tool:1.0") } });
    expect(within(form).getByText(/must be pinned by digest/)).toBeTruthy();
    expect((within(form).getByRole("button", { name: /Replace/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: manifestYaml() } });
    expect(within(form).getByText("Own Tool")).toBeTruthy();
    expect(within(form).getByText("replaces the one saved before")).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: /Replace/ }));
    await waitFor(() => expect(staged["catalog.private.save"]).toEqual({ parameters: { id: "private-tool", manifest: manifestYaml() } }));
  });

  it("reads a chosen file into the manifest box", async () => {
    serve();
    await openPrivateTab();
    const form = await screen.findByRole("form", { name: "Add or replace a private app" });
    const input = form.querySelector("input[type=file]") as HTMLInputElement;
    const file = new File([manifestYaml("private-new")], "private-new.yaml", { type: "application/yaml" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect((within(form).getByLabelText("Manifest") as HTMLTextAreaElement).value).toBe(manifestYaml("private-new")));
    expect(within(form).getByRole("button", { name: /^Add/ })).toBeTruthy();
  });
});
