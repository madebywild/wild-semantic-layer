import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SearchEmbeddingProviderConfig } from "../types.js";
import { type Embedder, EmbedderUnavailableError } from "./embedder.js";
import { loadWordPieceTokenizer, type WordPieceTokenizer } from "./wordpiece.js";

/**
 * Static (Model2Vec) embedder: a text's vector is the normalized mean of per-token vectors from a
 * lookup table. No neural network runs at index or query time, so there is no native binary and
 * nothing that breaks on musl/Alpine. Retrieval quality comes from pairing it with FTS in hybrid
 * mode; `bench/2026-11-18-static-embedder-poc.md` compares it with the ONNX model it replaced.
 *
 * Model files are downloaded once, at a pinned revision, and verified by SHA-256. The Float32
 * table is then quantized to Int8 once and kept as `embeddings.i8` (a quarter of the size); the
 * downloaded `model.safetensors` is deleted, so later loads read ~32 MB and do no hashing.
 */

export type StaticModelSpec = {
  revision: string;
  dimensions: number;
  files: { "model.safetensors": string; "tokenizer.json": string };
};

/** Only pinned, hash-verified models are accepted: a moving `main` must never change vectors. */
export const STATIC_MODELS: Record<string, StaticModelSpec> = {
  "minishlab/potion-retrieval-32M": {
    revision: "6fc8051fab2a1e0ee76689cf08c853792ac285e7",
    dimensions: 512,
    files: {
      "model.safetensors": "07609e5bd33aad37900b3fd62f4ec96f6daec88ca4d46b9d8b928bfababf6ea0",
      "tokenizer.json": "7d75cbc54318138807c401b0f0c9721117c628b39de8e8e0edb6cb17e0ee7d18",
    },
  },
  "minishlab/potion-base-8M": {
    revision: "bf8b056651a2c21b8d2565580b8569da283cab23",
    dimensions: 256,
    files: {
      "model.safetensors": "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2",
      "tokenizer.json": "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50",
    },
  },
};

export const DEFAULT_STATIC_MODEL = "minishlab/potion-retrieval-32M";

/** Model2Vec's reference `encode` truncates every input to this many tokens. */
const MAX_TOKENS = 512;

type StaticConfig = Extract<SearchEmbeddingProviderConfig, { provider: "static" }>;

export function resolveStaticModel(model: string | undefined): string {
  const resolved = model ?? DEFAULT_STATIC_MODEL;
  if (!(resolved in STATIC_MODELS)) {
    throw new Error(
      `Unknown static embedding model "${resolved}". Supported: ${Object.keys(STATIC_MODELS).join(", ")}.`,
    );
  }
  return resolved;
}

export function describeStaticEmbedder(config: StaticConfig): { id: string; dimensions: number } {
  const model = resolveStaticModel(config.model);
  return {
    id: `static:${model}`,
    dimensions: (STATIC_MODELS[model] as StaticModelSpec).dimensions,
  };
}

export async function createStaticEmbedder(config: StaticConfig): Promise<Embedder> {
  const model = resolveStaticModel(config.model);
  return loadStaticEmbedder(
    model,
    STATIC_MODELS[model] as StaticModelSpec,
    resolveStaticCacheDir(config.cacheDir),
  );
}

/** Download/verify/quantize/cache cycle for one pinned spec. Exported for unit tests. */
export async function loadStaticEmbedder(
  model: string,
  spec: StaticModelSpec,
  cacheDir: string,
): Promise<Embedder> {
  const dir = join(cacheDir, model, spec.revision);
  const id = `static:${model}`;
  try {
    const tokenizerJson = (await ensureFile(model, spec, dir, "tokenizer.json")).toString("utf8");
    const tablePath = join(dir, QUANTIZED_FILE);
    let table = readQuantizedTable(tablePath, spec);
    if (!table) {
      const weights = await ensureFile(model, spec, dir, "model.safetensors");
      table = quantizeRows(readSafetensorsEmbeddings(weights), spec.dimensions);
      writeQuantizedTable(tablePath, spec, table);
    }
    return assembleStaticEmbedder(id, spec.dimensions, tokenizerJson, table);
  } catch (cause) {
    // Offline first run: the indexer degrades to an FTS-only index instead of failing.
    throw new EmbedderUnavailableError(
      cause,
      `the static embedding model "${model}" could not be loaded from or downloaded to ${dir}; ` +
        "connect once to fetch it, or set `search.embedding.cacheDir` to a directory that " +
        "already holds it.",
    );
  }
}

