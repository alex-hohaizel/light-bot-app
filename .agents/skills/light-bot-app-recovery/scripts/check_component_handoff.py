#!/usr/bin/env python3
"""Check current Atelier component handoff records; not domain or consent certification."""
import argparse
import hashlib
import json
import re
from pathlib import Path

SELECTORS = {"app": "app-atelier-director", "chatbot": "chatbot-atelier-director", "agent_skill": "design-specialist-skills"}
ALLOWED_SELECTORS = {
    "app": {"app-atelier-" + stage for stage in ("director", "research", "concepts", "specification", "experience", "build", "support", "qa", "release", "growth", "operations")},
    "chatbot": {"chatbot-atelier-" + stage for stage in ("director", "research", "specification", "conversation", "knowledge", "integrations", "media", "build", "qa", "release", "operations")},
    "agent_skill": {"design-specialist-skills"},
}
STATUSES = {"draft", "prepared", "executed", "accepted", "blocked"}
ACTIVITY_GRANTS = {
    "planning": {"planning_only", "construction_only", "component_execution"},
    "skill_construction": {"construction_only"},
    "product_execution": {"component_execution"},
}
STABLE_SELECTOR = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")


def stable_selector(value):
    return isinstance(value, str) and len(value) <= 64 and bool(STABLE_SELECTOR.fullmatch(value))


