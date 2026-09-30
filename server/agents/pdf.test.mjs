// @vitest-environment node
/**
 * A PDF from #agent-files, a watched folder or an upload is read on the web process's one thread.
 * These files are built to make that read expensive; each must end quickly, whatever it holds. The
 * reader runs in a worker here, stopped at a deadline, so a regression fails the test instead of
 * hanging the suite the way it would hang BoxPilot.
 */
import { Worker } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

// Each call has its own deadline below; this only keeps the test's own limit above it.
vi.setConfig({ testTimeout: 30_000 });

const probe = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.module).then((pdf) => {
  const input = Buffer.from(workerData.input, "base64");
  const started = Date.now();
  let outcome;
  try {
    if (workerData.fn === "contentText") outcome = { text: pdf.contentText(input.toString("latin1"), new Map()) };
    else if (workerData.fn === "parseCMap") outcome = { entries: pdf.parseCMap(input.toString("latin1")).map.size };
    else outcome = { result: pdf.extractPdfText(input) };
  } catch (error) { outcome = { error: error.message }; }
  parentPort.postMessage({ ...outcome, ms: Date.now() - started });
});`;

/** Runs one reader call in a worker with a heap limit, stopped after `timeoutMs`. */
function readWithin(fn, input, { timeoutMs = 8_000 } = {}) {
  return new Promise((resolve) => {
    const worker = new Worker(probe, { eval: true, workerData: { module: new URL("./pdf.mjs", import.meta.url).href, fn, input: Buffer.from(input).toString("base64") }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(() => { void worker.terminate(); resolve({ timedOut: true }); }, timeoutMs);
    worker.once("message", (reply) => { clearTimeout(timer); void worker.terminate(); resolve(reply); });
    worker.once("error", (error) => { clearTimeout(timer); resolve({ crashed: error.message }); });
  });
}

/** A PDF of one page whose contents are the given streams, each an object of its own. */
function pdfWithPage(streams, { contents = null, pageExtra = "" } = {}) {
  const parts = [Buffer.from("%PDF-1.5\n")];
  const object = (number, dict, stream = null) => {
    parts.push(Buffer.from(`${number} 0 obj\n${dict}\n`));
    if (stream) parts.push(Buffer.from("stream\n"), stream, Buffer.from("\nendstream\n"));
    parts.push(Buffer.from("endobj\n"));
  };
  const first = 10;
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(3, `<< /Type /Page /Parent 2 0 R ${pageExtra} /Contents ${contents ?? `[${streams.map((_, index) => `${first + index} 0 R`).join(" ")}]`} >>`);
  streams.forEach((stream, index) => object(first + index, stream.dict ?? `<< /Length ${stream.data.length}${stream.flate ? " /Filter /FlateDecode" : ""} >>`, stream.data));
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n"));
  return Buffer.concat(parts);
}

describe("reading a PDF built to be expensive", () => {
  it("ends a hex string with no closing bracket instead of starting the stream over", async () => {
    for (const source of ["<41", "[<41", "BT (A) Tj <41"]) {
      const outcome = await readWithin("contentText", Buffer.from(source), { timeoutMs: 3_000 });
      expect(outcome.timedOut, source).toBeUndefined();
    }
    const outcome = await readWithin("extractPdfText", pdfWithPage([{ data: Buffer.from("BT <41") }]), { timeoutMs: 3_000 });
    expect(outcome.timedOut).toBeUndefined();
  });

  it("finds objects in linear time, whatever runs of digits the file holds", async () => {
    const outcome = await readWithin("extractPdfText", Buffer.from(`%PDF-1.4\n${"1".repeat(400_000)} ${"2".repeat(400_000)} x\n`));
    expect(outcome.timedOut).toBeUndefined();
    expect(outcome.error).toMatch(/No pages/);
  });

  it("does not slow down on a stream dictionary that repeats DecodeParms", async () => {
    const data = deflateSync(Buffer.from("BT (A) Tj"));
    const dict = `<< /Length ${data.length} /Filter /FlateDecode ${"/DecodeParms ".repeat(60_000)}>>`;
    const outcome = await readWithin("extractPdfText", pdfWithPage([{ dict, data }]));
    expect(outcome.timedOut).toBeUndefined();
  });

  it("reads a font map with unclosed sections and huge ranges in bounded time", async () => {
    const unclosed = "beginbfchar <01> <0041> ".repeat(60_000);
    const ranges = `beginbfrange ${"<0000> <FFFF> <0041> ".repeat(20_000)}endbfrange`;
    for (const cmap of [unclosed, ranges]) {
      const outcome = await readWithin("parseCMap", Buffer.from(cmap));
      expect(outcome.timedOut).toBeUndefined();
      expect(outcome.crashed).toBeUndefined();
    }
  });

  it("reads a stream a page names many times once", async () => {
    const pdf = pdfWithPage([{ data: Buffer.from("BT (Once) Tj ET") }], { contents: `[${"10 0 R ".repeat(40)}]` });
    const outcome = await readWithin("extractPdfText", pdf);
    expect(outcome.result.text).toBe("Once");
  });

  it("stops inflating once a document has given up its share, however many streams it has", async () => {
    // Forty streams of 8 MB of zeros each: a few kilobytes on disk, 320 MB inflated.
    const zeros = deflateSync(Buffer.alloc(8 * 1024 * 1024));
    const streams = [{ data: Buffer.from("BT (Readable) Tj ET") }, ...Array.from({ length: 40 }, () => ({ data: zeros, flate: true }))];
    const outcome = await readWithin("extractPdfText", pdfWithPage(streams));
    expect(outcome.timedOut).toBeUndefined();
    expect(outcome.crashed).toBeUndefined();
    expect(outcome.result?.text ?? outcome.error).toBeTruthy();
  });
});
