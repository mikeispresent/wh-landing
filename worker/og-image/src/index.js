/**
 * WildHeavy — og-image Cloudflare Worker
 *
 * Renders 1200x630 PNG share cards for public content:
 *   /og/r/{slug}.png  -> ranking card
 *   /og/m/{slug}.png  -> menu card
 *   /og/t/{slug}.png  -> spots / route card
 *
 * The share-preview Worker points its og:image tags here, so iMessage /
 * IG DM / Twitter unfurls show the actual content (top items, ratings,
 * stops) instead of a lone photo or the logo.
 *
 * Design language: "The Institution" — mirrors share-preview.js tokens.
 * Any failure redirects to the static og-image.png so scrapers always
 * get an image.
 *
 * Deploy: npm install && npx wrangler deploy   (Workers Paid plan required)
 */

import { ImageResponse } from 'workers-og';

const EDGE_FN = 'https://kufhzivrzvqayvzbwrpn.supabase.co/functions/v1/share-preview';
const PREFIX_TO_TYPE = { r: 'ranking', m: 'menu_card', t: 'route' };
const FALLBACK_IMG = 'https://wildheavy.com/og-image.png';
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];

// Institution palette — keep in sync with share-preview.js / wh-design.css.
const C = {
  paper: '#EDEBE3',
  bright: '#F4F2EA',
  dark: '#E3E0D6',
  ink: '#1A3629',
  mute: 'rgba(26,54,41,0.58)',
  gold: '#B8904A',
  goldSoft: '#9E7A3B',
  oxblood: '#8B2A2A',
  rule: 'rgba(26,54,41,0.18)',
  ruleGold: 'rgba(184,144,74,0.55)',
};

