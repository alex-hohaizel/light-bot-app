#!/usr/bin/env python3
"""Read local source/checkpoint records. Report recorded evidence, never grant rights."""
import argparse
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import parse_qsl, urlsplit
from zoneinfo import ZoneInfo

MAX_BYTES = 2 * 1024 * 1024
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
SOURCE_KEYS = ("operator_id", "territory", "service_date", "source_revision")
EXTERNAL_ACTIONS = {"send", "deploy", "migrate", "webhook", "export"}
ACTION_KINDS = EXTERNAL_ACTIONS | {"read", "local_build", "stop", "reconcile"}
SCHEDULE_STATES = {"scheduled", "explicit_none", "possible", "emergency"}


class InvalidRecord(ValueError):
    pass


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidRecord("duplicate JSON key")
        result[key] = value
    return result


def reject_constant(value):
    raise InvalidRecord("nonfinite JSON number")


def safe_path(root, value):
    if not isinstance(value, str) or not value:
        raise InvalidRecord("missing local path")
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise InvalidRecord("path must stay relative to project root")
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise InvalidRecord("symlink path rejected")
    if not current.is_file():
        raise InvalidRecord("local evidence or input file missing")
    return current


def load_json(root, path):
    file = safe_path(root, path)
    if file.stat().st_size > MAX_BYTES:
        raise InvalidRecord("JSON exceeds 2 MiB")
    try:
        record = json.loads(file.read_text(encoding="utf-8"),
                            object_pairs_hook=object_pairs,
                            parse_constant=reject_constant)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise InvalidRecord("invalid UTF-8 JSON") from error
    if not isinstance(record, dict):
        raise InvalidRecord("top-level JSON must be an object")
    return record


def text(row, key):
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        raise InvalidRecord("missing text field " + key)
    return value


