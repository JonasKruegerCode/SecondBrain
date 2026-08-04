# Wiki Quality Benchmark — realistic input documents

Two realistic inputs that should produce readable wiki articles, not fact lists.
The benchmark checks whether the output looks like an encyclopedia, not a database.

---

## Document 1: Team Meeting Protocol

Sprint Planning Meeting — 2026-08-01
Participants: Jonas, Leon, Julia

TOP 1 — Sprint Goal
The team agreed on the sprint goal: complete the SecondBrain ingestion pipeline
improvements and ship the new frontend edit mode. Jonas will lead the backend work,
Leon takes the frontend. Target velocity: 34 story points.

TOP 2 — Architecture Decision: Sync vs. Async Ingestion
After discussion, the team decided to switch from async Celery-based ingestion to
synchronous ingestion in the MCP server. The main reason: clients need real-time
error feedback. The Celery worker remains for background cron jobs (repair, reindex).
Decision owner: Jonas. Revisit in 4 weeks.

TOP 3 — Open Issues
Three open bugs were discussed: (1) The graph occasionally creates duplicate nodes
for the same entity when titles differ slightly. (2) The vault sync sometimes fails
silently on Git conflicts. (3) The frontend sidebar resize was broken on Firefox —
fixed in this sprint. Next steps: Jonas creates tickets for (1) and (2).

TOP 4 — Roadmap
Q3 focus: stabilise the ingestion pipeline and improve wiki quality. Q4 tentative:
multi-user support and team brain. Julia flagged that the LVM pilot needs a demo
by end of September.

---

## Document 2: Architecture Documentation

# SecondBrain Architecture Overview

SecondBrain is a personal knowledge management system with three core layers:

## Storage Layer
The wiki (Markdown files in a Git repository) is the single source of truth.
Neo4j stores the knowledge graph derived from wikilinks. Qdrant stores vector
embeddings for semantic search. Git serves as the audit trail — no separate
append-only log is needed.

## Ingestion Pipeline
New information enters through the `remember` MCP endpoint. The edit_vault agent
processes it in four steps: gather (vector search for relevant existing pages),
plan (single LLM call producing typed operations), apply (deterministic execution),
and finalize (reindex graph and vectors). The pipeline is synchronous so the caller
gets immediate success/failure feedback.

## Retrieval
Hybrid retrieval combines vector search (Qdrant) with graph expansion (Neo4j).
The `recall` endpoint returns the top 3 most relevant pages with their full content
and direct graph neighbours. The `get_RAG_response` endpoint uses an LLM to
synthesise a natural language answer from retrieved context.

## MCP Interface
The system exposes 9 MCP tools: remember, recall, search_wiki, get_page,
get_RAG_response, edit_page, delete_fact, delete_wiki_page, create_page_manual.
The last four allow strong AI clients to edit the wiki directly without going
through the LLM ingestion pipeline.