/** Assembles an embedder from already-verified model files. Exported for unit tests. */
export function buildStaticEmbedder(
  id: string,
  dimensions: number,
  tokenizerJson: string,
  safetensors: Buffer,
): Embedder {
  const table = quantizeRows(readSafetensorsEmbeddings(safetensors), dimensions);
  return assembleStaticEmbedder(id, dimensions, tokenizerJson, table);
}

function assembleStaticEmbedder(
  id: string,
  dimensions: number,
  tokenizerJson: string,
  table: QuantizedTable,
): Embedder {
  const tokenizer = loadWordPieceTokenizer(tokenizerJson);
  if (table.rows !== tokenizer.vocabSize) {
    throw new Error(
      `static model ${id}: ${table.rows} embedding rows but ${tokenizer.vocabSize} vocab entries`,
    );
  }
  const embed = (text: string): number[] => embedText(text, tokenizer, table);
  return {
    id,
    dimensions,
    // Symmetric model: documents and queries share one encoder and need no task prefix.
    embedDocuments: async (texts) => texts.map(embed),
    embedQuery: async (text) => embed(text),
  };
}

/**
 * `embeddings.i8` layout: 4-byte magic, then the source safetensors SHA-256 as 64 ASCII hex
 * bytes, u32 rows, u32 dims (little endian), Float32 row scales, Int8 values. The embedded hash
 * ties the file to the pinned model; a file that does not match is ignored and rebuilt.
 */
const QUANTIZED_FILE = "embeddings.i8";
const QUANTIZED_MAGIC = "SLI8";
const QUANTIZED_HEADER = 4 + 64 + 4 + 4;

function readQuantizedTable(path: string, spec: StaticModelSpec): QuantizedTable | undefined {
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  if (bytes.length < QUANTIZED_HEADER) return undefined;
  if (bytes.toString("latin1", 0, 4) !== QUANTIZED_MAGIC) return undefined;
  if (bytes.toString("latin1", 4, 68) !== spec.files["model.safetensors"]) return undefined;
  const rows = bytes.readUInt32LE(68);
  const dims = bytes.readUInt32LE(72);
  if (dims !== spec.dimensions || bytes.length !== QUANTIZED_HEADER + rows * 4 + rows * dims) {
    return undefined;
  }
  // Copy out of the file buffer: Float32Array views need 4-byte alignment.
  const scales = new Float32Array(rows);
  new Uint8Array(scales.buffer).set(bytes.subarray(QUANTIZED_HEADER, QUANTIZED_HEADER + rows * 4));
  const values = new Int8Array(rows * dims);
  new Uint8Array(values.buffer).set(bytes.subarray(QUANTIZED_HEADER + rows * 4));
  return { rows, dims, values, scales };
}

/** Best effort: a failed write only means the next load quantizes again. */
function writeQuantizedTable(path: string, spec: StaticModelSpec, table: QuantizedTable): void {
  try {
    const header = Buffer.alloc(QUANTIZED_HEADER);
    header.write(QUANTIZED_MAGIC, 0, "latin1");
    header.write(spec.files["model.safetensors"], 4, "latin1");
    header.writeUInt32LE(table.rows, 68);
    header.writeUInt32LE(table.dims, 72);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      Buffer.concat([
        header,
        Buffer.from(table.scales.buffer, table.scales.byteOffset, table.scales.byteLength),
        Buffer.from(table.values.buffer, table.values.byteOffset, table.values.byteLength),
      ]),
    );
    renameSync(temp, path);
    // Rename first, delete second: a concurrent loader always finds one of the two files.
    rmSync(join(path, "..", "model.safetensors"), { force: true });
  } catch {
    // Keep the safetensors file; the next load falls back to it.
  }
}

