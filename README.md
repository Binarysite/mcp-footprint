# mcp-footprint

[![ci](https://github.com/Binarysite/mcp-footprint/actions/workflows/ci.yml/badge.svg)](https://github.com/Binarysite/mcp-footprint/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Binarysite/mcp-footprint/actions/workflows/codeql.yml/badge.svg)](https://github.com/Binarysite/mcp-footprint/actions/workflows/codeql.yml)
[![release](https://img.shields.io/github/v/release/Binarysite/mcp-footprint)](https://github.com/Binarysite/mcp-footprint/releases)
![node >=22](https://img.shields.io/badge/node-%3E%3D22-informational)
[![license MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

bundlephobia for MCP servers: how many context tokens a server costs before you type anything, plus a CI budget that fails when its tool definitions grow.

<!-- sample-output:start -->
```text
$ npx github:Binarysite/mcp-footprint#v0.2.1 -- npx -y @modelcontextprotocol/server-memory@2.1.1
memory-server 2.1.1: 9 tools, 1 page
counted with o200k_base tokens of each tool's JSON (a comparable size, not any provider's billed count)

  o200k tokens   share  tool
           289   16.7%  search_nodes
           230   13.3%  open_nodes
           229   13.3%  read_graph
           205   11.9%  delete_relations
           197   11.4%  create_entities
           161    9.3%  create_relations
           148    8.6%  add_observations
           139    8.0%  delete_observations
           130    7.5%  delete_entities
         1,728  100.0%  total

longest descriptions  search_nodes (389 chars), delete_relations (378 chars), open_nodes (373 chars)
deepest schemas       add_observations (depth 7), create_entities (depth 7), delete_observations (depth 7)
biggest schemas       search_nodes (882 chars), read_graph (727 chars), open_nodes (621 chars)

resources  1, 35 o200k tokens (not in the total)
```
<!-- sample-output:end -->

This output is generated from [reports/server-memory.json](reports/server-memory.json), and a test fails if the two drift apart. The server in this command, `@modelcontextprotocol/server-memory` 2.1.1, needs Node.js 24 (its `engines` field says `>=24`); mcp-footprint itself runs on Node.js 22 or newer.

## Why

Every tool an MCP server exposes is sent to the model with each request, as a name, a description and a JSON Schema. That cost is paid before the first message.

Claude Code's `/context` already shows per-server usage once a server is installed, and tool search (deferred loading) cuts the cost on platforms that support it. mcp-footprint covers the two cases those do not: comparing servers before you install them, and letting server authors fail CI when their tool definitions grow.

## Use

mcp-footprint runs on Node.js 22 or newer; CI tests it on 22 and 24. The server you start must run on the same Node: the `@modelcontextprotocol` reference servers, including `server-memory` in the first command, need Node.js 24. `--from-json` starts no server and works on 22.

```sh
# Start a server over stdio, list its tools, stop it, print the report
npx github:Binarysite/mcp-footprint#v0.2.1 -- npx -y @modelcontextprotocol/server-memory@2.1.1

# Measure a saved tools/list result, with no process at all
npx github:Binarysite/mcp-footprint#v0.2.1 --from-json tools.json

# Fail when the tool definitions cost more than 3,000 tokens
npx github:Binarysite/mcp-footprint#v0.2.1 --budget 3000 -- node dist/index.js

# Show what changed since a report saved earlier with --out
npx github:Binarysite/mcp-footprint#v0.2.1 --baseline main.json -- node dist/index.js
```

With `--baseline`, the report ends with the change, size-limit style:

```text
baseline   +36 tokens (+10%) vs test/fixtures/baseline.json
           search_issues +24; 1 tool added
```

Everything after `--` is the server command, passed through untouched.

| Option | |
| --- | --- |
| `--count <mode>` | `o200k` (default), `anthropic` or `chars4` |
| `--budget <tokens>` | exit 1 when the total is above this |
| `--baseline <file>` | compare with an earlier `--json` report: total and per-tool change, also in `--json` as `baseline`. `--budget` still applies to the total |
| `--json` | print the report as JSON |
| `--out <file>` | also write the JSON report to a file |
| `--save-tools <file>` | write the server's raw tools/list result, for `--from-json` later |
| `--timeout <ms>` | deadline for the whole run: starting the server, listing, and counting (default 30000). After a timeout the server gets 200 ms to exit, then 200 ms after SIGTERM, so the run ends within about the timeout plus 0.5 s |
| `--model <id>` | model for `--count anthropic` (default `claude-opus-5-5`) |
| `--experimental` | required with `--count anthropic`; see below for why |
| `--verbose` | pass the server's stderr through |

`--from-json` accepts a bare array of tools, a tools/list result (`{"tools": [...]}`) or a JSON-RPC response (`{"result": {"tools": [...]}}`).

Exit codes: `0` ok, `1` over budget, `2` usage, server or API error, `130` interrupted.

## In CI

A composite action, used like size-limit. It needs Node.js 22 or newer on the runner, or 24 if `command` starts one of the `@modelcontextprotocol` reference servers. Actions are pinned by commit SHA, the same ones this repository's CI uses.

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
- uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
  with:
    node-version: 22
- run: npm ci && npm run build
- uses: Binarysite/mcp-footprint@6a5bd700a574e6be53a239c1fb07a0fc8d160cd6 # v0.2.1
  with:
    command: node dist/index.js
    budget: 3000
```

The step fails when the total goes over `budget`, writes the report to the job summary, and sets the `tokens` and `report` (JSON path) outputs. Give it `baseline: <path to an earlier report>` and the change against it heads the job summary and is set as the `delta` output; the budget still applies to the total. The action does not comment on pull requests, because that needs a token with write access; keep a baseline report from your default branch (for example as a committed file or a downloaded artifact) and pass its path. Use `from-json` instead of `command` to measure a committed tools/list result. This repository's CI runs the action against its fixture server on every push, including a run that must fail.

## Reference servers

Servers published under their vendor's own npm scope that list their tools without credentials, pinned to exact versions: the reference servers from `@modelcontextprotocol`, plus Microsoft's Playwright server, Notion's and Upstash's Context7. Before a package was added, `npm view <package> repository.url maintainers` was checked to confirm the repository and publishers belong to the vendor. Each was installed with `--ignore-scripts` and started with an empty temp dir as its working directory and `HOME`, and only `PATH` in its environment. The filesystem server was given that empty dir as its one allowed directory. All were measured on Node.js 24, because the four `@modelcontextprotocol` servers declare `engines: >=24`; the others declare 18 or newer (Playwright), 20.18.1 or newer (Context7) or nothing (Notion). mcp-footprint itself needs only 22. Each report holds the npm integrity hash, the full report and the raw tools/list result; a test re-measures the raw result and requires the committed numbers to match.

<!-- reference-table:start -->
| Server | Version | Tools | o200k tokens | Most expensive tool | Report |
| --- | ---: | ---: | ---: | --- | --- |
| `@notionhq/notion-mcp-server` | 2.6.1 | 24 | 17,140 | `API-update-page-markdown` (1,267) | [notion-mcp-server.json](reports/notion-mcp-server.json) |
| `@playwright/mcp` * | 0.0.85 | 25 | 3,917 | `browser_take_screenshot` (326) | [playwright-mcp.json](reports/playwright-mcp.json) |
| `@modelcontextprotocol/server-filesystem` | 2.3.0 | 16 | 2,909 | `edit_file` (337) | [server-filesystem.json](reports/server-filesystem.json) |
| `@modelcontextprotocol/server-memory` | 2.1.1 | 9 | 1,728 | `search_nodes` (289) | [server-memory.json](reports/server-memory.json) |
| `@modelcontextprotocol/server-everything` ** | 2.3.0 | 16 | 1,709 | `gzip-file-as-resource` (244) | [server-everything.json](reports/server-everything.json) |
| `@upstash/context7-mcp` | 4.6.0 | 2 | 1,060 | `resolve-library-id` (607) | [context7-mcp.json](reports/context7-mcp.json) |
| `@modelcontextprotocol/server-sequential-thinking` | 2.1.1 | 1 | 488 | `sequentialthinking` (488) | [server-sequential-thinking.json](reports/server-sequential-thinking.json) |

Measured 2026-11-11, Node v24.22.2, o200k_base via js-tiktoken 1.0.21, mcp-footprint 0.2.1.

\* `@playwright/mcp` registers more tools when started with `--caps` (config, network, storage, devtools, vision, pdf, testing, per its README). It was measured with no flags, so they are not counted.

\*\* `@modelcontextprotocol/server-everything` registers five more tools for a client that declares roots, elicitation and sampling (`registerConditionalTools` in its `dist/tools/index.js`). mcp-footprint declares no client capabilities, so they are not counted.

Checked and not measured:

- `@sentry/mcp-server` 0.49.0: needs credentials to list tools (exits during initialize: "Not authenticated. Run 'sentry-mcp auth login' first.")
- `@supabase/mcp-server-supabase` 0.16.1: needs credentials to list tools (exits during initialize asking for a personal access token)
- `@stripe/mcp` 0.3.4: deprecated on npm ("No longer maintained"); not run
- `@browserbasehq/mcp-server-browserbase` 2.4.3: deprecated on npm in favour of `@browserbasehq/mcp`, which is deprecated too (3.0.0, "no longer maintained"); not run
<!-- reference-table:end -->

Regenerate with `npm run measure:reference` (Node 24, the servers' minimum), then `npm run readme`. The other `@modelcontextprotocol` packages are SDK packages, developer tools, MCP Apps examples, or archived servers marked deprecated on npm, and were not run. A server that needs a token just to list its tools cannot be measured this way; it is listed under the table instead of being given credentials.

## How it counts

Each tool is reduced to what a model API receives, `{"name", "description", "input_schema"}`, and serialized as compact JSON. MCP-only fields (`title`, `annotations`, `outputSchema`, `icons`, `_meta`) are dropped. The output always names the counting mode.

- **`o200k`** (default): o200k_base tokens of each tool's JSON, a comparable size, not any provider's billed count. The encoding is OpenAI's o200k_base, as used by GPT-4o, with js-tiktoken's rank table and a merge that is checked against [js-tiktoken](https://github.com/dqbd/tiktoken)'s ids. No provider bills this number: each one renders tool definitions into its own internal format and adds a preamble before tokenizing. Use it to compare servers and to hold a budget. The total is the sum of the per-tool counts.
- **`anthropic`** (experimental, needs `--experimental`): the token-counting endpoint, `POST /v1/messages/count_tokens`, with `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_BASE_URL`). The total is a request with the tools minus the same request without them, so it includes the tool-use preamble the API adds. Per tool is the marginal cost: all tools minus all tools but that one. What is left over is printed as overhead. A server with n tools costs n + 2 requests; the endpoint is free but rate limited. It sits behind `--experimental` because the live call has never been exercised: it is tested against a mocked fetch only, built from the current API docs, so a mistake in how the request is shaped or how the difference is taken would go unnoticed. Every number published in this README uses o200k.
- **`chars4`**: the length of the JSON divided by 4, rounded up. An estimate, labelled as one wherever it appears.

Prompts and resources are listed and counted when a server advertises them, but they are kept out of the total: clients do not send them with every request.

## Limits

- stdio only. HTTP and SSE transports are out of scope for now.
- A single tool definition over 64 KB of JSON is refused (exit 2), and a server that writes 64 MB without a newline is stopped. Real servers are far below both.
- Tokenizers differ, so an o200k number is not a Claude number. Anthropic's [token-counting page](https://platform.claude.com/docs/en/build-with-claude/token-counting) gives no comparison with o200k. It does say that Claude Opus 4.7 and later use a newer tokenizer, on which the same input produces "approximately 30 percent more tokens" than on earlier Claude models, so even two Claude models disagree. Compare servers with one mode, not across modes, and do not convert between them.
- Vendor system-prompt overhead for tool use is not included, except in `anthropic` mode's difference.
- mcp-footprint connects with the 2025-era `initialize` handshake and declares no client capabilities. A server that registers tools only for clients with sampling, elicitation or roots reports fewer tools than a full client sees.
- The server's process group is killed on shutdown (POSIX). On Windows only the direct child is signalled, and CI does not run there.

## Develop

```sh
npm ci
npm test          # build to build/ and run node:test
npm run coverage  # same, with the coverage floor CI enforces
npm run lint
```

[docs/DESIGN.md](docs/DESIGN.md) records the decisions and what they cost.

## License

Built with Claude Code; the design decisions and reviews are mine. MIT, copyright Alfredo Rosadilla.
