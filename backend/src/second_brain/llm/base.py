"""Abstract base classes for LLM providers.

Every provider must implement LLMClient and LLMEmbedder so that the rest
of the codebase can remain provider-agnostic.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class LLMClient(ABC):
    """Generic async LLM client interface."""

    @abstractmethod
    async def complete(
        self,
        system: str,
        user: str,
        model: str | None = None,
        **kwargs: Any,
    ) -> str:
        """Send a chat completion request and return the text response."""

    @abstractmethod
    async def chat_json(
        self,
        system: str,
        user: str,
        model: str | None = None,
        **kwargs: Any,
    ) -> Any:
        """Like complete(), but instructs the model to reply with JSON and parses it."""


class LLMEmbedder(ABC):
    """Generic synchronous text-embedding interface."""

    @abstractmethod
    def embed(self, text: str) -> list[float]:
        """Embed a single text."""

    @abstractmethod
    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Embed a list of texts in one call."""


class LLMError(Exception):
    """Base exception for all provider errors."""
