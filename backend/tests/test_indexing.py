"""Unit tests for link parsing (typed relations → property-graph edges)."""
from second_brain.memory.indexing import normalize_rel, parse_links, parse_wikilinks

PAGE = """\
# Second Brain

last_updated: 2026-07-02

A memory system built on [[qdrant]] and [[neo4j|a graph database]].

## Relations

- uses:: [[docker]]
- part_of:: [[jonas-projects]]
- inspired_by:: [[llm-wiki|Karpathy's LLM wiki]]
"""


def test_parse_wikilinks_still_returns_all_targets() -> None:
    assert parse_wikilinks(PAGE) == ["qdrant", "neo4j", "docker", "jonas-projects", "llm-wiki"]


def test_parse_links_separates_typed_and_plain() -> None:
    links = parse_links(PAGE)
    assert ("docker", "uses") in links
    assert ("jonas-projects", "part_of") in links
    assert ("llm-wiki", "inspired_by") in links
    assert ("qdrant", None) in links
    assert ("neo4j", None) in links


def test_parse_links_typed_takes_precedence_over_plain() -> None:
    md = "See [[docker]] for details.\n\n- uses:: [[docker]]\n"
    links = parse_links(md)
    assert links == [("docker", "uses")]


def test_parse_links_allows_multiple_relations_to_same_target() -> None:
    md = "- uses:: [[neo4j]]\n- evaluates:: [[neo4j]]\n"
    links = parse_links(md)
    assert ("neo4j", "uses") in links
    assert ("neo4j", "evaluates") in links
    assert len(links) == 2


def test_parse_links_deduplicates() -> None:
    md = "- uses:: [[docker]]\n- uses:: [[docker]]\n[[qdrant]] and [[qdrant]] again\n"
    assert parse_links(md) == [("docker", "uses"), ("qdrant", None)]


def test_normalize_rel() -> None:
    assert normalize_rel("Part Of") == "part_of"
    assert normalize_rel("works-at") == "works_at"
    assert normalize_rel("  uses  ") == "uses"
