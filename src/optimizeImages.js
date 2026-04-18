// Smart image optimizer for data:image URIs embedded in the generated HTML.
//
// Classifies each image by Shannon entropy and treats blooms (smooth gradients)
// and photos (detailed) differently:
//   - blooms  → low-res palette PNG (preserves alpha) or low-q JPEG
//   - photos  → capped DPI, JPEG q88 (or PNG if alpha)
//
// Run between React SSR and Chrome print-to-pdf so Chrome embeds already-small
// images into the final PDF.

import sharp from 'sharp';

// Paper page width in CSS px (matches @page size in generate.js)
const PAGE_WIDTH_PX = 832;

// Blooms: 1× page width is plenty for a gradient
const BLOOM_MAX_WIDTH = PAGE_WIDTH_PX;
// Photos: 2× for retina rendering, not more
const PHOTO_MAX_WIDTH = PAGE_WIDTH_PX * 2;

// Shannon entropy threshold. Smooth gradients score ~2-4, photos ~6-7.8.
const BLOOM_ENTROPY_THRESHOLD = 4.5;

// JPEG / PNG settings per class
const BLOOM_JPEG_QUALITY = 55;
const BLOOM_PNG_COLORS = 64;
const PHOTO_JPEG_QUALITY = 88;

// Skip optimization for tiny images (icons, line art) — not worth it
const SKIP_UNDER_BYTES = 4096;

const DATA_URL_RE = /data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)/g;

export async function optimizeImages(html) {
  const tasks = new Map();

  for (const match of html.matchAll(DATA_URL_RE)) {
    const full = match[0];
    if (tasks.has(full)) continue;
    tasks.set(full, optimizeOne(match[2]));
  }

  if (tasks.size === 0) return { html, summary: { count: 0, before: 0, after: 0 } };

  const results = await Promise.all(tasks.values());
  const entries = [...tasks.keys()].map((original, i) => [original, results[i]]);

  let out = html;
  let before = 0;
  let after = 0;
  const classCounts = {};

  for (const [original, replacement] of entries) {
    before += original.length;
    if (!replacement) {
      // skipped — leave untouched
      after += original.length;
      classCounts.skipped = (classCounts.skipped || 0) + 1;
      continue;
    }
    after += replacement.dataUrl.length;
    classCounts[replacement.kind] = (classCounts[replacement.kind] || 0) + 1;
    // Use split/join instead of replace() to avoid regex-meta interpretation
    out = out.split(original).join(replacement.dataUrl);
  }

  return {
    html: out,
    summary: { count: entries.length, before, after, classCounts },
  };
}

async function optimizeOne(base64) {
  const buffer = Buffer.from(base64, 'base64');

  if (buffer.length < SKIP_UNDER_BYTES) return null;

  const img = sharp(buffer);
  let meta, stats;
  try {
    meta = await img.metadata();
    stats = await img.stats();
  } catch {
    return null; // unreadable — leave as-is
  }

  const hasAlpha = meta.hasAlpha;
  const colorChannels = hasAlpha ? stats.channels.slice(0, -1) : stats.channels;
  const entropy = colorChannels.reduce((s, c) => s + c.entropy, 0) / colorChannels.length;
  const isBloom = entropy < BLOOM_ENTROPY_THRESHOLD;

  const targetWidth = isBloom ? BLOOM_MAX_WIDTH : PHOTO_MAX_WIDTH;
  const shouldResize = meta.width > targetWidth;

  let pipeline = sharp(buffer);
  if (shouldResize) {
    pipeline = pipeline.resize({ width: targetWidth, withoutEnlargement: true });
  }

  let output;
  let kind;

  if (isBloom && hasAlpha) {
    // Palette PNG keeps alpha; 64 colors is plenty for a smooth bloom
    output = await pipeline
      .png({ palette: true, colors: BLOOM_PNG_COLORS, compressionLevel: 9 })
      .toBuffer();
    kind = 'bloom-png';
  } else if (isBloom) {
    output = await pipeline
      .jpeg({ quality: BLOOM_JPEG_QUALITY, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .toBuffer();
    kind = 'bloom-jpg';
  } else if (hasAlpha) {
    // Photo with alpha — rare (logo, icons). Keep PNG at best compression.
    output = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    kind = 'photo-png';
  } else {
    output = await pipeline
      .jpeg({ quality: PHOTO_JPEG_QUALITY, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .toBuffer();
    kind = 'photo-jpg';
  }

  // If optimization made it larger (rare — already-optimized small PNGs),
  // don't replace
  const originalB64Len = Math.ceil((buffer.length * 4) / 3);
  const newB64Len = Math.ceil((output.length * 4) / 3);
  if (newB64Len >= originalB64Len) return null;

  const mime = kind.endsWith('png') ? 'png' : 'jpeg';
  return {
    kind,
    dataUrl: `data:image/${mime};base64,${output.toString('base64')}`,
  };
}

export function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
