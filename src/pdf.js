// Paper MCP → PDF generator.
// Exposed as `runPdf(argv)` — the bin/inkpot.js dispatcher forwards its
// subcommand-args here. Also exports low-level helpers reused by
// sibling commands (e.g. form.js).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, accessSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { optimizeImages, formatBytes } from './optimizeImages.js';
import { optimizeBlooms } from './optimizeBlooms.js';
import { embedRemoteImages } from './embedRemotes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
];

export const FONT_LINKS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&family=EB+Garamond:ital,wght@1,400&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">`;

export const PDF_HELP = `Usage: inkpot pdf [options] <prefix>

Fetches frames named <prefix>/1, <prefix>/2, ... from Paper, sorts numerically, and builds an optimised PDF.

Options:
  -o, --output <path>   PDF output path (default: <prefix>.pdf)
  --list                List available artboards and exit
  --mcp-url <url>       MCP endpoint (default: http://127.0.0.1:29979/mcp)
  --page-size <name>    Paper size: A4, A5, or Letter (default: artboard size)
                        Artboard is scaled uniformly to fit.
  --margin <mm>         Inset from paper edge (default: 0, full-bleed)
  --bleed <mm>          Extend page on all sides by <mm> (for pro print handoff)
  --keep                Keep intermediate files
  --chrome <path>       Chrome binary path
  -h, --help            Show this help`;

// Paper sizes in millimetres, portrait.
export const PAGE_SIZES = {
  A4:     { width: 210, height: 297 },
  A5:     { width: 148, height: 210 },
  LETTER: { width: 216, height: 279 },
};

// Full-bleed by default — blooms and backgrounds reach the paper edge.
// Home printers will crop ~3–5mm via their unprintable zone; pass --margin
// to reserve space explicitly.
const DEFAULT_MARGIN_MM = 0;

// Resolve a `--page-size` string to { width, height } in mm. Case-insensitive.
export function resolvePageSize(name) {
  if (!name) return null;
  const key = name.toUpperCase();
  if (!PAGE_SIZES[key]) {
    throw new Error(`Unknown --page-size "${name}". Supported: ${Object.keys(PAGE_SIZES).join(', ')}`);
  }
  return { ...PAGE_SIZES[key], name: key };
}

function parsePdfArgs(argv) {
  return parseArgs({
    args: argv,
    options: {
      output: { type: 'string', short: 'o' },
      list: { type: 'boolean', default: false },
      'mcp-url': { type: 'string', default: 'http://127.0.0.1:29979/mcp' },
      'page-size': { type: 'string' },
      margin: { type: 'string' },
      bleed: { type: 'string' },
      keep: { type: 'boolean', default: false },
      chrome: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });
}

// --- MCP Client ---

export async function connectMcp(url) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'inkpot', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

export async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = result.content?.map(c => c.text).join('\n') || 'Unknown error';
    throw new Error(`MCP tool ${name} failed: ${text}`);
  }
  const text = result.content?.find(c => c.type === 'text')?.text;
  return text ? JSON.parse(text) : result.content;
}

// --- Frame resolution ---

export function resolveFrames(artboards, prefix) {
  const matching = [];
  // Match "<prefix>/<num>" or "<prefix> <num>" (slash preferred, space for legacy)
  const separators = ['/', ' '];
  for (const ab of artboards) {
    const name = ab.name;
    for (const sep of separators) {
      if (!name.startsWith(prefix + sep)) continue;
      const numStr = name.slice(prefix.length + sep.length);
      const num = parseInt(numStr, 10);
      if (isNaN(num)) continue;
      matching.push({ name, id: ab.id, number: num, width: ab.width, height: ab.height });
      break;
    }
  }
  if (matching.length === 0) {
    const names = artboards.map(a => a.name).sort();
    console.error(`No artboards matching "${prefix}/*". Available: ${names.join(', ')}`);
    process.exit(1);
  }
  matching.sort((a, b) => a.number - b.number);
  return matching;
}

// Try exact artboard name or id first; fall back to numbered-prefix resolution.
// Returns a list shaped like resolveFrames() output.
export function resolveFrameOrPrefix(artboards, arg) {
  const exact = artboards.find(a => a.name === arg);
  if (exact) return [{ name: exact.name, id: exact.id, number: 1, width: exact.width, height: exact.height }];
  const byId = artboards.find(a => a.id === arg);
  if (byId) return [{ name: byId.name, id: byId.id, number: 1, width: byId.width, height: byId.height }];
  return resolveFrames(artboards, arg);
}

