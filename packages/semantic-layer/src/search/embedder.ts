import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GEMINI_API_KEY_ENV } from "../config.js";
import type { SearchEmbeddingProviderConfig } from "../types.js";

/**
 * Turns text into vectors. `embedDocuments`/`embedQuery` are separate (not one generic `embed`)
 * because the local nomic model and Gemini's embedding API are both asymmetric: passages and
 * queries are embedded differently, and collapsing this would silently degrade retrieval quality.
 */
export type Embedder = {
  readonly id: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  /** Optional cleanup hook. Local embedders release the native ONNX pipeline. */
  close?(): Promise<void>;
};

export const LOCAL_EMBEDDER_UNAVAILABLE_MESSAGE =
  "the local embedding runtime (@huggingface/transformers) is unavailable on this platform — " +
  "install a build toolchain, use a glibc-based image, or set `search.embedding.provider: " +
  "gemini` in your semantic-layer config.";

/** Thrown when the optional `@huggingface/transformers` dependency fails to load (e.g. on musl/Alpine). */
export class LocalEmbedderUnavailableError extends Error {
  constructor(cause: unknown) {
    super(LOCAL_EMBEDDER_UNAVAILABLE_MESSAGE);
    this.name = "LocalEmbedderUnavailableError";
    this.cause = cause;
  }
}

/** Builds the configured embedder, lazily loading the local runtime only when that provider is active. */
export async function createEmbedder(config: SearchEmbeddingProviderConfig): Promise<Embedder> {
  if (config.provider === "gemini") return createGeminiEmbedder(config);
  return createLocalEmbedder(config);
}

/**
 * The identity `createEmbedder` would resolve to for this config, computed without loading the
 * real model (no ONNX session, no network call) — for staleness checks that need to compare
 * against the index meta sidecar cheaply, not to actually embed anything.
 */
export function describeConfiguredEmbedder(config: SearchEmbeddingProviderConfig): {
  id: string;
  dimensions: number;
} {
  if (config.provider === "gemini") {
    return {
      id: `gemini:${config.model ?? DEFAULT_GEMINI_MODEL}`,
      dimensions: DEFAULT_GEMINI_DIMENSIONS,
    };
  }
  const model = config.model ?? DEFAULT_LOCAL_MODEL;
  return {
    id: `local:${model}`,
    dimensions: LOCAL_MODEL_DIMENSIONS[model] ?? LOCAL_MODEL_DIMENSIONS[DEFAULT_LOCAL_MODEL] ?? 512,
  };
}

/**
 * Effective dimensions per supported local model, after any truncation applied below. Only
 * models listed here are accepted: `describeConfiguredEmbedder` must know the dimensions without
 * loading the model, and truncation is only sound for Matryoshka-trained models.
 */
const LOCAL_MODEL_DIMENSIONS: Record<string, number> = {
  // nomic-embed-text-v1.5 natively emits 768 dims; it is Matryoshka-trained, so truncating to a
  // trained breakpoint (768/512/256/128/64) + renormalizing keeps retrieval quality nearly intact.
  "nomic-ai/nomic-embed-text-v1.5": 512,
};

const DEFAULT_LOCAL_MODEL = "nomic-ai/nomic-embed-text-v1.5";

/**
 * nomic-embed-text-v1.5 is asymmetric: it expects a task prefix on every input. These map onto
 * the Embedder split — documents at index time, queries at search time.
 */
const LOCAL_DOCUMENT_PREFIX = "search_document: ";
const LOCAL_QUERY_PREFIX = "search_query: ";

