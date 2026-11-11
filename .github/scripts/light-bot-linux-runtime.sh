#!/usr/bin/env bash
set -euo pipefail
scratch=$1
node_bin=$2
pg_bin=$3
probe=$4
cd "$scratch"
[[ "$(id -u)" != 0 ]]
[[ "$(ip -o link show | wc -l)" == 1 && -z "$(ip route show)" ]]

"$node_bin" release-tools/launch.cjs --verify
"$node_bin" release-tools/runtime-preflight.cjs
"$node_bin" release-tools/undici-cache-probe.cjs
cp -- "$probe" app/dist-production/.lba-linux-preflight.mjs
"$node_bin" app/dist-production/.lba-linux-preflight.mjs native "$scratch"

# The trust authentication is scoped to a throwaway instance with no sockets
# outside this new network namespace. No input URL or password is accepted.
db_port=55493
"$pg_bin/initdb" -D "$scratch/db" -A trust -U lba_ci --no-locale --encoding=UTF8 > "$scratch/initdb.log"
trap '"$pg_bin/pg_ctl" -D "$scratch/db" -m fast -w stop >/dev/null 2>&1 || true' EXIT
"$pg_bin/pg_ctl" -D "$scratch/db" -l "$scratch/postgres.log" \
  -o "-h 127.0.0.1 -k '' -p $db_port -c fsync=off" -t 15 -w start >/dev/null
"$pg_bin/createdb" -h 127.0.0.1 -p "$db_port" -U lba_ci lba_preflight
target=$("$pg_bin/psql" -XAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$db_port" -U lba_ci -d lba_preflight \
  -c "select current_database() || '/' || host(inet_server_addr()) || '/' || inet_server_port()")
[[ "$target" == 'lba_preflight/127.0.0.1/55493' ]]
"$pg_bin/psql" -Xq -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$db_port" -U lba_ci -d lba_preflight \
  -c 'create table sessions (sid varchar primary key, sess json not null, expire timestamp(6) not null)'
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext 'subjectAltName=IP:127.0.0.1' -keyout "$scratch/oidc.key" -out "$scratch/oidc.pem" >/dev/null 2>&1
timeout 35s "$node_bin" app/dist-production/.lba-linux-preflight.mjs startup "$scratch"
