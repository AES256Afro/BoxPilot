#!/usr/bin/env bash
# Unsloth headless spike for M37: can `unsloth run` serve a small Qwen 3.5 with vision, headless on
# CPU, under a hard cap of 0.5-1 CPU, and idle near 0%? Findings: docs/spikes/2026-09-unsloth-headless.md.
#
# Runs on a throwaway Ubuntu runner (GitHub Actions, .github/workflows/unsloth-spike.yml) with
# Docker, sudo, jq and Node 24. It builds a slim image with Unsloth's own installer, runs the server
# in capped containers, and reads CPU and memory from each container's cgroup. Spike code, not
# product code: nothing in BoxPilot calls it.
#
#   tests/spikes/unsloth-headless.sh <step>
#   steps: build models perf capability lifecycle embeddings official
#
# Every measurement is one JSON line in $SPIKE_OUT/results.jsonl; logs land in $SPIKE_OUT/logs.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROBE="$HERE/unsloth-probe.mjs"
TMP_ROOT="${RUNNER_TEMP:-/tmp}"
OUT="${SPIKE_OUT:-$TMP_ROOT/unsloth-spike}"
HF_DIR="${SPIKE_HF_DIR:-$TMP_ROOT/hf}"
VENV="${SPIKE_VENV:-$TMP_ROOT/spike-venv}"
IMAGE="${SPIKE_IMAGE:-boxpilot-unsloth-slim:spike}"
MODEL="${SPIKE_MODEL:-unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL}"
EMBED_MODEL="${SPIKE_EMBED_MODEL:-Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0}"
MEM="${SPIKE_MEM:-6g}"
CTX="${SPIKE_CTX:-8192}"
PORT=18888
RESULTS="$OUT/results.jsonl"
NODE_BIN="$(command -v node)"
mkdir -p "$OUT/logs" "$HF_DIR"

CPU_MODEL="$(awk -F': ' '/model name/{print $2; exit}' /proc/cpuinfo 2>/dev/null || echo unknown)"
HOST_CPUS="$(nproc)"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# record <section> [base-json] key=value... -- appends one JSON line; numeric strings stay numbers.
record() {
  local section="$1" json kv k v
  shift
  json="$(jq -nc --arg section "$section" --arg cpu "$CPU_MODEL" --argjson host_cpus "$HOST_CPUS" '{section:$section, host_cpu:$cpu, host_cpus:$host_cpus}')"
  if [ $# -gt 0 ] && [ "${1:0:1}" = "{" ]; then
    json="$(jq -c --argjson extra "$1" '. + $extra' <<<"$json" 2>/dev/null || echo "$json")"
    shift
  fi
  for kv in "$@"; do
    case "$kv" in *=*) ;; *) continue ;; esac
    k="${kv%%=*}"
    v="${kv#*=}"
    if [ "${v:0:1}" = "[" ] || [ "${v:0:1}" = "{" ]; then
      json="$(jq -c --arg k "$k" --argjson v "$v" '. + {($k): $v}' <<<"$json" 2>/dev/null || jq -c --arg k "$k" --arg v "$v" '. + {($k): $v}' <<<"$json")"
    else
      json="$(jq -c --arg k "$k" --arg v "$v" '. + {($k): ($v | (tonumber? // .))}' <<<"$json")"
    fi
  done
  printf '%s\n' "$json" >>"$RESULTS"
  printf '%s\n' "$json" >&2
}

sub() { # sub a b -> a-b with one decimal, empty when either is missing
  if [ -z "${1:-}" ] || [ -z "${2:-}" ]; then echo ""; return; fi
  awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", a-b}'
}

probe() { "$NODE_BIN" "$PROBE" "$@"; }

redact() { sed -E 's/sk-unsloth-[A-Za-z0-9_-]+/sk-unsloth-<redacted>/g; s/([Pp]assword[^:=]*[:=][[:space:]]*)[^[:space:]]+/\1<redacted>/g'; }

save_logs() { docker logs -t "$1" 2>&1 | redact >"$OUT/logs/$1.log" || true; }

# ---- cgroup readings -------------------------------------------------------------------------

cg_of() { # cgroup v2 directory of a running container
  local pid
  pid="$(docker inspect -f '{{.State.Pid}}' "$1" 2>/dev/null)" || return 1
  [ -n "$pid" ] && [ "$pid" -gt 0 ] || return 1
  echo "/sys/fs/cgroup$(sed -n 's/^0:://p' "/proc/$pid/cgroup")"
}

