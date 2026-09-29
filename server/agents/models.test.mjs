// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runnerCaps } from "./caps.mjs";
import { readModelParameters } from "./host.mjs";
import { defaultModelId, downloadPreview, findNewerQwen, ggufPattern, modelById, modelLibrary, parseQwenRepo, quantOf, repoPattern, testedUnslothVersion } from "./models.mjs";

describe("the model library", () => {
  it("holds only Unsloth's small Qwen GGUFs with a vision projector, the 4B first", () => {
    expect(defaultModelId).toBe("qwen3.5-4b");
    for (const model of modelLibrary) {
      expect(model.repo, model.id).toMatch(repoPattern);
      expect(model.file, model.id).toMatch(ggufPattern);
      expect(model.vision && model.projector, model.id).toBeTruthy();
      expect(quantOf(model.file), model.id).toBe(model.quant);
    }
    expect(modelById("qwen3.5-9b").memoryBytes).toBeGreaterThan(8 * 1024 ** 3);
  });

  it("says which fit the runner's memory cap, files and all: the 4B and the 2B, never the 9B", () => {
    expect(modelLibrary.map((model) => model.id)).toEqual(["qwen3.5-4b", "qwen3.5-2b", "qwen3.5-9b"]);
    expect(modelLibrary.filter((model) => model.memoryBytes <= runnerCaps.memoryMaxBytes).map((model) => model.id)).toEqual(["qwen3.5-4b", "qwen3.5-2b"]);
    expect(modelLibrary.filter((model) => model.recommended).map((model) => model.id)).toEqual(["qwen3.5-4b"]);
    expect(modelById("qwen3.5-2b").tokensPerSecond).toBeGreaterThan(modelById("qwen3.5-4b").tokensPerSecond);
    expect(testedUnslothVersion).toMatch(/^\d{4}\.\d{1,2}\.\d+$/);
  });

  it("previews a download's size and time", () => {
    const preview = downloadPreview(modelById("qwen3.5-4b"));
    expect(preview.bytes).toBe(3_580_000_000);
    expect(preview.fastMinutes).toBe(2);
    expect(preview.slowMinutes).toBe(12);
  });

  it("reads a model's parameters strictly: Unsloth's Qwen repositories only", () => {
    expect(readModelParameters({ repo: "unsloth/Qwen3.5-4B-GGUF", file: "Qwen3.5-4B-UD-Q4_K_XL.gguf", projector: "mmproj-F16.gguf" })).toMatchObject({ quant: "UD-Q4_K_XL" });
    for (const bad of [
      { repo: "someone/Qwen3.5-4B-GGUF", file: "Qwen3.5-4B-UD-Q4_K_XL.gguf" },
      { repo: "unsloth/Qwen3.5-4B-GGUF", file: "../../etc/passwd" },
      { repo: "unsloth/Qwen3.5-4B-GGUF", file: "model.safetensors" },
      { repo: "unsloth/Qwen3.5-4B-GGUF", file: "Qwen3.5-4B.gguf" },
    ]) expect(() => readModelParameters(bad), JSON.stringify(bad)).toThrow();
  });
});

describe("a newer small Qwen", () => {
  const listing = [
    { id: "unsloth/Qwen3.6-4B-GGUF" }, { id: "unsloth/Qwen3.6-32B-GGUF" }, { id: "unsloth/Qwen3-Coder-4B-GGUF" },
    { id: "unsloth/Qwen3.5-4B-GGUF" }, { id: "unsloth/Qwen4-9B-GGUF" }, { id: "someone/Qwen5-4B-GGUF" },
  ];
  const details = {
    "unsloth/Qwen4-9B-GGUF": { siblings: [{ rfilename: "Qwen4-9B-Q4_K_M.gguf" }] },
    "unsloth/Qwen3.6-4B-GGUF": { siblings: [{ rfilename: "Qwen3.6-4B-UD-Q4_K_XL.gguf" }, { rfilename: "mmproj-F16.gguf" }] },
  };
  const fetchJson = async (url) => (url.includes("?author=") ? listing : details[url.replace("https://huggingface.co/api/models/", "")] ?? null);

  it("is a later version, at most 9B, with a vision projector; never a coder, a bigger model or another publisher", async () => {
    expect(parseQwenRepo("unsloth/Qwen3.5-4B-GGUF")).toEqual({ version: 3.5, parameters: 4 });
    expect(parseQwenRepo("unsloth/Qwen3-Coder-4B-GGUF")).toBeNull();
    // Qwen4 9B has no projector, so it cannot read images: the next candidate is 3.6 4B.
    expect(await findNewerQwen({ current: { repo: "unsloth/Qwen3.5-4B-GGUF" }, fetchJson })).toEqual({ repo: "unsloth/Qwen3.6-4B-GGUF", version: 3.6, parameters: 4, file: "Qwen3.6-4B-UD-Q4_K_XL.gguf", projector: "mmproj-F16.gguf" });
    expect(await findNewerQwen({ current: { repo: "unsloth/Qwen3.6-4B-GGUF" }, fetchJson })).toBeNull();
  });
});
