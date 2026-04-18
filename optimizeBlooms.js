// Replace CSS radial-gradient blooms with tiny shared PNG XObjects.
//
// Paper emits blooms as `background-image: radial-gradient(... in oklab, ...)`
// combined with `filter: blur(...)`. Chrome rasterizes each at print DPI,
// producing ~1 MB per bloom in the PDF.
//
// This pass parses each gradient, renders a canonical PNG from its parameters
// (deterministic: same gradient string → byte-identical PNG), and replaces
// the CSS with `url(data:image/png;base64,...)`. Chrome's Skia PDF backend
// hashes image data and emits a single XObject per unique PNG — so 40+ bloom
// instances collapse to ~5 shared streams in the final PDF.
//
// Derivation from the gradient string itself (not a hardcoded color map) means
// Paper can emit any bloom variation and this still handles it.

import sharp from 'sharp';

const BLOOM_SIZE = 512; // square PNG; CSS background-size handles placement
// Gaussian blur applied to the rasterized PNG to bake in the CSS `filter: blur(...)`
// effect that Paper originally relied on. Without this, the border-radius: 50% clip
// produces a visible hard edge. Value empirically tuned for 512px PNGs stretched
// to typical bloom element sizes (300-900 px).
const BLOOM_BLUR_SIGMA = 14;