cg_cpu() { awk '$1=="usage_usec"{u=$2} $1=="nr_throttled"{n=$2} $1=="throttled_usec"{t=$2} END{print u+0, n+0, t+0}' "$1/cpu.stat"; }

cg_mem() { # current_mb peak_mb anon_mb file_mb
  local cg="$1" cur peak anon file
  cur="$(cat "$cg/memory.current" 2>/dev/null || echo 0)"
  peak="$(cat "$cg/memory.peak" 2>/dev/null || echo 0)"
  anon="$(awk '$1=="anon"{print $2}' "$cg/memory.stat" 2>/dev/null)"
  file="$(awk '$1=="file"{print $2}' "$cg/memory.stat" 2>/dev/null)"
  awk -v c="$cur" -v p="$peak" -v a="${anon:-0}" -v f="${file:-0}" 'BEGIN{printf "%.0f %.0f %.0f %.0f", c/1048576, p/1048576, a/1048576, f/1048576}'
}

# measure <cg> <outfile> cmd... -- runs cmd with stdout to outfile and sets CPU_PCT (percent of one
# core over the command's wall time), THROTTLED_N and THROTTLED_S for the container meanwhile.
measure() {
  local cg="$1" outfile="$2" u0 n0 th0 u1 n1 th1 t0 t1 rc
  shift 2
  read -r u0 n0 th0 < <(cg_cpu "$cg")
  t0="$(date +%s%6N)"
  "$@" >"$outfile"
  rc=$?
  read -r u1 n1 th1 < <(cg_cpu "$cg")
  t1="$(date +%s%6N)"
  CPU_PCT="$(awk -v du="$((u1 - u0))" -v dt="$((t1 - t0))" 'BEGIN{printf "%.1f", du*100/dt}')"
  THROTTLED_N="$((n1 - n0))"
  THROTTLED_S="$(awk -v d="$((th1 - th0))" 'BEGIN{printf "%.1f", d/1e6}')"
  return "$rc"
}

proc_ticks() { # utime+stime of one process, all threads; parsed after the ")" so a comm with spaces is safe
  sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $12+$13}'
}

# idle_window <container> <seconds> -> JSON: container CPU% and per-process CPU% over the window
idle_window() {
  local name="$1" secs="$2" cg hz pids p u0 u1 t0 t1 arr cpu comm rss ni
  cg="$(cg_of "$name")" || { echo '{"error":"no cgroup"}'; return; }
  hz="$(getconf CLK_TCK)"
  pids="$(docker top "$name" -eo pid 2>/dev/null | tail -n +2 | tr '\n' ' ')"
  declare -A before=()
  for p in $pids; do before[$p]="$(proc_ticks "$p")"; done
  read -r u0 _ _ < <(cg_cpu "$cg")
  t0="$(date +%s%6N)"
  sleep "$secs"
  read -r u1 _ _ < <(cg_cpu "$cg")
  t1="$(date +%s%6N)"
  arr="[]"
  for p in $pids; do
    [ -r "/proc/$p/stat" ] || continue
    comm="$(cat "/proc/$p/comm" 2>/dev/null)"
    rss="$(awk '/^VmRSS/{print $2}' "/proc/$p/status" 2>/dev/null)"
    ni="$(sed 's/^.*) //' "/proc/$p/stat" | awk '{print $17}')"
    cpu="$(awk -v a="$(proc_ticks "$p")" -v b="${before[$p]:-0}" -v hz="$hz" -v s="$secs" 'BEGIN{printf "%.2f", (a-b)*100/hz/s}')"
    arr="$(jq -c --arg comm "$comm" --argjson pid "$p" --argjson cpu "$cpu" --argjson rss "${rss:-0}" --argjson ni "${ni:-0}" \
      '. + [{comm:$comm, pid:$pid, cpu_pct:$cpu, rss_mb:(($rss/1024)|floor), nice:$ni}]' <<<"$arr")"
  done
  jq -nc --argjson cpu "$(awk -v du="$((u1 - u0))" -v dt="$((t1 - t0))" 'BEGIN{printf "%.2f", du*100/dt}')" --argjson procs "$arr" \
    --argjson secs "$secs" '{idle_cpu_pct:$cpu, idle_window_s:$secs, procs:$procs}'
}

docker_stats() { docker stats --no-stream --format '{{json .}}' "$1" 2>/dev/null | jq -c '{cpu:.CPUPerc, mem:.MemUsage, pids:.PIDs}' 2>/dev/null || echo '{}'; }

netns_pid() { docker inspect -f '{{.State.Pid}}' "$1"; }

