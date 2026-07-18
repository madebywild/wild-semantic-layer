import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDir } from "../../../../helpers.js";

// Mocks the `@huggingface/transformers` package itself (not our own embedder.ts) so the
// model-resolution, cache-dir-resolution, prefix, and truncation logic in `createLocalEmbedder`
// can be exercised fast and deterministically — no real ONNX session, no model download. This is
// distinct from the opt-in `SEMANTIC_LAYER_TEST_REAL_LOCAL_EMBEDDER` test in embedder.test.ts,
// which intentionally uses the real package to catch real-world integration issues.
const pipelineSpy = vi.fn();
const disposeSpy = vi.fn();
const extractorSpy = vi.fn();

// transformers.js exposes a mutable `env` singleton; embedder.ts assigns `env.cacheDir` on it, so
// the mock must hand out a real object the tests can inspect.
const fakeEnv = { cacheDir: "" };

/** nomic-embed-text-v1.5 natively emits 768 dims; rows longer than 512 exercise the truncation. */
const NATIVE_DIMENSIONS = 768;

function nativeVector(seed: number): number[] {
  return Array.from({ length: NATIVE_DIMENSIONS }, (_, i) => ((i * 31 + seed) % 17) - 8);
}

vi.mock("@huggingface/transformers", () => ({
  pipeline: (task: string, model: string, options: unknown) => {
    pipelineSpy(task, model, options);
    extractorSpy.mockImplementation(async (texts: string[]) => ({
      tolist: () => texts.map((_, index) => nativeVector(index + 1)),
    }));
    return Promise.resolve(Object.assign(extractorSpy, { dispose: disposeSpy }));
  },
  env: fakeEnv,
}));

const { createEmbedder } = await import(
  "../../../../../packages/semantic-layer/src/search/embedder.js"
);

let tempDir: { dir: string; cleanup: () => void };

beforeEach(() => {
  // Default every test to a throwaway cache dir, so `mkdirSync` never touches the real home
  // directory unless a test explicitly wants to exercise that fallback (see below).
  tempDir = createTempDir();
  vi.stubEnv("SEMANTIC_LAYER_MODEL_CACHE_DIR", tempDir.dir);
  fakeEnv.cacheDir = "";
});

afterEach(() => {
  pipelineSpy.mockClear();
  disposeSpy.mockClear();
  extractorSpy.mockClear();
  vi.unstubAllEnvs();
  tempDir.cleanup();
});

describe("createEmbedder (local, mocked package)", () => {
  it("resolves the default model and dimensions when none is configured", async () => {
    const embedder = await createEmbedder({ provider: "local" });
    expect(embedder.id).toBe("local:nomic-ai/nomic-embed-text-v1.5");
    expect(embedder.dimensions).toBe(512);
    expect(pipelineSpy).toHaveBeenCalledWith(
      "feature-extraction",
      "nomic-ai/nomic-embed-text-v1.5",
      expect.objectContaining({ dtype: "q8" }),
    );
  });

  it("rejects an unknown model before loading anything", async () => {
    await expect(createEmbedder({ provider: "local", model: "not-a-real-model" })).rejects.toThrow(
      /Unknown local embedding model "not-a-real-model"\. Supported: nomic-ai\/nomic-embed-text-v1\.5/,
    );
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it("passes an explicit cacheDir straight through, taking priority over the env var", async () => {
    const explicitDir = `${tempDir.dir}-explicit`;
    try {
      await createEmbedder({ provider: "local", cacheDir: explicitDir });
      expect(fakeEnv.cacheDir).toBe(explicitDir);
    } finally {
      rmSync(explicitDir, { force: true, recursive: true });
    }
  });

  it("falls back to the SEMANTIC_LAYER_MODEL_CACHE_DIR env var when no cacheDir is configured", async () => {
    await createEmbedder({ provider: "local" });
    expect(fakeEnv.cacheDir).toBe(tempDir.dir);
  });

  it("falls back to ~/.cache/semantic-layer/models when nothing is configured", async () => {
    vi.stubEnv("SEMANTIC_LAYER_MODEL_CACHE_DIR", "");
    vi.stubEnv("XDG_CACHE_HOME", "");
    await createEmbedder({ provider: "local" });
    expect(fakeEnv.cacheDir).toContain("semantic-layer/models");
  });

  it("prefixes documents and queries with the model's task prefixes", async () => {
    const embedder = await createEmbedder({ provider: "local" });

    await embedder.embedDocuments(["alpha", "beta"]);
    expect(extractorSpy).toHaveBeenCalledWith(
      ["search_document: alpha", "search_document: beta"],
      expect.objectContaining({ pooling: "mean", normalize: true }),
    );

    await embedder.embedQuery("gamma");
    expect(extractorSpy).toHaveBeenCalledWith(
      ["search_query: gamma"],
      expect.objectContaining({ pooling: "mean", normalize: true }),
    );
  });

  it("truncates native vectors to 512 dims and renormalizes them to unit length", async () => {
    const embedder = await createEmbedder({ provider: "local" });

    const [vector] = await embedder.embedDocuments(["hello"]);
    if (!vector) throw new Error("expected a document vector");
    expect(vector).toHaveLength(512);
    expect(Array.isArray(vector)).toBe(true);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 10);

    const expected = nativeVector(1).slice(0, 512);
    const norm = Math.hypot(...expected);
    expect(vector).toEqual(expected.map((value) => value / norm));

    const queryVector = await embedder.embedQuery("hello");
    expect(queryVector).toHaveLength(512);
    expect(Math.hypot(...queryVector)).toBeCloseTo(1, 10);
  });

  it("wraps a pipeline-construction failure in LocalEmbedderUnavailableError", async () => {
    pipelineSpy.mockImplementationOnce(() => {
      throw new Error("native binding missing");
    });
    await expect(createEmbedder({ provider: "local" })).rejects.toThrow(
      /local embedding runtime .* is unavailable on this platform/,
    );
  });

  it("disposes the ONNX pipeline on close", async () => {
    const embedder = await createEmbedder({ provider: "local" });
    await embedder.close?.();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
