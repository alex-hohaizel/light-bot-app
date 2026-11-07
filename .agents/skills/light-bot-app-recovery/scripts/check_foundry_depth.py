#!/usr/bin/env python3
"""Validate linked Foundry2 domain/production/inheritance records, never quality."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import types

SUBJECT_FIELDS = ('blueprint_id', 'blueprint_revision', 'blueprint_sha256', 'authority_source')
RUNTIME = Path(__file__).absolute().with_name('foundry.py')


def read_current_subject(session):
    """Read the canonical session under its lock without saving or dispatching.

    A copied gate report cannot establish current approval. The trusted sibling
    runtime checks journal/snapshot integrity, exact inputs, current suite, pause
    and canonical authority bindings on an in-memory state only.
    """
    if RUNTIME.is_symlink() or not RUNTIME.is_file() or not stat.S_ISREG(RUNTIME.stat().st_mode):
        raise ValueError('trusted bundled foundry.py is unavailable')
    runtime = types.ModuleType('depth_current_foundry')
    runtime.__file__ = str(RUNTIME)
    exec(compile(RUNTIME.read_bytes(), str(RUNTIME), 'exec'), runtime.__dict__)
    session = Path(session).absolute()
    if not (session / '.agent-foundry' / 'state.json').is_file():
        raise ValueError('current Foundry session not found; supply --session SESSION (not a copied gate JSON)')
    if not (session / '.agent-foundry' / 'lock').is_file():
        raise ValueError('current Foundry session lock is missing; recover the initialized session')
    with runtime.lock(session) as home:
        state = runtime.read_state(home)
        runtime.refresh(state, session)
        blockers = runtime.approval_current(state, session)
        if blockers:
            raise ValueError('current Foundry approval blocks readiness: ' + '; '.join(sorted(set(blockers))))
        blueprint = state['blueprint']
        # Also check the stored canonical digest, not just two matching strings.
        if runtime.digest(blueprint['data']) != blueprint['sha256']:
            raise ValueError('current blueprint canonical digest mismatch')
        return {
            'blueprint_id': blueprint['data']['id'],
            'blueprint_revision': blueprint['data']['revision'],
            'blueprint_sha256': blueprint['sha256'],
            'authority_source': state['approval']['source'],
            'scope': blueprint['data']['scope'],
            'session_state_sha256': runtime.sha(home / 'state.json'),
            'session_revision': state['revision'],
        }

KINDS = {'core', 'domain', 'production', 'evaluation'}
LEVELS = {'source', 'structural', 'semantic', 'operation', 'integration', 'human', 'operational'}


def validate(model, root, ready=False, current_subject=None):
    errors = []
    root = Path(root).resolve()
    if not isinstance(model, dict):
        return ['model must be object']
    if model.get('schema_version') != 'foundry-depth/2':
        errors.append('schema_version must be foundry-depth/2')
    if model.get('is_template') is not False:
        errors.append('template is not an instantiated model')
    if model.get('maturity') not in {'M0', 'M1', 'M2'}:
        errors.append('maturity must be M0/M1/M2')
    if ready and model.get('maturity') != 'M2':
        errors.append('ready requires M2')
    if current_subject is not None and not isinstance(current_subject, dict):
        errors.append('current session subject must be an object')
        current_subject = None
    subject = model.get('subject')
    if not isinstance(subject, dict):
        if ready or model.get('maturity') in {'M1', 'M2'}:
            errors.append('subject must bind the current blueprint')
        subject = {}
    if ready or model.get('maturity') in {'M1', 'M2'}:
        for field in ('blueprint_id', 'authority_source'):
            if not isinstance(subject.get(field), str) or not subject[field].strip():
                errors.append('subject missing ' + field)
        if type(subject.get('blueprint_revision')) is not int or subject['blueprint_revision'] <= 0:
            errors.append('subject needs positive blueprint_revision')
        if not isinstance(subject.get('blueprint_sha256'), str) or not re.fullmatch('[a-f0-9]{64}', subject['blueprint_sha256']):
            errors.append('subject needs canonical blueprint_sha256')
    if ready and current_subject is None:
        errors.append('ready requires current Foundry session binding; supply --session SESSION')
    if current_subject is not None:
        for field in SUBJECT_FIELDS:
            if subject.get(field) != current_subject.get(field):
                errors.append('subject differs from current session: ' + field)
    tables = {}
    for kind in ['requirements', 'systems', 'rules', 'state_fields', 'capabilities', 'operations', 'recipes', 'artifacts', 'evidence', 'modules', 'assemblies']:
        rows = model.get(kind)
        if not isinstance(rows, list):
            errors.append(kind + ' must be list')
            rows = []
        table = {}
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not row['id'].strip():
                errors.append(kind + ' record needs nonempty id')
                continue
            if row['id'] in table:
                errors.append(kind + ': duplicate ' + row['id'])
            table[row['id']] = row
        tables[kind] = table
    if not tables['requirements']:
        errors.append('requirements cannot be empty')
    if not tables['modules']:
        errors.append('modules cannot be empty')

    def filled(row, names, label):
        for name in names:
            if not row.get(name):
                errors.append(label + ': missing ' + name)

    def refs(row, field, kind, label, required=False):
        ids = row.get(field, [])
        if not isinstance(ids, list) or any(not isinstance(x, str) for x in ids):
            errors.append(label + ': invalid ' + field)
            return []
        if required and not ids:
            errors.append(label + ': empty ' + field)
        for identifier in ids:
            if identifier not in tables[kind]:
                errors.append(label + ': missing reference ' + field + '/' + identifier)
        return ids

    def file_digest(relative, expected, label):
        if not isinstance(relative, str) or not relative or Path(relative).is_absolute() or '..' in Path(relative).parts:
            errors.append(label + ': unsafe path')
            return
        p = root / relative
        cursor = root
        for part in Path(relative).parts:
            cursor = cursor / part
            if cursor.is_symlink():
                errors.append(label + ': symlink is unsupported')
                return
        if not p.is_file():
            errors.append(label + ': missing file ' + relative)
        elif not isinstance(expected, str) or len(expected) != 64 or hashlib.sha256(p.read_bytes()).hexdigest() != expected:
            errors.append(label + ': digest mismatch ' + relative)

    for rid, r in tables['requirements'].items():
        filled(r, ['source', 'owner', 'acceptance', 'negative_case', 'due_gate'], rid)
        if r.get('applicability') not in {'applicable', 'not_applicable', 'pending'}:
            errors.append(rid + ': invalid applicability')
        if r.get('applicability') != 'applicable' and not r.get('rationale'):
            errors.append(rid + ': applicability needs rationale')
        if ready and r.get('applicability') == 'pending':
            errors.append(rid + ': pending applicability')
    for sid, s in tables['systems'].items():
        filled(s, ['purpose', 'owner', 'input_contract', 'output_contract', 'invariants'], sid)
        refs(s, 'depends_on', 'systems', sid)
    for rid, r in tables['rules'].items():
        filled(r, ['input_contract', 'steps', 'output_contract', 'oracle', 'failure_policy'], rid)
        refs(r, 'requirement_ids', 'requirements', rid, True)
        refs(r, 'state_ids', 'state_fields', rid)
    for fid, f in tables['state_fields'].items():
        filled(f, ['type', 'authority', 'persistence', 'consistency_group', 'migration', 'recovery_oracle'], fid)
    for cid, c in tables['capabilities'].items():
        filled(c, ['tool', 'operation', 'environment', 'status'], cid)
        refs(c, 'evidence_ids', 'evidence', cid)
        if c.get('status') not in {'candidate', 'descriptor_seen', 'configured', 'operation_tested', 'integrated'}:
            errors.append(cid + ': invalid capability status')
        if c.get('status') in {'operation_tested', 'integrated'}:
            witnesses = [tables['evidence'].get(x, {}) for x in c.get('evidence_ids', [])]
            allowed = {'integration', 'human', 'operational'} if c.get('status') == 'integrated' else {'operation', 'integration', 'human', 'operational'}
            if not any(x.get('result') == 'pass' and x.get('level') in allowed for x in witnesses):
                errors.append(cid + ': tested claim needs appropriate passing evidence')
    coverage = set()
    for oid, o in tables['operations'].items():
        filled(o, ['capability_id', 'recipe_id', 'consumer_id'], oid)
        coverage.update(refs(o, 'requirement_ids', 'requirements', oid, True))
        refs(o, 'output_ids', 'artifacts', oid, True)
        if o.get('capability_id') not in tables['capabilities']:
            errors.append(oid + ': missing capability')
        if o.get('recipe_id') not in tables['recipes']:
            errors.append(oid + ': missing recipe')
        bindings = o.get('parameter_bindings', [])
        if not isinstance(bindings, list):
            errors.append(oid + ': invalid parameter_bindings')
            bindings = []
        for b in bindings:
            if not isinstance(b, dict):
                errors.append(oid + ': invalid parameter binding')
                continue
            filled(b, ['requirement_id', 'field', 'status', 'consumption_check'], oid)
            if b.get('requirement_id') not in tables['requirements']:
                errors.append(oid + ': binding missing requirement')
            if b.get('status') not in {'supported_not_tested', 'consumed', 'unsupported', 'unknown'}:
                errors.append(oid + ': invalid binding status')
            if ready and b.get('status') != 'consumed':
                errors.append(oid + ': material parameter not consumed')
        if ready:
            c = tables['capabilities'].get(o.get('capability_id'), {})
            if c.get('status') not in {'operation_tested', 'integrated'}:
                errors.append(oid + ': operation not tested')
            proof_outputs = set()
            for eid in c.get('evidence_ids', []):
                e = tables['evidence'].get(eid, {})
                if e.get('result') == 'pass' and e.get('level') in {'operation', 'integration', 'human', 'operational'}:
                    proof_outputs.update(e.get('artifact_ids', []))
            if not set(o.get('output_ids', [])) <= proof_outputs:
                errors.append(oid + ': capability proof does not cover operation outputs')
            recipe = tables['recipes'].get(o.get('recipe_id'), {})
            if oid not in recipe.get('operation_ids', []) or not set(o.get('output_ids', [])) <= set(recipe.get('output_ids', [])) or recipe.get('consumer_id') != o.get('consumer_id'):
                errors.append(oid + ': recipe operation/output/consumer mismatch')
    for rid, r in tables['recipes'].items():
        filled(r, ['input_ids', 'output_ids', 'consumer_id', 'steps', 'validators', 'repair_policy'], rid)
        refs(r, 'operation_ids', 'operations', rid, True)
        refs(r, 'output_ids', 'artifacts', rid, True)
    for aid, a in tables['artifacts'].items():
        filled(a, ['path', 'owner', 'kind'], aid)
        if ready or a.get('sha256'):
            file_digest(a.get('path'), a.get('sha256'), aid)
    for eid, e in tables['evidence'].items():
        filled(e, ['observer', 'environment', 'method', 'scope', 'result'], eid)
        refs(e, 'artifact_ids', 'artifacts', eid, True)
        if e.get('level') not in LEVELS:
            errors.append(eid + ': invalid evidence level')
        if e.get('result') not in {'pass', 'fail', 'not_run', 'inconclusive'}:
            errors.append(eid + ': invalid evidence result')
        if e.get('independent') and any(tables['artifacts'].get(aid, {}).get('owner') == e.get('observer') for aid in e.get('artifact_ids', [])):
            errors.append(eid + ': author cannot be independent observer')
        subjects = e.get('subject_sha256', {})
        if not isinstance(subjects, dict):
            errors.append(eid + ': invalid subject digests')
            subjects = {}
        if e.get('result') == 'pass':
            for aid in e.get('artifact_ids', []):
                if not subjects.get(aid) or subjects.get(aid) != tables['artifacts'].get(aid, {}).get('sha256'):
                    errors.append(eid + ': stale or absent subject digest ' + aid)
    for mid, m in tables['modules'].items():
        filled(m, ['name', 'path'], mid)
        refs(m, 'requirement_ids', 'requirements', mid, True)
        if isinstance(m.get('path'), str):
            module = Path(m['path'])
            cursor = root
            link = False
            for part in module.parts:
                cursor = cursor / part
                link = link or cursor.is_symlink()
            if module.is_absolute() or '..' in module.parts or link or not (root / module / 'SKILL.md').is_file():
                errors.append(mid + ': module path must contain SKILL.md within root without symlinks')
        contracts = m.get('inherited_contracts', [])
        if not isinstance(contracts, list):
            errors.append(mid + ': invalid inherited_contracts')
            contracts = []
        present = set()
        for c in contracts:
            if not isinstance(c, dict):
                errors.append(mid + ': invalid inherited contract')
                continue
            present.add(c.get('kind'))
            file_digest(c.get('path'), c.get('sha256'), mid)
        if not KINDS <= present:
            errors.append(mid + ': missing inherited contract kinds ' + ','.join(sorted(KINDS - present)))
    for aid, a in tables['assemblies'].items():
        filled(a, ['consumer_id', 'scenario', 'expected_result'], aid)
        refs(a, 'artifact_ids', 'artifacts', aid, True)
        eids = refs(a, 'required_evidence_ids', 'evidence', aid, ready)
        if ready:
            for eid in eids:
                e = tables['evidence'].get(eid, {})
                if e.get('result') != 'pass' or e.get('level') not in {'integration', 'human', 'operational'}:
                    errors.append(aid + ': assembly needs passing integration/human/operational proof')
                if not set(a.get('artifact_ids', [])) <= set(e.get('artifact_ids', [])):
                    errors.append(aid + ': evidence does not cover exact assembly artifacts')
    if ready:
        if not tables['assemblies']:
            errors.append('ready requires consumer assembly')
        for rid, r in tables['requirements'].items():
            if r.get('applicability') == 'applicable' and rid not in coverage:
                errors.append(rid + ': no production operation')
    return errors


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('model', type=Path)
    p.add_argument('--root', type=Path, required=True, help='Exact unpacked generated-agent package root')
    p.add_argument('--session', type=Path, help='Current canonical Foundry session; defaults to --root when it is an initialized session')
    p.add_argument('--ready', action='store_true', help='Require current approved session binding, M2, actual outputs, parameter consumption and assembly witnesses')
    a = p.parse_args()
    current = None
    model_hash = None
    try:
        raw = a.model.read_bytes()
        model_hash = hashlib.sha256(raw).hexdigest()
        model = json.loads(raw)
        if a.ready or a.session is not None:
            current = read_current_subject(a.session or a.root)
        errors = validate(model, a.root, a.ready, current)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RuntimeError) as exc:
        errors = [str(exc)]
    print(json.dumps({'ok': not errors, 'quality_certified': False, 'gate': 'ready' if a.ready else 'plan', 'model_sha256': model_hash, 'current_subject': current, 'errors': errors}, ensure_ascii=False, indent=2))
    return bool(errors)


if __name__ == '__main__':
    raise SystemExit(main())
