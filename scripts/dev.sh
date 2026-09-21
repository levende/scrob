#!/usr/bin/env bash
#
# dev.sh — run the Scrob dev stack (backend + frontend) with hot reload,
# against an EXTERNAL / cloud PostgreSQL (e.g. Neon). No local DB container,
# no changes to the app code.
#
# Usage:
#   ./dev.sh                        # install deps, run migrations, start both
#   ./dev.sh diag                   # show max_connections + who is connected
#   ./dev.sh kill-idle              # drop idle connections (once DB is reachable)
#   SKIP_MIGRATIONS=1 ./dev.sh      # skip alembic upgrade head
#
# Cloud Postgres notes:
#   - Neon rejects non-SSL connections. asyncpg's SQLAlchemy dialect can't
#     take `?sslmode=require` from the URL, but it DOES accept `?ssl=require` —
#     so use that in DATABASE_URL for SSL-required hosts.
#   - Use the DIRECT endpoint (no "-pooler" in the host): that one is
#     transaction-mode PgBouncer and breaks prepared statements/migrations.
#   - channel_binding=require is not supported by asyncpg — leave it out.
#   - Connection pool (SQLAlchemy) is tunable via env vars, critical on hosts
#     with a low max_connections and NO server-side pooling (e.g. Aiven free
#     tier: max_connections=20, no pooling). The app's default ceiling of 30
#     connections (DB_POOL_SIZE 20 + DB_MAX_OVERFLOW 10) exhausts that limit.
#     Defaults: DB_POOL_SIZE=20 (min 1), DB_MAX_OVERFLOW=10 (min 0),
#     DB_POOL_TIMEOUT=30, DB_POOL_RECYCLE=1800, DB_POOL_PRE_PING=true.
#     Recommended for Aiven free: DB_POOL_SIZE=10, DB_MAX_OVERFLOW=5.
#
set -euo pipefail

# Resolve to project root (one level up from this script's directory)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

# ── colours ──────────────────────────────────────────────────────────────────
C_RESET=$'\033[0m'
C_BOLD=$'\033[1m'
C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'
C_RED=$'\033[31m'
C_CYAN=$'\033[36m'
C_DIM=$'\033[2m'

info()  { printf '%s%s==>%s %s\n' "$C_CYAN" "$C_BOLD" "$C_RESET" "$*"; }
ok()    { printf '%s%s✔%s %s\n' "$C_GREEN" "$C_BOLD" "$C_RESET" "$*"; }
warn()  { printf '%s%s!%s %s\n' "$C_YELLOW" "$C_BOLD" "$C_RESET" "$*"; }
die()   { printf '%s%s✖%s %s\n' "$C_RED" "$C_BOLD" "$C_RESET" "$*" >&2; exit 1; }

# ── tool availability ────────────────────────────────────────────────────────
command -v uv  >/dev/null 2>&1 || die "uv is not installed. Install it: https://docs.astral.sh/uv/"
command -v npm >/dev/null 2>&1 || die "npm is not installed. Install Node.js 22+."

# ── 1. ensure .env exists ────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  cp "$ROOT/.env.example" "$ENV_FILE"
  warn "Created .env from .env.example"
  warn "  -> Edit $ENV_FILE and set your cloud DB before running again."
fi