listening() { # listening sockets inside a container's network namespace, as a JSON array of strings
  sudo nsenter -t "$(netns_pid "$1")" -n ss -ltnupH 2>/dev/null | awk '{print $1" "$5" "$7}' | jq -R . | jq -sc .
}

established() { # remote ends of established TCP connections inside the container
  sudo nsenter -t "$(netns_pid "$1")" -n ss -tnH state established 2>/dev/null | awk '{print $4}' | sort -u | jq -R . | jq -sc .
}

processes() { docker top "$1" -eo pid,ni,rss,args 2>/dev/null | tail -n +2 | awk '{$1=$1; print}' | cut -c1-160 | jq -R . | jq -sc .; }

# ---- starting the server -----------------------------------------------------------------------

epoch_of() { date -d "$1" +%s.%N 2>/dev/null; }

ts_of() { # ts_of <container> <regex> [since] -> epoch of the first matching log line
  local stamp
  stamp="$(docker logs -t ${3:+--since "$3"} "$1" 2>&1 | grep -m1 -E "$2" | awk '{print $1}')"
  [ -n "$stamp" ] && epoch_of "$stamp"
}

wait_ready() { # wait_ready <container> <timeout_s> [since] -> prints the API key once the model is loaded
  local name="$1" timeout="$2" since="${3:-}" deadline logs key
  deadline=$(($(date +%s) + timeout))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != "true" ]; then
      log "$name is not running"
      return 1
    fi
    logs="$(docker logs ${since:+--since "$since"} "$name" 2>&1)"
    if grep -q 'API Key' <<<"$logs"; then
      key="$(grep -oE 'sk-unsloth-[A-Za-z0-9_-]+' <<<"$logs" | tail -1)"
      if [ -n "$key" ]; then
        echo "$key"
        return 0
      fi
    fi
    sleep 1
  done
  log "$name was not ready after ${timeout}s"
  return 1
}

# run_unsloth <name> <cpus> <threads> [docker args...] [-- unsloth args...]
# The shape M37 would ship: one capped, low-priority container running `unsloth run --api-only`,
# published on the host's loopback only. RUN_MODEL and RUN_CTX override the model and context.
run_unsloth() {
  local name="$1" cpus="$2" threads="$3" dargs=() uargs=()
  shift 3
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do dargs+=("$1"); shift; done
  [ "${1:-}" = "--" ] && shift
  uargs=("$@")
  docker rm -f "$name" >/dev/null 2>&1
  docker run -d --name "$name" \
    --cpus "$cpus" --memory "$MEM" --memory-swap "$MEM" --cpu-shares 128 --pids-limit 4096 \
    -p "127.0.0.1:$PORT:8888" -v "$HF_DIR:/hf" \
    -e HF_HOME=/hf -e HF_HUB_DISABLE_TELEMETRY=1 -e DO_NOT_TRACK=1 -e UNSLOTH_STUDIO_DISABLE_PUBLIC_CHECK=1 \
    "${dargs[@]}" "$IMAGE" \
    nice -n 19 unsloth run --model "${RUN_MODEL:-$MODEL}" --api-only --disable-tools -H 0.0.0.0 -p 8888 \
    --context-length "${RUN_CTX:-$CTX}" --parallel 1 --threads "$threads" "${uargs[@]}" >/dev/null
}

# start_and_time <name> -> sets KEY, CG and records startup/load times; returns 1 when not ready
start_and_time() {
  local name="$1" section="$2" started loading ready
  shift 2
  if ! KEY="$(wait_ready "$name" "${SPIKE_READY_TIMEOUT:-1200}")"; then
    save_logs "$name"
    record "$section" "$@" ok=false error=not-ready log_tail="$(docker logs --tail 15 "$name" 2>&1 | redact | tail -c 1500)"
    return 1
  fi
  CG="$(cg_of "$name")"
  started="$(epoch_of "$(docker inspect -f '{{.State.StartedAt}}' "$name")")"
  loading="$(ts_of "$name" 'Loading model')"
  ready="$(ts_of "$name" 'API Key')"
  read -r mcur mpeak manon mfile < <(cg_mem "$CG")
  record "$section" "$@" ok=true phase=loaded startup_s="$(sub "$loading" "$started")" load_s="$(sub "$ready" "$loading")" \
    ready_s="$(sub "$ready" "$started")" mem_mb="$mcur" mem_peak_mb="$mpeak" anon_mb="$manon" file_mb="$mfile"
  return 0
}

# ---- steps ---------------------------------------------------------------------------------