const WIDTH = 1200;
const HEIGHT = 630;
const MAX_ROWS = 3; // items shown on the card; spots/routes show up to 4

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/og\/([rmt])\/([A-Za-z0-9_-]{8,32})\.png$/);
    if (!match) return Response.redirect(FALLBACK_IMG, 302);

    // Edge cache: scrapers hit once, everyone after gets the cached PNG.
    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
      const [, prefix, slug] = match;
      const type = PREFIX_TO_TYPE[prefix];

      const res = await fetch(`${EDGE_FN}?type=${type}&slug=${slug}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return Response.redirect(FALLBACK_IMG, 302);
      const data = await res.json();

      // Swap remote photo URLs for time-boxed data URIs before rendering.
      if (data.content_type === 'ranking') {
        await resolveImages((data.ranking?.items_preview || []).slice(0, MAX_ROWS));
      } else if (data.content_type === 'menu_card') {
        await resolveImages((data.menu_card?.dishes_preview || []).slice(0, MAX_ROWS));
      }

      const html = buildCard(data);
      if (!html) return Response.redirect(FALLBACK_IMG, 302);

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
      ctx.waitUntil(cache.put(request, response.clone()));
      return response;
    } catch {
      return Response.redirect(FALLBACK_IMG, 302);
    }
  },
};

// ---------- Card dispatch ----------
function buildCard(data) {
  const creator = data.creator || {};
  const creatorName = creator.display_name || creator.username || 'A WildHeavy regular';
  const handle = creator.username ? `@${creator.username}` : '';

  if (data.content_type === 'ranking') return rankingCard(data.ranking, creatorName, handle);
  if (data.content_type === 'menu_card') return menuCardCard(data.menu_card, creatorName, handle);
  if (data.content_type === 'route') return routeCard(data.route, creatorName, handle);
  return null;
}

// ---------- Ranking ----------
function rankingCard(r, creatorName, handle) {
  const total = r.total_item_count || (r.items_preview || []).length;
  const items = (r.items_preview || []).slice(0, MAX_ROWS);
  const remaining = Math.max(0, total - items.length);

  const rows = items
    .map((d, i) => {
      const pos = ROMAN[i] || String(i + 1);
      return row(
        `<div style="display:flex;width:56px;justify-content:center;font-family:Fraunces;font-size:36px;color:${C.gold};">${esc(pos)}</div>`,
        `<div style="display:flex;flex-direction:column;flex:1;min-width:0;">
           <div style="display:flex;font-family:Fraunces;font-weight:500;font-size:28px;color:${C.ink};max-width:760px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(clip(d.name || 'Unnamed', 48))}</div>
           ${d.restaurant_name ? `<div style="display:flex;font-family:'JetBrains Mono';font-size:14px;letter-spacing:2px;color:${C.mute};margin-top:3px;">${esc(clip(d.restaurant_name.toUpperCase(), 46))}</div>` : ''}
         </div>`,
        thumb(d.image_url)
      );
    })
    .join('');

  const eyebrow = `RANKING${total ? ` · ${total} ${total === 1 ? 'ENTRY' : 'ENTRIES'}` : ''}`;
  const foot = remaining > 0 ? `+ ${remaining} MORE — IN THE APP` : 'FULL LIST IN THE APP';

  return shell({ eyebrow, title: r.title || 'Untitled ranking', sub: bylineLine(creatorName, handle, r.city), rows, foot });
}

// ---------- Menu card ----------
function menuCardCard(m, creatorName, handle) {
  const total = m.total_dish_count || (m.dishes_preview || []).length;
  const dishes = (m.dishes_preview || []).slice(0, MAX_ROWS);
  const remaining = Math.max(0, total - dishes.length);

  const rows = dishes
    .map((d) => {
      const label = ratingLabel(d.rating);
      return row(
        thumb(d.image_url),
        `<div style="display:flex;flex-direction:column;flex:1;min-width:0;">
           <div style="display:flex;font-family:Fraunces;font-weight:500;font-size:28px;color:${C.ink};max-width:800px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(clip(d.name || 'Unnamed dish', 48))}</div>
           ${d.rating != null
             ? `<div style="display:flex;align-items:center;margin-top:6px;">
                  ${ratingBars(d.rating)}
                  ${label ? `<div style="display:flex;font-family:'JetBrains Mono';font-size:15px;letter-spacing:2px;color:${C.mute};margin-left:14px;">${esc(label.toUpperCase())}</div>` : ''}
                </div>`
             : ''}
         </div>`,
        ''
      );
    })
    .join('');

  const eyebrow = `MENU CARD${total ? ` · ${total} ${total === 1 ? 'DISH LOGGED' : 'DISHES LOGGED'}` : ''}`;
  const foot = remaining > 0 ? `+ ${remaining} MORE DISHES — IN THE APP` : 'EVERY NOTE IN THE APP';

  return shell({ eyebrow, title: m.restaurant_name || 'Restaurant', sub: bylineLine(creatorName, handle), rows, foot });
}

// ---------- Spots / Route ----------
function routeCard(t, creatorName, handle) {
  const isSpots = t.kind === 'spots';
  let stops = Array.isArray(t.stops) ? t.stops : [];
  if (stops.length === 0 && (t.start_stop || t.end_stop)) {
    stops = [t.start_stop, t.end_stop].filter(Boolean); // pre-Spots payload compat
  }
  const total = t.total_stop_count || stops.length;
  const shown = stops.slice(0, 4);
  const remaining = Math.max(0, total - shown.length);
  const lastIdx = shown.length - 1;

  const rows = shown
    .map((s, i) => {
      const marker = isSpots
        ? `<div style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:22px;background:${C.gold};color:${C.bright};font-family:'JetBrains Mono';font-weight:700;font-size:18px;">●</div>`
        : `<div style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:22px;background:${C.gold};color:${C.bright};font-family:'JetBrains Mono';font-weight:700;font-size:18px;">${i + 1}</div>`;
      // "END" only when this is genuinely the route's final stop (nothing hidden).
      const isTrueEnd = i === lastIdx && remaining === 0 && stops.length > 1;
      const label = isSpots
        ? ''
        : (i === 0 ? 'START' : isTrueEnd ? 'END' : `STOP ${i + 1}`);
      return `
        <div style="display:flex;align-items:center;padding:10px 0;">
          <div style="display:flex;width:64px;justify-content:center;">${marker}</div>
          <div style="display:flex;flex-direction:column;flex:1;min-width:0;margin-left:16px;">
            ${label ? `<div style="display:flex;font-family:'JetBrains Mono';font-size:13px;letter-spacing:3px;color:${C.goldSoft};margin-bottom:2px;">${esc(label)}</div>` : ''}
            <div style="display:flex;font-family:Fraunces;font-weight:500;font-size:30px;color:${C.ink};max-width:900px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(clip(s?.name || 'Unnamed', 52))}</div>
          </div>
        </div>`;
    })
    .join('');

  const noun = isSpots ? (total === 1 ? 'PLACE' : 'PLACES') : (total === 1 ? 'STOP' : 'STOPS');
  const eyebrow = `${isSpots ? 'SPOTS' : 'ROUTE'}${total ? ` · ${total} ${noun}` : ''}`;
  const foot = remaining > 0 ? `+ ${remaining} MORE — IN THE APP` : 'NOTES FROM THE TABLE IN THE APP';

  return shell({
    eyebrow,
    title: t.title || (isSpots ? 'Untitled Spots' : 'Untitled route'),
    sub: bylineLine(creatorName, handle, t.city),
    rows,
    foot,
    rowsGap: 0,
  });
}

