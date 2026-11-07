#!/usr/bin/env python3
"""Read-only Work/Codex status and decision views of existing project records.

No state, approval, job, tool, network or background operation is created. A view
reports recorded claims; use the native controller for current domain gates.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys

VIEW_SCHEMA = "atelier-status-view/1"
LIMIT = 16 * 1024 * 1024
AXES = ("specification", "code", "integration", "device", "human")
PROJECT_PATHS = (".agent-foundry/state.json", ".appatelier/state.json",
                 ".gameatelier/orchestrator/state.json")
SUCCESS = {"pass", "passed", "succeeded", "success", "accept", "accepted"}
FAILURE = {"fail", "failed", "error", "reject", "rejected"}
PENDING = {"blocked", "pending", "running", "not_run"}
SECRET = re.compile(r"(?i)(?:\bBearer\s+[A-Za-z0-9._~+/-]+=*|\b(?:sk-|rnd_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)")
ASSIGNMENT_SECRET = re.compile(r'''(?ix)(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|authorization|secret|token)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)''')
SENSITIVE_NAME = re.compile(r"(?i)(?:^\.env(?:\.|$)|(?:^|[._-])(?:auth|credentials?|secrets?|tokens?|config)(?:[._-]|$)|^\.npmrc$)")


def need(ok, message):
    if not ok:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def clean(value):
    """Only selected text fields reach this function; never dump arbitrary records."""
    if value is None:
        return None
    if isinstance(value, (int, float, bool)):
        return value
    need(isinstance(value, str), "view text must be a scalar string")
    value = SECRET.sub("[REDACTED]", value)
    value = ASSIGNMENT_SECRET.sub(lambda m: m.group(1) + '"[REDACTED]"', value)
    value = re.sub(r"(?i)(https?://)[^/@\s]+:[^/@\s]+@", r"\1[REDACTED]@", value)
    value = re.sub(r"(?i)([?&](?:token|key|secret|password|signature|sig|access_token)=)[^&#\s]+", r"\1[REDACTED]", value)
    return value[:4000] + ("… [truncated view]" if len(value) > 4000 else "")


def scalar(row, *keys):
    for key in keys:
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            return clean(value)
    return None


def safe(path):
    # Inspect the ORIGINAL traversal first: normalizing link/../file must not
    # erase a symlink that the operating system would have traversed.
    path = Path(path).absolute()
    for part in (path, *path.parents):
        need(not part.is_symlink(), "symlink paths are not read")
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        need(not part.is_symlink(), "symlink paths are not read")
    need(path.is_dir() or not SENSITIVE_NAME.search(path.name), "configuration/credential paths are not read")
    return path


def read_bytes(path, limit=LIMIT):
    path = safe(path)
    fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_size <= limit, "bounded regular file required")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(limit + 1)
        after = os.fstat(fd)
        current = path.stat()
        signature = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
        need(len(raw) <= limit and signature(before) == signature(after) == signature(current), "source changed during read; retry from current source")
        return raw
    finally:
        os.close(fd)


def unique_pairs(pairs):
    out = {}
    for key, value in pairs:
        need(key not in out, "duplicate JSON object key")
        out[key] = value
    return out


def read_record(path):
    raw = read_bytes(path)
    def finite_float(value):
        number = float(value)
        need(math.isfinite(number), "nonfinite JSON value")
        return number
    def bounded_int(value):
        need(len(value) <= 128, "oversize JSON integer")
        return int(value)
    data = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_pairs,
                      parse_float=finite_float, parse_int=bounded_int,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON value")))
    need(isinstance(data, dict), "native project record must be an object")
    return data, hashlib.sha256(raw).hexdigest()


def locate(source, project_root=None):
    source = safe(source)
    if source.is_dir():
        need(project_root is None, "project-root is only needed with an explicit source file")
        found = [source / p for p in PROJECT_PATHS if (source / p).exists()]
        need(len(found) == 1, "project must contain exactly one known ledger; provide its explicit source file (ChatBot round/blueprint also needs an explicit file)")
        return safe(found[0]), source
    need(source.suffix.lower() == ".json", "explicit source must be a native JSON record")
    if project_root is not None:
        root = safe(project_root)
    else:
        root = source.parent
        for relative in PROJECT_PATHS:
            parts = PurePosixPath(relative).parts
            if tuple(source.parts[-len(parts):]) == parts:
                root = source.parents[len(parts)-1]
                break
    need(root.is_dir() and (source == root or root in source.parents), "source must remain inside its project root")
    return source, root


def table(data, key, kind):
    values = data.get(key)
    need(isinstance(values, dict if kind == "map" else list), "native " + key + " table has unsupported shape")
    if kind == "map":
        need(all(isinstance(v, dict) and k == v.get("id") for k, v in values.items()), "native table key and row ID differ: " + key)
    values = list(values.values()) if kind == "map" else values
    need(all(isinstance(x, dict) and isinstance(x.get("id"), str) and x["id"] for x in values), "native " + key + " rows require explicit IDs")
    need(len({x["id"] for x in values}) == len(values), "duplicate native row ID in " + key)
    for row in values:
        for field in ("status", "result", "verification", "scope"):
            need(row.get(field) is None or isinstance(row[field], str) or type(row[field]) is bool, "unsupported native row field type: " + field)
    return values


def signed_integrity(data):
    need(isinstance(data.get("journal"), list), "signed ledger requires journal")
    previous = None
    for seq, event in enumerate(data["journal"], 1):
        need(isinstance(event, dict), "invalid native journal event")
        plain = dict(event)
        claim = plain.pop("hash", None)
        need(event.get("seq") == seq and event.get("previous") == previous and digest(plain) == claim, "native journal integrity mismatch")
        previous = claim
    need(data.get("snapshot_hash") == digest({k: v for k, v in data.items() if k != "snapshot_hash"}), "native snapshot integrity mismatch")
    return "snapshot_and_journal_match"


def adapt(data):
    schema = data.get("schema_version")
    if schema == "1.0.0" and all(k in data for k in ("project_id", "purpose", "blueprint", "suite", "tasks", "requirements", "actions")):
        domain, shape, keys = "foundry", "map", ("tasks", "decisions", "requirements", "evidence", "artifacts", "actions")
        integrity = signed_integrity(data)
        bp = data.get("blueprint") or {}
        brief = bp.get("data") or {}
    elif schema == "2.0.0" and all(k in data for k in ("toolkit_version", "project_id", "knowledge_revision", "suite_lock", "tasks", "requirements")):
        domain, shape, keys = "game", "map", ("tasks", "decisions", "requirements", "evidence", "artifacts", "actions")
        integrity = signed_integrity(data)
        brief = data.get("seed_history", {})
    elif schema == "app-atelier-state/1":
        domain, shape, keys = "app", "map", ("job", "decision", "requirement", "evidence", "artifact", "effect")
        integrity, brief = "no_native_snapshot_signature", data.get("profile")
        need(isinstance(brief, dict) and brief.get("schema_version") == "app-atelier-profile/1", "App ledger needs its native profile")
    elif schema in ("chatbot.round/1", "chatbot.blueprint/3"):
        domain, shape = ("chatbot_round" if schema.endswith("round/1") else "chatbot_blueprint"), "list"
        keys = (("runs", "decisions", "requirements", "evidence", None, None) if domain == "chatbot_round"
                else ("attempts", "decisions", "requirements", "evidence", None, None))
        integrity, brief = "no_native_snapshot_signature", data.get("brief")
        need(isinstance(brief, dict) and isinstance(data.get("completion"), dict), "ChatBot record needs brief and completion objects")
        layout = (("findings", "changes", "reviews") if domain == "chatbot_round" else
                  ("platform_adapters", "applicability", "systems", "interactions", "journeys", "operations", "recipes"))
        need(all(isinstance(data.get(k), list) and all(isinstance(x, dict) for x in data[k]) for k in layout), "unsupported ChatBot native layout")
    else:
        raise ValueError("unsupported native project schema/layout; an explicit adapter is required")
    need(isinstance(brief, dict), "native brief has unsupported shape")
    values = []
    for key in keys:
        # ChatBot blueprints have no decision ledger: do not invent one.
        values.append([] if key is None or (key == "decisions" and key not in data and domain == "chatbot_blueprint") else table(data, key, shape))
    pause = data.get("pause", {"active": False})
    need(isinstance(pause, dict) and type(pause.get("active", False)) is bool, "pause.active must be a native boolean")
    return domain, values, brief, integrity, pause


def pick_scope(rows, scope):
    return rows if scope is None else [r for r in rows if r.get("scope") == scope]


def row_view(row):
    return {"id": clean(row["id"]), "recorded_status": scalar(row, "status", "result", "verification", "state") or "unknown",
            "scope": scalar(row, "scope"), "stage": scalar(row, "stage", "phase_id", "phase"),
            "summary": scalar(row, "goal", "intent", "question", "description", "name"),
            "owner": scalar(row, "owner", "observer", "actor_id"),
            "recorded_stale": row.get("status") == "stale" or bool(row.get("stale_reasons")),
            "stale_reasons": [clean(x) for x in row.get("stale_reasons", []) if isinstance(x, str)] if isinstance(row.get("stale_reasons", []), list) else ["Native stale reason has unsupported shape; inspect the native record."]}


def decision_view(row):
    out = row_view(row)
    for field in ("question", "reason", "explanation", "recommendation", "answer", "category", "effect", "source"):
        if isinstance(row.get(field), str):
            out[field] = clean(row[field])
    if "material" in row:
        need(type(row["material"]) is bool, "decision.material must be a native boolean")
        out["material"] = row["material"]
    options = row.get("options", [])
    need(isinstance(options, list) and all(isinstance(v, str) for v in options), "decision options require an explicit string list")
    out["options"] = [clean(v) for v in options]
    consequences = row.get("consequences", {})
    need(isinstance(consequences, dict), "decision consequences must be an object")
    out["consequences"] = {clean(k): clean(v) for k, v in consequences.items() if isinstance(v, str)}
    for key in ("revision", "decision_revision", "definition_sha256", "subject_sha256", "approved_sha256"):
        if type(row.get(key)) in (str, int):
            out[key] = clean(row[key])
    for key in ("task_ids", "requirement_ids", "phase_ids", "depends_on"):
        if key in row:
            need(isinstance(row[key], list) and all(isinstance(x, str) for x in row[key]), "decision affected IDs require a string list")
            out[key] = [clean(x) for x in row[key]]
    out["authority_verified_by_view"] = False
    out["record_is_not_new_consent"] = True
    return out


def result(row, domain=None):
    # Controllers, not similarly named extra fields, define native authority.
    value = row.get("status") if domain in ("foundry", "game", "app") else row.get("result", row.get("status"))
    if row.get("stale_reasons"):
        return "stale"
    if value is True:
        return "unknown"  # A bare boolean is not a typed evidence result.
    return value if isinstance(value, str) else "unknown"


def proof_axes(evidence, data, domain, scope=None):
    groups = {k: [] for k in AXES}
    by_id = {r["id"]: r for r in evidence}
    test_defs = {}
    if domain == "foundry":
        bp = (data.get("blueprint") or {}).get("data", {})
        for r in bp.get("tests", []):
            if isinstance(r, dict):test_defs[r.get("id")] = r
        test_defs.update(data.get("project_tests", {}))
    direct = {"document": "specification", "specification": "specification", "build": "code", "unit": "code", "code": "code",
              "integration": "integration", "device": "device", "human": "human", "human_validation": "human"}
    for r in evidence:
        test = test_defs.get(r.get("test_id"), {})
        if domain == "foundry":kind = test.get("kind")
        elif domain == "game":kind = r.get("modality")
        elif domain == "app":kind = r.get("modality") or r.get("kind")
        else:kind = r.get("kind")
        axis = direct.get(kind)
        if axis:
            groups[axis].append({"id": clean(r["id"]), "recorded_result": clean(result(r, domain))})
    if domain == "chatbot_blueprint":
        attempts = {r["id"]: r for r in table(data, "attempts", "list")}
        journeys = pick_scope(table(data, "journeys", "list"), scope)
        for row in journeys:
            attempt_ids, evidence_ids = row.get("attempt_ids", []), row.get("evidence_ids", [])
            need(isinstance(attempt_ids, list) and isinstance(evidence_ids, list) and all(isinstance(x, str) for x in attempt_ids + evidence_ids), "journey proof links must be string lists")
            linked = [attempts.get(x, {}) for x in attempt_ids] + [by_id.get(x, {}) for x in evidence_ids]
            values = [result(x) for x in linked]
            state = "unknown"
            if any(x in FAILURE for x in values):state = "failed"
            elif any(x in PENDING for x in values):state = "pending"
            elif attempt_ids and evidence_ids and row.get("verification") == "passed" and all(x in SUCCESS for x in values):state = "pass"
            groups["integration"].append({"id": clean(row["id"]), "recorded_result": state})
    assessments = data.get("completion", {}).get("assessments", {}) if domain.startswith("chatbot_") else {}
    need(isinstance(assessments, dict) and set(assessments) <= set(AXES), "unsupported completion assessments")
    explicit_unknown = set()
    for axis, row in assessments.items():
        need(isinstance(row, dict) and isinstance(row.get("scope"), str), "native assessment needs an object and explicit scope")
        if scope is not None and row["scope"] != scope:continue
        state, refs = row.get("status"), row.get("evidence_ids", [])
        need(state in ("not_assessed", "pending", "passed", "failed", "not_applicable"), "unsupported native assessment status")
        need(isinstance(refs, list) and all(isinstance(x, str) for x in refs), "assessment evidence IDs require a string list")
        record = {"id": "completion.assessments." + axis, "recorded_result": state,
                  "record_type": "assessment", "scope": clean(row["scope"]), "evidence_ids": [clean(x) for x in refs]}
        groups[axis].append(record)
        # A positive assessment cannot override failed/missing linked records.
        # The helper inspects this ledger only; it does not open proof artifacts.
        if state == "passed":
            if not refs:groups[axis].append({"id": record["id"] + ".missing_evidence", "recorded_result": "unknown"})
            for ref in refs:
                linked = by_id.get(ref, {})
                value = result(linked)
                if axis in ("human", "device") and (linked.get("kind") != axis or not scalar(linked, "actual_observation_ref")):
                    value = "unknown" if value in SUCCESS else value
                groups[axis].append({"id": clean(ref), "recorded_result": clean(value)})
        elif state in ("not_assessed", "not_applicable"):
            explicit_unknown.add(axis)
    out = {}
    for axis, rows in groups.items():
        values = [r["recorded_result"] for r in rows]
        status = "unknown"
        if any(x in FAILURE for x in values):status = "recorded_failed"
        elif any(x in PENDING for x in values):status = "recorded_pending"
        elif axis in explicit_unknown:status = "unknown"
        elif values and all(x in SUCCESS for x in values):status = "recorded_pass"
        elif values:status = "recorded_unresolved"
        out[axis] = {"status": status, "records": rows, "live_or_human_truth_certified": False}
    return out


def unresolved_requirements(requirements, data, domain):
    """Native applicability is not a generic requirement completion status."""
    if domain == "chatbot_round":
        completion = data["completion"]
        ids = completion.get("unresolved_requirement_ids")
        need(ids is None or isinstance(ids, list) and all(isinstance(x, str) for x in ids), "unresolved requirement IDs require a string list")
        reviews = data["reviews"]
        by_requirement = {}
        for review in reviews:
            rid, verdict = review.get("requirement_id"), review.get("verdict")
            need(isinstance(rid, str) and verdict in ("accept", "revise", "block", "unknown"), "unsupported native requirement review")
            by_requirement.setdefault(rid, []).append(verdict)
        terminal = completion.get("status") in ("stage_complete", "scoped_complete")
        team = data.get("team_policy", {})
        need(isinstance(team, dict), "native team policy must be an object")
        assignments = team.get("assignments", {})
        need(isinstance(assignments, dict), "native requirement assignments must be an object")
        def still_open(row):
            rid = row["id"]
            verdicts = by_requirement.get(rid, [])
            carried = assignments.get(rid, {})
            need(isinstance(carried, dict), "native requirement assignment must be an object")
            # An accepted review is a recorded claim, not current artifact proof.
            return (ids is None or rid in ids or any(v != "accept" for v in verdicts) or
                    not (verdicts or terminal and carried.get("status") in ("carried", "out_of_scope")))
        return [row_view(r) for r in requirements if still_open(r)]
    if domain == "chatbot_blueprint":
        # Blueprint maturity describes the declared contract. It does not close
        # delivery requirements or certify execution in this read-only helper.
        return [row_view(r) for r in requirements if r.get("state", "active") not in ("excluded", "not_applicable")]
    return [row_view(r) for r in requirements if r.get("status") not in ("met", "closed", "complete", "not_applicable")]


def build_view(source, project_root=None, scope=None):
    path, root = locate(source, project_root)
    data, source_hash = read_record(path)
    domain, tables, brief, integrity, pause = adapt(data)
    tasks, decisions, requirements, evidence, artifacts, effects = [pick_scope(v, scope) for v in tables]
    pending = [decision_view(r) for r in decisions if r.get("status") not in ("confirmed", "accepted", "resolved", "revoked", "superseded", "rejected")]
    task_status = lambda r: r.get("result") if domain == "chatbot_blueprint" else r.get("status")
    done_states = ("passed",) if domain == "chatbot_blueprint" else ("completed", "succeeded")
    active = [row_view(r) for r in tasks if task_status(r) == "running"]
    todo = [row_view(r) for r in tasks if task_status(r) not in (*done_states, "cancelled", "running")]
    completed = [row_view(r) for r in tasks if task_status(r) in done_states]
    unknown_effects = [row_view(r) for r in effects if r.get("status") in ("pending", "unknown", "dispatched")]
    open_requirements = unresolved_requirements(requirements, data, domain)
    gaps = []
    errors = data.get("integrity_errors", [])
    need(isinstance(errors, list), "integrity_errors must be a list")
    gaps += [clean(x) for x in errors if isinstance(x, str)]
    if data.get("suite_mismatch") is True:gaps.append("Native record reports a suite mismatch; reconcile it with the native controller.")
    if unknown_effects:gaps.append("External outcomes remain pending/unknown; reconcile before dependent retry.")
    if scope is not None:gaps.append("This is an exact-scope projection; it is not an overall project gate.")
    completion = data.get("completion", {})
    need(isinstance(completion, dict), "native completion must be an object")
    outcome = scalar(completion, "outcome", "status")
    completion_conflict = domain == "chatbot_round" and outcome in ("stage_complete", "scoped_complete") and bool(open_requirements)
    if completion_conflict:gaps.append("Recorded completion conflicts with unresolved or unaccepted selected requirements; inspect the native controller.")
    workflow = "paused" if pause.get("active") is True else ("blocked" if errors or data.get("suite_mismatch") is True or completion_conflict else
               "recorded_cancelled" if outcome == "cancelled" else
               "recorded_completed" if outcome in ("accepted_done", "completed", "stage_complete", "scoped_complete") else "active" if active else
               "waiting_decision" if pending else "planned" if todo else "unresolved")
    checkpoint = data.get("checkpoint", {})
    need(isinstance(checkpoint, dict), "checkpoint must be an object")
    next_action = scalar(checkpoint, "next_action")
    if pause.get("active") is True:next_action = "Preserve checkpoint; resume only under an actual applicable user instruction."
    elif unknown_effects:next_action = "Reconcile the recorded unknown external outcomes before dependent retry."
    elif completion_conflict:next_action = "Reconcile the recorded completion and unresolved requirements with the native controller."
    elif workflow == "recorded_cancelled":next_action = "Preserve the cancellation record and reconcile any already dispatched effects."
    elif workflow == "recorded_completed":next_action = "Preserve the final result and checkpoint; no next stage is invented."
    elif not next_action:
        next_action = "Review pending decisions and their exact scope." if pending else "Continue the authorized active task." if active else "Use the native controller to inspect current scope, dependencies and the next permitted step."
    revision = data.get("revision", brief.get("version"))
    need(revision is None or type(revision) in (str, int), "native revision must be text/integer")
    goal = scalar(brief, "goal", "user_intent", "intent", "description", "name") or scalar(data, "goal")
    return {"schema_version": VIEW_SCHEMA, "mode": "read_only_projection", "domain": domain,
            "source": {"path": clean(str(path)), "project_root": clean(str(root)), "sha256": source_hash,
                       "native_schema": data["schema_version"], "revision": revision, "record_integrity": integrity},
            "project_id": clean(data.get("project_id", brief.get("id", "unknown"))), "goal": goal,
            "scope": clean(scope) if scope is not None else "all_recorded_scopes", "workflow_status": workflow,
            "pause": {"active": pause.get("active", False), "reason": scalar(pause, "reason")},
            "current_work": active, "pending_work": todo, "recorded_completed_work": completed,
            "pending_decisions": pending, "recorded_decisions": [decision_view(r) for r in decisions],
            "open_requirements": open_requirements, "unknown_effects": unknown_effects,
            "evidence_axes": proof_axes(evidence, data, domain, scope), "gaps": gaps,
            "recorded_completion": {"status": outcome, "stage": scalar(completion, "stage", "maturity"),
                                    "scope": scalar(completion, "scope", "claimed_scope")},
            "next_action": clean(next_action), "native_gate_checked": False,
            "limitations": ["Recorded claims are not actual execution or user acceptance.",
                            "The native domain controller owns current scope, dependency and authorization gates.",
                            "Only source-file integrity is checked; artifact/proof files, environment, native builds, providers and human observations are not exercised.",
                            "Redaction is best-effort; keep credentials out of project state and public free-text fields."]}


def markdown(view, decision_id=None):
    def line(value):
        return str(value if value is not None else "невідомо").replace("\n", " ").replace("\r", " ")
    if decision_id is not None:
        found = next((r for r in view["recorded_decisions"] if r["id"] == decision_id), None)
        need(found is not None, "decision ID absent from this exact source/scope")
        parts = ["# Рішення: " + line(found["id"]), "", "Питання: " + line(found.get("question")),
                 "Причина: " + line(found.get("reason", found.get("explanation"))),
                 "Рекомендація: " + line(found.get("recommendation")), "Обсяг: " + line(found.get("scope")),
                 "Записаний статус: " + line(found["recorded_status"]), ""]
        parts += ["- " + line(x) + ": " + line(found["consequences"].get(x)) for x in found["options"]]
        parts += ["", "Записана відповідь: " + line(found.get("answer")),
                  "Ця картка не створює згоду й не перевіряє її справжність."]
    else:
        parts = ["# Поточний стан: " + line(view["project_id"]), "", "Мета: " + line(view["goal"]),
                 "Обсяг: " + line(view["scope"]), "Стан: " + line(view["workflow_status"]), "",
                 "Записаний етап: " + line(view["recorded_completion"]["stage"]),
                 "Зараз: " + (", ".join(line(r["id"]) for r in view["current_work"]) or "немає записаних активних робіт"),
                 "Очікує рішення: " + (", ".join(line(r["id"]) for r in view["pending_decisions"]) or "немає записаних pending-рішень"),
                 "Записано завершеними: " + (", ".join(line(r["id"]) + (" [recorded stale]" if r["recorded_stale"] else "") for r in view["recorded_completed_work"]) or "немає"), "",
                 "## Докази за окремими осями", ""]
        parts += ["- " + key + ": " + value["status"] for key, value in view["evidence_axes"].items()]
        parts += ["", "Наступна дія: " + line(view["next_action"])]
        parts += ["- Обмеження: " + line(x) for x in view["gaps"]]
        parts += ["", "Це проєкція записаного стану; actual execution, предметну якість і поточний дозвіл перевіряють окремо."]
    parts += ["", "Джерело: " + line(view["source"]["path"]), "SHA-256: " + view["source"]["sha256"]]
    return "\n".join(parts) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("status", "decision"):
        p = commands.add_parser(command)
        p.add_argument("--source", type=Path, required=True, help="Known project root or explicit native JSON; never config/credential files")
        p.add_argument("--project-root", type=Path, help="Explicit project root for a record with project-relative references")
        p.add_argument("--scope", help="Exact scope filter; omitted means all recorded scopes")
        p.add_argument("--format", choices=("json", "markdown"), default="markdown")
        if command == "decision":p.add_argument("--id", required=True)
    args = parser.parse_args(argv)
    try:
        view = build_view(args.source, args.project_root, args.scope)
        if args.command == "decision":
            row = next((r for r in view["recorded_decisions"] if r["id"] == args.id), None)
            need(row is not None, "decision ID absent from this exact source/scope")
            if args.format == "json":print(json.dumps({"schema_version": "atelier-decision-view/1", "source": view["source"], "decision": row, "native_gate_checked": False}, ensure_ascii=False, indent=2))
            else:print(markdown(view, args.id), end="")
        elif args.format == "json":print(json.dumps(view, ensure_ascii=False, indent=2, allow_nan=False))
        else:print(markdown(view), end="")
        return 0
    except (OSError, ValueError, TypeError, KeyError, AttributeError, UnicodeError, RecursionError, OverflowError) as exc:
        # OSError/UnicodeError representations may contain an arbitrary path or
        # source byte excerpt. Do not echo those values into a shared transcript.
        message = "source path operation failed" if isinstance(exc, OSError) else "source is not valid UTF-8" if isinstance(exc, UnicodeError) else clean(str(exc))
        print(json.dumps({"ok": False, "error": message, "writes_performed": False}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
