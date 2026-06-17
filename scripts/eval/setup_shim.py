#!/usr/bin/env python3
"""
Create a compatibility shim for langchain_community.chat_models.vertexai.

RAGAS hard-imports ChatVertexAI from langchain_community even when VertexAI is
not used. langchain v1.x removed that module; this script adds a stub so the
import succeeds without requiring the full google-cloud-aiplatform stack.

Run once after `pip install -r requirements.txt`:
    python scripts/eval/setup_shim.py
"""

import importlib.util
import sys
from pathlib import Path


def main() -> None:
    """Write a compatibility shim for langchain_community.chat_models.vertexai.

    Locates the installed langchain_community package directory and writes a
    stub ``vertexai.py`` under ``chat_models/`` if one does not already exist.
    The stub re-exports ``ChatVertexAI`` so that RAGAS's hard import succeeds
    without requiring the full google-cloud-aiplatform stack.

    Exits with status 1 if langchain_community is not installed.
    """
    spec = importlib.util.find_spec("langchain_community")
    if spec is None or spec.submodule_search_locations is None:
        print("ERROR: langchain_community not found — install requirements first.")
        sys.exit(1)

    pkg_dir = Path(next(iter(spec.submodule_search_locations)))
    shim_path = pkg_dir / "chat_models" / "vertexai.py"

    if shim_path.exists():
        print(f"Shim already present: {shim_path}")
        return

    shim_path.write_text(
        "# Compatibility shim: ChatVertexAI moved to langchain-google-vertexai in langchain v1.x.\n"
        "# RAGAS hard-imports this path; stub prevents ImportError without requiring VertexAI.\n"
        "try:\n"
        "    from langchain_google_vertexai import ChatVertexAI\n"
        "except ImportError:\n"
        "    class ChatVertexAI:  # type: ignore[no-redef]\n"
        "        pass\n"
        "\n"
        "__all__ = ['ChatVertexAI']\n",
        encoding="utf-8",
    )
    print(f"Shim written: {shim_path}")


if __name__ == "__main__":
    main()
