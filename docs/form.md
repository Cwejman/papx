# papx form

`papx form <arg>` builds a fillable PDF from Paper artboards. Any Text node whose **layer name** matches the pattern `{field:<key>}` becomes an AcroForm text field at the node's rendered position; the node's current text is the field's default value.

```sh
npx papx form vp-contract              # prefix → pages vp-contract/1, /2, ...
npx papx form "Asya v11"               # exact artboard name
npx papx form GQL-0                    # node id
npx papx form GQL-0 -o contract.pdf    # custom output path
```

## How it works

1. **Scan.** Walk the artboard(s) for descendants whose layer name matches `^\{field:(.+)\}$`. Collect key, preview text, and computed styles.
2. **Mark.** Inject `data-field-key="<key>"` on the `<div>` wrapping each field in the rendered React JSX (matched by the preview text).
3. **Measure.** Run Chrome headless with `--dump-dom` on the rendered HTML. A small inline script writes each field's page-relative bbox into a hidden `<pre>` element.
4. **Print.** Run Chrome with `--print-to-pdf` to produce the base PDF; `@media print { [data-field-key] { visibility: hidden } }` removes the baked field text so the AcroForm overlay provides the visible text.
5. **Overlay.** `pdf-lib` opens the base PDF, embeds DM Sans Regular + Medium, and inserts an AcroForm text field at each measured bbox (CSS px × 0.75 = PDF pt, Y flipped).

## Naming convention

| Layer name | What happens |
|---|---|
| `{field:arbetstagare.namn}` | AcroForm text field with name `arbetstagare.namn` |
| `{field:befattning}` | AcroForm text field with name `befattning` |
| anything else | Static design; left untouched |

Dotted keys are preserved verbatim — useful for grouped fill/export in a downstream pipeline.

## Typography

DM Sans (Regular 400 + Medium 500) is embedded from `@fontsource/dm-sans`. Field weight is picked from each node's computed `fontWeight` (≥ 500 → Medium). Color defaults to `#1A1712`.

**Viewer caveat:** macOS Preview regenerates AcroForm appearances with its own system font regardless of the embedded font, so fields visually render Helvetica-ish there. Adobe Acrobat Reader respects the embedded DM Sans.

## Gotchas

- **Text must be unique within the artboard.** Matching is by preview-text substring; two fields with identical text will collide. If that happens, vary the preview values or give the field a fixed-width container.
- **Paper's "hug contents" sizing.** Auto-sized text nodes produce a bbox that fits the preview — a longer filled value will overflow visually. Set an explicit width on the text node's container in Paper.
- **One-level measurement.** `closest('.page')` determines which PDF page a field lands on, so nested `.page` wrappers will confuse the measurement script.
- **Multi-page forms.** Supported in principle (the bbox includes `page`), but untested on multi-page documents; single-page contracts are the primary use case.

## Flags

| Flag | Default | Description |
|---|---|---|
| `-o, --output <path>` | `<arg>.pdf` | Output PDF path |
| `--mcp-url <url>` | `http://127.0.0.1:29979/mcp` | Paper MCP endpoint |
| `--keep` | off | Keep intermediate `_generated_*` files |
| `--chrome <path>` | auto-detect | Override Chrome binary path |
