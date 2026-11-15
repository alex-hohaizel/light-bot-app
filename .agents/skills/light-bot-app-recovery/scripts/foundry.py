#!/usr/bin/env python3
"""Local approval, coverage and workflow records. No model or external executor."""
import argparse
import copy
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import zipfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

VERSION = "1.0.0"
SPECIALIST_SELECTORS = {"app": "app-atelier-director", "chatbot": "chatbot-atelier-director", "agent_skill": "design-specialist-skills"}
SPECIALIST_STAGES = {
    "app": {"app-atelier-" + stage for stage in ("director", "research", "concepts", "specification", "experience", "build", "support", "qa", "release", "growth", "operations")},
    "chatbot": {"chatbot-atelier-" + stage for stage in ("director", "research", "specification", "conversation", "knowledge", "integrations", "media", "build", "qa", "release", "operations")},
    "agent_skill": {"design-specialist-skills"},
}
MAX_FILES = 10000
MAX_BYTES = 256 * 1024 * 1024
HEX = re.compile(r"^[a-f0-9]{64}$")
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
GROUPS = ("lessons", "artifacts", "evidence", "requirements", "project_tests", "decisions", "executions", "tasks", "capabilities", "grants", "actions")
SCRIPT_ROOT = Path(__file__).absolute().parent


def need(value, message):
    if not value:
        raise ValueError(message)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def fields(record, *names):
    need(isinstance(record, dict), "record must be an object")
    for name in names:
        need(name in record and record[name] not in (None, "", []), "nonempty field required: " + name)


def text(value, name):
    need(isinstance(value, str) and value.strip(), "nonempty text required: " + name)
    return value


def strings(value, name):
    need(isinstance(value, list) and all(isinstance(x, str) and x for x in value), name + " must be a string array")
    need(len(set(value)) == len(value), "duplicate values: " + name)
    return value


def source(record):
    fields(record, "source", "verbatim")
    text(record["source"], "source")
    text(record["verbatim"], "verbatim")


def relative(name):
    need(isinstance(name, str) and name and "\\" not in name and ":" not in name, "unsafe relative path")
    p = PurePosixPath(name)
    need(not p.is_absolute() and ".." not in p.parts and name == p.as_posix() and p.parts, "unsafe/noncanonical relative path")
    return p


def safe(root, name, public=False):
    p = relative(name)
    need(not public or p.parts[0] != ".agent-foundry", "artifact cannot be runtime state")
    target = root.joinpath(*p.parts)
    for count in range(1, len(p.parts) + 1):
        need(not root.joinpath(*p.parts[:count]).is_symlink(), "symlink forbidden: " + name)
    return target


def ordinary(path):
    st = path.lstat()
    need(stat.S_ISREG(st.st_mode), "regular file required: " + str(path))
    return st


def read_bytes(path, limit=MAX_BYTES):
    ordinary(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        need(stat.S_ISREG(os.fstat(fd).st_mode), "regular file required")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            value = stream.read(limit + 1)
        need(len(value) <= limit, "file exceeds bounded input limit")
        return value
    finally:
        os.close(fd)


def sha(path):
    return hashlib.sha256(read_bytes(path)).hexdigest()


def input_json(path):
    return json.load(sys.stdin) if str(path) == "-" else json.loads(read_bytes(Path(path)).decode("utf-8"))


def suite():
    root = SCRIPT_ROOT.parent
    return {name: sha(root / name) if (root / name).is_file() else None for name in ("scripts/foundry.py", "assets/blueprint.template.json", "assets/discovery-topics.json", "references/generated-agent-contract.md")}


@contextmanager
def lock(root, create=False):
    for parent in (root, *root.parents):
        need(not parent.is_symlink(), "session path cannot contain symlinks")
    if create:
        root.mkdir(parents=True, exist_ok=True)
    need(root.is_dir(), "session directory missing")
    home = safe(root, ".agent-foundry")
    if create:
        home.mkdir(exist_ok=True)
    need(home.is_dir(), "session not initialized")
    path = home / "lock"
    if path.exists():
        ordinary(path)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0), 0o600)
    try:
        need(stat.S_ISREG(os.fstat(fd).st_mode), "lock must be regular")
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield home
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def read_state(home):
    state = json.loads(read_bytes(home / "state.json").decode())
    need(state.get("schema_version") == VERSION, "unsupported state schema")
    previous = None
    for index, event in enumerate(state.get("journal", []), 1):
        data = dict(event)
        hashed = data.pop("hash", None)
        need(event.get("seq") == index and event.get("previous") == previous and digest(data) == hashed, "journal integrity failure")
        previous = hashed
    need(state.get("snapshot_hash") == digest({k: v for k, v in state.items() if k != "snapshot_hash"}), "snapshot integrity failure")
    return state


