import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Knowledge } from "./agents/Knowledge";

/*
 * Kept outside src/pages/agents while another change works in that folder; it belongs beside
 * Knowledge.tsx once both have landed.
 */

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const library = {
  sources: [{ id: "documents", title: "Your documents", enabled: true, items: 0, size: 0, unit: "characters", indexedAt: null }],
  documents: [],
  search: { kind: "words (BM25)", embeddings: "off", pending: 0, vectors: 0, enabled: false },
  learning: { quietHours: { start: "02:00", end: "06:00" }, agents: [] },
  canChange: true,
  connectors: { notion: { enabled: false, credential: null }, slack: { enabled: false, credential: null, channels: [] } },
  folder: { enabled: false, path: null }, webSearch: { enabled: false, endpoint: null },
};

describe("uploading a document to the learning library", () => {
  it("says the file was added, and what was read from it", async () => {
    // The upload's own words were set, then overwritten by an empty notice: nothing was said.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/api/v1/agents/knowledge/upload") && init?.method === "POST") {
        return json({ id: "88888888-8888-4888-8888-888888888888", title: "Network notes", enabled: true, createdAt: "2026-10-05T08:00:00Z", characters: 1200, source: "pdf", externalId: null, pinned: false, detail: "3 pages" });
      }
      if (url === "/api/v1/agents/knowledge") return json(library);
      return json({ error: `unexpected ${url}` }, 500);
    }));
    render(<Knowledge csrfToken="csrf" role="owner" now={Date.parse("2026-10-05T09:00:00Z")} onStart={vi.fn()} />);
    const input = await screen.findByLabelText("A document to upload");
    fireEvent.change(input, { target: { files: [new File(["notes"], "network-notes.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByText("Network notes was added (3 pages).")).toBeTruthy();
  });
});
