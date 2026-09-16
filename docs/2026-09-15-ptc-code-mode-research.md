# Programmatic Tool Calling (PTC) & Code Mode — architecture research

**Compiled:** 2026-09-15 · **Method:** web search + direct page fetch of vendor docs/eng blogs; no source is cited that was not fetched or returned with a verbatim extract.
**Confidence legend:** `HIGH` = vendor primary doc / official API reference · `MEDIUM` = engineering blog or reputable secondary · `LOW` = forum/opinion/personal blog.
**Scope note:** every URL below was actually retrieved during this research. Where a page is undated, that is stated rather than guessed.

---

## Q1. What is "Programmatic Tool Calling", who named it, and what is the canonical definition?

**Claim 1.1 — Anthropic named and productized "Programmatic Tool Calling" on 2025-11-24.** The Anthropic engineering post *Introducing advanced tool use on the Claude Developer Platform* (Published Nov 24, 2025) is the originating announcement; it groups PTC with Tool Search Tool and Tool Use Examples as three beta features, and calls PTC the feature that "allows Claude to invoke tools in a code execution environment reducing the impact on the model's context window."
Source: https://www.anthropic.com/engineering/advanced-tool-use — `HIGH`

**Claim 1.2 — Canonical vendor definition (Anthropic, current docs):** "Programmatic tool calling allows Claude to write code that calls your tools programmatically within a code execution container, rather than requiring round trips through the model for each tool invocation. This reduces latency for multi-tool workflows and decreases token consumption by allowing Claude to filter or process data before it reaches the model's context window."
Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling — `HIGH`

**Claim 1.3 — Anthropic's abbreviation "PTC" is used in their own first-party material.** The Claude Cookbook page is titled "Programmatic tool calling (PTC)" (dated 2025-11-24 in its metadata) and defines it as writing code that calls tools programmatically in the Code Execution environment.
Source: https://platform.claude.com/cookbook/tool-use-programmatic-tool-calling-ptc — `HIGH`

**Claim 1.4 — The *idea* predates the name; Anthropic credits prior art explicitly.** The same Nov 24, 2025 post's Acknowledgements section states the work "drew inspiration from across the AI ecosystem, including Joel Pobar's LLMVM, Cloudflare's Code Mode and Code Execution as MCP."
Source: https://www.anthropic.com/engineering/advanced-tool-use — `HIGH`

**Claim 1.5 — Cloudflare shipped the pattern first, under the name "Code Mode" (2025-09-26).** Authored by Kenton Varda and Sunil Pai: "We tried something different: Convert the MCP tools into a TypeScript API, and then ask an LLM to write code that calls that API." This predates Anthropic's PTC announcement by ~2 months.
Source: https://blog.cloudflare.com/code-mode/ — `HIGH`

**Claim 1.6 — Anthropic's own MCP variant, "Code execution with MCP" (2025-11-04), is a third related artifact.** It proposes presenting MCP servers as a file tree of code APIs (`servers/google-drive/getDocument.ts`) rather than direct tool calls; it explicitly notes "Cloudflare published similar findings, referring to code execution with MCP as 'Code Mode.'"
Source: https://www.anthropic.com/engineering/code-execution-with-mcp — `HIGH`

**Claim 1.7 — Academic prior art:** CodeAct ("Executable Code Actions Elicit Better LLM Agents", Wang et al., arXiv:2402.01030, 2024) proposes executable Python code as a *unified action space* for LLM agents — the conceptual ancestor of both terms.
Source: https://arxiv.org/abs/2402.01030 — `HIGH` (for the paper) / relevant as background only.

**Net answer to "who named it":** Cloudflare coined **"Code Mode"** (2025-09-26); Anthropic coined **"Programmatic Tool Calling / PTC"** (2025-11-24) as a narrower, productized API feature. Both build on CodeAct-style research. The two names are now used semi-interchangeably in third-party docs (see Q6).

---

## Q2. Anthropic's PTC: exact mechanism, tool versions, and parameter names

