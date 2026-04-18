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
  --keep                Keep intermediate files
  --chrome <path>       Chrome binary path
  -h, --help            Show this help`;

function parsePdfArgs(argv) {
  return parseArgs({
    args: argv,
    options: {
      output: { type: 'string', short: 'o' },
      list: { type: 'boolean', default: false },
      'mcp-url': { type: 'string', default: 'http://127.0.0.1:29979/mcp' },
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

export function buildJsxFile(jsxBodies, htmlOutputPath, extraHeadHtml = '', extraBodyHtml = '') {
  const components = jsxBodies.map((body, i) => {
    // get_jsx wraps output in ( ... ) — strip outer parens if present
    let cleaned = body.trim();
    if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    return `const Page${i} = () => (\n    ${cleaned}\n);`;
  });

  const pageList = jsxBodies.map((_, i) => `Page${i}`).join(', ');

  return `import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'fs';
import path from 'path';

${components.join('\n\n')}

const Pages = [${pageList}];
const bodies = Pages.map(P => renderToStaticMarkup(React.createElement(P)));

const pagesHtml = bodies.map((b, i) =>
  \`<div class="page" style="page-break-before: \${i===0?'auto':'always'};">\${b}</div>\`
).join('\\n');

const html = \`<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="utf-8">
${FONT_LINKS}
${extraHeadHtml}
<style>
  @page { size: 832px 1178px; margin: 0; }
  html, body { margin: 0; padding: 0; background: #FAFAFA; font-optical-sizing: auto; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  .page { width: 832px; height: 1178px; overflow: hidden; position: relative; }
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
export async function renderOptimizedHtml({ jsxBodies, tag, keep = false, extraHeadHtml = '', extraBodyHtml = '' }) {
  const jsxPath = resolve(__dirname, `_generated_${tag}_pages.jsx`);
  const cjsPath = resolve(__dirname, `_generated_${tag}_out.cjs`);
  const htmlPath = resolve(__dirname, `_generated_${tag}_doc.html`);

  const jsxContent = buildJsxFile(jsxBodies, htmlPath, extraHeadHtml, extraBodyHtml);
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

  const jsxBodies = await fetchJsxBodies(client, frames);

  await client.close();
  console.log('disconnected from Paper MCP');

  const outputPdf = resolve(flags.output || `${prefix}.pdf`);
  const tag = `${prefix}_${process.pid}`;

  const { htmlPath, cleanup } = await renderOptimizedHtml({ jsxBodies, tag, keep: flags.keep });

  const chrome = findChrome(flags.chrome);
  printHtmlToPdf({ chrome, htmlPath, outputPdf });

  console.log(`done: ${outputPdf}`);

  cleanup();
}
