# Spike: Unsloth headless on CPU for M37's resident agent

**Date:** 2026-09-29 · **Status:** Findings, no product change · **Script:** `tests/spikes/unsloth-headless.sh`
(with `tests/spikes/unsloth-probe.mjs`) · **Workflow:** `.github/workflows/unsloth-spike.yml` (manual only)

The question: can Unsloth, not Ollama, serve a small Qwen 3.5 with vision headless on a machine with no
GPU, under a hard cap of about 0.5 to 1 CPU, at a usable speed, and idle at about 0%? Measured on GitHub
Actions `ubuntu-24.04` runners (4 vCPU, 16 GB, no GPU), with Unsloth 2026.9.12 and Unsloth's prebuilt
llama.cpp b11160.

## Verdict

**Yes, with two workarounds and one speed caveat.**

- `unsloth run --api-only` serves `unsloth/Qwen3.5-4B-GGUF` (UD-Q4_K_XL with its F16 vision projector)
  headless on CPU from a 2.0 GB image. It answered 5 of 5 tool-calling trials with a valid call, read a
  chart's title and numbers correctly, and returned valid JSON for both `json_schema` and `json_object`.
- The cap holds exactly. Under `--cpus=1.0` the container used 99.8% of one core while generating, and
  50.0% under `--cpus=0.5`: a quarter and an eighth of the 4-vCPU runner, at `nice 19`.
- **Idle is about 0%:** 0.41 to 0.50% of one core with the model loaded (0.1% of the machine), all of it
  Unsloth's Python backend; llama-server itself sat at 0.00 to 0.03%.
- **Speed is the caveat.** At 1 CPU the 4B model writes 4.2 tokens a second, so a 150-token answer takes
  42 s, and it reads a prompt at 7.7 tokens a second, so a 1,000-token context waits 2 min 12 s for its
  first token. At 0.5 CPU everything takes twice as long. That is fine for background work (summaries,
  tool routing, alert triage) and slow for chat. The 2B model is twice as fast with the same tool and
  vision results; the 9B is too slow under this cap.
- **Workaround 1:** server-side tools (Python, terminal, web search) are on by default. Always pass
  `--disable-tools`; verified that a request asking for them then cannot run them.
- **Workaround 2:** Unsloth's own idle unload (`UNSLOTH_MODEL_IDLE_TTL`) frees the model, but its reload
  forgets `--context-length` and relaunches llama-server at the GGUF's 262,144-token context (an 8 GB KV
  cache), which the memory cap OOM-kills. Pinning the context in llama-server's own arguments (`-c 8192`,
  which the reload keeps) avoids it: the model then reloads in 3.8 s and answers 6.6 s after the request.

## Runs

