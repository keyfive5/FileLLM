# FileLLM

An AI agent that manages and changes files on Windows from plain-English prompts.

Ask it *"my storage is too full, what's causing it and what should I delete?"* or
*"find all the documents from 2018 with the word hello in them"* and it works the
problem the way a person would: run a cheap check first, look at what came back,
decide what to do next, and keep going until it can answer with real paths and
real numbers.

**Zero dependencies. Zero cost. Runs entirely on your machine.**

---

## Install

1. Install [Node.js](https://nodejs.org) (LTS). That's the only prerequisite.
2. Download this folder.
3. Double-click **`START.bat`**.

Your browser opens automatically. There is no `npm install` — FileLLM has no
dependencies at all, only the Node standard library.

## Pick a brain (all the defaults are free)

On first launch it asks which model to use:

| Provider | Cost | Notes |
| --- | --- | --- |
| **Google Gemini** | Free tier, **no credit card** | Recommended. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **Groq** | Free tier | Very fast. [console.groq.com/keys](https://console.groq.com/keys) |
| **Cerebras** | Free tier | [cloud.cerebras.ai](https://cloud.cerebras.ai) |
| **OpenRouter** | Free with `:free` models | [openrouter.ai/keys](https://openrouter.ai/keys) |
| **Ollama** | Free, **fully offline** | Nothing leaves your machine. See the speed note below. |
| **LM Studio** | Free, fully offline | Same idea, different runtime. |
| Anthropic / OpenAI | Paid | Supported, never required. |

Hosting cost is zero because there is no hosting: the server runs on
`127.0.0.1` and stops when you close the window.

> **Offline speed note.** Local models are genuinely free but only as fast as
> your hardware. On a CPU-only machine a 4B model takes roughly a minute per
> reasoning step, so a multi-step question can take several minutes. On a
> machine with a GPU it's fine. If local inference feels slow, the Gemini and
> Groq free tiers are both fast and still cost nothing.

---

## What it can actually do

**Reads inside files, not just filenames.** `.docx`, `.pdf`, `.xlsx`, `.pptx`,
plus text and source formats — parsed directly from the bytes. Windows Search
only does this reliably for indexed locations, and quietly returns nothing for
the rest.

**Real date filtering.** "documents from 2018", "past 6 months", "last year" map
to actual modification-time ranges, not a fuzzy relevance score.

**Storage analysis that names names.** Per-folder rollups, largest files, and a
junk report covering temp dirs, browser caches, package-manager caches, crash
dumps and stale installers — each with a risk rating and a reason.

**Duplicate detection by content.** Grouped by size, then a 64 KB fingerprint,
then a full SHA-1. Same-name files that differ are not reported; differently
named identical files are.

### The nine tools

| Tool | What it does |
| --- | --- |
| `disk_overview` | Free/used space per drive, sizes of the standard user folders |
| `folder_breakdown` | Which subfolders eat the space, plus the biggest individual files |
| `find_junk` | Reclaimable caches and stale installers, risk-rated |
| `find_files` | Filter by name, glob, extension, size and date |
| `search_content` | Search *inside* documents, including Office and PDF |
| `read_file` | Read one file's text to confirm what it is |
| `list_directory` | Immediate contents of a folder |
| `find_duplicates` | Byte-identical duplicates, hash-verified |
| `propose_changes` | Stage changes for you to approve — **the only mutating tool** |

---

## Safety

Two independent gates sit in front of every change:

1. **The model cannot execute changes.** There is no delete tool, no move tool,
   no shell tool. `propose_changes` only builds a plan. The function that applies
   a plan is reachable only from the Approve button in the UI. A test asserts
   that `propose_changes` is the only tool marked mutating.
2. **A path guard** ([`src/safety.mjs`](src/safety.mjs)) rejects drive roots,
   `C:\Windows`, `Program Files`, `AppData` itself, your home folder, the
   well-known user folders, and FileLLM's own directory — before the plan is
   built *and* again at execution time.

On top of that:

- Deletions go to the **Recycle Bin** via the same API Explorer uses, so they're restorable.
- Moves, renames and copies are written to an **undo journal** and reversible from the Undo tab.
- Nothing overwrites silently — a colliding destination becomes `name (1).ext`.
- The walker never follows symlinks or junctions, so it can't loop or escape.
- The server binds to `127.0.0.1` only and requires a **per-launch token**, so a
  random web page you have open cannot drive your filesystem.

---

## Proving it's actually an agent

Two things in the UI exist purely to make this checkable rather than claimed.

**The Proof tab** shows the raw HTTP traffic to the model: full request body
(including the tool schemas sent), full response body (including the tool call
the model chose), status code, latency and token counts. Nothing is summarised.

**The "Prove it's an agent" button** runs an end-to-end test:

1. Generates a random token like `ZPHR-4F9C2A81B0D3` with `crypto.randomBytes` —
   it cannot be in any model's training data, because it did not exist a second ago.
2. Writes it into a real `.docx` (a ZIP of DEFLATE-compressed XML), buried among
   ~43 decoy files across six folders and eight years.
3. Plants a **trap**: a second `.docx` containing the *same* token, modified in a
   different year.
4. Adds a **near-miss**: a third document containing the token with one character changed.
5. Asks, in plain English, for the 2018 document containing that code — without
   naming the file, the folder, or which tool to use.
6. Grades the answer and deletes the test folder.

To pass, it has to choose its own tools, decompress and parse a binary Office
format, apply a date filter, and reject the trap. A scripted keyword matcher
fails step 3; a model answering from memory fails step 1.

---

## Tests

```bash
node test/run-tests.mjs
```

32 assertions covering the ZIP reader/writer round-trip, Office and PDF text
extraction, encoding detection, date parsing, the safety guards, the walker's
junction handling, index rollups, each search tool, and the mutation gating.

---

## How it works

```
START.bat → server.mjs (127.0.0.1, token-gated)
              │
              ├── src/agent.mjs        ReAct loop: model → tool → observe → repeat
              ├── src/providers.mjs    OpenAI / Gemini / Anthropic wire formats
              ├── src/tools/           the nine tools
              ├── src/walk.mjs         directory walker + cached index
              ├── src/extract.mjs      docx / xlsx / pptx / pdf text extraction
              ├── src/zip.mjs          minimal ZIP reader and writer
              ├── src/safety.mjs       path guards
              └── ui/                  single-page front-end, no framework
```

The index is what makes it feel fast: one pass over a tree records every path,
size and mtime to `%LOCALAPPDATA%\FileLLM\index`, so follow-up questions filter
an array instead of re-crawling the disk. Cache lifetime is 10 minutes, and
Settings has a Clear button.

Models that lack native function calling (common for small local ones) are
automatically switched to a plain-text JSON tool protocol, so FileLLM still
works fully offline.

## Configuration

| Setting | Where |
| --- | --- |
| Provider, model, API key | Settings in the UI → `%LOCALAPPDATA%\FileLLM\config.json` |
| Port | `FILELLM_PORT` env var (default 8777) |
| Fixed session token | `FILELLM_TOKEN` env var (default: random per launch) |
| Don't auto-open browser | `FILELLM_NO_OPEN=1` |

Your API key is stored only in that local file and is redacted from the Proof
tab. Nothing is sent anywhere except to the model provider you chose.

## Licence

MIT.
