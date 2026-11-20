# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/arsen-dot/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/arsen-dot/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, standard library only — no UI, no outside service, no git binary. It serves git smart HTTP (upload-pack v2 / receive-pack v0), GitHub REST v3, GraphQL v4, and MCP over streamable HTTP, all from one shared in-memory store: repositories, branches, commits, contents, labels, issues, comments, pull requests and merges, with deterministic state exports.

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. There is nothing to install: the program imports `node:http` and its own modules only.

The lifecycle (`main.ts`): bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register` with `{"port": N}`, poll `GET $MAKEFUN_ENV_URL/done` until `{"done": true}`, then exit 0.

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: routing, Bearer auth, request ids.
- `store.ts`: the shared store and git object helpers.
- `gitproto.ts`: pkt-line / pack codecs, upload-pack, receive-pack.
- `rest.ts`: GitHub REST v3.
- `graphql.ts`: GitHub GraphQL v4 executor.
- `mcp.ts`: MCP server (initialize, tools/list, tools/call).

---

<sub>Entered on [make.fun](https://make.fun/?ref=gr5mvssd&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
