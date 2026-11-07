#!/usr/bin/env python3
"""Bind a briefing/1 execution specification, human script and actual user decision.

This stdlib controller validates records and file bindings. It does not interview,
interpret consent, authenticate a message, run a job/tool, resume a pause, or certify
quality. The agent must verify the actual user message before recording a decision.
Only explicitly listed immutable input files are checked for drift. Keep mutable
outputs and their final hashes in closeout, not in baseline.inputs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any

SCHEMA = "briefing/1"
SCOPE_KEYS = ("schema_version", "mode", "family", "stage", "goal", "authority_refs", "baseline", "topics", "execution_spec")
BASELINE_KEYS = ("source", "accepted_intent", "evidence", "runtime", "continuation")
TOPIC_STATUSES = {"confirmed", "delegated", "deferred", "not_applicable", "pending"}
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
PLACEHOLDERS = re.compile(r"(?:^|\b)(?:example|placeholder|todo|unavailable|self.generated|template)(?:\b|$)", re.I)


class BriefingError(Exception):
    pass


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def scope_hash(record: dict[str, Any]) -> str:
    return digest_bytes(canonical({key: record.get(key) for key in SCOPE_KEYS}))


def load_json(path: Path) -> dict[str, Any]:
    try:
        def reject_duplicates(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise BriefingError(f"Duplicate JSON key: {key}")
                result[key] = value
            return result
        value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicates,
                           parse_constant=lambda value: (_ for _ in ()).throw(BriefingError(f"Invalid JSON number: {value}")))
    except (OSError, ValueError) as exc:
        raise BriefingError(f"Cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise BriefingError(f"Expected JSON object: {path}")
    return value


def atomic_write(path: Path, data: bytes, *, exclusive: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if exclusive:
        try:
            with path.open("xb") as stream:
                stream.write(data)
        except FileExistsError as exc:
            raise BriefingError(f"Refusing to overwrite existing file: {path}") from exc
        return
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_json(path: Path, record: dict[str, Any], *, exclusive: bool = False) -> None:
    atomic_write(path, (json.dumps(record, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8"), exclusive=exclusive)


def contained_path(root: Path, value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise BriefingError(f"{label}: nonempty file path required")
    candidate = Path(value)
    candidate = (candidate if candidate.is_absolute() else root / candidate).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise BriefingError(f"{label}: path escapes --root: {value}") from exc
    return candidate


def file_binding(root: Path, item: Any, label: str) -> list[str]:
    if not isinstance(item, dict):
        return [f"{label}: file binding must be an object"]
    if not isinstance(item.get("sha256"), str) or not SHA_RE.fullmatch(item["sha256"]):
        return [f"{label}: lowercase SHA256 required"]
    try:
        path = contained_path(root, item.get("path"), label)
        if not path.is_file():
            return [f"{label}: file is unavailable: {item.get('path')}"]
        if digest_bytes(path.read_bytes()) != item["sha256"]:
            return [f"{label}: immutable input or artifact SHA256 drift: {item.get('path')}"]
    except (BriefingError, OSError) as exc:
        return [str(exc)]
    return []


def text_present(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def content_present(value: Any) -> bool:
    if isinstance(value, bool) or value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return value != [] and value != {}


def id_list(value: Any, label: str, known: set[str], errors: list[str]) -> list[str]:
    if not isinstance(value, list) or any(not text_present(item) for item in value):
        errors.append(f"{label}: list of step IDs required")
        return []
    if len(value) != len(set(value)):
        errors.append(f"{label}: duplicate step IDs")
    unknown = set(value) - known
    if unknown:
        errors.append(f"{label}: unknown step IDs: {', '.join(sorted(unknown))}")
    return value


def immutable_inputs(record: dict[str, Any]):
    for index, item in enumerate(record.get("authority_refs", [])):
        if isinstance(item, dict) and ("path" in item or "sha256" in item):
            yield item, f"authority_refs[{index}]"
    baseline = record.get("baseline", {})
    if isinstance(baseline, dict):
        for section in BASELINE_KEYS:
            part = baseline.get(section, {})
            if isinstance(part, dict) and isinstance(part.get("inputs"), list):
                for index, item in enumerate(part["inputs"]):
                    yield item, f"baseline.{section}.inputs[{index}]"


def validate_structure(record: dict[str, Any], root: Path) -> list[str]:
    errors: list[str] = []
    if record.get("schema_version") != SCHEMA:
        errors.append(f"schema_version must be {SCHEMA}")
    if record.get("mode") not in ("brief", "resume"):
        errors.append("mode must be brief or resume")
    for field in ("family", "stage", "goal"):
        if not text_present(record.get(field)):
            errors.append(f"{field}: nonempty text required")
    refs = record.get("authority_refs")
    if not isinstance(refs, list):
        errors.append("authority_refs: list required")
    else:
        for index, ref in enumerate(refs):
            if not isinstance(ref, dict) or ref.get("source_role") not in ("user", "policy") or not text_present(ref.get("source_ref")):
                errors.append(f"authority_refs[{index}]: user/policy source_role and source_ref required")
    spec = record.get("execution_spec")
    steps: list[Any] = []
    if not isinstance(spec, dict):
        errors.append("execution_spec: object required")
        spec = {}
    if not text_present(spec.get("revision")):
        errors.append("execution_spec.revision: nonempty text required")
    for field in ("outcomes", "steps", "resources", "limits", "milestones", "stop", "delegation", "next_route"):
        if field not in spec:
            errors.append(f"execution_spec.{field}: required")
    for field in ("outcomes", "steps", "resources", "milestones"):
        if field in spec and not isinstance(spec[field], list):
            errors.append(f"execution_spec.{field}: list required")
    if not isinstance(spec.get("steps"), list) or not spec.get("steps"):
        errors.append("execution_spec.steps: nonempty list required")
    else:
        steps = spec["steps"]
    if not content_present(spec.get("outcomes")):
        errors.append("execution_spec.outcomes: at least one outcome required")
    for field in ("limits", "stop", "delegation", "next_route"):
        if field in spec and not content_present(spec[field]):
            errors.append(f"execution_spec.{field}: explicit content required")
    step_ids = [step.get("id") for step in steps if isinstance(step, dict) and text_present(step.get("id"))]
    known = set(step_ids)
    if len(step_ids) != len(steps):
        errors.append("Every execution step needs a nonempty ID")
    if len(step_ids) != len(known):
        errors.append("Duplicate execution step IDs")
    graph: dict[str, list[str]] = {}
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            errors.append(f"execution_spec.steps[{index}]: object required")
            continue
        label = f"step {step.get('id', index)}"
        deps = id_list(step.get("depends_on"), f"{label}.depends_on", known, errors)
        if step.get("id") in deps:
            errors.append(f"{label}: self dependency")
        if text_present(step.get("id")):
            graph[step["id"]] = deps
        for field in ("outputs", "acceptance"):
            if not isinstance(step.get(field), list) or not step[field]:
                errors.append(f"{label}.{field}: nonempty list required")
    visiting: set[str] = set()
    visited: set[str] = set()
    def visit(step_id: str) -> None:
        if step_id in visiting:
            errors.append(f"Dependency cycle involving step {step_id}")
            return
        if step_id in visited:
            return
        visiting.add(step_id)
        for dep in graph.get(step_id, []):
            visit(dep)
        visiting.remove(step_id)
        visited.add(step_id)
    for step_id in graph:
        visit(step_id)
    topics = record.get("topics")
    if not isinstance(topics, list):
        errors.append("topics: list required")
    else:
        seen: set[str] = set()
        for index, topic in enumerate(topics):
            if not isinstance(topic, dict):
                errors.append(f"topics[{index}]: object required")
                continue
            label = f"topic {topic.get('id', index)}"
            if not text_present(topic.get("id")) or topic.get("id") in seen:
                errors.append(f"{label}: missing or duplicate ID")
            if text_present(topic.get("id")):
                seen.add(topic["id"])
            status = topic.get("status")
            if not isinstance(status, str) or status not in TOPIC_STATUSES:
                errors.append(f"{label}: unsupported status")
            if topic.get("criticality") not in ("material", "technical", "future"):
                errors.append(f"{label}: criticality must be material, technical or future")
            deps = id_list(topic.get("dependent_steps"), f"{label}.dependent_steps", known, errors)
            if status == "confirmed" and (not content_present(topic.get("answer")) or not text_present(topic.get("source_ref"))):
                errors.append(f"{label}: confirmed requires answer and source_ref")
            if status == "delegated":
                for field in ("owner", "bounds", "acceptance"):
                    if not content_present(topic.get(field)):
                        errors.append(f"{label}: delegated requires {field}")
                if topic.get("criticality") == "material":
                    source = topic.get("source_ref")
                    if (topic.get("source_role") != "user" or not text_present(source)
                            or PLACEHOLDERS.search(source)
                            or source.lower().startswith(("self:", "generated:", "template:"))
                            or topic.get("source_status", "available") != "available"):
                        errors.append(f"{label}: material delegation requires an actual available user source_role/source_ref within the recorded bounds")
            if status == "deferred":
                for field in ("owner", "due_gate", "rationale"):
                    if not content_present(topic.get(field)):
                        errors.append(f"{label}: deferred requires {field}")
            if status == "not_applicable" and not text_present(topic.get("rationale")):
                errors.append(f"{label}: not_applicable requires rationale")
            if status in ("pending", "deferred") and topic.get("criticality") == "material" and not deps:
                errors.append(f"{label}: unresolved material topic requires explicit dependent_steps")
    baseline = record.get("baseline")
    if not isinstance(baseline, dict):
        errors.append("baseline: object required")
    else:
        for section in BASELINE_KEYS:
            part = baseline.get(section)
            if not isinstance(part, dict):
                errors.append(f"baseline.{section}: object required")
                continue
            for field in ("facts", "unknowns", "inputs"):
                if not isinstance(part.get(field), list):
                    errors.append(f"baseline.{section}.{field}: list required")
            for index, fact in enumerate(part.get("facts", []) if isinstance(part.get("facts"), list) else []):
                if not isinstance(fact, dict) or not text_present(fact.get("text")) or not text_present(fact.get("source_ref")):
                    errors.append(f"baseline.{section}.facts[{index}]: text and source_ref required")
            for index, unknown in enumerate(part.get("unknowns", []) if isinstance(part.get("unknowns"), list) else []):
                if not isinstance(unknown, dict) or not text_present(unknown.get("text")):
                    errors.append(f"baseline.{section}.unknowns[{index}]: text required")
                elif "blocking_steps" not in unknown:
                    errors.append(f"baseline.{section}.unknowns[{index}]: explicit blocking_steps required (may be empty)")
                else:
                    id_list(unknown["blocking_steps"], f"baseline.{section}.unknowns[{index}].blocking_steps", known, errors)
            if record.get("mode") == "resume" and not part.get("facts") and not part.get("unknowns"):
                errors.append(f"baseline.{section}: resume must record facts or explicit unknowns")
    pause = record.get("pause")
    if not isinstance(pause, dict) or not isinstance(pause.get("active"), bool):
        errors.append("pause.active: boolean state required; this controller never clears it")
    for item, label in immutable_inputs(record):
        errors.extend(file_binding(root, item, label))
    return errors


def render_script(record: dict[str, Any]) -> bytes:
    """A deterministic, complete human view of the immutable scope fields."""
    labels = {
        "source_role": "Автор джерела", "source_ref": "Джерело", "source_status": "Доступність джерела",
        "facts": "Підтверджені відомості", "unknowns": "Невідомості", "inputs": "Незмінні вхідні файли",
        "text": "Зміст", "blocking_steps": "Залежні заблоковані кроки", "path": "Файл", "sha256": "SHA256",
        "id": "ID", "question": "Питання", "status": "Статус", "criticality": "Значущість",
        "answer": "Відповідь", "bounds": "Дозволені межі", "acceptance": "Критерії приймання",
        "owner": "Власник", "due_gate": "Строк рішення", "dependent_steps": "Залежні кроки",
        "rationale": "Обґрунтування", "revision": "Редакція", "outcomes": "Потрібні результати",
        "steps": "Кроки виконання", "depends_on": "Передумови", "outputs": "Вихідні матеріали",
        "resources": "Ресурси", "limits": "Обмеження", "milestones": "Проміжні покази й контроль",
        "stop": "Межа зупинки", "delegation": "Делегування", "next_route": "Наступний маршрут",
        "stage": "Етап", "host": "Середовище", "selector": "Вхід", "goal": "Мета",
        "source": "Source — фактичні джерела", "accepted_intent": "Accepted intent — прийнятий задум",
        "evidence": "Evidence — перевірки", "runtime": "Runtime — фактичне виконання",
        "continuation": "Continuation — точка продовження",
    }
    values = {"confirmed": "підтверджено", "delegated": "делеговано", "deferred": "відкладено",
              "not_applicable": "не застосовується", "pending": "очікує рішення", "material": "матеріальне",
              "technical": "технічне", "future": "майбутнє", "user": "користувач", "policy": "чинне правило"}
    def literal(value: Any) -> str:
        # Literal user content must not become Markdown structure or a code fence.
        text = str(value).replace("\\", "\\\\")
        for character in "`*_{}[]<>#|":
            text = text.replace(character, "\\" + character)
        return text.replace("\r", "").replace("\n", "  \n")
    def human(value: Any, indent: int = 0) -> list[str]:
        prefix = "  " * indent
        if isinstance(value, dict):
            if not value:
                return [prefix + "- Не задано."]
            output = []
            for key in sorted(value):
                label = labels.get(key, key.replace("_", " "))
                item = value[key]
                if isinstance(item, (dict, list)):
                    output.append(prefix + f"- **{literal(label)}:**")
                    output.extend(human(item, indent + 1))
                else:
                    output.append(prefix + f"- **{literal(label)}:** {literal(values.get(item, item) if isinstance(item, str) else item)}")
            return output
        if isinstance(value, list):
            if not value:
                return [prefix + "- Немає записів."]
            output = []
            for index, item in enumerate(value, 1):
                if isinstance(item, dict):
                    output.append(prefix + f"- **{literal(item.get('id', str(index)))}**")
                    output.extend(human(item, indent + 1))
                elif isinstance(item, list):
                    output.append(prefix + f"- **{index}**")
                    output.extend(human(item, indent + 1))
                else:
                    output.append(prefix + "- " + literal(item))
            return output
        return [prefix + "- " + literal(value)]
    lines = ["# Сценарій виконання", "", f"Редакція: {literal(record['execution_spec']['revision'])}",
             f"Режим: {literal(record['mode'])}; сімейство: {literal(record['family'])}; етап: {literal(record['stage'])}",
             f"Scope SHA256: {scope_hash(record)}", "", "## Мета", "", literal(record["goal"]), ""]
    sections = [("Джерела повноважень", record["authority_refs"]),
                ("Фактична baseline та невідомості", record["baseline"]),
                ("Відповіді, делегування та відкладені рішення", record["topics"]),
                ("План, результати, перевірки, ресурси й межа зупинки", record["execution_spec"])]
    for title, value in sections:
        lines += [f"## {title}", ""] + human(value) + [""]
    lines += ["Сценарій потребує фактичного погодження користувачем у точному scope. "
              "Його наявність або SHA256 не створює згоди, не знімає паузу та не засвідчує якість.", ""]
    return "\n".join(lines).encode("utf-8")


def binding_errors(record: dict[str, Any], root: Path) -> list[str]:
    binding = record.get("script_binding")
    if not isinstance(binding, dict):
        return ["script_binding missing: run render-script and show the actual script to the user"]
    expected_scope = scope_hash(record)
    expected_script = digest_bytes(render_script(record))
    errors = []
    if binding.get("scope_hash") != expected_scope:
        errors.append("script_binding scope_hash is stale")
    if binding.get("script_sha256") != expected_script:
        errors.append("script_binding script_sha256 is stale")
    errors.extend(file_binding(root, {"path": binding.get("path"), "sha256": binding.get("script_sha256")}, "script_binding"))
    return errors


def approval_errors(record: dict[str, Any], approval: Any) -> list[str]:
    if not isinstance(approval, dict):
        return ["No actual user approval recorded"]
    errors = []
    if approval.get("source_role") != "user":
        errors.append("Approval must come from the actual user, not an agent or tool")
    source = approval.get("source_ref")
    if not text_present(source) or PLACEHOLDERS.search(source) or source.lower().startswith(("self:", "generated:", "template:")):
        errors.append("Approval source_ref is missing, unavailable, self-generated or a placeholder")
    if approval.get("source_status", "available") != "available":
        errors.append("Approval source is unavailable or unverified")
    quote = approval.get("quote")
    if not text_present(quote) or PLACEHOLDERS.search(quote):
        errors.append("Actual nonplaceholder user quote required")
    decision = approval.get("decision")
    if decision not in ("approved", "partial", "rejected", "revoked"):
        errors.append("Approval decision must be approved, partial, rejected or revoked")
    if approval.get("revision") != record["execution_spec"].get("revision"):
        errors.append("Approval revision is stale")
    if approval.get("scope_hash") != scope_hash(record):
        errors.append("Approval scope_hash is stale")
    if approval.get("script_sha256") != digest_bytes(render_script(record)):
        errors.append("Approval script_sha256 is stale")
    known = {step["id"] for step in record["execution_spec"]["steps"]}
    included = id_list(approval.get("approved_steps"), "approval.approved_steps", known, errors)
    excluded = id_list(approval.get("excluded_steps"), "approval.excluded_steps", known, errors)
    if set(included) & set(excluded):
        errors.append("Approval cannot both approve and exclude the same step")
    if decision == "approved" and (set(included) != known or excluded):
        errors.append("approved decision must cover exactly all steps with no exclusions")
    if decision == "partial" and (not included or not excluded or set(included) | set(excluded) != known):
        errors.append("partial decision requires a nonempty approved/excluded partition of all steps")
    if decision in ("rejected", "revoked") and included:
        errors.append("Rejected/revoked decision cannot approve any step")
    return errors


def blockers(record: dict[str, Any], selected: list[str]) -> dict[str, list[str]]:
    """Propagate only declared blockers through the actual step dependency graph."""
    graph = {step["id"]: step["depends_on"] for step in record["execution_spec"]["steps"]}
    direct: dict[str, list[str]] = {step_id: [] for step_id in graph}
    for topic in record["topics"]:
        if topic["status"] in {"pending", "deferred"} and topic["criticality"] == "material":
            for step_id in topic["dependent_steps"]:
                direct[step_id].append(f"material topic {topic['id']} is {topic['status']}")
    for section, part in record["baseline"].items():
        if section not in BASELINE_KEYS:
            continue
        for unknown in part["unknowns"]:
            for step_id in unknown["blocking_steps"]:
                direct[step_id].append(f"baseline.{section} unknown: {unknown['text']}")
    approved = set(record["approval"]["approved_steps"])
    result: dict[str, list[str]] = {}
    def collect(step_id: str, seen: set[str]) -> list[str]:
        if step_id in seen:
            return []
        seen = seen | {step_id}
        found = list(direct[step_id])
        if step_id not in approved:
            found.append(f"step {step_id} is outside the approved subset")
        for dep in graph[step_id]:
            found.extend(f"dependency {dep}: {reason}" for reason in collect(dep, seen))
        return found
    for step_id in selected:
        found = collect(step_id, set())
        if found:
            result[step_id] = found
    return result


def closeout_errors(record: dict[str, Any], root: Path) -> list[str]:
    """Validate a result/checkpoint without inventing acceptance or a next stage."""
    closeout = record.get("closeout")
    if not isinstance(closeout, dict):
        return ["closeout: object required"]
    errors = []
    outcome = closeout.get("outcome", "continue")
    outcomes = {"continue", "ready_for_acceptance", "accepted_continue", "accepted_done",
                "waiting_decision", "paused", "blocked", "cancelled"}
    if not isinstance(outcome, str) or outcome not in outcomes:
        errors.append("closeout.outcome: unsupported outcome")
        return errors
    for field in ("result", "readiness", "recommendation"):
        if not text_present(closeout.get(field)):
            errors.append(f"closeout.{field}: explicit content required")
    for field in ("checks", "gaps", "artifacts"):
        if not isinstance(closeout.get(field), list):
            errors.append(f"closeout.{field}: list required")
    artifacts = closeout.get("artifacts") if isinstance(closeout.get("artifacts"), list) else []
    if not artifacts:
        errors.append("closeout.artifacts: at least one actual output/checkpoint required")
    for index, artifact in enumerate(artifacts):
        errors.extend(file_binding(root, artifact, f"closeout.artifacts[{index}]"))
    needs_brief = closeout.get("needs_brief", False)
    if not isinstance(needs_brief, bool):
        errors.append("closeout.needs_brief: boolean required")
    if needs_brief and not text_present(closeout.get("questionnaire_offer")):
        errors.append("closeout.questionnaire_offer: explain the actual next unresolved decisions")
    terminal = outcome in {"accepted_done", "cancelled"}
    route = closeout.get("next_stage")
    prompt = closeout.get("next_launch_prompt")
    if terminal:
        if route not in (None, {}) or prompt not in (None, {}):
            errors.append("terminal closeout must not invent a next stage or launch prompt")
        if needs_brief:
            errors.append("terminal closeout cannot require a next briefing")
    else:
        requires_route = outcome in {"continue", "accepted_continue"}
        if requires_route or route not in (None, {}):
            if not isinstance(route, dict):
                errors.append("closeout.next_stage: object required for continuation")
            else:
                for field in ("stage", "host", "selector"):
                    if not text_present(route.get(field)):
                        errors.append(f"closeout.next_stage.{field}: nonempty text required")
        if requires_route or prompt not in (None, {}):
            if not isinstance(prompt, dict):
                errors.append("closeout.next_launch_prompt: actual {path, sha256} required for continuation")
            else:
                errors.extend(file_binding(root, prompt, "closeout.next_launch_prompt"))
        if requires_route and not text_present(closeout.get("return_validation")):
            errors.append("closeout.return_validation: actual return checks required for continuation")
    if outcome.startswith("accepted_"):
        acceptance = closeout.get("owner_acceptance")
        if not isinstance(acceptance, dict):
            errors.append("accepted closeout needs actual owner_acceptance; execution approval is not result acceptance")
        else:
            if acceptance.get("source_role") != "user" or acceptance.get("decision") != "accepted":
                errors.append("owner_acceptance must be the user's accepted decision")
            for field in ("source_ref", "quote"):
                value = acceptance.get(field)
                if not text_present(value) or PLACEHOLDERS.search(value):
                    errors.append("owner_acceptance." + field + ": actual nonplaceholder source required")
            ref = acceptance.get("source_ref")
            if isinstance(ref, str) and ref.lower().startswith(("self:", "generated:", "template:")):
                errors.append("owner_acceptance source cannot be self-generated")
            if acceptance.get("source_status", "available") != "available":
                errors.append("owner_acceptance source unavailable or unverified")
            if acceptance.get("scope_hash") != scope_hash(record):
                errors.append("owner_acceptance scope_hash is stale")
            if acceptance.get("artifacts_sha256") != digest_bytes(canonical(artifacts)):
                errors.append("owner_acceptance artifacts_sha256 is stale")
    return errors


def check(record: dict[str, Any], root: Path, gate: str, step_id: str | None = None) -> dict[str, Any]:
    errors = validate_structure(record, root)
    result: dict[str, Any] = {"schema_version": SCHEMA, "gate": gate, "ok": False, "errors": errors,
                              "quality_certified": False, "human_authority_authenticated": False,
                              "executes_actions": False}
    if errors:
        return result
    result["scope_hash"] = scope_hash(record)
    if step_id and step_id not in {step["id"] for step in record["execution_spec"]["steps"]}:
        errors.append(f"Unknown --step: {step_id}")
    if gate != "interview":
        errors.extend(binding_errors(record, root))
    if gate in {"approval", "execution"}:
        errors.extend(approval_errors(record, record.get("approval")))
        if not errors:
            if record["approval"]["decision"] not in {"approved", "partial"}:
                errors.append(f"Actual user decision is {record['approval']['decision']}; execution is not approved")
            else:
                selected = [step_id] if step_id else record["approval"]["approved_steps"]
                result["selected_steps"] = selected
                blocked = blockers(record, selected)
                result["blocked_steps"] = blocked
                for step, reasons in blocked.items():
                    errors.extend(f"{step}: {reason}" for reason in reasons)
        if gate == "execution" and record["pause"]["active"]:
            errors.append("Active pause blocks execution; this controller never clears or resumes it")
    if gate == "closeout":
        errors.extend(closeout_errors(record, root))
        result["execution_authorized_by_closeout"] = False
    result["ok"] = not errors
    return result


def template(mode: str, family: str, stage: str, goal: str) -> dict[str, Any]:
    baseline = {section: {"facts": [], "unknowns": [], "inputs": []} for section in BASELINE_KEYS}
    if mode == "resume":
        for section, part in baseline.items():
            part["unknowns"] = [{"text": f"Reconstruct actual {section}; no fact inferred from prior conversation", "blocking_steps": []}]
    return {"schema_version": SCHEMA, "mode": mode, "family": family, "stage": stage, "goal": goal,
            "authority_refs": [], "baseline": baseline, "topics": [],
            "execution_spec": {"revision": "1", "outcomes": [], "steps": [], "resources": [], "limits": {},
                               "milestones": [], "stop": {}, "delegation": {}, "next_route": {}},
            "approval": None, "pause": {"active": False}, "script_binding": None, "closeout": None}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    def command(name, help_text):
        item = commands.add_parser(name, help=help_text)
        item.add_argument("record", type=Path)
        item.add_argument("--root", type=Path, help="All referenced files must resolve within this directory; default record parent")
        item.add_argument("--json", action="store_true", help="Print structured result")
        return item
    init = command("init", "Create an unfinished briefing/1 record, refusing overwrite")
    init.add_argument("--mode", choices=("brief", "resume"), required=True)
    init.add_argument("--family", required=True)
    init.add_argument("--stage", required=True)
    init.add_argument("--goal", required=True)
    render = command("render-script", "Render the deterministic human script and bind its exact bytes")
    render.add_argument("--output", required=True, help="Script path, relative to --root or absolute within it")
    approval = command("record-approval", "Record actual user decision JSON; never manufactures consent")
    approval.add_argument("--approval", type=Path, required=True)
    validate = command("check", "Check a binding/readiness gate without executing any action")
    validate.add_argument("--gate", choices=("interview", "approval", "execution", "closeout"), required=True)
    validate.add_argument("--step", help="Check only this approved step and its prerequisites")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        path = args.record.resolve()
        root = (args.root or path.parent).resolve()
        contained_path(root, str(path), "record")
        if args.command == "init":
            write_json(path, template(args.mode, args.family, args.stage, args.goal), exclusive=True)
            output = {"ok": True, "record": str(path), "status": "draft", "approval_created": False}
        else:
            record = load_json(path)
            if args.command == "check":
                output = check(record, root, args.gate, args.step)
            elif args.command == "render-script":
                errors = validate_structure(record, root)
                if errors:
                    raise BriefingError("; ".join(errors))
                target = contained_path(root, args.output, "--output")
                forbidden = {path}
                for item, label in immutable_inputs(record):
                    forbidden.add(contained_path(root, item["path"], label))
                if target in forbidden:
                    raise BriefingError("Rendered script cannot overwrite the record or an immutable input")
                script = render_script(record)
                new_binding = {"path": str(target.relative_to(root)), "scope_hash": scope_hash(record), "script_sha256": digest_bytes(script)}
                if record.get("approval") and (record["approval"].get("scope_hash") != new_binding["scope_hash"] or record["approval"].get("script_sha256") != new_binding["script_sha256"]):
                    record.setdefault("approval_history", []).append(record.pop("approval"))
                    record["approval"] = None
                atomic_write(target, script)
                record["script_binding"] = new_binding
                write_json(path, record)
                output = {"ok": True, "script_binding": new_binding, "approval_created": False}
            else:
                errors = validate_structure(record, root)
                if not errors:
                    errors.extend(binding_errors(record, root))
                approval = load_json(args.approval)
                if not errors:
                    errors.extend(approval_errors(record, approval))
                if errors:
                    raise BriefingError("; ".join(errors))
                if record.get("approval"):
                    record.setdefault("approval_history", []).append(record["approval"])
                record["approval"] = approval
                write_json(path, record)
                output = {"ok": True, "decision_recorded": approval["decision"], "execution_started": False,
                          "human_authority_authenticated": False}
        if args.json:
            print(json.dumps(output, ensure_ascii=False, sort_keys=True))
        else:
            print("PASS" if output["ok"] else "BLOCKED")
            for error in output.get("errors", []):
                print(f"- {error}")
            if "script_binding" in output:
                print(json.dumps(output["script_binding"], ensure_ascii=False, indent=2))
            print("Structural binding only; no human authentication, action execution, or quality certification.")
        return 0 if output["ok"] else 1
    except (BriefingError, OSError, ValueError, TypeError, KeyError) as exc:
        output = {"ok": False, "errors": [str(exc)], "quality_certified": False}
        if args.json:
            print(json.dumps(output, ensure_ascii=False, sort_keys=True))
        else:
            print(f"BLOCKED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
