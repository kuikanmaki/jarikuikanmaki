"""Shared authority lookup helpers for corpus builders."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
AUTH = ROOT / "authority"

TYPE_FILES = {
    "person": "persons.json",
    "org": "orgs.json",
    "place": "places.json",
    "topic": "topics.json",
    "event": "events.json",
    "work": "works.json",
}


def load_authority_map() -> dict[str, dict]:
    """Return id -> authority record for all typed authority files."""
    out: dict[str, dict] = {}
    for typ, fname in TYPE_FILES.items():
        path = AUTH / fname
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        for item in data.get("items") or []:
            aid = item.get("id")
            if aid:
                out[aid] = item
    return out


def pref_label(auth_map: dict[str, dict], aid: str) -> str | None:
    rec = auth_map.get(aid)
    if not rec:
        return None
    return rec.get("prefLabel") or rec.get("indexTerm") or aid


def labels_for_ids(auth_map: dict[str, dict], ids: list[str]) -> tuple[list[str], list[str]]:
    """Return (labels, missing_ids) preserving order; skip unknown ids in labels."""
    labels: list[str] = []
    missing: list[str] = []
    for aid in ids or []:
        lab = pref_label(auth_map, aid)
        if lab is None:
            missing.append(aid)
        else:
            labels.append(lab)
    return labels, missing