def save(home, state, command):
    state["revision"] += 1
    event = {"seq": len(state["journal"]) + 1, "previous": state["journal"][-1]["hash"] if state["journal"] else None, "time": now(), "command": command, "revision": state["revision"]}
    event["hash"] = digest(event)
    state["journal"].append(event)
    state["snapshot_hash"] = digest({k: v for k, v in state.items() if k != "snapshot_hash"})
    fd, name = tempfile.mkstemp(prefix=".state-", dir=home)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(state, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, home / "state.json")
        directory = os.open(home, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def rows(data, key):
    value = data.get(key)
    need(isinstance(value, list) and value, "nonempty blueprint list required: " + key)
    result = {}
    for row in value:
        fields(row, "id")
        need(row["id"] not in result, "duplicate ID in " + key)
        result[row["id"]] = row
    return result


def dag(graph, label):
    done, active = set(), set()
    def visit(node):
        need(node in graph, "unknown dependency in " + label + ": " + node)
        need(node not in active, "cycle in " + label)
        if node in done:
            return
        active.add(node)
        for dependency in graph[node]:
            visit(dependency)
        active.remove(node)
        done.add(node)
    for node in graph:
        visit(node)


def check_blueprint(bp, root):
    need(isinstance(bp, dict) and bp.get("schema_version") == VERSION and bp.get("is_template") is False, "instantiate supported blueprint; templates are not approval-ready")
    fields(bp, "id", "revision", "goal", "scope", "entry_skill", "non_goals", "continuity")
    source(bp)
    need(type(bp["revision"]) is int and bp["revision"] > 0, "positive blueprint revision required")
    for key in ("goal", "scope"):
        text(bp[key], key)
    strings(bp["non_goals"], "non_goals")
    skills = bp.get("skills")
    need(isinstance(skills, list) and skills, "nonempty skills required")
    names = []
    for row in skills:
        fields(row, "name", "purpose", "capability_ids", "phase_ids")
        need(SLUG.fullmatch(row["name"]) and len(row["name"]) <= 64, "portable skill name required")
        names.append(row["name"])
    need(len(set(names)) == len(names) and bp["entry_skill"] in names, "one existing entry skill and unique skill names required")
    groups = {key: rows(bp, key) for key in ("capabilities", "phases", "roles", "components", "artifacts", "tests")}
    all_ids = [key for group in groups.values() for key in group]
    need(len(set(all_ids)) == len(all_ids), "blueprint IDs must be globally unique")
    def refs(row, key, group, nonempty=True):
        values = strings(row.get(key, []), key)
        need(not nonempty or values, "coverage required: " + key)
        need(set(values) <= set(groups[group]), "unknown " + key)
        return values
    for row in groups["roles"].values():
        fields(row, "competence", "responsibility")
    for row in groups["phases"].values():
        fields(row, "name", "acceptance", "handoff", "return_route")
        refs(row, "capability_ids", "capabilities")
        refs(row, "artifact_ids", "artifacts")
        refs(row, "depends_on", "phases", False)
    dag({key: row.get("depends_on", []) for key, row in groups["phases"].items()}, "phase graph")
    for row in groups["components"].values():
        fields(row, "kind", "purpose", "owner")
        need(row["owner"] in groups["roles"], "unknown component owner")
        refs(row, "capability_ids", "capabilities")
        refs(row, "phase_ids", "phases")
        if row["kind"] in SPECIALIST_SELECTORS:
            route = row.get("specialist_route")
            fields(route, "selector", "handoff_artifact_id")
            need(route["selector"] in SPECIALIST_STAGES[row["kind"]], "component requires a stable specialist selector of its own family")
            handoff = groups["artifacts"].get(route["handoff_artifact_id"], {})
            need(handoff.get("kind") == "component_handoff" and str(handoff.get("path", "")).endswith(".json"), "component requires a declared component_handoff JSON artifact")
            shared = strings(route.get("shared_contract_artifact_ids", []), "shared_contract_artifact_ids")
            need(set(shared) <= set(groups["artifacts"]), "unknown shared contract artifact")
    product_components = [row for row in groups["components"].values() if row["kind"] in {"app", "chatbot"}]
    if {row["kind"] for row in product_components} == {"app", "chatbot"}:
        for row in product_components:
            need(row["specialist_route"].get("shared_contract_artifact_ids"), "mixed app/chatbot components need explicit shared contract artifacts")
    paths = []
    for row in groups["artifacts"].values():
        fields(row, "path", "kind", "phase_id", "owner", "acceptance")
        relative(row["path"])
        paths.append(row["path"].casefold())
        need(row["phase_id"] in groups["phases"] and row["owner"] in groups["roles"], "unknown artifact phase/owner")
        refs(row, "capability_ids", "capabilities")
    need(len(set(paths)) == len(paths), "duplicate/case-colliding artifact paths")
    for row in groups["tests"].values():
        fields(row, "method", "negative_case", "due_phase")
        need(type(row.get("independent")) is bool, "explicit test independence required")
        need(row["due_phase"] in groups["phases"], "unknown test due phase")
        refs(row, "capability_ids", "capabilities")
        refs(row, "artifact_ids", "artifacts")
    for row in groups["capabilities"].values():
        source(row)
        fields(row, "intent", "priority", "owner", "acceptance", "applicability")
        need(row["priority"] in ("must", "should", "explore") and type(row.get("emphasis")) is bool, "priority/emphasis required")
        need(row["owner"] in groups["roles"], "unknown capability owner")
        need(row["applicability"] in ("applicable", "not_applicable"), "applicability must be decided before approval")
        if row["applicability"] == "not_applicable":
            text(row.get("rationale"), "N/A rationale")
            need(row["priority"] != "must" and not row["emphasis"], "explicit must/emphasis cannot be made N/A")
        for key, group in (("phase_ids", "phases"), ("component_ids", "components"), ("artifact_ids", "artifacts"), ("test_ids", "tests")):
            refs(row, key, group, row["applicability"] == "applicable")
        refs(row, "depends_on", "capabilities", False)
        if row["applicability"] == "applicable":
            for key, group in (("phase_ids", "phases"), ("component_ids", "components"), ("artifact_ids", "artifacts"), ("test_ids", "tests")):
                need(all(row["id"] in groups[group][ref]["capability_ids"] for ref in row[key]), "bidirectional coverage mismatch: " + row["id"] + "/" + key)
    dag({key: row.get("depends_on", []) for key, row in groups["capabilities"].items()}, "capability graph")
    for row in skills:
        refs(row, "capability_ids", "capabilities")
        refs(row, "phase_ids", "phases")
        need("skills/" + row["name"] + "/SKILL.md" in {r["path"] for r in groups["artifacts"].values()}, "every approved skill needs an expected SKILL.md artifact")
    need({ident for ident, row in groups["capabilities"].items() if row["applicability"] == "applicable"} <= {ident for row in skills for ident in row["capability_ids"]}, "every applicable capability must belong to a skill")
    for row in groups["capabilities"].values():
        if row["applicability"] != "applicable":
            continue
        need(set(row["artifact_ids"]) <= {ident for test_id in row["test_ids"] for ident in groups["tests"][test_id]["artifact_ids"]}, "capability tests must cover every declared output")
        need(all(groups["artifacts"][ident]["phase_id"] in row["phase_ids"] for ident in row["artifact_ids"]), "capability output phase mismatch")
    for key in ("requirements", "knowledge", "decisions", "dependencies", "evidence", "pauses", "approvals", "handoffs", "maintenance", "honesty"):
        text(bp["continuity"].get(key), "continuity." + key)
    need(isinstance(bp.get("questions"), list), "explicit questions array required")
    blockers = []
    for q in bp["questions"]:
        fields(q, "id", "question", "explanation", "status")
        need(type(q.get("blocking")) is bool, "question blocking flag required")
        need(q["status"] in ("pending", "resolved", "deferred", "not_applicable"), "unknown question status")
        if q["status"] == "resolved":
            fields(q, "answer")
            source(q)
        elif q["status"] == "not_applicable":
            fields(q, "rationale")
        elif q["blocking"]:
            blockers.append("blocking question: " + q["id"])
        else:
            need(q.get("due_phase") in groups["phases"], "future question needs exact due phase")
    catalog = SCRIPT_ROOT.parent / "assets/discovery-topics.json"
    need(bp.get("discovery_catalog_sha256") == sha(catalog), "blueprint must pin current discovery topic catalog")
    topics = {r["id"] for r in json.loads(read_bytes(catalog).decode())["topics"]}
    evaluations = bp.get("discovery_coverage")
    need(isinstance(evaluations, list), "explicit discovery_coverage required")
    ids = [r.get("topic_id") for r in evaluations if isinstance(r, dict)]
    need(len(ids) == len(evaluations) == len(set(ids)) and topics <= set(ids), "every catalog topic needs one current applicability record")
    questions = {q["id"]: q for q in bp["questions"]}
    for row in evaluations:
        fields(row, "topic_id", "applicability", "rationale", "source", "current_status", "owner", "due_gate")
        need(row["applicability"] in ("applicable", "not_applicable"), "topic applicability must be resolved")
        need(row["current_status"] in ("resolved", "pending", "deferred"), "unknown discovery topic status")
        refs_q = strings(row.get("current_question_ids", []), "current_question_ids")
        deferred = strings(row.get("deferred_product_decisions", []), "deferred_product_decisions")
        strings(row.get("evidence_ids", []), "discovery evidence_ids")
        affected = strings(row.get("affected_capability_ids", []), "affected_capability_ids")
        need(set(refs_q + deferred) <= set(questions) and set(affected) <= set(groups["capabilities"]), "unknown discovery question/capability reference")
        if row["applicability"] == "applicable":
            need(affected, "applicable discovery topic must map to capabilities")
        if row["current_status"] == "pending":
            blockers.append("unresolved construction discovery topic: " + row["topic_id"])
        if row["current_status"] == "deferred":
            need(deferred and row["due_gate"] in groups["phases"] and all(not questions[x]["blocking"] and questions[x].get("due_phase") == row["due_gate"] for x in deferred), "deferred product topic needs nonblocking questions and exact due phase")
    need(isinstance(bp.get("input_sources"), list), "explicit input_sources required")
    for item in bp["input_sources"]:
        fields(item, "path", "sha256", "source")
        need(HEX.fullmatch(item["sha256"]), "source hash required")
        path = safe(root, item["path"], public=True)
        if not path.is_file() or path.is_symlink() or sha(path) != item["sha256"]:
            blockers.append("input source differs: " + item["path"])
    return groups, blockers


def active_blueprint(state, root):
    row = state.get("blueprint")
    need(row is not None, "blueprint missing")
    groups, blockers = check_blueprint(row["data"], root)
    return row, groups, blockers


def approval_current(state, root):
    blockers = list(state.get("integrity_errors", []))
    if state["suite"] != suite():
        blockers.append("suite changed; compatibility review required")
    if state["pause"]["active"]:
        blockers.append("user pause active")
    if not state.get("blueprint"):
        return blockers + ["blueprint missing"]
    bp, _, extra = active_blueprint(state, root)
    blockers += extra
    approval = state.get("approval") or {}
    if approval.get("status") != "confirmed" or approval.get("blueprint_sha256") != bp["sha256"] or approval.get("blueprint_revision") != bp["data"]["revision"] or approval.get("design_revision") != state["design_revision"]:
        blockers.append("current complete blueprint has no exact user approval")
    if approval and not authority_current(root, approval, bp["sha256"]):
        blockers.append("canonical approval source denied/revoked/changed")
    return blockers


def test_defs(state):
    result = {r["id"]: r for r in (state.get("blueprint") or {}).get("data", {}).get("tests", [])}
    result.update(state["project_tests"])
    return result


def file_current(root, row, key="path", hash_key="sha256"):
    try:
        path = safe(root, row[key], public=True)
        return path.is_file() and not path.is_symlink() and sha(path) == row[hash_key]
    except (OSError, ValueError, KeyError):
        return False


def refresh(state, root):
    problems = []
    if state["suite"] != suite():
        problems.append("suite changed; compatibility review required")
    for item in (state.get("blueprint") or {}).get("data", {}).get("input_sources", []):
        if not file_current(root, item):
            problems.append("input source differs: " + item["path"])
    for item in state["intakes"]:
        for row in item["files"]:
            if not file_current(root, row):
                problems.append("immutable imported source differs: " + row["path"])
    if any(not p.startswith("suite changed") for p in problems) and state.get("approval"):
        state["approval"]["status"] = "stale"
    state["integrity_errors"] = sorted(set(problems))
    for row in state["artifacts"].values():
        if not file_current(root, row):
            row["status"] = "stale"
        if state["purpose"] == "factory":
            definitions = {x["id"]: x for x in (state.get("blueprint") or {}).get("data", {}).get("artifacts", [])}
            if row.get("definition_sha256") != digest(definitions.get(row["id"])):
                row["status"] = "stale"
    for row in state["evidence"].values():
        if not file_current(root, row, "proof_path", "proof_sha256") or row.get("test_sha256") != digest(test_defs(state).get(row["test_id"])) or any(state["artifacts"].get(key, {}).get("status") != "current" or state["artifacts"][key]["sha256"] != value for key, value in row["artifact_hashes"].items()):
            row["status"] = "stale"
    changed = True
    while changed:
        changed = False
        for row in state["tasks"].values():
            if row["status"] != "completed":
                continue
            snap = row["completion"]
            stale = any(state["artifacts"].get(k, {}).get("status") != "current" or state["artifacts"][k]["sha256"] != v for k, v in snap["artifacts"].items())
            stale |= any(state["evidence"].get(k, {}).get("status") not in ("pass", "observed") or digest(state["evidence"][k]) != v for k, v in snap["evidence"].items())
            stale |= any(state["tasks"].get(k, {}).get("status") != "completed" or state["tasks"][k]["revision"] != v for k, v in snap["tasks"].items())
            stale |= any(requirement_hash(state["requirements"].get(k, {})) != v for k, v in snap["requirements"].items())
            stale |= any(not closure(state, state["requirements"].get(k, {})) for k in snap["requirements"])
            stale |= bool(phase_prerequisites(state, root, row["phase_id"], row["scope"], state["executions"].get(row["execution_id"], {})))
            if stale:
                row["status"] = "stale"
                changed = True
    for row in state["actions"].values():
        if row["status"] in ("succeeded", "failed") and not file_current(root, row["receipt"], "proof_path", "proof_sha256"):
            row["status"] = "unknown"


def mark_impact(state, ids, phases):
    ids, phases = set(ids), set(phases)
    bp = state["blueprint"]["data"]
    expanded = True
    while expanded:
        before = (set(ids), set(phases))
        ids.update(r["id"] for r in bp["capabilities"] if set(r.get("depends_on", [])) & ids)
        phases.update(r["id"] for r in bp["phases"] if set(r.get("depends_on", [])) & phases)
        expanded = before != (ids, phases)
    for row in state["requirements"].values():
        if row["id"] in ids or row["phase_id"] in phases or set(row.get("capability_ids", [])) & ids:
            row["status"] = "pending"
            ids.add(row["id"])
    for row in state["artifacts"].values():
        if row["id"] in ids or row.get("phase_id") in phases or set(row.get("capability_ids", [])) & ids:
            row["status"] = "stale"
    for row in state["tasks"].values():
        if row["id"] in ids or row["phase_id"] in phases or set(row.get("requirement_ids", [])) & ids:
            row["status"] = "stale"


def authority(record):
    source(record)
    need(record.get("actor") == "user", "actual user authority actor required")
    text(record.get("scope"), "authority scope")


def authority_current(root, record, subject):
    # A command name cannot turn an explicitly denied/revoked record into consent.
    # Older conversational records can omit this optional typed decision; new
    # approve records are normalized below. Their provenance still needs review.
    if record.get("actor") != "user" or record.get("decision", "approve") != "approve" or ("revoked" in record and record["revoked"] is not False) or record.get("status") in {"declined", "denied", "revoked", "cancelled", "rejected"}:
        return False
    binding = record.get("canonical_authority")
    if binding is None:
        return True  # Actual conversational provenance remains an agent/human obligation.
    try:
        fields(binding, "path", "sha256", "record_id")
        path = safe(root, binding["path"], public=True)
        if sha(path) != binding["sha256"]:
            return False
        data = json.loads(read_bytes(path).decode())
        if data.get("schema_version") != "foundry-authority/1":
            return False
        matches = [x for x in data.get("items", []) if x.get("id") == binding["record_id"]]
        return len(matches) == 1 and matches[0].get("actor") == "user" and matches[0].get("decision") == "approve" and matches[0].get("scope") == record["scope"] and matches[0].get("subject_sha256") == subject
    except (OSError, ValueError, KeyError, TypeError):
        return False


def preserve_authority_binding(old, record):
    binding = (old or {}).get("canonical_authority")
    if binding:
        incoming = record.get("canonical_authority", {})
        need(incoming.get("path") == binding["path"] and incoming.get("record_id") == binding["record_id"], "canonical authority binding cannot be dropped or redirected")


def requirement_hash(row):
    return digest({k: v for k, v in row.items() if k not in ("status", "artifact_ids", "evidence_ids", "closure", "revision", "amendment")})


def closure(state, row):
    if row.get("status") == "not_applicable":
        return bool(row.get("rationale")) and row.get("priority") != "must"
    if row.get("status") != "met" or not row.get("artifact_ids") or not row.get("evidence_ids"):
        return False
    artifacts = set(row["artifact_ids"])
    if any(state["artifacts"].get(x, {}).get("status") != "current" for x in artifacts):
        return False
    evidence = [state["evidence"].get(x, {}) for x in row["evidence_ids"]]
    if any(x.get("status") not in ("pass", "observed") for x in evidence):
        return False
    if not artifacts <= {a for e in evidence for a in e.get("artifact_ids", [])}:
        return False
    bound = row.get("closure") or {}
    return bound.get("artifact_hashes") == {a: state["artifacts"][a]["sha256"] for a in artifacts} and bound.get("evidence_hashes") == {e: digest(state["evidence"][e]) for e in row["evidence_ids"]}


def readiness(state, root, task):
    blockers = approval_current(state, root)
    if task["status"] not in ("pending", "running"):
        blockers.append("task is not pending/running")
    execution = state["executions"].get(task["execution_id"], {})
    if execution.get("status") != "current" or execution.get("blueprint_sha256") != state["blueprint"]["sha256"] or execution.get("scope") != task["scope"] or task["phase_id"] not in execution.get("phase_ids", []):
        blockers.append("task lacks current exact execution authority")
    if execution and not authority_current(root, execution, digest({k: execution[k] for k in ("scope", "blueprint_sha256", "phase_ids")})):
        blockers.append("canonical execution authority changed")
    blockers += phase_prerequisites(state, root, task["phase_id"], task["scope"], execution)
    blockers += decision_blockers(state, root, task["phase_id"], task["scope"], task["id"])
    for ident in task["depends_on"]:
        if state["tasks"].get(ident, {}).get("status") != "completed":
            blockers.append("task dependency incomplete: " + ident)
    fulfilled = set(task["fulfills_requirements"])
    for ident in task["requirement_ids"]:
        if ident not in fulfilled and not closure(state, state["requirements"].get(ident, {})):
            blockers.append("required requirement not closed: " + ident)
    for row in state["requirements"].values():
        if row["phase_id"] == task["phase_id"] and row["scope"] == task["scope"] and row["priority"] == "must" and row["id"] not in fulfilled and (row.get("blocks_work") is True or task["id"] in row.get("blocks_task_ids", [])) and not closure(state, row):
            blockers.append("due must not closed: " + row["id"])
    for row in state["actions"].values():
        if row["task_id"] == task["id"] and row["status"] in ("pending", "unknown"):
            blockers.append("reconcile external outcome: " + row["id"])
    return sorted(set(blockers))


def phase_content_blockers(state, root, phase_id, scope, execution_id, require_tasks=True):
    blockers = []
    phases = {r["id"]: r for r in state["blueprint"]["data"]["phases"]}
    tasks = [r for r in state["tasks"].values() if r["phase_id"] == phase_id and r["scope"] == scope and r["execution_id"] == execution_id]
    if require_tasks and (not tasks or any(r["status"] != "completed" for r in tasks)):
        blockers.append("all declared phase tasks must be completed")
    for row in state["requirements"].values():
        if row["phase_id"] == phase_id and row["scope"] == scope and (row["priority"] == "must" or row.get("emphasis")) and not closure(state, row):
            blockers.append("due phase must not closed: " + row["id"])
    if state["purpose"] == "factory":
        for ident in phases[phase_id]["artifact_ids"]:
            if state["artifacts"].get(ident, {}).get("status") != "current":
                blockers.append("current phase output missing: " + ident)
        due_tests = [r for r in state["blueprint"]["data"]["tests"] if r["due_phase"] == phase_id]
    else:
        due_tests = [r for r in state["project_tests"].values() if r["phase_id"] == phase_id and r["scope"] == scope]
    for test in due_tests:
        if not any(r["test_id"] == test["id"] and r["status"] == "pass" and r["test_sha256"] == digest(test) for r in state["evidence"].values()):
            blockers.append("current due phase test pass missing: " + test["id"])
    blockers += decision_blockers(state, root, phase_id, scope)
    return blockers


def phase_prerequisites(state, root, phase_id, scope, execution):
    phases = {x["id"]: x for x in state["blueprint"]["data"]["phases"]}
    blockers = []
    for prior in phases[phase_id].get("depends_on", []):
        tasks = [r for r in state["tasks"].values() if r["phase_id"] == prior and r["scope"] == scope and r["execution_id"] == execution.get("id")]
        completed = bool(tasks) and all(r["status"] == "completed" for r in tasks)
        proof_ids = execution.get("prerequisite_evidence", {}).get(prior, [])
        supplied = bool(proof_ids) and all(state["evidence"].get(x, {}).get("status") in ("pass", "observed") and digest(state["evidence"][x]) == execution.get("prerequisite_hashes", {}).get(x) and all(state["artifacts"][a]["phase_id"] == prior for a in state["evidence"][x]["artifact_ids"]) for x in proof_ids)
        prior_blockers = phase_content_blockers(state, root, prior, scope, execution.get("id"), require_tasks=not supplied)
        if prior_blockers or not (completed or supplied):
            blockers.append("approved phase prerequisite incomplete: " + prior)
        elif not supplied:
            blockers += phase_prerequisites(state, root, prior, scope, execution)
    return blockers


def decision_definition(row):
    return {k: row[k] for k in ("id", "question", "options", "scope", "phase_ids", "task_ids", "material")}


def decision_current(root, row):
    return row.get("status") == "confirmed" and row.get("definition_sha256") == digest(decision_definition(row)) and authority_current(root, row["authority"], digest({"definition_sha256": row["definition_sha256"], "answer": row["answer"]}))


def decision_blockers(state, root, phase_id, scope, task_id=None):
    blockers = []
    for q in state["blueprint"]["data"]["questions"]:
        if q["status"] in ("pending", "deferred") and not q["blocking"] and q.get("due_phase") == phase_id:
            row = state["decisions"].get(q["id"], {})
            if not row or row.get("scope") != scope or not decision_current(root, row):
                blockers.append("future product decision now due: " + q["id"])
    for row in state["decisions"].values():
        if row["material"] and row["scope"] == scope and phase_id in row["phase_ids"] and (not row["task_ids"] or task_id in row["task_ids"] or task_id is None) and not decision_current(root, row):
            blockers.append("material project decision pending/revoked: " + row["id"])
    return blockers


def phase_readiness(state, root, phase_id, scope, execution_id):
    blockers = approval_current(state, root)
    _, groups, _ = active_blueprint(state, root)
    need(phase_id in groups["phases"], "unknown phase")
    execution = state["executions"].get(execution_id, {})
    if execution.get("scope") != scope or execution.get("status") != "current" or execution.get("blueprint_sha256") != state["blueprint"]["sha256"] or phase_id not in execution.get("phase_ids", []):
        blockers.append("phase lacks current execution authority")
    if execution and not authority_current(root, execution, digest({k: execution[k] for k in ("scope", "blueprint_sha256", "phase_ids")})):
        blockers.append("canonical execution authority changed")
    blockers += phase_prerequisites(state, root, phase_id, scope, execution)
    blockers += phase_content_blockers(state, root, phase_id, scope, execution_id)
    return sorted(set(blockers))


def effect_current(state, root, grant):
    blockers = approval_current(state, root)
    if grant.get("decision") != "approve" or grant.get("blueprint_sha256") != state["blueprint"]["sha256"]:
        blockers.append("positive current exact effect authority missing")
    if not authority_current(root, grant, grant["subject_sha256"]):
        blockers.append("canonical effect authority denied/revoked/changed")
    capability = state["capabilities"].get(grant["capability_id"], {})
    if capability.get("available") is not True or digest(capability) != grant["capability_hash"]:
        blockers.append("capability missing/changed")
    if grant["type"] not in capability.get("effect_types", []) or capability.get("scope") != grant["scope"]:
        blockers.append("capability does not support exact effect type/scope")
    for ident, value in grant["artifact_hashes"].items():
        row = state["artifacts"].get(ident, {})
        if row.get("status") != "current" or row.get("sha256") != value:
            blockers.append("approved artifact changed: " + ident)
    return blockers


def put(state, group, row):
    fields(row, "id")
    result = copy.deepcopy(row)
    result["revision"] = state[group].get(row["id"], {}).get("revision", 0) + 1
    if row["id"] in state[group]:
        state["record_history"].append({"group": group, "record": copy.deepcopy(state[group][row["id"]])})
    state[group][row["id"]] = result
    return result


def blueprint_public(state):
    row = state.get("blueprint")
    if not row:
        return None
    data = row["data"]
    return {"id": data["id"], "revision": data["revision"], "sha256": row["sha256"], "entry_skill": data["entry_skill"], "skill_names": [x["name"] for x in data["skills"]]}


def intake(state, root, path, record):
    fields(record, "id", "rights", "source")
    ident = record["id"]
    need(SLUG.fullmatch(ident), "import ID must be portable slug")
    target = safe(root, "inputs/" + ident, public=True)
    need(not target.exists(), "intake never overwrites originals")
    path = Path(path).absolute()
    for parent in (path, *path.parents):
        need(not parent.is_symlink(), "intake source path cannot contain symlinks")
    need(path != root and not path in root.parents and root not in path.parents, "intake source must be separate from session")
    target.parent.mkdir(exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=".intake-", dir=target.parent))
    files, seen, total = [], set(), 0
    def write(name, stream):
        nonlocal total
        relative(name)
        need(name.casefold() not in seen and len(seen) < MAX_FILES, "duplicate/case-colliding path or intake file limit")
        seen.add(name.casefold())
        dest = safe(temp, name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        h = hashlib.sha256()
        with dest.open("xb") as out:
            while True:
                block = stream.read(1024 * 1024)
                if not block:
                    break
                total += len(block)
                need(total <= MAX_BYTES, "bounded intake byte limit exceeded")
                out.write(block)
                h.update(block)
        files.append({"path": "inputs/" + ident + "/" + name, "sha256": h.hexdigest()})
    try:
        if path.is_dir():
            source_paths = sorted(path.rglob("*"))
            for p in source_paths:
                need(not p.is_symlink(), "intake symlink forbidden")
                need(p.is_dir() or p.is_file(), "intake special file forbidden")
                if p.is_file():
                    write(p.relative_to(path).as_posix(), io.BytesIO(read_bytes(p)))
            source_sha = digest([{**r, "path": r["path"].split("/", 2)[2]} for r in files])
        else:
            source_sha = sha(path)
            with zipfile.ZipFile(path) as z:
                need(len(z.infolist()) <= MAX_FILES and sum(x.file_size for x in z.infolist()) <= MAX_BYTES, "bounded intake archive limits exceeded")
                for info in z.infolist():
                    name = info.filename.rstrip("/")
                    relative(name)
                    mode = info.external_attr >> 16
                    need(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), "archive link/special file forbidden")
                    if not info.is_dir():
                        with z.open(info) as stream:
                            write(name, stream)
        need(files, "empty intake")
        os.replace(temp, target)
        result = dict(record, files=files, source_sha256=source_sha, imported_at=now(), executed=False)
        state["intakes"].append(result)
        return result
    finally:
        if temp.exists():
            shutil.rmtree(temp)


