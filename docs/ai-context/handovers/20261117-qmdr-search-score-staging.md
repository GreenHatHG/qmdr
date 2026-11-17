---
created_at: 2026-11-17
updated_at: 2026-11-17
topic: qmdr-search-score-staging
status: resolved
affected_modules: [src/qmd.ts, src/llm.ts, src/store.ts]
tags: [rerank, rrf, sigmoid, hybrid-search, min-score, voyage]
---

# Search Final Score: Reranker-as-Final-Score (staged pipeline)

## 1. Context & Problem
`qmdr query` showed an irrelevant doc ranked #1 with "75% match". The old code blended scores: `finalScore = rrfWeight*(1/rrfRank) + (1-rrfWeight)*rerankScore`. Rank #1 gave `0.75*1.0 = 0.75` before the reranker score counted, so any top-fused doc displayed ≥ ~0.72 even when the reranker judged it irrelevant (raw logit was -0.0026). The displayed percentage was rank position, not relevance.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)
- **Attempt**: Tiered RRF/reranker blend (rrfWeight 0.75/0.60/0.40 by rank).
  - **Failure Reason**: Mixes a rank-based number (bounded by 1, doc-count dependent) with a reranker score that can be a negative unbounded logit. An irrelevant #1 doc can never fall below ~0.72. Non-monotonic in rank, kills recall (upstream bench: recall@5 0.630 vs 0.815 reranker-only).
- **Attempt**: Trust reranker cache as-is after the fix.
  - **Failure Reason**: Pre-change cache entries hold raw logits (e.g. -0.0026). Cache-read path must normalize too, or stale logits leak as negative/incorrect scores. Normalization is idempotent, so double-normalize is safe.
- **Attempt**: One universal min-score for all rerankers.
  - **Failure Reason**: Score distributions differ per model. qwen3-reranker 0.6b output: irrelevant queries scored 0.46-0.50 (above a relevant Chinese-query hit at 0.33) — no threshold could separate. Never assume a threshold transfers across models.
- **Attempt**: Upstream fix dependency (tobi/qmd).
  - **Failure Reason**: Upstream has the same blend bug; issue #697 and fix PR #1032 sat unmerged as of 2026-11. Do not wait for upstream; port the staged design locally.

## 3. Decision & Verified Solution
- **Chosen Approach**: Industry-standard staged pipeline (matches Azure AI Search L2, Vespa global-phase, Cohere guidance). RRF fusion only selects candidates (top ~40). The reranker's calibrated 0-1 score IS the final score. RRF rank breaks ties only. Raw logits from cross-encoders get sigmoid-normalized when out of [0,1]; calibrated scores pass through unchanged.
- **Key Changes**:
  - `src/llm.ts`: added `normalizeRerankScore(score)` — sigmoid only when score outside [0,1]. Applied in `rerankWithSiliconflow` and `rerankWithDashscope` result mapping.
  - `src/qmd.ts` `_querySearchImpl`: deleted the tiered blend; `finalScore = rerankScore` in both extract and cross-encoder branches. Final sort: `(b.score - a.score) || (rrfRankMap.get(a.file)! - rrfRankMap.get(b.file)!)`.
  - `src/store.ts` `rerank()`: cache-read path applies `normalizeRerankScore(parseFloat(cached))`.
  - Committed as 5a1f8cd `fix(search): reranker score is final; RRF only selects candidates` (3 files, +20/-19).
  - Global CLI: `bun link` from repo root symlinks `~/.bun/install/global/node_modules/qmdr` → repo, so commits take effect without reinstall.
- **Minimal Code / Command Reference**:
  ```ts
  // src/llm.ts — sigmoid only when out of [0,1]; idempotent
  export function normalizeRerankScore(score: number): number {
    if (score >= 0 && score <= 1) return score;
    return 1 / (1 + Math.exp(-score));
  }
  // src/qmd.ts — reranker score is final; RRF rank only breaks ties
  finalResults.sort((a, b) => (b.score - a.score) || (rrfRankMap.get(a.file)! - rrfRankMap.get(b.file)!));
  ```

## 4. Hard Constraints for Future AI
- NEVER blend RRF rank scores with reranker scores into one number. Fusion selects candidates; the reranker decides the final score.
- NEVER display fusion/rank scores as relevance percentages. RRF scores are bookkeeping (top ≈ 1/61), not confidence.
- ALWAYS sigmoid-normalize raw reranker logits to [0,1] before display or thresholding; ALWAYS normalize on cache-read (idempotent, safe for calibrated values).
- Reranker model and min-score are coupled. Verified distributions (pi-kitmux corpus): voyage/rerank-2.5 → relevant 0.52-0.94, irrelevant 0.20-0.25, clean cut at 0.35 (strict: 0.7). qwen3-reranker 0.6b → relevant 0.33-0.63, irrelevant 0.46-0.50, NO clean cut exists; do not use it with absolute thresholds.
- `formatScore` color bands (green ≥ 0.7, yellow ≥ 0.4) fit voyage/rerank-2.5; recalibrate if the reranker model changes.
- Gemini/OpenAI LLM-mode rerank uses synthetic scores `1.0 - rank*0.05`, not true relevance — different min-score semantics entirely.
- Test reranker behavior with three query types: direct-hit English, paraphrase, and cross-language (Chinese) — cross-language is the weak spot (voyage: 0.52 vs 0.82-0.94 English).
