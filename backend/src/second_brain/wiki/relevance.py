"""Relevance ranking for wiki search.

Vector cosine stays the published ``score``. Ordering uses reciprocal rank
fusion of that signal with BM25, plus title, id and heading boosts. Pages
marked ``type: archive`` or ``status: historical`` are down-weighted. An
adaptive cutoff drops the weak tail; an explicit result limit skips it.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any

RRF_K = 60
BM25_K1 = 1.2
BM25_B = 0.75
ARCHIVE_PENALTY = 0.28
# Relative floor only engages once a real field boost lifts the top score
# above pure reciprocal-rank noise (~0.03). Flat lexical lists stay intact.
PEAK_SCORE = 0.2
RELATIVE_FLOOR = 0.36
CLIFF_RATIO = 0.62
CLIFF_OF_TOP = 0.82
TOKEN_RE = re.compile(r"[0-9a-zäöü]+", re.IGNORECASE)
HEADING_RE = re.compile(r"(?m)^#{1,6}[ \t]+(.+?)\s*$")
FIELD_RE = re.compile(r"(?im)^[ \t]*(type|status)[ \t]*:[ \t]*([a-z0-9_-]+)")
IMPLICIT_CANDIDATE_LIMIT = 15

# Question and function words. Stripped only when a content word remains,
# so "Was weiß Jonas so" matches Jonas without requiring "was" or "so".
STOPWORDS = frozenset(
    {
        "a",
        "am",
        "aber",
        "about",
        "als",
        "also",
        "an",
        "and",
        "auch",
        "auf",
        "aus",
        "bei",
        "bin",
        "bis",
        "bitte",
        "da",
        "das",
        "dass",
        "dem",
        "den",
        "der",
        "des",
        "die",
        "do",
        "does",
        "du",
        "ein",
        "eine",
        "einem",
        "einen",
        "einer",
        "eines",
        "er",
        "es",
        "etwas",
        "for",
        "fuer",
        "fur",
        "gibt",
        "hat",
        "habe",
        "haben",
        "how",
        "ich",
        "ihm",
        "ihn",
        "ihr",
        "ihre",
        "im",
        "in",
        "is",
        "ist",
        "ja",
        "mal",
        "man",
        "mich",
        "mir",
        "mit",
        "nach",
        "nicht",
        "noch",
        "nur",
        "ob",
        "oder",
        "of",
        "on",
        "or",
        "schon",
        "sein",
        "seine",
        "sich",
        "sie",
        "sind",
        "so",
        "that",
        "the",
        "to",
        "uber",
        "über",
        "und",
        "uns",
        "vom",
        "von",
        "vor",
        "wann",
        "warum",
        "was",
        "weiss",
        "welche",
        "welcher",
        "welches",
        "wer",
        "what",
        "when",
        "where",
        "who",
        "wie",
        "wir",
        "wo",
        "zu",
        "zum",
        "zur",
    }
)


def tokenize(text: str) -> list[str]:
    """Case-folded unicode word tokens. ``ß`` folds to ``ss`` via casefold."""
    return TOKEN_RE.findall(text.casefold())


def content_tokens(query: str) -> list[str]:
    """Query tokens with question words removed when any content word remains."""
    raw = tokenize(query)
    kept = [token for token in raw if token not in STOPWORDS]
    return kept or raw


def _heading_tokens(page: dict[str, Any], title: str) -> set[str]:
    tokens: set[str] = set()
    for heading in HEADING_RE.findall(str(page.get("markdown") or "")):
        if heading.casefold().strip() == title:
            continue
        tokens.update(tokenize(heading))
    return tokens


def _counts(page: dict[str, Any]) -> Counter[str]:
    """Weighted term counts: title, id segments, headings, then body."""
    title = str(page.get("title") or "")
    page_id = str(page.get("id") or "")
    counts: Counter[str] = Counter()
    for token in tokenize(title):
        counts[token] += 6
    for token in tokenize(page_id.replace("-", " ")):
        counts[token] += 5
    for token in _heading_tokens(page, title.casefold().strip()):
        counts[token] += 3
    body = tokenize(str(page.get("markdown") or ""))
    for token in body[:4000]:
        counts[token] += 1
    return counts


def bm25_scores(tokens: list[str], pages: list[dict[str, Any]]) -> dict[str, float]:
    """BM25 over the supplied page set. Unknown ids score 0."""
    if not tokens or not pages:
        return {}
    documents = [(str(page.get("id") or ""), _counts(page)) for page in pages]
    total = len(documents)
    lengths = [sum(counts.values()) or 1 for _page_id, counts in documents]
    average = sum(lengths) / total
    scores = {page_id: 0.0 for page_id, _counts in documents}
    for token in set(tokens):
        df = sum(1 for _page_id, counts in documents if counts[token])
        idf = math.log(1.0 + (total - df + 0.5) / (df + 0.5))
        for (page_id, counts), length in zip(documents, lengths, strict=True):
            tf = counts[token]
            if not tf:
                continue
            denom = tf + BM25_K1 * (1.0 - BM25_B + BM25_B * length / average)
            scores[page_id] += idf * (tf * (BM25_K1 + 1.0)) / denom
    return scores


def field_boost(query: str, tokens: list[str], page: dict[str, Any]) -> float:
    """Largest title or id match, plus a small heading bonus."""
    folded = query.strip().casefold()
    title = str(page.get("title") or "").casefold().strip()
    page_id = str(page.get("id") or "").casefold()
    if folded and folded in {title, page_id}:
        identity = 1.6
    else:
        identity = 0.0
        segments = set(page_id.split("-"))
        for token in tokens:
            if title == token or page_id == token:
                identity = max(identity, 1.2)
            elif title.startswith(token) or page_id.startswith(token + "-"):
                identity = max(identity, 0.9)
            elif token in segments:
                identity = max(identity, 0.45)
    if any(token in _heading_tokens(page, title) for token in tokens):
        identity += 0.15
    return identity


def is_archival(page: dict[str, Any]) -> bool:
    """True when Markdown declares ``type: archive`` or ``status: historical``."""
    text = f"{page.get('title') or ''}\n{str(page.get('markdown') or '')[:4000]}"
    for kind, value in FIELD_RE.findall(text):
        normalized = value.casefold()
        if kind.casefold() == "type" and normalized == "archive":
            return True
        if kind.casefold() == "status" and normalized in {"historical", "archive", "archived"}:
            return True
    return False


def combine_chunk_scores(best: float, mean: float | None) -> float:
    """Best chunk dominates; supporting chunks nudge the vector rank."""
    if mean is None or not math.isfinite(mean):
        return best
    return 0.75 * best + 0.25 * mean


def rank_pages(
    query: str,
    pages: list[dict[str, Any]],
    vectors: dict[str, float],
) -> list[dict[str, Any]]:
    """Return copies ordered by fused relevance. ``rank_score`` is unrounded."""
    tokens = content_tokens(query)
    lexical = bm25_scores(tokens, pages)
    vector_order = sorted(
        pages,
        key=lambda page: (-vectors.get(str(page.get("id") or ""), 0.0), str(page.get("id") or "")),
    )
    vector_rank = {
        str(page.get("id") or ""): index
        for index, page in enumerate(vector_order, start=1)
        if vectors.get(str(page.get("id") or ""), 0.0) > 0.0
    }
    lexical_order = sorted(
        (page for page in pages if lexical.get(str(page.get("id") or ""), 0.0) > 0.0),
        key=lambda page: (
            -lexical.get(str(page.get("id") or ""), 0.0),
            str(page.get("id") or ""),
        ),
    )
    lexical_rank = {
        str(page.get("id") or ""): index for index, page in enumerate(lexical_order, start=1)
    }
    fused: list[tuple[float, float, dict[str, Any]]] = []
    for page in pages:
        page_id = str(page.get("id") or "")
        boost = field_boost(query, tokens, page)
        penalty = ARCHIVE_PENALTY if is_archival(page) else 1.0
        rrf = 0.0
        if page_id in vector_rank:
            rrf += 1.0 / (RRF_K + vector_rank[page_id])
        if page_id in lexical_rank:
            rrf += 1.0 / (RRF_K + lexical_rank[page_id])
        vector_score = vectors.get(page_id, 0.0)
        fused.append(((rrf + boost) * penalty, vector_score, page))
    fused.sort(key=lambda item: (-item[0], -item[1], str(item[2].get("id") or "")))
    return [{**page, "rank_score": score} for score, _vector, page in fused]


def overlapping_ids(
    query: str,
    pages: list[dict[str, Any]],
    skip: set[str],
    limit: int,
) -> list[str]:
    """Page ids with the most query-token hits, excluding ``skip``."""
    tokens = content_tokens(query)
    if not tokens or limit < 1:
        return []
    scored: list[tuple[int, str]] = []
    for page in pages:
        page_id = str(page.get("id") or "")
        if not page_id or page_id in skip:
            continue
        text = f"{page_id.replace('-', ' ')} {page.get('title') or ''} {page.get('markdown') or ''}"
        bag = set(tokenize(text))
        overlap = sum(1 for token in tokens if token in bag)
        if overlap:
            scored.append((overlap, page_id))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [page_id for _overlap, page_id in scored[:limit]]


def adaptive_cutoff(rows: list[dict[str, Any]], cap: int) -> list[dict[str, Any]]:
    """Keep a relevance prefix of an already ranked list.

    A smooth score slope is preserved up to ``cap``. A cliff, or a long tail
    far below a boosted top score, ends the list. The first row always stays.
    """
    if cap < 1 or not rows:
        return []
    kept = [rows[0]]
    top = float(rows[0].get("rank_score") or 0.0)
    use_floor = top >= PEAK_SCORE
    for previous, row in zip(rows, rows[1:], strict=False):
        if len(kept) >= cap:
            break
        score = float(row.get("rank_score") or 0.0)
        prev = float(previous.get("rank_score") or 0.0)
        if use_floor and score < top * RELATIVE_FLOOR:
            break
        if prev > 0.0 and score < prev * CLIFF_RATIO and score < top * CLIFF_OF_TOP:
            break
        kept.append(row)
    return kept


def trim_ranked(
    rows: list[dict[str, Any]], cap: int, *, enabled: bool
) -> tuple[list[dict[str, Any]], bool, bool]:
    """Apply cutoff when every row carries ``rank_score``.

    Returns the visible rows, whether the hard cap hid further matches, and
    whether the adaptive cutoff discarded a weak tail.
    """
    if cap < 1:
        return [], False, False
    if not enabled or not rows or any("rank_score" not in row for row in rows):
        visible = rows[:cap]
        return visible, len(rows) > cap, False
    kept = adaptive_cutoff(rows, cap)
    truncated = len(rows) > cap and len(kept) >= cap
    cutoff = len(kept) < min(len(rows), cap)
    return kept, truncated, cutoff
