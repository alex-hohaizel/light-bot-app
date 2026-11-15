#!/usr/bin/env python3
"""Check the bundled Work/Codex instructions in newly generated artifacts."""

import argparse
from pathlib import Path
import re


GUIDE = Path("references/joint-work-codex.md")
LOCAL_LINK = re.compile(r"\]\((?:\./)?references/joint-work-codex\.md\)")


def verify_child(root, entry, expected):
    entry_path = root / entry
    guide_path = root / GUIDE
    paths = (root, entry_path, guide_path.parent, guide_path)
    if any(path.is_symlink() for path in paths):
        return "entry and reference must be ordinary local paths"
    if not (entry_path.is_file() and guide_path.is_file()):
        return "entry or bundled guide is missing or not a regular file"
    try:
        if guide_path.read_bytes() != expected:
            return f"{GUIDE} differs from the constructor's release"
        if not LOCAL_LINK.search(entry_path.read_text(encoding="utf-8")):
            return f"{entry} is missing a local link to {GUIDE}"
    except (OSError, UnicodeError) as error:
        return str(error)
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entry", choices=("SKILL.md", "AGENTS.md"), default="SKILL.md")
    parser.add_argument("child_roots", type=Path, nargs="+")
    args = parser.parse_args()
    try:
        expected = (Path(__file__).resolve().parents[1] / GUIDE).read_bytes()
    except OSError as error:
        parser.exit(1, f"Cannot read constructor reference: {error}\n")
    failed = False
    for root in args.child_roots:
        error = verify_child(root, args.entry, expected)
        if error:
            print(f"FAIL {root}: {error}")
            failed = True
        else:
            print(f"OK {root}: bundled guide and local entry link")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