// --- Font normalization ---

export function normalizeFonts(jsx) {
  // Most specific patterns first
  jsx = jsx.replace(
    /Paper Mono Preview, ui-monospace, "SFMono-Regular", "SF Mono", "Menlo", "Consolas", "Liberation Mono", monospace/g,
    '"JetBrains Mono", monospace'
  );
  jsx = jsx.replace(
    /Paper Mono Preview, ui-monospace, monospace/g,
    '"JetBrains Mono", monospace'
  );
  jsx = jsx.replace(/Paper Mono Preview/g, '"JetBrains Mono"');
  jsx = jsx.replace(/Paper Mono \(Preview\)/g, '"JetBrains Mono"');

  // Inter Tight → DM Sans
  jsx = jsx.replace(/"Inter Tight"/g, '"DM Sans"');
  jsx = jsx.replace(/'Inter Tight'/g, "'DM Sans'");
  jsx = jsx.replace(/\\"Inter Tight\\"/g, '\\"DM Sans\\"');

  // Paper's internal optical-size DM Sans names → plain "DM Sans"
  // e.g. "DMSans-9ptRegular_Regular", "DMSans-18ptMedium_Medium", etc.
  jsx = jsx.replace(/"DMSans-[^"]+"/g, '"DM Sans"');

  // System monospace stack (without Paper Mono prefix) → JetBrains Mono
  jsx = jsx.replace(
    /ui-monospace, "SFMono-Regular", "SF Mono", "Menlo", "Consolas", "Liberation Mono", monospace/g,
    '"JetBrains Mono", monospace'
  );

  // Quote CSS custom-property keys in style objects: `{ --foo: 'x' }` → `{ '--foo': 'x' }`
  // JSX/JS object literal keys starting with `--` must be string-quoted.
  jsx = jsx.replace(/([{,]\s*)(--[a-zA-Z0-9-]+)(\s*:)/g, "$1'$2'$3");

  // Collapse literal newlines inside single-quoted strings — Paper emits multi-line
  // CSS values (e.g. gradients) that are invalid JS string literals otherwise.
  jsx = jsx.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/gs, (m, s) =>
    "'" + s.replace(/\s*\n\s*/g, ' ').trim() + "'"
  );

  return jsx;
}

// --- JSX file assembly ---

const PX_PER_MM = 96 / 25.4;
const BASE_CSS = `
  html, body { margin: 0; padding: 0; background: #FAFAFA; font-optical-sizing: auto; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }`;

// Build the page CSS + whether pages need an inner scaling wrapper.
// `paper` null → page matches artboard pixels, no scaling (default behaviour).
// `paper` set → artboard scaled uniformly to fit paper (minus margins/bleed).
export function buildPageShell({ paper, bleedMm = 0, marginMm = 0, artW, artH }) {
  if (!paper) {
    return {
      css: `${BASE_CSS}
  @page { size: ${artW}px ${artH}px; margin: 0; }
  .page { width: ${artW}px; height: ${artH}px; overflow: hidden; position: relative; }`,
      wrapsInner: false,
    };
  }
  const totalW = paper.width + 2 * bleedMm;
  const totalH = paper.height + 2 * bleedMm;
  const innerWpx = (totalW - 2 * marginMm) * PX_PER_MM;
  const innerHpx = (totalH - 2 * marginMm) * PX_PER_MM;
  const scale = Math.min(innerWpx / artW, innerHpx / artH);
  const offX = marginMm * PX_PER_MM + (innerWpx - artW * scale) / 2;
  const offY = marginMm * PX_PER_MM + (innerHpx - artH * scale) / 2;
  // `zoom` (not `transform: scale`) — zoom resizes the layout box so
  // Chrome's print-to-PDF doesn't clip content whose DOM extent exceeds @page.
  return {
    css: `${BASE_CSS}
  @page { size: ${totalW}mm ${totalH}mm; margin: 0; }
  .page { width: ${totalW}mm; height: ${totalH}mm; overflow: hidden; position: relative; background: #FAFAFA; }
  .page-inner { position: absolute; left: ${offX}px; top: ${offY}px; width: ${artW}px; height: ${artH}px; zoom: ${scale}; }`,
    wrapsInner: true,
  };
}

