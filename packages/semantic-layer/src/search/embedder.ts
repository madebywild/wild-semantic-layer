import { DEFAULT_GEMINI_API_KEY_ENV } from "../config.js";
import type { SearchEmbeddingProviderConfig } from "../types.js";
import { createStaticEmbedder, describeStaticEmbedder } from "./static-embedder.js";

/**
 * Turns text into vectors. `embedDocuments`/`embedQuery` are separate (not one generic `embed`)
 * because Gemini's embedding API is asymmetric: passages and queries are embedded with different
 * task types, and collapsing this would silently degrade retrieval quality. The static embedder
 * is symmetric and implements both the same way.
 */
export type Embedder = {
  readonly id: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  /** Optional cleanup hook, e.g. for wrappers that hold a cache open. */
  close?(): Promise<void>;
};

/**
 * Thrown when an embedder cannot load, for example when the static model was never downloaded and
 * the machine is offline. The indexer then builds an FTS-only index instead of failing.
 */
export class EmbedderUnavailableError extends Error {
  constructor(cause: unknown, message: string) {
    super(message);
    this.name = "EmbedderUnavailableError";
    this.cause = cause;
  }
}

/**
 * Minimum cosine similarity a vector hit needs. Static (Model2Vec) cosines are not calibrated for a
 * fixed floor: unrelated text routinely scores 0.25-0.35 while many relevant chunks score below
 * 0.2, so any floor drops real matches. Static vector search therefore ranks without one, only
 * excluding anti-correlated chunks. Gemini keeps the historical 0.4 floor.
 */
export function vectorSimilarityFloor(embedderId: string): number {
  return embedderId.startsWith("static:") ? 0 : 0.4;
}

/**
 * Hybrid-mode pseudo-relevance feedback (Rocchio): after a first fused pass, the query vector is
 * moved toward the mean of the top `documents` chunk vectors by `weight`, and the vector side is
 * re-ranked. A static query costs microseconds to embed, so the second scan is the only cost.
 * Chosen on BEIR SciFact and confirmed on held-out NFCorpus and ArguAna for the static embedder
 * only, hence not applied to Gemini.
 */
export function pseudoRelevanceFeedback(
  embedderId: string,
): { documents: number; weight: number } | undefined {
  return embedderId.startsWith("static:") ? { documents: 3, weight: 0.5 } : undefined;
}

/** Builds the configured embedder. */
export async function createEmbedder(config: SearchEmbeddingProviderConfig): Promise<Embedder> {
  if (config.provider === "gemini") return createGeminiEmbedder(config);
  return createStaticEmbedder(config);
}

/**
 * The identity `createEmbedder` would resolve to for this config, computed without loading the
 * model or calling the network, for staleness checks that compare against the index metadata.
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
  return describeStaticEmbedder(config);
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
