import { describe, expect, it } from "vitest";
import { runnerCaps } from "./caps.mjs";
import { readModelParameters } from "./host.mjs";
import { defaultModelId, downloadPreview, findNewerQwen, ggufPattern, modelById, modelLibrary, parseQwenRepo, quantOf, repoPattern, testedUnslothVersion } from "./models.mjs";

describe("the model library", () => {
  it("holds Unsloth's small Qwen GGUFs and the owner's two HauhauCS builds, each with a vision projector, the 4B first", () => {
    expect(defaultModelId).toBe("qwen3.5-4b");
    for (const model of modelLibrary) {
      expect(model.repo, model.id).toMatch(repoPattern);
      expect(model.file, model.id).toMatch(ggufPattern);
      expect(model.vision && model.projector, model.id).toBeTruthy();
      expect(quantOf(model.file), model.id).toBe(model.quant);
    }
    // The 9B-class builds needed the cap raised from 8 GB (ADR-019): under the old cap their files alone left no room.
    for (const id of ["qwen3.5-9b", "qwen3.5-9b-uncensored", "gemma4-e4b-uncensored"]) expect(modelById(id).memoryBytes, id).toBeGreaterThan(8 * 1024 ** 3);
    // The HauhauCS builds are not measured yet, and say so.
    for (const id of ["qwen3.5-9b-uncensored", "gemma4-e4b-uncensored"]) expect(modelById(id).measuredAt, id).toMatch(/^not measured/);
  });

  it("says which fit the runner's 12 GB memory cap, files and all: every one, with room to spare for none of the 9B-class", () => {
    expect(modelLibrary.map((model) => model.id)).toEqual(["qwen3.5-4b", "qwen3.5-2b", "qwen3.5-9b", "gemma4-e4b-uncensored", "qwen3.5-9b-uncensored"]);
    expect(runnerCaps.memoryMaxBytes).toBe(12 * 1024 ** 3);
    expect(modelLibrary.filter((model) => model.memoryBytes <= runnerCaps.memoryMaxBytes).map((model) => model.id)).toEqual(modelLibrary.map((model) => model.id));
    for (const model of modelLibrary.filter((entry) => entry.parameters >= 9)) expect(model.memoryBytes, model.id).toBeGreaterThan(runnerCaps.memoryMaxBytes * 0.75);
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

  it("reads a model's parameters strictly: Unsloth's Qwen repositories and the two HauhauCS ones, named whole", () => {
    expect(readModelParameters({ repo: "unsloth/Qwen3.5-4B-GGUF", file: "Qwen3.5-4B-UD-Q4_K_XL.gguf", projector: "mmproj-F16.gguf" })).toMatchObject({ quant: "UD-Q4_K_XL" });
    expect(readModelParameters({ repo: "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive", file: "Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf" })).toMatchObject({ quant: "Q4_K_P" });
    for (const repo of ["HauhauCS/Gemma-4-E2B-Uncensored-HauhauCS-Aggressive", "HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Balanced", "HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced", "hauhaucs/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive"]) {
      expect(() => readModelParameters({ repo, file: "model-Q4_K_M.gguf" }), repo).toThrow(/Only/);
    }
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
