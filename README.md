# Basis clients

Open-source clients for [Basis](https://basis1.tech), which parses Excel workbooks, evaluates formulas, traces dependencies and edits workbook models.

| Package | What it is | Docs |
| --- | --- | --- |
| [`@basis1/parse`](https://www.npmjs.com/package/@basis1/parse) | TypeScript SDK for the Basis parsing API | [`sdk/`](sdk/README.md) |
| [`@basis1/mcp`](https://www.npmjs.com/package/@basis1/mcp) | MCP server that gives AI assistants Basis's workbook tools | [`mcp/`](mcp/README.md) |

Both talk to the hosted Basis API (`https://api.basis1.tech`) and need an API key. The Basis engine and hosted service are separate and not part of this repository.

## Quick start

```sh
npm install @basis1/parse
```

```sh
BASIS_API_KEY=… npx -y @basis1/mcp
```

Each package's README covers usage, configuration and what's sent over the network.

## Development

Node 20.19 or later. The MCP server depends on the SDK through `file:../sdk`, so build the SDK first:

```sh
(cd sdk && npm ci && npm run build && npm test)
(cd mcp && npm ci && npm run build && npm test)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

Apache License 2.0. See [LICENSE](LICENSE).