def dispatch(state, root, args, record):
    cmd = args.command
    if cmd == "blueprint":
        groups, blockers = check_blueprint(record, root)
        hashed = digest(record)
        previous = state.get("blueprint")
        if previous:
            need(record["id"] == previous["data"]["id"] and record["revision"] > previous["data"]["revision"], "same blueprint ID and increasing revision required")
            old = {x["id"]: x for x in previous["data"]["capabilities"]}
            changed = [ident for ident, value in old.items() if (value["priority"] == "must" or value["emphasis"]) and groups["capabilities"].get(ident) != value]
            if changed:
                need(args.change_authority, "user must/emphasis changed; exact amendment authority required")
                a = input_json(args.change_authority)
                authority(a)
                need(a.get("from_sha256") == previous["sha256"] and a.get("to_sha256") == hashed and set(a.get("changed_ids", [])) == set(changed), "amendment must pin old/new blueprint and exact changed must IDs")
                need(authority_current(root, a, digest({"from_sha256": previous["sha256"], "to_sha256": hashed, "changed_ids": sorted(changed)})), "canonical amendment source does not approve exact change")
                state["amendments"].append(a)
            state["blueprint_history"].append(previous)
        state["blueprint"] = {"data": record, "sha256": hashed, "registered_at": now()}
        state["design_revision"] += 1
        if state.get("approval"):
            state["approval"]["status"] = "stale"
        for item in state["executions"].values():
            item["status"] = "stale"
        for item in state["tasks"].values():
            item["status"] = "stale"
        return {"blueprint": blueprint_public(state), "ready_for_approval": not blockers, "blockers": blockers}
    if cmd in ("check", "build-gate"):
        if cmd == "check":
            _, _, blockers = active_blueprint(state, root)
            blockers += state["integrity_errors"]
            return {"valid": not blockers, "blockers": sorted(set(blockers)), "blueprint": blueprint_public(state), "semantic_quality_certified": False}
        blockers = approval_current(state, root)
        return {"ready": not blockers, "blockers": blockers, "blueprint": blueprint_public(state), "approval_ref": state.get("approval"), "executes": False}
    if cmd == "approve":
        bp, _, blockers = active_blueprint(state, root)
        need(not blockers and not state["integrity_errors"] and state["suite"] == suite() and not state["pause"]["active"], "cannot approve while source/question/suite/pause is blocked")
        authority(record)
        need(record.get("decision", "approve") == "approve" and ("revoked" not in record or record["revoked"] is False) and ("status" not in record or record["status"] in {"confirmed", "approved", "current"}), "approve rejects explicit negative, pending or revoked authority")
        preserve_authority_binding(state.get("approval"), record)
        need(args.sha256 == bp["sha256"] and args.revision == bp["data"]["revision"] and args.scope == bp["data"]["scope"] == record["scope"], "approval must match exact current hash/revision/scope")
        need(authority_current(root, record, bp["sha256"]), "canonical source does not approve exact blueprint")
        state["approval"] = dict(record, decision="approve", blueprint_sha256=args.sha256, blueprint_revision=args.revision, design_revision=state["design_revision"], status="confirmed", recorded_at=now())
        return {"approval_ref": state["approval"], "external_effects_authorized": False}
    if cmd == "context":
        result = {"project_id": state["project_id"], "purpose": state["purpose"], "blueprint": blueprint_public(state), "approval": state.get("approval"), "pause": state["pause"], "blockers": approval_current(state, root), "pending_tasks": [x["id"] for x in state["tasks"].values() if x["status"] != "completed"], "unknown_effects": [x["id"] for x in state["actions"].values() if x["status"] in ("pending", "unknown")], "next": "Inspect current sources and scope; use build-gate before target construction or readiness before a task. No action is executed by this command."}
        query = (args.query or "").casefold()
        result["records"] = {g: [r for r in state[g].values() if not query or query in canonical(r).casefold()] for g in GROUPS}
        if state.get("blueprint"):
            bp = state["blueprint"]["data"]
            result["always_review"] = {"must_or_emphasized": [r for r in bp["capabilities"] if r["applicability"] == "applicable" and (r["priority"] == "must" or r["emphasis"])], "continuity": bp["continuity"], "unresolved_questions": [r for r in bp["questions"] if r["status"] not in ("resolved", "not_applicable")], "current_project_must": [r for r in state["requirements"].values() if r["priority"] == "must" or r.get("emphasis")]}
        # Follow typed references instead of relying on query ranking for dependencies.
        links = {"depends_on": "tasks", "requirement_ids": "requirements", "fulfills_requirements": "requirements", "artifact_ids": "artifacts", "evidence_ids": "evidence", "execution_id": "executions", "grant_id": "grants", "capability_id": "capabilities"}
        selected = {g: {r["id"]: r for r in values} for g, values in result["records"].items()}
        changed = True
        while changed:
            changed = False
            for values in list(selected.values()):
                for row in list(values.values()):
                    for key, group in links.items():
                        ids = row.get(key, [])
                        for ident in ([ids] if isinstance(ids, str) else ids):
                            if ident in state[group] and ident not in selected[group]:
                                selected[group][ident] = state[group][ident]
                                changed = True
        result["records"] = {g: list(values.values()) for g, values in selected.items()}
        return result
    if cmd == "lesson":
        source(record)
        fields(record, "id", "text", "scope", "confidence", "impact_reason")
        need(type(record.get("material")) is bool, "explicit material impact flag required")
        bp, groups, _ = active_blueprint(state, root)
        ids = set(strings(record.get("impact_ids", []), "impact_ids"))
        phases = set(strings(record.get("phase_ids", []), "phase_ids"))
        known = {k for group in groups.values() for k in group} | set(state["requirements"]) | set(state["tasks"]) | set(state["artifacts"])
        need((ids or phases) and ids <= known and phases <= set(groups["phases"]), "lesson must name existing impact IDs/phases")
        result = put(state, "lessons", record)
        mark_impact(state, ids, phases)
        if record["material"]:
            state["design_revision"] += 1
            if state.get("approval"):
                state["approval"]["status"] = "stale"
        return result
    if cmd == "artifact":
        fields(record, "id", "path", "phase_id", "kind", "author_ids", "capability_ids")
        _, groups, _ = active_blueprint(state, root)
        need(record["phase_id"] in groups["phases"] and set(strings(record["capability_ids"], "capability_ids")) <= set(groups["capabilities"]), "unknown artifact phase/capabilities")
        strings(record["author_ids"], "author_ids")
        path = safe(root, record["path"], public=True)
        hashed = sha(path)
        definition = groups["artifacts"].get(record["id"])
        if state["purpose"] == "factory":
            need(definition is not None and record.get("bundle_path") == definition["path"], "factory artifact needs exact approved bundle path")
            need(record["phase_id"] == definition["phase_id"] and record["kind"] == definition["kind"] and set(record["capability_ids"]) == set(definition["capability_ids"]), "artifact definition differs from approved passport")
            if definition.get("immutable"):
                need(record.get("immutable") is True, "approved immutable artifact cannot be downgraded")
        old = state["artifacts"].get(record["id"])
        if old and old.get("immutable"):
            need(old["path"] == record["path"] and old["sha256"] == hashed, "immutable original cannot be replaced; use derivative ID")
        row = put(state, "artifacts", dict(record, sha256=hashed, status="current", definition_sha256=digest(definition)))
        return row
    if cmd == "test":
        fields(record, "id", "phase_id", "scope", "capability_ids", "artifact_ids", "method", "negative_case")
        source(record)
        _, groups, _ = active_blueprint(state, root)
        need(record["id"] not in {r["id"] for r in state["blueprint"]["data"]["tests"]}, "cannot override approved blueprint test")
        need(record["phase_id"] in groups["phases"] and type(record.get("independent")) is bool, "test phase/independence required")
        strings(record["artifact_ids"], "artifact_ids")
        return put(state, "project_tests", record)
    if cmd == "evidence":
        fields(record, "id", "test_id", "artifact_ids", "proof_path", "observer", "status", "environment", "method", "observed_at")
        source(record)
        tests = test_defs(state)
        need(record["test_id"] in tests, "unknown exact test ID")
        test = tests[record["test_id"]]
        ids = strings(record["artifact_ids"], "artifact_ids")
        need(set(test["artifact_ids"]) <= set(ids), "evidence must cover all test artifacts")
        need(all(state["artifacts"].get(x, {}).get("status") == "current" for x in ids), "evidence needs current registered artifacts")
        need(record["status"] in ("pass", "fail", "observed"), "unknown evidence result")
        if test["independent"]:
            need(record["status"] != "observed" and all(record["observer"] not in state["artifacts"][x]["author_ids"] for x in ids), "independent test cannot use author/self-observation")
        proof = safe(root, record["proof_path"], public=True)
        return put(state, "evidence", dict(record, proof_sha256=sha(proof), artifact_hashes={x: state["artifacts"][x]["sha256"] for x in ids}, test_sha256=digest(test)))
    if cmd == "execution":
        authority(record)
        preserve_authority_binding(state["executions"].get(record.get("id")), record)
        fields(record, "id", "blueprint_sha256", "phase_ids")
        _, groups, _ = active_blueprint(state, root)
        need(not approval_current(state, root), "approved current blueprint required before execution scope")
        need(record["blueprint_sha256"] == state["blueprint"]["sha256"] and set(strings(record["phase_ids"], "phase_ids")) <= set(groups["phases"]), "execution must pin exact blueprint and phases")
        subject = digest({k: record[k] for k in ("scope", "blueprint_sha256", "phase_ids")})
        need(authority_current(root, record, subject), "canonical source does not approve exact execution")
        prerequisites = record.get("prerequisite_evidence", {})
        need(isinstance(prerequisites, dict) and set(prerequisites) <= set(groups["phases"]), "unknown prerequisite phase")
        ids = [x for values in prerequisites.values() for x in strings(values, "prerequisite_evidence")]
        need(all(state["evidence"].get(x, {}).get("status") in ("pass", "observed") for x in ids), "current prior evidence required")
        return put(state, "executions", dict(record, status="current", prerequisite_hashes={x: digest(state["evidence"][x]) for x in ids}))
    if cmd == "requirement":
        record = dict(record)
        record.setdefault("emphasis", False)
        source(record)
        fields(record, "id", "intent", "scope", "phase_id", "owner", "priority", "acceptance", "status", "capability_ids")
        _, groups, _ = active_blueprint(state, root)
        need(record["phase_id"] in groups["phases"] and record["priority"] in ("must", "should", "explore") and record["status"] in ("pending", "met", "not_applicable"), "invalid requirement phase/priority/status")
        need(type(record["emphasis"]) is bool and set(strings(record["capability_ids"], "capability_ids")) <= set(groups["capabilities"]), "requirement emphasis/capability mapping required")
        old = state["requirements"].get(record["id"])
        if old and (old["priority"] == "must" or old.get("emphasis")) and requirement_hash(old) != requirement_hash(record):
            amendment = record.get("amendment")
            need(amendment, "must definition change requires actual amendment authority")
            authority(amendment)
            need(amendment.get("from_sha256") == requirement_hash(old) and amendment.get("to_sha256") == requirement_hash(record) and amendment["scope"] == "requirement:" + record["id"], "amendment must pin exact old/new requirement and scope")
            need(authority_current(root, amendment, digest({"from_sha256": requirement_hash(old), "to_sha256": requirement_hash(record)})), "canonical amendment source does not approve exact requirement change")
        if old and requirement_hash(old) != requirement_hash(record):
            state["requirement_history"].append(old)
        artifact_ids = strings(record.get("artifact_ids", []), "artifact_ids")
        evidence_ids = strings(record.get("evidence_ids", []), "evidence_ids")
        if record["status"] == "not_applicable":
            need(record["priority"] != "must" and not record["emphasis"] and record.get("rationale"), "must/emphasis cannot silently become N/A")
        row = dict(record)
        if record["status"] == "met":
            need(artifact_ids and evidence_ids and all(x in state["artifacts"] for x in artifact_ids) and all(x in state["evidence"] for x in evidence_ids), "closure artifacts/evidence required")
            row["closure"] = {"artifact_hashes": {x: state["artifacts"][x]["sha256"] for x in artifact_ids}, "evidence_hashes": {x: digest(state["evidence"][x]) for x in evidence_ids}}
            need(closure(state, row), "requirement closure must cover current actual artifacts with current evidence")
        return put(state, "requirements", row)
    if cmd == "decision":
        source(record)
        fields(record, "id", "question", "options", "scope", "phase_ids", "status")
        _, groups, _ = active_blueprint(state, root)
        row = dict(record, task_ids=strings(record.get("task_ids", []), "task_ids"))
        need(type(row.get("material")) is bool and row["status"] in ("pending", "confirmed", "revoked"), "decision material/status required")
        need(set(strings(row["phase_ids"], "phase_ids")) <= set(groups["phases"]), "unknown decision phase")
        strings(row["options"], "options")
        need(len(row["options"]) >= 2, "at least two concrete decision options required")
        question = next((q for q in state["blueprint"]["data"]["questions"] if q["id"] == row["id"]), None)
        if question:
            need(row["question"] == question["question"] and (not question.get("options") or row["options"] == question["options"]) and question.get("due_phase") in row["phase_ids"], "future decision must match approved question and due phase")
        hashed = digest(decision_definition(row))
        old = state["decisions"].get(row["id"])
        if old and old["material"] and digest(decision_definition(old)) != hashed:
            amendment = row.get("amendment")
            need(amendment, "material decision definition cannot be downgraded or redirected without exact amendment authority")
            authority(amendment)
            old_hash = digest(decision_definition(old))
            need(amendment.get("from_sha256") == old_hash and amendment.get("to_sha256") == hashed and amendment["scope"] == "decision:" + row["id"], "decision amendment must pin exact old/new definitions")
            need(authority_current(root, amendment, digest({"from_sha256": old_hash, "to_sha256": hashed})), "canonical decision amendment does not approve exact change")
            state["decision_history"].append(old)
        if old and old.get("authority", {}).get("canonical_authority") and row["status"] != "confirmed":
            row["authority"] = old["authority"]
        if row["status"] == "confirmed":
            fields(row, "authority", "answer", "confirms_sha256")
            authority(row["authority"])
            preserve_authority_binding((old or {}).get("authority"), row["authority"])
            need(row["answer"] in row["options"] and row["authority"].get("choice") == row["answer"] and row["authority"]["scope"] == row["scope"] and row["confirms_sha256"] == hashed, "decision must pin exact options/scope/answer")
            need(authority_current(root, row["authority"], digest({"definition_sha256": hashed, "answer": row["answer"]})), "canonical decision authority denied/revoked/changed")
        row["definition_sha256"] = hashed
        return put(state, "decisions", row)
    if cmd == "task":
        fields(record, "id", "phase_id", "scope", "goal", "owner", "execution_id")
        source(record)
        _, groups, _ = active_blueprint(state, root)
        need(record["phase_id"] in groups["phases"] and type(record.get("independent_review_required")) is bool, "task phase/independence required")
        row = dict(record)
        for key in ("depends_on", "requirement_ids", "fulfills_requirements", "artifact_ids", "test_ids"):
            row[key] = strings(record.get(key, []), key)
        need(row["artifact_ids"] and row["test_ids"], "task output and test coverage required")
        need(set(row["test_ids"]) <= set(test_defs(state)), "unknown task tests")
        need(set(row["requirement_ids"]) | set(row["fulfills_requirements"]) <= set(state["requirements"]), "unknown task requirement")
        need(set(row["depends_on"]) <= set(state["tasks"]) and row["id"] not in row["depends_on"], "unknown/self task dependency")
        graph = {k: v["depends_on"] for k, v in state["tasks"].items()}
        graph[row["id"]] = row["depends_on"]
        dag(graph, "task graph")
        return put(state, "tasks", dict(row, status="pending"))
    if cmd in ("readiness", "start", "complete"):
        need(args.id in state["tasks"], "unknown task")
        row = state["tasks"][args.id]
        blockers = readiness(state, root, row)
        if cmd == "readiness":
            return {"ready": not blockers, "blockers": blockers, "task": row}
        need(not blockers, "task blocked: " + "; ".join(blockers))
        if cmd == "start":
            need(row["status"] == "pending", "task already started")
            row["status"] = "running"
            row["started_at"] = now()
            return row
        need(row["status"] == "running", "task must be started")
        evidence_ids = args.evidence or []
        evidence = [state["evidence"].get(x, {}) for x in evidence_ids]
        need(evidence and all(x.get("status") in ("pass", "observed") for x in evidence), "current completion evidence required")
        need(set(row["test_ids"]) <= {x.get("test_id") for x in evidence}, "completion must cover every task test")
        need(set(row["artifact_ids"]) <= {a for e in evidence for a in e.get("artifact_ids", [])}, "completion must cover every output")
        need(all(state["artifacts"].get(a, {}).get("status") == "current" for a in row["artifact_ids"]), "current output required")
        if row["independent_review_required"]:
            need(all(e["status"] == "pass" and all(e["observer"] not in state["artifacts"][a]["author_ids"] for a in e["artifact_ids"]) for e in evidence), "independent pass required")
        requirements = set(row["requirement_ids"]) | set(row["fulfills_requirements"])
        need(all(closure(state, state["requirements"][x]) for x in requirements), "all declared requirements must close before completion")
        row["completion"] = {"artifacts": {a: state["artifacts"][a]["sha256"] for a in row["artifact_ids"]}, "evidence": {e: digest(state["evidence"][e]) for e in evidence_ids}, "tasks": {d: state["tasks"][d]["revision"] for d in row["depends_on"]}, "requirements": {x: requirement_hash(state["requirements"][x]) for x in requirements}}
        row["status"] = "completed"
        row["completed_at"] = now()
        return row
    if cmd == "phase-check":
        blockers = phase_readiness(state, root, args.id, args.scope, args.execution_id)
        return {"valid": not blockers, "blockers": blockers, "phase_id": args.id, "scope": args.scope, "semantic_quality_certified": False}
    if cmd == "bundle-check":
        blockers = approval_current(state, root)
        bp, groups, _ = active_blueprint(state, root)
        directory = Path(args.directory).absolute()
        for parent in (directory, *directory.parents):
            need(not parent.is_symlink(), "bundle path cannot contain symlinks")
        need(directory.is_dir(), "bundle directory required")
        found = []
        skills = directory / "skills"
        if skills.is_dir():
            for folder in skills.iterdir():
                need(folder.is_dir() and not folder.is_symlink(), "unexpected non-directory/link in skills")
                path = safe(directory, "skills/" + folder.name + "/SKILL.md")
                content = read_bytes(path).decode()
                match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.+)", content, re.S)
                need(match, "usable skill frontmatter/body required")
                name = re.search(r"^name:\s*['\"]?([a-z0-9-]+)['\"]?\s*$", match.group(1), re.M)
                need(name and name.group(1) == folder.name, "skill folder/name mismatch")
                need(re.search(r"^description:\s*\S", match.group(1), re.M), "skill description required")
                found.append(folder.name)
        if set(found) != set(x["name"] for x in bp["data"]["skills"]):
            blockers.append("bundle skill set differs from approved exact set")
        for ident, definition in groups["artifacts"].items():
            row = state["artifacts"].get(ident, {})
            path = safe(directory, definition["path"])
            if row.get("status") != "current" or not path.is_file() or sha(path) != row.get("sha256"):
                blockers.append("bundle artifact/current registry mismatch: " + ident)
        for ident, test in groups["tests"].items():
            evidence = [e for e in state["evidence"].values() if e["test_id"] == ident and e["status"] == "pass" and e.get("test_sha256") == digest(test)]
            if not evidence:
                blockers.append("missing current pass for blueprint test: " + ident)
        return {"valid": not blockers, "blockers": sorted(set(blockers)), "blueprint": blueprint_public(state), "semantic_quality_certified": False, "installed": False}
    if cmd == "intake":
        return intake(state, root, args.source, record)
    if cmd == "pause":
        source(record)
        fields(record, "reason", "boundary")
        need(record["boundary"] in ("now", "after_task", "after_artifact", "after_phase"), "explicit supported pause boundary required")
        need(record["boundary"] == "now" or not state["pause"]["active"], "active pause must be explicitly resumed before rearming")
        if record["boundary"] == "after_task":
            need(record.get("task_id") in state["tasks"] and state["tasks"][record["task_id"]]["status"] != "completed", "future exact task required")
        if record["boundary"] == "after_artifact":
            need(record.get("artifact_id") and record["artifact_id"] not in state["artifacts"], "future exact artifact required")
        if record["boundary"] == "after_phase":
            _, groups, _ = active_blueprint(state, root)
            need(record.get("phase_id") in groups["phases"] and record.get("scope") and record.get("execution_id") in state["executions"], "exact phase/scope/execution required")
        state["pause"] = dict(record, active=record["boundary"] == "now")
        return state["pause"]
    if cmd == "resume":
        need(not state["integrity_errors"] and state["suite"] == suite(), "reconcile inputs/suite before resume")
        need(not any(r["status"] in ("pending", "unknown") for r in state["actions"].values()), "reconcile unknown external outcomes before resume")
        state["pause"] = {"active": False, "boundary": None, "reason": "explicit resume"}
        return {"ready": True, "replayed_actions": []}
    if cmd == "capability":
        source(record)
        fields(record, "id", "environment", "scope", "verified_at")
        need(type(record.get("available")) is bool, "explicit observed availability required")
        types = strings(record.get("effect_types", []), "effect_types")
        need(not record["available"] or types, "available capability needs actually supported effect types")
        return put(state, "capabilities", record)
    if cmd == "grant":
        authority(record)
        preserve_authority_binding(state["grants"].get(record.get("id")), record)
        fields(record, "id", "type", "capability_id", "artifact_ids", "parameters", "decision", "action_id", "idempotency_key")
        need(record["decision"] in ("approve", "decline"), "explicit effect approval/decline required")
        need(isinstance(record["parameters"], dict), "exact effect parameters object required")
        need(record["capability_id"] in state["capabilities"], "unknown capability")
        ids = strings(record["artifact_ids"], "artifact_ids")
        need(ids and all(state["artifacts"].get(x, {}).get("status") == "current" for x in ids), "prepared current effect artifacts required")
        value = dict(record, blueprint_sha256=state["blueprint"]["sha256"], capability_hash=digest(state["capabilities"][record["capability_id"]]), artifact_hashes={x: state["artifacts"][x]["sha256"] for x in ids})
        value["subject_sha256"] = digest({k: value[k] for k in ("action_id", "idempotency_key", "type", "scope", "capability_id", "artifact_hashes", "parameters")})
        # Recording a denial is allowed; it cannot authorize dispatch. Only an
        # affirmative grant needs current exact approval, checked again there.
        if record["decision"] == "approve":
            need(authority_current(root, record, value["subject_sha256"]), "canonical source does not approve exact effect")
        return put(state, "grants", value)
    if cmd == "action":
        source(record)
        fields(record, "id", "grant_id", "idempotency_key", "task_id", "type", "scope", "capability_id", "artifact_ids", "parameters")
        need(record["grant_id"] in state["grants"] and record["task_id"] in state["tasks"], "action requires known grant/task")
        grant = state["grants"][record["grant_id"]]
        need(record["id"] == grant["action_id"] and record["idempotency_key"] == grant["idempotency_key"], "grant is single-action authority")
        for key in ("type", "scope", "capability_id", "artifact_ids", "parameters"):
            need(record[key] == grant[key], "action differs from approved exact " + key)
        need(record["scope"] == state["tasks"][record["task_id"]]["scope"], "task/action scope mismatch")
        fingerprint = digest({k: record[k] for k in ("type", "scope", "capability_id", "artifact_ids", "parameters", "task_id")})
        existing = state["actions"].get(record["id"])
        if existing:
            need(existing["fingerprint"] == fingerprint and existing["idempotency_key"] == record["idempotency_key"], "action identity cannot be repurposed")
            return existing
        need(not any(x["idempotency_key"] == record["idempotency_key"] for x in state["actions"].values()), "idempotency key already registered")
        return put(state, "actions", dict(record, fingerprint=fingerprint, grant_hash=digest(grant), status="prepared"))
    if cmd == "dispatch":
        need(args.revision == state["revision"], "stale project revision")
        row = state["actions"].get(args.id)
        need(row and row["status"] == "prepared", "action already dispatched; reconcile actual outcome, never blindly repeat")
        grant = state["grants"][row["grant_id"]]
        need(digest(grant) == row["grant_hash"], "effect grant changed")
        need(not effect_current(state, root, grant), "effect authority/capability/artifacts are blocked")
        task = state["tasks"][row["task_id"]]
        need(task["status"] == "running" and not readiness(state, root, task), "running current authorized task required")
        need(not any(r["status"] in ("pending", "unknown") for r in state["actions"].values()), "reconcile unresolved external effects before another dispatch")
        row["status"] = "pending"
        row["dispatched_at"] = now()
        return {"action": row, "host_tool_may_execute_once": True, "executed": False}
    if cmd == "receipt":
        row = state["actions"].get(args.id)
        need(row, "unknown action")
        source(record)
        fields(record, "provider_ref", "proof_path")
        value = dict(record, outcome=args.outcome, proof_sha256=sha(safe(root, record["proof_path"], public=True)))
        if row.get("receipt") == value:
            return {"replayed": True, "action": row}
        need(row["status"] in ("pending", "unknown"), "receipt conflicts with terminal/prepared action")
        need(row["status"] != "unknown" or record.get("reconciled") is True and args.outcome != "unknown", "unknown outcome requires actual read-only reconciliation proof")
        row.setdefault("receipt_history", []).append(value)
        row["receipt"] = value
        row["status"] = args.outcome
        return row
    if cmd == "refresh":
        if args.accept_suite_update:
            source(record)
            fields(record, "review")
            strings(record.get("impact_ids"), "impact_ids")
            need(type(record.get("material")) is bool, "explicit suite material-impact verdict required")
            state["suite"] = suite()
            state["suite_reviews"].append(record)
            mark_impact(state, set(record["impact_ids"]), set())
            if record["material"] and state.get("approval"):
                state["approval"]["status"] = "stale"
        refresh(state, root)
        return {"ready": not state["integrity_errors"], "integrity_errors": state["integrity_errors"], "approval": state.get("approval")}
    raise ValueError("unsupported command")


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    commands = p.add_subparsers(dest="command", required=True)
    names = ("init", "blueprint", "check", "approve", "build-gate", "context", "lesson", "artifact", "test", "evidence", "execution", "requirement", "decision", "task", "readiness", "start", "complete", "phase-check", "bundle-check", "intake", "pause", "resume", "capability", "grant", "action", "dispatch", "receipt", "refresh")
    records = {"blueprint", "approve", "lesson", "artifact", "test", "evidence", "execution", "requirement", "decision", "task", "intake", "pause", "capability", "grant", "action", "receipt"}
    for name in names:
        q = commands.add_parser(name)
        q.add_argument("session", type=Path)
        if name in records:
            q.add_argument("--record", required=True)
        if name == "init":
            q.add_argument("--project-id", required=True)
            q.add_argument("--purpose", choices=("factory", "project"), default="factory")
        if name == "blueprint":
            q.add_argument("--change-authority")
        if name == "approve":
            q.add_argument("--sha256", required=True)
            q.add_argument("--revision", type=int, required=True)
            q.add_argument("--scope", required=True)
        if name == "context":
            q.add_argument("--query")
        if name in ("readiness", "start", "complete", "phase-check", "dispatch", "receipt"):
            q.add_argument("--id", required=True)
        if name == "phase-check":
            q.add_argument("--scope", required=True)
            q.add_argument("--execution-id", required=True)
        if name == "complete":
            q.add_argument("--evidence", action="append")
        if name == "dispatch":
            q.add_argument("--revision", required=True, type=int)
        if name == "receipt":
            q.add_argument("--outcome", required=True, choices=("succeeded", "failed", "unknown"))
        if name == "bundle-check":
            q.add_argument("--directory", required=True)
        if name == "intake":
            q.add_argument("--source", required=True)
        if name == "refresh":
            q.add_argument("--accept-suite-update", action="store_true")
            q.add_argument("--record")
    return p


