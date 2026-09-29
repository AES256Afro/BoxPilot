// @vitest-environment node
/**
 * Outside data for agents (M37): the PDF reader, uploads, a folder on this server, the owner's own
 * SearXNG, and the Notion and Slack readers the root task runs - each bounded, each off until the
 * owner turns it on, none of it ever instructions.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError, boundSync, fetchNotion, fetchSlack, readFolderSetting, scanFolder, searxSearch, textOfUpload } from "./connectors.mjs";
import { PdfError, extractPdfText, parseCMap } from "./pdf.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

/** A small PDF: one page in a plain font, one in a font with a ToUnicode map and a compressed stream. */
function samplePdf({ encrypt = false } = {}) {
  const parts = [Buffer.from("%PDF-1.5\n")];
  const object = (number, dict, stream = null) => {
    parts.push(Buffer.from(`${number} 0 obj\n${dict}\n`));
    if (stream) parts.push(Buffer.from("stream\n"), stream, Buffer.from("\nendstream\n"));
    parts.push(Buffer.from("endobj\n"));
  };
  const plain = Buffer.from("BT /F1 12 Tf 72 700 Td (Hello, homebox) Tj 0 -14 Td (Line \\(two\\)) Tj ET");
  const cmap = Buffer.from("/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <004F> <0002> <004B> endbfchar 1 beginbfrange <0003> <0005> <0041> endbfrange endcmap end end");
  const coded = deflateSync(Buffer.from("BT /F2 12 Tf 72 700 Td <000100020003> Tj [(<)] TJ ET".replace("[(<)] TJ ", "")));
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>");
  object(3, "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>");
  object(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  object(5, `<< /Length ${plain.length} >>`, plain);
  object(6, "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F2 9 0 R >> >> /Contents 8 0 R >>");
  object(7, `<< /Length ${cmap.length} >>`, cmap);
  object(8, `<< /Length ${coded.length} /Filter /FlateDecode >>`, coded);
  object(9, "<< /Type /Font /Subtype /Type0 /BaseFont /Custom /ToUnicode 7 0 R >>");
  parts.push(Buffer.from(`trailer\n<< /Root 1 0 R${encrypt ? " /Encrypt 10 0 R" : ""} >>\n%%EOF\n`));
  return Buffer.concat(parts);
}

describe("reading a PDF", () => {
  it("walks the pages in order and reads plain and mapped fonts, compressed or not", () => {
    const { text, pages } = extractPdfText(samplePdf());
    expect(pages).toBe(2);
    expect(text).toBe("Hello, homebox\nLine (two)\n\nOKA");
  });

  it("maps codes and ranges from a ToUnicode CMap", () => {
    const { map, width } = parseCMap("2 beginbfchar <01> <0048> <02> <0069> endbfchar 1 beginbfrange <0a> <0c> [<0041> <0042> <0043>] endbfrange");
    expect(width).toBe(1);
    expect([map.get("01"), map.get("02"), map.get("0b")]).toEqual(["H", "i", "B"]);
  });

  it("refuses what it cannot read: not a PDF, an encrypted one, one with no text", () => {
    expect(() => extractPdfText(Buffer.from("just some text, not a pdf"))).toThrow(PdfError);
    expect(() => extractPdfText(samplePdf({ encrypt: true }))).toThrow(/encrypted/);
    const empty = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer << /Root 1 0 R >>\n");
    expect(() => extractPdfText(empty)).toThrow(/No pages/);
  });
});

describe("uploads and a folder", () => {
  it("takes PDF, Markdown and text, and refuses anything else", () => {
    expect(textOfUpload(samplePdf(), "manual.pdf")).toMatchObject({ text: expect.stringContaining("Hello, homebox"), detail: "2 pages" });
    expect(textOfUpload(Buffer.from("# Notes\r\nThe router is at 192.168.1.1\u0007"), "notes.md").text).toBe("# Notes\nThe router is at 192.168.1.1");
    expect(() => textOfUpload(Buffer.from([0, 1, 2, 3]), "photo.jpg")).toThrow(ConnectorError);
  });

  it("names a folder of documents, never a system one", () => {
    expect(readFolderSetting("/srv/notes/")).toBe("/srv/notes");
    for (const bad of ["notes", "/", "/etc", "/etc/ssh", "/proc/1", "/var/lib/boxpilot/agents", "/srv/\0x"]) expect(() => readFolderSetting(bad), bad).toThrow(ConnectorError);
  });

  it("reads the folder's documents, one level down, and says which it skipped", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-folder-"));
    directories.push(root);
    await mkdir(path.join(root, "house"));
    await writeFile(path.join(root, "network.md"), "The router is at 192.168.1.1");
    await writeFile(path.join(root, "house", "manual.pdf"), samplePdf());
    await writeFile(path.join(root, "photo.jpg"), "not read");
    await writeFile(path.join(root, ".hidden.md"), "not read");
    const { documents } = await scanFolder(root);
    expect(documents.map((document) => [document.externalId.replaceAll("\\", "/"), document.title])).toEqual([["house/manual.pdf", "manual"], ["network.md", "network"]]);
  });
});

