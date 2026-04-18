# papx

CLI for [Paper](https://paper.design) design tools. Turns artboards into optimised outputs via Paper's local MCP server.

```sh
npx papx pdf vp                     # build vp.pdf from Paper frames vp/1, vp/2, ...
npx papx pdf ww -o web.pdf          # custom output path
npx papx pdf --list                 # list available artboards
npx papx form contract-artboard     # build a fillable PDF (AcroForm)
```

## Commands

| Command | Description |
|---|---|
| `papx pdf <prefix>` | Build an optimised PDF from artboards named `<prefix>/1`, `<prefix>/2`, … — [docs](docs/pdf.md) |
| `papx form <arg>` | Build a fillable PDF; text nodes named `{field:<key>}` become AcroForm text fields — [docs](docs/form.md) |

Run `papx <command> --help` for command-specific flags.

## Install

```sh
npm install -g papx
# or use npx without installing
npx papx pdf vp
```

Requires Node.js ≥ 20, Google Chrome (or Chromium), and [Paper](https://paper.design) running with its MCP server enabled (defaults to `http://127.0.0.1:29979/mcp`).

## Why

Paper is a design tool. This CLI takes your canvas and turns it into shippable outputs without the usual export-to-PDF bloat (a 17-page deck with bloom gradients typically drops from ~21 MB raw to ~3 MB here, with no visual regression — see [docs/pdf.md](docs/pdf.md) for how).

## Design invariants

- **One stateless tool.** No persistent config files, no locally-saved JSX pages. Paper is the source of truth.
- **Frame naming is the manifest.** `<prefix>/<n>` in Paper → pages sorted numerically; no "variant" system.
- **Deterministic optimisation.** Same Paper input → byte-identical intermediate artefacts, so Chrome's Skia PDF backend dedupes shared assets into single XObjects.

## Contributing

Future subcommands slot in as new modules under `src/` with a matching entry in `bin/papx.js` — e.g. `papx fonts`, `papx export`. See `src/pdf.js` for the shape of a command.

## License

MIT — see [LICENSE](LICENSE).