**Claim 2.1 — It is opt-in per tool via `allowed_callers`, and requires the code execution tool.** Full config from the announcement:
```json
{"tools": [
  {"type": "code_execution_20250825", "name": "code_execution"},
  {"name": "get_team_members", "input_schema": {...},
   "allowed_callers": ["code_execution_20250825"]}
]}
```
Source: https://www.anthropic.com/engineering/advanced-tool-use — `HIGH`

**Claim 2.2 — The 5-step mechanism (verbatim, current docs):** (1) Claude writes Python code that invokes the tool as a function, potentially including multiple calls and pre/post-processing logic; (2) Claude runs this code in a sandboxed container through code execution; (3) when a tool function is called, **code execution pauses** and the API returns a `tool_use` block; (4) you provide the result and code execution continues — **intermediate results are not loaded into Claude's context window**; (5) once all code execution completes, Claude receives the final output.
Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling — `HIGH`

**Claim 2.3 — Tools are surfaced to the generated code as async Python functions.** "Each function takes a single dict of arguments and returns a string: the text of the `tool_result` you send back." Claude awaits them with top-level `await` and can parallelize with `asyncio.gather`, e.g. `rows = json.loads(await query_database({"sql": ""}))`.
Source: same as 2.2 — `HIGH`

**Claim 2.4 — Wire format / block types.** PTC emits a `server_tool_use` block (`name: "code_execution"`, `input.code`) and, for each nested call, a `tool_use` block carrying `caller: {"type": "code_execution_20250825", "tool_id": "srvtoolu_abc"}`. Final result arrives as `code_execution_tool_result` with `content.stdout`.
Sources: https://www.anthropic.com/engineering/advanced-tool-use and https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling — `HIGH`

**Claim 2.5 — `allowed_callers` values:** `["direct"]` — "Claude is guided to call this tool directly (default if omitted)"; `["code_execution_<version>"]` — "guided to call this tool only from within code execution"; `["direct", "code_execution_<version>"]` — either. The docs frame these as *guidance to Claude*, not enforcement (see Claim 5.1).
Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling — `HIGH`
> The advice to pick one route rather than both ("this provides clearer guidance to Claude for how best to use the tool") appears in the **LiteLLM** integration doc, attributed to Anthropic but not found verbatim on the Anthropic docs page I fetched. Source: https://docs.litellm.ai/docs/providers/anthropic_programmatic_tool_calling — `MEDIUM`

**Claim 2.6 — Tool-version progression (this is the important drift since launch):**
- `code_execution_20250825` — Bash + file operations. **This is the version used throughout the Nov 2025 launch material.**
- `code_execution_20260120` — "adds REPL state persistence and programmatic tool calling from within the sandbox." **PTC now requires `code_execution_20260120` or later.**
- `code_execution_20260521` — same runtime as `20260120`; the only difference is the tool description documents a **90-second wall-clock limit per Python cell** in PTC, so Claude can budget long cells. A cell exceeding it returns a normal result with non-zero `return_code` and a `detection_timeout` status message (distinct from the `execution_time_exceeded` error for whole-invocation overrun).
- In `allowed_callers`, `code_execution_20260120` and `code_execution_20260521` are **interchangeable**; response blocks always tag the caller as `code_execution_20260120`.
Sources: https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool and …/programmatic-tool-calling — `HIGH`
> ⚠️ **Migration note:** any 2025-era tutorial using `allowed_callers: ["code_execution_20250825"]` reflects the launch API only. Third-party docs (e.g. the AWS `sample-bedrock-api-proxy` architecture doc and the LiteLLM page) still show `code_execution_20250825`. Source: https://github.com/aws-samples/sample-bedrock-api-proxy/blob/main/docs/architecture/features.md — `MEDIUM`

**Claim 2.7 — Container lifecycle and timeouts.** Same containers as code execution. New container per request unless reused via the top-level `container` ID; **the container ID is mandatory on the continuation request while a programmatic call is pending — the API rejects the request without it.** Idle containers reclaimed after ~5 minutes; hard 30-day max reuse. A pending programmatic tool call **times out after ~4 minutes and raises `TimeoutError` inside the code.**
Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling — `HIGH`

