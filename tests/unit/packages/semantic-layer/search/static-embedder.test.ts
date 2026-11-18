import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeConfiguredEmbedder,
  LocalEmbedderUnavailableError,
  vectorSimilarityFloor,
} from "../../../../../packages/semantic-layer/src/search/embedder.js";
import {
  buildStaticEmbedder,
  createStaticEmbedder,
  loadStaticEmbedder,
  type StaticModelSpec,
} from "../../../../../packages/semantic-layer/src/search/static-embedder.js";
import { loadWordPieceTokenizer } from "../../../../../packages/semantic-layer/src/search/wordpiece.js";

const VOCAB = [
  "[PAD]",
  "[UNK]",
  "[CLS]",
  "[SEP]",
  "hello",
  "world",
  "##s",
  "cafe",
  "!",
  "fetch",
  "##priority",
];

function tokenizerJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    normalizer: {
      type: "BertNormalizer",
      clean_text: true,
      handle_chinese_chars: true,
      strip_accents: null,
      lowercase: true,
    },
    pre_tokenizer: { type: "BertPreTokenizer" },
    model: {
      type: "WordPiece",
      unk_token: "[UNK]",
      continuing_subword_prefix: "##",
      max_input_chars_per_word: 100,
      vocab: Object.fromEntries(VOCAB.map((token, id) => [token, id])),
    },
    ...overrides,
  });
}

/** A Model2Vec-shaped safetensors file holding one 2-D F32 `embeddings` tensor. */
function safetensors(rows: number[][]): Buffer {
  const dims = rows[0]?.length ?? 0;
  const data = Buffer.from(new Float32Array(rows.flat()).buffer);
  // Odd header length on purpose: the data section then starts at a non-4-byte-aligned offset.
  const json = JSON.stringify({
    embeddings: { dtype: "F32", shape: [rows.length, dims], data_offsets: [0, data.length] },
  });
  const header = Buffer.from(`${json} `);
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([length, header, data]);
}

