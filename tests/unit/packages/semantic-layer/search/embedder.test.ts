import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbedder } from "../../../../../packages/semantic-layer/src/search/embedder.js";

const REAL_FASTEMBED_ENV = "SEMANTIC_LAYER_TEST_REAL_FASTEMBED";

function stubFetchOnce(response: { ok: boolean; status?: number; body: unknown }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(JSON.stringify(response.body)),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createEmbedder (gemini)", () => {
  it("throws a clear error when no API key is configured", async () => {
    vi.stubEnv("SEMANTIC_LAYER_GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    await expect(createEmbedder({ provider: "gemini" })).rejects.toThrow(/requires an API key/);
  });

  it("uses the default env var for the API key", async () => {
    vi.stubEnv("SEMANTIC_LAYER_GEMINI_API_KEY", "default-key");
    const fetchMock = stubFetchOnce({ ok: true, body: { embeddings: [{ values: [0.1, 0.2] }] } });
    const embedder = await createEmbedder({ provider: "gemini" });
    await embedder.embedQuery("hello");

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("default-key");
  });

  it("falls back to GEMINI_API_KEY when the namespaced env var is unset", async () => {
    vi.stubEnv("SEMANTIC_LAYER_GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "fallback-key");
    const fetchMock = stubFetchOnce({ ok: true, body: { embeddings: [{ values: [0.1] }] } });
    const embedder = await createEmbedder({ provider: "gemini" });
    await embedder.embedQuery("hello");

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("fallback-key");
  });

  it("honors a custom apiKeyEnv override", async () => {
    vi.stubEnv("CUSTOM_GEMINI_KEY", "custom-key");
    const fetchMock = stubFetchOnce({ ok: true, body: { embeddings: [{ values: [0.1] }] } });
    const embedder = await createEmbedder({ provider: "gemini", apiKeyEnv: "CUSTOM_GEMINI_KEY" });
    await embedder.embedQuery("hello");

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("custom-key");
  });

  it("reflects a model override in id and request URL", async () => {
    vi.stubEnv("SEMANTIC_LAYER_GEMINI_API_KEY", "key");
    const fetchMock = stubFetchOnce({ ok: true, body: { embeddings: [{ values: [0.1] }] } });
    const embedder = await createEmbedder({ provider: "gemini", model: "text-embedding-004" });
    expect(embedder.id).toBe("gemini:text-embedding-004");

    await embedder.embedQuery("hello");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("models/text-embedding-004:batchEmbedContents");
  });

  it("embeds documents with the RETRIEVAL_DOCUMENT task type and preserves vector order", async () => {
    vi.stubEnv("SEMANTIC_LAYER_GEMINI_API_KEY", "key");
    const fetchMock = stubFetchOnce({
      ok: true,
      body: { embeddings: [{ values: [1, 2] }, { values: [3, 4] }] },
    });
    const embedder = await createEmbedder({ provider: "gemini" });
    const vectors = await embedder.embedDocuments(["a", "b"]);

    expect(vectors).toEqual([
      [1, 2],
      [3, 4],
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0].embedContentConfig.taskType).toBe("RETRIEVAL_DOCUMENT");
    expect(body.requests[0].content.parts[0].text).toBe("a");
  });

  it("embeds queries with the RETRIEVAL_QUERY task type", async () => {
    vi.stubEnv("SEMANTIC_LAYER_GEMINI_API_KEY", "key");
    const fetchMock = stubFetchOnce({ ok: true, body: { embeddings: [{ values: [9, 9] }] } });
    const embedder = await createEmbedder({ provider: "gemini" });
    const vector = await embedder.embedQuery("query text");

    expect(vector).toEqual([9, 9]);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.requests[0].embedContentConfig.taskType).toBe("RETRIEVAL_QUERY");
  });

  it("splits large document batches across multiple requests", async () => {
    vi.stubEnv("SEMANTIC_LAYER_GEMINI_API_KEY", "key");
    const texts = Array.from({ length: 150 }, (_, i) => `doc-${i}`);
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const requestBody = JSON.parse(init.body as string) as { requests: unknown[] };
      const embeddings = requestBody.requests.map(() => ({ values: [1] }));
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ embeddings }),
        text: () => Promise.resolve(""),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const embedder = await createEmbedder({ provider: "gemini" });
    const vectors = await embedder.embedDocuments(texts);

    expect(vectors).toHaveLength(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an empty array without calling fetch for an empty document list", async () => {
    vi.stubEnv("SEMANTIC_LAYER_GEMINI_API_KEY", "key");
    const fetchMock = stubFetchOnce({ ok: true, body: { embeddings: [] } });
    const embedder = await createEmbedder({ provider: "gemini" });
    const vectors = await embedder.embedDocuments([]);

    expect(vectors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a clear error on a failed HTTP response", async () => {
    vi.stubEnv("SEMANTIC_LAYER_GEMINI_API_KEY", "key");
    stubFetchOnce({ ok: false, status: 429, body: { error: "rate limited" } });
    const embedder = await createEmbedder({ provider: "gemini" });
    await expect(embedder.embedQuery("hello")).rejects.toThrow(
      /Gemini embeddings request failed \(429\)/,
    );
  });

  it("defaults dimensions to gemini-embedding-001's 3072", async () => {
    vi.stubEnv("SEMANTIC_LAYER_GEMINI_API_KEY", "key");
    const embedder = await createEmbedder({ provider: "gemini" });
    expect(embedder.id).toBe("gemini:gemini-embedding-001");
    expect(embedder.dimensions).toBe(3072);
  });
});

describe("createEmbedder (fastembed)", () => {
  it("throws a clear, actionable error for an unrecognized model without touching the network", async () => {
    // On a platform where fastembed itself fails to load (e.g. Alpine/musl), the availability
    // guard fires first — accept either outcome so this test isn't platform-dependent.
    await expect(
      createEmbedder({ provider: "fastembed", model: "not-a-real-model" }),
    ).rejects.toThrow(
      /Unknown fastembed model "not-a-real-model"|fastembed is unavailable on this platform/,
    );
  });

  it.skipIf(!process.env[REAL_FASTEMBED_ENV])(
    "loads the real local model and embeds text (opt-in, network + ONNX required)",
    async () => {
      const embedder = await createEmbedder({ provider: "fastembed" });
      expect(embedder.id).toBe("fastembed:fast-bge-small-en-v1.5");
      expect(embedder.dimensions).toBe(384);

      const [vector] = await embedder.embedDocuments(["hello world"]);
      expect(vector).toHaveLength(384);
      // fastembed itself returns Float32Array; Orama's vector validation rejects that even
      // though `.length` matches, so this must come back as a plain array.
      expect(Array.isArray(vector)).toBe(true);

      const queryVector = await embedder.embedQuery("hello");
      expect(queryVector).toHaveLength(384);
      expect(Array.isArray(queryVector)).toBe(true);
    },
    60_000,
  );
});