**Claim 2.8 — Interaction limits.** `strict: true` structured outputs are **not supported** with programmatic calling; you **cannot force** programmatic calling of a specific tool via `tool_choice`; `disable_parallel_tool_use: true` is **not supported**. The continuation user message may contain **only** `tool_result` blocks, and the same `tools` array must be resent.
Source: same as 2.7 — `HIGH`

**Claim 2.9 — Availability / data governance.** Supported on Claude API, Claude Platform on AWS, Microsoft Foundry (requires a Hosted on Anthropic deployment); **not available on Amazon Bedrock or Google Cloud**. Claude Haiku 4.5 accepts the newer tool versions but **does not support PTC**. **PTC is not ZDR-eligible.** Related: the `_20260209`+ web tools default to a code-execution caller for internal "dynamic filtering"; to use them with ZDR you must set `"allowed_callers": ["direct"]` to bypass the internal code execution step.
Sources: https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling and …/server-tools — `HIGH`

**Claim 2.10 — Container resources:** 5 GiB RAM, 5 GiB disk, 1 CPU; internet access completely disabled; file access limited to workspace directory; sandbox isolated from host and other containers.
Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool — `HIGH`

**Claim 2.11 — Anthropic's own published effect sizes:** average **+11% performance while using 24% fewer input tokens** on BrowseComp and DeepSearchQA when adding PTC on top of basic search tools; internal testing cited in the launch post: average usage **43,588 → 27,297 tokens (−37%)** on complex research tasks, internal knowledge retrieval **25.6% → 28.5%**, GIA benchmark **46.5% → 51.2%**, and a worked budget-audit example reducing **200 KB of raw expense data to ~1 KB**.
Sources: https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling and https://www.anthropic.com/engineering/advanced-tool-use — `HIGH` (as vendor-reported figures; see "Contested" below)

---

## Q3. Cloudflare "Code Mode": MCP → TypeScript API in a sandbox

**Claim 3.1 — Core mechanism and rationale (2025-09-26, Kenton Varda & Sunil Pai).** The Agents SDK fetches an MCP server's schema and **converts it into a TypeScript API complete with doc comments derived from the schema**; that TS surface is loaded into the agent's context and the agent writes code against it. The agent is then presented with **just one tool that executes TypeScript**, whose "only access to the outside world is through the TypeScript APIs representing its connected MCP servers." Stated rationale: "LLMs have seen a lot of code. They have not seen a lot of 'tool calls'… LLMs are better at writing code to call MCP, than at calling MCP directly."
Source: https://blog.cloudflare.com/code-mode/ — `HIGH`

**Claim 3.2 — Stated token/latency rationale:** "With the traditional approach, the output of each tool call must feed into the LLM's neural network, just to be copied over to the inputs of the next call, wasting time, energy, and tokens. When the LLM can write code, it can skip all that, and only read back the final results it needs."
Source: https://blog.cloudflare.com/code-mode/ — `HIGH`

**Claim 3.3 — Server-side Code Mode (2026-02-20, Matt Carey).** The full Cloudflare API (2,500+ endpoints) is exposed over MCP as **exactly two tools, `search()` and `execute()`**, "while consuming only around 1,000 tokens. The footprint stays fixed, no matter how many API endpoints exist." Measured reduction: **99.9%** versus an equivalent non-Code-Mode MCP server that "would consume 1.17 million tokens." Measured with tiktoken.
Source: https://blog.cloudflare.com/code-mode-mcp/ — `HIGH`

**Claim 3.4 — Sandbox substrate is a Dynamic Worker isolate.** "A lightweight V8 sandbox with no file system, no environment variables to leak through prompt injection and external fetches disabled by default. Outbound requests can be explicitly controlled with outbound fetch handlers when needed." Both `search()` and `execute()` run model-written code inside it.
Source: https://blog.cloudflare.com/code-mode-mcp/ — `HIGH`

