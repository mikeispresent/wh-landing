/**
 * WildHeavy — og-image Cloudflare Worker
 *
 * Renders 1200x630 PNG share cards for public content:
 *   /og/r/{slug}.png  -> ranking card
 *   /og/m/{slug}.png  -> menu card
 *   /og/t/{slug}.png  -> spots / route card
 *   /og/l/{slug}.png  -> My Recs list card (neighborhood, quick list, would go back)
 *
 * The share-preview Worker points its og:image tags here, so iMessage /
 * IG DM / Twitter unfurls show the actual content (top items, ratings,
 * stops) instead of a lone photo or the logo.
 *
 * Design: "The Plate" on forest (2026-11-10), drawn in src/card.js. Half
 * the card is the real photo or route map, the other half is the title and
 * the top entries in the app's own type. Any failure redirects to the static
 * og-image.png so scrapers always get an image.
 *
 * Deploy: npm install && npx wrangler deploy   (Workers Paid plan required)
 */

import { ImageResponse } from 'workers-og';
import { WORDMARK_FOREST } from './brand.js';
import { buildStory, isAllowedPhotoUrl, STORY_W, STORY_H } from './story.js';
import { buildPaperHtml, PAPER_SIZES } from './paper.js';
import { renderInBrowser } from './browser.js';
import { shape, plateCard } from './card.js';

// wildheavy-prod. The old Lovable Cloud project (kufhzivrzvqayvzbwrpn) was
// decommissioned in the 2026-08 backend migration — its DNS no longer
// resolves, which broke every /og/* and /story/* render until 2026-08-17.
const EDGE_FN = 'https://dxwjkuqsncatvovjwrzv.supabase.co/functions/v1/share-preview';
const PREFIX_TO_TYPE = { r: 'ranking', m: 'menu_card', t: 'route', l: 'list' };
const FALLBACK_IMG = 'https://wildheavy.com/og-image.png';

