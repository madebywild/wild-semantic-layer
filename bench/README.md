# Benchmarks

Continuous benchmark trail for `semantic-layer`. Every non-trivial change to
retrieval, indexing, or the embedding pipeline gets measured against a fixed
protocol before it is trusted, and every run is recorded so improvements and
regressions stay visible over time.

## Rules

- **Evidence over assumptions.** A report exists only for a benchmark that
  actually ran, with real numbers, a recorded environment, and a reproducible
  method. Crashes, failed hypotheses, and dead ends are recorded too — they
  are findings, not embarrassments.
- **The committed artifact is the report.** Large raw artifacts (datasets,
  generated vaults, indexes, model caches) stay in `.tmp/bench/` and are
  gitignored. The harness lives in `bench/harness/` and must stay runnable;
  if a change breaks it, fix the harness in the same change.
- **Compare like with like.** Re-running a benchmark means the same datasets,
  metrics, and protocol as the previous run, plus a Delta section against the
  most recent prior report. If the protocol must change, say so explicitly in
  Method and mark older numbers non-comparable.

## Naming

`bench/YYYY-MM-DD-<benchmark>-<scope>.md` — one file per run, e.g.
`2026-07-18-beir-local-search.md`. Never edit an old report's numbers;
supersede it with a new dated file and link back if the conclusion changes.

## Report structure

1. **Summary** — 2–4 sentences: what was measured, headline numbers, verdict.
2. **Environment** — commit SHA(s), package version, machine/OS/arch,
   embedding model (id, dtype, dimensions), DB/library versions, dataset
   sources.
3. **Method** — datasets (documents, queries, split), metrics with their exact
   definitions, reproduction commands, any deviation from the canonical
   protocol (and why).
4. **Results** — one table per dataset covering every mode and metric, plus
   timings (index throughput, query latency). Published baselines with
   citations for context, clearly separated from our numbers.
5. **Findings** — numbered defects/observations the run surfaced, each with
   its evidence (crash stack, probe result, measurement) and resolution.
6. **Actions** — commits/PRs/issues the run produced.
7. **Follow-ups** — known gaps and the next experiments worth running.

For repeat runs of the same benchmark, add **Delta** between Results and
Findings: per-metric change vs the previous report, with a one-line cause for
any movement beyond noise (±0.005 nDCG).