def timestamp(value):
    if not isinstance(value, str):
        raise InvalidRecord("timestamp must be an ISO string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise InvalidRecord("invalid ISO timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise InvalidRecord("timestamp requires explicit timezone")
    return parsed


def fresh(row, now, observed_key="observed_at", expiry_key="valid_until"):
    observed = timestamp(row.get(observed_key))
    expires = timestamp(row.get(expiry_key))
    if observed > now or expires <= observed or expires <= now:
        raise InvalidRecord("future observation or expired validity window")


def boolean(row, key):
    if type(row.get(key)) is not bool:
        raise InvalidRecord("missing boolean field " + key)
    return row[key]


def rows(record, key):
    values = record.get(key)
    if not isinstance(values, list) or any(not isinstance(x, dict) for x in values):
        raise InvalidRecord(key + " must be an array of objects")
    identifiers = [text(x, "id") for x in values]
    if len(set(identifiers)) != len(identifiers):
        raise InvalidRecord("duplicate id in " + key)
    return values


def verify_evidence(root, entry, evidence, now):
    for key in SOURCE_KEYS:
        if text(evidence, key) != text(entry, key):
            raise InvalidRecord("evidence scope mismatch for " + key)
    if evidence.get("level") not in {"source", "integration"}:
        raise InvalidRecord("evidence level must be source or integration")
    if evidence.get("outcome") not in {"pass", "fail", "inconclusive"}:
        raise InvalidRecord("unknown evidence outcome")
    fresh(evidence, now, "checked_at", "expires_at")
    digest = text(evidence, "sha256")
    file = safe_path(root, text(evidence, "path"))
    if not SHA256.fullmatch(digest) or hashlib.sha256(file.read_bytes()).hexdigest() != digest:
        raise InvalidRecord("evidence file digest mismatch")


def verify_url(value):
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise InvalidRecord("source_url must be HTTP(S)")
    if parsed.username or parsed.password:
        raise InvalidRecord("credentials in source URL")
    sensitive = {"token", "key", "api_key", "apikey", "secret", "password", "authorization"}
    if any(key.lower() in sensitive for key, _ in parse_qsl(parsed.query)):
        raise InvalidRecord("sensitive query key in source URL")


def check_source(root, entry, now):
    for key in ("id", "operator_id", "territory", "source_revision"):
        text(entry, key)
    if entry.get("cost") != "free":
        raise InvalidRecord("API/data cost must be free")
    if entry.get("capability") not in {"catalog", "schedule", "address"}:
        raise InvalidRecord("unknown source capability")
    if entry.get("status") not in {"candidate", "active", "blocked"}:
        raise InvalidRecord("unknown source status")
    notify = boolean(entry, "notifications_enabled")
    verify_url(text(entry, "source_url"))
    try:
        service_date = date.fromisoformat(text(entry, "service_date"))
    except ValueError as error:
        raise InvalidRecord("invalid service_date") from error
    evidence = rows(entry, "evidence")
    for item in evidence:
        verify_evidence(root, entry, item, now)
    if entry["status"] != "active":
        if notify:
            raise InvalidRecord("inactive source cannot enable notifications")
        return
    if entry["capability"] == "catalog":
        raise InvalidRecord("catalog row cannot be an active schedule")
    if any(x["outcome"] != "pass" for x in evidence):
        raise InvalidRecord("unresolved evidence cannot qualify active source")
    fresh(entry, now)
    local_today = now.astimezone(ZoneInfo("Europe/Kyiv")).date()
    if service_date not in {local_today, date.fromordinal(local_today.toordinal() + 1)}:
        raise InvalidRecord("active schedule service date must be today or tomorrow in Kyiv")
    if entry.get("schedule_state") not in SCHEDULE_STATES:
        raise InvalidRecord("stale, conflicting or unavailable source cannot be active")
    if entry.get("terms_review") != "allowed":
        raise InvalidRecord("active source requires recorded allowed-use review")
    if not any(x["level"] == "source" and x["outcome"] == "pass" for x in evidence):
        raise InvalidRecord("active source lacks current scoped source evidence")
    if notify:
        if entry["capability"] != "address" or entry.get("address_binding") != "verified":
            raise InvalidRecord("personal notifications require verified address capability")
        if not any(x["level"] == "integration" and x["outcome"] == "pass" for x in evidence):
            raise InvalidRecord("notifications lack recorded scoped integration evidence")


def check_registry(root, record, now):
    if record.get("schema_version") != "lba-source-registry/1":
        raise InvalidRecord("schema_version must be lba-source-registry/1")
    text(record, "project_id")
    entries = rows(record, "sources")
    errors = []
    summary = []
    for index, entry in enumerate(entries):
        label = "source " + str(index + 1)
        try:
            check_source(root, entry, now)
            summary.append({"id": entry["id"], "status": entry["status"],
                            "capability": entry["capability"]})
        except InvalidRecord as error:
            errors.append(label + ": " + str(error))
        except OSError:
            errors.append(label + ": local file could not be read")
    return errors, summary


def check_action(action, grants, now):
    kind = action.get("kind")
    if kind not in ACTION_KINDS:
        raise InvalidRecord("unknown action kind")
    if action.get("outcome") not in {"not_started", "success", "failed", "unknown"}:
        raise InvalidRecord("unknown action outcome")
    if action["outcome"] == "unknown":
        raise InvalidRecord("unknown external outcome requires reconciliation before resume")
    if kind in EXTERNAL_ACTIONS:
        target = text(action, "target")
        grant = grants.get(action.get("authority_id"))
        if not grant or grant.get("kind") != kind or grant.get("target") != target:
            raise InvalidRecord("external action lacks matching recorded authority")
        applied_at = now
        if action["outcome"] in {"success", "failed"}:
            applied_at = timestamp(action.get("performed_at"))
            if applied_at > now:
                raise InvalidRecord("action completion is in the future")
        if timestamp(grant.get("expires_at")) <= applied_at:
            raise InvalidRecord("recorded authority expired at action time")
        text(grant, "source")


def check_checkpoint(record, now):
    if record.get("schema_version") != "lba-checkpoint/1":
        raise InvalidRecord("schema_version must be lba-checkpoint/1")
    for key in ("project_id", "task_id", "phase", "next_step"):
        text(record, key)
    if record["phase"] not in {"P0", "P1", "P2", "P3", "P4", "P5", "P6"}:
        raise InvalidRecord("unknown phase")
    if record.get("status") not in {"ready", "blocked", "paused", "completed"}:
        raise InvalidRecord("unknown checkpoint status")
    repo = record.get("repository")
    if not isinstance(repo, dict):
        raise InvalidRecord("repository identity required")
    for key in ("url", "branch", "sha"):
        text(repo, key)
    if not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", repo["sha"]):
        raise InvalidRecord("repository requires full commit hash")
    grants = {x["id"]: x for x in rows(record, "authorities")}
    errors = []
    for action in rows(record, "actions"):
        try:
            check_action(action, grants, now)
        except InvalidRecord as error:
            errors.append("action " + action["id"] + ": " + str(error))
    return errors, {"task_id": record["task_id"], "phase": record["phase"],
                    "status": record["status"], "recorded_resume_ready": not errors and record["status"] == "ready"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--registry", help="JSON path relative to root")
    parser.add_argument("--checkpoint", help="JSON path relative to root")
    parser.add_argument("--at", help="Explicit aware ISO time for repeatable checks")
    parser.add_argument("--format", choices=("json", "markdown"), default="json")
    args = parser.parse_args()
    result = {"record_validation": "failed", "external_verification": "not_performed", "errors": []}
    try:
        if not args.registry and not args.checkpoint:
            raise InvalidRecord("supply --registry or --checkpoint")
        if not args.root.is_absolute() or not args.root.is_dir():
            raise InvalidRecord("root must be an existing absolute directory")
        if any(part.is_symlink() for part in [args.root, *args.root.parents]):
            raise InvalidRecord("root symlink rejected")
        now = timestamp(args.at) if args.at else datetime.now(timezone.utc)
        project_ids = set()
        if args.registry:
            registry = load_json(args.root, args.registry)
            errors, result["sources"] = check_registry(args.root, registry, now)
            result["errors"].extend(errors)
            project_ids.add(text(registry, "project_id"))
        if args.checkpoint:
            checkpoint = load_json(args.root, args.checkpoint)
            errors, result["checkpoint"] = check_checkpoint(checkpoint, now)
            result["errors"].extend(errors)
            project_ids.add(text(checkpoint, "project_id"))
        if len(project_ids) > 1:
            result["errors"].append("registry and checkpoint project identity mismatch")
        if not result["errors"]:
            result["record_validation"] = "passed"
    except (InvalidRecord, ValueError) as error:
        result["errors"].append(str(error))
    except OSError:
        result["errors"].append("local input or evidence could not be read")
    if result["errors"] and "checkpoint" in result:
        result["checkpoint"]["recorded_resume_ready"] = False
    if args.format == "markdown":
        print("Recorded validation — " + result["record_validation"])
        print("External source and human authorization verification — not performed")
        for source in result.get("sources", []):
            print("- " + source["id"] + " · " + source["capability"] + " · " + source["status"])
        if "checkpoint" in result:
            state = result["checkpoint"]
            print("Task " + state["task_id"] + " · " + state["phase"] + " · " + state["status"])
        for error in result["errors"]:
            print("- ERROR " + error)
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not result["errors"] else 2


if __name__ == "__main__":
    sys.exit(main())
