# Design

The decisions that shape mcp-footprint, and what each one costs.

## The transport owns the server's process group

The SDK's `StdioClientTransport` (in `@modelcontextprotocol/client` 2.4.0) spawns the server and stops it with `proc.kill()`, which signals only that process. Servers are often started through a wrapper (`npx`, `sh -c`, `uv run`), so the process the SDK signals is not the one holding the pipes, and a timeout can leave the real server running.

`ProcessTransport` (src/stdio.ts) spawns the server with `detached: true`, which makes it the leader of a new process group, and sends every signal to the group. Shutdown is the sequence the MCP stdio spec describes: close stdin, wait, SIGTERM, wait, SIGKILL. After that the group is swept with SIGKILL even if the leader exited on its own. The integration test uses a server that ignores SIGTERM and starts a grandchild that ignores it too, so the test passes only if the SIGKILL reaches the whole group.

This duplicates part of the SDK, a couple of hundred lines built on its `deserializeMessage` and `serializeMessage`. Process groups are also POSIX only: on Windows just the direct child gets the signal, and CI never runs there.

## One deadline for the whole session

`--timeout` covers spawn, `initialize` and every list call together, instead of a timeout per request. A server that answers each request just under a per-request limit can otherwise hold CI for minutes. Each step also races against the server's exit, so a crash is reported at once with the tail of its stderr instead of after the deadline.

The catch is a slow but healthy server with many pages, which needs a larger `--timeout` than it would per request.

## Untrusted input is bounded in time and size

A server, or a file handed to `--from-json`, controls every byte that gets counted. Three limits keep one from parking CI:

- js-tiktoken 1.0.21 merges byte pairs by rescanning the whole piece after every merge, which is quadratic on a long run of one character: 10 KB of `a` took 6.5 s, 40 KB more than 80 s. src/o200k.ts keeps js-tiktoken's rank table and split pattern and replaces only the merge with a priority queue (same rule: lowest rank, leftmost on a tie), so 50 KB of `a` takes well under a second. A test compares the ids with js-tiktoken's on a few hundred samples, and the reference reports re-measure to the same numbers.
- Counting runs in a worker thread that is terminated when `--timeout` runs out, measured from the start of the run, so a slow path nobody has found yet still ends at the deadline. A tool whose JSON is over 64 KB is refused before counting.
- stdout is split into lines without recopying the unfinished one, and a line that passes 64 MB stops the server. The SDK's `ReadBuffer` concatenated every chunk onto the pending line, and on overflow it cleared and kept going, so a server that never wrote a newline grew the process to 771 MB in 8 s.

After a timeout or any other failure the server gets 200 ms per shutdown step instead of 2 s, so `--timeout 1500` ends in about 1.9 s rather than 6.

What it takes: a second thread with its own copy of the rank table, loaded as soon as the run starts so that for a live server it overlaps the server's startup. And the merge is our code now, not js-tiktoken's; if the encoding ever changed, it would have to follow.

## Pages are walked by hand

`Client.listTools()` without a cursor aggregates every page, but it can also remove tools whose `x-mcp-header` declarations it considers invalid, and it does not report how many pages there were. mcp-footprint calls `client.request({ method: 'tools/list', params: { cursor } })` per page, so the measurement is exactly what the server sent. A cursor seen twice or more than 1,000 pages is an error rather than a hang. An empty-string cursor ends the list, because some servers send `""` instead of omitting the field.

It leans on the SDK's lower-level `request()` signature, which is more likely to change between releases than `listTools()`.

## The client is `@modelcontextprotocol/client`, not `@modelcontextprotocol/sdk`

The v1 SDK package carries the server side too. Installed on its own, `@modelcontextprotocol/sdk` 1.32.2 brings 95 packages, including express and hono. mcp-footprint's whole runtime tree, the v2 client and js-tiktoken included, is 15 packages.

v2 is the newer line, with less mileage. It also ships a 2026-era negotiation path that mcp-footprint does not use: it keeps the default legacy `initialize` handshake, which every current server answers.

## What gets counted

A tool is reduced to `{"name", "description", "input_schema"}` and serialized as compact JSON, then each tool is counted on its own and the total is the sum. This is the Anthropic Messages API shape. OpenAI's function shape carries the same three fields under other names.

No provider tokenizes this JSON as is. Each renders tool definitions into its own internal format and adds a preamble, so what gets billed is different and provider-specific. The number is labelled "o200k_base tokens of each tool's JSON (a comparable size, not any provider's billed count)" for that reason: a size to compare servers by and to budget against. Counting tools one by one also differs by a few tokens from counting the joined array, which is why the total is defined as the sum; shares then add up to 100%.

## o200k is the default and the only published mode

It runs offline, needs no key, and gives the same number on every machine, which a CI budget requires. The rank table (2.3 MB) is loaded only when the mode is used.

It is not Claude's tokenizer, and Anthropic's docs publish no conversion between the two. The `anthropic` mode exists for that question; it is never used for the published numbers.

## Anthropic mode measures differences

The endpoint returns a whole request's input size. The total is `count(probe + all tools) - count(probe)`, which includes the tool-use preamble the API adds. Per tool is `count(all) - count(all but this one)`, the tokens that removing that tool would save. The remainder is printed as overhead, so nothing is spread over tools that did not cause it.

A server with n tools takes n + 2 requests, sent four at a time and retried on 429 and 5xx. With a single tool the overhead cannot be separated, so it lands on that tool.

The mode needs `--experimental`. It was built from the API docs and tested against a mocked fetch, and nobody has run it against the live endpoint yet; until someone does, its numbers should not look as settled as the o200k ones.

## Prompts and resources are outside the total

They are listed and counted when advertised, on their own lines. Clients show them to the user and pull one into the context on demand, so they are not part of the cost of every request.

## Reports carry their inputs

Each file in reports/ holds the raw tools/list result next to the numbers, plus the package's npm integrity hash. A test re-measures the raw result and requires an exact match, and another regenerates the README table and the sample output and requires that they match too. A change to the serializer or the tokenizer that would make a published number wrong fails CI instead.

The price is repository size: each report is tens of KB of JSON.

## The action builds from source

`action.yml` runs `npm ci` in the action's checkout, and the `prepare` script compiles TypeScript. No compiled code is committed, and a release is a tag.

So every run installs the dev dependencies too. That takes a few seconds and needs the npm registry to be reachable.

## The client declares no capabilities

mcp-footprint asks for nothing, which is the honest baseline for "what does this server cost". Some servers register tools only for clients that support sampling, elicitation or roots; `server-everything` adds five. Those tools are not counted, and the README says so next to that row.