describe("web search through the owner's SearXNG", () => {
  const guard = async (endpoint) => new URL(endpoint).origin;
  it("asks SearXNG's JSON API on this network and returns the results as text", async () => {
    const asked = [];
    const fetcher = async (url) => { asked.push(String(url)); return new Response(JSON.stringify({ results: [{ title: "SMART attributes", url: "https://example.org/smart", content: "What reallocated sectors mean." }, { title: "no url", url: "javascript:alert(1)" }] }), { status: 200 }); };
    const text = await searxSearch({ endpoint: "http://192.168.1.20:8089", query: "reallocated sectors", limit: 5 }, { fetcher, guard });
    expect(asked[0]).toBe("http://192.168.1.20:8089/search?q=reallocated+sectors&format=json&safesearch=1");
    expect(text).toBe("1. SMART attributes\nhttps://example.org/smart\nWhat reallocated sectors mean.");
  });

  it("says how to turn JSON on when SearXNG refuses it, and refuses an address off this network", async () => {
    await expect(searxSearch({ endpoint: "http://192.168.1.20:8089", query: "x" }, { fetcher: async () => new Response("", { status: 403 }), guard })).rejects.toThrow(/search\.formats/);
    await expect(searxSearch({ endpoint: "https://searx.example.com", query: "x" }, { fetcher: async () => new Response("{}"), guard: async () => { throw new Error("searx.example.com is not on this network"); } })).rejects.toThrow(/only to a SearXNG on this network/);
    await expect(searxSearch({ endpoint: null, query: "x" })).rejects.toThrow(/no SearXNG address/);
  });
});

describe("Notion and Slack, as the root task reads them", () => {
  it("reads the pages a Notion integration was shared with, block by block", async () => {
    const seen = [];
    const fetcher = async (url, options) => {
      seen.push({ url: String(url), auth: options.headers.Authorization, version: options.headers["Notion-Version"] });
      if (String(url).endsWith("/v1/search")) return new Response(JSON.stringify({ results: [{ id: "0123456789abcdef0123456789abcdef", properties: { Name: { type: "title", title: [{ plain_text: "Network" }] } } }] }));
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "The router is " }, { plain_text: "192.168.1.1" }] } }, { type: "divider", divider: {} }] }));
    };
    expect(await fetchNotion({ token: "secret-notion" }, { fetcher })).toEqual([{ externalId: "0123456789abcdef0123456789abcdef", title: "Notion: Network", text: "The router is 192.168.1.1" }]);
    expect(seen.every((entry) => entry.auth === "Bearer secret-notion" && entry.version === "2022-06-28")).toBe(true);
  });

  it("reads the last week of the channels named, and leaves out who wrote what", async () => {
    const fetcher = async (url) => (String(url).includes("C0123456")
      ? new Response(JSON.stringify({ ok: true, messages: [{ ts: "1790000000.000100", text: "Backup finished", user: "U999" }, { ts: "1790000100.000100", text: "joined", subtype: "channel_join" }] }))
      : new Response(JSON.stringify({ ok: false, error: "channel_not_found" })));
    const [document] = await fetchSlack({ token: "xoxb", channels: ["C0123456", "not-a-channel"] }, { fetcher, now: () => 1_790_000_200_000 });
    expect(document).toMatchObject({ externalId: "C0123456", title: "Slack: C0123456" });
    expect(document.text).toMatch(/: Backup finished$/);
    expect(document.text).not.toMatch(/U999|joined/);
    await expect(fetchSlack({ token: "xoxb", channels: ["C9999999"] }, { fetcher })).rejects.toThrow(/channel_not_found/);
  });

  it("hands back at most what the library keeps from one sync", () => {
    const big = Array.from({ length: 10 }, (_, index) => ({ externalId: String(index), title: String(index), text: "x".repeat(60_000) }));
    const bounded = boundSync(big);
    expect(bounded.truncated).toBe(true);
    expect(bounded.documents.reduce((sum, document) => sum + document.text.length, 0)).toBeLessThanOrEqual(400_000);
  });
});
