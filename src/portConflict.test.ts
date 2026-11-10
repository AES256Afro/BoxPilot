import { describe, expect, it } from "vitest";
import { describePortConflict, freePortAfter } from "./portConflict";

const base = { label: "API", port: 11434, protocol: "tcp", listeners: ["127.0.0.1:11434"] };

describe("describePortConflict", () => {
  it("names a leftover Compose project and how to stop it", () => {
    const text = describePortConflict({ ...base, containers: [{ name: "llmcoach-ollama-1", app: null, composeProject: "llmcoach" }] });
    expect(text).toContain("container llmcoach-ollama-1");
    expect(text).toContain("project “llmcoach”");
    expect(text).toContain("docker compose -p llmcoach down");
  });

  it("names a BoxPilot app by its catalog name", () => {
    const text = describePortConflict({ ...base, containers: [{ name: "bp-open-webui", app: "open-webui", composeProject: "bp-open-webui" }] }, (id) => (id === "open-webui" ? "Open WebUI + Ollama" : null));
    expect(text).toContain("by Open WebUI + Ollama, installed through BoxPilot");
    expect(text).not.toContain("docker compose");
  });

  it("offers docker stop for a plain container", () => {
    expect(describePortConflict({ ...base, containers: [{ name: "adhoc", app: null, composeProject: null }] })).toContain("docker stop adhoc");
  });

  it("falls back to the listener when no container holds the port", () => {
    expect(describePortConflict({ ...base, containers: [] })).toBe("API: port 11434/tcp is already in use on this server (127.0.0.1:11434). Pick another port.");
    expect(describePortConflict(base)).toContain("(127.0.0.1:11434)");
  });

  it("keeps the resolved advice for port 53", () => {
    expect(describePortConflict({ label: "DNS", port: 53, protocol: "udp", listeners: ["127.0.0.53:53"] })).toContain("DNSStubListener=no");
  });
});

describe("freePortAfter", () => {
  it("takes the server's suggestion when it sent one", () => {
    expect(freePortAfter({ ...base, suggested: 11436 })).toBe(11436);
  });

  it("works one out from the listeners when they came with the answer, skipping the form's other boxes", () => {
    expect(freePortAfter(base, { inUse: [{ port: 11435, protocol: "tcp" }, 11436], alsoTaken: [11437] })).toBe(11438);
  });

  it("offers nothing when it knows neither: a guess that is also taken is worse", () => {
    expect(freePortAfter(base)).toBeNull();
    expect(freePortAfter({ ...base, suggested: 0 })).toBeNull();
    expect(freePortAfter({ ...base, suggested: 11434 })).toBeNull();
    expect(freePortAfter({ ...base, suggested: 11435 }, { alsoTaken: [11435] })).toBeNull();
  });
});