| Run | What it produced |
| --- | --- |
| [36560191538](https://github.com/AES256Afro/BoxPilot/actions/runs/36560191538) | Official image (pull, default services, `unsloth run` inside it). The slim build failed: the installer puts the CLI under `$UNSLOTH_STUDIO_HOME/bin`. |
| [36560502263](https://github.com/AES256Afro/BoxPilot/actions/runs/36560502263) | Slim image built; model loads failed on a missing `libgomp.so.1`. In-process ONNX embeddings measured. |
| [36560978436](https://github.com/AES256Afro/BoxPilot/actions/runs/36560978436) | The main numbers: 4B cap matrix, capability, security, lifecycle, embeddings, 2B and 9B. |
| [36564347136](https://github.com/AES256Afro/BoxPilot/actions/runs/36564347136) | The recommended flags end to end with five minutes of idle, the embedding sidecar, the pinned-context reload, and the official image again on the same CPU as the slim runs. |
| [36567361214](https://github.com/AES256Afro/BoxPilot/actions/runs/36567361214) | The lifecycle again, naming the model on every request (run 4's probe asked for the wrong one after the unload). |

(Run [36560146818](https://github.com/AES256Afro/BoxPilot/actions/runs/36560146818) was a skipped no-op
push that registered the workflow so it could be dispatched from this branch.) Every run uploads
`results.jsonl` (one JSON line per measurement) and the container and llama-server logs as artifacts.

Hardware: every job ran on an AMD EPYC 7763 (Zen 3) except run 1's official-image job, which landed on
an EPYC 9V74 (Zen 4); the official-image figures below are run 4's, on the 7763. The home server's CPU is
different again; the same script can be rerun there before M37 settles the numbers.

## 1. Install path

What Unsloth is, checked against the docs and the source (`unslothai/unsloth` at 2026.9.12):

- PyPI `unsloth` is the Core training library plus the `unsloth` CLI. `pip install unsloth` alone cannot
  serve: `unsloth run` stops with "Unsloth Studio not set up. Run install.sh first."
- `curl -fsSL https://unsloth.ai/install.sh | sh` installs Unsloth Studio: a uv-managed Python 3.13, a venv
  with the Studio backend, an isolated Node, Unsloth's prebuilt llama.cpp for the detected hardware (CPU
  here) and whisper.cpp. `UNSLOTH_NO_TORCH=1` makes it GGUF-only (no PyTorch) and `UNSLOTH_SKIP_AUTOSTART=1`
  stops it launching. As root it also apt-installs cmake, git, build-essential and libcurl headers, which
  the prebuilt llama.cpp never uses.
- `unsloth run` is a Studio command. It starts the Studio FastAPI backend (uvicorn) and the backend starts
  llama-server as a child. So the headless path is two processes: Python on the API port and llama-server
  on a random loopback port inside the same container.
- The official image `unsloth/unsloth` (`latest` = `studio`) is CUDA-based and already starts on CPU
  (`UNSLOTH_IMAGE_ALLOW_CPU=1`, so `UNSLOTH_ALLOW_CPU=1` is only needed on `core`). Its default command runs
  supervisord with Studio's web UI and JupyterLab; sshd starts only when `SSH_KEY` or `PUBLIC_KEY` is set.
  Passing a command (`unsloth run ...`) replaces supervisord, so none of those start.

| | Slim: Ubuntu 24.04 + `install.sh` | Official `unsloth/unsloth:latest` |
| --- | --- | --- |
| Size | **2.0 GB** image, built in 89-100 s | 10.5 GB compressed, **20.9 GB** on disk, 260-280 s to pull |
| What is in it | Studio venv 1.3 GB, llama.cpp 222 MB, Node 203 MB, three side venvs of `transformers` 164 MB, uv Python 109 MB | PyTorch 2.11 + CUDA 12.8, the training stack, JupyterLab, notebooks, Studio, llama.cpp, whisper.cpp |
| Default command | none (the image is built to run `unsloth run`) | supervisord: Studio's web UI on 0.0.0.0:8000 and JupyterLab on 0.0.0.0:8888; 961 MB and 0.50% of a core idle with no model |
| With `unsloth run --api-only` as the command | Python backend (410-430 MB RSS) + llama-server | Python backend (1,045 MB RSS: PyTorch is importable) + llama-server |
| 4B at 1 CPU, 2 threads | backend up 6.1 s, model loaded 8.8 s later; 3.72 tokens/s; idle 0.50% | backend up 10.5 s, model loaded 15.8 s later; 3.54 tokens/s; idle 0.54% |
| Ports inside the container | API on the `-p` port, llama-server on 127.0.0.1:random | the same |
| Can the extras be switched off? | nothing extra runs | yes, by giving a command; the 18 GB of training stack stays on disk |

The slim image needs one thing the installer does not bring on a bare Ubuntu: `libgomp1`. Unsloth's CPU
llama-server links OpenMP, and without it every load fails with "llama-server could not start: the system
library libgomp.so.1 is missing". Everything else it links (libssl3, libstdc++6) is already there once
curl is installed. (The installer's own purge of its compilers would take libgomp1 with gcc, so it has to
be installed as a package of its own.)

## 2. Caps

Each configuration is one container: `--cpus` as shown, `--memory 6g --memory-swap 6g`,
`--cpu-shares 128` (cgroup `cpu.weight` 5), and `nice -n 19` on `unsloth run`, published on
`127.0.0.1` only. `--context-length 8192 --parallel 1`. CPU is read from the container's cgroup `cpu.stat`
over each request's wall time, as a percentage of one core. The model files were read from a restored
Hugging Face cache, so load times exclude downloads.

**Qwen3.5-4B UD-Q4_K_XL + mmproj-F16** (runner: EPYC 7763)

| `--cpus` | `--threads` | Backend up | Model load | Short: first token | Short: tokens/s | 150-token answer | 1,000-token prompt: tokens/s | 1,000-token prompt: first token | CPU while generating | Idle CPU (model loaded) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1.0 | 1 | 6.1 s | 8.8 s | 6.6 s | **4.20** | 42 s | 7.7 | 132 s | 99.8% | **0.49%** |
| 1.0 | 2 | 6.1 s | 8.8 s | 7.0 s | 3.72 | 47 s | 7.5 | 138 s | 100% (throttled 48 s) | 0.50% |
| 0.5 | 1 | 11.9 s | 18.1 s | 13.6 s | **2.08** | 85 s | 3.8 | 264 s | 50.0% | **0.50%** |
| 0.5 | 2 | 12.1 s | 18.4 s | 14.2 s | 1.77 | 98 s | 3.7 | 271 s | 50.0% (throttled 152 s) | 0.49% |

- "Backend up" is container start to the Studio backend answering; "model load" is from there to the
  model being ready. Both scale with the cap.
- The short case asks for a 300-word explanation with `max_tokens: 150`, so every run writes exactly 150
  tokens. The long case sends 994 to 1,030 tokens of container logs and asks for one sentence. llama-server's
  own timings agree with the client's within 0.1 tokens/s.
- **One thread beats two under a cap of one CPU or less.** Two threads spend the quota faster and then sit
  throttled: 11% slower at 1.0 CPU, 15% slower at 0.5.
- Idle was measured over 60 s, 30 s after the last request. Per process: the Python backend 0.45-0.48%,
  llama-server 0.00-0.03%. `docker stats` showed 0.40-0.86% in the same windows.
- Memory: 2.2 GB anonymous after load, 2.6 GB after a few requests, plus the mmapped model files (3.6 GB for
  the 4B and its projector) as page cache. On the runner that page cache was charged to the host, which
  had just restored it; on a server the container reading it first is charged. In run 1 it was: the
  official-image container sat at 6.0 GB of its 6 GB cap. Growth after load is llama-server's context
  checkpoints for this hybrid model (Unsloth sets 20 per slot, 50 MiB each); `--ctx-checkpoints 4` caps it.

**The recommended flags end to end** (run 4: 4B, `--cpus 1.0`, 1 thread, `-c 8192 --ctx-checkpoints 4`):
ready in 14.0 s; a 150-token answer at 4.41 tokens/s in 40.5 s; 5 of 5 tool calls valid at 1 CPU, 9 to 20 s
each after the first (47 s, which reads the tool schema); the embedding sidecar started on first use; then
**five minutes of idle at 0.49% of one core** with both models loaded (Python backend 0.48%, the chat
llama-server 0.01%, the embedding llama-server 0.01%), 2.8 GB anonymous memory, and no outbound
connections.

**The other sizes** (same flags; runner EPYC 7763)

| Model | `--cpus` / `--threads` | Load | Short: tokens/s | 150-token answer | 1,000-token prompt: tokens/s | First token after 1,000 tokens | Idle CPU | Anonymous RAM + model files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen3.5-2B UD-Q4_K_XL | 1.0 / 2 | 7.2 s | 8.29 | 21 s | 19.2 | 52 s | 0.47% | 1.7 GB + 2.0 GB |
| Qwen3.5-2B UD-Q4_K_XL | 0.5 / 1 | 13.1 s | 4.73 | 37 s | 9.7 | 101 s | 0.47% | 1.7 GB + 2.0 GB |
| Qwen3.5-4B UD-Q4_K_XL | 1.0 / 2 | 8.8 s | 3.72 | 47 s | 7.5 | 138 s | 0.50% | 2.6 GB + 3.6 GB |
| Qwen3.5-9B UD-Q4_K_XL | 1.0 / 2 | 9.7 s | 2.30 | 77 s | 4.2 | 240 s | 0.41% | 3.8 GB + 6.9 GB |

Qwen 3.8 was checked and ruled out: its smallest release is the 27B (the others are Flash-Next at 180B and
a 2.4T MoE).

## 3. Capability

Run with the cap lifted to 4 CPUs and 4 threads so the checks finish; the answers do not depend on the cap.
Thinking was off for all but the thinking test.

| Check | 4B | 2B | 9B |
| --- | --- | --- | --- |
| Tool calling: `get_container_status(name)` in an OpenAI `tools` schema, five differently worded asks | **5/5** valid calls, right name each time, `finish_reason: tool_calls` | 5/5 | 5/5 |
| Tool result handed back | answered "running and healthy, up for 3 days" | same | same |
| Vision: a 640x400 PNG bar chart titled "Disk usage by volume" (root 87%, data 42%, backup 15%) | read the title and all three values and colours, 44 s | same, 24 s | same, 67 s |
| `response_format` `json_schema` (strict, enum) and `json_object` | both valid | not run | not run |

Thinking:

- Unsloth launches Qwen3.5's small models with reasoning off (`--reasoning off`), so the default request
  answers directly, in 3 tokens.
- Per request it is switched with Unsloth's own field `enable_thinking: true|false`, or the llama.cpp
  spelling `chat_template_kwargs: {"enable_thinking": false}`; both worked. The reasoning arrives in
  `message.reasoning_content`, never in `content`.
- With thinking on, the 4B spent all 1,500 allowed tokens reasoning about a one-line arithmetic question
  and gave no answer: 172 s at 4 CPUs, so about 6 minutes at 1 CPU. On CPU, leave it off.

## 4. Lifecycle

**Unloading inside Unsloth works; its reload needed a workaround.** `UNSLOTH_MODEL_IDLE_TTL` (seconds, 60 at
the least) is documented in the source as the headless setting: after that long with no requests the
backend stops llama-server, and the next request loads the model again.

| Step (4B, 1 CPU, 6 GB cap) | Result |
| --- | --- |
| 60 s idle with `UNSLOTH_MODEL_IDLE_TTL=60` | "Idle auto-unload: freed GGUF after 60s idle": the chat llama-server exits, container memory 2.5 GB to 0.58 GB, idle CPU 0.47-0.48% (the Python backend). The embedding sidecar, if started, stays (101 MB) |
| Next request, run 3 (context set only with `--context-length`) | **failed:** the reload used `-c 262144` (8 GB of KV cache), and every attempt was OOM-killed for ten minutes |
| Next request, runs 4 and 5 (context also pinned with `-c 8192`) | **reloaded in 3.8 s; first token 6.6 s** after the request was sent. The log reads "Inheriting llama_extra_args from previous load ... '-c', '8192'" |
| `docker pause` then `unpause` | memory held while paused (2.5 GB); first token 0.8 s after unpausing |
| `docker stop` | 1 to 6 s |
| `docker start`, page cache warm | API ready 8.9-9.0 s, first token 12.4-12.9 s |
| `docker start` after dropping the page cache (a cold boot) | API ready 16.8-22.7 s, first token 19.9-27.0 s |

Why the first reload failed: the unload records the model's id and quant, and the reload rebuilds the launch
from those plus the llama-server arguments that were passed through (`--threads` survived), but not
Unsloth's own `--context-length`, so it falls back to the GGUF's native 262,144 tokens. llama-server takes
the last `-c` it is given, so passing `-c 8192` through keeps the context on reload. The unload also saves
the slot's KV cache to disk under `$UNSLOTH_STUDIO_HOME/cache/llama-slots` so the reload can resume it.

## 5. Embeddings

`/v1/embeddings` is not in Unsloth's docs, but the source and the runs show three ways it answers:

| Option | Ready | One text | 16 texts | Dimensions | Memory | Idle CPU |
| --- | --- | --- | --- | --- | --- | --- |
| **Unsloth beside the chat model:** the backend starts a second llama-server with its RAG embedder, `unsloth/bge-small-en-v1.5` GGUF by default, inside the same container and cap | 1.5-2.6 s on the first request, which downloads it; 0.7 s once cached | 0.026 s | 0.29 s at 1 CPU | 384 | **101 MB** RSS | **0.01%** |
| The same with `RAG_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B-GGUF` | 17.9 s | 2.9 s | 14.3 s | 1,024 | 3.9 GB RSS: the container hit its 6 GB cap | not measured |
| `unsloth run` with `Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0` as the model, own container, 1 CPU | 12.0 s | 0.21 s | 3.0 s | 1,024 | 0.64 GB + 0.69 GB file | 0.46% (Python) |
| The same image's `llama-server --embedding --pooling last`, no Python, 1 CPU | **1.2 s** | 0.19 s | 2.2 s | 1,024 | **0.34 GB** + 0.64 GB file | **0.00%** |
| In-process ONNX in Node (`@huggingface/transformers` 4.3.0), `Xenova/all-MiniLM-L6-v2` q8, systemd scope `CPUQuota=100%` | 1.3 s | **0.003 s** | 0.11 s | 384 | **192 MB** RSS | about 1% in the 20 s after a burst |
| The same with `onnx-community/Qwen3-Embedding-0.6B-ONNX` q8 | 7.8 s | 0.20 s | 5.1 s | 1,024 | 1.5 GB RSS | 8% in the 20 s after a burst |

All of them ranked "disk almost full on the data volume" closer to "the storage volume is nearly out of
space" than to "the cat sat on the mat". The ONNX runtime spins its threads for a moment after work, which
is what the post-burst idle figures show. Installing `@huggingface/transformers` adds 735 MB of
`node_modules`, 548 MB of it `onnxruntime-node`.

The sidecar is not idle-unloaded with the chat model: after the chat GGUF was freed it stayed, at 101 MB and
0.03% of a core. Unsloth launches it (`core/rag/embed_llama_server.py`) with no `-c` and no `--threads`, so
llama.cpp uses the model's own context and its default thread count. For bge-small that is 512 tokens and
cheap; for Qwen3-Embedding it is 32,768 tokens, a 3.7 GB KV cache, which is where the 3.9 GB went, and the
extra threads under a one-CPU cap explain 2.9 s a text. Run as its own `llama-server --embedding -c 2048
-t 2` it needed 0.34 GB and 0.19 s.

## 6. Security

Measured on the 4B container (`--api-only --disable-tools -H 0.0.0.0` inside, `-p 127.0.0.1:18888:8888`):

| Probe | Result |
| --- | --- |
| Host sockets | `127.0.0.1:18888` only (`docker port`: `8888/tcp -> 127.0.0.1:18888`) |
| Container sockets | the backend on `0.0.0.0:8888` (container network only), llama-server on `127.0.0.1:<random>`, and the embedding sidecar on another `127.0.0.1` port once started; nothing else |
| Outbound connections while idle | none |
| `/v1/models`, `/v1/chat/completions` without a key, or with a wrong one | 401 |
| With the key | 200 |
| `/` | 404 (`--api-only` serves no web UI) |
| `/docs`, `/openapi.json`, `/api/health` | **200 without a key**: the Swagger page lists every Studio route |
| A request with `enable_tools: true` asking to `cat /etc/hostname` | no tool ran; the container's hostname did not appear |

What to know before shipping it:

- **An API key is always required.** `unsloth run` mints one (`sk-unsloth-...`), prints it on the "API Key:"
  line, and keeps it in `$UNSLOTH_STUDIO_HOME/auth/.cli_api_key_*`, reusing it across restarts.
  `--api-key` cannot be passed. Keyless access exists but is an admin setting stored in Studio's
  database, off by default. For BoxPilot a key on loopback is fine: read it once from the log or the file.
- **Server-side tools default to on for every bind** in this version (the docs still say off for
  non-loopback binds). They run Python and shell inside the container. `--disable-tools` is a hard,
  process-wide override.
- **`--api-only` removes the web UI, not the management API.** Studio's `/api/*` routes (sign-in, model
  downloads, training, settings) stay mounted, and the first start creates an admin `unsloth` whose
  generated password is printed to the container log and saved in `auth/.bootstrap_password`. Loopback-only
  publishing keeps that local; setting `UNSLOTH_STUDIO_PASSWORD` to a secret BoxPilot holds, and treating the
  container log as sensitive, closes the rest.
- llama-server inside the container has no key and logs "CORS allows all origins"; it is reachable only from
  inside the container.
- Network use: Unsloth fetches models and its embedder from Hugging Face on demand, and with a wildcard bind
  on a public address it asks check-host.net whether the port is reachable
  (`UNSLOTH_STUDIO_DISABLE_PUBLIC_CHECK=1` stops that).

**Licences.** The Core library is Apache-2.0, and the package metadata says so. The headless path does not
use it: `unsloth run` starts Studio's backend, and 21 of the 22 files in `unsloth_cli/`, like Studio's
backend, carry `SPDX-License-Identifier: AGPL-3.0-only`. llama.cpp, which does the inference, is MIT. So
what M37 would run is AGPL-3.0 code as a separate, unmodified process that BoxPilot talks to over HTTP.
Installing it on the owner's server from Unsloth's own installer, rather than shipping a modified copy
inside BoxPilot, keeps BoxPilot's code out of it. That reading should be confirmed before M37 ships; it is
not legal advice.

## Recommendation for M37

**Packaging.** A BoxPilot-built image, not the official one: ten times smaller, and none of the training
stack.

```dockerfile
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive UNSLOTH_STUDIO_HOME=/opt/unsloth-studio PATH=/opt/unsloth-studio/bin:$PATH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates libgomp1 \
 && curl -fsSL https://unsloth.ai/install.sh | UNSLOTH_NO_TORCH=1 UNSLOTH_SKIP_AUTOSTART=1 sh \
 && (apt-get purge -y --auto-remove cmake build-essential libcurl4-openssl-dev git || true) \
 && rm -rf /var/lib/apt/lists/* /opt/unsloth-studio/cache/uv /root/.cache/uv
```

**Run.**

```bash
docker run -d --name boxpilot-agent-model --restart unless-stopped \
  --cpus 1.0 --memory 7g --memory-swap 7g --cpu-shares 128 \
  -p 127.0.0.1:18888:8888 -v boxpilot-agent-hf:/hf \
  -e HF_HOME=/hf -e HF_HUB_DISABLE_TELEMETRY=1 -e UNSLOTH_STUDIO_DISABLE_PUBLIC_CHECK=1 \
  -e UNSLOTH_MODEL_IDLE_TTL=900 \
  boxpilot/unsloth-headless \
  nice -n 19 unsloth run --model unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL \
    --api-only --disable-tools -H 0.0.0.0 -p 8888 \
    --context-length 8192 --parallel 1 --threads 1 \
    -c 8192 --ctx-checkpoints 4
```

Everything above was measured together except the 7 GB cap (runs used 6 GB; see Caps) and the 900 s
TTL (runs used 60 s). BoxPilot reads the key from the "API Key:" line after each start, calls
`http://127.0.0.1:18888/v1/...`, and always names the model (`unsloth/Qwen3.5-4B-GGUF`): once it is
unloaded, `/v1/models` lists every GGUF in the cache, not only this one. Setting `UNSLOTH_STUDIO_PASSWORD`
to a secret BoxPilot holds should replace the generated admin password (see Security); that was not tested.

- **Caps:** `--cpus 1.0` (0.5 halves the speed; the owner can choose), `--threads` equal to the whole CPUs
  in the cap and at least 1, `nice 19` and `--cpu-shares 128` so it yields to everything else,
  `--memory 7g` for the 4B (5g for the 2B). On systemd the same is `CPUQuota=100%`, `MemoryMax=7G`,
  `CPUWeight=idle`, `Nice=19`.
- **Model:** the 4B for answers, the 2B when latency matters more; not the 9B. Keep prompts short:
  prefill, not generation, is what makes a long context slow on one core.
- **Idle:** keep the container running. With the model loaded it costs 0.5% of one core and about 6 GB of
  memory. `UNSLOTH_MODEL_IDLE_TTL` gives back 2 GB of it after a quiet spell and reloads on the next
  request (3.8 s, first token 6.6 s), but only with the context pinned by `-c` as above. When the agent
  will not be used for hours, BoxPilot stopping the container frees everything, including the 0.4 GB
  Python backend, and costs 12-13 s to the first token (20-27 s after a reboot). `docker pause` saves
  nothing: idle CPU is already near zero and paused memory stays allocated.
- **Thinking:** off (Unsloth's default for these models); send `enable_thinking: false` anyway.

**Embeddings without Ollama:** use Unsloth's own `/v1/embeddings`. With the chat model loaded, it starts
`bge-small-en-v1.5` (384 dimensions) beside it in the same container and under the same cap: 101 MB,
26 ms a text at 1 CPU, 0.01% of a core idle, the same key and base URL as chat. Seed that GGUF into the
Hugging Face cache at install so the first call does not download it. M34.1's pieces (at most 1,200
characters) fit its 512-token window. If a multilingual or stronger embedder is wanted, run
Qwen3-Embedding-0.6B with the same image's `llama-server --embedding --pooling last -c 2048 -t 1` as a
second capped process (1.2 s to start, 0.34 GB, 0.19 s a text, 0.00% idle), not through
`RAG_EMBEDDING_MODEL`. In-process ONNX (`all-MiniLM-L6-v2`: 192 MB, 3 ms a text) is the fallback for a
server without the model container, at the cost of 735 MB of `node_modules` and running inside BoxPilot's
own process, outside any cap.

## Risks and unknowns

- **The home server's CPU.** Every number here is from EPYC 7763 cores in a VM. Rerun
  `tests/spikes/unsloth-headless.sh perf` on the server before M37 promises a latency.
- **Churn.** This spike ran on Unsloth's twelfth release of the month (2026.9.12); its images rebuild
  daily, and the 8,700-line installer always installs the latest Unsloth and llama.cpp. The docs already
  lag the code: they say server-side tools are off for non-loopback binds, and the code turns them on for
  every bind. M37 should pin: build the image from a known Unsloth version and llama.cpp tag, and rerun
  this workflow before moving either.
- **The idle-reload bug** is worked around, not fixed; it is worth reporting upstream. The workaround
  depends on Unsloth continuing to pass llama-server arguments through on reload.
- **Weight.** Headless still means Studio: a 1.3 GB venv, Node, a 0.4 GB Python process with the whole
  Studio API mounted, and a bootstrap admin account. That process is also all of the idle CPU. The
  `llama-server` Unsloth installs can serve alone (it did for embeddings: 0.00% idle, 1.2 s to start, no
  Python, and no AGPL code running), at the cost of Unsloth's tool-call healing, per-model settings and idle
  unload. Worth one follow-up measurement for chat if the Studio layer's weight or licence matters.
- **Memory accounting.** The mmapped model is page cache: reclaimable, but evicting it under a tight cap
  makes every token read the disk. Size `--memory` for the model files plus the anonymous figure.
- **Not measured:** the 7 GB cap and a 900 s TTL as recommended, `UNSLOTH_STUDIO_PASSWORD` with
  `--api-only`, `HF_HUB_OFFLINE=1` once the models are cached, MTP speculative decoding
  (`Qwen3.5-4B-MTP-GGUF`), chat and embeddings at the same moment under one cap, and AVX-512 or ARM hosts.

## Reproduce

```bash
gh workflow run unsloth-spike.yml --ref spike/unsloth-headless -f jobs=perf,capability,recommended,official,nine-b
```

Or on a Linux host with Docker, jq and Node 24, in order:
`bash tests/spikes/unsloth-headless.sh models`, `build`, then any of `perf`, `capability`,
`recommended`, `lifecycle`, `embeddings`, `official`. Results go to `$SPIKE_OUT` (default
`$RUNNER_TEMP/unsloth-spike`). `SPIKE_MODEL`, `SPIKE_MEM` and `SPIKE_PERF_MATRIX` change the model, the
memory cap and the CPU/thread matrix.