**Claim 3.5 — Cloudflare acknowledges Anthropic converged independently:** "Anthropic independently explored the same pattern in their Code Execution with MCP post." Their own "Comparing approaches to context reduction" section also names Goose and "Anthropics Claude SDK as Programmatic Tool Calling."
Source: https://blog.cloudflare.com/code-mode-mcp/ — `HIGH`

---

## Q4. Other implementations and published measurements

**Claim 4.1 — OpenAI ships a feature under the identical name "Programmatic Tool Calling."** Responses API: add the `programmatic_tool_calling` hosted tool and set `allowed_callers: ["programmatic"]` on eligible tools (values: omitted/`["direct"]`, `["programmatic"]`, `["direct","programmatic"]`). Models write **JavaScript** (with top-level `await`) run in "a fresh, isolated V8 runtime" that has no Node.js, no package install, no network, no general-purpose filesystem, no subprocess execution, no console, and no persistent JS state between programs. Programs emit output only via `text(...)` or `image(...)`.
Source: https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling — `HIGH` (page undated; retrieved 2026-09-15)

**Claim 4.2 — OpenAI's response envelope differs from Anthropic's.** New item types `program` (with `call_id` and an opaque `fingerprint` for resume/replay), nested `function_call` items whose `caller.caller_id` matches the program's `call_id`, and `program_output` (`status: completed | incomplete`). Supported callers include `function`, `custom`, `mcp`, `apply_patch`, local and hosted `shell`, and `code_interpreter`. Notably, **an MCP tool's `require_approval` policy can pause the program until you approve the call** — a per-call policy hook Anthropic's docs do not describe.
Source: same as 4.1 — `HIGH`

**Claim 4.3 — OpenAI claims ZDR compatibility without a persistent container** (unlike Anthropic, where PTC is not ZDR-eligible): "For Responses API requests, Programmatic Tool Calling supports Zero Data Retention (ZDR) workflows without requiring a persistent code-execution container."
Source: same as 4.1 — `HIGH`

**Claim 4.4 — OpenAI's Agents API enables PTC by default** and gives the agent an `exec` tool; disable with `{"type": "programmatic_tool_calling", "enabled": false}`.
Source: same as 4.1 — `HIGH`

**Claim 4.5 — AWS measured 87–92% token reduction across 8 model families, with an accuracy side-effect (2026-05-19).** Same expense-audit task, PTC vs non-PTC, self-hosted Docker sandbox on ECS. Representative rows: Claude Sonnet 4.6 128,043 → 12,739 tokens (−90.1%); deepseek.v3.2 245,967 → 19,543 (−92.1%); Kimi 2.5 148,085 → 10,875 (−92.7%). **In PTC mode all eight models produced the exactly correct answer; in non-PTC mode only the two Claude models did.** Claimed cost effect: ~$15,600/mo → ~$1,560/mo on 1,000 daily executions.
Source: https://aws.amazon.com/blogs/machine-learning/implementing-programmatic-tool-calling-on-amazon-bedrock/ — `MEDIUM` (vendor engineering blog; n=1 task per model, single trial — see Contested)

**Claim 4.6 — AWS's reference proxy shows the pause/resume loop concretely**, and documents a real production gap: **"Non-streaming only (streaming PTC not yet implemented)"**, session timeout 4.5 min (`PTC_SESSION_TIMEOUT=270`), sandbox network disabled by default, tools executed client-side, multi-instance deployments require sticky sessions. Parallel calls are batched within a 100 ms window and returned as multiple `tool_use` blocks.
Source: https://github.com/aws-samples/sample-bedrock-api-proxy/blob/main/docs/architecture/features.md — `MEDIUM`

