# @basis1/mcp

**The Excel engine for AI agents.** Let AI agents read, check and edit Excel models.

An [MCP](https://modelcontextprotocol.io) server for [Basis](https://basis1.tech). It lets Claude, Cursor and other MCP clients parse Excel workbooks, evaluate formulas, trace dependencies, and open a workbook as a session to change inputs and read results.

**Every tool runs on the Basis API.** You need a Basis API key and a network connection, and the workbooks you give a tool are uploaded to the Basis API at `https://api.basis1.tech`. See [What gets uploaded](#what-gets-uploaded).

## Install

You need Node.js 20.19 or later and a Basis API key, which you create yourself in your account settings at [basis1.tech/settings](https://basis1.tech/settings). Each snippet below starts the server with `npx`, which downloads the package the first time.

One-click install (you'll paste your API key afterwards in Cursor, or be asked for it in VS Code):

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=basis&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBiYXNpczEvbWNwIl0sImVudiI6eyJCQVNJU19BUElfS0VZIjoieW91ci1hcGkta2V5In19)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Basis-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=basis&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22basis-api-key%22%2C%22description%22%3A%22Basis%20API%20key%20%28create%20one%20at%20basis1.tech%2Fsettings%29%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40basis1%2Fmcp%22%5D%2C%22env%22%3A%7B%22BASIS_API_KEY%22%3A%22%24%7Binput%3Abasis-api-key%7D%22%7D%7D)

### Claude Desktop

Open **Settings → Developer → Edit Config** and add this to `claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "basis": {
      "command": "npx",
      "args": ["-y", "@basis1/mcp"],
      "env": {
        "BASIS_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Claude Code

```sh
claude mcp add basis --env BASIS_API_KEY=your-api-key -- npx -y @basis1/mcp
```

Add `--scope user` to use it in every project, or `--scope project` to share it through the project's `.mcp.json`. In a shared file, write `"BASIS_API_KEY": "${BASIS_API_KEY}"` so each person's key comes from their own environment.

### Cursor

Add this to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "basis": {
      "command": "npx",
      "args": ["-y", "@basis1/mcp"],
      "env": {
        "BASIS_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Other MCP clients

Configure a stdio server with the command `npx` and the arguments `-y @basis1/mcp`, and set `BASIS_API_KEY` in its environment. On Windows, if your client can't start `npx` directly, use the command `cmd` with the arguments `/c npx -y @basis1/mcp`.

### Without installing anything: the hosted endpoint

If your client supports remote MCP servers over HTTP with custom headers, you can connect to the hosted endpoint directly instead of running this package:

```json
{
  "mcpServers": {
    "basis": {
      "type": "http",
      "url": "https://api.basis1.tech/mcp",
      "headers": { "Authorization": "Bearer your-api-key" }
    }
  }
}
```

In Claude Code: `claude mcp add --transport http basis https://api.basis1.tech/mcp --header "Authorization: Bearer your-api-key"`.

It offers the same tools, except that it can't read files on your computer: pass a `url` or `base64` instead of a `path`. This package adds `path` support by reading the file on your machine and uploading it for you.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `BASIS_API_KEY` | none (required) | Your Basis API key. Without it the server still starts, and every tool tells you the key is missing. |
| `BASIS_BASE_URL` | `https://api.basis1.tech` | The Basis API to use, for example a self-hosted server. It must use `https://` unless it points at `localhost`, so your key is never sent unencrypted. |
| `BASIS_MCP_MAX_FETCH_BYTES` | `200000000` | The largest workbook a tool will download when you pass a `url`. |

`BASIS_TOKEN`, the old name for the key, still works and logs a reminder to rename it.

If a setting is invalid, the server doesn't start: it writes what to fix to stderr, which your MCP client shows in its server logs (Claude Desktop: **Settings → Developer**, or `~/Library/Logs/Claude/mcp-server-basis.log` on macOS). The server writes diagnostics only to stderr, because stdout carries the MCP protocol, and it never prints your key.

`npx -y @basis1/mcp --help` lists these settings, and `--version` prints the version.

## Tools

Workbook inputs accept exactly one of `path` (a file on your computer), `url` or `base64`.

**Parsing**

- `parse_workbook`: returns the workbook as NDJSON records (`workbook_meta`, `sheet`, `cell`, `edge`, `image`, `image_summary`, `audit`). Large files run as a background job and are polled to completion for you.
- `submit_job`: starts a parse job and returns its handle (`job_id`, `status_url`, `stream_url`) without waiting.
- `get_job_status`: the status of a job.
- `stream_job`: the NDJSON output of a finished job, optionally from record `since`.
- `diff_workbooks`: cell-level differences between two workbooks: added, removed and changed cells (value and/or formula), with format-only changes listed separately. Takes `before_*` and `after_*` inputs and `include_format`.

**Formulas**

- `evaluate_formula`: evaluates one Excel formula against cell values you pass, for example `{"formula": "NPV(0.08,A1:A5)", "data": {"A1": 100, ...}}`. Supports 278 Excel functions, including financial, statistical, lookup and dynamic-array functions.

**Recalculating a file**

- `recalc_workbook`: takes an `.xlsx` (`path`, `url` or `base64`) and returns it with computed values saved in every formula cell, plus the same error summary. Call it after you create or edit a workbook with openpyxl (or any library that saves formulas without results): without it, pandas, openpyxl `data_only=True` and other readers that are not Excel see empty cells. It replaces running LibreOffice's `recalc.py`. Pass `output_path` to write the result on your computer; the same path as the input with `overwrite: true` recalculates a file in place. The file is uploaded for the calculation and not kept.

Both file-returning tools carry over what Basis does not model (styles, charts, images, data validation, conditional formats, defined names, comments, VBA in `.xlsm`) byte for byte. What cannot be kept is listed under `summary.warnings`: per-word formatting inside a cell's text, what-if data tables, and the cached results of multi-cell array formulas. Formulas Basis cannot compute are listed under `summary.uncomputed` instead of being saved blank without notice.

**Workbook sessions.** A session holds one workbook open on the Basis API so you can change it step by step.

- `create_session`: opens a workbook from `path`, `url`, `base64` or your Library (`library_file_id`), or starts a blank one. Optional `calc` turns on iterative calculation. A local `path` travels inside one request, so files over about 24 MB can't open as a session yet; `parse_workbook` handles large files.
- `list_sessions`, `close_session`.
- `set_inputs`: sets values or formulas by defined name or cell reference, recalculates, and reports which named outputs changed.
- `get_outputs`: reads computed values by name, cell reference or range (`Sheet1!H2:H18`), or every defined name.
- `define_variable`: creates or retargets a defined name.
- `add_sheet`: adds a sheet to a blank workbook.
- `rename_sheet`: renames a sheet; formulas, defined names and validations that point at it follow the new name.
- `set_calc_settings`: turns iterative calculation on or off for circular models.
- `inspect_model`: sheets, defined names, calculation settings and statistics, optionally with the dependency graph.
- `get_cell_formula`, `get_formula_range`: formulas and values for one cell or a range.
- `trace_dependencies`: precedents and dependents of a cell, up to 5 levels deep.
- `audit_workbook`: a structural audit (errors, broken references, cycles, named ranges).
- `commit_session`, `restore_session`: named checkpoints and rollback.
- `export_workbook`: recalculates the session and returns it as an `.xlsx` with every formula's computed value saved in the file, plus a summary of formula errors (`#REF!`, `#DIV/0!`, `#NAME?` with sheet and cell). Pass `output_path` to write the file on your computer instead of getting base64 back (`overwrite: true` to replace an existing file).
- `snapshot_session`: the current workbook as `.xlsx` bytes (base64), no summary. Prefer `export_workbook`.
- `save_to_library`: saves the workbook to your Basis Library as a new file or a new version.

Tool errors come back as a tool result with `isError` set and a JSON body `{"code", "message", "status"}`, for example `missing_api_key`, `unauthorized`, `network_error`, `session_not_found` or one of the API's error codes.

## What gets uploaded

- **Parsing and diffing:** the workbook is sent to the Basis API. Parse jobs and their results are kept in the server's memory only and expire after 15 minutes.
- **Formulas:** the formula and the cell values you pass are sent to the Basis API.
- **Sessions:** the workbook is uploaded when you create the session and stays on the Basis API while you work. A session closes after 30 minutes without use, or when you call `close_session`. So that sessions survive server restarts, their state is also checkpointed to private cloud storage, which deletes checkpoints within a day.
- **Library:** `save_to_library` stores the workbook in your Library until you delete it.
- **Files on your computer:** a tool reads a `path` you pass and uploads that file's contents. It reads nothing else.
- **URLs:** this package downloads a `url` you pass to `parse_workbook`, `submit_job` or `diff_workbooks` on your machine and uploads the bytes. For sessions, the Basis API downloads the URL itself.

All traffic uses HTTPS, with your API key in the `Authorization` header. If your workbooks can't leave your machine, don't use this server with them.

## Development

From a checkout of this repository:

```sh
(cd ../sdk && npm ci && npm run build)  # @basis1/parse, linked as file:../sdk
npm ci
npm run build                            # typecheck, then bundle dist/index.js
npm test                                 # unit, hosted forwarding and stdio handshake tests
npm run test:pack                        # pack, install in a temp dir, MCP handshake over stdio
```

To run your build against another Basis server, for example a self-hosted one:

```sh
BASIS_API_KEY=devtoken BASIS_BASE_URL=http://localhost:8080 node dist/index.js
```

### How the package is built

`dist/index.js` is a single esbuild bundle that includes `@modelcontextprotocol/sdk` and `zod` (both MIT). As runtime dependencies they would install 95 packages (23 MB) on every first `npx` run, including web-server frameworks a stdio server never uses. Bundled, `npx` installs two packages and runs the exact versions we tested. Their license texts ship in `dist/THIRD_PARTY_LICENSES.txt`, and the build fails if a bundled package isn't permissively licensed.

`@basis1/parse` is a real runtime dependency, not bundled. In the repository it's `file:../sdk`. The release process rewrites that to `^<sdk version>` before publishing, and `scripts/check-publishable.mjs` refuses a package that still has a local path.

### Releasing

Releases are published by the maintainers. When a change touches both packages, the SDK is released first, then the MCP server, which depends on the published SDK version. `version` is kept in sync between `package.json` and `server.json`.

### MCP Registry

`server.json` describes this server for the [MCP Registry](https://registry.modelcontextprotocol.io) as `tech.basis1/mcp`, and `mcpName` in `package.json` links the npm package to it. The `tech.basis1/` namespace belongs to the basis1.tech domain rather than a personal GitHub account, so the registry verifies it through DNS. Nothing is submitted automatically.

The maintainers list each release in the registry after the npm publish, signing in with `mcp-publisher login dns --domain basis1.tech`. The `tech.basis1/` namespace is verified through a DNS record on basis1.tech.

## License

Apache-2.0. See [LICENSE](LICENSE).
