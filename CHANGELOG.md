# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-11

### Added

- `mcp-footprint -- <command>`: starts an MCP server over stdio, runs `initialize`, follows `tools/list` pagination, lists prompts and resources when advertised, and stops the server's whole process group. One deadline (`--timeout`) covers the session.
- `--from-json`: measures a saved tools/list result without starting a process. `--save-tools` writes one.
- Counting modes: `o200k` (default, via js-tiktoken), `anthropic` (the count_tokens endpoint, by difference; tested against a mocked fetch only), and a labelled `chars4` estimate.
- Report: per-tool tokens and share sorted by cost, longest descriptions, deepest and biggest schemas, total. `--json` and `--out` for machines.
- `--budget`, with exit codes 0 ok, 1 over budget, 2 error, 130 interrupted.
- Composite GitHub Action (`action.yml`) for a budget in CI.
- Measured reports for four official reference servers, and a README table generated from them.

[0.1.0]: https://github.com/Binarysite/mcp-footprint/releases/tag/v0.1.0