**Claim 4.7 — Vercel AI SDK ships `@ai-sdk/code-mode`** (experimental; Node.js 22+, not in browser/edge). Generated code runs in an **isolated QuickJS sandbox**; `experimental_toolCallers` selects which tools code mode may call, with `DIRECT_TOOL_CALL` as the dual-route sentinel. `executionPolicy` exposes `timeoutMs`, `memoryLimitBytes`, `maxStackSizeBytes`, `maxSourceBytes`, `maxResultBytes`, `maxConsoleOutputBytes`, `maxBridgeRequests`, `maxInFlightBridgeRequests`. The sandbox blocks Node globals (`process`, `require`), `fetch`/WebCrypto, and `eval`/dynamic `Function` construction.
Source: https://ai-sdk.dev/docs/ai-sdk-core/code-mode — `HIGH` (undated; retrieved 2026-09-15)

**Claim 4.8 — goose (Block) implemented Code Mode MCP** (blog post dated 2025-12-15); Cloudflare's post cites it as an independent implementation.
Sources: https://block.github.io/goose/blog/2025/12/15/code-mode-mcp/ — `MEDIUM`

**Claim 4.9 — Glean ships enterprise PTC inside an "Agent Sandbox."** Frames the win as replacing "over 10 separate model turns" for paginated Salesforce traversal with one program; claims "Auditable workflows — inspect intermediate steps and artifacts in the sandbox for debugging"; PTC runs only over **allowlisted** tools and always requires an active sandbox. Made available for customer-hosted AWS/GCP deployments in the 2026-05-06 release.
Sources: https://docs.glean.com/security/agent-sandbox-ptc and https://docs.glean.com/release-notes/releases/2026-05-06-may-release — `HIGH` (product docs; claims are vendor-stated)

**Claim 4.10 — Independent academic ablation: cost wins are real, accuracy wins are not (arXiv:2607.10569, RIT, KDD 2026 SE 3.0 workshop).** Crossed 3-arm design (baseline / bash_only / code_only) × 2 task regimes × 2 agents, model+harness+prompts fixed. "Restricting the agent to a single execute_code MCP tool is cheaper than — or statistically tied with — its cheapest tool-rich rival in three cells… with **pass rates statistically tied within each cell**." The lone exception (SWE-bench × Claude Code) was directionally costlier (+14.4%, not significant), and "a conditional-cost analysis localizes that gap to failure-cost on doomed-run trajectories, not a per-edit tax on successful runs." Authors explicitly list the industry 98–99% claims as one of three contradictory prescriptions they set out to test.
Source: https://arxiv.org/html/2607.10569v1 — `MEDIUM`

**Claim 4.11 — Microsoft Research uses PTC as a component for small models (arXiv:2603.06713, ATLAS).** Combines iterative tool loading (ISL/ITL) with PTC ("ITL+PTC") to bound context growth for a 4B SLM on MCP benchmarks; reports approaching frontier-agent performance "under far tighter parameter and context budgets." It also names SLM-specific failure modes: "code-based orchestration exposes weaknesses in code synthesis, execution, and recovery."
Source: https://arxiv.org/html/2603.06713v1 — `MEDIUM`

**Claim 4.12 — "Speculative PTC" (sPTC) is an emerging latency-optimization layer.** Alex L. Zhang proposes pre-launching tool calls parsed from partially-generated REPL code, inspired by CPU speculative execution and speculative decoding; measured speedups "on the order of 1–1.2x" on Recursive Language Model workloads (Qwen3-30B-A3B, 5 runs/experiment) and states the technique "generally applies to harnesses that generate code (i.e. CodeAct-like or 'code mode' harnesses)."
Source: https://alexzhang13.github.io/blog/2026/spec-ptc/ — `LOW` (personal research blog)

---

## Q5. Tradeoffs and failure modes reported in practice

