from pathlib import Path

import pytest

from second_brain.memory.vault import FileSystemVault


def test_vault_read_write(tmp_path: Path) -> None:
    vault = FileSystemVault(str(tmp_path))

    # Test write
    vault.write_file("test", "# Hello World")

    # Test read
    content = vault.read_file("test.md")
    assert content == "# Hello World"

    # Test missing file
    assert vault.read_file("missing.md") is None

def test_vault_list_files(tmp_path: Path) -> None:
    vault = FileSystemVault(str(tmp_path))
    vault.write_file("logs/test1.md", "content")
    vault.write_file("wiki/test2.md", "content")

    files = vault.list_files()
    assert len(files) == 2
    assert "logs/test1.md" in files
    assert "wiki/test2.md" in files

    prefix_files = vault.list_files("wiki")
    assert len(prefix_files) == 1
    assert prefix_files[0] == "wiki/test2.md"

def test_vault_path_traversal(tmp_path: Path) -> None:
    vault = FileSystemVault(str(tmp_path))
    with pytest.raises(ValueError, match="Path traversal"):
        vault.write_file("../outside.md", "bad")