# ── 2. load .env into the environment ───────────────────────────────────────
# Never `source` .env directly — its values aren't shell-quoted, so a `#`,
# space, `$` or `:` in a value would truncate or break the line, and a
# YAML-style `KEY: value` would be executed as a command. Only real
# `KEY=VALUE` assignments are parsed and exported.
load_env() {
  local file="$1" line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"   # trim leading whitespace
    [[ -z "$line" ]] && continue
    [[ "$line" == \#* ]] && continue
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*:[[:space:]] ]]; then
      warn "YAML-style line in .env (use 'KEY=VALUE' not 'KEY: value'): ${line%%:*}"
      continue
    fi
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      if [[ "$value" =~ ^\"(.*)\"$ ]]; then
        value="${BASH_REMATCH[1]}"
      elif [[ "$value" =~ ^\'(.*)\'$ ]]; then
        value="${BASH_REMATCH[1]}"
      fi
      value="${value%% \#*}"   # strip inline comment (space + #)
      export "$key=$value"
    fi
  done < "$file"
}

load_env "$ENV_FILE"

# ── 3. validate database config ─────────────────────────────────────────────
if [ -z "${DATABASE_URL:-}" ] && [ -z "${POSTGRES_HOST:-}" ]; then
  die "No database configured. In $ENV_FILE set either:
      DATABASE_URL=postgresql+asyncpg://user:pass@YOUR_CLOUD_HOST/dbname?ssl=require
    or the POSTGRES_HOST / POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB fields."
fi

# Resolve the effective host for display (so you can confirm it's the cloud DB).
if [ -n "${DATABASE_URL:-}" ]; then
  DB_HOST="$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-zA-Z+]+://[^@]*@([^:/]+).*#\1#')"
  if [ "$DB_HOST" = "$DATABASE_URL" ]; then
    DB_HOST="$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-zA-Z+]+://([^:/]+).*#\1#')"
  fi
else
  DB_HOST="${POSTGRES_HOST}"
fi

ok "Using PostgreSQL at ${C_BOLD}${DB_HOST}${C_RESET}"
if [ "$DB_HOST" = "localhost" ] || [ "$DB_HOST" = "127.0.0.1" ]; then
  warn "Host is localhost — make sure you set it to your cloud DB host, otherwise the backend won't connect."
fi

# ── Diagnostic: who is holding connections ─────────────────────────────────
# ./dev.sh diag — connects and lists max_connections + a pg_stat_activity
# summary so you can spot a rogue instance holding connections open.
# If max_connections is low (e.g. 20 on Aiven free), lower DB_POOL_SIZE /
# DB_MAX_OVERFLOW in .env so the app's pool stays under the limit.
if [ "${1:-}" = "diag" ]; then
  cd "$ROOT/backend"
  [ -d .venv ] || uv sync
  info "Querying pg_stat_activity + max_connections…"
  uv run python - <<'PY'
import asyncio
import os

import asyncpg


async def main() -> None:
    dsn = os.environ.get("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    if not dsn:
        print("DATABASE_URL is not set — check .env")
        return
    try:
        conn = await asyncpg.connect(dsn, timeout=8)
    except Exception as exc:
        print("CONNECT FAILED:", type(exc).__name__, str(exc)[:300])
        print("The DB is full or unreachable — restart the managed service to free connections.")
        return
    try:
        print("max_connections:", await conn.fetchval("SHOW max_connections"))
        print("total active rows:", await conn.fetchval("SELECT count(*) FROM pg_stat_activity"))
        rows = await conn.fetch(
            "SELECT usename, application_name, coalesce(client_addr::text,'local') AS client, "
            "state, count(*) AS n "
            "FROM pg_stat_activity GROUP BY usename, application_name, client_addr, state "
            "ORDER BY n DESC"
        )
        for row in rows:
            print(" ", dict(row))
    finally:
        await conn.close()


asyncio.run(main())
PY
  exit 0
fi

# ── Terminate idle connections ───────────────────────────────────────────────
# ./dev.sh kill-idle — frees slots held by idle/pooled connections without a
# service restart. Needs a free slot to run, so use it while the DB is up.
if [ "${1:-}" = "kill-idle" ]; then
  cd "$ROOT/backend"
  [ -d .venv ] || uv sync
  info "Terminating idle connections older than 1 minute…"
  uv run python - <<'PY'
import asyncio
import os

import asyncpg


async def main() -> None:
    dsn = os.environ.get("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    if not dsn:
        print("DATABASE_URL is not set — check .env")
        return
    try:
        conn = await asyncpg.connect(dsn, timeout=8)
    except Exception as exc:
        print("CONNECT FAILED:", type(exc).__name__, str(exc)[:300])
        print("The DB is full or unreachable — restart the managed service first.")
        return
    try:
        killed = await conn.fetchval(
            "SELECT count(*) FROM ("
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE state = 'idle' "
            "  AND state_change < now() - interval '1 minute' "
            "  AND pid <> pg_backend_pid()"
            ") t WHERE pg_terminate_backend"
        )
        print(f"Terminated {killed} idle connection(s).")
        print("Still active:", await conn.fetchval("SELECT count(*) FROM pg_stat_activity"))
    finally:
        await conn.close()


asyncio.run(main())
PY
  exit 0
fi

BACKEND_PORT="${BACKEND_PORT:-7331}"
FRONTEND_PORT="${FRONTEND_PORT:-7330}"

# ── 4. backend deps + migrations ─────────────────────────────────────────────
cd "$ROOT/backend"

info "Installing backend dependencies (uv sync)…"
uv sync

if [ "${SKIP_MIGRATIONS:-0}" != "1" ]; then
  info "Running database migrations (alembic upgrade heads)…"
  # NOTE: `heads` (plural) on purpose — not `head`. After a merge without a
  # merge-migration the repo can temporarily have 2+ Alembic heads; then
  # `upgrade head` fails with "Multiple head revisions are present" while
  # `upgrade heads` still applies all branches. With a single head both are equal.
  if ! uv run alembic upgrade heads; then
    warn "Migration failed. If the error is 'Multiple head revisions are present',"
    warn "  add a merge migration: cd backend && uv run alembic merge -m \"merge heads\" <rev1> <rev2>"
    warn "  (list heads via: cd backend && uv run alembic heads)."
    exit 1
  fi
  ok "Migrations applied."
else
  warn "Skipping migrations (SKIP_MIGRATIONS=1)."
fi

# ── 5. frontend deps ─────────────────────────────────────────────────────────
cd "$ROOT/frontend"
if [ ! -d node_modules ]; then
  info "Installing frontend dependencies (npm install)…"
  npm install
fi

# ── 6. start both with hot reload ────────────────────────────────────────────
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  [ -n "$BACKEND_PID" ]  && kill "$BACKEND_PID"  2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
}
trap 'exit 130' INT TERM
trap cleanup EXIT

cd "$ROOT/backend"
info "Starting backend (uvicorn --reload) on :$BACKEND_PORT"
uv run uvicorn main:app --reload --port "$BACKEND_PORT" &
BACKEND_PID=$!

cd "$ROOT/frontend"
info "Starting frontend (astro dev) on :$FRONTEND_PORT"
BACKEND_PORT="$BACKEND_PORT" npm run dev -- --host --port "$FRONTEND_PORT" &
FRONTEND_PID=$!

printf '\n%s─────────────────────────────────────────────────%s\n' "$C_DIM" "$C_RESET"
printf '%s  Frontend : %shttp://localhost:%s%s\n' "$C_BOLD" "$C_GREEN" "$FRONTEND_PORT" "$C_RESET"
printf '%s  Backend  : %shttp://localhost:%s%s  (API docs at /docs)\n' "$C_BOLD" "$C_GREEN" "$BACKEND_PORT" "$C_RESET"
printf '%s  Press Ctrl+C to stop both.%s\n' "$C_DIM" "$C_RESET"
printf '%s─────────────────────────────────────────────────%s\n' "$C_DIM" "$C_RESET"

wait
