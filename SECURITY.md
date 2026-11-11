# Security

## Reporting a vulnerability

Report it privately through GitHub's [private vulnerability reporting](https://github.com/Binarysite/mcp-footprint/security/advisories/new) for this repository. Please do not open a public issue. Expect a first answer within 7 days.

## What mcp-footprint runs

- `mcp-footprint -- <command>` executes `<command>` with your environment, the same as starting the server yourself. Only measure servers you would run.
- `--from-json` reads a file and starts no process.
- `--count anthropic` sends the tool definitions (names, descriptions, schemas) to the Anthropic API with the key in `ANTHROPIC_API_KEY`, or to `ANTHROPIC_BASE_URL` if set. The key is sent only in the `x-api-key` header and is never printed or written to a report.
- The GitHub Action passes its inputs to the shell through environment variables, never by expression interpolation into the script.

## Supported versions

Only the latest release gets fixes.
