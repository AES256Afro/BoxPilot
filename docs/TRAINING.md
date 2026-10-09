# Training the agents' model from what the owner approves (M46, ADR-014)

BoxPilot's agents run on a small local model (Qwen 3.5 4B under Unsloth, four processors, a server
that must run cool). Nothing trains on the box. Two things improve the model's work all the same:

1. **What it is shown.** The example book (`agent_examples`) keeps every request a person approved
   the plan for, and the planner is shown the nearest few before each plan, picked by geometry
   (`docs/HARNESS.md` → Examples). This works on the box, today, and needs nothing below.
2. **What it was trained on.** The same book, exported, is training data for an adapter trained on
   a GPU machine elsewhere and brought back as a GGUF. This page is that recipe. It is optional,
   it is the owner's to run, and the adapter ships only if it beats the base model on the agents'
   evaluation.

## 1. Export the book

From the Agents page (Memory tab → Examples → Export; M46.4) or the API, as the owner:

```bash
curl -fsS -b cookies.txt "https://your-boxpilot/api/v1/agents/<agent-id>/examples/export" -o examples.jsonl
```

`?cover=40` picks a covering subset of forty (k-center greedy over the requests' embeddings: the
breadth of the book rather than its bulk); `?seeds=false` leaves out the examples the template
shipped with. Or on the server itself, as the database's owner, for every agent at once:

```bash
runuser -u boxpilot -- node /opt/boxpilot/scripts/boxpilot-agents-examples.mjs list /var/lib/boxpilot/boxpilot.sqlite3
runuser -u boxpilot -- node /opt/boxpilot/scripts/boxpilot-agents-examples.mjs export /var/lib/boxpilot/boxpilot.sqlite3 > examples.jsonl
```

Each line is one chat-shaped record, the planner's own conversation:

```json
{"messages":[{"role":"system","content":"You work out what a request to Server Keeper asks for ... Tools:\n- where_runs: Where does it run? ..."},
             {"role":"user","content":"Where does Pi-hole run on host-1?\n\nWork out what is asked and plan it. Answer only with the JSON."},
             {"role":"assistant","content":"{\"goal\":\"Find where Pi-hole runs on host-1\",\"subject\":\"Pi-hole\",\"constraints\":[],\"confidence\":0.8,\"clarify\":null,\"plan\":[{\"step\":\"Read where.runs\",\"tool\":\"where_runs\"},{\"step\":\"Answer\",\"tool\":null}]}"}],
 "meta":{"agent":"Server Keeper","signal":"thumbs-up","seed":false,"tools":["where_runs"],"route":"local","createdAt":"2026-10-09T10:00:00.000Z"}}
```

Nothing that names the house leaves with it: host names, accounts, the domain, private addresses
and MAC addresses are replaced with the same stand-ins a run on Claude uses (`host-1`, `user-1`,
`site-1.example`, `192.0.2.x`), and secrets were redacted when the example was kept. Read the file
once before it goes anywhere, all the same: it is the owner's words and the owner's call.

`meta.signal` says what the approval was (`card-staged`, `thumbs-up`, `finding-kept`,
`eval-passed`, or `seed`). The assistant turn is the model's own understanding where a run kept
one; a seed's is a plain one written for it.

## 2. What to train, and why geometry rather than brute force

The owner asked for geometric options over brute force. In fine-tuning, brute force is a full
fine-tune or a high-rank adapter on everything, many epochs, as much data as there is; it moves
every weight and forgets as readily as it learns. The geometric options change less of the base
model's structure:

