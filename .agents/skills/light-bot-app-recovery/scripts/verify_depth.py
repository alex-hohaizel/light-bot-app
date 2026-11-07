#!/usr/bin/env python3
"""Validate an additive depth/2 project projection; never certify domain quality."""
import argparse
import hashlib
import json
from pathlib import Path

LEVEL = {"draft": 0, "design": 1, "production": 2}
KINDS = {"source", "calculation", "local", "integration", "independent", "human", "device", "external"}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(data, root, gate="draft"):
    errors = []
    root = Path(root).resolve()

    def fail(message):
        errors.append(message)

    def needed(obj, fields, where):
        if not isinstance(obj, dict):
            fail(where + ": expected object")
            return False
        for key in fields:
            value = obj.get(key)
            if value is None or value == "" or value == [] or value == {}:
                fail(where + ": missing " + key)
        return True

    def strings(obj, field, where, nonempty=False):
        values = obj.get(field)
        if not isinstance(values, list) or any(not isinstance(v, str) or not v.strip() for v in values):
            fail(where + ": " + field + " must be string array")
            return []
        if nonempty and not values:
            fail(where + ": empty " + field)
        return values

    if not isinstance(data, dict):
        return ["project must be object"]
    needed(data, ["schema_version", "project_id", "revision", "maturity", "scope", "consumer"], "project")
    if data.get("schema_version") != "depth/2":
        fail("unsupported schema_version; provide a current depth/2 result from current evidence")
    maturity = data.get("maturity")
    if maturity not in LEVEL:
        fail("unknown maturity")
    elif LEVEL[maturity] < LEVEL[gate]:
        fail("declared maturity below requested gate")
    tables = {}
    collections = ["requirements", "systems", "contracts", "operations", "capabilities", "recipes", "attempts", "transformations", "assemblies", "evidence"]
    for key in collections:
        values = data.get(key)
        table = {}
        if not isinstance(values, list):
            fail(key + ": expected array")
            values = []
        for row in values:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"].strip():
                fail(key + ": record requires nonempty id")
                continue
            if row["id"] in table:
                fail(key + ": duplicate id " + row["id"])
            table[row["id"]] = row
        tables[key] = table
    all_ids = [key for table in tables.values() for key in table]
    if len(all_ids) != len(set(all_ids)):
        fail("IDs must be globally unique across collections")

    def refs(row, field, table, where, nonempty=False):
        values = strings(row, field, where, nonempty)
        for value in values:
            if value not in tables[table]:
                fail(where + ": unresolved " + field + " " + value)
        return values

    def files(values, where):
        if not isinstance(values, list) or not values:
            fail(where + ": nonempty file records required")
            return
        for item in values:
            if not needed(item, ["path", "sha256"], where):
                continue
            path, sha = item.get("path"), item.get("sha256")
            if not isinstance(path, str) or not isinstance(sha, str):
                fail(where + ": path/hash must be strings")
                continue
            resolved = (root / path).resolve()
            if Path(path).is_absolute() or root not in resolved.parents:
                fail(where + ": path escapes root " + path)
                continue
            if not resolved.is_file():
                fail(where + ": missing file " + path)
            elif digest(resolved) != sha:
                fail(where + ": stale bytes " + path)

    if not tables["requirements"]:
        fail("at least one scoped requirement required")
    for ident, row in tables["requirements"].items():
        needed(row, ["source", "owner", "applicability", "acceptance", "negative_case", "due"], ident)
        app = row.get("applicability")
        if app not in {"required", "conditional", "not_applicable", "pending"}:
            fail(ident + ": invalid applicability")
        if row.get("due") not in LEVEL:
            fail(ident + ": invalid due gate")
        refs(row, "contract_ids", "contracts", ident)
        refs(row, "evidence_ids", "evidence", ident)
        if app == "not_applicable":
            needed(row, ["reason", "reopen_when"], ident)
        if app == "conditional":
            needed(row, ["condition"], ident)
            if not isinstance(row.get("active"), bool):
                fail(ident + ": conditional active must be boolean")
        active = app == "required" or (app == "conditional" and row.get("active") is True)
        due = LEVEL.get(row.get("due"), 99) <= LEVEL[gate]
        if app == "pending" and due:
            fail(ident + ": due applicability unresolved")
        if active and due:
            if not row.get("contract_ids"):
                fail(ident + ": due active requirement lacks contract")
            refs(row, "evidence_ids", "evidence", ident, True)
            required = strings(row, "required_evidence_kinds", ident, True)
            observed = set()
            for e in row.get("evidence_ids", []):
                ev = tables["evidence"].get(e, {})
                observed.add(ev.get("kind"))
                if ev.get("verdict") != "pass" or ev.get("status") != "current":
                    fail(ident + ": due proof not passing/current " + e)
                if ident not in ev.get("requirement_ids", []):
                    fail(ident + ": evidence does not cover requirement " + e)
            for contract_id in row.get('contract_ids', []):
                if ident not in tables['contracts'].get(contract_id, {}).get('requirement_ids', []):
                    fail(ident + ': contract does not cover linked requirement ' + contract_id)
            if not set(required).issubset(observed):
                fail(ident + ": required evidence kinds missing")
    for ident, row in tables["systems"].items():
        needed(row, ["owner", "applicability"], ident)
        if row.get('applicability') not in {'required', 'conditional', 'not_applicable', 'pending'}:
            fail(ident + ': invalid system applicability')
        if LEVEL[gate] >= 1 and row.get('applicability') == 'pending':
            fail(ident + ': system applicability unresolved')
        if row.get('applicability') == 'conditional':
            needed(row, ['condition'], ident)
            if not isinstance(row.get('active'), bool):
                fail(ident + ': conditional system active must be boolean')
        active_system = row.get('applicability') == 'required' or (row.get('applicability') == 'conditional' and row.get('active') is True)
        if active_system:
            for key in ["state_fields", "transitions", "invariants", "interactions"]:
                if LEVEL[gate] >= 1:
                    needed(row, [key], ident)
        elif row.get("applicability") == "not_applicable":
            needed(row, ["reason", "reopen_when"], ident)
    for ident, row in tables["contracts"].items():
        needed(row, ["owner", "consumer", "inputs", "outputs", "rule", "failure", "acceptance"], ident)
        refs(row, "requirement_ids", "requirements", ident, True)
        refs(row, "operation_ids", "operations", ident, LEVEL[gate] >= 2)
    for ident, row in tables["operations"].items():
        needed(row, ["owner", "consumer", "status"], ident)
        for key, table in [("capability_ids", "capabilities"), ("recipe_ids", "recipes"), ("attempt_ids", "attempts")]:
            refs(row, key, table, ident, LEVEL[gate] >= 2)
        if LEVEL[gate] >= 2 and row.get("status") != "verified":
            fail(ident + ": production operation not verified")
        if LEVEL[gate] >= 2:
            successes = [tables['attempts'].get(a, {}) for a in row.get('attempt_ids', [])]
            if not any(a.get('outcome') == 'succeeded' and a.get('recipe_id') in row.get('recipe_ids', []) for a in successes):
                fail(ident + ': verified operation lacks successful linked recipe attempt')
            if any(a.get('outcome') in {'unknown','pending'} for a in successes):
                fail(ident + ': operation has unresolved attempt outcome')
            accepted = tables['attempts'].get(row.get('accepted_attempt_id'), {})
            if row.get('accepted_attempt_id') not in row.get('attempt_ids', []) or accepted.get('outcome') != 'succeeded' or accepted.get('recipe_id') not in row.get('recipe_ids', []):
                fail(ident + ': operation requires exact accepted successful attempt')
    for ident, row in tables["capabilities"].items():
        needed(row, ["operation", "tool_version", "environment", "parameters", "limits", "rights", "cost", "status"], ident)
        refs(row, "evidence_ids", "evidence", ident, LEVEL[gate] >= 2)
        if LEVEL[gate] >= 2 and row.get("status") != "exercised":
            fail(ident + ": production capability not exercised")
        if LEVEL[gate] >= 2:
            for key in row.get('evidence_ids', []):
                proof = tables['evidence'].get(key, {})
                if proof.get('kind') not in {'local', 'integration', 'device', 'external'} or proof.get('verdict') != 'pass' or proof.get('status') != 'current':
                    fail(ident + ': capability requires actual current execution proof')
                if ident not in proof.get('capability_ids', []):
                    fail(ident + ': capability evidence scope mismatch')
                if proof.get('environment') != row.get('environment'):
                    fail(ident + ': capability proof environment mismatch')
    for ident, row in tables["recipes"].items():
        needed(row, ["owner", "consumer", "inputs", "steps", "outputs", "acceptance", "fallback", "budget"], ident)
        refs(row, "transformation_ids", "transformations", ident, LEVEL[gate] >= 2)
    for ident, row in tables["transformations"].items():
        needed(row, ["input_semantics", "output_semantics", "preserve", "check"], ident)
    for ident, row in tables["attempts"].items():
        needed(row, ["actor", "recipe_id", "outcome", "parameters", "resources"], ident)
        if row.get("recipe_id") not in tables["recipes"]:
            fail(ident + ": unresolved recipe_id")
        if row.get("outcome") not in {"succeeded", "failed", "pending", "unknown", "cancelled"}:
            fail(ident + ": invalid outcome")
        if row.get("outcome") in {"pending", "unknown"}:
            needed(row, ["reconcile"], ident)
        if row.get("outcome") == "succeeded":
            files(row.get("outputs"), ident + ".outputs")
    for ident, row in tables["assemblies"].items():
        needed(row, ["owner", "consumer", "build", "environment", "scenario", "expected", "actual", "recovery"], ident)
        refs(row, "evidence_ids", "evidence", ident, True)
        refs(row, "operation_ids", "operations", ident, True)
        if LEVEL[gate] >= 2:
            files(row.get('artifacts'), ident + '.artifacts')
            files(row.get('component_files'), ident + '.component_files')
            component_files = row.get('component_files', [])
            artifacts = row.get('artifacts', [])
            for op in row.get("operation_ids", []):
                if tables["operations"].get(op, {}).get("status") != "verified":
                    fail(ident + ": assembly includes unverified operation " + op)
                operation = tables['operations'].get(op, {})
                attempt = tables['attempts'].get(operation.get('accepted_attempt_id'), {})
                for output in attempt.get('outputs', []):
                    if output not in component_files:
                        fail(ident + ': assembly missing accepted operation output')
            for key in row.get('evidence_ids', []):
                proof = tables['evidence'].get(key, {})
                if proof.get('kind') not in {'integration', 'device', 'external', 'human'} or proof.get('verdict') != 'pass' or proof.get('status') != 'current':
                    fail(ident + ': assembly requires current integrated observation')
                if ident not in proof.get('assembly_ids', []) or proof.get('build') != row.get('build') or proof.get('environment') != row.get('environment'):
                    fail(ident + ': assembly proof build/environment/scope mismatch')
                if any(a not in proof.get('files', []) for a in artifacts) or any(c not in proof.get('inputs', []) for c in component_files):
                    fail(ident + ': assembly proof not bound to artifacts/components')
    for ident, row in tables["evidence"].items():
        needed(row, ["kind", "actor", "scope", "environment", "observed_at", "verdict", "status", "method"], ident)
        if row.get("kind") not in KINDS:
            fail(ident + ": unknown evidence kind")
        if row.get("status") not in {"current", "historical", "stale"}:
            fail(ident + ": invalid evidence status")
        if row.get("verdict") not in {"pass", "fail", "inconclusive"}:
            fail(ident + ": invalid evidence verdict")
        refs(row, "requirement_ids", "requirements", ident, True)
        if row.get("kind") == "independent":
            needed(row, ["author_actor", "reviewer_actor"], ident)
            if row.get("author_actor") == row.get("reviewer_actor"):
                fail(ident + ": author cannot independently review self")
            if row.get('actor') != row.get('reviewer_actor'):
                fail(ident + ': independent evidence actor must be actual reviewer')
        files(row.get("files"), ident + ".files")
        files(row.get("inputs"), ident + ".inputs")
    if LEVEL[gate] >= 2:
        for key in ["systems", "operations", "assemblies"]:
            if not tables[key]:
                fail("production requires " + key)
        handoff = data.get("handoff", {})
        valid_handoff = needed(handoff, ["receiver", "reconstruction", "permissions", "budget", "checkpoint", "next_action"], "handoff")
        if not valid_handoff or handoff.get("status") != "accepted":
            fail("production requires accepted cold-receiver handoff")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("--gate", choices=LEVEL, default="draft")
    parser.add_argument("--root", type=Path)
    args = parser.parse_args()
    try:
        data = json.loads(args.project.read_text(encoding="utf-8"))
        errors = validate(data, args.root or args.project.parent, args.gate)
    except (ValueError, OSError, TypeError, KeyError) as exc:
        errors = [str(exc)]
    print(json.dumps({"structurally_valid": not errors, "quality_certified": False,
                      "gate": args.gate, "errors": errors}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
