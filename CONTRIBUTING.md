# Contributing

Thanks for helping improve the Basis clients. Bug reports, fixes and documentation improvements are all welcome.

## Before you start

- **Security issues:** don't open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Bigger changes** (a new SDK method, a new MCP tool, a change to configuration): open an issue first so we can agree on the shape. Both packages mirror the hosted API, so some changes need the API to change first.

## Making a change

1. Fork the repository and branch from `main`.
2. Build and test the package you changed (the MCP server needs the SDK built first):
   ```sh
   (cd sdk && npm ci && npm run build && npm test && npm run test:pack)
   (cd mcp && npm ci && npm run build && npm test && npm run test:pack)
   ```
3. Add or update tests for the behavior you changed, and update the package README if it affects users.
4. Open a pull request describing what changed and why.

## Tests and releases

- Some contract tests run in Basis's private engine repository instead of here: they check the SDK's types and the MCP tool catalog against the engine's real output and the hosted server, which aren't part of this repository. The tests in this repository run without them.
- Releases are published by the maintainers.

## Ground rules

- Keep runtime dependencies to a minimum. Any dependency must be permissively licensed (Apache-2.0, MIT, BSD or ISC); the MCP build fails if a bundled one isn't.
- Never commit API keys, real customer workbooks or other private data. Test fixtures must be made-up workbooks.
- By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
