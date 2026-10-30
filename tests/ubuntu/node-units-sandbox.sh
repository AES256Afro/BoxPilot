#!/bin/bash
# Every unit BoxPilot ships that starts node, started under its own sandbox on this machine's
# systemd: for each deploy/*.service whose ExecStart runs /usr/local/bin/node, a transient unit
# (systemd-run --wait --pipe --collect) gets that unit's [Service] sandbox directives, one -p each,
# and runs node -e 'process.exit(0)'. It must finish with result success. What the unit runs and
# where - ExecStart, Type, User, the environment, the directories, the paths, Restart, Timeout, the
# credentials, the standard streams - is left out: those name things only an installed BoxPilot has.
# Everything else in [Service] is the sandbox, and node has to start under it.
#
# boxpilot-libvirt-foundation.service failed at every start on 2026-10-22 with Result: core-dump:
# MemoryDenyWriteExecute=true refuses the mprotect(PROT_EXEC) that V8's JIT needs at start-up, so
# node trapped (status=5/TRAP, "Check failed: 12 == errno") before the script ran. Nothing had run
# node under that unit's directives before a host did. docs/reviews/2026-10-22-libvirt-foundation-
# core-dump.md has the triage; server/deployment.test.mjs refuses that one directive by name, and
# this test refuses whichever directive comes next.
#
#   sudo bash tests/ubuntu/node-units-sandbox.sh [/path/to/node-24]
#
# The node binary is the first argument, else /usr/local/bin/node, else the node on the PATH. It
# must live where ProtectHome= hides nothing, so not under /home or /root. BOXPILOT_UNIT_DIR selects
# the unit directory (default: deploy/ in this checkout), so a unit from another revision, or one
# written by hand, can be tried. On a failure it prints what systemd-run and node said, the unit's
# journal lines, and which of the directives break node on their own.
#
# It changes nothing on the machine: transient units only, and a scratch directory it removes. It
# needs root to start system units, and no npm dependencies.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root (systemd-run starts system units)" >&2; exit 2; }
command -v systemd-run >/dev/null 2>&1 || { echo "systemd-run is required" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UNIT_DIR="${BOXPILOT_UNIT_DIR:-${ROOT}/deploy}"
[ -d "$UNIT_DIR" ] || { echo "no unit directory at ${UNIT_DIR}" >&2; exit 2; }

NODE="${1:-}"
if [ -z "$NODE" ]; then
  if [ -x /usr/local/bin/node ]; then NODE=/usr/local/bin/node; else NODE="$(command -v node || true)"; fi
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "no node binary found: pass one as the first argument" >&2; exit 2; }
NODE="$(readlink -f "$NODE")"
case "$NODE" in
  /home/*|/root/*) echo "node at ${NODE} sits where ProtectHome= hides it: pass one outside /home and /root" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

printf 'systemd %s, node %s at %s, units from %s\n' "$(systemctl --version | head -n 1 | cut -d' ' -f2)" "$("$NODE" -p 'process.versions.node')" "$NODE" "$UNIT_DIR"

# The [Service] section as systemd reads it: no comments, no blank lines, a trailing backslash
# joining the next line.
service_lines() {
  awk '
    /^[[:space:]]*\[/ { in_service = ($0 ~ /^[[:space:]]*\[Service\][[:space:]]*$/); next }
    !in_service { next }
    /^[[:space:]]*[#;]/ { next }
    /^[[:space:]]*$/ { next }
    {
      line = $0
      while (line ~ /\\$/ && (getline continued) > 0) { sub(/\\$/, " ", line); line = line continued }
      print line
    }
  ' "$1"
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  printf '%s' "${value%"${value##*[![:space:]]}"}"
}

# The directives that say what runs and where, not how it is confined. Credentials, environment
# files and the directories name files and paths only an installed BoxPilot has; the standard
# streams are --pipe's.
sandbox_directive() {
  case "$1" in
    ExecStart*|ExecStop*|Type|User|Group|Environment*|WorkingDirectory|*Directory*) return 1 ;;
    ReadWritePaths|ReadOnlyPaths|InaccessiblePaths|BindPaths|BindReadOnlyPaths) return 1 ;;
    Restart*|Timeout*|Condition*|StandardInput|StandardOutput|StandardError|*Credential*) return 1 ;;
  esac
  return 0
}

# start_node <transient unit name> <output file> [-p Key=Value ...]: 0 when the unit finished with
# result success. Both systemd-run's own lines and node's stderr land in the output file (--pipe).
start_node() {
  local unit="$1" out="$2"
  shift 2
  systemd-run --wait --pipe --collect --unit="$unit" "$@" "$NODE" -e 'process.exit(0)' >"$out" 2>&1
  local rc=$?
  # systemd 255 says "Finished with result: core-dump"; older ones "Finished with result 'core-dump'."
  local result
  result="$(sed -n "s/.*Finished with result[^a-z]*\([a-z-]*\).*/\1/p" "$out" | head -n 1)"
  [ -n "$result" ] || result="not started"
  printf '%s' "$result" >"${out}.result"
  [ "$rc" -eq 0 ] && [ "$result" = success ]
}