def main():
    args = parser().parse_args()
    root = args.session.absolute()
    try:
        record = input_json(args.record) if getattr(args, "record", None) else None
        with lock(root, args.command == "init") as home:
            if args.command == "init":
                need(SLUG.fullmatch(args.project_id), "portable project ID required")
                need(not (home / "state.json").exists(), "existing session never overwritten")
                need(all(suite().values()), "complete runtime dependencies required before initialization")
                state = {"schema_version": VERSION, "project_id": args.project_id, "purpose": args.purpose, "revision": 0, "design_revision": 0, "suite": suite(), "blueprint": None, "blueprint_history": [], "requirement_history": [], "decision_history": [], "record_history": [], "amendments": [], "approval": None, "intakes": [], "suite_reviews": [], "integrity_errors": [], "pause": {"active": False, "boundary": None, "reason": "new session"}, "journal": [], **{g: {} for g in GROUPS}}
                save(home, state, "init")
                result = {"project_id": args.project_id, "purpose": args.purpose, "initialized": True, "project_revision": state["revision"]}
            else:
                state = read_state(home)
                before = copy.deepcopy(state)
                refresh(state, root)
                refreshed = copy.deepcopy(state)
                try:
                    result = dispatch(state, root, args, record)
                except Exception:
                    if refreshed != before:
                        save(home, refreshed, "refresh-before-rejected-" + args.command)
                    raise
                if args.command == "complete" and state["pause"].get("boundary") == "after_task" and state["pause"].get("task_id") == args.id:
                    state["pause"]["active"] = True
                    state["pause"]["reason"] = "requested task boundary reached"
                if args.command == "artifact" and state["pause"].get("boundary") == "after_artifact" and state["pause"].get("artifact_id") == record["id"]:
                    state["pause"]["active"] = True
                    state["pause"]["reason"] = "requested artifact boundary reached"
                if args.command == "phase-check" and result.get("valid") and state["pause"].get("boundary") == "after_phase" and state["pause"].get("phase_id") == args.id and state["pause"].get("scope") == args.scope and state["pause"].get("execution_id") == args.execution_id:
                    state["pause"]["active"] = True
                    state["pause"]["reason"] = "requested phase boundary reached"
                if state != before:
                    save(home, state, args.command)
                if isinstance(result, dict):
                    result = copy.deepcopy(result)
                    result["project_revision"] = state["revision"]
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if isinstance(result, dict) and (result.get("ready") is False or result.get("valid") is False) else 0
    except (ValueError, KeyError, TypeError, OSError, json.JSONDecodeError, zipfile.BadZipFile, RuntimeError) as exc:
        print(json.dumps({"error": str(exc), "executed": False}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
