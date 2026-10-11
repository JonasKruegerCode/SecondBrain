"""Run an explicit paid OpenRouter chat acceptance against the fictional demo vault.

The runner sends only the public Lantern Bay fixture to the configured model. It
stores structural evidence, never model answers, prompts, credentials, or page
content. A real ``OPENROUTER_API_KEY`` and ``--confirm-paid-provider`` are both
required so this check cannot be triggered by an ordinary local demo.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import shutil
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from second_brain.core.config import settings
from second_brain.llm.providers.openrouter.client import OpenRouterClient
from second_brain.wiki.chat import WikiChat
from second_brain.wiki.demo import seed_vault
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiStore

FIRST_QUESTION = (
    "Read the tide-clock page. What warning should a visitor hear before using "
    "that model for real navigation or shore access? Answer briefly from the wiki."
)
FOLLOW_UP = (
    "Now read the salt-marsh page and compare its pilot result with that warning. "
    "What remains uncertain, and why?"
)


class AcceptanceError(RuntimeError):
    """The real-provider result did not meet a structural acceptance criterion."""


def _artifact_dir(root: Path, now: datetime | None = None) -> Path:
    run_id = (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%SZ")
    path = root / ".demo" / "openrouter-acceptance" / run_id
    suffix = 1
    while path.exists():
        path = root / ".demo" / "openrouter-acceptance" / f"{run_id}-{suffix}"
        suffix += 1
    path.mkdir(parents=True)
    return path


def _content_digest(store: WikiStore) -> str:
    """Hash stable IDs, revisions, and content without returning any of them."""
    digest = hashlib.sha256()
    for page in sorted(store.list_pages(), key=lambda item: str(item["id"])):
        for key in ("id", "revision", "markdown"):
            digest.update(str(page[key]).encode("utf-8"))
            digest.update(b"\0")
    return digest.hexdigest()


def _validate_turn(
    result: dict[str, Any],
    *,
    required_page: str,
    required_terms: tuple[str, ...],
) -> dict[str, Any]:
    answer = result.get("answer")
    sources = result.get("sources")
    activity = result.get("activity")
    limits = result.get("limits")
    if not isinstance(answer, str) or not answer.strip() or len(answer) > 2_500:
        raise AcceptanceError("The provider did not return a proportionate text answer.")
    if not isinstance(sources, list) or not isinstance(activity, list):
        raise AcceptanceError("The chat result omitted source or activity metadata.")
    read_ids = {
        source.get("id")
        for source in sources
        if isinstance(source, dict) and source.get("evidence") == "read"
    }
    if required_page not in read_ids:
        raise AcceptanceError(f"The model did not read required page {required_page}.")
    if not isinstance(limits, dict) or not isinstance(limits.get("tool_calls"), int):
        raise AcceptanceError("The chat result omitted tool-call limits.")
    if not 1 <= limits["tool_calls"] <= limits.get("max_tool_calls", 0):
        raise AcceptanceError("The provider did not complete within the tool-call contract.")
    normalized = answer.casefold()
    if not any(term.casefold() in normalized for term in required_terms):
        raise AcceptanceError("The answer omitted the fixture's required caution or uncertainty.")
    return {
        "answer_characters": len(answer),
        "tool_calls": limits["tool_calls"],
        "source_ids": sorted(
            source["id"]
            for source in sources
            if isinstance(source, dict) and isinstance(source.get("id"), str)
        ),
        "read_source_ids": sorted(str(page_id) for page_id in read_ids if page_id is not None),
        "activity_entries": len(activity),
    }


async def _run_chat(
    vault: Path,
    provider_factory: Callable[[], Any] = OpenRouterClient,
) -> dict[str, Any]:
    store = WikiStore(vault)
    indexes = IndexCoordinator(store)
    before = _content_digest(store)
    try:
        chat = WikiChat(store, indexes, provider_factory())
        first = await asyncio.wait_for(
            chat.answer([{"role": "user", "content": FIRST_QUESTION}]),
            timeout=240,
        )
        first_summary = _validate_turn(
            first,
            required_page="tide-clock",
            required_terms=("not", "real", "forecast", "navigation", "shore access"),
        )
        second = await asyncio.wait_for(
            chat.answer(
                [
                    {"role": "user", "content": FIRST_QUESTION},
                    {"role": "assistant", "content": first["answer"]},
                    {"role": "user", "content": FOLLOW_UP},
                ]
            ),
            timeout=240,
        )
        second_summary = _validate_turn(
            second,
            required_page="salt-marsh",
            required_terms=("uncertain", "cannot", "several", "conditions", "tide alone"),
        )
        if _content_digest(store) != before:
            raise AcceptanceError("The read-only chat changed the demo vault.")
        return {"first_turn": first_summary, "follow_up": second_summary}
    finally:
        indexes.close()


def main(argv: Sequence[str] | None = None) -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--confirm-paid-provider",
        action="store_true",
        help="Confirm that bounded real OpenRouter calls and their cost are intended",
    )
    parser.add_argument(
        "--keep-vault",
        action="store_true",
        help="Retain the fictional disposable vault after a successful run",
    )
    args = parser.parse_args(argv)
    if not args.confirm_paid_provider:
        parser.error("--confirm-paid-provider is required")
    if not os.environ.get("OPENROUTER_API_KEY"):
        parser.error("OPENROUTER_API_KEY is required")

    artifact_dir = _artifact_dir(root)
    vault = artifact_dir / "vault"
    result_path = artifact_dir / "result.json"
    started = datetime.now(UTC)
    status = "failed"
    failure_type: str | None = None
    turns: dict[str, Any] | None = None
    try:
        seed_vault(vault)
        turns = asyncio.run(_run_chat(vault))
        status = "passed"
    except Exception as exc:  # Provider details may contain sensitive request metadata.
        failure_type = type(exc).__name__
    keep_vault = args.keep_vault or status != "passed"
    if not keep_vault:
        shutil.rmtree(vault, ignore_errors=True)
    finished = datetime.now(UTC)
    evidence = {
        "schema": 1,
        "status": status,
        "started_at": started.isoformat(),
        "finished_at": finished.isoformat(),
        "duration_seconds": round((finished - started).total_seconds(), 3),
        "provider": "openrouter",
        "model": settings.DEFAULT_MODEL,
        "fixture": "examples/demo-vault",
        "external_model_calls": True,
        "multi_turn": True,
        "answer_content_recorded": False,
        "vault_unchanged": status == "passed",
        "vault_retained": keep_vault,
        "turns": turns,
        "failure_type": failure_type,
    }
    result_path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(f"OpenRouter acceptance {status}. Evidence: {result_path}")
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
