#!/usr/bin/env bash
#
# Vault Finance — host update agent. Runs an update the owner started from
# the app's Settings → Server update. Not meant to be run by hand: the
# vault-update.path systemd unit starts it when the server drops
# request.json into the shared folder (set up by enable-app-updates.sh).
#
# The server container has no Docker access; this script is the only thing
# that acts on a request, and it only ever does one thing: run
# update-server.sh (latest release). Nothing in the request is executed.
#
# Wrapped in main() so `git pull` rewriting this file mid-run is harmless.
set -uo pipefail

main() {
  local script_dir repo_dir dir req log lock target started port
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
  repo_dir="$(cd -- "$script_dir/../.." &>/dev/null && pwd)"
  dir="${VAULT_UPDATE_DIR:?VAULT_UPDATE_DIR is set by vault-update.service}"
  req="$dir/request.json"
  log="$dir/last-update.log"
  lock="$dir/.agent.lock"

  [ -e "$req" ] || return 0
  exec 9>"$lock"
  flock -n 9 || return 0

  # Only digits and dots survive; the version is just echoed back to the app.
  target="$(grep -o '"targetVersion":"[0-9.]*"' "$req" 2>/dev/null | head -1 | grep -o '[0-9][0-9.]*' || true)"
  rm -f "$req"
  started="$(date -u +%FT%TZ)"
  write_status "$dir" running "Downloading and installing the update…" "$target" "$started" ""

  port="$(grep -E '^VAULT_PORT=' "$repo_dir/docker/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -dc '0-9')"
  port="${port:-8443}"

  {
    echo "== $(date -u +%FT%TZ) update requested from the app (target ${target:-latest})"
    bash "$repo_dir/installers/server/update-server.sh"
  } >"$log" 2>&1
  local rc=$?

  if [ "$rc" -ne 0 ]; then
    write_status "$dir" failed "The update failed: $(last_line "$log" | sed 's/[.]*$//'). Your server is still running the old version. Details: last-update.log in the server's data folder." "$target" "$started" "$(date -u +%FT%TZ)"
    return 1
  fi

  # Migrations run on boot; wait for the new server to answer.
  local version="" i
  for i in $(seq 1 60); do
    version="$(curl -fsk --max-time 3 "https://127.0.0.1:$port/api/v1/version" 2>/dev/null \
      | grep -o '"apiVersion":"[0-9.]*"' | grep -o '[0-9][0-9.]*' || true)"
    [ -n "$version" ] && break
    sleep 3
  done
  if [ -z "$version" ]; then
    write_status "$dir" failed "The new version was installed but the server hasn't come back up. On the server, check: docker compose -f docker/docker-compose.yml logs server" "$target" "$started" "$(date -u +%FT%TZ)"
    return 1
  fi
  echo "== server is up on $version" >>"$log"
  write_status "$dir" succeeded "Updated to $version." "$target" "$started" "$(date -u +%FT%TZ)"
}

# Last meaningful log line, made safe to embed in JSON.
last_line() {
  grep -v '^[[:space:]]*$' "$1" | tail -1 | tr -d '\000-\037"\\' | cut -c1-300
}

json_or_null() { if [ -n "$1" ]; then printf '"%s"' "$1"; else printf 'null'; fi; }

# write_status DIR STATE MESSAGE TARGET STARTED FINISHED — atomic replace.
write_status() {
  local tmp="$1/.status.json.tmp"
  printf '{"state":"%s","message":"%s","targetVersion":%s,"startedAt":%s,"finishedAt":%s}\n' \
    "$2" "$3" "$(json_or_null "$4")" "$(json_or_null "$5")" "$(json_or_null "$6")" >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$1/status.json"
}

main "$@"; exit $?
