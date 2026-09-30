# Local AI tools for Workbench

Search selected project files with source citations, convert PDFs into page-linked Markdown, evaluate a small local model, and export a sample demonstration. This is a working command-line prototype. Reports open in Workbench’s existing preview pane; the native search sidebar is unchanged.

No new npm dependencies, paid inference, subscription purchases, or public hosting are part of this implementation. Hugging Face Free is sufficient. The [source catalog](../ai/catalog.json) records the chosen models and candidate datasets.

## This computer

Ollama 0.33.3, Qwen3 Embedding 0.6B, Qwen3.5 4B, and Docling 2.126.0 have been installed in the current WSL environment. The local Ollama process is listening at 127.0.0.1:11435 for this session. After it stops or the machine restarts, start it again with the serve command below.

The runtime lives under ~/.local/share/workbench-ai and model/index caches under ~/.cache/workbench-ai. Ollama also creates its normal ~/.ollama identity. Python packages are pinned in scripts/ai/requirements.txt. The Linux Ollama archive is checked against its upstream SHA-256 before extraction. Installed model digests are recorded in each index and model evaluation.

## Setup on another computer

Prerequisites: Node 22.16+ or 24+, Git, internet access for initial downloads, and [uv](https://docs.astral.sh/uv/getting-started/installation/). Use the Ubuntu/WSL terminal on Windows. On Apple Silicon macOS, first install Ollama using its [official installation options](https://docs.ollama.com/quickstart) or `brew install ollama`. The Python environment uses CPU conversion; Ollama chooses CUDA or Metal where available. Linux x64 is the environment tested in this implementation. The current Python package set is not an Intel Mac support claim.

From the Workbench source folder:

```sh
node scripts/ai.mjs setup
node scripts/ai.mjs serve
```

Leave serve running. In another project terminal:

```sh
node scripts/ai.mjs models
node scripts/ai.mjs doctor
```

The two model downloads total about 4.03 GB. Runtime libraries, Python packages, document models, and working memory are additional. The current Windows GPU is an RTX 3060 with 12 GB VRAM. Hardware is not bundled or provisioned by these commands. Setup does not register a background service.

The setup command can be rerun. It preserves an existing detected Ollama binary and installs the pinned Docling environment. Running models explicitly refreshes the named model tags; evaluations record the actual digests rather than treating a mutable tag as a permanent revision.

## Search a project

The checked-in [configuration](../ai/workbench.config.json) selects README.md, docs, and src, excluding historical/media folders. Review filenames before the first index:

```sh
node scripts/ai.mjs index --dry-run --json
node scripts/ai.mjs index
node scripts/ai.mjs search "What happens when collaborators change the same file?"
```

Use `--out artifacts/ai/search.md` to save full passages for preview. `--json` returns machine-readable results for an existing Workbench assistant. Choose `--mode lexical`, `--mode semantic`, or the default `--mode hybrid`. Keyword-only indexing works without Ollama using `index --lexical-only`; it replaces that project’s semantic index, so rebuild normally to restore semantic search.

For another project, invoke the same script with `--root /path/to/project --config /path/to/reviewed-config.json`. Include entries are relative files or folders, not glob patterns. Copy the example config and change the folder list and extensions. A standalone folder without Git requires an explicit `respectGitIgnore: false`; review its inclusion list yourself.

The source scan honors current Git ignore rules, including tracked files subsequently ignored, and skips hidden paths, symlinks, dependency/build folders, common credential names, binary text, and recognizable credential content. This is not an exhaustive sensitive-data detector. Per-file and total chunk limits bound the experiment. Source content goes only to the literal loopback Ollama endpoint; redirects and remote endpoints are refused.

Indexing reuses unchanged chunks when the model digest matches. Search excludes retrieved files whose contents have changed since indexing and asks for a rebuild. New files require indexing before they are searchable. There is no background watcher. At most one passage per source file appears in the top results. Scores indicate ranking, not confidence, and this command does not generate an answer.

## Convert a PDF

Provide a local PDF and a fresh output folder:

```sh
node scripts/ai.mjs ingest /path/to/document.pdf --out artifacts/ai/intake/my-document
```

Output includes document.md, structured document.json, pages/page-0001.md and subsequent pages, manifest.json with the input hash, and review.csv. The first run downloads Docling’s local model assets from Hugging Face. The converter enables no remote document services or external plugins.

The standard CPU pipeline extracts layout and tables. It is not the experimental Granite Docling VLM. Add `--ocr` for scanned pages. Add `--offline` after all required weights have been cached; missing weights then cause an error. The limits are 50 MB and 200 pages, with `--max-pages` available to lower the page limit. A partial or failed conversion is an error, and an existing nonempty output directory is refused.

Check text, reading order, tables, and page references against the source before using the conversion. Handwriting, equations, complex tables, and multilingual documents have not been validated. OCR is available but the measured fixture uses selectable English text.

## Run evaluations

```sh
node scripts/ai.mjs eval-search --out artifacts/ai/search-evaluation-new
node scripts/ai.mjs eval-models --out artifacts/ai/model-evaluation-new
```

The search diagnostic compares BM25 keyword, exact cosine semantic, and reciprocal-rank hybrid retrieval over the same chunks. The 40 authored questions test whether a labeled source appears in the top five. They are not an independent acceptance set. The intended gate remains at least 85% on 40 independently reviewed questions and improvement over the baseline.

The model diagnostic runs 20 short structured tasks with no tools or generated-code execution. It saves raw responses, measured timings, token counts when supplied by Ollama, CSV results, and a decision memo. Errors count as failures. Timings include loading where it occurred. These tasks do not establish coding-agent or repository-editing reliability.

For a current-assistant comparison, open the generated baseline-prompts.md, run each prompt as a fresh turn with its supplied system instruction, and put the unedited response in baseline-template.json. Identify the assistant/model and any differing settings in provider/notes; leave unmeasured timing null. Then:

```sh
node scripts/ai.mjs compare --local artifacts/ai/model-evaluation/model-results.json --baseline /path/to/completed-baseline.json
```

Comparison refuses a different suite, missing responses, or duplicate IDs. No assistant is launched or charged automatically. A missing reference run stays pending.

To reproduce the PDF smoke test:

```sh
node scripts/ai.mjs fixture-pdf --out artifacts/ai/specimen-new
node scripts/ai.mjs ingest artifacts/ai/specimen-new/intake-specimen.pdf --out artifacts/ai/intake-new
node scripts/ai.mjs check-intake --input artifacts/ai/intake-new --out artifacts/ai/intake-check-new
```

The 20 generated pages cover paragraphs, simple tables, two columns, and checklists. The automatic check verifies required tokens on the correct page, not overall visual fidelity. A real-document review remains necessary.

## Export a demonstration

```sh
node scripts/ai.mjs demo --out artifacts/ai/demo-new
```

Open the generated demo.html in Workbench. It is a self-contained document with four saved search examples, three invented CC0 source files, a walkthrough, and an empty five-reviewer feedback sheet. Its buttons display real results computed during export. It does not perform live inference in the browser or send feedback anywhere. Use `--lexical-only` for an export without an installed model.

The exporter reads only ai/fixtures/demo; it does not accept arbitrary project sources for a public-looking demonstration. Generated artifacts are Git-ignored. Distribution, recruiting testers, and recording whether three of five reviewers complete the tasks unaided remain the owner’s decisions.

## Current boundaries

These tools run from source and are not bundled into the installed Electron app. Their reports work with the existing preview pane. No native semantic sidebar, autonomous coding agent, production document service, voice transcription model, or public demo hosting was added. [Wispr Flow compatibility](wispr-flow.md) is a separate input integration; Flow handles its own transcription.

`npm run verify` checks the application and tool tests without needing a GPU or network. Live model/PDF evaluations run separately. Set WORKBENCH_AI_HOME or WORKBENCH_AI_CACHE before setup to move installation/cache locations. WORKBENCH_AI_OLLAMA can point to an existing executable. Do not run concurrent index writers or evaluations against a model tag you are changing.

For another machine, sync these source changes to its existing machine branch first. The current work is not committed or pushed, so a pull alone cannot retrieve it. After the changes are available there, run `npm run verify` and the setup sequence above. Model caches are machine-local and are not copied through Git.