// Match a radial-gradient(...) with balanced parens (handles nested functions
// like `oklab(84% 0.080 0.040 / 80%)`).
function findRadialGradients(html) {
  const results = [];
  const re = /radial-gradient\(/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const start = m.index;
    let depth = 1;
    let i = start + 'radial-gradient('.length;
    while (i < html.length && depth > 0) {
      const c = html[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    if (depth === 0) {
      results.push({ full: html.slice(start, i), start, end: i });
    }
  }
  return results;
}

// Parse one color stop: `oklab(L% a b / alpha) 0%` or `rgb(...)` etc.
// Returns { r, g, b, a, offset } or null.
function parseColorStop(str) {
  str = str.trim();
  // Peel off trailing offset "XX%"
  const stopMatch = str.match(/\s+(-?\d+(?:\.\d+)?)%\s*$/);
  const offset = stopMatch ? parseFloat(stopMatch[1]) / 100 : null;
  const colorPart = stopMatch ? str.slice(0, -stopMatch[0].length).trim() : str;

  const rgba = parseColor(colorPart);
  if (!rgba) return null;
  return { ...rgba, offset };
}

function parseColor(str) {
  str = str.trim();

  // oklab(L% a b / alpha) — L is 0-100%, a and b are signed decimals
  let m = str.match(
    /^oklab\(\s*([-\d.]+)%?\s+([-\d.]+)\s+([-\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/
  );
  if (m) {
    const L = parseFloat(m[1]) / 100;
    const a = parseFloat(m[2]);
    const b = parseFloat(m[3]);
    const alpha = m[4] ? parseAlpha(m[4]) : 1;
    const [r, g, bb] = oklabToSRGB(L, a, b);
    return {
      r: Math.round(clamp01(r) * 255),
      g: Math.round(clamp01(g) * 255),
      b: Math.round(clamp01(bb) * 255),
      a: alpha,
    };
  }

  // rgb(...) / rgba(...)
  m = str.match(/^rgba?\(\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    return {
      r: Math.round(parseFloat(m[1])),
      g: Math.round(parseFloat(m[2])),
      b: Math.round(parseFloat(m[3])),
      a: m[4] ? parseAlpha(m[4]) : 1,
    };
  }
  m = str.match(/^rgba?\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)(?:\s*,\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    return {
      r: Math.round(parseFloat(m[1])),
      g: Math.round(parseFloat(m[2])),
      b: Math.round(parseFloat(m[3])),
      a: m[4] ? parseAlpha(m[4]) : 1,
    };
  }

  // hex #rgb / #rrggbb
  m = str.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    const hex = m[1];
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: 1,
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
  }

  return null;
}

function parseAlpha(s) {
  s = s.trim();
  if (s.endsWith('%')) return parseFloat(s) / 100;
  return parseFloat(s);
}

// oklab → linear sRGB → gamma-encoded sRGB (0-1 range)
function oklabToSRGB(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const rLin =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  return [encodeSRGB(rLin), encodeSRGB(gLin), encodeSRGB(bLin)];
}

function encodeSRGB(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// Given the inside of `radial-gradient(...)`, split on top-level commas so
// nested color functions stay intact.
function splitTopLevel(inside) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const c of inside) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// Render a radial gradient to PNG via SVG rasterization.
// Identical input → identical output bytes (deterministic for Skia dedup).
// Uses userSpaceOnUse coords with r = diagonal half so 0.65 stop matches CSS
// `circle farthest-corner, ... 65%`. Gaussian blur is baked in to replace
// Paper's `filter: blur(...)` (which would force per-element rasterization).
async function renderBloomPng(stops, sizePx) {
  const stopTags = stops
    .map(
      (s, i) =>
        `<stop offset="${(s.offset != null ? s.offset : i / (stops.length - 1)).toFixed(4)}" stop-color="rgb(${s.r},${s.g},${s.b})" stop-opacity="${s.a.toFixed(4)}"/>`
    )
    .join('');

  const cx = sizePx / 2;
  const r = (sizePx / 2) * Math.SQRT2; // matches CSS circle farthest-corner

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}"><defs><radialGradient id="b" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cx}" r="${r.toFixed(3)}">${stopTags}</radialGradient></defs><rect width="100%" height="100%" fill="url(#b)"/></svg>`;

  return sharp(Buffer.from(svg))
    .blur(BLOOM_BLUR_SIGMA)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// Find the enclosing `style="..."` attribute span for a position inside the HTML.
// Returns { styleStart, contentStart, contentEnd, styleEnd } or null.
function findEnclosingStyle(html, pos) {
  // Walk backwards to find 'style="'
  const openSearch = html.lastIndexOf('style="', pos);
  if (openSearch < 0) return null;
  const contentStart = openSearch + 'style="'.length;
  if (contentStart > pos) return null;
  const contentEnd = html.indexOf('"', contentStart);
  if (contentEnd < pos) return null;
  return {
    styleStart: openSearch,
    contentStart,
    contentEnd,
    styleEnd: contentEnd + 1,
  };
}

// Remove CSS declarations (e.g. filter, border-radius) from a style string.
// Each target is a property name. Handles missing trailing `;`.
function stripDeclarations(style, predicate) {
  // Split on `;` but keep it simple — styles here are machine-emitted by Paper.
  return style
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(decl => !predicate(decl))
    .join(';');
}

export async function optimizeBlooms(html) {
  const gradients = findRadialGradients(html);
  if (gradients.length === 0) {
    return { html, summary: { replaced: 0, unique: 0, before: 0, after: 0 } };
  }

  // Dedup by exact gradient string → one PNG per unique gradient
  const cache = new Map(); // gradient string → data URL

  // Pre-render PNGs for every bloom gradient we'll replace
  const toProcess = [];
  for (const g of gradients) {
    const inside = g.full.slice('radial-gradient('.length, -1).trim();
    const parts = splitTopLevel(inside);
    if (parts.length < 2) continue;
    const stops = parts.slice(1).map(parseColorStop).filter(Boolean);
    if (stops.length < 2) continue;
    // Only transform blooms — gradients with at least one transparent stop
    if (!stops.some(s => s.a < 1)) continue;
    toProcess.push({ ...g, stops });
  }

  for (const g of toProcess) {
    if (cache.has(g.full)) continue;
    const png = await renderBloomPng(g.stops, BLOOM_SIZE);
    cache.set(g.full, `data:image/png;base64,${png.toString('base64')}`);
  }

  // For each gradient, find the enclosing style attribute so we can also strip
  // the filter:blur and border-radius:50% that Paper pairs with every bloom —
  // otherwise the clip edge shows as a hard line.
  const styleEdits = new Map(); // contentStart → { original, rewritten }
  let before = 0;
  let after = 0;

  for (const g of toProcess) {
    const dataUrl = cache.get(g.full);
    if (!dataUrl) continue;

    const enclosing = findEnclosingStyle(html, g.start);
    if (!enclosing) continue;

    const key = enclosing.contentStart;
    if (!styleEdits.has(key)) {
      styleEdits.set(key, {
        contentStart: enclosing.contentStart,
        contentEnd: enclosing.contentEnd,
        original: html.slice(enclosing.contentStart, enclosing.contentEnd),
      });
    }
    const edit = styleEdits.get(key);

    // Replace gradient inside the style string (use first occurrence only —
    // we walk through all gradients in order)
    const currentStyle = edit.rewritten ?? edit.original;
    // Replace gradient with url(data:...) and ensure the PNG stretches to
    // fill the element (CSS radial-gradient fills 100% by default, but
    // background-image: url(...) defaults to the PNG's intrinsic size).
    let afterReplace = currentStyle.replace(g.full, `url(${dataUrl})`);
    if (!/background-size\s*:/i.test(afterReplace)) {
      afterReplace += ';background-size:100% 100%';
    }
    edit.rewritten = afterReplace;

    before += g.full.length;
    after += `url(${dataUrl})`.length;
  }

  // Strip filter:blur and border-radius:50% from each touched style.
  for (const edit of styleEdits.values()) {
    if (!edit.rewritten) continue;
    edit.rewritten = stripDeclarations(edit.rewritten, decl => {
      // Remove filter: ...blur(...)
      if (/^filter\s*:/i.test(decl) && /blur\s*\(/i.test(decl)) return true;
      // Remove border-radius: 50% (both axes equal — the elliptical clip)
      if (/^border-radius\s*:\s*50%\s*$/i.test(decl)) return true;
      return false;
    });
  }

  // Apply style rewrites from end to start to keep indices valid.
  const edits = [...styleEdits.values()].sort((a, b) => b.contentStart - a.contentStart);
  let out = html;
  for (const edit of edits) {
    if (!edit.rewritten) continue;
    out = out.slice(0, edit.contentStart) + edit.rewritten + out.slice(edit.contentEnd);
  }

  return {
    html: out,
    summary: {
      replaced: toProcess.length,
      unique: cache.size,
      before,
      after,
    },
  };
}
