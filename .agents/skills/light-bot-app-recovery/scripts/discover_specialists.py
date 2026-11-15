#!/usr/bin/env python3
"""Read-only specialist inventory and source-pinned reuse decision checks.

No invocation, installation, network access, spending or effect grants occur here.
Semantic source analysis remains the responsible agent's job.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

FORMAT = "specialist-discovery/1"
ARCHIVED = {"archive", "archives", "archived", "uninstalled", "disabled"}
FIT_FIELDS = ("capabilities", "inputs", "outputs", "stages", "compatibility", "rights", "limits", "need_fit")


def digest(content):
    return hashlib.sha256(content).hexdigest()


def frontmatter_name(content):
    """Only the initial frontmatter defines identity; body examples do not."""
    header = re.match(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", content, re.S)
    names = re.findall(r"(?m)^name:[ \t]*(.*?)[ \t]*$", header.group(1)) if header else []
    if len(names) != 1:
        return None
    name = names[0].strip()
    if len(name) >= 2 and name[0] in "\"'" and name[-1] == name[0]:
        name = name[1:-1]
    return name if len(name) <= 64 and re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) else None


def contained(path, roots):
    return any(path == root or root in path.parents for root in roots)


def source_record(path, roots):
    """Read source only within approved roots, without executing its content."""
    path = Path(path)
    if path.is_symlink() or not contained(path.resolve(), roots):
        raise ValueError("source is outside approved roots or is a symlink")
    content = path.read_bytes()
    name = frontmatter_name(content.decode("utf-8"))
    if not name:
        raise ValueError("missing or invalid leading frontmatter name")
    title = re.search(r"(?m)^# ([^\n]*)", content.decode("utf-8"))
    heading = re.search(r"\b(\d+\.\d+(?:\.\d+)?)\b", title.group(1)) if title else None
    source = {"path": str(path.resolve()), "sha256": digest(content),
              "version": heading.group(1) if heading else "unknown", "files": []}
    card = path.parent / "assets" / "capability-card.json"
    if card.is_file():
        if card.is_symlink() or not contained(card.resolve(), roots):
            raise ValueError("capability card is outside approved roots or is a symlink")
        card_bytes = card.read_bytes()
        source["files"].append({"path": str(card.resolve()), "sha256": digest(card_bytes)})
        try:
            profile = json.loads(card_bytes)
        except (ValueError, UnicodeError):
            profile = {"error": "invalid capability card; analyze actual source"}
    else:
        profile = None
    return name, source, profile


def inventory(host, roots=(), catalogs=(), exclude_sources=(), snapshot_roots=()):
    if host not in {"work", "codex"}:
        raise ValueError("host must be work or codex")
    roots = [Path(p).resolve() for p in roots]
    approved_roots = roots + [Path(p).resolve() for p in snapshot_roots]
    if any(not p.is_dir() for p in approved_roots):
        raise ValueError("approved source roots must be existing directories")
    excluded = {str(Path(p).resolve()) for p in exclude_sources}
    entries = []
    for catalog in catalogs:
        if not isinstance(catalog, dict) or not isinstance(catalog.get("entries"), list):
            raise ValueError("metadata must contain an entries array")
        entries.extend(catalog["entries"])
    for root in roots:
        paths = [root / "SKILL.md"] if (root / "SKILL.md").is_file() else list(root.glob("*/SKILL.md"))
        for folder in ARCHIVED:
            paths.extend(root.glob(folder + "/*/SKILL.md"))
        for path in sorted(set(paths)):
            if str(path.resolve()) not in excluded:
                entries.append({"host": host, "source": str(path), "installed": True, "listed": False})
    candidates = {}
    diagnostics = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("metadata entry must be an object")
        entry_host = entry.get("host", host)
        if entry_host not in {"work", "codex"}:
            raise ValueError("metadata host must be work or codex")
        reference = entry.get("source", "")
        if not isinstance(reference, str):
            raise ValueError("metadata source must be a path or resource identifier")
        if reference and "://" not in reference and str(Path(reference).resolve()) in excluded:
            continue
        name, source, profile = entry.get("name"), {"reference": reference, "version": entry.get("version", "unknown")}, None
        issues = []
        checked = False
        # A counterpart's path never authorizes probing another host or machine.
        snapshot = entry.get("source_snapshot")
        if entry_host == host and (snapshot or (reference and "://" not in reference)):
            try:
                actual_name, actual_source, profile = source_record(snapshot or reference, approved_roots)
                if snapshot:
                    actual_source.update(reference=reference, kind="reader_snapshot")
                if name and name != actual_name:
                    issues.append("metadata_name_mismatch")
                name, source, checked = actual_name, actual_source, True
                if entry.get("sha256") and entry["sha256"] != source["sha256"]:
                    issues.append("stale_metadata_hash")
                if entry.get("version") and entry["version"] != source["version"]:
                    issues.append("stale_metadata_version")
            except (OSError, UnicodeError, ValueError) as error:
                issues.append(str(error))
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or len(name) > 64:
            diagnostics.append({"source": reference, "issue": "unresolved_identity", "details": issues})
            continue
        archived = entry.get("status") in ARCHIVED or bool(set(Path(reference).parts) & ARCHIVED)
        identity = entry_host + ":" + name + ":" + digest(str(source.get("path", reference)).encode())[:12]
        record = candidates.setdefault(identity, {
            "id": identity, "name": name, "host": entry_host,
            "selectors": {"work": "@" + name, "codex": "$" + name},
            "source": source, "availability": {"listed": False, "installed": False, "source_checked": False},
            "status": "archived" if archived else "active", "issues": [], "capability_card": profile,
            "source_analysis_required": True,
        })
        for key, value in {"listed": entry.get("listed", True), "installed": entry.get("installed", False), "source_checked": checked}.items():
            # Other-host availability is unverified, even if a metadata hint says installed.
            record["availability"][key] |= bool(value) if entry_host == host else False
        record["issues"] = sorted(set(record["issues"] + issues))
        if checked:
            record["source"], record["capability_card"] = source, profile
    grouped = {}
    for record in candidates.values():
        if record["status"] == "active" and record["host"] == host and (record["availability"]["installed"] or record["availability"]["listed"]):
            grouped.setdefault(record["name"], []).append(record)
    for group in grouped.values():
        if len(group) > 1:
            for record in group:
                record["issues"].append("ambiguous_installed_identity")
    for record in candidates.values():
        state = record["availability"]
        record["availability_status"] = ("source_checked" if state["source_checked"] else "installed" if state["installed"] else "available" if state["listed"] else "unverified")
        record["selectable_after_analysis"] = record["host"] == host and record["status"] == "active" and (state["installed"] or state["listed"]) and state["source_checked"] and not record["issues"]
    return {"schema_version": FORMAT, "host": host, "approved_roots": [str(p) for p in approved_roots],
            "candidates": sorted(candidates.values(), key=lambda r: r["id"]), "diagnostics": diagnostics,
            "execution_performed": False, "grants_created": []}


def validate_decision(report, decision):
    """Check an agent-authored analysis; do not invent semantic fit or authority."""
    errors = []
    candidates = {row["id"]: row for row in report.get("candidates", [])}
    if report.get("schema_version") != FORMAT:
        errors.append("unsupported inventory format")
    mode = decision.get("decision")
    required = decision.get("requirement_ids", [])
    selected = decision.get("selected", [])
    if mode not in {"reuse", "compose", "extend", "create_gap"}:
        errors.append("decision must be reuse, compose, extend or create_gap")
    for key in ("reason", "search_scope", "authority_ref"):
        if not isinstance(decision.get(key), str) or not decision[key].strip():
            errors.append("missing " + key)
    if not isinstance(required, list) or not required or any(not isinstance(x, str) or not x for x in required) or len(set(required)) != len(required):
        errors.append("unique nonempty requirement_ids required")
        required = []
    if not isinstance(selected, list) or len(set(selected)) != len(selected):
        errors.append("selected must be a unique candidate ID array")
        selected = []
    resolutions = {}
    resolution_records = decision.get("identity_resolutions", [])
    if not isinstance(resolution_records, list):
        errors.append("identity_resolutions must be an array")
        resolution_records = []
    for resolution in resolution_records:
        if not isinstance(resolution, dict):
            errors.append("identity resolution must be an object")
            continue
        identity = resolution.get("candidate_id")
        row = candidates.get(identity)
        if (not row or row["host"] != report.get("host") or row["name"] in resolutions
                or "ambiguous_installed_identity" not in row["issues"]
                or any(not isinstance(resolution.get(k), str) or not resolution[k].strip() for k in ("binding_ref", "reason"))):
            errors.append("identity resolution requires one actual current-host binding reference and reason per ambiguous slug")
        else:
            resolutions[row["name"]] = identity
    analyses = decision.get("analyses", [])
    if not isinstance(analyses, list):
        errors.append("analyses must be an array")
        analyses = []
    by_id = {}
    covered = set()
    for analysis in analyses:
        if not isinstance(analysis, dict):
            errors.append("analysis must be an object")
            continue
        identity = analysis.get("candidate_id")
        candidate = candidates.get(identity)
        if not candidate or identity in by_id:
            errors.append("unknown or duplicate analyzed candidate: " + str(identity))
            continue
        by_id[identity] = analysis
        if analysis.get("source_sha256") != candidate["source"].get("sha256") or not candidate["availability"]["source_checked"]:
            errors.append(identity + ": actual source analysis pin required")
        if not all(isinstance(analysis.get(key), str) and analysis[key].strip() for key in FIT_FIELDS):
            errors.append(identity + ": all fit dimensions require explicit source analysis")
        if analysis.get("fit") not in {"usable", "extend", "incompatible", "unknown"}:
            errors.append(identity + ": invalid fit")
        coverage = analysis.get("requirement_ids", [])
        if not isinstance(coverage, list) or any(x not in required for x in coverage):
            errors.append(identity + ": invalid requirement coverage")
            coverage = []
        # Re-read the pinned files at decision time; an old review cannot select changed source.
        for pinned in [candidate["source"]] + candidate["source"].get("files", []):
            path = pinned.get("path")
            try:
                current = Path(path).read_bytes() if path else b""
                if not path or digest(current) != pinned.get("sha256"):
                    errors.append(identity + ": source changed; rediscover and reanalyze")
            except OSError:
                errors.append(identity + ": source unavailable; rediscover")
        dependencies = analysis.get("source_files", [])
        if not isinstance(dependencies, list):
            errors.append(identity + ": source_files must be an array")
            dependencies = []
        for pinned in dependencies:
            try:
                path = Path(pinned["path"])
                roots = [Path(p).resolve() for p in report.get("approved_roots", [])]
                if path.is_symlink() or not contained(path.resolve(), roots) or digest(path.read_bytes()) != pinned.get("sha256"):
                    errors.append(identity + ": consulted source dependency stale or outside approved roots")
            except (OSError, TypeError, KeyError):
                errors.append(identity + ": invalid consulted source dependency")
        if identity in selected:
            resolved = (resolutions.get(candidate["name"]) == identity
                        and candidate["status"] == "active" and candidate["availability"]["source_checked"]
                        and not (set(candidate["issues"]) - {"ambiguous_installed_identity"}))
            if not (candidate["selectable_after_analysis"] or resolved) or analysis.get("fit") not in {"usable", "extend"}:
                errors.append(identity + ": candidate is not selectable")
            if mode in {"reuse", "compose"} and analysis.get("fit") != "usable":
                errors.append(identity + ": extension required")
            covered.update(coverage)
    for identity in selected:
        if identity not in by_id:
            errors.append(str(identity) + ": selected candidate lacks actual source analysis")
    counterpart_assessments = {}
    counterpart_records = decision.get("counterpart_assessments", [])
    if not isinstance(counterpart_records, list):
        errors.append("counterpart_assessments must be an array")
        counterpart_records = []
    for assessment in counterpart_records:
        if not isinstance(assessment, dict):
            errors.append("counterpart assessment must be an object")
            continue
        identity = assessment.get("candidate_id")
        row = candidates.get(identity)
        status = assessment.get("status")
        if (not row or row["host"] == report.get("host") or row["status"] != "active"
                or identity in counterpart_assessments or status not in {"unknown", "bridge", "incompatible", "irrelevant"}):
            errors.append("counterpart assessment requires one known other-host candidate and an explicit status")
            continue
        counterpart_assessments[identity] = assessment
        if not isinstance(assessment.get("reason"), str) or not assessment["reason"].strip():
            errors.append(identity + ": counterpart assessment reason required")
        if status == "unknown":
            continue
        scope = assessment.get("requirement_ids", [])
        if not isinstance(scope, list) or not scope or any(x not in required for x in scope):
            errors.append(identity + ": counterpart assessment must name considered requirement IDs")
        elif status in {"irrelevant", "incompatible"} and set(scope) != set(required):
            errors.append(identity + ": excluding a counterpart from create_gap requires assessment against every requested requirement")
        if not isinstance(assessment.get("need_fit"), str) or not assessment["need_fit"].strip():
            errors.append(identity + ": source-backed counterpart need_fit required")
        review = assessment.get("source_review", {})
        try:
            path = Path(review["path"])
            roots = [Path(p).resolve() for p in report.get("approved_roots", [])]
            if path.is_symlink() or not contained(path.resolve(), roots):
                raise ValueError("counterpart review is outside approved roots")
            content = path.read_bytes()
            if (digest(content) != review.get("sha256") or frontmatter_name(content.decode("utf-8")) != row["name"]
                    or review.get("host") != row["host"] or not review.get("reference")
                    or review["reference"] != row["source"].get("reference")):
                raise ValueError("counterpart source review pin does not match candidate")
        except (OSError, TypeError, KeyError, UnicodeError, ValueError):
            errors.append(identity + ": actual counterpart source review pin required; availability stays unverified")
        if status == "bridge" and not assessment.get("bridge_ref"):
            errors.append(identity + ": suitable other-host specialist requires a bounded bridge reference")
    if mode == "reuse" and len(selected) != 1:
        errors.append("reuse requires exactly one specialist")
    if mode == "compose" and (len(selected) < 2 or not decision.get("interface_contract_ref")):
        errors.append("compose requires multiple specialists and an interface contract")
    gaps = set(required) - covered
    if mode in {"reuse", "compose"} and gaps:
        errors.append("selected specialists do not cover all requirements")
    if mode == "extend" and (not selected or not covered or not gaps or set(decision.get("gap_requirement_ids", [])) != gaps):
        errors.append("extend requires existing specialists and exact uncovered requirement IDs")
    if mode == "create_gap":
        active = {r["id"] for r in candidates.values() if r["host"] == report.get("host") and r["status"] == "active"}
        other_host = {r["id"] for r in candidates.values() if r["host"] != report.get("host") and r["status"] == "active"}
        if any(i not in counterpart_assessments or counterpart_assessments[i]["status"] in {"unknown", "bridge"} for i in other_host):
            errors.append("known other-host shortlist candidates need source-backed applicability assessment; unknown or bridge cannot justify a duplicate engine")
        if report.get("diagnostics") or any(set(candidates[i]["issues"]) - ({"ambiguous_installed_identity"} if candidates[i]["name"] in resolutions else set()) for i in active):
            errors.append("resolve inventory ambiguity, stale metadata and unreadable identities before concluding a gap")
        if selected or not active <= set(by_id) or any(a.get("fit") in {"usable", "extend", "unknown"} for a in by_id.values()):
            errors.append("create_gap requires a bounded search with every active candidate analyzed and no reusable or unresolved fit")
        if set(decision.get("gap_requirement_ids", [])) != set(required):
            errors.append("create_gap must name exact missing requirements")
    return {"valid": not errors, "errors": errors, "decision": mode,
            "execution_performed": False, "grants_created": [], "semantic_quality_certified": False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    scan = sub.add_parser("inventory", help="read current-host metadata and explicitly approved installed source roots")
    scan.add_argument("--host", required=True, choices=("work", "codex"))
    scan.add_argument("--root", action="append", default=[])
    scan.add_argument("--metadata", action="append", default=[])
    scan.add_argument("--snapshot-root", action="append", default=[], help="approved reader snapshots; do not scan or infer installation")
    scan.add_argument("--exclude-source", action="append", default=[], help="SKILL.md path excluded by current scope; never read it")
    check = sub.add_parser("check-decision", help="validate source pins and an agent-authored reuse decision")
    check.add_argument("inventory")
    check.add_argument("decision")
    args = parser.parse_args(argv)
    try:
        if args.command == "inventory":
            result = inventory(args.host, args.root, [json.loads(Path(p).read_text()) for p in args.metadata], args.exclude_source, args.snapshot_root)
        else:
            result = validate_decision(json.loads(Path(args.inventory).read_text()), json.loads(Path(args.decision).read_text()))
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result.get("valid") is False else 0


if __name__ == "__main__":
    raise SystemExit(main())