// ---------- Shared layout ----------
function shell({ eyebrow, title, sub, rows, foot, rowsGap = 12 }) {
  const t = clip(title, 60);
  const titleSize = t.length > 30 ? 42 : 52;

  return `
  <div style="display:flex;flex-direction:column;width:${WIDTH}px;height:${HEIGHT}px;background:${C.paper};padding:36px;">
    <div style="display:flex;flex-direction:column;flex:1;background:${C.bright};border:1px solid ${C.rule};border-radius:6px;padding:36px 48px 32px;">

      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;">
          <div style="display:flex;width:26px;height:2px;background:${C.gold};margin-right:14px;"></div>
          <div style="display:flex;font-family:'JetBrains Mono';font-weight:700;font-size:18px;letter-spacing:5px;color:${C.goldSoft};">${esc(eyebrow)}</div>
        </div>
        <div style="display:flex;font-family:'JetBrains Mono';font-weight:700;font-size:18px;letter-spacing:5px;color:${C.ink};">WILDHEAVY</div>
      </div>

      <div style="display:flex;font-family:Fraunces;font-weight:500;font-size:${titleSize}px;line-height:1.05;color:${C.ink};margin-top:14px;max-width:1080px;">${esc(t)}</div>
      ${sub ? `<div style="display:flex;font-family:'JetBrains Mono';font-size:16px;letter-spacing:2px;color:${C.mute};margin-top:10px;">${esc(sub)}</div>` : ''}

      <div style="display:flex;flex-direction:column;flex:1;justify-content:center;margin-top:14px;overflow:hidden;${rowsGap ? `gap:${rowsGap}px;` : ''}">
        ${rows || `<div style="display:flex;font-family:Fraunces;font-size:28px;color:${C.mute};">Nothing plated yet.</div>`}
      </div>

      <div style="display:flex;align-items:center;margin-top:14px;">
        <div style="display:flex;flex:1;height:1px;background:linear-gradient(90deg,rgba(184,144,74,0.05),${C.gold},rgba(184,144,74,0.05));"></div>
      </div>
      <div style="display:flex;justify-content:center;margin-top:10px;">
        <div style="display:flex;font-family:'JetBrains Mono';font-weight:700;font-size:16px;letter-spacing:4px;color:${C.oxblood};">${esc(foot)}</div>
      </div>

    </div>
  </div>`;
}

// A standard content row: [left][middle][right] on paper background.
function row(left, middle, right) {
  return `
  <div style="display:flex;align-items:center;background:${C.paper};border:1px solid ${C.rule};border-radius:4px;padding:10px 16px;">
    ${left}
    <div style="display:flex;flex:1;min-width:0;margin-left:16px;margin-right:16px;">${middle}</div>
    ${right}
  </div>`;
}

function thumb(dataUri) {
  return dataUri
    ? `<div style="display:flex;width:72px;height:72px;border-radius:4px;overflow:hidden;border:1px solid ${C.rule};"><img src="${dataUri}" width="72" height="72" style="width:72px;height:72px;object-fit:cover;" /></div>`
    : `<div style="display:flex;width:72px;height:72px;border-radius:4px;background:${C.dark};border:1px solid ${C.rule};"></div>`;
}

function bylineLine(name, handle, city) {
  const parts = [`BY ${name.toUpperCase()}`];
  if (handle) parts.push(handle.toUpperCase());
  if (city) parts.push(city.toUpperCase());
  return clip(parts.join(' · '), 70);
}

// 5-segment brass bars — mirrors the app's rating scale without star glyphs
// (glyph coverage in embedded fonts is not guaranteed).
function ratingBars(n) {
  const filled = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
  let bars = '';
  for (let i = 0; i < 5; i++) {
    bars += `<div style="display:flex;width:24px;height:8px;border-radius:2px;background:${C.gold};opacity:${i < filled ? 1 : 0.22};margin-right:5px;"></div>`;
  }
  return `<div style="display:flex;align-items:center;">${bars}</div>`;
}

// Mirrors src/lib/ratingDefinitions.ts — keep in sync.
function ratingLabel(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  switch (Math.round(Number(n))) {
    case 5: return 'Top Rank Worthy';
    case 4: return "Can't Miss";
    case 3: return 'Solid';
    case 2: return 'Decent';
    case 1: return 'Skip It';
    default: return '';
  }
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
  { name: 'Fraunces', weight: 500, css: 'Fraunces:opsz,wght@144,500' },
  { name: 'JetBrains Mono', weight: 700, css: 'JetBrains+Mono:wght@700' },
];
let fontCache = null;

async function loadFonts() {
  if (fontCache) return fontCache;
  fontCache = await Promise.all(
    FONT_SPECS.map(async (spec) => ({
      name: spec.name,
      weight: spec.weight,
      style: 'normal',
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

// ---------- Helpers ----------
function clip(s, max) {
  const str = String(s ?? '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// NOTE: satori-html does NOT decode HTML entities, so classic escaping
// (&amp; etc.) renders literally on the card. Only neutralize tag-opening
// characters; everything else passes through as plain text.
function esc(s) {
  return String(s ?? '')
    .replace(/</g, '‹')
    .replace(/>/g, '›');
}
