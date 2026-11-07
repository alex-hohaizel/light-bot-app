# Local validation records

Copy the templates into the project-owned state directory. Replace placeholders from actual observations. Keep private addresses and credentials outside these records. Use this helper to check already recorded information and file digests before a handoff. An accepted JSON record proves consistency of the record. When both inputs are supplied they must name the same project. A registry failure also clears the checkpoint’s recorded continuation signal. External observation and the user's authorization require their own evidence.

```bash
python3 scripts/lba_audit.py --root /absolute/project \
  --registry docs/light-bot-app/source-registry.json \
  --checkpoint docs/light-bot-app/checkpoint.json --format markdown
```

Use `--at 2030-01-01T12:00:00+02:00` for a synthetic repeatable test. Normal use checks current time. Exit 0 means recorded fields and referenced bytes passed. Exit 2 means rejected input or unresolved recorded conditions. The helper performs no network requests, writes, delivery, migration, deployment or permission changes.

## Source registry

Format `lba-source-registry/1` has `project_id` and a `sources` array with unique IDs. Each source supplies the fields shown in the template. A candidate or blocked record can preserve a missing/unavailable/conflicting source but its `notifications_enabled` must be false. A catalog row alone provides no active schedule capability.

For `status=active` additionally provide aware ISO `observed_at` and `valid_until`, a `service_date` of today or tomorrow in `Europe/Kyiv`, `terms_review=allowed` and `schedule_state` of `scheduled`, `explicit_none`, `possible` or `emergency`. The validity window is an explicit project choice. Use a short scope-specific window backed by the operator's update behavior. The helper rejects expired windows and future observation times.

Every evidence object has these fields.

| Field | Value |
| --- | --- |
| `id` | Unique within the source's evidence array. |
| `operator_id`, `territory`, `service_date`, `source_revision` | Exact match with that source. |
| `level` | `source` or `integration`. |
| `outcome` | `pass`, `fail` or `inconclusive`. |
| `path`, `sha256` | Relative regular local file and its actual SHA-256. |
| `checked_at`, `expires_at` | Aware ISO timestamps establishing current recorded scope. |

An active row requires a current passing `source` witness. Declared personal notifications additionally require `capability=address`, `address_binding=verified` and a current passing `integration` witness. Human review must determine whether the file actually supports that claim. A field called `pass` creates no factual verification. Each outgoing operation uses the current delivery grant and subscription check in its own runtime.

## Checkpoint

Format `lba-checkpoint/1` records project, task, phase P0–P6, status `ready`, `blocked`, `paused` or `completed`, confirmed repository URL/branch/full commit SHA, `next_step`, `authorities` and `actions`. The template intentionally fails until the repository identity is supplied. This prevents a placeholder from looking like a verified checkout.

Each action is `{id, kind, target, outcome, authority_id}`. Kinds are `read`, `local_build`, `send`, `deploy`, `migrate`, `webhook`, `export`, `stop` or `reconcile`. Outcomes are `not_started`, `success`, `failed` or `unknown`. Completed external attempts also supply an aware `performed_at` timestamp. Expiry is checked at action time for completed attempts and at the current time for new attempts. Unknown outcome blocks recorded continuation until external state has been reconciled and the resulting evidence recorded. The original attempt history remains in the project log.

For `send`, `deploy`, `migrate`, `webhook` and `export`, a referenced authority record must exist with exact `{id, kind, target, source, expires_at}`. `source` identifies the actual user instruction or approved operation record. Match the target narrowly. The helper checks recorded correspondence and expiry, while the executor verifies the source and its scope before any action. Never make an approval merely to satisfy the validator.

The output's `recorded_resume_ready` is true only when a checkpoint declares `ready` and its records pass. It is a local consistency signal. Independently recheck host access, input revisions, effect status and current authority before starting work.
