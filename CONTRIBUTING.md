# Contributing

Issues and pull requests are welcome. For anything larger than a fix, open an issue first so we can agree on the shape.

## Setup

```sh
npm ci
npm test          # compiles src/, test/ and scripts/ to build/ and runs node:test
npm run coverage  # the coverage floor CI enforces: 95% lines, 90% branches, 95% functions
npm run lint
npm run typecheck
```

Node.js 22 or newer. Re-measuring the reference servers needs Node 24, their minimum.

## Rules

- Every published number comes from a committed report. Change reports only with `npm run measure:reference`, then run `npm run readme`. Tests fail if the README, the reports and the raw tools/list results disagree.
- To add a reference server, add it to `SERVERS` in `scripts/measure-reference.ts`. It must be an official `@modelcontextprotocol` server that starts without credentials.
- Estimates are never printed without their label.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
- New behavior comes with a test. Process handling is tested against real processes in `test/integration.test.ts`, not mocks.