const WIDTH = 1200;
const HEIGHT = 630;
// Bump on any change to card.js or pen.js. Edge cache entries survive
// deploys and are keyed by URL, so without this a design change stays
// invisible for the full 24h TTL.
const OG_CACHE_VERSION = '2';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const storyMatch = url.pathname.match(/^\/story\/([rmt])\/([A-Za-z0-9_-]{8,32})\.png$/);
    if (storyMatch) return handleStory(request, env, ctx, storyMatch, url);

    const match = url.pathname.match(/^\/og\/([rmtl])\/([A-Za-z0-9_-]{8,32})\.png$/);
    if (!match) return Response.redirect(FALLBACK_IMG, 302);

    // Edge cache: scrapers hit once, everyone after gets the cached PNG.
    const cache = caches.default;
    const cacheUrl = new URL(url);
    cacheUrl.searchParams.set('_v', OG_CACHE_VERSION);
    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      const [, prefix, slug] = match;
      const type = PREFIX_TO_TYPE[prefix];

      const res = await fetch(`${EDGE_FN}?type=${type}&slug=${slug}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return Response.redirect(FALLBACK_IMG, 302);
      const data = await res.json();

      // Swap remote photo URLs for time-boxed data URIs before rendering:
      // the shown entries' photos, the route's map, the creator's avatar.
      const k = data.content_type;
      const list = k === 'ranking' ? data.ranking?.items_preview
        : k === 'menu_card' ? data.menu_card?.dishes_preview
        : k === 'route' ? data.route?.stops
        : k === 'list' ? data.list?.places : null;
      await Promise.all([
        resolveImages((list || []).slice(0, 4)),
        (async () => { if (k === 'route' && data.route?.map_url) data.route.map_uri = await fetchThumb(data.route.map_url); })(),
        (async () => { if (data.creator?.avatar_url) data.creator.avatar_uri = await fetchThumb(data.creator.avatar_url); })(),
      ]);

      const card = shape(data);
      if (!card) return Response.redirect(FALLBACK_IMG, 302);
      const html = plateCard(card);

      const fonts = await loadFonts();
      const img = new ImageResponse(html, { width: WIDTH, height: HEIGHT, fonts, format: 'png' });
      const buf = await img.arrayBuffer();

      const response = new Response(buf, {
        headers: {
          'Content-Type': 'image/png',
          // 1h browser, 24h edge. Edits to content can lag up to the TTL;
          // messaging apps cache per-URL far longer anyway.
          'Cache-Control': 'public, max-age=3600, s-maxage=86400',
        },
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      if (url.searchParams.has('debug')) return new Response(String(err && err.stack), { status: 500 });
      return Response.redirect(FALLBACK_IMG, 302);
    }
  },
};

// ---------- Story (1080x1920) ----------
//
// GET /story/{r|m|t}/{slug}.png?variant=photo|clean&photo=<storage url>
//
// Unlike the OG path this does NOT fall back to a static image on failure.
// A 1200x630 landscape PNG dropped into a 9:16 slot looks broken, and the
// app already has an inline error + Retry state. Honest status codes let it
// do its job: 404 unknown slug, 410 private, 502 upstream, 500 render.
//
// The photo comes in as a URL rather than an index: share-preview only
// returns the top three previews and never returns hero_photo_url, so the
// Worker cannot reproduce the client's photo list. Passing the URL removes
// the dual-ordering contract entirely. The allowlist in story.js is what
// stops this being an open image-proxy.
// The app fetches these with fetch() from a Capacitor WebView, whose origin
// is capacitor://localhost — cross-origin to wildheavy.com. Without an
// Access-Control-Allow-Origin header the fetch fails even though the <img>
// preview loads fine (img tags aren't CORS-gated for display), which looks
// exactly like a render failure. The images are public content already, so
// a wildcard is correct here.
const STORY_CORS = { 'Access-Control-Allow-Origin': '*' };

// Bump on any change to story.js, paper.js or brand.js. Edge cache entries survive
// deploys and are keyed by URL, so without this a design fix stays invisible
// for the full TTL. Content edits are handled separately by the client
// passing ?v=<updated_at>.
const STORY_CACHE_VERSION = '12';

async function handleStory(request, env, ctx, match, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...STORY_CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' },
    });
  }

  const cacheUrl = new URL(url);
  cacheUrl.searchParams.set('_v', STORY_CACHE_VERSION);
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });

  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    // Edge cache entries survive deploys, so anything stored before CORS was
    // added would keep failing the app's fetch for the full TTL. Re-apply the
    // headers on the way out rather than making anyone wait it out.
    const hit = new Response(cached.body, cached);
    for (const [k, v] of Object.entries(STORY_CORS)) hit.headers.set(k, v);
    return hit;
  }

  const [, prefix, slug] = match;
  const type = PREFIX_TO_TYPE[prefix];
  const variant = url.searchParams.get('variant') === 'clean' ? 'clean' : 'photo';
  const photoParam = url.searchParams.get('photo');

  let data;
  try {
    const res = await fetch(`${EDGE_FN}?type=${type}&slug=${slug}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.status === 404) return jsonErr(404, 'not_found');
    if (res.status === 410) return jsonErr(410, 'unavailable');
    if (!res.ok) return jsonErr(502, 'upstream_error');
    data = await res.json();
  } catch {
    return jsonErr(502, 'upstream_error');
  }

  // Paper cards (Guest Check / Lineup Card / Route + Spots Card), drawn by a
  // real Chrome via Cloudflare Browser Rendering so they match the mockups
  // exactly. ?format=story (1080x1920, default) or ?format=post (1080x1440).
  // `variant` and `photo` are ignored here: the paper carries its own photos.
  // Any failure falls back to the Satori story card below (story size only;
  // a 9:16 image in a 3:4 post slot would be wrong, so post returns an error
  // and the app's Retry state takes over).
  const format = url.searchParams.get('format') === 'post' ? 'post' : 'story';
  if (env && env.BROWSER && url.searchParams.get('engine') !== 'satori') {
    try {
      const html = buildPaperHtml(data, { format, wordmarkUri: WORDMARK_FOREST.uri });
      if (html) {
        const { w, h } = PAPER_SIZES[format];
        const png = await renderInBrowser(env.BROWSER, html, w, h);
        const response = new Response(png, {
          headers: {
            ...STORY_CORS,
            'Content-Type': 'image/png',
            'X-WH-Engine': 'paper',
            'Cache-Control': 'public, max-age=60, s-maxage=300',
          },
        });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }
    } catch (err) {
      console.error('paper render failed:', err && err.message);
      if (url.searchParams.has('debug')) return jsonErr(500, `paper_failed: ${err && err.message}`);
    }
  }
  if (format === 'post') return jsonErr(502, 'render_failed');

  // A rejected photo (wrong host, wrong format, too slow) silently degrades
  // to the clean card rather than failing the whole render.
  let photoUri = null;
  if (variant === 'photo' && isAllowedPhotoUrl(photoParam)) {
    photoUri = await fetchThumb(photoParam);
  }

  // Creator avatar for the identity row. Best-effort — a missing or slow
  // avatar drops back to the handle alone rather than failing the render.
  const avatarUri = data?.creator?.avatar_url ? await fetchThumb(data.creator.avatar_url) : null;

  try {
    const html = buildStory(data, photoUri ? 'photo' : 'clean', photoUri, avatarUri);
    if (!html) return jsonErr(500, 'render_failed');

    const fonts = await loadFonts();
    const img = new ImageResponse(html, { width: STORY_W, height: STORY_H, fonts, format: 'png' });
    const buf = await img.arrayBuffer();

    const response = new Response(buf, {
      headers: {
        ...STORY_CORS,
        'Content-Type': 'image/png',
        // Shorter than the OG cards: a user tweaking variants wants to see
        // edits, and these aren't scraped by messaging apps.
        // Short on purpose. Users tweak variants and re-edit content, and
        // these aren't scraped by messaging apps, so freshness beats hits.
        'Cache-Control': 'public, max-age=60, s-maxage=300',
      },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch {
    return jsonErr(500, 'render_failed');
  }
}

function jsonErr(status, code) {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { ...STORY_CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ---------- Thumbnails: fetch -> data URI (bounded, best-effort) ----------
// Satori can fetch remote images itself, but pre-fetching lets us time-box
// and size-cap each one so a slow/huge photo can't sink the whole render.
const THUMB_TIMEOUT_MS = 2500;
const THUMB_MAX_BYTES = 4 * 1024 * 1024;

async function fetchThumb(imageUrl) {
  if (!imageUrl || !/^https:\/\//.test(imageUrl)) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), THUMB_TIMEOUT_MS);
    const res = await fetch(imageUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get('Content-Type') || '';
    if (!/^image\/(jpeg|png|webp|gif)/.test(ct)) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > THUMB_MAX_BYTES) return null;
    // webp/gif aren't reliably decoded by resvg — only pass through jpeg/png.
    if (!/^image\/(jpeg|png)/.test(ct)) return null;
    return toDataUri(buf, ct.split(';')[0]);
  } catch {
    return null;
  }
}

function toDataUri(buf, contentType) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

// Resolve preview-item images to data URIs in place (parallel, best-effort).
async function resolveImages(items) {
  await Promise.all(
    (items || []).map(async (it) => {
      it.image_url = it && it.image_url ? await fetchThumb(it.image_url) : null;
    })
  );
}

// ---------- Fonts ----------
// Satori needs raw TTF/OTF/WOFF data (no woff2). Google Fonts serves static
// instances in those formats when the request UA predates woff2 support.
// Cached at module level so warm isolates skip the fetch entirely.
const FONT_SPECS = [
  { name: 'Bitter',   weight: 700, css: 'Bitter:wght@700' },
  // Title face (2026-10-11): Big Shoulders Display, same as the app and site titles.
  { name: 'Big Shoulders Display', weight: 900, css: 'Big+Shoulders+Display:wght@900' },
  { name: 'JetBrains Mono', weight: 700, css: 'JetBrains+Mono:wght@700' },
  { name: 'Instrument Sans', weight: 600, css: 'Instrument+Sans:wght@600' },
  // Tagline face: Bitter italic, same as the site and app mastheads.
  { name: 'Bitter', weight: 400, style: 'italic', css: 'Bitter:ital,wght@1,400' },
];
let fontCache = null;

async function loadFonts() {
  if (fontCache) return fontCache;
  fontCache = await Promise.all(
    FONT_SPECS.map(async (spec) => ({
      name: spec.name,
      weight: spec.weight,
      style: spec.style || 'normal',
      data: await fetchGoogleFontTtf(spec.css),
    }))
  );
  return fontCache;
}

async function fetchGoogleFontTtf(cssFamily) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${cssFamily}&display=swap`;
  const css = await (
    await fetch(cssUrl, {
      // Old UA => Google serves TTF instead of woff2.
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:12.0) Gecko/20100101 Firefox/12.0' },
    })
  ).text();
  const match = css.match(/src:\s*url\((https:[^)]+)\)\s*format\('(?:truetype|opentype|woff)'\)/);
  if (!match) throw new Error(`No usable font url for ${cssFamily}`);
  const fontRes = await fetch(match[1]);
  if (!fontRes.ok) throw new Error(`Font fetch failed for ${cssFamily}`);
  return fontRes.arrayBuffer();
}
