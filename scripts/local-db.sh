#!/usr/bin/env bash
# Starts (or stops) a throwaway local Postgres for the tests. Needs the Postgres server binaries.
#   scripts/local-db.sh start   -> postgres://postgres@127.0.0.1:54329/postgres (trust auth)
#   scripts/local-db.sh stop
# The tests create and drop their own database on it (see tests/helpers.ts).
set -euo pipefail

PORT="${PGTEST_PORT:-54329}"
DIR="${PGTEST_DIR:-/var/lib/postgresql/reminderbot-test}"
BIN="$(dirname "$(ls -d /usr/lib/postgresql/*/bin/postgres | sort -V | tail -1)")"

as_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

case "${1:-start}" in
  start)
    if [ ! -f "$DIR/PG_VERSION" ]; then
      mkdir -p "$DIR"
      [ "$(id -u)" = "0" ] && chown postgres:postgres "$DIR"
      as_pg "$BIN/initdb" -D "$DIR" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
    fi
    if ! as_pg "$BIN/pg_ctl" -D "$DIR" status >/dev/null 2>&1; then
      as_pg "$BIN/pg_ctl" -D "$DIR" -l "$DIR/server.log" -w \
        -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1 -c timezone=UTC" start >/dev/null
    fi
    # Roles that exist on every Supabase project.
    psql -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -qtA -v ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
SQL
    echo "postgres://postgres@127.0.0.1:$PORT/postgres"
    ;;
  stop)
    as_pg "$BIN/pg_ctl" -D "$DIR" -m fast stop
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
