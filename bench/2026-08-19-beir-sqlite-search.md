# 2026-08-19 — BEIR: SQLite search index (ArguAna)

## Summary

This is the first measured SQLite v2 run on BEIR ArguAna: 8,674 notes became
17,802 chunks and the full build completed in 887.0 s (9.8 notes/s). After
the diagnostic fixes below, SQLite retained the previous vector effectiveness
and near-previous FTS effectiveness; hybrid reached 0.3691 nDCG@10. Its
end-to-end query latency is not yet an improvement over the historical
LadybugDB reference band, so the result validates correctness and scale, not
a performance win.

## Environment

- Code observed after the run: `969111b` (`perf(search): normalize broad FTS
  queries`), following `6d8c0e4`, `f2a509d`, `61ed8ee`, and `68f68f6`.
- Package: `@madebywild/semantic-layer` 2.0.0; index: Node `node:sqlite`,
  SQLite FTS5, Float32 embedding BLOBs, and exact in-process cosine search.
- Host rechecked while preparing this report: macOS 26.6 (Darwin arm64), Node
  24.19.0. The benchmark logs do not contain their own immutable environment
  fingerprint, so treat this as a post-run verification rather than a complete
  reproducibility record.
- Embedder/config: local `nomic-ai/nomic-embed-text-v1.5`, 512 dimensions,
  `@huggingface/transformers` 4.2.0 / `onnxruntime-node` 1.24.3, and default
  heading chunking (`maxChunkChars: 2000`).
- Dataset: BEIR ArguAna, 8,674 documents and 1,406 judged test queries. The
  legacy comparison is the 2026-07-18 ArguAna result in
  [`2026-07-18-beir-local-search.md`](2026-07-18-beir-local-search.md).

## Method

- `bench/harness/bench.ts` converted each corpus document into a vault note,
  performed a full SQLite build, then ran each retrieval mode at limit 100.
  Scoring deduplicates chunk hits by note id and computes mean nDCG@10,
  Recall@100, and MRR@10 over the 1,406 qrels.
- The completed final measurement used `eval-only` against the generated
  SQLite index. It records end-to-end per-query wall-clock samples and reports
  aggregate mean (`queryMs`), median, and p95. These include query embedding
  where the mode needs it.
- The full-build diagnostic log is retained as diagnostic evidence, not as the
  final retrieval result: its FTS score was 0.0004 before FTS query fixes.
- The benchmark does not delete or rewrite legacy `vault.lbug*` artifacts.
  Migration coverage confirms those derived artifacts remain untouched; SQLite
  writes `vault.sqlite` and only transient WAL/SHM sidecars.

## Results

### ArguAna (17,802 chunks)

| mode | nDCG@10 | Recall@100 | MRR@10 | mean ms | median ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fts | 0.3342 | 0.9324 | 0.2174 | 58.6 | 52.9 | 100.3 |
| vector | 0.3442 | 0.9723 | 0.2234 | 93.4 | 83.8 | 157.8 |
| hybrid | **0.3691** | **0.9801** | **0.2424** | 154.9 | 139.7 | 265.4 |

The full build recorded 887.0 s / 9.8 notes/s. Its diagnostic query output
before the fixes was FTS 0.0004 nDCG@10 (24.8 ms mean; 23.0 ms median; 39.9
ms p95), vector 0.3442 (164.7 / 103.0 / 543.8 ms), and hybrid 0.3440 (119.0 /
107.5 / 202.6 ms). Those figures are not comparable final retrieval results.

### Delta vs historical ArguAna result

The 2026-07-18 LadybugDB run reported 0.336 FTS / 0.344 vector / 0.375 hybrid
nDCG@10 and a 10–31 ms FTS, 20–87 ms vector, 40–132 ms hybrid query-latency
reference range. Its report did not say whether those latency figures were
means, medians, or percentiles, so this is an indicative—not like-for-like—
comparison.

- Effectiveness: FTS is -0.0018 nDCG@10, vector +0.0002, and hybrid -0.0059.
  These are small single-run deltas; neither benchmark report includes repeated
  trials from which to infer statistical significance.
- Latency: final median FTS is above the old FTS range (52.9 vs 10–31 ms),
  vector is within the old vector range near its upper end (83.8 vs 20–87 ms),
  and hybrid is above the old hybrid range (139.7 vs 40–132 ms). Final means
  and p95s are also above each old range ceiling except none for vector median.
  Do not infer a regression magnitude until both implementations are measured
  under a single timing protocol.

## Findings

1. **Dangling corpus wikilinks blocked relational insertion.** Bracket-shaped
   corpus prose produced parsed links without indexed endpoints; strict SQLite
   foreign keys then rejected the build. `6d8c0e4` now inserts a link only when
   both endpoints exist, preserving valid graph edges without treating stray
   prose as a relationship.
2. **Broad FTS queries first lost recall, then had an inefficient plan.** The
   diagnostic full run's 0.0004 FTS nDCG exposed unsafe/over-restrictive query
   normalization. `f2a509d` retains broad natural-language retrieval using
   safely quoted OR terms. `61ed8ee` and `68f68f6` order through FTS5's hidden
   `rank` to keep top-k ordering in the FTS plan instead of scoring a broad
   match set before `LIMIT`; `969111b` completes query normalization. The final
   FTS result, 0.3342 nDCG@10, is the relevant measurement.
3. **SQLite v2 stores all durable index state in one file.** The build uses
   `vault.sqlite` for metadata, FTS, graph tables, and embeddings. Legacy
   LadybugDB artifacts remain untouched during migration and are not part of
   SQLite's durable index state.

## Actions

- `6d8c0e4` — skip dangling wikilink edges during SQLite insertion.
- `f2a509d`, `61ed8ee`, `68f68f6`, `969111b` — restore broad FTS retrieval,
  preserve rank-aware FTS5 top-k execution, and normalize natural-language
  terms safely.
- Re-run FiQA2018 in a controlled session before making a 57k-query-latency
  claim; the attempted run below did not reach indexing.

## FiQA2018 (skipped after invalid run)

The 57,638-document FiQA run was stopped without a result. The host suspended
or heavily paused the process overnight: its wall elapsed jumped from about
one hour to more than eight hours while its accumulated CPU time and log did
not advance normally. That invalidated the build-throughput measurement before
SQLite insertion began. At stop time `vault.sqlite` was still 4 KiB and its WAL
was 0 bytes, which is evidence that embedding remained outside the transaction
and no partial index mutation occurred. No FiQA query-latency or effectiveness
claim is made from this run.

| metric | value |
| --- | --- |
| corpus documents | 57,638 parsed into the temporary vault |
| full build duration / throughput | invalid; run stopped before insertion |
| SQLite state at stop | 4 KiB main file; 0-byte WAL |
| FTS/vector/hybrid results | not measured |