/** Row i is the one-hot vector for dimension i mod 4, scaled so quantization error shows up. */
function oneHotRows(): number[][] {
  return VOCAB.map((_, id) => [0, 1, 2, 3].map((dim) => (dim === id % 4 ? 0.5 + id / 100 : 0.01)));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("loadWordPieceTokenizer", () => {
  const tokenizer = loadWordPieceTokenizer(tokenizerJson());

  it("lowercases, strips accents, splits punctuation, and continues subwords", () => {
    expect(tokenizer.encode("Hello Worlds! Café")).toEqual([4, 5, 6, 8, 7]);
    expect(tokenizer.encode("fetchpriority")).toEqual([9, 10]);
  });

  it("maps a word with no full WordPiece cover to [UNK]", () => {
    expect(tokenizer.encode("hellox world")).toEqual([1, 5]);
  });

  it("drops control characters and treats any Unicode whitespace as a separator", () => {
    expect(tokenizer.encode("hello\u0000 world​")).toEqual([4, 5]);
  });

  it("rejects tokenizers it does not implement instead of tokenizing differently", () => {
    expect(() =>
      loadWordPieceTokenizer(tokenizerJson({ model: { type: "BPE", vocab: {} } })),
    ).toThrow(/unsupported tokenizer model/);
    expect(() => loadWordPieceTokenizer(tokenizerJson({ normalizer: null }))).toThrow(
      /unsupported tokenizer normalizer/,
    );
    expect(() =>
      loadWordPieceTokenizer(tokenizerJson({ pre_tokenizer: { type: "Whitespace" } })),
    ).toThrow(/unsupported tokenizer pre_tokenizer/);
    expect(() =>
      loadWordPieceTokenizer(
        tokenizerJson({ model: { type: "WordPiece", unk_token: "[NOPE]", vocab: { a: 0 } } }),
      ),
    ).toThrow(/no unk token/);
  });

  it("isolates CJK characters and maps over-long words to [UNK]", () => {
    expect(tokenizer.encode("hello中world")).toEqual([4, 1, 5]);
    expect(tokenizer.encode(`${"hello".repeat(30)} world`)).toEqual([1, 5]);
  });

  it("applies Hugging Face defaults when optional tokenizer fields are absent", () => {
    const minimal = loadWordPieceTokenizer(
      JSON.stringify({
        normalizer: { type: "BertNormalizer" },
        pre_tokenizer: { type: "BertPreTokenizer" },
        model: { type: "WordPiece", vocab: Object.fromEntries(VOCAB.map((t, id) => [t, id])) },
      }),
    );
    expect(minimal.encode("Hello Worlds! Café 中")).toEqual([4, 5, 6, 8, 7, 1]);
    // Repeated words come from the memo and must not change the result.
    expect(minimal.encode("hello hello")).toEqual([4, 4]);
  });

  it("leaves control and CJK characters alone when cleaning and CJK padding are off", () => {
    const raw = loadWordPieceTokenizer(
      tokenizerJson({
        normalizer: { type: "BertNormalizer", clean_text: false, handle_chinese_chars: false },
      }),
    );
    expect(raw.encode("hello\u0001world")).toEqual([1]);
    expect(raw.encode("hello中")).toEqual([1]);
  });

  it("keeps case and accents when the normalizer disables lowercasing", () => {
    const cased = loadWordPieceTokenizer(
      tokenizerJson({
        normalizer: { type: "BertNormalizer", lowercase: false, strip_accents: false },
      }),
    );
    expect(cased.encode("hello Hello")).toEqual([4, 1]);
  });
});

describe("buildStaticEmbedder", () => {
  it("returns the normalized mean of known token rows, ignoring unknown words", async () => {
    const embedder = buildStaticEmbedder(
      "static:test",
      4,
      tokenizerJson(),
      safetensors(oneHotRows()),
    );
    const [vector] = await embedder.embedDocuments(["hello unknownword world"]);
    const rows = oneHotRows();
    const mean = [0, 1, 2, 3].map((dim) => ((rows[4]?.[dim] ?? 0) + (rows[5]?.[dim] ?? 0)) / 2);
    const norm = Math.hypot(...mean);
    for (const [dim, value] of (vector ?? []).entries()) {
      // Int8 per-row quantization keeps every component within 1% of the Float32 result.
      expect(value).toBeCloseTo((mean[dim] ?? 0) / norm, 2);
    }
    expect(Math.hypot(...(vector ?? []))).toBeCloseTo(1, 6);
  });

  it("embeds queries and documents identically (symmetric model)", async () => {
    const embedder = buildStaticEmbedder(
      "static:test",
      4,
      tokenizerJson(),
      safetensors(oneHotRows()),
    );
    const [document] = await embedder.embedDocuments(["fetchpriority"]);
    expect(await embedder.embedQuery("fetchpriority")).toEqual(document);
  });

  it("returns a zero vector when no token is known", async () => {
    const embedder = buildStaticEmbedder(
      "static:test",
      4,
      tokenizerJson(),
      safetensors(oneHotRows()),
    );
    expect(await embedder.embedQuery("zzz")).toEqual([0, 0, 0, 0]);
  });

  it("caps a text at 512 known tokens like Model2Vec's reference encoder", async () => {
    const embedder = buildStaticEmbedder(
      "static:test",
      4,
      tokenizerJson(),
      safetensors(oneHotRows()),
    );
    const long = `${"hello ".repeat(512)}${"world ".repeat(100)}`;
    expect(await embedder.embedQuery(long)).toEqual(await embedder.embedQuery("hello"));
  });

  it("rejects a safetensors file without a 2-D F32 embeddings tensor", () => {
    const header = Buffer.from(
      JSON.stringify({ embeddings: { dtype: "F16", shape: [1, 1], data_offsets: [0, 2] } }),
    );
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(header.length));
    const file = Buffer.concat([length, header, Buffer.alloc(2)]);
    expect(() => buildStaticEmbedder("static:test", 1, tokenizerJson(), file)).toThrow(
      /no 2-D F32 `embeddings` tensor/,
    );
  });

  it("rejects a table whose row count does not match the vocabulary", () => {
    expect(() =>
      buildStaticEmbedder("static:test", 4, tokenizerJson(), safetensors(oneHotRows().slice(1))),
    ).toThrow(/embedding rows but/);
  });
});

describe("createStaticEmbedder", () => {
  it("rejects a download whose SHA-256 does not match the pinned file", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "static-embedder-"));
    try {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
      );
      const error = await createStaticEmbedder({ provider: "static", cacheDir }).catch((e) => e);
      expect(error).toBeInstanceOf(LocalEmbedderUnavailableError);
      expect((error as Error).cause).toMatchObject({
        message: expect.stringMatching(/SHA-256 mismatch/),
      });
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("degrades like an unavailable local runtime when offline", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "static-embedder-"));
    try {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
      await expect(createStaticEmbedder({ provider: "static", cacheDir })).rejects.toBeInstanceOf(
        LocalEmbedderUnavailableError,
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("resolves the cache directory from the env, then XDG_CACHE_HOME", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    vi.stubEnv("SEMANTIC_LAYER_MODEL_CACHE_DIR", join(tmpdir(), "sl-env-cache"));
    await expect(createStaticEmbedder({ provider: "static" })).rejects.toThrow(/sl-env-cache/);
    vi.stubEnv("SEMANTIC_LAYER_MODEL_CACHE_DIR", "");
    vi.stubEnv("XDG_CACHE_HOME", join(tmpdir(), "sl-xdg-cache"));
    await expect(createStaticEmbedder({ provider: "static" })).rejects.toThrow(
      /sl-xdg-cache.semantic-layer.models/,
    );
    rmSync(join(tmpdir(), "sl-env-cache"), { recursive: true, force: true });
    rmSync(join(tmpdir(), "sl-xdg-cache"), { recursive: true, force: true });
  });

  it("rejects unpinned models", async () => {
    await expect(
      createStaticEmbedder({ provider: "static", model: "acme/unknown" }),
    ).rejects.toThrow(/Unknown static embedding model/);
  });
});

