// Paper MCP → fillable-PDF generator.
//
// Same pipeline as `papx pdf`, plus overlays AcroForm text fields on every
// Paper text node whose layer name matches `^\{field:(.+)\}$`. The capture
// group becomes the PDF form field name (dotted keys kept verbatim); the
// node's current text becomes the field's default value.

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const nodeRequire = createRequire(import.meta.url);
const DM_SANS_REGULAR_PATH = nodeRequire.resolve('@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff');
const DM_SANS_MEDIUM_PATH = nodeRequire.resolve('@fontsource/dm-sans/files/dm-sans-latin-500-normal.woff');

import {
  connectMcp,
  callTool,
  resolveFrameOrPrefix,
  fetchJsxBodies,
  renderOptimizedHtml,
  printHtmlToPdf,
  findChrome,
} from './pdf.js';

export const FORM_HELP = `Usage: papx form [options] <prefix-or-artboard>

Builds a fillable PDF from Paper artboards. Text nodes whose layer name
matches the pattern {field:<key>} become AcroForm text fields at their
rendered position; the current text content is the default value.

Accepts either a numbered prefix ("<prefix>/1", "<prefix>/2", ...) or an
exact artboard name / node id (for single-page forms).

Options:
  -o, --output <path>   PDF output path (default: <prefix>.pdf)
  --mcp-url <url>       MCP endpoint (default: http://127.0.0.1:29979/mcp)
  --keep                Keep intermediate files
  --chrome <path>       Chrome binary path
  -h, --help            Show this help`;

const FIELD_RE = /^\{field:(.+)\}$/;
const CSS_PX_TO_PT = 0.75;

