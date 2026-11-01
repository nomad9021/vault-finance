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
# The shared folder is writable by the container, so this script never opens
# a path there that the container could have planted (a symlink to one of your
# files, say): its lock and working log live in a private folder, files it
# publishes are written to a fresh mktemp name and renamed into place — a
# rename replaces a planted link instead of following it — and the folder is
# sticky, so the container can't swap that temp file for a link mid-write.
#
# Wrapped in main() so `git pull` rewriting this file mid-run is harmless.
set -uo pipefail

main() {
  local script_dir repo_dir dir private req log lock target started port
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
  repo_dir="$(cd -- "$script_dir/../.." &>/dev/null && pwd)"
  dir="${VAULT_UPDATE_DIR:?VAULT_UPDATE_DIR is set by vault-update.service}"
  private="${XDG_STATE_HOME:-$HOME/.local/state}/vault-finance-update"
  mkdir -p "$private" && chmod 700 "$private" || return 1
  # Sticky: the container (group member, not owner) can't remove or swap the
  # files this agent creates here, so nothing it publishes can be raced into
  # a symlink. Folders set up before this was added get the bit now.
  [ -k "$dir" ] || chmod +t "$dir" || return 1
  req="$dir/request.json"
  log="$private/last-update.log"
  lock="$private/agent.lock"

  [ -f "$req" ] && [ ! -L "$req" ] || { rm -f "$req"; return 0; }
  exec 9>"$lock"
  flock -n 9 || return 0

  # Take the request out of the shared folder first (rename doesn't follow
  # links), then read it only if what we took is a plain file — so nothing
  # swapped in after the check above is ever opened.
  local taken="$private/request.json"
  mv -fT "$req" "$taken" 2>/dev/null || return 0
  if [ -L "$taken" ] || [ ! -f "$taken" ]; then rm -f "$taken"; return 0; fi
  # Only digits and dots survive; the version is just echoed back to the app.
  target="$(head -c 4096 "$taken" | grep -o '"targetVersion":"[0-9.]*"' | head -1 | grep -o '[0-9][0-9.]*' || true)"
  rm -f "$taken"
  started="$(date -u +%FT%TZ)"
  write_status "$dir" running "Downloading and installing the update…" "$target" "$started" ""

  port="$(grep -E '^VAULT_PORT=' "$repo_dir/docker/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -dc '0-9')"
  port="${port:-8443}"

  {
    echo "== $(date -u +%FT%TZ) update requested from the app (target ${target:-latest})"
    bash "$repo_dir/installers/server/update-server.sh"
  } >"$log" 2>&1
  local rc=$?

  publish "$dir" last-update.log 644 <"$log"

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
  publish "$dir" last-update.log 644 <"$log"
  write_status "$dir" succeeded "Updated to $version." "$target" "$started" "$(date -u +%FT%TZ)"
}

# Last meaningful log line, made safe to embed in JSON.
last_line() {
  grep -v '^[[:space:]]*$' "$1" | tail -1 | tr -d '\000-\037"\\' | cut -c1-300
}

json_or_null() { if [ -n "$1" ]; then printf '"%s"' "$1"; else printf 'null'; fi; }

# publish DIR NAME MODE < content — write stdin to DIR/NAME without following
# anything planted there: mktemp creates a brand-new file (O_EXCL), and the
# rename swaps it in for whatever NAME was, link or not.
publish() {
  local tmp
  tmp="$(mktemp "$1/.agent.XXXXXXXX")" || return 1
  cat >"$tmp" && chmod "$3" "$tmp" && mv -fT "$tmp" "$1/$2" || { rm -f "$tmp"; return 1; }
}

# write_status DIR STATE MESSAGE TARGET STARTED FINISHED — atomic replace.
write_status() {
  printf '{"state":"%s","message":"%s","targetVersion":%s,"startedAt":%s,"finishedAt":%s}\n' \
    "$2" "$3" "$(json_or_null "$4")" "$(json_or_null "$5")" "$(json_or_null "$6")" \
    | publish "$1" status.json 644
}

main "$@"; exit $?
