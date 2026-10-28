# QMDR - AI Setup Guide

QMDR — hybrid markdown search (BM25 + vector + LLM reranking). Fork of [tobi/qmd](https://github.com/tobi/qmd), cloud APIs replace local GGUF models.

## 1. Install

Bun ≤1.3.6 required — 1.3.7+ segfault with sqlite-vec (unfixed as of 1.3.9).

**Path A — Bun (recommended):**
```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.6"
# China: prepend BUN_INSTALL_MIRROR=https://npmmirror.com/mirrors/bun
bun install -g github:uf-hy/qmdr
```

**Path B — Binary (no Bun needed):**

Available: macOS arm64/x64, Linux x64/arm64, Windows x64. Windows ARM → use x64 binary (runs via emulation).

```bash
OS=$(uname -s | tr A-Z a-z); ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && ARCH="x64"
DIR=/usr/local/bin; [ ! -w "$DIR" ] && DIR="$HOME/.local/bin" && mkdir -p "$DIR"
curl -L "https://github.com/uf-hy/qmdr/releases/latest/download/qmd-${OS}-${ARCH}" -o "$DIR/qmd" && chmod +x "$DIR/qmd"
```

**Windows (PowerShell):**
```powershell
Invoke-WebRequest "https://github.com/uf-hy/qmdr/releases/latest/download/qmd-windows-x64.exe" -OutFile "$env:LOCALAPPDATA\qmd.exe"
# Add to PATH if needed: [Environment]::SetEnvironmentVariable("Path", "$env:Path;$env:LOCALAPPDATA", "User")
```
Binary: sqlite-vec must be loadable (`QMD_ALLOW_SQLITE_EXTENSIONS=1`). macOS: `brew install sqlite`. Linux: `apt install libsqlite3-dev`. Windows: sqlite3.dll usually bundled. Or set `QMD_SQLITE_VEC_PATH`.

Verify: `qmd --help`. If not found, ensure install dir is in PATH.

## 2. Configure

Config file: `~/.config/qmd/.env` (auto-loaded on startup). Collect all keys, write once.

```bash
mkdir -p ~/.config/qmd
```

### 💰 Cost

SiliconFlow gives **¥14 free credit** on signup. Daily cost ~¥0.06 for typical use (indexing + querying). The free credit lasts **6+ months**.

SiliconFlow also offers permanently free models (embedding, chat, reranking) — with these, the ¥14 credit is only used for premium models. See "Free tier" config below.

Region: China → default endpoint works. International → add `QMD_SILICONFLOW_BASE_URL=https://api.siliconflow.com/v1`.

**Default config** (best quality, uses ¥14 credit):

```env
# Required: SiliconFlow. Register at cloud.siliconflow.cn (.com intl). ¥14 free credit on signup.
QMD_SILICONFLOW_API_KEY=sk-xxx

# Recommended: Gemini reranking (free). Get key at ai.google.dev
QMD_GEMINI_API_KEY=xxx
QMD_RERANK_PROVIDER=gemini

# Alternative: SiliconFlow reranking (no extra key, uses ¥14 credit)
# QMD_RERANK_PROVIDER=siliconflow
# QMD_RERANK_MODE=llm
```

**Free tier config** (¥0 cost, SiliconFlow free models only, slightly lower quality):

```env
QMD_SILICONFLOW_API_KEY=sk-xxx
QMD_SILICONFLOW_EMBED_MODEL=BAAI/bge-m3
QMD_SILICONFLOW_QUERY_EXPANSION_MODEL=Qwen/Qwen2.5-7B-Instruct
QMD_RERANK_PROVIDER=siliconflow
QMD_RERANK_MODE=llm
QMD_LLM_RERANK_MODEL=Qwen/Qwen2.5-7B-Instruct
```

> Free tier uses bge-m3 (1024d) instead of Qwen3-Embedding-8B (4096d), and Qwen2.5-7B for query expansion/reranking instead of GLM-4.5-Air. Chinese retrieval quality is slightly lower but still good. Switching models requires `qmd embed -f` to rebuild vectors.

```env
# Optional: custom OpenAI-compatible endpoint
# QMD_OPENAI_API_KEY=xxx
# QMD_OPENAI_BASE_URL=https://custom-endpoint.com/v1
# QMD_EMBED_PROVIDER=openai
```

### Custom OpenAI-compatible setup: Qwen3-Embedding-8B (2048d) + Qwen3-Reranker-8B

Copy-paste template: [`.env.qwen3.example`](.env.qwen3.example). Only the base URL and API key need editing.

```env
# --- endpoint (one key, one base URL) ---
QMD_OPENAI_API_KEY=sk-xxx
QMD_OPENAI_BASE_URL=https://your-endpoint/v1
QMD_TIMEOUT_MS=60000

# --- embedding: Qwen3-Embedding-8B, truncated to 2048 dims ---
QMD_EMBED_PROVIDER=openai
QMD_OPENAI_EMBED_MODEL=Qwen/Qwen3-Embedding-8B
QMD_EMBED_DIMENSIONS=2048
QMD_EMBED_PROMPT_STYLE=qwen3

# --- reranker: Qwen3-Reranker-8B via a dedicated /rerank endpoint ---
QMD_RERANK_PROVIDER=siliconflow
QMD_RERANK_MODE=rerank
QMD_SILICONFLOW_API_KEY=sk-xxx
QMD_SILICONFLOW_BASE_URL=https://your-endpoint/v1
QMD_SILICONFLOW_RERANK_MODEL=Qwen/Qwen3-Reranker-8B

# --- query expansion (optional: needs a chat model) ---
QMD_QUERY_EXPANSION_PROVIDER=openai
QMD_OPENAI_MODEL=Qwen/Qwen3-8B
# No chat model on this endpoint? Disable it instead:
# QMD_QUERY_EXPANSION_PROVIDER=none
```

Then `qmd embed -f` (model + dimension changed) and `qmd doctor` (it compares the DB vector dimension against a live embedding probe).

Keep every comment on its own line — the `.env` loader does not strip inline comments, so `FOO=bar  # note` sets `FOO` to `"bar  # note"`.

Notes:

- **Dimensions.** `QMD_EMBED_DIMENSIONS` is optional and is sent as the `dimensions` field on every embedding request. If your endpoint returns 2048 natively (server-side MRL truncation), or rejects the field, omit it — the model's native size is used instead.
- **Prompt format.** Qwen3-Embedding is trained with `Instruct: …\nQuery: …` on the query side and raw text on the document side, so QMDR detects Qwen3-Embedding from the model name and switches format automatically. `QMD_EMBED_PROMPT_STYLE=gemma|qwen3` forces either style (`gemma` = the old `title:/task:` prefixes, still used for every other model), and `QMD_EMBED_QUERY_INSTRUCT` replaces the instruction text. Changing the style means a rebuild: `qmd embed -f`.
- **Why `siliconflow` for the reranker.** The `siliconflow` rerank provider is a generic Cohere-style client (`POST {base}/rerank`, body `{model, query, documents, top_n}`, reads `results[].relevance_score`). It works with any compatible gateway (vLLM `/rerank`, SiliconFlow, Jina, TEI). `QMD_RERANK_PROVIDER=openai` is *LLM* rerank (chat completions), which a cross-encoder like Qwen3-Reranker cannot serve.
- **Query expansion is optional.** Set `QMD_QUERY_EXPANSION_PROVIDER=none` to turn it off: only expansion is skipped, BM25 and vector search still run, and the cache cannot bring old expansion lines back. Any other value counts as `none` — including a typo and a blank `QMD_QUERY_EXPANSION_PROVIDER=` — so neither can re-enable it. Only a variable you never set falls back to the key-based auto-pick. Left unset while `QMD_SILICONFLOW_API_KEY` exists, the slot auto-picks `siliconflow` and calls `zai-org/GLM-4.5-Air` against your endpoint. That fails 3 times on every query — expansion errors are swallowed, so no cooldown ever kicks in. Set the slot explicitly.
- **When expansion is off or has no provider** the query still runs, using only the original query (BM25 + vector). **When a call fails** it degrades to the built-in local expansion instead (`lex` + `vec` + a synthetic `hyde` line). Neither case needs a chat model, and neither blocks a search.
- **`QMD_OPENAI_MODEL` matters.** Setting `QMD_SILICONFLOW_API_KEY` makes the OpenAI slot fall back to `zai-org/GLM-4.5-Air` when `QMD_OPENAI_MODEL` is unset — set it explicitly to a chat model your endpoint actually serves.
- **Timeouts.** An 8B reranker behind a gateway can exceed the 15s default. `QMD_TIMEOUT_MS=60000` covers it; or lower `QMD_RERANK_DOC_LIMIT` / `QMD_RERANK_CHUNKS_PER_DOC`.

**Alibaba Bailian (百炼) reranking** (native qwen3-rerank, fastest):

```env
QMD_DASHSCOPE_API_KEY=sk-xxx
QMD_RERANK_PROVIDER=dashscope
QMD_RERANK_MODE=rerank
# QMD_DASHSCOPE_RERANK_MODEL=qwen3-rerank  # default
```

> Bailian's qwen3-rerank uses a dedicated rerank API (`/compatible-api/v1/reranks`), not the OpenAI-compatible chat endpoint. QMDR handles this automatically when `QMD_RERANK_PROVIDER=dashscope`. Combine with SiliconFlow for embedding + query expansion.

### Cost Estimation (Dynamic)

Step 1: Calculate your daily tokens

Memory - how to calculate:
- Count characters in your memory/*.md files
- tokens = characters ÷ 1.74 (Chinese text approximate ratio)
- Or use tiktoken for exact count

Sessions - how to calculate:
- Check your session files in ~/.openclaw/agents/*/sessions/
- Estimate similarly, or reference: ~360K tokens/day

Step 2: Calculate years with ¥14 credit

Formula: 
- Years = (14 ÷ price_per_M) × 1,000,000 ÷ daily_tokens
- Free models (bge-large-zh-v1.5, bge-m3): unlimited

Example - if your memory = 5K tokens/day:
- Qwen3-Embedding-0.6B (¥0.07/M): (14 ÷ 0.07) × 1M ÷ 5,000 = 40,000 days ≈ 110 years
- Qwen3-Embedding-4B (¥0.14/M): (14 ÷ 0.14) × 1M ÷ 5,000 = 20,000 days ≈ 55 years
- Free models: unlimited

Example - if memory + sessions = 360K tokens/day:
- Qwen3-Embedding-0.6B: (14 ÷ 0.07) × 1M ÷ 360,000 = 555 days ≈ 1.5 years
- Qwen3-Embedding-4B: (14 ÷ 0.14) × 1M ÷ 360,000 = 277 days ≈ 0.8 years
- Free models: unlimited

### Reranking: two modes

QMDR supports two reranking strategies:

- `QMD_RERANK_MODE=rerank` — Dedicated reranker model (e.g. bge-reranker, qwen3-rerank). Fast (~300ms), returns relevance scores directly. Best quality.
- `QMD_RERANK_MODE=llm` (default) — Uses a chat model to extract and rank relevant content. Slower (~1-3s) but works with any OpenAI-compatible API. Also extracts key passages.

For LLM rerank, use a lightweight/cheap model — it only needs to read ~20 short chunks and pick the relevant ones. Recommended models:

- SiliconFlow → `zai-org/GLM-4.5-Air` (default, ¥1/M in)
- SiliconFlow free → `Qwen/Qwen2.5-7B-Instruct` (free, unlimited)

After configuring, run `qmd doctor --bench` to verify rerank latency. Target: <500ms for dedicated reranker, <3s for LLM rerank.

Provider auto-routing: siliconflow → gemini → dashscope → openai (first with configured key).
QMDR requires cloud APIs — there are no local/fallback models. Unconfigured providers will show ❌ in `qmd doctor`.

## 3. Verify

```bash
qmd doctor          # check providers
qmd doctor --bench  # optional: query quality test
```

## 3.5 Diagnostics

**Profile query performance** — find bottlenecks in the search pipeline:
```bash
qmd query "your question" --profile
```
Shows timing breakdown: query expansion → BM25 retrieval → vector search → reranking → total. Reranking typically takes 60-80% of total time. Use this to decide if you need a faster reranker.

**Verbose output** — see the full query process (expanded queries, chunk selection, reranker scores):
```bash
qmd query "your question" --verbose
```
Default output is minimal (results only, ~400 tokens). `--verbose` shows everything (~3700 tokens). `--profile` auto-enables verbose.

## 4. Client Integration

### OpenClaw

Native memory backend, no MCP.

**Index workspace** (OpenClaw workspace: directory containing `openclaw.json`, typically `~/.openclaw/workspace`):
```bash
qmd collection add <WORKSPACE_PATH> --name memory --mask "*.md"  # idempotent
qmd context add qmd://memory "Personal memory files"
qmd embed
qmd query "test" -c memory  # empty result = no .md files in path
```

**Merge into `openclaw.json`** (typically `~/.openclaw/openclaw.json` — read existing first, merge `memory` block only):
```json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "command": "qmd",
      "includeDefaultMemory": true,
      "sessions": { "enabled": true },
      "update": { "interval": "5m", "debounceMs": 15000 },
      "limits": { "maxResults": 6, "timeoutMs": 60000 }
    }
  }
}
```

`command`: `"qmd"` (global) or absolute path to `src/qmd.ts` (source mode — needs `#!/usr/bin/env bun` shebang + chmod +x).
Never use `"bun /path/to/qmd.ts"` — bun misparses subcommands.

**Sessions indexing** — `"sessions": { "enabled": true }` exports your AI conversation history as markdown files and indexes them. This means QMDR can search through past conversations, decisions, and context — not just your static markdown files. Highly recommended for personal knowledge retrieval.

Cost tip: Sessions generate ~300-400K tokens/day. With free models (bge-large-zh-v1.5, bge-m3), cost is ¥0. Or use ¥14 credit: ~0.4-1.5 years depending on model tier.

Env keys: `~/.config/qmd/.env` auto-loaded (recommended). Or add to launchd/systemd. Process env > .env.

Restart: `openclaw gateway restart`. Verify `memory_search` returns `"provider": "qmd"`.
If QMDR fails or times out, OpenClaw automatically falls back to built-in SQLite search.

### Claude Code / OpenCode

Install skill:
```bash
# Claude Code
mkdir -p ~/.claude/skills/qmdr
curl -sL https://raw.githubusercontent.com/uf-hy/qmdr/main/skills/qmdr/SKILL.md -o ~/.claude/skills/qmdr/SKILL.md
# OpenCode
mkdir -p ~/.config/opencode/skills/qmdr
curl -sL https://raw.githubusercontent.com/uf-hy/qmdr/main/skills/qmdr/SKILL.md -o ~/.config/opencode/skills/qmdr/SKILL.md
```

Usage: `qmd query "natural language"` (hybrid) | `qmd search "keywords"` (BM25) | `qmd get "#docid"` (full doc).
Always use natural language for `query`, not keyword concatenation.

Index your project before first use:
```bash
qmd collection add . --name project --mask "*.md"
qmd embed
```

## Environment Variables

Essential (used during setup):

Variable	Default	Note
QMD_SILICONFLOW_API_KEY	—	Required
QMD_GEMINI_API_KEY	—	Recommended (reranking)
QMD_OPENAI_API_KEY	—	Optional (custom endpoint)
QMD_EMBED_PROVIDER	auto	siliconflow / openai
QMD_QUERY_EXPANSION_PROVIDER	auto	siliconflow / gemini / openai / none (off)
QMD_RERANK_PROVIDER	auto	siliconflow / gemini / openai / dashscope
QMD_RERANK_MODE	llm	llm / rerank (dedicated API)
QMD_SILICONFLOW_BASE_URL	https://api.siliconflow.cn/v1	International: .com
QMD_GEMINI_BASE_URL	Google default	Custom endpoint / proxy (China users)
QMD_DASHSCOPE_API_KEY	—	Alibaba Bailian (rerank only)

Model/tuning overrides (change only if needed):

Variable	Default
QMD_SILICONFLOW_EMBED_MODEL	Qwen/Qwen3-Embedding-8B
QMD_SILICONFLOW_QUERY_EXPANSION_MODEL	zai-org/GLM-4.5-Air
QMD_GEMINI_MODEL	gemini-2.5-flash (thinkingBudget=0)
QMD_LLM_RERANK_MODEL	zai-org/GLM-4.5-Air
QMD_SILICONFLOW_RERANK_MODEL	BAAI/bge-reranker-v2-m3
QMD_DASHSCOPE_RERANK_MODEL	qwen3-rerank
QMD_CHUNK_SIZE_TOKENS	200
QMD_CHUNK_OVERLAP_TOKENS	40
QMD_SQLITE_VEC_PATH	auto

Changing embedding model → `qmd embed -f` to rebuild index.

## Troubleshooting

Problem	Fix
qmd: command not found	Ensure install dir in PATH
sqlite-vec load error	macOS: brew install sqlite; or set QMD_SQLITE_VEC_PATH
/$bunfs/root/ error	Use bun install -g (source), not compiled binary
Segfault on Linux	Bun ≥1.3.7 — downgrade to 1.3.6
Dimension mismatch	qmd embed -f
Slow queries (>5s)	qmd doctor — use non-thinking models
Script not found "query"	Use direct path with shebang, not "bun /path/to/qmd.ts"