export function buildJsxFile(jsxBodies, htmlOutputPath, extraHeadHtml = '', extraBodyHtml = '', pageLayout = null) {
  const components = jsxBodies.map((body, i) => {
    // get_jsx wraps output in ( ... ) — strip outer parens if present
    let cleaned = body.trim();
    if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    return `const Page${i} = () => (\n    ${cleaned}\n);`;
  });

  const pageList = jsxBodies.map((_, i) => `Page${i}`).join(', ');
  // Fallback artboard dims for callers (e.g. form.js) that don't pass a layout.
  const layout = pageLayout ?? { paper: null, artW: 832, artH: 1178 };
  const { css, wrapsInner } = buildPageShell(layout);

  return `import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'fs';

${components.join('\n\n')}

const Pages = [${pageList}];
const bodies = Pages.map(P => renderToStaticMarkup(React.createElement(P)));
const wrapsInner = ${wrapsInner};

const pagesHtml = bodies.map((b, i) => {
  const brk = i === 0 ? 'auto' : 'always';
  const inner = wrapsInner ? \`<div class="page-inner">\${b}</div>\` : b;
  return \`<div class="page" style="page-break-before: \${brk};">\${inner}</div>\`;
}).join('\\n');

const html = \`<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="utf-8">
${FONT_LINKS}
${extraHeadHtml}
<style>${css}
</style>
</head>
<body>
\${pagesHtml}
${extraBodyHtml}
</body>
</html>\`;

fs.writeFileSync(${JSON.stringify(htmlOutputPath)}, html);
console.log(\`wrote \${${JSON.stringify(htmlOutputPath)}} (\${html.length} bytes, \${bodies.length} pages)\`);
`;
}

// --- Chrome ---

export function findChrome(override) {
  if (override) {
    try { accessSync(override); return override; } catch {
      console.error(`Chrome not found at ${override}`);
      process.exit(1);
    }
  }
  for (const p of CHROME_PATHS) {
    try { accessSync(p); return p; } catch { /* continue */ }
  }
  console.error('Chrome not found. Use --chrome to specify the path.');
  process.exit(1);
}

// --- High-level pipeline (extracted) ---

// Fetch and font-normalize JSX for each frame. Side-effects: prints progress.
export async function fetchJsxBodies(client, frames) {
  const jsxBodies = [];
  for (const frame of frames) {
    process.stdout.write(`  fetching ${frame.name}...`);
    const result = await client.callTool({
      name: 'get_jsx',
      arguments: { nodeId: frame.id, format: 'inline-styles' },
    });
    const text = result.content?.find(c => c.type === 'text')?.text;
    if (!text) {
      console.error(' failed — no JSX returned');
      process.exit(1);
    }
    let jsx;
    try { jsx = JSON.parse(text); } catch { jsx = text; }
    jsx = normalizeFonts(jsx);
    jsxBodies.push(jsx);
    console.log(' ok');
  }
  return jsxBodies;
}

// Build a JSX file, esbuild it, run it to render HTML, then run the three
// optimisation passes (blooms → remotes → photos). Returns { htmlPath, cleanup }.
export async function renderOptimizedHtml({ jsxBodies, tag, keep = false, extraHeadHtml = '', extraBodyHtml = '', pageLayout = null }) {
  const jsxPath = resolve(__dirname, `_generated_${tag}_pages.jsx`);
  const cjsPath = resolve(__dirname, `_generated_${tag}_out.cjs`);
  const htmlPath = resolve(__dirname, `_generated_${tag}_doc.html`);

  const jsxContent = buildJsxFile(jsxBodies, htmlPath, extraHeadHtml, extraBodyHtml, pageLayout);
  writeFileSync(jsxPath, jsxContent);
  console.log(`wrote ${jsxPath}`);

  console.log('compiling...');
  await esbuild.build({
    entryPoints: [jsxPath],
    bundle: true,
    platform: 'node',
    outfile: cjsPath,
    logLevel: 'error',
  });

  console.log('rendering HTML...');
  execFileSync('node', [cjsPath], { stdio: 'inherit' });

  console.log('collapsing blooms to shared images...');
  const rendered = readFileSync(htmlPath, 'utf8');
  const bloomPass = await optimizeBlooms(rendered);
  const bp = bloomPass.summary;
  console.log(`  ${bp.replaced} gradient instances → ${bp.unique} unique PNG XObject${bp.unique === 1 ? '' : 's'}`);

  console.log('embedding remote assets...');
  const embedPass = await embedRemoteImages(bloomPass.html);
  const ep = embedPass.summary;
  console.log(`  ${ep.unique}/${ep.count} remote images embedded (${formatBytes(ep.bytes)})`);

  const photoPass = await optimizeImages(embedPass.html);
  const ps = photoPass.summary;
  if (ps.count) {
    const savings = ps.before - ps.after;
    const pct = ps.before ? Math.round((savings / ps.before) * 100) : 0;
    const classSummary = Object.entries(ps.classCounts || {})
      .map(([k, v]) => `${v} ${k}`).join(', ');
    console.log(`  ${ps.count} raster images: ${formatBytes(ps.before)} → ${formatBytes(ps.after)} (-${pct}%) [${classSummary}]`);
  }

  writeFileSync(htmlPath, photoPass.html);

  const cleanup = () => {
    if (keep) return;
    try { unlinkSync(jsxPath); } catch {}
    try { unlinkSync(cjsPath); } catch {}
    try { unlinkSync(htmlPath); } catch {}
  };

  return { htmlPath, jsxPath, cjsPath, cleanup };
}

