# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

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

[0.1.1]: https://github.com/Binarysite/mcp-footprint/releases/tag/v0.1.1
[0.1.0]: https://github.com/Binarysite/mcp-footprint/releases/tag/v0.1.0
