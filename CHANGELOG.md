# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-11-11

### Changed

- JSON report: `counter.exact` is replaced by `counter.tokenizer` (`"o200k_base"`, `"anthropic-count_tokens"`, or `null` for chars/4) and `counter.billed` (always `false`: no mode reproduces a bill). `exact: true` on the o200k count read as a promise about billing. Pre-1.0, so a minor-level shape change; a `--baseline` file written by 0.2.0 still loads, since only `counter.mode` is read from it.
- Reference reports re-measured with 0.2.1; the counts are unchanged.

### Fixed

- Shutdown no longer replaces the real error with `unexpected error: kill EPERM`. macOS returns EPERM when the process group holds only zombies; it is now treated like ESRCH (already gone).
- `--baseline`: tools that share a name are compared one to one instead of collapsing into the last one.

### Added

- Pagination stops with an error after 100,000 items across pages, so a server with endless pages cannot fill memory before `--timeout`.

## [0.2.0] - 2026-11-11

### Changed

- The o200k label now reads "o200k_base tokens of each tool's JSON (a comparable size, not any provider's billed count)" in the text report, the JSON report, the README and the reference reports. It used to call the count exact, which invited reading it as a bill.
- `--count anthropic` needs `--experimental`: it has only been tested against a mocked API.
- The README sample installs the current release; the release that took the measurement is named only in the note under the table.
- The README no longer implies a direction between o200k and Claude counts; it quotes what Anthropic's token-counting page does say.

### Added

- `--baseline <report.json>` compares with an earlier report: total and per-tool change, tools added and removed, in the text report and as `baseline` in `--json`. `--budget` still applies to the total.
- Action: an optional `baseline` input. The change heads the job summary and is set as the `delta` output. No pull-request comment is posted.
- Reference reports for `@playwright/mcp` 0.0.85, `@notionhq/notion-mcp-server` 2.6.1 and `@upstash/context7-mcp` 4.6.0. `@sentry/mcp-server` and `@supabase/mcp-server-supabase` need credentials to list tools; `@stripe/mcp` and the Browserbase servers are deprecated on npm. They are listed under the README table, not measured.
- A warning when two tools share a name, in the text report and in `warnings` in the JSON report.

### Fixed

- A tools/list result nested too deep for the SDK's validator is reported as such, not as "Maximum call stack size exceeded".
- An invalid tool schema is reported by its first problem and a count of the rest, instead of a dump of every issue.
- Counting is no longer quadratic on long runs of one character (10 KB of `a` took 6.5 s, 40 KB more than 80 s). The o200k merge now uses a priority queue over js-tiktoken's rank table; the ids are unchanged.
- `--timeout` now bounds the whole run, counting included: o200k counting runs in a worker thread that is terminated at the deadline.
- A tool definition over 64 KB of JSON is refused with exit 2.
- A server that writes without ever ending a line is stopped once 64 MB are pending, instead of growing memory without limit.
- After a timeout or other failure, shutdown waits 200 ms per step instead of 2 s, so the run ends within about `--timeout` + 0.5 s.

## [0.1.1] - 2026-11-11

### Security

- `--count anthropic`: the base URL (`ANTHROPIC_BASE_URL`) is validated once. Only `https:` is accepted (`http:` only for localhost, 127.0.0.1 and [::1]), and a URL with embedded credentials is rejected. Redirects are never followed, so the `x-api-key` header cannot be replayed to another host.
- `--count anthropic`: `retry-after` is clamped to 30 s, the HTTP-date form is understood, and an unparsable value falls back to the default delay. Each request has a deadline (`--timeout`) and retry waits stop on Ctrl-C.
- A tool schema nested tens of thousands of levels deep no longer overflows the stack when measuring depth; one too deep to serialize is reported as an error. A very large `tools/list` page no longer overflows it either.
- The text report and error messages replace terminal control characters in server- or file-supplied text (tool, server, path and command names) with U+FFFD and truncate long names, so a hostile server cannot clear the screen, retitle the terminal or forge report rows. JSON output is unchanged.

## [0.1.0] - 2026-11-11

### Added

- `mcp-footprint -- <command>`: starts an MCP server over stdio, runs `initialize`, follows `tools/list` pagination, lists prompts and resources when advertised, and stops the server's whole process group. One deadline (`--timeout`) covers the session.
- `--from-json`: measures a saved tools/list result without starting a process. `--save-tools` writes one.
- Counting modes: `o200k` (default, via js-tiktoken), `anthropic` (the count_tokens endpoint, by difference; tested against a mocked fetch only), and a labelled `chars4` estimate.
- Report: per-tool tokens and share sorted by cost, longest descriptions, deepest and biggest schemas, total. `--json` and `--out` for machines.
- `--budget`, with exit codes 0 ok, 1 over budget, 2 error, 130 interrupted.
- Composite GitHub Action (`action.yml`) for a budget in CI.
- Measured reports for four official reference servers, and a README table generated from them.

[0.2.1]: https://github.com/Binarysite/mcp-footprint/releases/tag/v0.2.1
[0.2.0]: https://github.com/Binarysite/mcp-footprint/releases/tag/v0.2.0
[0.1.1]: https://github.com/Binarysite/mcp-footprint/releases/tag/v0.1.1
[0.1.0]: https://github.com/Binarysite/mcp-footprint/releases/tag/v0.1.0
