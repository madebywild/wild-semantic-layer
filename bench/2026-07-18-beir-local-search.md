# 2026-07-18 — BEIR: local search index, first measurement

## Summary

First external benchmark of the semantic-layer search index, run on three
BEIR corpora (SciFact, NFCorpus, ArguAna) against the real local stack:
LadybugDB FTS + HNSW, `nomic-ai/nomic-embed-text-v1.5` (q8, 512-dim
Matryoshka), transformers.js on CPU. Verdict: **the system is sound** — fts
matches published BM25, vector sits in the expected dense range, and hybrid
beats both single modes on every dataset (+2–5 nDCG points). Getting to the
first complete run exposed four scale defects (one ours, three LadybugDB
0.18.2); all were fixed or worked around and verified end to end.

## Environment

- Commits: `5e9e79a` (fastembed → transformers.js migration) through
  `79dcbbd` (benchmark-driven fixes), package version 0.3.0 (pre-1.0).
- Machine: macOS 26.5.1 (arm64), 16 GB RAM, Node 24.18.0, CPU-only.
- Embedder: `nomic-ai/nomic-embed-text-v1.5`, ONNX q8, truncated to 512 dims
  (L2-renormalized), `@huggingface/transformers` 4.2.0 / onnxruntime-node 1.24.3.
- Index: `@ladybugdb/core` 0.18.2 (FTS + HNSW vector extension).
- Datasets: BEIR UKP mirror
  (`https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/`),
  downloaded 2026-07-18.

## Method

- SciFact (5,183 docs / 300 test queries), NFCorpus (3,633 / 323), ArguAna
  (8,674 / 1,406). Corpus docs became vault notes (id = BEIR doc id, title +
  body), indexed with default config (`heading` chunking, 2000 maxChunkChars)
  → 10,924 / 7,680 / 17,802 chunks.
- Every query ran all three modes, limit 100, ranked lists deduplicated by
  note id. Metrics: nDCG@10 (gain = qrel score, log₂ discount), Recall@100,
  MRR@10; means over judged queries.
- Reproduce: `bench/harness/README.md` (datasets → `.tmp/bench/datasets/`,
  vaults/indexes → `.tmp/bench/<dataset>/`, all gitignored).
- Deviations from canonical BEIR: none in scoring; the index pipeline is
  chunk-level (per note: title + sections), so per-document scoring dedupes
  chunks of the same document.

## Results

nDCG@10 (Recall@100 · MRR@10), all ours:

| dataset | fts | vector | hybrid |
| --- | --- | --- | --- |
| SciFact | 0.673 (0.915 · 0.637) | 0.692 (0.915 · 0.660) | **0.725** (0.952 · 0.693) |
| NFCorpus | 0.312 (0.235 · 0.510) | 0.330 (0.260 · 0.531) | **0.349** (0.277 · 0.568) |
| ArguAna | 0.336 (0.955 · 0.221) | 0.344 (0.972 · 0.223) | **0.375** (0.982 · 0.245) |

Published baselines (same datasets, cited, not our measurements):

| reference | SciFact | NFCorpus | ArguAna |
| --- | --- | --- | --- |
| BM25 (BEIR-standard, [arXiv 2605.28522](https://arxiv.org/pdf/2605.28522)) | 0.679 | 0.322 | 0.397 |
| bge-small-en-v1.5 dense ([arXiv 2606.01070](https://arxiv.org/html/2606.01070v1)) | 0.720 | — | — |

Timings: index build 6.7 (SciFact) / 6.2 (NFCorpus) / 12.0 (ArguAna) notes/s
on CPU; query latency 10–31 ms (fts), 20–87 ms (vector), 40–132 ms (hybrid).

Read: fts ≈ published BM25 on SciFact/NFCorpus (LadybugDB FTS is a sound
lexical baseline); vector is in the expected dense range; hybrid wins
everywhere. ArguAna is the known BEIR outlier where lexical retrieval beats
most dense systems — our hybrid (0.375) still trails published Anserini BM25
(0.397), consistent with the literature; LadybugDB's tokenizer is the likely
gap vs Anserini.

## Findings

The first five runs crashed before producing a number. Each defect was proven
with a counterfactual probe or a native crash stack (macOS DiagnosticReports):

1. **Embedder OOM (our bug).** The full-rebuild path embeds every chunk in one
   `embedDocuments` call; the transformers.js pipeline runs its whole input as
   one padded batch, so ~11k chunks materialized batch×seq×hidden×layers
   activations and the process was SIGKILLed. Fixed: batches of 32 texts with
   every output tensor disposed. Length-sorting the batches (padding cost is
   quadratic in batch max length) lifted throughput 2.5 → 6.9 notes/s.
2. **LadybugDB incremental HNSW segfault.** Populating the vector index via
   one maintenance insert per embedding UPDATE crashed at ~5k vectors:
   `OnDiskHNSWIndex::shrinkForNode` → `simsimd_cos_f32_neon` null deref.
   Small vaults never reach `shrinkForNode` (degree overflow), which is why
   tests never saw it. Fixed: build the index in one bulk
   `CREATE_VECTOR_INDEX` pass after embeddings are set — the same bulk-vs-
   incremental lesson the codebase already applies to FTS.
3. **LadybugDB checkpoint race → database corruption.** The post-work
   `CHECKPOINT` segfaulted in `BufferManager::claimAFrame` (via
   `finishCheckpoint` → `writeDatabaseHeaderToStorage`) with an ONNX runtime
   resident, on 3 of ~5 attempts, and a crashed `finishCheckpoint` leaves the
   database header unreadable ("not a valid Lbug database file"). Clean-room
   replays of the exact statement sequence without the embedder never crashed
   (see `bench/harness/repro-checkpoint-race.ts`) — it is a race widened by
   native thread contention, not a data bug. Mitigated: read-only units skip
   the no-op WAL drain, removing the race window from query workloads.
4. **Buffer pool appetite.** LadybugDB's default buffer manager claims ~80%
   of system RAM — a library must not do that beside a 1–3 GB ONNX arena on a
   16 GB host. Capped at 2 GiB in `openDatabase`.

## Actions

- `5e9e79a` feat: replace archived fastembed with transformers.js nomic-embed-text-v1.5
- `79dcbbd` fix: survive and speed up large-vault index builds (findings 1–4)
- `e1e5a7e` docs: record findings in `apps/demo/vault/meta.search.md`
- Gates on final code: 377 unit+integration tests, e2e Testcontainers suite,
  demo vault check/index — all green.

## Follow-ups

- FiQA2018 (57k docs) skipped this round (~3 h build at current throughput);
  the next scale data point. ArguAna (17.8k chunks) is the largest verified
  build so far.
- Incremental rebuilds that change thousands of chunks at once still use the
  per-UPDATE HNSW path from finding 2; fine for small deltas, but a bulk
  refresh strategy is needed if that path ever gets large.
- The checkpoint race (finding 3) is worked around, not fixed — the repro
  harness is ready for an upstream LadybugDB issue.
- The 512-dim Matryoshka path omits the model card's pre-truncation
  `layer_norm`; measurable-quality experiment for a future run (expect a
  small nDCG delta on vector/hybrid).
- ArguAna gap: investigate LadybugDB FTS tokenization vs Anserini BM25
  (stemming/stopwords) — the only dataset where we trail published lexical.
