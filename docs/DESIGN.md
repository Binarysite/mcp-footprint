# Design

The decisions that shape mcp-footprint, and what each one costs.

## The transport owns the server's process group

The SDK's `StdioClientTransport` (in `@modelcontextprotocol/client` 2.4.0) spawns the server and stops it with `proc.kill()`, which signals only that process. Servers are often started through a wrapper (`npx`, `sh -c`, `uv run`), so the process the SDK signals is not the one holding the pipes, and a timeout can leave the real server running.

`ProcessTransport` (src/stdio.ts) spawns the server with `detached: true`, which makes it the leader of a new process group, and sends every signal to the group. Shutdown is the sequence the MCP stdio spec describes: close stdin, wait, SIGTERM, wait, SIGKILL. After that the group is swept with SIGKILL even if the leader exited on its own. The integration test uses a server that ignores SIGTERM and starts a grandchild that ignores it too, so the test passes only if the SIGKILL reaches the whole group.

Cost: under 200 lines that duplicate part of the SDK, built on its `ReadBuffer` and `serializeMessage`. Process groups are POSIX; on Windows only the direct child is signalled, and nothing runs there in CI.

## One deadline for the whole session

`--timeout` covers spawn, `initialize` and every list call together, instead of a timeout per request. A server that answers each request just under a per-request limit can otherwise hold CI for minutes. Each step also races against the server's exit, so a crash is reported at once with the tail of its stderr instead of after the deadline.

Cost: a slow but healthy server with many pages needs a larger `--timeout`.

## Pages are walked by hand

`Client.listTools()` without a cursor aggregates every page, but it can also remove tools whose `x-mcp-header` declarations it considers invalid, and it does not report how many pages there were. mcp-footprint calls `client.request({ method: 'tools/list', params: { cursor } })` per page, so the measurement is exactly what the server sent. A cursor seen twice or more than 1,000 pages is an error rather than a hang. An empty-string cursor ends the list, because some servers send `""` instead of omitting the field.

Cost: this depends on the SDK's lower-level `request()` signature, which is more likely to change than `listTools()`.

## The client is `@modelcontextprotocol/client`, not `@modelcontextprotocol/sdk`

The v1 SDK package carries the server side too. Installed on its own, `@modelcontextprotocol/sdk` 1.32.2 brings 95 packages, including express and hono. mcp-footprint's whole runtime tree, the v2 client and js-tiktoken included, is 15 packages.

Cost: v2 is newer. It also ships a 2026-era negotiation path; mcp-footprint keeps the default legacy `initialize` handshake, which every current server answers.

## What gets counted

A tool is reduced to `{"name", "description", "input_schema"}` and serialized as compact JSON, then each tool is counted on its own and the total is the sum. This is the Anthropic Messages API shape. OpenAI's function shape carries the same three fields under other names.

Cost: providers do not tokenize this JSON. They render tool definitions into an internal format first and add a fixed preamble, so the billed number is different and provider-specific. The o200k count is exact for the JSON and should be read as a size to compare servers by and to budget against, not as a bill. Counting tools one by one also differs by a few tokens from counting the joined array, which is why the total is defined as the sum: shares then add up to 100%.

## o200k is the default and the only published mode

It runs offline, needs no key, and gives the same number on every machine, which a CI budget requires. The rank table (2.3 MB) is loaded only when the mode is used.

Cost: it is not Claude's tokenizer. The `anthropic` mode exists for that, and is never used for the published numbers.

## Anthropic mode measures differences

The endpoint returns a whole request's input size. The total is `count(probe + all tools) - count(probe)`, which includes the tool-use preamble the API adds. Per tool is `count(all) - count(all but this one)`, the tokens that removing that tool would save. The remainder is printed as overhead, so nothing is spread over tools that did not cause it.

Cost: n + 2 requests for n tools, four at a time, with retries on 429 and 5xx. With a single tool the overhead cannot be separated and is attributed to that tool.

## Prompts and resources are outside the total

They are listed and counted when advertised, on their own lines. Clients show them to the user and pull one into the context on demand, so they are not part of the cost of every request.

## Reports carry their inputs

Each file in reports/ holds the raw tools/list result next to the numbers, plus the package's npm integrity hash. A test re-measures the raw result and requires an exact match, and another regenerates the README table and the sample output and requires that they match too. A change to the serializer or the tokenizer that would make a published number wrong fails CI instead.

Cost: 6 to 41 KB of JSON per server in the repository.

## The action builds from source

`action.yml` runs `npm ci` in the action's checkout, and the `prepare` script compiles TypeScript. No compiled code is committed, and a release is a tag.

Cost: each run installs the dev dependencies, which takes a few seconds and needs network access to the npm registry.

## The client declares no capabilities

mcp-footprint asks for nothing, which is the honest baseline for "what does this server cost". Some servers register tools only for clients that support sampling, elicitation or roots; `server-everything` adds five. Those tools are not counted, and the README says so next to that row.