async function createLocalEmbedder(
  config: Extract<SearchEmbeddingProviderConfig, { provider: "local" }>,
): Promise<Embedder> {
  const model = resolveLocalModel(config.model);
  const dimensions = LOCAL_MODEL_DIMENSIONS[model];
  if (dimensions === undefined) throw new Error(`local model "${model}" has no known dimensions`);

  let transformers: typeof import("@huggingface/transformers");
  let extractor: import("@huggingface/transformers").FeatureExtractionPipeline;
  const cacheDir = resolveLocalCacheDir(config.cacheDir);
  try {
    transformers = await import("@huggingface/transformers");
    // transformers.js' own cache setup expects the directory to already exist (it doesn't mkdir
    // recursively), so a fresh machine with no ~/.cache/semantic-layer yet fails otherwise.
    mkdirSync(cacheDir, { recursive: true });
    transformers.env.cacheDir = cacheDir;

    console.error(
      `semantic-layer: loading local embedding model "${model}" (first run downloads it to ` +
        `${cacheDir}; cached on disk afterward).`,
    );
    // Pipeline creation is inside the try too: onnxruntime-node's native binding can fail to
    // load here (not just at import) on musl/Alpine, and that must hit the same FTS-only degrade.
    extractor = await transformers.pipeline("feature-extraction", model, { dtype: "q8" });
  } catch (cause) {
    throw new LocalEmbedderUnavailableError(cause);
  }

  const embed = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return (output.tolist() as number[][]).map((vector) =>
      truncateAndRenormalize(vector, dimensions),
    );
  };

  return {
    id: `local:${model}`,
    dimensions,
    embedDocuments: (texts) => embed(texts.map((text) => `${LOCAL_DOCUMENT_PREFIX}${text}`)),
    embedQuery: async (text) => {
      const [vector] = await embed([`${LOCAL_QUERY_PREFIX}${text}`]);
      if (!vector) throw new Error("local embedder did not return a vector");
      return vector;
    },
    close: async () => {
      // Releasing the ONNX pipeline frees the native session before process exit.
      await (extractor as { dispose?: () => Promise<void> }).dispose?.();
    },
  };
}

/**
 * Truncating a Matryoshka-trained embedding to a lower dimension requires renormalizing: the
 * model is trained so each prefix is unit-norm on its own, and vector search assumes unit vectors.
 */
function truncateAndRenormalize(vector: number[], dimensions: number): number[] {
  if (vector.length <= dimensions) return vector;
  const truncated = vector.slice(0, dimensions);
  const norm = Math.hypot(...truncated);
  return norm === 0 ? truncated : truncated.map((value) => value / norm);
}

function resolveLocalModel(model: string | undefined): string {
  if (!model) return DEFAULT_LOCAL_MODEL;
  if (!(model in LOCAL_MODEL_DIMENSIONS)) {
    throw new Error(
      `Unknown local embedding model "${model}". Supported: ${Object.keys(LOCAL_MODEL_DIMENSIONS).join(", ")}.`,
    );
  }
  return model;
}

function resolveLocalCacheDir(configCacheDir: string | undefined): string {
  if (configCacheDir) return configCacheDir;
  if (process.env.SEMANTIC_LAYER_MODEL_CACHE_DIR) {
    return process.env.SEMANTIC_LAYER_MODEL_CACHE_DIR;
  }
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "semantic-layer", "models");
}

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_MODEL = "gemini-embedding-001";
const DEFAULT_GEMINI_DIMENSIONS = 3072;
const GEMINI_BATCH_SIZE = 100;

type GeminiTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/** Treats an empty-string env var the same as an unset one, so a blank override doesn't silently win. */
function envOrUndefined(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

function createGeminiEmbedder(
  config: Extract<SearchEmbeddingProviderConfig, { provider: "gemini" }>,
): Embedder {
  const model = config.model ?? DEFAULT_GEMINI_MODEL;
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_GEMINI_API_KEY_ENV;
  const apiKey = envOrUndefined(apiKeyEnv) ?? envOrUndefined("GEMINI_API_KEY");
  if (!apiKey) {
    throw new Error(`Gemini embedder requires an API key: set ${apiKeyEnv} or GEMINI_API_KEY.`);
  }

  return {
    id: `gemini:${model}`,
    dimensions: DEFAULT_GEMINI_DIMENSIONS,
    embedDocuments: (texts) => embedGeminiBatched(model, apiKey, texts, "RETRIEVAL_DOCUMENT"),
    embedQuery: async (text) => {
      const [vector] = await embedGeminiBatched(model, apiKey, [text], "RETRIEVAL_QUERY");
      if (!vector) throw new Error("Gemini embeddings response did not include a vector");
      return vector;
    },
  };
}

async function embedGeminiBatched(
  model: string,
  apiKey: string,
  texts: string[],
  taskType: GeminiTaskType,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += GEMINI_BATCH_SIZE) {
    const slice = texts.slice(offset, offset + GEMINI_BATCH_SIZE);
    vectors.push(...(await embedGeminiBatch(model, apiKey, slice, taskType)));
  }
  return vectors;
}

async function embedGeminiBatch(
  model: string,
  apiKey: string,
  texts: string[],
  taskType: GeminiTaskType,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await fetch(`${GEMINI_API_BASE}/models/${model}:batchEmbedContents`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        embedContentConfig: { taskType },
      })),
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Gemini embeddings request failed (${response.status}): ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { embeddings?: Array<{ values: number[] }> };
  return (body.embeddings ?? []).map((entry) => entry.values);
}
