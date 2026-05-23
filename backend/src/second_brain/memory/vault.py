import os
from pathlib import Path
from typing import Protocol


class VaultStore(Protocol):
    """
    Protocol defining the interface for File System Vault operations (Obsidian Markdown).
    """

    def read_file(self, path: str) -> str | None:
        """Read the content of a markdown file. Returns None if not exists."""
        ...

    def write_file(self, path: str, content: str) -> None:
        """Write content to a markdown file, overwriting if it exists."""
        ...

    def list_files(self, prefix: str = "") -> list[str]:
        """List all markdown files in the vault, optionally filtered by prefix."""
        ...


class FileSystemVault:
    """
    File system implementation of the VaultStore.
    """

    def __init__(self, base_path: str) -> None:
        self.base_path = Path(base_path)
        self.base_path.mkdir(parents=True, exist_ok=True)

    def _resolve_path(self, path: str) -> Path:
        """Resolve the path securely within the vault."""
        # Remove leading slashes to prevent absolute path resolution outside vault
        clean_path = path.lstrip("/")
        full_path = (self.base_path / clean_path).resolve()

        # Security check: ensure the resolved path is within the base path
        if not str(full_path).startswith(str(self.base_path.resolve())):
             raise ValueError("Path traversal attack detected.")

        # Ensure it's a markdown file (or directories leading to one)
        if not full_path.name.endswith(".md"):
            full_path = full_path.with_suffix(".md")

        return full_path

    def read_file(self, path: str) -> str | None:
        """Read markdown file content."""
        full_path = self._resolve_path(path)
        if not full_path.exists() or not full_path.is_file():
            return None
        return full_path.read_text(encoding="utf-8")

    def write_file(self, path: str, content: str) -> None:
        """Write content to a markdown file."""
        full_path = self._resolve_path(path)
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(content, encoding="utf-8")

    def list_files(self, prefix: str = "") -> list[str]:
        """List all .md files in the vault."""
        files = []
        for root, _, filenames in os.walk(self.base_path):
            for filename in filenames:
                if filename.endswith(".md"):
                    rel_path = Path(root) / filename
                    rel_str = str(rel_path.relative_to(self.base_path))

                    # Ensure unified path separators
                    rel_str = rel_str.replace("\\", "/")
                    if not prefix or rel_str.startswith(prefix):
                         files.append(rel_str)
        return files
