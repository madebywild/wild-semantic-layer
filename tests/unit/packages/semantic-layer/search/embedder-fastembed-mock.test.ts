import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDir } from "../../../../helpers.js";

// Mocks the `fastembed` package itself (not our own embedder.ts) so the model-resolution,
// cache-dir-resolution, and vector-conversion logic in `createLocalFastEmbedEmbedder` can be
// exercised fast and deterministically — no real ONNX session, no model download. This is
// distinct from the opt-in `SEMANTIC_LAYER_TEST_REAL_FASTEMBED` test in embedder.test.ts, which
// intentionally uses the real package to catch real-world integration issues.
const initSpy = vi.fn();

const FakeEmbeddingModel = {
  AllMiniLML6V2: "fast-all-MiniLM-L6-v2",
  BGEBaseEN: "fast-bge-base-en",
  BGEBaseENV15: "fast-bge-base-en-v1.5",
  BGESmallEN: "fast-bge-small-en",
  BGESmallENV15: "fast-bge-small-en-v1.5",
  BGESmallZH: "fast-bge-small-zh-v1.5",
  MLE5Large: "fast-multilingual-e5-large",
  CUSTOM: "custom",
};

class FakeFlagEmbedding {
  static async init(options: unknown) {
    initSpy(options);
    return new FakeFlagEmbedding();
  }

  // fastembed's real methods yield/return Float32Array, not plain arrays — replicate that here so
  // this test also covers the Array.from(...) conversion embedder.ts applies to both.
  async *passageEmbed(texts: string[]) {
    yield texts.map(() => new Float32Array([1, 2, 3, 4]));
  }

  async queryEmbed(_text: string) {
    return new Float32Array([5, 6, 7, 8]);
  }
}

vi.mock("fastembed", () => ({
  FlagEmbedding: FakeFlagEmbedding,
  EmbeddingModel: FakeEmbeddingModel,
}));

const { createEmbedder } = await import(
  "../../../../../packages/semantic-layer/src/search/embedder.js"
);

let tempDir: { dir: string; cleanup: () => void };

beforeEach(() => {
  // Default every test to a throwaway cache dir, so `mkdirSync` never touches the real home
  // directory unless a test explicitly wants to exercise that fallback (see below).
  tempDir = createTempDir();
  vi.stubEnv("SEMANTIC_LAYER_FASTEMBED_CACHE_DIR", tempDir.dir);
});

afterEach(() => {
  initSpy.mockClear();
  vi.unstubAllEnvs();
  tempDir.cleanup();
});

describe("createEmbedder (fastembed, mocked package)", () => {
  it("resolves the default model and dimensions when none is configured", async () => {
    const embedder = await createEmbedder({ provider: "fastembed" });
    expect(embedder.id).toBe("fastembed:fast-bge-small-en-v1.5");
    expect(embedder.dimensions).toBe(384);
    expect(initSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: "fast-bge-small-en-v1.5" }),
    );
  });

  it("resolves an explicitly configured, valid model and its dimensions", async () => {
    const embedder = await createEmbedder({ provider: "fastembed", model: "fast-bge-base-en" });
    expect(embedder.id).toBe("fastembed:fast-bge-base-en");
    expect(embedder.dimensions).toBe(768);
    expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({ model: "fast-bge-base-en" }));
  });

  it("passes an explicit cacheDir straight through, taking priority over the env var", async () => {
    const explicitDir = `${tempDir.dir}-explicit`;
    try {
      await createEmbedder({ provider: "fastembed", cacheDir: explicitDir });
      expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({ cacheDir: explicitDir }));
    } finally {
      rmSync(explicitDir, { force: true, recursive: true });
    }
  });

  it("falls back to the SEMANTIC_LAYER_FASTEMBED_CACHE_DIR env var when no cacheDir is configured", async () => {
    await createEmbedder({ provider: "fastembed" });
    expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({ cacheDir: tempDir.dir }));
  });

  it("falls back to ~/.cache/semantic-layer/fastembed when nothing is configured", async () => {
    vi.stubEnv("SEMANTIC_LAYER_FASTEMBED_CACHE_DIR", "");
    vi.stubEnv("XDG_CACHE_HOME", "");
    await createEmbedder({ provider: "fastembed" });
    const call = initSpy.mock.calls[0]?.[0] as { cacheDir: string };
    expect(call.cacheDir).toContain("semantic-layer/fastembed");
  });

  it("converts fastembed's Float32Array outputs to plain arrays for both documents and queries", async () => {
    const embedder = await createEmbedder({ provider: "fastembed" });

    const [vector] = await embedder.embedDocuments(["hello"]);
    expect(vector).toEqual([1, 2, 3, 4]);
    expect(Array.isArray(vector)).toBe(true);

    const queryVector = await embedder.embedQuery("hello");
    expect(queryVector).toEqual([5, 6, 7, 8]);
    expect(Array.isArray(queryVector)).toBe(true);
  });
});
