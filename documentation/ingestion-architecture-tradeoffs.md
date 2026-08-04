# Ingestion Architecture Tradeoffs: Fixed Pipeline vs. Free-Agentic

**Status:** Decision document — no implementation required  
**Date:** 2026-08-04  
**Context:** Evaluating whether the current `gather → plan → apply (→ reconcile) → finalize`
LangGraph pipeline should be replaced or extended with a freer, goal-driven agent loop.

---

## Current Architecture: Fixed-Step Pipeline (`edit_vault`)

```
gather → plan → apply →[create/merge?]→ reconcile → finalize
```

- **gather**: vector search → load seed pages (pure retrieval, no LLM)
- **plan**: single LLM call → emits typed operation list (`add_claim`, `edit_section`, `create_page`, `link`, `merge`, `mark_outdated`, `delete_claim`, `delete_page`, `edit_claim`)
- **apply**: deterministic execution of the operation list (no LLM)
- **reconcile**: conditional — runs only after `create_page`/`merge` to rewire backlinks
- **finalize**: re-derives Qdrant embeddings and Neo4j graph edges for changed pages

**Shared by two entry points:**
- `remember(text)`: new information → gather by similarity → plan → apply
- `repair(slug)`: existing page → gather by page content → plan (only gardening ops) → apply

---

## Alternative: Free-Agentic ("Goal + Tools") Approach

The agent would iteratively decide its own tool calls:

```
goal: "store this information"
loop:
  → search_wiki(query)
  → get_page(id)
  → apply_op(op)   ← or emit structured patch
  → verify(?)
  → done?
```

The LLM decides *which* tools to call and *when* to stop, rather than following a fixed sequence.

---

## Comparison

### Costs

| Dimension | Fixed Pipeline | Free-Agentic |
|-----------|---------------|--------------|
| LLM calls per ingestion | 2 (split + plan) | 3–10+ (one per tool call) |
| Token cost per ingestion | Low (one plan call) | 3–8× higher (multi-turn context accumulates) |
| Latency | Low (parallel gather) | High (sequential tool calls, each waits for LLM) |

**Verdict:** Fixed pipeline wins on cost and latency by a large margin. A free agent easily spends 5–10× the tokens for the same outcome, and latency adds up fast when tool calls are sequential.

### Determinism and Debuggability

| Dimension | Fixed Pipeline | Free-Agentic |
|-----------|---------------|--------------|
| Reproducibility | High (same input → near-identical plan) | Low (tool-call sequence varies per run) |
| Debuggability | High (logged plan JSON + diffs) | Low (trace of 6–12 interleaved calls) |
| Auditability | High (git commit per run) | Medium (hard to summarize what changed and why) |
| Testing | Easy (unit-test plan parsing + apply) | Hard (mock multi-turn interaction) |

**Verdict:** Fixed pipeline wins decisively. The typed operation list is the key artifact — it's inspectable, loggable, and testable. A free agent's reasoning is implicit in tool-call traces that are hard to review or replay.

### Correctness / Quality

| Dimension | Fixed Pipeline | Free-Agentic |
|-----------|---------------|--------------|
| Hallucination risk | Controlled (grounding rules in single prompt) | Higher (multi-turn context drift, model can "forget" constraints) |
| Completeness | Depends on prompt quality (see P2 improvements) | Potentially better for very complex, multi-entity texts |
| Conflict detection | Needs explicit repair cron | Could do it inline (but expensive) |
| Error recovery | Explicit `skipped`/`rejected` lists | Implicit retry loops (harder to reason about) |

**Verdict:** For most ingestion tasks (individual facts, short notes, structured info), the fixed pipeline with improved prompts (P2) matches free-agentic quality at far lower cost. A free agent's quality advantage only appears for extremely long, complex documents with many cross-references — and even there, the better approach is to improve the `split_into_topics` pre-processing step rather than switching architectures.

### Failure Modes

| Mode | Fixed Pipeline | Free-Agentic |
|------|---------------|--------------|
| LLM budget exhaustion | Fails fast, error propagated to caller (P0 fix) | May partially apply, leaving wiki in inconsistent state |
| Rate limiting | Retried once per call, fast fail | Disrupts mid-loop, hard to resume |
| Infinite loops | Impossible (finite steps) | Requires explicit loop budget (still possible) |
| Partial write | Unlikely (apply is atomic per-op, each has rollback) | Likely (partial tool-call sequences) |

**Verdict:** Fixed pipeline is significantly safer. The free-agentic loop has failure modes that are hard to detect and recover from in a persistent wiki.

---

## Recommendation

**Keep the fixed pipeline. Do not switch to free-agentic.**

The improvements from P2 (completeness rules in the plan prompt, finer topic splitting) address the core quality gap (incomplete fact extraction) within the existing architecture. These changes are already in place.

If further quality improvements are needed, the right levers are:

1. **Better `split_into_topics`**: more granular pre-chunking before the plan call (already improved in P2).
2. **Structured plan schema**: enforce a minimum number of operations relative to input length (e.g., "if input has N sentences, emit at least N ops").
3. **Two-pass planning**: a second LLM call that reviews the initial plan and adds missed facts (cheap, deterministic, fits the fixed pipeline model).
4. **Longer context in `gather`**: increase `GATHER_LIMIT` and `PAGE_PROMPT_CHARS` for documents with many cross-references.

### When a free-agentic approach *would* make sense

- **Active knowledge synthesis**: when the goal is not "store this text" but "answer this question by exploring the wiki and drawing conclusions" — this is `get_RAG_response`, which is already a different code path.
- **Multi-document reconciliation at scale**: if the repair task grows to comparing hundreds of pages for contradictions, a goal-driven agent might navigate more efficiently than a cron-based single-page repair. But this is a different problem domain.

---

## Summary Table

| Property | Fixed Pipeline | Free-Agentic |
|----------|---------------|--------------|
| Cost per ingestion | ✅ Low | ❌ High |
| Latency | ✅ Low | ❌ High |
| Determinism | ✅ High | ❌ Low |
| Debuggability | ✅ High | ❌ Low |
| Failure safety | ✅ High | ❌ Medium |
| Quality (simple inputs) | ✅ Good (with P2 prompt fixes) | ✅ Good |
| Quality (complex multi-entity) | ⚠️ Improve via pre-chunking | ✅ Potentially better |
| Implementation complexity | ✅ Low | ❌ High |

**Decision: stick with the fixed `gather → plan → apply` pipeline, invest in prompt quality and pre-chunking.**