- **LoRA** (the default everywhere): a low-rank update added to each weight matrix. Cheap and
  well understood; Unsloth's own guidance is rank 16 or 32, alpha equal to the rank or twice it, all
  linear layers, 1 to 3 epochs, learning rate 2e-4, dropout 0
  ([Unsloth, LoRA hyperparameters](https://unsloth.ai/docs/get-started/fine-tuning-llms-guide/lora-hyperparameters-guide)).
- **DoRA** (weight-decomposed low-rank adaptation): splits each weight into a magnitude and a
  direction and trains the direction with LoRA and the magnitude on its own. In PEFT it is one flag,
  `use_dora=True`, documented as improving on LoRA "especially at low ranks" at some training-time
  cost, merged for inference ([PEFT, LoraConfig](https://huggingface.co/docs/peft/main/en/package_reference/lora)).
  Whether a given Unsloth build passes the flag through is not in Unsloth's docs: check your
  version, and fall back to PEFT directly if it does not.
- **OFT** (orthogonal fine-tuning): instead of adding to a weight, multiply it by a learned orthogonal
  matrix, block-diagonal to keep it cheap. An orthogonal transform keeps the angles between neurons
  (the "hyperspherical energy"), so it preserves what the base model knows better than an additive
  update of the same size; the constrained variant (COFT) also bounds how far it rotates. In PEFT:
  `OFTConfig(oft_block_size=32, use_cayley_neumann=True, target_modules="all-linear")`, with TRL's
  `SFTTrainer`, merged for inference ([PEFT, OFT](https://huggingface.co/docs/peft/main/en/package_reference/oft)).
  The literature's own numbers put OFT and its variants (BOFT, HOFT) close to DoRA on accuracy, with
  stability of the base model's structure as the gain
  ([PSOFT, 2025](https://arxiv.org/html/2505.11235v3); [HOFT, 2025](https://arxiv.org/html/2505.16531)).
- **Geometry-aware initialisation**: PEFT's `init_lora_weights="pissa"` (principal singular vectors
  of the base weight) or `"olora"` (QR) start the adapter where the base model's own geometry is,
  rather than at random.

The recommendation for BoxPilot's data, which is small (hundreds of short records) and narrow (one
JSON shape, a dozen tools): **LoRA r=16, alpha=16, all linear layers, with `use_dora=True`** as the
first run, and **OFT with `oft_block_size=32`** as the second, each one epoch, each measured the
same way (§4). Keep the base model's reasoning: BoxPilot's planner runs with thinking off, so these
records teach a direct JSON answer, which is right for the planner; if the same model also answers
people (it does: the acting conversation), Unsloth's Qwen 3.5 guidance is to keep at least 75% of
the training mix reasoning-style, or to train on reasoning-style outputs throughout
([Unsloth, Qwen3.5 fine-tuning](https://unsloth.ai/docs/models/qwen3.5/fine-tune)). Mix in a
reasoning-style set, or train the planner's adapter and keep it for the planner alone.

Do not QLoRA Qwen 3.5: Unsloth's guide says 4-bit training of these models shows "higher than
normal quantization differences". bf16 LoRA on the 4B takes about 10 GB of VRAM; the 2B about 5 GB.
Use `transformers` v5.

## 3. The recipe (GPU machine, not the server)

```python
# train.py: Unsloth, Qwen 3.5 4B, a geometric adapter on BoxPilot's example book.
from unsloth import FastLanguageModel
from datasets import load_dataset
from trl import SFTTrainer, SFTConfig
import json

model, tokenizer = FastLanguageModel.from_pretrained("unsloth/Qwen3.5-4B", max_seq_length=4096, load_in_4bit=False, dtype=None)

# Option A, DoRA: LoRA on the direction, a learned magnitude. If your Unsloth build does not take
# use_dora, drop it here and apply peft.LoraConfig(use_dora=True) to the base model directly.
model = FastLanguageModel.get_peft_model(
    model, r=16, lora_alpha=16, lora_dropout=0, bias="none",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_dora=True, use_gradient_checkpointing="unsloth", random_state=3407,
)
# Option B, OFT (rotations that keep the base model's geometry), with PEFT directly:
#   from peft import OFTConfig, get_peft_model
#   model = get_peft_model(base, OFTConfig(oft_block_size=32, use_cayley_neumann=True, target_modules="all-linear", task_type="CAUSAL_LM"))

data = load_dataset("json", data_files="examples.jsonl", split="train")
data = data.map(lambda row: {"text": tokenizer.apply_chat_template(row["messages"], tokenize=False)})

trainer = SFTTrainer(
    model=model, tokenizer=tokenizer, train_dataset=data, dataset_text_field="text",
    args=SFTConfig(per_device_train_batch_size=2, gradient_accumulation_steps=8, num_train_epochs=1, learning_rate=2e-4,
                   warmup_ratio=0.05, lr_scheduler_type="linear", weight_decay=0.01, bf16=True, logging_steps=5, output_dir="out", seed=3407),
)
trainer.train()

# Merge and export as the GGUF BoxPilot serves (the same quantization family as the base: UD-Q4_K_XL is Unsloth's; q4_k_m is the nearest the exporter offers).
model.save_pretrained_gguf("boxpilot-skills", tokenizer, quantization_method="q4_k_m")
```

Keep the chat template the model was trained with: an exported model that does worse in another
runtime usually has the wrong template or end-of-sequence token, which the Unsloth guide names as
the commonest cause.

## 4. The gate: it ships only if it is better

The adapter is judged by the same evaluation as everything else, on the real model, before it goes
near the server. Put the GGUF where the bench finds a model and run the built-in evaluation on it
and on the base, on the same machine:

```bash
# On a Linux machine with the runtime installed (the bench starts Unsloth the way the runner does):
node tests/bench/agents-real.mjs --runtime "$RUNTIME_DIR" --state "$STATE_DIR" --threads 4 --eval --out base.json
# ... with the adapter's GGUF in the state directory's Hugging Face cache in place of the base ...
node tests/bench/agents-real.mjs --runtime "$RUNTIME_DIR" --state "$STATE_DIR" --threads 4 --eval --out adapter.json
```

Or dispatch `.github/workflows/agents-bench.yml` (mode `eval`) for the base on a GitHub runner, as
M46.1 was measured. The six questions (`test/agents-eval.mjs`) are graded against the facts of a
server laid out like the owner's; the base scores 6/6. An adapter that scores lower on any of them,
or that is slower by more than the noise between two runs, does not ship. Then the acting tasks
(`server/agents/act-grade.mjs`) and the red-team set (`server/agents/redteam.mjs`) must still pass
with the adapter behind the stand-in wire. Only then is the GGUF offered as a model in the Agents
section's library (`agents.model.download` checks every byte against a published checksum: publish
the file with one), and switched to the way any model is: through an approval card, never by itself.

## What is not here

- No trainer runs on the box, and BoxPilot calls none. A CPU-only server keeps the base model.
- Records for the acting conversation (request, tool output, answer) are not exported yet: the book
  keeps the request, the plan and the answer, not the tool outputs the answer was checked against.
- Reinforcement learning from the thumbs (DPO or GRPO on up against down) would need pairs the book
  does not keep: a thumbs down deletes the example rather than keeping it as a negative.
