#!/bin/bash
set -u
TASK_DIRECTORY="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TASK_NODE="/opt/homebrew/bin/node"
TASK_STATUS=0
if [ ! -x "$TASK_NODE" ]; then TASK_NODE="$(command -v node || true)"; fi
if [ -z "$TASK_NODE" ]; then
  echo 'Не знайдено Node. Повідомте Codex код BOOTSTRAP_NODE_UNAVAILABLE.'
  TASK_STATUS=1
else
  "$TASK_NODE" --experimental-strip-types "$TASK_DIRECTORY/local-runtime/production-bootstrap.mjs" "$@" || TASK_STATUS=$?
fi
echo 'Натисніть Return, щоб закрити вікно.'
read -r TASK_CLOSE
exit "$TASK_STATUS"