describe("loadStaticEmbedder cache cycle", () => {
  const tokenizer = Buffer.from(tokenizerJson());
  const weights = safetensors(oneHotRows());
  const spec: StaticModelSpec = {
    revision: "rev1",
    dimensions: 4,
    files: {
      "model.safetensors": createHash("sha256").update(weights).digest("hex"),
      "tokenizer.json": createHash("sha256").update(tokenizer).digest("hex"),
    },
  };

  function serveModel() {
    const fetchMock = vi.fn(async (url: string) => {
      const body = url.endsWith("tokenizer.json") ? tokenizer : weights;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("downloads once, keeps an Int8 table instead of the safetensors, and reloads offline", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "static-embedder-"));
    try {
      const fetchMock = serveModel();
      const first = await loadStaticEmbedder("acme/tiny", spec, cacheDir);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[0]).toMatch(/huggingface\.co\/acme\/tiny\/resolve\/rev1\//);
      const dir = join(cacheDir, "acme/tiny", "rev1");
      expect(readdirSync(dir).sort()).toEqual(["embeddings.i8", "tokenizer.json"]);

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
      const second = await loadStaticEmbedder("acme/tiny", spec, cacheDir);
      expect(second.id).toBe("static:acme/tiny");
      expect(await second.embedQuery("hello worlds")).toEqual(
        await first.embedQuery("hello worlds"),
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("ignores an Int8 table that does not belong to the pinned model and rebuilds it", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "static-embedder-"));
    try {
      serveModel();
      await loadStaticEmbedder("acme/tiny", spec, cacheDir);
      const table = join(cacheDir, "acme/tiny", "rev1", "embeddings.i8");
      const original = readFileSync(table);
      writeFileSync(table, Buffer.concat([Buffer.from("XXXX"), original.subarray(4)]));

      const fetchMock = serveModel();
      await loadStaticEmbedder("acme/tiny", spec, cacheDir);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(readFileSync(table).equals(original)).toBe(true);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("rebuilds a truncated Int8 table", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "static-embedder-"));
    try {
      serveModel();
      await loadStaticEmbedder("acme/tiny", spec, cacheDir);
      const table = join(cacheDir, "acme/tiny", "rev1", "embeddings.i8");
      const original = readFileSync(table);
      writeFileSync(table, original.subarray(0, 10));
      serveModel();
      await loadStaticEmbedder("acme/tiny", spec, cacheDir);
      expect(readFileSync(table).equals(original)).toBe(true);
      writeFileSync(table, original.subarray(0, original.length - 1));
      serveModel();
      await loadStaticEmbedder("acme/tiny", spec, cacheDir);
      expect(readFileSync(table).equals(original)).toBe(true);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("re-downloads a cached file whose hash no longer matches", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "static-embedder-"));
    try {
      serveModel();
      await loadStaticEmbedder("acme/tiny", spec, cacheDir);
      const tokenizerPath = join(cacheDir, "acme/tiny", "rev1", "tokenizer.json");
      writeFileSync(tokenizerPath, "{}");
      const fetchMock = serveModel();
      await loadStaticEmbedder("acme/tiny", spec, cacheDir);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(existsSync(tokenizerPath)).toBe(true);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("reports an HTTP failure as an unavailable embedder", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "static-embedder-"));
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      const error = await loadStaticEmbedder("acme/tiny", spec, cacheDir).catch((e) => e);
      expect(error).toBeInstanceOf(LocalEmbedderUnavailableError);
      expect((error as Error).cause).toMatchObject({ message: expect.stringMatching(/404/) });
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe("static embedder identity and floor", () => {
  it("describes the default model without loading it", () => {
    expect(describeConfiguredEmbedder({ provider: "static" })).toEqual({
      id: "static:minishlab/potion-retrieval-32M",
      dimensions: 512,
    });
  });

  it("keeps the 0.4 floor for nomic and ranks static vectors without one", () => {
    expect(vectorSimilarityFloor("local:nomic-ai/nomic-embed-text-v1.5")).toBe(0.4);
    expect(vectorSimilarityFloor("static:minishlab/potion-retrieval-32M")).toBe(0);
  });
});