/**
 * Int8 table with one float scale per row (the scale is `max|x| / 127`). It is a quarter of the
 * Float32 table's memory; mean pooling averages away the rounding error (see bench report).
 */
type QuantizedTable = { rows: number; dims: number; values: Int8Array; scales: Float32Array };

function quantizeRows(source: Float32Array, dims: number): QuantizedTable {
  const rows = source.length / dims;
  if (!Number.isInteger(rows))
    throw new Error("static model embeddings are not a rows×dims matrix");
  const values = new Int8Array(source.length);
  const scales = new Float32Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const offset = row * dims;
    let max = 0;
    for (let col = 0; col < dims; col += 1) {
      const magnitude = Math.abs(source[offset + col] as number);
      if (magnitude > max) max = magnitude;
    }
    const scale = max / 127;
    scales[row] = scale;
    if (scale === 0) continue;
    for (let col = 0; col < dims; col += 1) {
      values[offset + col] = Math.round((source[offset + col] as number) / scale);
    }
  }
  return { rows, dims, values, scales };
}

/** Model2Vec `encode`: drop unknown tokens, truncate, mean-pool the rows, L2-normalize. */
function embedText(text: string, tokenizer: WordPieceTokenizer, table: QuantizedTable): number[] {
  const sum = new Float64Array(table.dims);
  let count = 0;
  for (const id of tokenizer.encode(text)) {
    if (id === tokenizer.unkId) continue;
    const scale = table.scales[id] as number;
    const offset = id * table.dims;
    for (let col = 0; col < table.dims; col += 1) {
      sum[col] = (sum[col] as number) + (table.values[offset + col] as number) * scale;
    }
    count += 1;
    if (count === MAX_TOKENS) break;
  }
  // The mean's 1/count factor cancels under normalization, so only the norm is needed.
  let norm = 0;
  for (const value of sum) norm += value * value;
  norm = Math.sqrt(norm);
  const vector = new Array<number>(table.dims);
  for (let col = 0; col < table.dims; col += 1) {
    vector[col] = norm === 0 ? 0 : (sum[col] as number) / norm;
  }
  return vector;
}

/** Reads the single `embeddings` F32 tensor of a Model2Vec `model.safetensors`. */
function readSafetensorsEmbeddings(bytes: Buffer): Float32Array {
  const headerLength = Number(bytes.readBigUInt64LE(0));
  const header = JSON.parse(bytes.subarray(8, 8 + headerLength).toString("utf8")) as Record<
    string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }
  >;
  const tensor = header.embeddings;
  if (!tensor || tensor.dtype !== "F32" || tensor.shape.length !== 2) {
    throw new Error("static model safetensors has no 2-D F32 `embeddings` tensor");
  }
  const [begin, end] = tensor.data_offsets;
  const start = 8 + headerLength + begin;
  // Copy into an aligned buffer: the data section's byte offset need not be a multiple of 4.
  const aligned = new Uint8Array(end - begin);
  aligned.set(bytes.subarray(start, 8 + headerLength + end));
  return new Float32Array(aligned.buffer);
}

async function ensureFile(
  model: string,
  spec: StaticModelSpec,
  dir: string,
  name: keyof StaticModelSpec["files"],
): Promise<Buffer> {
  const path = join(dir, name);
  const expected = spec.files[name];
  if (existsSync(path)) {
    const bytes = readFileSync(path);
    if (sha256(bytes) === expected) return bytes;
  }
  mkdirSync(dir, { recursive: true });
  console.error(
    `semantic-layer: downloading static embedding model file ${model}/${name} to ${dir}.`,
  );
  const url = `https://huggingface.co/${model}/resolve/${spec.revision}/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to download ${url} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`${model}/${name}: SHA-256 mismatch (expected ${expected}, got ${actual})`);
  }
  // Write-then-rename so a concurrent or interrupted download never leaves a partial file.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
  return bytes;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveStaticCacheDir(configCacheDir: string | undefined): string {
  if (configCacheDir) return configCacheDir;
  if (process.env.SEMANTIC_LAYER_MODEL_CACHE_DIR) return process.env.SEMANTIC_LAYER_MODEL_CACHE_DIR;
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "semantic-layer", "models");
}