# A transient unit with no directive at all first: if node does not start even there, this machine's
# systemd (its bus, its journal) is the problem, and no directive is to blame.
if ! start_node "boxpilot-node-sandbox-$$-plain.service" "${WORK}/plain"; then
  echo "systemd-run cannot start node in a plain transient unit here (result: $(cat "${WORK}/plain.result")):" >&2
  sed 's/^/    /' "${WORK}/plain" >&2
  exit 2
fi

status=0
count=0
for unit_file in "$UNIT_DIR"/*.service; do
  [ -e "$unit_file" ] || continue
  grep -Eq '^ExecStart=[-@:+!]*/usr/local/bin/node([[:space:]]|$)' "$unit_file" || continue
  count=$((count + 1))
  name="$(basename "$unit_file")"
  stem="$(printf '%s' "${name%.service}" | tr -c 'A-Za-z0-9-' '-')"
  out="${WORK}/${count}"
  service_lines "$unit_file" >"${out}.service"
  props=()
  while IFS= read -r line; do
    key="$(trim "${line%%=*}")"
    [ -n "$key" ] || continue
    sandbox_directive "$key" || continue
    props+=(-p "${key}=$(trim "${line#*=}")")
  done <"${out}.service"
  directives=$(( ${#props[@]} / 2 ))

  transient="boxpilot-node-sandbox-$$-${count}-${stem}.service"
  if start_node "$transient" "$out" ${props[@]+"${props[@]}"}; then
    printf '%-44s %s (%d directives)\n' "$name" "$(cat "${out}.result")" "$directives"
    continue
  fi

  status=1
  printf '%-44s %s (%d directives): node did not start under this sandbox\n' "$name" "$(cat "${out}.result")" "$directives"
  echo "  directives:"
  for ((i = 1; i < ${#props[@]}; i += 2)); do echo "    ${props[i]}"; done
  echo "  systemd-run and node said:"
  sed 's/^/    /' "$out"
  echo "  journal of ${transient}:"
  journalctl --sync >/dev/null 2>&1 || true
  journalctl --no-pager -q -o short-precise -u "$transient" 2>&1 | sed 's/^/    /'
  # Which directives break node by themselves, so the failure names its cause when one does.
  alone=()
  for ((i = 1; i < ${#props[@]}; i += 2)); do
    start_node "boxpilot-node-sandbox-$$-${count}-${stem}-$((i / 2)).service" "${out}-alone" -p "${props[i]}" || alone+=("${props[i]}")
  done
  if [ "${#alone[@]}" -gt 0 ]; then
    echo "  on its own, each of these stops node from starting:"
    printf '    %s\n' "${alone[@]}"
  else
    echo "  no single directive stops node on its own: the combination does"
  fi
done

[ "$count" -gt 0 ] || { echo "no unit under ${UNIT_DIR} runs /usr/local/bin/node" >&2; exit 2; }
if [ "$status" -eq 0 ]; then
  echo "node starts under the sandbox of every one of the ${count} node units"
else
  echo "FAILED: a node unit's sandbox stops node before its script runs" >&2
fi
exit "$status"