// Print an HTML file to PDF via headless Chrome.
export function printHtmlToPdf({ chrome, htmlPath, outputPdf }) {
  console.log('printing to PDF...');
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--virtual-time-budget=15000',
    `--print-to-pdf=${outputPdf}`,
    '--print-to-pdf-no-header',
    `file://${htmlPath}`,
  ], { stdio: 'pipe' });
}

// Build a page layout spec from CLI flags + resolved frames.
// Returns { paper, bleedMm, marginMm, artW, artH }. `paper` is null when no
// --page-size was passed (content-sized page, no scaling).
export function buildPageLayout(flags, frames) {
  const artW = Math.max(...frames.map(f => f.width));
  const artH = Math.max(...frames.map(f => f.height));
  const paper = resolvePageSize(flags['page-size']);
  if (!paper) return { paper: null, artW, artH };

  const bleedMm = flags.bleed ? parseFloat(flags.bleed) : 0;
  if (Number.isNaN(bleedMm) || bleedMm < 0) {
    throw new Error(`Invalid --bleed value: ${flags.bleed}`);
  }
  const marginMm = flags.margin !== undefined ? parseFloat(flags.margin) : DEFAULT_MARGIN_MM;
  if (Number.isNaN(marginMm) || marginMm < 0) {
    throw new Error(`Invalid --margin value: ${flags.margin}`);
  }
  return { paper, bleedMm, marginMm, artW, artH };
}

// --- Entry point ---

export async function runPdf(argv) {
  let flags, positionals;
  try {
    ({ values: flags, positionals } = parsePdfArgs(argv));
  } catch (err) {
    console.error(err.message);
    console.error(PDF_HELP);
    process.exit(1);
  }

  if (flags.help) {
    console.log(PDF_HELP);
    return;
  }

  const mcpUrl = flags['mcp-url'];

  let client;
  try {
    client = await connectMcp(mcpUrl);
  } catch (err) {
    console.error(`Paper MCP not reachable at ${mcpUrl}. Is Paper running?\n${err.message}`);
    process.exit(1);
  }

  console.log('connected to Paper MCP');

  const info = await callTool(client, 'get_basic_info');
  const artboards = info.artboards;

  if (flags.list) {
    console.log(`\n${artboards.length} artboards:\n`);
    const sorted = [...artboards].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const ab of sorted) {
      console.log(`  ${ab.name.padEnd(30)} ${ab.width}×${ab.height}  [${ab.id}]`);
    }
    await client.close();
    return;
  }

  const prefix = positionals[0];
  if (!prefix) {
    console.error(PDF_HELP);
    process.exit(1);
  }

  const frames = resolveFrames(artboards, prefix);
  console.log(`found ${frames.length} frames: ${frames.map(f => f.name).join(', ')}`);

  let pageLayout;
  try {
    pageLayout = buildPageLayout(flags, frames);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (pageLayout.paper) {
    const { paper, bleedMm, artW, artH } = pageLayout;
    const tw = paper.width + 2 * bleedMm;
    const th = paper.height + 2 * bleedMm;
    console.log(`page size: ${paper.name} ${tw}×${th}mm${bleedMm ? ` (incl. ${bleedMm}mm bleed)` : ''}, artboard ${artW}×${artH}px`);
  }

  const jsxBodies = await fetchJsxBodies(client, frames);

  await client.close();
  console.log('disconnected from Paper MCP');

  const outputPdf = resolve(flags.output || `${prefix}.pdf`);
  const tag = `${prefix}_${process.pid}`;

  const { htmlPath, cleanup } = await renderOptimizedHtml({ jsxBodies, tag, keep: flags.keep, pageLayout });

  const chrome = findChrome(flags.chrome);
  printHtmlToPdf({ chrome, htmlPath, outputPdf });

  console.log(`done: ${outputPdf}`);

  cleanup();
}
