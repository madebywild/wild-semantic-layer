import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GEMINI_API_KEY_ENV } from "../config.js";
import type { SearchEmbeddingProviderConfig } from "../types.js";

/**
 * Turns text into vectors. `embedDocuments`/`embedQuery` are separate (not one generic `embed`)
 * because BGE-family models and Gemini's embedding API are both asymmetric: passages and queries
 * are embedded differently, and collapsing this would silently degrade retrieval quality.
 */
export type Embedder = {
  readonly id: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
};

export const FASTEMBED_UNAVAILABLE_MESSAGE =
  "fastembed is unavailable on this platform — install a build toolchain, use a glibc-based " +
  "image, or set `search.embedding.provider: gemini` in your semantic-layer config.";

/** Thrown when the optional `fastembed` dependency fails to load (e.g. on musl/Alpine). */
export class FastEmbedUnavailableError extends Error {
  constructor(cause: unknown) {
    super(FASTEMBED_UNAVAILABLE_MESSAGE);
    this.name = "FastEmbedUnavailableError";
    this.cause = cause;
  }
}

/** Builds the configured embedder, lazily loading `fastembed` only when that provider is active. */
export async function createEmbedder(config: SearchEmbeddingProviderConfig): Promise<Embedder> {
  if (config.provider === "gemini") return createGeminiEmbedder(config);
  return createLocalFastEmbedEmbedder(config);
}

/**
 * The identity `createEmbedder` would resolve to for this config, computed without loading the
 * real model (no ONNX session, no network call) — for staleness checks that need to compare
 * against a manifest cheaply, not to actually embed anything.
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
  const model = config.model ?? DEFAULT_FASTEMBED_MODEL;
  return {
    id: `fastembed:${model}`,
    dimensions:
      FASTEMBED_MODEL_DIMENSIONS[model] ??
      FASTEMBED_MODEL_DIMENSIONS[DEFAULT_FASTEMBED_MODEL] ??
      384,
  };
}

const FASTEMBED_MODEL_DIMENSIONS: Record<string, number> = {
  "fast-all-MiniLM-L6-v2": 384,
  "fast-bge-base-en": 768,
  "fast-bge-base-en-v1.5": 768,
  "fast-bge-small-en": 384,
  "fast-bge-small-en-v1.5": 384,
  "fast-bge-small-zh-v1.5": 512,
  "fast-multilingual-e5-large": 1024,
};

const DEFAULT_FASTEMBED_MODEL = "fast-bge-small-en-v1.5";

async function createLocalFastEmbedEmbedder(
  config: Extract<SearchEmbeddingProviderConfig, { provider: "fastembed" }>,
): Promise<Embedder> {
  let fastembed: typeof import("fastembed");
  try {
    fastembed = await import("fastembed");
  } catch (cause) {
    throw new FastEmbedUnavailableError(cause);
  }

  const { FlagEmbedding, EmbeddingModel } = fastembed;
  const model = resolveFastEmbedModel(config.model, EmbeddingModel);
  const dimensions =
    FASTEMBED_MODEL_DIMENSIONS[model] ?? FASTEMBED_MODEL_DIMENSIONS[DEFAULT_FASTEMBED_MODEL];
  if (dimensions === undefined)
    throw new Error(`fastembed model "${model}" has no known dimensions`);
  const cacheDir = resolveFastEmbedCacheDir(config.cacheDir);
  // fastembed's own cache setup expects the directory to already exist (it doesn't mkdir
  // recursively), so a fresh machine with no ~/.cache/semantic-layer yet fails otherwise.
  mkdirSync(cacheDir, { recursive: true });

  console.error(
    `semantic-layer: loading local fastembed model "${model}" (first run downloads it to ` +
      `${cacheDir}; cached on disk afterward).`,
  );
  const instance = await FlagEmbedding.init({ model, cacheDir });

  return {
    id: `fastembed:${model}`,
    dimensions,
    embedDocuments: (texts) => collectBatches(instance.passageEmbed(texts)),
    // fastembed returns Float32Array vectors; Orama's vector validation rejects them even though
    // `.length` matches the declared dimension, so every vector must be converted to a plain array.
    embedQuery: async (text) => Array.from(await instance.queryEmbed(text)),
  };
}

async function collectBatches(
  batches: AsyncGenerator<number[][], void, unknown>,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for await (const batch of batches) {
    for (const vector of batch) vectors.push(Array.from(vector));
  }
  return vectors;
}

type FastEmbedStandardModel = Exclude<
  import("fastembed").EmbeddingModel,
  import("fastembed").EmbeddingModel.CUSTOM
>;

function resolveFastEmbedModel(
  model: string | undefined,
  EmbeddingModel: typeof import("fastembed").EmbeddingModel,
): FastEmbedStandardModel {
  const supported = Object.values(EmbeddingModel).filter(
    (value): value is FastEmbedStandardModel => value !== EmbeddingModel.CUSTOM,
  );
  if (!model) return EmbeddingModel.BGESmallENV15;
  const match = supported.find((value) => value === model);
  if (!match) {
    throw new Error(`Unknown fastembed model "${model}". Supported: ${supported.join(", ")}.`);
  }
  return match;
}

function resolveFastEmbedCacheDir(configCacheDir: string | undefined): string {
  if (configCacheDir) return configCacheDir;
  if (process.env.SEMANTIC_LAYER_FASTEMBED_CACHE_DIR) {
    return process.env.SEMANTIC_LAYER_FASTEMBED_CACHE_DIR;
  }
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "semantic-layer", "fastembed");
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
