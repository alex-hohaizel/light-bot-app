#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || "$(uname -s)-$(uname -m)" != Linux-x86_64 ]]; then
  echo 'Run on Linux x64 with a path to the sealed candidate.' >&2
  exit 1
fi
node_bin=$(command -v node)
[[ "$(id -u)" != 0 ]]
pg_bin=/usr/lib/postgresql/16/bin
if [[ ! -x "$pg_bin/initdb" ]]; then
  pg_bin=$(pg_config --bindir)
fi
for tool in initdb pg_ctl createdb psql; do
  [[ -x "$pg_bin/$tool" ]]
done
for tool in sudo unshare runuser ip openssl timeout; do
  command -v "$tool" >/dev/null
done

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
candidate=$(cd -- "$1" && pwd -P)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/lba-linux-preflight.XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
mkdir -m 700 "$scratch/home" "$scratch/tmp"
clean=(env -i "PATH=$(dirname -- "$node_bin"):/usr/sbin:/usr/bin:/sbin:/bin" "HOME=$scratch/home" "TMPDIR=$scratch/tmp")
: > "$scratch/npm-user-config"
: > "$scratch/npm-global-config"
npm_env=("${clean[@]}" "NPM_CONFIG_USERCONFIG=$scratch/npm-user-config" "NPM_CONFIG_GLOBALCONFIG=$scratch/npm-global-config")
[[ "$("${clean[@]}" "$node_bin" --version)" == v20.20.0 && "$("${npm_env[@]}" npm --version)" == 10.8.2 ]]
probe="$script_dir/light-bot-linux-preflight.mjs"

# Copy only manifest-verified files and the named release checks.
"${clean[@]}" "$node_bin" "$probe" prepare "$candidate" "$scratch"
(
  cd "$scratch/app"
  "${npm_env[@]}" npm ci --include=dev --include=optional --ignore-scripts=false --no-audit --no-fund
)

# No external interfaces or routes in the runtime phase. Root configures the
# namespace only. The application, test code, and database run as the caller.
sudo -n unshare --net /bin/bash -c '
  set -euo pipefail
  ip link set lo up
  [[ "$(ip -o link show | wc -l)" == 1 && -z "$(ip route show)" ]]
  user=$1
  shift
  exec runuser -u "$user" -- "$@"
' bash "$(id -un)" "${clean[@]}" /bin/bash "$script_dir/light-bot-linux-runtime.sh" "$scratch" "$node_bin" "$pg_bin" "$probe"
