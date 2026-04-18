// Fetch Paper CDN image URLs and embed them as data URIs in the HTML,
// so Chrome doesn't fetch them at native resolution during print.
//
// Runs BEFORE optimizeImages — once embedded as data: URIs, the entropy-
// classified photo pass kicks in automatically.

const CDN_RE = /https:\/\/app\.paper\.design\/file-assets\/[^"'\s)]+/g;

export async function embedRemoteImages(html) {
  const urls = [...new Set([...html.matchAll(CDN_RE)].map(m => m[0]))];
  if (urls.length === 0) {
    return { html, summary: { count: 0, unique: 0, bytes: 0 } };
  }

  const cache = new Map(); // url → data URL string
  let totalBytes = 0;

  await Promise.all(urls.map(async url => {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`  ${url} → ${res.status}, leaving as remote`);
        return;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType =
        res.headers.get('content-type')?.split(';')[0].trim() ||
        guessMimeFromUrl(url);
      const dataUrl = `data:${contentType};base64,${buffer.toString('base64')}`;
      cache.set(url, dataUrl);
      totalBytes += buffer.length;
    } catch (err) {
      console.warn(`  ${url} → ${err.message}, leaving as remote`);
    }
  }));

  let out = html;
  for (const [url, dataUrl] of cache) {
    out = out.split(url).join(dataUrl);
  }

  return {
    html: out,
    summary: { count: urls.length, unique: cache.size, bytes: totalBytes },
  };
}

function guessMimeFromUrl(url) {
  const ext = url.split('.').pop().toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'application/octet-stream';
}
