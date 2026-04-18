# PDF build

Stateless pipeline: Paper → MCP → React → Chrome headless → optimised PDF.

**Paper is the source of truth.** Never commit a `.jsx` file of pages. If a design needs to change, change it in Paper.

## Quick start

```sh
inkpot pdf --list          # list all artboards in the current Paper file
inkpot pdf vp              # frames vp/1, vp/2, ... → vp.pdf
inkpot pdf ww -o web.pdf   # custom output path
inkpot pdf vp --keep       # keep scratch files for debugging
```

Frames must be named `<prefix>/<number>` in Paper (e.g. `vp/1`, `vp/2`). Legacy space-separator (`WW 2`) also matches. Numbers sort numerically.

Requires Paper running locally with the MCP server at `http://127.0.0.1:29979/mcp` (override with `--mcp-url`).

Typical result: a 17-page text-and-bloom deck goes from ~21 MB (naïve Chrome print) to ~3 MB with no visual regression.

## Pipeline flow

```
 Paper MCP
    │  get_basic_info → artboard list
    │  get_jsx        → one JSX body per frame
    ▼
 normalizeFonts       map Paper's internal names → Google Fonts
 buildJsxFile         wrap bodies in <Pages>, write _generated_*.jsx
 esbuild              bundle → _generated_*.cjs
 node cjs             React SSR → _generated_*.html
 ───────────────────────── image optimisation ─────────────────────────
 optimizeBlooms       CSS radial-gradient()+filter:blur → shared PNG XObjects
 embedRemoteImages    Paper CDN URLs → inline data URIs
 optimizeImages       entropy-classified photo/bloom compression
 ────────────────────────────────────────────────────────────────────
 Chrome headless      --print-to-pdf → final PDF
 cleanup              remove _generated_* (unless --keep)
```

## Modules

### `src/pdf.js`
Orchestrator for `inkpot pdf`. MCP client, frame resolution, font normalization, HTML assembly, Chrome invocation, cleanup. Also exports helpers (`fetchJsxBodies`, `renderOptimizedHtml`, `printHtmlToPdf`, `resolveFrameOrPrefix`) reused by `src/form.js`.

Tunable spots:
- `FONT_LINKS` — Google Fonts stylesheet link (keep in sync with the `DMSans-*` / `Paper Mono Preview` / `Inter Tight` mappings in `normalizeFonts`).
- `CHROME_PATHS` — where we look for Chrome; pass `--chrome <path>` to override at runtime.
- `@page` size (inside `buildJsxFile`) — currently fixed at 832×1178 px to match Paper artboards.

### `optimizeBlooms.js`
Paper emits blooms as `background-image: radial-gradient(circle farthest-corner at 50% 50% in oklab, ...)` paired with `filter: blur(…)` and `border-radius: 50%`. Chrome rasterizes the blurred output at print DPI (~300 DPI), producing ~1 MB per bloom instance.

