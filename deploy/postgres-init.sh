#!/bin/sh
set -eu
# Password is restricted to generated hex, preventing shell/SQL interpolation.
case "$DJ_RUNTIME_PASSWORD" in *[!a-f0-9]*|'') echo "Invalid runtime secret format" >&2; exit 1;; esac
[ "${#DJ_RUNTIME_PASSWORD}" -ge 64 ] || exit 1
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE dingjiang_runtime LOGIN PASSWORD '$DJ_RUNTIME_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE dingjiang FROM PUBLIC;
GRANT CONNECT ON DATABASE dingjiang TO dingjiang_runtime;
GRANT USAGE ON SCHEMA public TO dingjiang_runtime;
SQL
