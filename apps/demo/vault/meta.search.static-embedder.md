---
id: meta.search.static-embedder
title: Static embedder
desc: Default Model2Vec embedder with no native runtime.
status: active
owner: tom@wild.as
audience: [agents, eng]
last_verified: 2026-11-19
ttl_days: 180
tags: [meta, search, embeddings]
layer: demo
code_refs:
  - file: packages/semantic-layer/src/search/static-embedder.ts
    symbol: createStaticEmbedder
    kind: function
  - file: packages/semantic-layer/src/search/static-embedder.ts
    symbol: STATIC_MODELS
    kind: const
  - file: packages/semantic-layer/src/search/wordpiece.ts
    symbol: loadWordPieceTokenizer
    kind: function
  - file: packages/semantic-layer/src/search/embedder.ts
    symbol: pseudoRelevanceFeedback
    kind: function
---

# Static embedder

`search.embedding.provider: static` is the default for [[meta.search]] and its
only on-device embedder; it replaced the ONNX `local` provider. It runs
`minishlab/potion-retrieval-32M`, a Model2Vec model: a text's vector is the
L2-normalized mean of one 512-dimension row per WordPiece token, with unknown
tokens dropped and input capped at 512 tokens like the reference encoder.
Documents and queries are embedded the same way. Nothing neural runs, so
there is no ONNX runtime, no native binary, and nothing that breaks on Alpine.

## Model files

Only pinned models in `STATIC_MODELS` are accepted: a Hugging Face revision
plus the SHA-256 of `tokenizer.json` and `model.safetensors`. The first load
downloads both, verifies the hashes, quantizes the Float32 table to Int8 with
one scale per row, writes it as `embeddings.i8`, and deletes the 129 MB
safetensors file. Later loads read about 33 MB and take about 0.1 s. A
`embeddings.i8` that does not carry the pinned hash, or has the wrong size, is
ignored and rebuilt. A load that cannot reach the network on a cold cache
throws `EmbedderUnavailableError`, so indexing degrades to FTS-only.

Int8 and Float32 vectors agree to a cosine of at least 0.99994 on 4,000 BEIR
documents. The in-tree tokenizer matched Hugging Face `tokenizers` token for
token on 34,765 texts.

## Retrieval tuning

Static vectors are weaker alone than a transformer's, so three choices make
the default `hybrid` mode hold its quality:

- No cosine floor: unrelated text scores 0.25 to 0.35 while many relevant
  chunks score below 0.2, so any fixed floor drops real matches.
- Porter stemming in FTS5.
- One round of pseudo-relevance feedback in hybrid mode: the query vector moves
  toward the mean of the top 3 fused chunks (weight 0.5) and the vector side is
  ranked again. It was chosen on SciFact and confirmed on NFCorpus and ArguAna.
  It hurt `--mode vector` alone, so that mode does not use it.

`--mode vector` alone is weaker than the removed nomic model was, by 0.002 to 0.058
nDCG@10 depending on the dataset. See
`bench/2026-11-18-static-embedder-poc.md` for every number.