step_build() {
  # The smallest clean path: Ubuntu 24.04 plus Unsloth's own installer, GGUF-only (no PyTorch).
  # The installer apt-installs optional compilers when it runs as root; they are removed in the same
  # layer because the prebuilt llama.cpp needs none of them.
  local ctx="$TMP_ROOT/unsloth-slim-ctx" t0 t1 size
  mkdir -p "$ctx"
  cat >"$ctx/Dockerfile" <<'DOCKERFILE'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive \
    UNSLOTH_STUDIO_HOME=/opt/unsloth-studio \
    PATH=/opt/unsloth-studio/bin:$PATH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://unsloth.ai/install.sh | UNSLOTH_NO_TORCH=1 UNSLOTH_SKIP_AUTOSTART=1 sh \
 && (apt-get purge -y --auto-remove cmake build-essential libcurl4-openssl-dev git >/dev/null 2>&1 || true) \
 && rm -rf /var/lib/apt/lists/* /opt/unsloth-studio/cache/uv /root/.cache/uv /root/.cache/pip
RUN unsloth --version
DOCKERFILE
  log "building $IMAGE"
  t0="$(date +%s)"
  if ! docker build --progress=plain -t "$IMAGE" "$ctx" >"$OUT/logs/build.log" 2>&1; then
    record build ok=false build_s=$(($(date +%s) - t0)) log_tail="$(tail -c 2500 "$OUT/logs/build.log")"
    return 1
  fi
  t1="$(date +%s)"
  size="$(docker image inspect -f '{{.Size}}' "$IMAGE")"
  local version llama sizes licence
  version="$(docker run --rm "$IMAGE" unsloth --version 2>&1 | tail -1)"
  llama="$(docker run --rm --entrypoint sh "$IMAGE" -c 'b=$(find / -xdev -name llama-server -type f 2>/dev/null | head -1); echo "$b"; "$b" --version 2>&1 | tail -2' | tr '\n' ' ')"
  sizes="$(docker run --rm --entrypoint sh "$IMAGE" -c 'du -xsh /opt/unsloth-studio /root/.local /root/.cache /usr 2>/dev/null; du -xh -d2 /opt/unsloth-studio /root/.local/share 2>/dev/null | sort -rh | head -14' | awk '{print $1" "$2}' | jq -R . | jq -sc .)"
  # Which licence the headless path runs under: the CLI and the backend it starts carry SPDX headers.
  licence="$(docker run --rm --entrypoint sh "$IMAGE" -c '
    py=/opt/unsloth-studio/unsloth_studio/bin/python
    sp=$($py -c "import sysconfig;print(sysconfig.get_paths()[\"purelib\"])")
    echo "pkg=$($py -c "import importlib.metadata as m; d=m.metadata(\"unsloth\"); print(d.get(\"License-Expression\") or d.get(\"License\"))")"
    echo "cli_agpl_files=$(grep -rl "AGPL-3.0" $sp/unsloth_cli 2>/dev/null | wc -l)/$(find $sp/unsloth_cli -name "*.py" | wc -l)"
    s=$(find / -xdev -path "*studio/backend/main.py" 2>/dev/null | head -1); echo "studio_main=$s"; head -2 "$s" | tail -1
  ' 2>&1 | tr '\n' ';')"
  record build ok=true build_s=$((t1 - t0)) image_mb=$((size / 1048576)) unsloth_version="$version" llama_server="$llama" \
    sizes="$sizes" licence="$licence"
}

step_models() {
  # Pre-fetch into the Hugging Face cache layout that `unsloth run` reads, so the cached copy is
  # what every container loads and load times exclude downloads.
  python3 -m venv "$VENV" || { sudo apt-get install -y python3-venv >/dev/null && python3 -m venv "$VENV"; } || return 1
  "$VENV/bin/pip" install -q "huggingface_hub>=0.34" pillow || return 1
  local repo files t0 spec
  export HF_HOME="$HF_DIR" HF_HUB_DISABLE_XET=1 HF_HUB_DISABLE_TELEMETRY=1
  for spec in ${SPIKE_DOWNLOADS:-unsloth/Qwen3.5-4B-GGUF=Qwen3.5-4B-UD-Q4_K_XL.gguf,mmproj-F16.gguf Qwen/Qwen3-Embedding-0.6B-GGUF=Qwen3-Embedding-0.6B-Q8_0.gguf}; do
    repo="${spec%%=*}"
    files="${spec#*=}"
    t0="$(date +%s)"
    # shellcheck disable=SC2086
    "$VENV/bin/hf" download "$repo" ${files//,/ } >/dev/null || { record models repo="$repo" ok=false; continue; }
    record models repo="$repo" files="$files" ok=true seconds=$(($(date +%s) - t0))
  done
  du -sh "$HF_DIR" >&2
}

make_chart() { # a small PNG with a chart and readable text, for the vision check
  "$VENV/bin/python" - "$1" <<'PY'
import sys
from PIL import Image, ImageDraw, ImageFont
W, H = 640, 400
img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)
try:
    title = ImageFont.load_default(size=30)
    small = ImageFont.load_default(size=22)
except TypeError:
    title = small = ImageFont.load_default()
d.text((20, 15), "Disk usage by volume", fill="black", font=title)
bars = [("root", 87, (200, 40, 40)), ("data", 42, (40, 120, 200)), ("backup", 15, (60, 160, 60))]
for i, (name, pct, colour) in enumerate(bars):
    x = 70 + i * 190
    top = 340 - int(pct * 2.5)
    d.rectangle([x, top, x + 110, 340], fill=colour)
    d.text((x + 20, top - 30), f"{pct}%", fill="black", font=small)
    d.text((x + 15, 350), name, fill="black", font=small)
d.line([50, 340, 610, 340], fill="black", width=2)
img.save(sys.argv[1])
PY
}

step_perf() {
  local cfg cpus threads name tmp
  tmp="$(mktemp)"
  for cfg in ${SPIKE_PERF_MATRIX:-1.0:1 1.0:2 0.5:1 0.5:2}; do
    cpus="${cfg%%:*}"
    threads="${cfg##*:}"
    name="uns-perf-c${cpus/./}-t$threads"
    log "perf: cpus=$cpus threads=$threads model=$MODEL"
    run_unsloth "$name" "$cpus" "$threads" || { record perf-load cpus="$cpus" threads="$threads" ok=false error=docker-run; continue; }
    if ! start_and_time "$name" perf-load cpus="$cpus" threads="$threads" model="$MODEL"; then
      docker rm -f "$name" >/dev/null 2>&1
      continue
    fi
    measure "$CG" "$tmp" probe first-token --key "$KEY"
    record perf "$(tail -1 "$tmp")" kind=warmup cpus="$cpus" threads="$threads" model="$MODEL" cpu_pct="$CPU_PCT"
    measure "$CG" "$tmp" probe bench --kind short --key "$KEY"
    record perf "$(tail -1 "$tmp")" cpus="$cpus" threads="$threads" model="$MODEL" cpu_pct="$CPU_PCT" throttled_n="$THROTTLED_N" throttled_s="$THROTTLED_S"
    measure "$CG" "$tmp" probe bench --kind long --key "$KEY" --prompt-tokens 1000
    record perf "$(tail -1 "$tmp")" cpus="$cpus" threads="$threads" model="$MODEL" cpu_pct="$CPU_PCT" throttled_n="$THROTTLED_N" throttled_s="$THROTTLED_S"
    log "perf: settling before the idle window"
    sleep 30
    read -r mcur mpeak manon mfile < <(cg_mem "$CG")
    record perf-idle "$(idle_window "$name" "${SPIKE_IDLE_S:-60}")" cpus="$cpus" threads="$threads" model="$MODEL" \
      mem_mb="$mcur" mem_peak_mb="$mpeak" anon_mb="$manon" file_mb="$mfile" docker_stats="$(docker_stats "$name")"
    save_logs "$name"
    docker rm -f "$name" >/dev/null 2>&1
  done
  rm -f "$tmp"
}

step_capability() {
  local name=uns-cap tmp hostname pid
  tmp="$(mktemp)"
  run_unsloth "$name" "${SPIKE_CAP_CPUS:-4}" "${SPIKE_CAP_THREADS:-4}" || return 1
  start_and_time "$name" capability-load cpus="${SPIKE_CAP_CPUS:-4}" threads="${SPIKE_CAP_THREADS:-4}" model="$MODEL" || { docker rm -f "$name"; return 1; }
  probe first-token --key "$KEY" >/dev/null
  local parts="${SPIKE_CAP_PARTS:-tools,vision,json,thinking,security,embed-on-chat}"
  if [[ ",$parts," == *",tools,"* ]]; then
    record capability-tools "$(probe tools --key "$KEY" --trials 5 --timeout 600 | tail -1)" model="$MODEL"
  fi
  if [[ ",$parts," == *",vision,"* ]]; then
    make_chart "$OUT/chart.png"
    record capability-vision "$(probe vision --key "$KEY" --image "$OUT/chart.png" --expect "disk,87" | tail -1)" model="$MODEL"
  fi
  if [[ ",$parts," == *",json,"* ]]; then
    record capability-json "$(probe json --key "$KEY" | tail -1)" model="$MODEL"
  fi
  if [[ ",$parts," == *",thinking,"* ]]; then
    record capability-thinking "$(probe thinking --key "$KEY" | tail -1)" model="$MODEL"
  fi
  if [[ ",$parts," == *",security,"* ]]; then
    hostname="$(docker inspect -f '{{.Config.Hostname}}' "$name")"
    record security "$(probe security --key "$KEY" --hostname "$hostname" | tail -1)" \
      listening_in_container="$(listening "$name")" \
      host_publish="$(docker port "$name" | jq -R . | jq -sc .)" \
      host_listening_18888="$(ss -ltnH "sport = :$PORT" | awk '{print $4}' | jq -R . | jq -sc .)" \
      established="$(established "$name")" processes="$(processes "$name")"
  fi
  if [[ ",$parts," == *",embed-on-chat,"* ]]; then
    # With a chat GGUF resident, does /v1/embeddings answer at all?
    record embeddings "$(probe embed --key "$KEY" --timeout 120 | tail -1)" backend=unsloth-run-chat-model model="$MODEL"
  fi
  save_logs "$name"
  docker rm -f "$name" >/dev/null 2>&1
  rm -f "$tmp"
}

step_lifecycle() {
  # Idle unload inside Unsloth (UNSLOTH_MODEL_IDLE_TTL, 60 s floor), then pause, stop/start with a
  # warm page cache, and stop/start after dropping caches (a cold boot's disk reads).
  local name=uns-life tmp t0 since llama
  tmp="$(mktemp)"
  run_unsloth "$name" 1.0 2 -e UNSLOTH_MODEL_IDLE_TTL=60 || return 1
  start_and_time "$name" lifecycle cpus=1.0 threads=2 idle_ttl=60 || { docker rm -f "$name"; return 1; }
  probe first-token --key "$KEY" >"$tmp"
  llama="$(docker top "$name" -eo comm | grep -c llama-server)"
  read -r mcur _ manon mfile < <(cg_mem "$CG")
  record lifecycle "$(tail -1 "$tmp")" phase=first-request llama_server_procs="$llama" mem_mb="$mcur" anon_mb="$manon" file_mb="$mfile"

  log "lifecycle: waiting past the idle TTL"
  sleep 100
  llama="$(docker top "$name" -eo comm | grep -c llama-server)"
  read -r mcur _ manon mfile < <(cg_mem "$CG")
  record lifecycle "$(idle_window "$name" 30)" phase=after-idle-ttl llama_server_procs="$llama" mem_mb="$mcur" anon_mb="$manon" file_mb="$mfile" \
    unload_log="$(docker logs "$name" 2>&1 | grep -iE 'unload|idle' | tail -3 | redact | jq -R . | jq -sc .)"

  t0="$(date +%s.%N)"
  probe first-token --key "$KEY" --retry 600 >"$tmp"
  llama="$(docker top "$name" -eo comm | grep -c llama-server)"
  record lifecycle "$(tail -1 "$tmp")" phase=request-after-unload to_first_token_s="$(sub "$(jq -r '.first_token_epoch // empty' "$tmp")" "$t0")" llama_server_procs="$llama"

  docker pause "$name" >/dev/null
  sleep 5
  read -r mcur _ manon mfile < <(cg_mem "$CG")
  t0="$(date +%s.%N)"
  docker unpause "$name" >/dev/null
  probe first-token --key "$KEY" >"$tmp"
  record lifecycle "$(tail -1 "$tmp")" phase=unpause paused_mem_mb="$mcur" to_first_token_s="$(sub "$(jq -r '.first_token_epoch // empty' "$tmp")" "$t0")"

  for cache in warm cold; do
    t0="$(date +%s.%N)"
    docker stop -t 30 "$name" >/dev/null
    record lifecycle phase="stop-$cache" stop_s="$(sub "$(date +%s.%N)" "$t0")"
    if [ "$cache" = cold ]; then
      sync
      echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null
    fi
    since="$(date +%s.%N)"
    t0="$since"
    docker start "$name" >/dev/null
    if ! KEY="$(wait_ready "$name" 1200 "$since")"; then
      record lifecycle phase="start-$cache" ok=false
      break
    fi
    CG="$(cg_of "$name")"
    probe first-token --key "$KEY" >"$tmp"
    record lifecycle "$(tail -1 "$tmp")" phase="start-$cache-page-cache" \
      to_ready_s="$(sub "$(ts_of "$name" 'API Key' "$since")" "$t0")" \
      to_first_token_s="$(sub "$(jq -r '.first_token_epoch // empty' "$tmp")" "$t0")"
  done
  save_logs "$name"
  docker rm -f "$name" >/dev/null 2>&1
  rm -f "$tmp"
}

step_embeddings() {
  local name tmp ls gguf cpath t0 up
  tmp="$(mktemp)"

  # 1. `unsloth run` with an embedding GGUF: its own capped container, since one Unsloth serves one model.
  name=uns-embed
  RUN_MODEL="$EMBED_MODEL" RUN_CTX=2048 MEM=2g run_unsloth "$name" 1.0 2 || true
  if SPIKE_READY_TIMEOUT=600 start_and_time "$name" embeddings-load backend=unsloth-run model="$EMBED_MODEL" cpus=1.0 threads=2; then
    measure "$CG" "$tmp" probe embed --key "$KEY" --timeout 300
    record embeddings "$(tail -1 "$tmp")" backend=unsloth-run cpus=1.0 threads=2 cpu_pct="$CPU_PCT"
    sleep 20
    read -r mcur _ manon mfile < <(cg_mem "$CG")
    record embeddings-idle "$(idle_window "$name" 60)" backend=unsloth-run mem_mb="$mcur" anon_mb="$manon" file_mb="$mfile"
  fi
  save_logs "$name"
  docker rm -f "$name" >/dev/null 2>&1

  # 2. The llama-server binary Unsloth installed, run directly with --embedding: no Python at all.
  name=llama-embed
  ls="$(docker run --rm --entrypoint sh "$IMAGE" -c 'find / -xdev -name llama-server -type f 2>/dev/null | head -1')"
  gguf="$(find "$HF_DIR" -name 'Qwen3-Embedding-0.6B-Q8_0.gguf' | head -1)"
  cpath="/hf/${gguf#"$HF_DIR"/}"
  docker rm -f "$name" >/dev/null 2>&1
  t0="$(date +%s.%N)"
  docker run -d --name "$name" --cpus 1.0 --memory 1g --memory-swap 1g --cpu-shares 128 \
    -p 127.0.0.1:18090:8090 -v "$HF_DIR:/hf" -e "LD_LIBRARY_PATH=${ls%/*}" --entrypoint nice "$IMAGE" -n 19 \
    "$ls" -m "$cpath" --embedding --pooling last -t 2 -c 2048 -b 2048 -ub 2048 --host 0.0.0.0 --port 8090 >/dev/null
  up=""
  for _ in $(seq 1 240); do
    if curl -fs http://127.0.0.1:18090/health >/dev/null 2>&1; then up="$(sub "$(date +%s.%N)" "$t0")"; break; fi
    sleep 0.5
  done
  if [ -n "$up" ]; then
    CG="$(cg_of "$name")"
    read -r mcur mpeak manon mfile < <(cg_mem "$CG")
    measure "$CG" "$tmp" probe embed --base http://127.0.0.1:18090 --key "" --model qwen3-embedding --timeout 300
    record embeddings "$(tail -1 "$tmp")" backend=llama-server-direct cpus=1.0 threads=2 cpu_pct="$CPU_PCT" ready_s="$up" \
      binary="$ls" mem_after_load_mb="$mcur"
    sleep 20
    read -r mcur _ manon mfile < <(cg_mem "$CG")
    record embeddings-idle "$(idle_window "$name" 60)" backend=llama-server-direct mem_mb="$mcur" anon_mb="$manon" file_mb="$mfile" \
      listening="$(listening "$name")"
  else
    record embeddings backend=llama-server-direct ok=false log_tail="$(docker logs --tail 20 "$name" 2>&1 | tail -c 1500)"
  fi
  save_logs "$name"
  docker rm -f "$name" >/dev/null 2>&1

  # 3. In-process ONNX in Node (what BoxPilot's own server could hold), capped by a systemd scope.
  local dir="$TMP_ROOT/onnx"
  mkdir -p "$dir" && (cd "$dir" && npm init -y >/dev/null && npm install --no-audit --no-fund @huggingface/transformers >"$OUT/logs/onnx-npm.log" 2>&1)
  record embeddings-install backend=onnx-node node_modules_mb="$(du -sm "$dir/node_modules" | awk '{print $1}')" \
    onnxruntime_mb="$(du -sm "$dir/node_modules/onnxruntime-node" 2>/dev/null | awk '{print $1}')"
  local spec model pooling weight
  for spec in ${SPIKE_ONNX_MODELS:-Xenova/all-MiniLM-L6-v2:mean onnx-community/Qwen3-Embedding-0.6B-ONNX:last_token}; do
    model="${spec%%:*}"
    pooling="${spec##*:}"
    for weight in idle 1; do
      : >"$tmp"
      sudo systemd-run --scope --quiet -p CPUQuota=100% -p MemoryMax=2G -p "CPUWeight=$weight" -- \
        nice -n 19 "$NODE_BIN" "$PROBE" onnx-embed --dir "$dir" --cache "$TMP_ROOT/onnx-cache" --model "$model" --pooling "$pooling" \
        >"$tmp" 2>"$OUT/logs/onnx-$(basename "$model").log"
      [ -s "$tmp" ] && break
    done
    record embeddings "$(tail -1 "$tmp")" backend=onnx-node cap="systemd scope CPUQuota=100% MemoryMax=2G CPUWeight=$weight nice 19"
  done
  rm -f "$tmp"
}

step_official() {
  # The official image: what its default command starts, and `unsloth run --api-only` inside it.
  local img="${SPIKE_OFFICIAL_IMAGE:-unsloth/unsloth:latest}" t0 size name tmp digest
  tmp="$(mktemp)"
  t0="$(date +%s)"
  if ! docker pull -q "$img" >/dev/null 2>"$OUT/logs/official-pull.log"; then
    record official ok=false error=pull log_tail="$(tail -c 800 "$OUT/logs/official-pull.log")"
    return 1
  fi
  size="$(docker image inspect -f '{{.Size}}' "$img")"
  digest="$(docker image inspect -f '{{index .RepoDigests 0}}' "$img")"
  record official ok=true phase=pull pull_s=$(($(date +%s) - t0)) image_mb=$((size / 1048576)) digest="$digest" \
    disk_after_pull="$(df -h / | tail -1 | awk '{print $4" free"}')"

  name=off-default
  docker rm -f "$name" >/dev/null 2>&1
  docker run -d --name "$name" -e UNSLOTH_ALLOW_CPU=1 -e UNSLOTH_SKIP_NOTEBOOK_SYNC=1 "$img" >/dev/null
  for _ in $(seq 1 180); do
    docker logs "$name" 2>&1 | grep -qiE 'container ready|Unsloth Studio running' && break
    [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || break
    sleep 1
  done
  sleep 20
  read -r mcur _ manon mfile < <(cg_mem "$(cg_of "$name")")
  record official "$(idle_window "$name" 60)" phase=default-command listening="$(listening "$name")" processes="$(processes "$name")" \
    mem_mb="$mcur" anon_mb="$manon" log_ready="$(docker logs "$name" 2>&1 | grep -iE 'ready|listening|port|jupyter|studio' | head -12 | redact | jq -R . | jq -sc .)"
  save_logs "$name"
  docker rm -f "$name" >/dev/null 2>&1

  name=off-headless
  IMAGE="$img" run_unsloth "$name" 1.0 2 -e UNSLOTH_ALLOW_CPU=1 -e UNSLOTH_SKIP_NOTEBOOK_SYNC=1 || return 1
  if start_and_time "$name" official-headless cpus=1.0 threads=2 image="$img"; then
    measure "$CG" "$tmp" probe first-token --key "$KEY"
    measure "$CG" "$tmp" probe bench --kind short --key "$KEY"
    record official-headless "$(tail -1 "$tmp")" cpus=1.0 threads=2 cpu_pct="$CPU_PCT" throttled_s="$THROTTLED_S"
    sleep 30
    read -r mcur _ manon mfile < <(cg_mem "$CG")
    record official-headless "$(idle_window "$name" 60)" phase=idle listening="$(listening "$name")" processes="$(processes "$name")" \
      mem_mb="$mcur" anon_mb="$manon" file_mb="$mfile"
  fi
  save_logs "$name"
  docker rm -f "$name" >/dev/null 2>&1
  rm -f "$tmp"
}

main() {
  local step="${1:-}"
  case "$step" in
    build | models | perf | capability | lifecycle | embeddings | official) ;;
    *)
      echo "usage: $0 build|models|perf|capability|lifecycle|embeddings|official" >&2
      exit 2
      ;;
  esac
  log "step $step on $CPU_MODEL ($HOST_CPUS CPUs, $(free -g | awk '/Mem:/{print $2}') GB)"
  "step_$step"
}

main "$@"