function parseFormArgs(argv) {
  return parseArgs({
    args: argv,
    options: {
      output: { type: 'string', short: 'o' },
      'mcp-url': { type: 'string', default: 'http://127.0.0.1:29979/mcp' },
      keep: { type: 'boolean', default: false },
      chrome: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });
}

// Walk the descendants of each frame and collect every Text node whose
// layer name matches {field:<key>}. Returns a flat array of field records.
async function collectFieldNodes(client, frames) {
  const fields = [];

  async function walk(nodeId, frameIdx) {
    const info = await callTool(client, 'get_node_info', { nodeId });
    const m = info.name && info.name.match(FIELD_RE);
    if (m && info.component === 'Text') {
      fields.push({
        frameIdx,
        key: m[1],
        textContent: info.textContent ?? '',
        nodeId,
        width: info.width,
        height: info.height,
      });
      // Text nodes don't have meaningful field-children; skip descending.
      return;
    }
    for (const cid of info.childIds || []) {
      await walk(cid, frameIdx);
    }
  }

  for (let i = 0; i < frames.length; i++) {
    await walk(frames[i].id, i);
  }

  if (fields.length === 0) return fields;

  // Batch-fetch computed styles to match fonts in the form layer.
  const styles = await callTool(client, 'get_computed_styles', {
    nodeIds: fields.map(f => f.nodeId),
  });
  for (const f of fields) {
    const s = styles[f.nodeId] || {};
    f.fontSize = parseFloat(s.fontSize) || 14;
    f.lineHeight = parseFloat(s.lineHeight) || f.fontSize * 1.4;
    f.color = s.color || '#000000';
    f.fontWeight = Number(s.fontWeight) || 400;
  }
  return fields;
}

// Inject a `data-field-key` attribute on the <div> wrapping each field's
// text so we can measure its bbox in Chrome and match it back to the key.
// Relies on the field's preview text being unique inside its artboard's
// rendered JSX. Warns if a text is missing or ambiguous.
function injectFieldMarkers(jsx, fields) {
  const taken = new Set(); // char offsets of already-injected <div starts
  const warnings = [];

  for (const f of fields) {
    if (!f.textContent) {
      warnings.push(`field "${f.key}": empty preview text, skipping`);
      continue;
    }
    // Find the first occurrence of the text that isn't already inside a
    // marked <div>. Text may have trimmed whitespace from Paper.
    let searchFrom = 0;
    let foundStart = -1;
    while (searchFrom < jsx.length) {
      const idx = jsx.indexOf(f.textContent, searchFrom);
      if (idx === -1) break;
      const divStart = jsx.lastIndexOf('<div', idx);
      if (divStart === -1 || taken.has(divStart)) {
        searchFrom = idx + 1;
        continue;
      }
      // Confirm the <div> is an immediate parent: between divStart and idx
      // there should be no other opening tag. Looser check: the text is
      // directly between `>` and `</div>` with only whitespace around it.
      const between = jsx.slice(divStart, idx);
      const gtIdx = between.lastIndexOf('>');
      const interior = between.slice(gtIdx + 1);
      if (!/^\s*$/.test(interior)) {
        // The preview text is nested deeper than the nearest <div>. That's
        // fine — we just mark the outer <div>, which still gives a correct
        // bbox (text node is inside it).
      }
      foundStart = divStart;
      break;
    }

    if (foundStart === -1) {
      warnings.push(`field "${f.key}": text "${f.textContent}" not found in JSX`);
      continue;
    }
    taken.add(foundStart);

    // Insert `data-field-key="..."` right after `<div`.
    jsx = jsx.slice(0, foundStart + 4) +
      ` data-field-key="${f.key}"` +
      jsx.slice(foundStart + 4);

    // Shift remaining taken offsets past the insertion.
    // (Not strictly needed since we only compare equality, but keep honest.)
  }

  return { jsx, warnings };
}

// Script that runs after page load and writes a JSON blob of per-field
// bounding boxes (page-relative, in CSS px) into a hidden <pre>.
// Hide baked field text at print time so the AcroForm overlay provides the
// visible text. Layout stays intact because `visibility: hidden` preserves
// the element's box. During the --dump-dom measurement pass (screen media),
// text stays visible — needed so getBoundingClientRect captures the correct
// size for hug-content text nodes.
const PRINT_HIDE_CSS = `<style>
  @media print {
    [data-field-key] { visibility: hidden; }
  }
</style>`;

const MEASURE_SCRIPT = `
<pre id="field-bboxes" style="display:none"></pre>
<script>
(function() {
  function measure() {
    var pages = Array.prototype.slice.call(document.querySelectorAll('.page'));
    var out = {};
    var nodes = document.querySelectorAll('[data-field-key]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute('data-field-key');
      var page = el.closest('.page');
      var pageIdx = pages.indexOf(page);
      var pageRect = page.getBoundingClientRect();
      var r = el.getBoundingClientRect();
      out[key] = {
        page: pageIdx,
        x: r.left - pageRect.left,
        y: r.top - pageRect.top,
        w: r.width,
        h: r.height,
      };
    }
    var sink = document.getElementById('field-bboxes');
    if (sink) sink.textContent = JSON.stringify(out);
  }
  if (document.readyState === 'complete') measure();
  else window.addEventListener('load', measure);
})();
</script>`;

// Run Chrome with --dump-dom to capture the post-script DOM, parse the
// field-bboxes JSON back out.
function measureBboxes({ chrome, htmlPath }) {
  console.log('measuring field positions...');
  const dom = execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--virtual-time-budget=8000',
    '--window-size=832,2000',
    '--dump-dom',
    `file://${htmlPath}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024 });

  const m = dom.match(/<pre id="field-bboxes"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) {
    throw new Error('field-bboxes sink not found in dumped DOM — measurement script failed to run');
  }
  const payload = m[1].trim();
  if (!payload) {
    throw new Error('field-bboxes is empty — no data-field-key elements rendered or script did not finish');
  }
  // Decode HTML entities just in case (JSON has `"` → &quot; possible)
  const decoded = payload
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  return JSON.parse(decoded);
}

// Overlay AcroForm text fields on the printed PDF.
async function overlayFormFields({ pdfPath, outputPath, fields, bboxes }) {
  const bytes = readFileSync(pdfPath);
  const doc = await PDFDocument.load(bytes);
  doc.registerFontkit(fontkit);
  const form = doc.getForm();

  // Embed DM Sans (Regular 400 + Medium 500) so the AcroForm text matches
  // Paper's typography rather than Helvetica.
  const dmRegular = await doc.embedFont(readFileSync(DM_SANS_REGULAR_PATH), { subset: true });
  const dmMedium = await doc.embedFont(readFileSync(DM_SANS_MEDIUM_PATH), { subset: true });

  const pages = doc.getPages();

  let placed = 0;
  const missing = [];
  for (const f of fields) {
    const bbox = bboxes[f.key];
    if (!bbox) { missing.push(f.key); continue; }
    const page = pages[bbox.page ?? 0];
    if (!page) { missing.push(`${f.key} (no page ${bbox.page})`); continue; }

    const pageHeightPt = page.getHeight();
    const xPt = bbox.x * CSS_PX_TO_PT;
    const wPt = bbox.w * CSS_PX_TO_PT;
    const hPt = bbox.h * CSS_PX_TO_PT;
    const yPt = pageHeightPt - (bbox.y * CSS_PX_TO_PT) - hPt;

    const pdfField = form.createTextField(f.key);
    if (f.textContent) pdfField.setText(f.textContent);
    pdfField.addToPage(page, {
      x: xPt,
      y: yPt,
      width: wPt,
      height: hPt,
      font: f.fontWeight >= 500 ? dmMedium : dmRegular,
      textColor: rgb(0.102, 0.09, 0.071), // ≈ #1A1712
      borderWidth: 0,
      backgroundColor: undefined,
    });
    // Scale text to match Paper's size (in pt, px × 0.75).
    pdfField.setFontSize(f.fontSize * CSS_PX_TO_PT);
    placed++;
  }

  const saved = await doc.save({ updateFieldAppearances: true });
  writeFileSync(outputPath, saved);
  return { placed, missing };
}

export async function runForm(argv) {
  let flags, positionals;
  try {
    ({ values: flags, positionals } = parseFormArgs(argv));
  } catch (err) {
    console.error(err.message);
    console.error(FORM_HELP);
    process.exit(1);
  }

  if (flags.help) {
    console.log(FORM_HELP);
    return;
  }

  const mcpUrl = flags['mcp-url'];
  const arg = positionals[0];
  if (!arg) {
    console.error(FORM_HELP);
    process.exit(1);
  }

  let client;
  try {
    client = await connectMcp(mcpUrl);
  } catch (err) {
    console.error(`Paper MCP not reachable at ${mcpUrl}. Is Paper running?\n${err.message}`);
    process.exit(1);
  }
  console.log('connected to Paper MCP');

  const info = await callTool(client, 'get_basic_info');
  const frames = resolveFrameOrPrefix(info.artboards, arg);
  console.log(`found ${frames.length} frame${frames.length === 1 ? '' : 's'}: ${frames.map(f => f.name).join(', ')}`);

  console.log('scanning for {field:*} nodes...');
  const fields = await collectFieldNodes(client, frames);
  if (fields.length === 0) {
    console.error(`no {field:*} text nodes found in ${frames.map(f => f.name).join(', ')}`);
    await client.close();
    process.exit(1);
  }
  console.log(`  found ${fields.length} field${fields.length === 1 ? '' : 's'}:`);
  for (const f of fields) {
    console.log(`    ${f.key.padEnd(32)} "${f.textContent}" (${f.width}×${f.height}, ${f.fontSize}px)`);
  }

  const jsxBodies = await fetchJsxBodies(client, frames);
  await client.close();
  console.log('disconnected from Paper MCP');

  // Inject data-field-key attributes per-frame.
  const allWarnings = [];
  const markedBodies = jsxBodies.map((jsx, i) => {
    const frameFields = fields.filter(f => f.frameIdx === i);
    const { jsx: out, warnings } = injectFieldMarkers(jsx, frameFields);
    for (const w of warnings) allWarnings.push(`frame ${frames[i].name}: ${w}`);
    return out;
  });
  for (const w of allWarnings) console.warn(`  ! ${w}`);

  const outputPdf = resolve(flags.output || `${arg.replace(/[\/\s·]/g, '_')}.pdf`);
  const tag = `form_${arg.replace(/[^a-z0-9]/gi, '_')}_${process.pid}`;

  const { htmlPath, cleanup } = await renderOptimizedHtml({
    jsxBodies: markedBodies,
    tag,
    keep: flags.keep,
    extraHeadHtml: PRINT_HIDE_CSS,
    extraBodyHtml: MEASURE_SCRIPT,
  });

  const chrome = findChrome(flags.chrome);

  const bboxes = measureBboxes({ chrome, htmlPath });
  const measuredCount = Object.keys(bboxes).length;
  console.log(`  measured ${measuredCount} bbox${measuredCount === 1 ? '' : 'es'}`);

  // Temp PDF without form fields, then overlay.
  const tmpPdf = outputPdf + '.tmp.pdf';
  printHtmlToPdf({ chrome, htmlPath, outputPdf: tmpPdf });

  console.log('overlaying AcroForm fields...');
  const { placed, missing } = await overlayFormFields({
    pdfPath: tmpPdf,
    outputPath: outputPdf,
    fields,
    bboxes,
  });

  try { unlinkSync(tmpPdf); } catch {}
  cleanup();

  console.log(`placed ${placed}/${fields.length} fields${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);
  console.log(`done: ${outputPdf}`);

  // Surface a designer-facing warning if any field's bbox looks auto-sized.
  const autoSized = fields.filter(f => {
    const b = bboxes[f.key];
    if (!b) return false;
    return Math.abs(b.w - f.width) < 1 && f.textContent && f.textContent.length > 0;
  });
  if (autoSized.length && autoSized.length === fields.length) {
    // All widths match node widths exactly → likely all auto-sized. Silent.
  }
}