This pass:
1. Finds every radial-gradient with an alpha-falloff stop (`color … 0%, color … 65%` with ≥1 transparent stop).
2. Parses the gradient, converts any oklab colours to sRGB (proper L·a·b → linear-sRGB → gamma-encoded conversion — see `oklabToSRGB`).
3. Renders a 512 px SVG with `userSpaceOnUse` radial gradient at `r = diagonal/2` (matches CSS `circle farthest-corner`).
4. Applies a Gaussian blur (`BLOOM_BLUR_SIGMA = 14`) to bake in the CSS `filter: blur()` softness.
5. PNG-encodes (compressionLevel 9).
6. Replaces `radial-gradient(...)` with `url(data:image/png;base64,...)`, **and strips `filter: blur(...)` + `border-radius: 50%`** from the same element (both create per-element rasterisation or hard clip edges).
7. Ensures `background-size: 100% 100%` so the square PNG stretches to fill the element (CSS gradients fill 100% by default; `url(...)` backgrounds don't).

Because the PNG bytes are deterministic from the gradient string, Chrome's Skia PDF backend hashes identical data URIs to **one shared XObject** — 40 bloom instances collapse to ~6 unique image streams.

Tunable: `BLOOM_SIZE` (PNG dimensions), `BLOOM_BLUR_SIGMA` (soft edge amount).

### `embedRemoteImages` (`embedRemotes.js`)
Paper inlines large image assets as `https://app.paper.design/file-assets/<id>/<file>` URLs. If left, Chrome fetches them at native resolution during print.

This pass parallel-fetches every unique CDN URL, converts to a `data:<mime>;base64,...` URI, and replaces in-place. Failures are logged and left as-is (Chrome will fetch them normally).

Tunable: extend `CDN_RE` if other hosts appear.

### `optimizeImages.js`
Final pass over all `data:image/...` URIs (blooms from pass 1, photos from pass 2). Classifies each by Shannon entropy:

- **Entropy < 4.5** → bloom-class. Compress as palette PNG (if alpha) or low-q JPEG.
- **Entropy ≥ 4.5** → photo-class. Cap width at 2× page width, JPEG q88 (or PNG if alpha preservation needed).
- **Buffer < 4 KB** → skip (icons/line art).
- **New size ≥ original** → skip (already optimal, avoid double-encode).

Tunable knobs at the top of the file: `PAGE_WIDTH_PX`, `BLOOM_MAX_WIDTH`, `PHOTO_MAX_WIDTH`, `BLOOM_ENTROPY_THRESHOLD`, `BLOOM_JPEG_QUALITY`, `BLOOM_PNG_COLORS`, `PHOTO_JPEG_QUALITY`, `SKIP_UNDER_BYTES`.

## Flags

- `-o, --output <path>` — PDF output path (default `<prefix>.pdf`)
- `--list` — print artboards and exit
- `--mcp-url <url>` — override MCP endpoint
- `--keep` — retain `_generated_*` intermediate files for debugging
- `--chrome <path>` — override Chrome binary path

## Gotchas & troubleshooting

**"fonts look wrong"** — Paper emits internal names like `"DMSans-9ptRegular_Regular"`. `normalizeFonts` remaps those to Google Fonts families. When Paper adds a new font variant, the fallback stack kicks in; check the console for `DMSans-…` leaks in the generated HTML and extend `normalizeFonts`.

**"blooms look like hard circles"** — the bloom pass didn't strip `filter: blur` or `border-radius: 50%`. Check that `optimizeBlooms` actually matched those elements. Signal: the element's style attribute contains BOTH a `radial-gradient(...)` and `filter: blur(...)` in the emitted HTML.

**"photos look crushed"** — raise `PHOTO_JPEG_QUALITY` (default 88) or raise `PHOTO_MAX_WIDTH` (default 2 × page width).

**"bloom file size regrown"** — check Chrome isn't being forced to rasterise per-element. Any `filter`, `backdrop-filter`, `transform: … rotate3d`, `clip-path`, or `mix-blend-mode` on a background-image element forces rasterisation.

**"MCP connection refused"** — Paper isn't running, or the MCP server is on a different port. Open Paper, check the MCP port (defaults to 29979), or pass `--mcp-url`.

**"new Paper JSX pattern crashes the build"** — add a normalization step in `src/pdf.js` → `normalizeFonts` or a new `normalize*` helper. Don't hand-write JSX.

## Design invariants

- **One stateless tool.** No persistent `pages.jsx` in the repo; no per-project config files.
- **Paper is the source of truth.** Layout changes in Paper, not here.
- **Frame naming is the manifest.** `<prefix>/<n>` sorted numerically; no "variant" system.
- **Bloom dedup is deterministic.** Same gradient string must produce byte-identical PNG. Don't introduce randomness (timestamps, rng) into `renderBloomPng`.
- **Photos → JPEG, blooms → PNG (if alpha).** Don't JPEG-encode things with partial transparency — you'll get a grey/white halo.

## Dependencies

- `@modelcontextprotocol/sdk` — Paper MCP client
- `esbuild` — JSX→JS bundling
- `react` / `react-dom` — SSR
- `sharp` — image decoding, resizing, encoding, blur, entropy/stats
- `zod` — (transitive, from MCP SDK)

Run `npm install` if `node_modules/` is missing.