def frontmatter_name(content):
    """Read only the leading frontmatter block, never body examples or later blocks."""
    source = content.decode("utf-8")
    header = re.match(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", source, re.S)
    if not header:
        return None
    names = re.findall(r"(?m)^name:[ \t]*(.*?)[ \t]*$", header.group(1))
    if len(names) != 1:
        return None
    value = names[0].strip()
    if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
        value = value[1:-1]
    return value if stable_selector(value) else None


def validate(data, root, ready=False):
    root = Path(root).resolve()
    errors = []

    def require(ok, message):
        if not ok:
            errors.append(message)

    def text(value):
        return isinstance(value, str) and bool(value.strip())

    def object_(value, label):
        if not isinstance(value, dict):
            errors.append(label + " must be an object")
            return {}
        return value

    def strings(value, label, nonempty=False):
        if not isinstance(value, list) or any(not text(v) for v in value):
            errors.append(label + " must be a string array")
            return []
        require(len(value) == len(set(value)), label + " contains duplicates")
        if nonempty:
            require(bool(value), label + " cannot be empty")
        return value

    def file_(record, label):
        record = object_(record, label)
        path, expected = record.get("path"), record.get("sha256")
        if not text(path) or Path(path).is_absolute() or ".." in Path(path).parts:
            errors.append(label + " requires a contained relative path")
            return
        current = root
        for part in Path(path).parts:
            current = current / part
            if current.is_symlink():
                errors.append(label + " does not allow symlinks")
                return
        if root not in current.resolve().parents or not current.is_file():
            errors.append(label + " file missing or outside project")
            return
        content = current.read_bytes()
        require(isinstance(expected, str) and hashlib.sha256(content).hexdigest() == expected, label + " file hash is stale")
        return content

    data = object_(data, "handoff")
    require(data.get("schema_version") == "atelier-component-handoff/1", "unsupported handoff schema; prepare a current record from actual sources")
    require(data.get("is_template") is False, "instantiate the handoff template before use")
    for key in ("product_id", "component_id", "parent_intent_ref", "authority_ref", "consumer"):
        require(text(data.get(key)), "missing " + key)
    kind = data.get("component_kind")
    require(kind in SELECTORS, "unsupported component_kind")
    status = data.get("status")
    require(status in STATUSES, "invalid handoff status")
    parent_ids = strings(data.get("parent_requirement_ids"), "parent_requirement_ids", True)
    owned_ids = strings(data.get("owned_requirement_ids"), "owned_requirement_ids", True)
    require(set(owned_ids) <= set(parent_ids), "owned requirements must come from parent authority")
    scope = object_(data.get("scope"), "scope")
    for key in ("goal", "included", "excluded", "stop"):
        require(bool(scope.get(key)), "scope missing " + key)
    permissions = object_(data.get("permissions"), "permissions")
    require(text(permissions.get("source_ref")), "permissions source_ref required")
    require(permissions.get("grant") in {"planning_only", "construction_only", "component_execution"}, "invalid permission grant")
    strings(permissions.get("allowed_effects"), "permissions.allowed_effects")
    for key in ("budget", "decisions", "environment_capabilities", "acceptance", "checkpoint"):
        require(bool(data.get(key)), "missing " + key)
    require(text(data.get("next_action")) and text(data.get("return_condition")), "next action and upstream return condition required")
    return_to = object_(data.get("return_to"), "return_to")
    require(stable_selector(return_to.get("selector")) and text(return_to.get("component_id")), "stable return selector and parent component required")
    chain = strings(data.get("orchestrator_chain"), "orchestrator_chain", True)
    require(all(stable_selector(value) for value in chain), "orchestrator chain requires stable selectors without version numbers")
    strings(data.get("selected_channels"), "selected_channels")
    strings(data.get("proposed_channels"), "proposed_channels")
    inputs = data.get("inputs")
    require(isinstance(inputs, list), "inputs must be an array")
    for index, record in enumerate(inputs if isinstance(inputs, list) else []):
        file_(record, "inputs[" + str(index) + "]")
    contracts = data.get("shared_contract_refs")
    require(isinstance(contracts, list), "shared_contract_refs must be an array")
    contract_ids = set()
    for record in contracts if isinstance(contracts, list) else []:
        record = object_(record, "shared contract")
        identifier = record.get("id")
        require(text(identifier) and identifier not in contract_ids, "shared contracts need unique IDs")
        if text(identifier):
            contract_ids.add(identifier)
        require(text(record.get("owner")), "shared contract owner required")
        consumers = strings(record.get("component_ids"), "shared contract component_ids", True)
        require(data.get("component_id") in consumers, "shared contract must bind this component")
        file_(record, "shared contract " + str(identifier))
    platform_refs = strings(data.get("platform_adapter_contract_refs"), "platform_adapter_contract_refs")
    require(set(platform_refs) <= contract_ids, "platform adapter references missing bound contract")
    related = data.get("related_components", [])
    require(isinstance(related, list), "related_components must be an array")
    for peer in related if isinstance(related, list) else []:
        peer = object_(peer, "related component")
        require(text(peer.get("component_id")) and peer.get("component_id") != data.get("component_id"), "related component identity invalid")
        require(peer.get("component_kind") in SELECTORS, "related component kind invalid")
        refs = strings(peer.get("contract_ids"), "related component contract_ids", True)
        require(set(refs) <= contract_ids, "related component references missing shared contract")
        for identifier in refs:
            matching = [c for c in contracts if isinstance(c, dict) and c.get("id") == identifier]
            require(bool(matching) and peer.get("component_id") in matching[0].get("component_ids", []), "shared contract does not bind related component")
    evidence = data.get("evidence")
    require(isinstance(evidence, list), "evidence must be an array")
    evidence_ids = set()
    evidence_by_id = {}
    for record in evidence if isinstance(evidence, list) else []:
        record = object_(record, "evidence")
        identifier = record.get("id")
        require(text(identifier) and identifier not in evidence_ids, "evidence IDs must be unique")
        if text(identifier):
            evidence_ids.add(identifier)
            evidence_by_id[identifier] = record
        for key in ("claim", "actor", "method", "scope"):
            require(text(record.get(key)), "evidence missing " + key)
        file_(record, "evidence " + str(identifier))
    invocation = object_(data.get("invocation"), "invocation")
    require(invocation.get("selector") in ALLOWED_SELECTORS.get(kind, set()), "component must use a stable supported selector of its own family")
    require(invocation.get("environment") in {"work", "codex"}, "invocation environment must be work or codex")
    activity = invocation.get("activity")
    require(activity in ACTIVITY_GRANTS, "invocation activity must be planning, skill_construction or product_execution")
    if activity == "skill_construction":
        require(kind == "agent_skill", "skill construction requires an agent_skill component")
    elif activity == "product_execution":
        require(kind in {"app", "chatbot"}, "product execution requires an app or chatbot component")
    require(len(chain) >= 2 and chain[-1] == invocation.get("selector"), "orchestrator chain must terminate at the actual invocation selector")
    require(len(chain) >= 2 and chain[-2] == return_to.get("selector"), "return selector must be the immediate parent in orchestrator chain")
    availability = invocation.get("availability")
    require(availability in {"available", "unavailable", "unknown"}, "invalid invocation availability")
    invoked = invocation.get("status")
    require(invoked in {"planned", "blocked", "performed"}, "invalid invocation status")
    receipts = strings(invocation.get("receipt_refs"), "invocation.receipt_refs")
    require(set(receipts) <= evidence_ids, "invocation references missing receipt evidence")
    if availability == "available":
        resolution = object_(invocation.get("resolution"), "invocation.resolution")
        require(text(resolution.get("source_ref")), "actual resolved source reference required")
        snapshot = file_(resolution.get("snapshot"), "resolved skill snapshot")
        if snapshot is not None:
            require(frontmatter_name(snapshot) == invocation.get("selector"), "resolved source frontmatter differs from stable selector")
    if invoked == "performed":
        require(availability == "available", "missing skill cannot be reported invoked")
        require(bool(receipts), "performed invocation requires actual receipt evidence")
        require(text(invocation.get("actor")), "performed invocation requires actual actor")
        for identifier in receipts:
            receipt = evidence_by_id.get(identifier, {})
            require(receipt.get("actor") == invocation.get("actor"), "invocation receipt actor differs from actual actor")
            require(receipt.get("component_id") == data.get("component_id"), "invocation receipt must bind this component")
            receipt_ids = strings(receipt.get("requirement_ids"), "invocation receipt requirement_ids", True)
            require(set(receipt_ids) <= set(owned_ids), "invocation receipt requirements outside component scope")
    fallback = data.get("fallback")
    fallback_ready = False
    if fallback is not None:
        fallback = object_(fallback, "fallback")
        require(fallback.get("mode") in {"embedded_method", "handoff_to_capable_host"}, "invalid fallback mode")
        for key in ("reason", "owner", "consumer", "acceptance"):
            require(text(fallback.get(key)), "fallback missing " + key)
        if fallback.get("mode") == "embedded_method":
            file_(fallback.get("method"), "fallback method")
            fallback_ready = kind == "agent_skill" and activity == "skill_construction"
    if invoked == "performed" or ready or (fallback_ready and status in {"executed", "accepted"}):
        require(permissions.get("grant") in ACTIVITY_GRANTS.get(activity, set()), "permission grant does not authorize " + str(activity).replace("_", " "))
    outputs = data.get("deliverables")
    require(isinstance(outputs, list), "deliverables must be an array")
    for record in outputs if isinstance(outputs, list) else []:
        file_(record, "deliverable")
    if status in {"executed", "accepted"}:
        require(invoked == "performed" or fallback_ready, "executed/accepted component requires actual invocation or bound construction method")
        require(isinstance(outputs, list) and bool(outputs), "executed output files required")
        require(bool(evidence_ids), "executed component evidence required")
    questions = data.get("open_questions")
    require(isinstance(questions, list), "open_questions must be an array")
    blocking_pending = False
    for question in questions if isinstance(questions, list) else []:
        question = object_(question, "open question")
        require(text(question.get("question")), "open question text required")
        require(type(question.get("blocking")) is bool, "open question blocking must be boolean")
        require(question.get("status") in {"pending", "resolved"}, "open question status must be pending or resolved")
        if question.get("status") == "resolved":
            require(text(question.get("resolution_ref")), "resolved question requires resolution_ref")
        blocking_pending = blocking_pending or (question.get("blocking") is True and question.get("status") != "resolved")
    if ready:
        require(status in {"prepared", "executed", "accepted"}, "ready requires a prepared or executed handoff")
        require(availability == "available" or fallback_ready, "required specialist missing; current handoff is blocked")
        require(not blocking_pending, "blocking component decision unresolved")
    return errors


def check(data, root, ready=False):
    try:
        return validate(data, root, ready)
    except (TypeError, AttributeError, KeyError, OSError, ValueError) as exc:
        return ["invalid handoff structure: " + str(exc)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--ready", action="store_true", help="Check receiving readiness, not product completion")
    args = parser.parse_args()
    try:
        errors = check(json.loads(args.file.read_text(encoding="utf-8")), args.root or args.file.parent, args.ready)
    except (OSError, ValueError) as exc:
        errors = [str(exc)]
    print(json.dumps({"structurally_valid": not errors, "quality_certified": False, "errors": errors}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
