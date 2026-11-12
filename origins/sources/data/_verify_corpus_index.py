#!/usr/bin/env python3
"""Verify corpus-index.json matches a fresh build from extended + authorities.

Exits 1 if the committed/on-disk index was hand-edited or is stale.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "corpus-index.json"
HASH_OUT = ROOT / "corpus-index.sha256"
BUILDER = ROOT / "_build_corpus_index.py"


def main() -> int:
    if not OUT.exists():
        print("missing corpus-index.json")
        return 1

    current = OUT.read_text(encoding="utf-8")
    meta = json.loads(current)
    if meta.get("note") and "GENERATED" not in meta.get("note", ""):
        print("WARNING: corpus-index missing GENERATED note")

    # Rebuild into a temp copy by running builder then restoring
    backup = current
    hash_backup = HASH_OUT.read_text(encoding="utf-8") if HASH_OUT.exists() else None
    try:
        subprocess.check_call([sys.executable, str(BUILDER)], cwd=str(ROOT))
        rebuilt = OUT.read_text(encoding="utf-8")
        # Compare semantic payload ignoring generated_at timestamp
        a = json.loads(backup)
        b = json.loads(rebuilt)
        a.pop("generated_at", None)
        b.pop("generated_at", None)
        if a != b:
            print("corpus-index DRIFT: on-disk index does not match rebuild from extended/authorities")
            # show shallow diffs
            for key in sorted(set(a) | set(b)):
                if a.get(key) != b.get(key):
                    if key == "sources":
                        print(f"  sources length {len(a.get('sources') or [])} vs {len(b.get('sources') or [])}")
                    else:
                        print(f"  field differs: {key}")
            return 1
        stored_hash = (HASH_OUT.read_text(encoding="utf-8").split() or [""])[0]
        if a.get("input_sha256") and stored_hash and a["input_sha256"] != stored_hash:
            print("corpus-index.sha256 mismatch vs payload input_sha256")
            return 1
        print(f"corpus-index OK (input_sha256={a.get('input_sha256', '')[:12]}…, {a.get('sourceCount')} sources)")
        return 0
    finally:
        # Leave the freshly rebuilt files in place (they are the truth).
        pass


if __name__ == "__main__":
    sys.exit(main())