**Claim 5.1 — `allowed_callers` is explicitly NOT a security boundary (Anthropic's own words).** "`allowed_callers` controls how the tool is presented to Claude and is validated against `tool_choice`, but it is **not a hard API-level block on direct invocation**. Claude is strongly guided to respect it, but your client should still be prepared to handle a direct `tool_use` for any tool it defines. **Do not rely on `allowed_callers` as a security boundary.**"
Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling — `HIGH`

**Claim 5.2 — Opt-in hygiene is on the developer.** The cookbook instructs: "Only opt in tools that are safe for programmatic/repeated execution"; the launch post adds that the best PTC candidates are tools "that can run in parallel (independent operations)" and "[o]perations safe to retry (idempotent)."
Sources: https://platform.claude.com/cookbook/tool-use-programmatic-tool-calling-ptc and https://www.anthropic.com/engineering/advanced-tool-use — `HIGH`

**Claim 5.3 — Per-call policy enforcement is the weakest link in at least one major SDK.** Vercel's AI SDK states plainly: "**Code mode does not currently integrate with AI SDK tool approval flows.** Tool calls made by generated code are nested inside the code mode invocation, so they cannot pause the generation and surface a tool approval request to your application… **If a nested tool requires approval, the call is rejected rather than executed.**" Guidance: keep approval-gated tools directly callable.
Source: https://ai-sdk.dev/docs/ai-sdk-core/code-mode — `HIGH`
> Contrast: OpenAI's `mcp` tool `require_approval` *can* pause a program; Anthropic's model pauses per nested call and hands the `tool_use` back to your application — so both leave a policy chokepoint, but only if the host implements it there.

**Claim 5.4 — OpenAI's own routing guidance reserves writes and approvals for direct tool calling.** "Writes or approval-sensitive actions → Use direct tool calling by default **to preserve a clear authorization boundary**." Also: "Final citation or native artifact validation → Use direct tool calling unless the program preserves the native output and validates every required item," and "Check arguments and permissions for each call in your application, **even when it comes from a hosted program**."
Source: https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling — `HIGH`

**Claim 5.5 — Loss of observability is the standard debugging complaint.** Arize (2026-09): "A failing tool call is a discrete event with a clear input and output. A failing program is subtler: the bug might be in the agent's logic, in how it composed the tools, or in an intermediate result you never saw because it never left the sandbox. **Traces get harder to read and evaluate.**" They also require "a record of what the agent ran, not just what it said."
Source: https://arize.com/blog/code-mode/ — `MEDIUM`

**Claim 5.6 — Streaming observability is concretely limited today.** AWS's reference implementation documents "Non-streaming only (streaming PTC not yet implemented)," i.e. the pause/resume protocol does not stream.
Source: https://github.com/aws-samples/sample-bedrock-api-proxy/blob/main/docs/architecture/features.md — `MEDIUM`

**Claim 5.7 — Naive sandboxing causes real host RCE.** CVE-2026-57141 (PraisonAI `codeMode` tool, `praisonai-ts`): a `new Function()` + `with(sandbox)` "sandbox" guarded by a regex blocklist is bypassed via `Function('return this')()` plus string-concatenated `require('child_' + 'process')`, "achieving full arbitrary code execution on the host system." The advisory notes `with()` adds to the scope chain but does not prevent global access, and that the blocklist pattern "is fundamentally insecure and cannot be fixed with regex improvements."
Source: https://corgea.com/advisories/vulnerabilities/CVE-2026-57141 — `MEDIUM` (advisory aggregator; CVE id and code paths given. Cross-check against the NVD entry before quoting in an architecture doc.)

**Claim 5.8 — Argument injection through "pre-approved" commands reaches RCE even without a code sandbox.** Trail of Bits (2025-10-22) documents one-shot RCE against three unnamed production agents exploiting pre-approved commands and unvalidated flags, and concludes: "Maintaining allowlists of 'safe' commands without a sandbox is fundamentally flawed… Implement sandboxing as the primary security control," recommending WebAssembly or OS-level sandboxes and argument separators.
Source: https://blog.trailofbits.com/2025/10/22/prompt-injection-to-rce-in-ai-agents/ — `MEDIUM`

**Claim 5.9 — A sandbox does not defend the second untrusted input.** Blake Crosley (2026-06-06): agents have "two untrusted inputs, not one — model-generated code that your runtime executes, and tool/server output that your model ingests." Tool poisoning (Invariant Labs, April 2025; OWASP LLM01:2025) "fires without the tool being called" and "no amount of process isolation helps, because the agent was supposed to be able to read that tool and act on it."
Source: https://blakecrosley.com/blog/agent-two-untrusted-inputs — `MEDIUM`

**Claim 5.10 — Reputable practitioner skepticism of model-based injection defenses.** Simon Willison, on Claude Code auto mode (2026-03-24): "I remain unconvinced by prompt injection protections that rely on AI, since they're non-deterministic by nature… I still want my coding agents to run in a robust sandbox by default, one that restricts file access and network connections in a deterministic way." This is the same reasoning that motivates code-mode sandbox design; it is also the reason a code-mode sandbox should be counted as *isolation*, not as *injection mitigation*.
Source: https://simonwillison.net/2026/mar/24/auto-mode-for-claude-code/ — `LOW` (opinion) but `MEDIUM`-weight provenance.

**Claim 5.11 — Anthropic warns about a "multicomputer environment" failure mode.** When code execution is provided alongside client-side execution tools (a Bash tool, a custom REPL), "Claude can sometimes confuse these environments, attempting to use the wrong tool or assuming state is shared between them." Recommended: explicit system-prompt guidance plus explicit passing of results between environments.
Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool — `HIGH`

**Claim 5.12 — Code mode may now be duplicative of the harness.** Arize: "foundation models and coding harnesses are increasingly shipping with tool search and code execution built in. If you build your own inside, say, an MCP server, you may be duplicating what the harness already provides, in a layer that shouldn't own it… treat this as a caution rather than a rule." And: "For a product with a modest number of tools, plain tool calling may be the simpler, safer choice. Code mode earns its complexity when tool count, data volume, or task horizon grows past what tool calling handles gracefully."
Source: https://arize.com/blog/code-mode/ — `MEDIUM`

**Claim 5.13 — Sandbox engineering scope checklist (vendor-neutral, secondary).** Generated code needs isolation (container / micro-VM / interpreter sandbox) with hard caps on CPU, memory, execution time, and filesystem; network access "needs careful thought: a prompt-injected agent with an open connection can exfiltrate data just by writing code"; expose only the functions and data the user is entitled to; retain a record of what ran. "None of this is easy to retrofit."
Source: https://arize.com/blog/code-mode/ — `MEDIUM`

---

## Q6. Terminology mapping and collisions

**Claim 6.1 — Within agent tooling, "PTC" overwhelmingly means Programmatic Tool Calling.** Anthropic (docs + cookbook), OpenAI (API guide), AWS (Bedrock blog), Glean (product docs), Microsoft Research (arXiv:2603.06713), and the RIT ablation paper all use PTC = Programmatic Tool Calling. It is the de-facto expansion. — `HIGH`

**Claim 6.2 — "Code Mode" and "PTC" are **near-synonyms but not identical**.** Union.ai's docs state the equivalence directly: "Programmatic tool calling (also known as code mode) is a pattern where LLMs write executable code instead of making individual tool calls." Source: https://www.union.ai/docs/v2/flyte/user-guide/agents/sandboxing/code-mode/ — `MEDIUM`
The practical architectural distinction, drawn from primary sources: **PTC = keep your existing tool definitions and add one field** (`allowed_callers`), so your application stays in the per-call loop via pause/resume; **Code Mode = re-architect the tool surface itself** into a typed module/SDK (`codemode.*` namespaces, or `search()`/`execute()`), so the tool catalog never appears as tools at all. — `MEDIUM` (synthesized from primary docs in Q2/Q3; a secondary source states the same split at https://dreaming.press/posts/programmatic-tool-calling-claude-explained.html — `LOW`)

**Claim 6.3 — Cross-industry collision: PTC Inc.** PTC (Nasdaq: PTC), formerly Parametric Technology Corporation, is a CAD/PLM software vendor — legally renamed PTC Inc. in 2013. In any document that also discusses engineering/manufacturing software, bare "PTC" is ambiguous.
Sources: https://www.ptc.com/ and https://investor.ptc.com/resources/news/news-details/2013/PTC-Updates-Name-to-Reflect-Expanded-Scope-and-Vision/default.aspx — `HIGH` (existence)

**Claim 6.4 — Second cross-industry collision: PTC Therapeutics** (Nasdaq: PTCT), a biopharma company, surfaced repeatedly when searching the bare acronym. — `MEDIUM`

**Claim 6.5 — A derived acronym already exists: sPTC** (speculative programmatic tool calling), coined by Alex L. Zhang. Source: https://alexzhang13.github.io/blog/2026/spec-ptc/ — `LOW`

**Honest negative result:** I searched specifically for a competing *agent-tooling* expansion of "PTC" and **found none**. The realistic ambiguity is therefore (a) cross-industry (PTC Inc. / PTC Therapeutics) and (b) PTC-vs-Code-Mode conflation, not an in-domain acronym clash. I did not verify any source claiming "PTC" means something else in agent tooling, so no such claim is made here.

---

## What is contested / uncertain

1. **The accuracy claim is the weakest link.** Anthropic's +11% is described as adding PTC *on top of basic search tools* on agentic-search benchmarks, and it explicitly cross-references the "dynamic filtering" blog — so it bundles more than PTC alone. AWS reports PTC making 6 of 8 models go from wrong to right on a *single task, single run per model*. Against that, the only crossed multi-regime ablation I found (arXiv:2607.10569) reports **pass rates statistically tied across tool surfaces** with the win entirely in cost. Treat "PTC improves accuracy" as vendor-context-specific, not general. — contested
2. **The headline token percentages are not comparable across sources.** Anthropic's 98.7% (150,000 → 2,000) is about *tool-definition* loading for MCP servers; Cloudflare's 99.9% (1.17M → ~1,000) is about exposing a 2,500-endpoint API; Anthropic's PTC figure is 37% (43,588 → 27,297) on real tasks; AWS's is 87–92% on one task. All are defensible; quoting any of them as "PTC saves X%" without the regime is a category error. — uncertain
3. **"Code mode saves tokens" vs "code mode adds round trips."** Arize's counter-argument: a `search`+`execute` surface "only solves the upfront cost… now every step carries an extra `search` call it didn't need before. We've traded a leaner upfront prompt for even more round trips." Whether the net is positive depends on tool-count, data volume, and horizon. — contested
4. **Who "owns" the layer is unresolved.** Arize's caution about duplicating harness-native tool search + code execution is a live architectural question, and Anthropic's own docs warn about two coexisting execution environments confusing the model (Claim 5.11). — uncertain
5. **The security boundary is genuinely unresolved.** Even the best-documented sandboxes are described by their vendors as isolation, not as injection defense; `allowed_callers` is explicitly not enforcement; Vercel's approval flow cannot pause nested calls; and CVE-2026-57141 shows the naive `with()`+blocklist pattern still shipping. I found **no** source claiming a code-mode sandbox eliminates prompt-injection risk, and several explicitly denying it. — uncertain (but well-evidenced)
6. **API drift is fast and third-party docs are stale.** `code_execution_20250825` (launch) → `20260120` (PTC actually enabled) → `20260521` (90 s cell limit surfaced) within ~9 months. Any 2025-dated tutorial should be re-checked against the current docs page. — `HIGH` (verified drift)
7. **Unverified item to flag before quoting:** the CVE-2026-57141 detail comes from an advisory aggregator (Corgea), not from NVD directly. I did not fetch the NVD record, so the CVE id should be cross-checked before it goes into an architecture doc.
8. **Pages with no stated publication date** (so no date is asserted here): OpenAI's PTC guide, Vercel's AI SDK code-mode doc, Glean's Agent Sandbox & PTC page, Union.ai's docs. Retrieval date for all four: 2026-09-15.
