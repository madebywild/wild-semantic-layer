# 2026-11-18 BEIR: static embedder POC vs ONNX (SciFact, NFCorpus, ArguAna)

## Summary

This run tests whether the ONNX embedding stack (`@huggingface/transformers` on
`onnxruntime-node`, 720 MB installed) can be replaced by a static Model2Vec
embedder without losing retrieval quality, following the Chrome team's
[Modern Web Guidance deep dive](https://developer.chrome.com/blog/mwg-technical-deep-dive).
With Porter stemming in FTS5 and one round of pseudo-relevance feedback (PRF),
the static default's hybrid nDCG@10 is within ±0.005 of the ONNX default on all
three datasets (mean 0.4747 vs 0.4751), with higher Recall@100 and slightly
lower MRR@10. Cold ArguAna builds fall from 1,460 s to 7.7 s, peak memory from
7.4 GB to 0.7 GB, and the installed package from 720 MB to 34 MB. Vector-only
mode is weaker (SciFact −0.058). Verdict: hybrid quality holds; vector-only
does not.

## Environment

- Base commit `d50f814`; POC on branch `claude/sharp-sagan-kk6lg6`.
  Package `@madebywild/semantic-layer` 2.1.0 (3.0.0 unreleased).
- Linux 6.18 container, 4 vCPU Intel Xeon @ 2.10 GHz, 15 GB RAM, Node 22.23.5.
  This is not the M1 host of the 2026-08-19 report, so absolute timings are
  not comparable with it; only same-host numbers are compared below.
- Baseline ("ONNX"): an isolated worktree at `d50f814` (schema 5, unicode61
  FTS, `local` provider): `nomic-ai/nomic-embed-text-v1.5`, q8, 512 dims,
  `@huggingface/transformers` 4.2.0, `onnxruntime-node` 1.24.3.
- POC ("static"): `minishlab/potion-retrieval-32M` at revision
  `6fc8051fab2a1e0ee76689cf08c853792ac285e7`, 512 dims, Int8 table with one
  Float32 scale per row, in-tree BERT WordPiece tokenizer; schema 6 with
  `tokenize='porter unicode61'`; hybrid PRF with 3 feedback chunks, weight 0.5.
- Datasets: BEIR SciFact (5,183 docs, 300 test queries), NFCorpus (3,633 docs,
  323 queries), ArguAna (8,674 docs, 1,406 queries).

## Method

- `bench/harness/bench.ts` unchanged in scoring (nDCG@10, Recall@100, MRR@10,
  limit 100, chunk hits deduplicated by note). New: `BENCH_EMBEDDER` selects
  the provider; lines now report build seconds, embedder load time, first
  query embed time and peak RSS.
- Harness fix: ArguAna prose contains `[[...]]` citations, which the indexer
  has rejected as dangling wikilinks since `86c5049`, so ArguAna could not be
  built at all at `d50f814`. The harness now rewrites `[[` to `[ [` in corpus
  text for both embedders. FTS on ArguAna still reproduces the 2026-08-19 value
  exactly (0.3342), so the effect on scoring is nil.
- Tuning protocol: every choice (no cosine floor for static, Porter stemming,
  PRF depth and weight, keeping plain RRF weights) was picked on SciFact only,
  then checked on NFCorpus and ArguAna as held-out sets. Variants were screened
  with an offline replay of `querySearch` over the built SQLite index; the
  replay reproduced every harness number exactly before it was trusted.
- Quality numbers are deterministic and were reproduced by two independent
  runs each. Latency numbers come from a final pass with nothing else running:
  static runs did a cold build (`SEMANTIC_LAYER_DISABLE_EMBEDDING_CACHE=1`)
  then queries; ONNX runs used `eval-only` on their existing index.
- Cold ONNX builds: SciFact and NFCorpus finished embedding but the processes
  died on a later lazy import after the harness bundle was rebuilt under them
  (see Findings), so only ArguAna has an ONNX cold build time, and that run
  shared the CPU with test suites for part of its 24 minutes.

## Results

### Hybrid (default mode)

| dataset | metric | ONNX | static | delta |
| --- | --- | ---: | ---: | ---: |
| SciFact | nDCG@10 | 0.7053 | 0.7021 | −0.0032 |
| SciFact | Recall@100 | 0.9577 | 0.9570 | −0.0007 |
| SciFact | MRR@10 | 0.6704 | 0.6619 | −0.0085 |
| NFCorpus | nDCG@10 | 0.3497 | 0.3533 | +0.0036 |
| NFCorpus | Recall@100 | 0.2812 | 0.3103 | +0.0291 |
| NFCorpus | MRR@10 | 0.5792 | 0.5515 | −0.0277 |
| ArguAna | nDCG@10 | 0.3702 | 0.3686 | −0.0016 |
| ArguAna | Recall@100 | 0.9794 | 0.9829 | +0.0035 |
| ArguAna | MRR@10 | 0.2428 | 0.2407 | −0.0021 |

### Vector-only and FTS-only

| dataset | ONNX vector | static vector | ONNX FTS | static FTS (Porter) |
| --- | ---: | ---: | ---: | ---: |
| SciFact nDCG@10 | 0.6872 | 0.6297 | 0.6567 | 0.6864 |
| NFCorpus nDCG@10 | 0.3314 | 0.3267 | 0.3082 | 0.3269 |
| ArguAna nDCG@10 | 0.3420 | 0.3401 | 0.3342 | 0.3418 |

### Ablation on the static embedder (hybrid nDCG@10)

| step | SciFact (dev) | NFCorpus | ArguAna |
| --- | ---: | ---: | ---: |
| static, unicode61 FTS, plain RRF | 0.6680 | 0.3353 | 0.3617 |
| + Porter stemming | 0.6925 | 0.3463 | 0.3657 |
| + PRF (3 chunks, weight 0.5) | **0.7021** | **0.3533** | **0.3686** |
| ONNX baseline | 0.7053 | 0.3497 | 0.3702 |

The 0.4 cosine floor of the ONNX path, kept for static, would have dropped 18%
of relevant SciFact documents and 94% of relevant NFCorpus documents. With
static vectors, an unrelated corpus's best match per query scores a median
0.25–0.33, while relevant NFCorpus documents score a median 0.12, so no floor
separates the two; static ranks without one.

### Counterfactual: ONNX with the same retrieval changes (replay)

| dataset | ONNX as shipped | ONNX + Porter | ONNX + Porter + PRF |
| --- | ---: | ---: | ---: |
| SciFact | 0.7053 | 0.7309 | 0.7291 |
| NFCorpus | 0.3497 | 0.3592 | 0.3636 |
| ArguAna | 0.3702 | 0.3747 | 0.3865 |

The middle column is what keeping ONNX alongside the same Porter change would
have reached. The static embedder therefore trails it by 0.013–0.029 nDCG@10.
That gap is the price of dropping ONNX, which the package now does entirely.

### Cost

| measure | ONNX | static |
| --- | ---: | ---: |
| installed `node_modules` (packed package, `npm install`) | 720 MB | 34 MB |
| model cache on disk | 132 MB | 33 MB |
| ArguAna cold build (17,802 chunks) | 1,460.1 s | 7.7 s |
| SciFact / NFCorpus cold build | not measured | 5.9 s / 4.0 s |
| peak RSS, ArguAna cold build + eval | 7,420 MB | 727 MB |
| embedder load (warm cache) | 466–521 ms | 100–173 ms |
| first-ever static load (download excluded; quantize + persist) | n/a | ~890 ms |
| warm query embedding | ~20–30 ms | 0.04–0.08 ms |

Median / p95 end-to-end query latency (ms), same host, uncontended:

| dataset | mode | ONNX | static |
| --- | --- | ---: | ---: |
| SciFact | fts | 5.1 / 9.0 | 6.5 / 12.9 |
| SciFact | vector | 31.0 / 46.5 | 13.2 / 18.6 |
| SciFact | hybrid | 39.4 / 56.2 | 36.8 / 49.0 |
| NFCorpus | fts | 2.7 / 6.0 | 2.7 / 5.9 |
| NFCorpus | vector | 21.6 / 35.3 | 8.0 / 11.6 |
| NFCorpus | hybrid | 22.7 / 32.3 | 20.0 / 28.4 |
| ArguAna | fts | 60.5 / 111.5 | 71.4 / 131.7 |
| ArguAna | vector | 98.3 / 180.7 | 28.6 / 37.6 |
| ArguAna | hybrid | 169.9 / 320.8 | 129.6 / 196.2 |

Hybrid pays for a second vector scan (PRF), which the near-free query
embedding more than covers. Porter makes FTS on long ArguAna queries about
18% slower.

### Published context

The Model2Vec card reports an MTEB retrieval average of 35.06 for
potion-retrieval-32M vs 42.92 for all-MiniLM-L6-v2. The Chrome MWG team saw
the same pattern: static query embeddings plus BM25 fusion matched a
transformer (Hit@K 95.4% vs 94.7%), while whole-document static averaging did
not (78.2%).

## Findings

1. **The vector floor was model-specific.** The 0.4 cosine floor fits nomic
   but would have discarded most relevant static hits (see above). The floor is
   now per embedder (`vectorSimilarityFloor`): 0.4 for nomic, none for static.
2. **ArguAna was unbuildable at HEAD.** Since `86c5049` unified wikilink
   validation, dangling `[[...]]` in corpus prose fail the index build. Fixed in
   the harness; the product behavior is correct for real vaults.
3. **Rebuilding the harness bundle kills in-flight runs.** `tsup` replaces
   hashed chunk files that a running bench imports lazily, which ended two
   multi-minute ONNX runs with `ERR_MODULE_NOT_FOUND`. The embedding cache kept
   their vectors, so the reruns cost seconds. Documented in the harness README.
4. **Tokenizer parity.** The in-tree WordPiece tokenizer produced identical ids
   to Hugging Face tokenizers.js 0.1.3 on 34,765 texts (4,835,287 tokens: all
   three corpora and query sets plus edge cases).
5. **Int8 is safe.** Int8 and Float32 static vectors agree to a cosine of at
   least 0.999938 on 4,000 documents. Persisting the Int8 table cut the load
   from ~890 ms (hash + quantize every time) to ~100 ms.
6. **PRF is mode-specific.** PRF from a vector-only first pass lowered SciFact
   vector nDCG@10 from 0.6297 to 0.6142, so vector mode does not use it.

## Actions

- Static provider (`static-embedder.ts`, `wordpiece.ts`), now the default.
- ONNX removed entirely: the `local` provider, `@huggingface/transformers` and
  `LocalEmbedderUnavailableError` (now `EmbedderUnavailableError`) are gone;
  `static` and hosted `gemini` remain. The package becomes 3.0.0.
- FTS5 `porter unicode61` tokenizer, schema version 6.
- Per-embedder vector floor; hybrid PRF for static.
- Harness: static only, timing and RSS output, ArguAna wikilink fix. The ONNX
  numbers above came from a worktree at `d50f814`; the harness can no longer
  produce them.

## Follow-ups

- Run FiQA2018 (57k documents): ArguAna-scale ONNX builds already take 24 min
  here, which is where the static build time matters most.
- Measure on real agent queries from vault usage (2–5 words, per MWG) instead
  of BEIR's long queries; BEIR is the only labelled set today.
- Close the vector-only gap: a vault-tuned static table (Tokenlearn-style
  distillation from nomic) is the obvious next experiment.
- Release as 3.0.0 after `pnpm check` and `pnpm check:release`.
