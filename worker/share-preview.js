/**
 * WildHeavy — share-preview Cloudflare Worker
 *
 * Intercepts public share links on wildheavy.com:
 *   /r/{slug}  -> ranking preview
 *   /m/{slug}  -> menu card preview
 *   /t/{slug}  -> route preview
 *
 * Everything else passes through to the origin (GitHub Pages).
 *
 * Design language: "The Institution" — Minetta Tavern meets French Laundry
 * meets Apple precision. Source of truth for tokens: wh-design.css.
 *
 * Deploy:
 *   1. Cloudflare Dashboard -> Workers & Pages -> share-preview Worker
 *   2. Paste this file into the editor, Save & Deploy
 *   3. Routes already wired:
 *        wildheavy.com/r/*   ->  share-preview
 *        wildheavy.com/m/*   ->  share-preview
 *        wildheavy.com/t/*   ->  share-preview
 */

const EDGE_FN = 'https://dxwjkuqsncatvovjwrzv.supabase.co/functions/v1/share-preview';
const PREFIX_TO_TYPE = { r: 'ranking', m: 'menu_card', t: 'route' };

// Roman numerals for top-N positions (preview shows ≤3, supports up to 10).
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];

// ---------- App Store config ----------
// Set APP_STORE_APP_ID once you have an iTunes app ID from App Store Connect.
// When set, iOS Safari renders Apple's Smart App Banner at the top of the
// preview, and the in-page CTA on iOS becomes "Get on the App Store"
// pointing at the App Store URL. Desktop CTA is unaffected.
//
// Until the app is approved, leaving this empty is fine — the Worker falls
// back to the wildheavy.app CTA on every device. Flip the constant once
// you have the ID and redeploy. No other changes needed.
const APP_STORE_APP_ID = '6758928194';

// Install tracking. Paste the provider token from App Store Connect
// (Analytics > Sources > Campaigns > create a link) and every App Store link
// from a share page carries a campaign name (share_menu, share_rank,
// share_spread), so installs from shared links show up there. Empty = off.
const APP_STORE_PROVIDER_TOKEN = '128451653';

function appStoreUrl(campaign) {
  if (!APP_STORE_APP_ID) return 'https://wildheavy.app';
  const base = `https://apps.apple.com/app/id${APP_STORE_APP_ID}`;
  return APP_STORE_PROVIDER_TOKEN && campaign
    ? `${base}?pt=${APP_STORE_PROVIDER_TOKEN}&ct=${campaign}&mt=8`
    : base;
}

// True for iPhone, iPod, and iPads running iPadOS that still report 'iPad'
// in the UA. Modern iPad Safari spoofs Mac UA by default, but the App Store
// install flow is iPhone-first anyway — this catches the volume.
function isIos(userAgent) {
  if (!userAgent) return false;
  return /iPhone|iPod|iPad/.test(userAgent);
}

// ---------- Router ----------
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/([rmt])\/([A-Za-z0-9_-]{8,32})\/?$/);

    // Not a share path -> pass through to GitHub Pages origin.
    if (!match) return fetch(request);

    const [, prefix, slug] = match;
    const type = PREFIX_TO_TYPE[prefix];
    const ctx = { ios: isIos(request.headers.get('User-Agent') || '') };

    let res;
    try {
      res = await fetch(`${EDGE_FN}?type=${type}&slug=${slug}`, {
        headers: { Accept: 'application/json' },
      });
    } catch {
      return renderPage(errorState('We couldn\u2019t reach the kitchen. Try again in a minute.'), 200, ctx);
    }

    if (res.status === 410) return renderPage(unavailableState(), 410, ctx);
    if (res.status === 404 || res.status === 400) return renderPage(notFoundState(), 404, ctx);
    if (!res.ok) return renderPage(errorState('Something went sideways. Try again.'), 502, ctx);

    let data;
    try {
      data = await res.json();
    } catch {
      return renderPage(errorState('Bad response from the kitchen.'), 502, ctx);
    }

    return renderPage(previewState(data, slug, ctx), 200, ctx);
  },
};

// ---------- State builders ----------
function previewState(data, slug, ctx = {}) {
  const creator = data.creator || {};
  const creatorName = creator.display_name || creator.username || 'A WildHeavy regular';
  const creatorHandle = creator.username ? `@${creator.username}` : '';
  const avatar = creator.avatar_url || '';

  if (data.content_type === 'ranking') {
    const r = data.ranking;
    const appUrl = buildAppUrl('ranking', r.id);
    return {
      status: 'ok',
      ogTitle: `${r.title} by ${creatorName}`,
      ogDescription: buildRankingDescription(r),
      ogImage: dynamicOgImage('ranking', slug),
      appUrl,
      campaign: 'share_rank',
      bodyHtml: rankingBody({ r, creator: { name: creatorName, handle: creatorHandle, avatar }, appUrl, ctx }),
    };
  }

  if (data.content_type === 'menu_card') {
    const m = data.menu_card;
    const appUrl = buildAppUrl('menu_card', m.id);
    return {
      status: 'ok',
      ogTitle: `${m.restaurant_name}, a menu card by ${creatorName}`,
      ogDescription: buildMenuCardDescription(m),
      ogImage: dynamicOgImage('menu_card', slug),
      appUrl,
      campaign: 'share_menu',
      bodyHtml: menuCardBody({ m, creator: { name: creatorName, handle: creatorHandle, avatar }, appUrl, ctx }),
    };
  }

  // route
  const t = data.route;
  const appUrl = buildAppUrl('route', t.id);
  // Backward compat: payloads without `kind` (pre-Spots edge fn) are ordered.
  const isSpots = t.kind === 'spots';
  return {
    status: 'ok',
    ogTitle: isSpots
      ? `${t.title}: Spots${t.city ? ` in ${t.city}` : ` by ${creatorName}`}`
      : `${t.title}, a route by ${creatorName}`,
    ogDescription: buildRouteDescription(t),
    ogImage: dynamicOgImage('route', slug),
    appUrl,
    campaign: 'share_spread',
    bodyHtml: routeBody({ t, creator: { name: creatorName, handle: creatorHandle, avatar }, appUrl, ctx }),
  };
}

function unavailableState() {
  return {
    status: 'unavailable',
    ogTitle: 'WildHeavy',
    ogDescription: 'This link isn\u2019t available right now.',
    ogImage: 'https://wildheavy.com/og-image.png',
    // /feed (not the bare domain) so iOS opens the installed app: the
    // wildheavy.app app-site-association lists /feed but not "/".
    appUrl: 'https://wildheavy.app/feed',
    bodyHtml: stateHtml({
      kicker: 'Off the menu',
      title: 'This link isn\u2019t on the menu.',
      sub: 'The regular who made this either set it private or pulled it down.',
      ctaLabel: 'Open WildHeavy',
      ctaHref: 'https://wildheavy.app/feed',
    }),
  };
}

function notFoundState() {
  return {
    status: 'not_found',
    ogTitle: 'WildHeavy',
    ogDescription: 'We couldn\u2019t find that link.',
    ogImage: 'https://wildheavy.com/og-image.png',
    appUrl: 'https://wildheavy.app',
    bodyHtml: stateHtml({
      title: 'Nothing in the kitchen by that name.',
      ctaLabel: 'Back to WildHeavy',
      ctaHref: 'https://wildheavy.com',
    }),
  };
}

function errorState(msg) {
  return {
    status: 'error',
    ogTitle: 'WildHeavy',
    ogDescription: 'Something went wrong loading this link.',
    ogImage: 'https://wildheavy.com/og-image.png',
    appUrl: 'https://wildheavy.app',
    bodyHtml: stateHtml({
      kicker: 'Hiccup',
      title: 'A hiccup in the kitchen.',
      sub: msg,
      ctaLabel: 'Back to WildHeavy',
      ctaHref: 'https://wildheavy.com',
    }),
  };
}

function stateHtml({ kicker, title, sub, ctaLabel, ctaHref }) {
  return `
    <section class="state">
      ${kicker ? `<div class="eyebrow"><span>${esc(kicker)}</span></div>` : ''}
      <h1 class="state__title">${esc(title)}</h1>
      ${sub ? `<p class="state__sub">${esc(sub)}</p>` : ''}
      <a class="btn btn--primary" href="${esc(ctaHref)}">${esc(ctaLabel)} \u2192</a>
    </section>`;
}

// ---------- Body templates ----------
// ---------- Ranking (the app's layout) ----------
//
// Mirrors RankingDetail.tsx: brass pen rule, category title with the city,
// the Giver, the top 3 (TopThree.tsx), then #4 to #20 as rows (RankListRow.tsx).
// The app folds anything past #20; the page says how many more are in the app.

function rankNumeral(n, tone, size) {
  return `<span class="rk-n rk-n--${size} rk-n--${tone}" aria-hidden="true">${n}</span>`;
}

function rankingBody({ r, creator, appUrl, ctx }) {
  const restOnly = r.is_restaurant_only === true;
  const items = (r.items_all || r.items_preview || []).map((d, i) => ({
    rank: i + 1,
    name: (restOnly ? d.restaurant_name : d.name) || d.name || 'Unnamed',
    sub: restOnly ? '' : d.restaurant_name || '',
    photo: d.image_url || '',
  }));
  const total = Math.max(r.total_item_count || 0, items.length);
  const hiddenCount = Math.max(0, total - items.length);

  const podium = items.slice(0, 3);
  const list = items.slice(3);

  const subLine = (it, cls = '') => (it.sub ? `<span class="rk-sub ${cls}">${esc(it.sub)}</span>` : '');

  let top = '';
  if (podium.length) {
    const first = podium[0];
    const lead = first.photo
      ? `<img class="rk-lead__img" src="${esc(first.photo)}" alt="">
         <div class="rk-lead__cap">${rankNumeral(1, 'brass', 'xl')}<span class="rk-lead__txt"><span class="rk-name rk-name--lead">${esc(first.name)}</span>${subLine(first, 'rk-sub--lead')}</span></div>`
      : `<div class="rk-lead__nophoto">${rankNumeral(1, 'brass', 'xl')}
          <div class="rk-bracketed">${penBracket(true)}<span class="rk-name rk-name--lead">${esc(first.name)}</span>${subLine(first, 'rk-sub--lead')}</div>
        </div>`;
    const others = podium.slice(1).map((it) =>
      it.photo
        ? `<div class="rk-tile"><img src="${esc(it.photo)}" alt="" loading="lazy">
            <div class="rk-tile__cap">${rankNumeral(it.rank, 'leather', 'lg')}<span><span class="rk-name rk-name--tile">${esc(it.name)}</span>${subLine(it)}</span></div></div>`
        : `<div class="rk-tile"><div class="rk-tile__box">${penBracket(true)}<span class="rk-name rk-name--tile rk-name--clamp">${esc(it.name)}</span></div>
            <div class="rk-tile__cap">${rankNumeral(it.rank, 'leather', 'lg')}<span>${subLine(it)}</span></div></div>`,
    ).join('');
    top = `<section class="rk-top" aria-label="Top 3">
        <div class="rk-lead">${lead}</div>
        ${others ? `<div class="rk-tiles">${others}</div>` : ''}
      </section>`;
  }

  const rows = list
    .map(
      (it) => `<li class="rk-row">
        <span class="rk-row__n">${rankNumeral(it.rank, 'leather', 'md')}</span>
        <span class="rk-row__text"><span class="rk-name">${esc(it.name)}</span>${subLine(it)}</span>
        ${it.photo ? `<img class="rk-row__img" src="${esc(it.photo)}" alt="" loading="lazy">` : ''}
      </li>`,
    )
    .join('');
  const listSection = list.length || hiddenCount
    ? `<section class="rk-list" aria-label="The list">
        ${list.length ? `<div class="m-between rk-list__hd"><span class="rk-list__lbl">The list</span><span class="m-cnt">4 to ${items.length}</span></div><ul>${rows}</ul>` : ''}
        ${hiddenCount ? `<p class="rk-more">The rest of the list · ${hiddenCount} more in the app</p>` : ''}
      </section>`
    : '';

  const cityOnly = String(r.city || '').split(',')[0].trim();
  const title = r.category || r.title || 'Ranking';
  const longTitle = Array.from(String(title).trim()).length > 24;
  const initial = (creator.handle || creator.name || '?').replace(/^@/, '').trim().slice(0, 1).toUpperCase();
  const author = `<div class="m-author">
      ${creator.avatar
        ? `<img class="m-avatar" src="${esc(creator.avatar)}" alt="" loading="lazy">`
        : `<span class="m-avatar m-avatar--empty">${esc(initial)}</span>`}
      <span class="m-author__name">${esc(creator.handle || creator.name)}</span>
    </div>`;

  return `
    <article class="m-sheet">
      <div class="m-top">
        <span class="m-kind">Ranking</span>
        <span class="m-cnt">${total} ${total === 1 ? 'dish' : 'dishes'}</span>
      </div>
      ${penRule('pen-rule--brass')}
      <div class="m-between rk-head">
        <h1 class="m-title m-title--page${longTitle ? ' m-title--long' : ''}" dir="auto">${esc(title)}</h1>
        ${cityOnly ? `<span class="rk-city">${esc(cityOnly)}</span>` : ''}
      </div>
      ${author}
      ${top}
      ${listSection}
      ${signupCta('See the full ranking', appUrl, ctx, { campaign: 'share_rank', note: 'Rank your own in the app.', cls: 'm-cta' })}
    </article>`;
}

// ---------- Menu Card (the app's layout, "The Order") ----------
//
// Mirrors MenuCardSheet.tsx. The ordering rules below are ports of
// src/lib/whatToOrder.ts, src/lib/dishVerdicts.ts and menuCardLines.ts. Keep
// them in step with the app: if those files change, change these.

const PEN_CORNER = 'M56 2.90L55.12 2.84L54.25 2.79L53.37 2.74L52.49 2.68L51.62 2.63L50.74 2.58L49.86 2.54L48.99 2.49L48.11 2.45L47.24 2.41L46.36 2.38L45.49 2.35L44.61 2.32L43.74 2.30L42.86 2.28L41.99 2.27L41.11 2.26L40.24 2.26L39.37 2.26L38.49 2.27L37.62 2.28L36.74 2.28L35.87 2.29L35 2.29L34.12 2.30L33.25 2.30L32.37 2.30L31.50 2.30L30.63 2.30L29.75 2.30L28.88 2.30L28 2.29L27.13 2.29L26.26 2.28L25.38 2.28L24.51 2.27L23.63 2.26L22.76 2.25L21.89 2.24L21.01 2.23L20.14 2.22L19.26 2.21L18.39 2.20L17.52 2.19L16.64 2.17L15.77 2.16L14.89 2.15L14.02 2.13L13.14 2.11L12.27 2.10L11.39 2.08L10.52 2.07L9.64 2.05L8.77 2.03L7.89 2.02L6.96 2L6.02 2.10L5.09 2.38L4.22 2.84L3.46 3.46L2.84 4.22L2.38 5.09L2.10 6.02L2 6.95L2 7.75L2 8.50L2 9.25L2 10L4 10L4 9.25L4 8.50L4 7.75L4 7.05L4.06 6.41L4.23 5.85L4.51 5.33L4.88 4.88L5.33 4.51L5.85 4.23L6.41 4.06L7.04 4L7.86 4.02L8.73 4.03L9.61 4.05L10.48 4.07L11.36 4.08L12.23 4.10L13.11 4.11L13.98 4.13L14.86 4.14L15.73 4.16L16.61 4.17L17.48 4.19L18.36 4.20L19.24 4.21L20.11 4.22L20.99 4.23L21.86 4.24L22.74 4.25L23.62 4.26L24.49 4.27L25.37 4.28L26.24 4.28L27.12 4.29L28 4.29L28.87 4.30L29.75 4.30L30.62 4.30L31.50 4.30L32.38 4.30L33.25 4.30L34.13 4.30L35 4.29L35.88 4.29L36.76 4.28L37.63 4.28L38.51 4.27L39.38 4.26L40.26 4.25L41.14 4.23L42.01 4.20L42.89 4.16L43.76 4.12L44.64 4.08L45.51 4.03L46.39 3.97L47.26 3.91L48.14 3.84L49.01 3.77L49.89 3.69L50.76 3.62L51.63 3.53L52.51 3.45L53.38 3.36L54.25 3.28L55.13 3.19L56 3.10Z';
const PEN_MIDDLE = 'M2.09 0L2.10 16.67L2.11 33.33L2.12 50L2.14 66.67L2.15 83.33L2.16 100L2.17 116.67L2.18 133.33L2.18 150L2.19 166.67L2.20 183.33L2.21 200L2.21 216.67L2.22 233.33L2.22 250L2.23 266.67L2.23 283.33L2.24 300L2.24 316.67L2.24 333.33L2.24 350L2.24 366.67L2.24 383.33L2.24 400L2.24 416.67L2.23 433.33L2.23 450L2.23 466.67L2.22 483.33L2.22 500L2.21 516.67L2.20 533.33L2.20 550L2.19 566.67L2.18 583.33L2.17 600L2.16 616.67L2.15 633.33L2.14 650L2.13 666.67L2.12 683.33L2.11 700L2.09 716.67L2.08 733.33L2.07 750L2.06 766.67L2.04 783.33L2.03 800L2.02 816.67L2 833.33L1.99 850L1.98 866.67L1.96 883.33L1.95 900L1.94 916.67L1.92 933.33L1.91 950L1.90 966.67L1.89 983.33L1.88 1000L3.78 1000L3.80 983.33L3.81 966.67L3.83 950L3.85 933.33L3.87 916.67L3.89 900L3.91 883.33L3.93 866.67L3.95 850L3.97 833.33L3.99 816.67L4.02 800L4.04 783.33L4.06 766.67L4.08 750L4.10 733.33L4.12 716.67L4.14 700L4.16 683.33L4.18 666.67L4.20 650L4.21 633.33L4.23 616.67L4.25 600L4.26 583.33L4.28 566.67L4.29 550L4.30 533.33L4.31 516.67L4.32 500L4.33 483.33L4.34 466.67L4.35 450L4.35 433.33L4.36 416.67L4.36 400L4.36 383.33L4.36 366.67L4.36 350L4.36 333.33L4.35 316.67L4.35 300L4.34 283.33L4.34 266.67L4.33 250L4.32 233.33L4.31 216.67L4.29 200L4.28 183.33L4.27 166.67L4.25 150L4.24 133.33L4.22 116.67L4.20 100L4.19 83.33L4.17 66.67L4.15 50L4.13 33.33L4.11 16.67L4.09 -0Z';

const COURSE_LABEL = { drink: 'Drink', start: 'Starter', side: 'Side', main: 'Main', dessert: 'Dessert' };
const MEAL_LABEL = { brunch: 'Brunch', lunch: 'Lunch', dinner: 'Dinner', happy_hour: 'Happy Hour', just_drinks: 'Just Drinks' };

// dishVerdicts.ts: 4-5 must, 3 solid, 1-2 skip, anything else unrated.
function verdictFor(rating) {
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 1) return 'unrated';
  if (rating >= 4) return 'must';
  if (rating <= 2) return 'skip';
  return 'solid';
}

// whatToOrder.ts without the author's picks (the web page has no picks).
function whatToOrder(items, slots = 3) {
  const ranked = items.map((item, index) => ({ item, index, tier: Math.round(Number(item.rating)) }));
  const eligibleFn = (it) => !it.notTried && ['must', 'solid'].includes(verdictFor(it.rating));
  const auto = (a, b) => {
    if (a.tier !== b.tier) return b.tier - a.tier;
    const ap = a.item.hasPhoto ? 1 : 0;
    const bp = b.item.hasPhoto ? 1 : 0;
    if (ap !== bp) return bp - ap;
    const ac = Math.max(1, Number(a.item.orderCount) || 1);
    const bc = Math.max(1, Number(b.item.orderCount) || 1);
    if (ac !== bc) return bc - ac;
    return a.index - b.index;
  };

  const eligible = ranked.filter((r) => eligibleFn(r.item)).sort(auto);
  const tiers = [];
  for (const r of eligible) {
    const last = tiers[tiers.length - 1];
    if (last && last[0].tier === r.tier) last.push(r);
    else tiers.push([r]);
  }

  const top = [];
  const also = [];
  let remaining = slots;
  for (const tier of tiers) {
    if (remaining <= 0) { also.push(...tier); continue; }
    if (tier.length <= remaining) { top.push(...tier); remaining -= tier.length; continue; }
    const chosen = tier.slice(0, remaining);
    chosen.sort(auto);
    top.push(...chosen);
    also.push(...tier.filter((r) => !chosen.includes(r)));
    remaining = 0;
  }

  let mode = 'advice';
  if (top.length === 0) {
    const record = ranked
      .filter((r) => !r.item.notTried && verdictFor(r.item.rating) === 'skip')
      .sort(auto)
      .slice(0, slots);
    if (record.length > 0) { top.push(...record); mode = 'record'; }
    else mode = 'none';
  }

  const inTop = new Set(top.map((r) => r.index));
  const byLogged = (a, b) => a.index - b.index;
  const solid = also.filter((r) => verdictFor(r.item.rating) === 'solid');
  const skip = [];
  const notTried = [];
  for (const r of ranked) {
    if (inTop.has(r.index) || eligibleFn(r.item)) continue;
    const v = verdictFor(r.item.rating);
    if (r.item.notTried || v === 'unrated') notTried.push(r);
    else if (v === 'solid') solid.push(r);
    else if (v === 'skip') skip.push(r);
  }
  also.sort((a, b) => (a.tier !== b.tier ? b.tier - a.tier : a.index - b.index));
  const unwrap = (rs) => rs.map((r) => r.item);
  const rest = {
    alsoOrder: unwrap(also.filter((r) => verdictFor(r.item.rating) === 'must')),
    solid: unwrap(solid.sort(byLogged)),
    skip: unwrap(skip.sort(byLogged)),
    notTried: unwrap(notTried.sort(byLogged)),
  };
  return {
    top: unwrap(top),
    mode,
    rest,
    restCount: rest.alsoOrder.length + rest.solid.length + rest.skip.length + rest.notTried.length,
  };
}

// menuCardLines.ts: one shape for dishes and drinks.
function toMenuCardLines(m) {
  const src = Array.isArray(m.dishes_all)
    ? m.dishes_all
    : (m.dishes_preview || []).map((d) => ({ ...d, type: 'dish', course_type: 'main', order_count: 1 }));
  return src.map((d, i) => ({
    key: i,
    type: d.type === 'drink' ? 'drink' : 'dish',
    name: d.name || 'Unnamed dish',
    rating: typeof d.rating === 'number' ? d.rating : 0,
    not_tried: !!d.not_tried,
    order_count: Math.max(1, Number(d.order_count) || 1),
    is_seasonal: !!d.is_seasonal,
    is_shared: !!d.is_shared,
    course_type: d.type === 'drink' ? 'drink' : (COURSE_LABEL[d.course_type] ? d.course_type : 'main'),
    variant_name: d.variant_name || null,
    photo_url: d.image_url || null,
    notTried: !!d.not_tried,
    hasPhoto: !!d.image_url,
    orderCount: Math.max(1, Number(d.order_count) || 1),
  }));
}

function lineTags(l) {
  return [l.variant_name, l.is_shared ? 'Shared' : null, l.is_seasonal ? 'Seasonal' : null].filter(Boolean);
}

// How the table was booked. Mirrors bookingLine() in MenuCardVisitSheet.tsx,
// with the booking platforms as "Booked on: Resy".
function bookingLine(service) {
  if (!service) return '';
  const raw = String(service);
  const v = raw.startsWith('Other:') ? raw.slice(6).trim() : raw.trim();
  if (!v || v === 'Other') return '';
  switch (v) {
    case 'Walk-in': return 'Walked in';
    case 'Someone else': return 'Someone else booked';
    case 'Phone': return 'Booked by phone';
    case 'Email': return 'Booked by email';
    case 'Credit Card / Concierge': return 'Booked through Credit Card / Concierge';
    default: return `Booked on: ${v}`;
  }
}

function penRule(cls = '') {
  return `<div class="pen-rule ${cls}" aria-hidden="true"></div>`;
}

const PEN_CORNER_SHORT = PEN_CORNER.replace(/([ML])([\d.]+) /g, (_, c, x) => {
  const v = Number(x);
  return `${c}${v <= 8 ? v : 8 + (v - 8) * (32 / 52)} `;
});

function penBracket(short = false) {
  const w = short ? 40 : 60;
  const d = short ? PEN_CORNER_SHORT : PEN_CORNER;
  return `<div class="pbr${short ? ' pbr--short' : ''}" aria-hidden="true">
    <svg class="pbr-t" width="${w}" height="10" viewBox="0 0 ${w} 10"><path d="${d}"/></svg>
    <svg class="pbr-m" viewBox="0 0 6 1000" preserveAspectRatio="none"><path d="${PEN_MIDDLE}"/></svg>
    <svg class="pbr-b" width="${w}" height="10" viewBox="0 0 ${w} 10"><path d="${d}"/></svg>
  </div>`;
}

const BEAR = '<span class="m-bear" aria-hidden="true"></span>';

function verdictWord(rating, extra = '') {
  const best = Math.round(rating) === 5;
  return `<span class="m-verdict${best ? ' m-verdict--top' : ''} ${extra}">${best ? BEAR.replace('m-bear', 'm-bear m-bear--sm') : ''}${esc(ratingLabel(rating))}</span>`;
}

function orderCount(n) {
  return n > 1 ? `<span class="m-x" aria-label="${n} orders">×${n}</span>` : '';
}

function tableScale(step) {
  const s = Math.min(5, Math.max(0, Math.round(step)));
  const tone = s >= 4 ? 'ox' : s === 3 ? 'leather' : 'forest';
  let dots = '';
  for (let i = 0; i < 6; i++) dots += i === s ? `<i class="on on--${tone}"></i>` : '<i></i>';
  return `<div class="m-scale" role="img" aria-label="Getting a table: step ${s + 1} of 6">
    <div class="m-scale__track">${dots}</div>
    <div class="m-scale__ends"><span>Walk in</span><span>Insider only</span></div>
  </div>`;
}

function menuCardBody({ m, creator, appUrl, ctx }) {
  const isTasting = m.is_tasting_menu === true;
  const all = isTasting ? [] : toMenuCardLines(m);
  const dishesOnly = all.filter((l) => l.type === 'dish');
  // orderLines(): picks are about the food; with food on the card, drinks get their own bar.
  const lines = dishesOnly.length > 0 ? dishesOnly : all;
  const drinkBar = dishesOnly.length > 0 ? all.filter((l) => l.type === 'drink' && l.name.trim()) : [];
  const order = whatToOrder(lines);
  const top = order.top;
  const picksTitle = order.mode === 'record' ? 'What I ordered' : 'What to order';

  const ticket = m.ticket_number ? String(m.ticket_number).padStart(3, '0') : '';
  const title = m.restaurant_name || 'Restaurant';
  const longTitle = Array.from(title.trim()).length > 24;

  // ── Fact line: "Dinner for 4 | Oct 2026" ──
  const meal = MEAL_LABEL[m.meal_service] || '';
  const party = Number(m.party_size) || 0;
  const who = meal ? (party > 0 ? `${meal} for ${party}` : meal) : party > 0 ? `Party of ${party}` : '';
  const when = m.visit_date ? formatMonth(m.visit_date) : '';
  const factParts = [who, when].filter(Boolean);
  const facts = factParts.length || m.is_go_to
    ? `<div class="m-facts">
        ${factParts.length ? `<p>${factParts.map((p) => `<span>${esc(p)}</span>`).join('<span aria-hidden="true">|</span>')}</p>` : ''}
        ${m.is_go_to ? '<span class="m-marker"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.2 6.1 20.6l1.3-6.6L2.5 9.4l6.6-.8z"/></svg>Go-To</span>' : ''}
      </div>`
    : '';

  // ── Author ──
  const initial = (creator.handle || creator.name || '?').replace(/^@/, '').trim().slice(0, 1).toUpperCase();
  const author = `<div class="m-author">
      ${creator.avatar
        ? `<img class="m-avatar" src="${esc(creator.avatar)}" alt="" loading="lazy">`
        : `<span class="m-avatar m-avatar--empty">${esc(initial)}</span>`}
      <span class="m-author__name">${esc(creator.handle || creator.name)}</span>
    </div>`;

  // ── Getting a table ──
  const diff = typeof m.reservation_difficulty === 'number' ? m.reservation_difficulty : null;
  const booked = bookingLine(m.reservation_service);
  const tableNote = m.reservation_notes
    ? `<p class="m-note"><strong>${(diff ?? 0) > 3 ? 'Access strategy:' : 'Tips:'}</strong> <span class="m-pre">${esc(m.reservation_notes)}</span></p>`
    : '';
  const table = diff !== null || booked
    ? `<section class="m-table" aria-label="Getting a table">
        <div class="m-table__row">
          <span class="m-lbl">Getting a table</span>
          ${diff !== null ? `<span class="m-table__val"><b>${esc(reservationDifficultyLabel(diff))}</b></span>` : ''}
        </div>
        ${diff !== null ? tableScale(diff) : ''}
        ${booked ? `<p class="m-booked">${esc(booked)}</p>` : ''}
        ${tableNote}
      </section>`
    : (tableNote ? `<section class="m-table">${tableNote}</section>` : '');

  // ── Drinks ──
  const drinks = drinkBar.length
    ? `<section class="m-drinks" aria-label="Drinks">
        <div class="m-between"><span class="m-lbl">Drinks</span><span class="m-cnt">${drinkBar.length}</span></div>
        <ul>${drinkBar
          .map(
            (d) => `<li>
            ${d.photo_url ? `<img src="${esc(d.photo_url)}" alt="" loading="lazy">` : ''}
            <span class="m-drink__name">${esc(d.name)}${orderCount(d.order_count)}</span>
            ${!d.not_tried && d.rating > 0 ? `<span class="m-stars"><span aria-hidden="true">★</span> ${Math.round(d.rating)}</span>` : ''}
          </li>`,
          )
          .join('')}</ul>
      </section>`
    : '';

  // ── Rows ──
  const courseWord = (l) => `<span class="m-course">${esc(COURSE_LABEL[l.course_type] || 'Main')}</span>`;
  const restRow = (l, group) => {
    const factsLine = [COURSE_LABEL[l.course_type] || 'Main', ...lineTags(l)].join(' · ');
    const showVerdict = group !== 'Didn’t try' && !l.not_tried && Math.round(l.rating) >= 1;
    return `<li class="m-row">
      <span class="m-row__text">
        <span class="m-name">${esc(l.name)}${orderCount(l.order_count)}</span>
        <span class="m-course">${esc(factsLine)}</span>
        ${showVerdict ? verdictWord(l.rating, 'm-verdict--row') : ''}
      </span>
      ${l.photo_url ? `<img class="m-row__img" src="${esc(l.photo_url)}" alt="" loading="lazy">` : ''}
    </li>`;
  };
  const restGroups = [
    ['Also order', order.rest.alsoOrder],
    ['Solid', order.rest.solid],
    ['Skip these', order.rest.skip],
    ['Didn’t try', order.rest.notTried],
  ].filter(([, xs]) => xs.length > 0);
  const restList = restGroups
    .map(
      ([group, xs]) => `<section aria-label="${esc(group)}">
        <div class="m-group"><h3>${esc(group)}</h3><span class="m-cnt">${xs.length}</span></div>
        <ul>${xs.map((l) => restRow(l, group)).join('')}</ul>
      </section>`,
    )
    .join('');

  // ── Picks: up to 3 ──
  let picks = '';
  if (!isTasting && top.length > 0) {
    const first = top[0];
    const others = top.slice(1);
    const othersAsTiles = others.length === 2 && others.every((l) => !!l.photo_url);
    const lead = first.photo_url
      ? `<div class="m-lead">
          <img src="${esc(first.photo_url)}" alt="${esc(first.name)}">
          <div class="m-between m-lead__cap">
            <span><span class="m-name m-name--lead">${esc(first.name)}${orderCount(first.order_count)}</span>${courseWord(first)}</span>
            ${verdictWord(first.rating)}
          </div>
        </div>`
      : `<div class="m-bracketed">
          ${penBracket()}
          ${verdictWord(first.rating)}
          <span class="m-hero">${esc(first.name)}${orderCount(first.order_count)}</span>
          ${courseWord(first)}
        </div>`;
    const more = othersAsTiles
      ? `<div class="m-tiles">${others
          .map(
            (l) => `<div class="m-tile">
              <img src="${esc(l.photo_url)}" alt="${esc(l.name)}" loading="lazy">
              <span class="m-name">${esc(l.name)}${orderCount(l.order_count)}</span>
              ${courseWord(l)}
              ${verdictWord(l.rating, 'm-verdict--tile')}
            </div>`,
          )
          .join('')}</div>`
      : others.length
        ? `<ul class="m-others">${others
            .map(
              (l) => `<li class="m-row m-row--big">
                <span class="m-row__text">
                  <span class="m-name m-name--big">${esc(l.name)}${orderCount(l.order_count)}</span>
                  ${courseWord(l)}
                  ${verdictWord(l.rating, 'm-verdict--row')}
                </span>
                ${l.photo_url ? `<img class="m-row__img m-row__img--big" src="${esc(l.photo_url)}" alt="" loading="lazy">` : ''}
              </li>`,
            )
            .join('')}</ul>`
        : '';
    picks = `<section aria-label="${esc(picksTitle)}">
        <div class="m-between m-sechd"><h2 class="m-title m-title--section">${esc(picksTitle)}</h2><span class="m-cnt">${top.length} of ${lines.length}</span></div>
        ${penRule()}
        ${lead}
        ${more}
      </section>`;
  } else if (!isTasting && top.length === 0 && order.restCount > 0) {
    picks = `<section aria-label="The order">
        <div class="m-between m-sechd"><h2 class="m-title m-title--section">The order</h2><span class="m-cnt">${lines.length}</span></div>
        ${penRule()}
        ${restList}
      </section>`;
  }

  const tastingCover = isTasting
    ? `<section aria-label="Part of the experience">
        <div class="m-sechd"><h2 class="m-title m-title--section">Part of the experience</h2></div>
        ${penRule()}
        <p class="m-note m-note--plain">The chef planned these courses as a surprise. They open in the app once you log your visit or the menu changes.</p>
      </section>`
    : '';

  const shift = m.would_try_next
    ? `<div class="m-caption">
        <svg class="m-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4M2 10h4M2 14h4M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/></svg>
        <p><strong>Shift notes:</strong> <span class="m-pre">${esc(m.would_try_next)}</span></p>
      </div>`
    : '';
  const comped = m.is_comped ? '<p class="m-comped">Meal comped by the restaurant or a sponsor.</p>' : '';

  const restSection = !isTasting && top.length > 0 && order.restCount > 0
    ? `<section aria-label="The rest of the order" class="m-rest">
        <div class="m-between m-sechd"><h2 class="m-title m-title--section">The rest of the order</h2><span class="m-cnt">${order.restCount} more</span></div>
        ${penRule()}
        ${restList}
      </section>`
    : '';

  return `
    <article class="m-sheet">
      <div class="m-top">
        <span class="m-kind">${isTasting ? 'Tasting Menu' : 'Menu Card'}</span>
        ${ticket ? `<span class="m-no">${BEAR}Nº ${esc(ticket)}</span>` : ''}
      </div>
      ${penRule()}
      <h1 class="m-title m-title--page${longTitle ? ' m-title--long' : ''}" dir="auto">${esc(title)}</h1>
      ${facts}
      ${author}
      ${table}
      ${drinks}
      ${picks}
      ${tastingCover}
      ${shift}
      ${comped}
      ${restSection}
      ${signupCta('Open in WildHeavy', appUrl, ctx, { campaign: 'share_menu', note: 'Ate here too? Tap Make it mine in the app.', cls: 'm-cta' })}
    </article>`;
}

// "Reservation manifest" — a sub-panel that teases the visit context the
// app captures (effort + social context + loyalty) without exposing the
// detailed prose (`reservation_notes`, `would_try_next`). Renders nothing
// if the menu card has no surfaced context fields.
function reservationManifest(m) {
  const diffLabel = reservationDifficultyLabel(m.reservation_difficulty);
  const meter = m.reservation_difficulty != null
    ? renderDifficultyMeter(m.reservation_difficulty)
    : '';
  const service = m.reservation_service && String(m.reservation_service).trim();
  const partyMeal = partyMealLine(m.meal_service, m.party_size);
  const occasion = humanizeEnum(m.occasion);
  const ticket = typeof m.ticket_number === 'number' && m.ticket_number > 0
    ? `TKT #${String(m.ticket_number).padStart(3, '0')}`
    : '';

  // If we have nothing to say, render nothing.
  if (!diffLabel && !service && !partyMeal && !occasion && !ticket) return '';

  // LEFT column — reservation effort
  const reservationLine = diffLabel
    ? `
        <div class="manifest__tier">${esc(diffLabel)}</div>
        ${meter}`
    : '';
  const serviceLine = service
    ? `<div class="manifest__hint">via ${esc(service)}</div>`
    : '';

  const leftHasContent = !!(diffLabel || service);
  const left = leftHasContent
    ? `
      <div class="manifest__col">
        <div class="manifest__key">Reservation</div>
        ${reservationLine}
        ${serviceLine}
      </div>`
    : '';

  // RIGHT column — visit context
  const contextParts = [];
  if (partyMeal) contextParts.push(partyMeal);
  if (occasion) contextParts.push(occasion);
  const contextLine = contextParts.length
    ? `<div class="manifest__line">${esc(contextParts.join(' \u00b7 '))}</div>`
    : '';
  const ticketLine = ticket
    ? `<div class="manifest__hint">${esc(ticket)}</div>`
    : '';
  const rightHasContent = !!(contextLine || ticketLine);
  const right = rightHasContent
    ? `
      <div class="manifest__col manifest__col--right">
        <div class="manifest__key">Context</div>
        ${contextLine}
        ${ticketLine}
      </div>`
    : '';

  return `
    <aside class="manifest" aria-label="Visit details">
      ${left}
      ${right}
    </aside>`;
}

// ---------- Route and Spots (the app's layout) ----------
//
// Mirrors RouteDetail.tsx, SpreadParts.tsx and lib/spreadPage.ts. Keep the
// pin colors, group titles and the "From" rules in step with those files.
// Left in the app on purpose: the stop sheet, per-place and all-stops
// Directions, the restaurant page, the attached Menu Card, "See them on the
// map" (Spots).
const SPREAD_PIN = {
  drinks: { bg: '#C9A84C', fg: '#1A3629', label: 'Drinks' },
  food: { bg: '#A0522D', fg: '#FBFBF9', label: 'Food' },
  both: { bg: '#B87B3A', fg: '#FBFBF9', label: 'Both' },
  untagged: { bg: '#2D2D2D', fg: '#FBFBF9', label: 'Not tagged' },
};
const SPREAD_INTENT_LABEL = { drinks: 'Drinks', food: 'Food', both: 'Food and drinks' };

const SPREAD_ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const SPREAD_TRANSPORT = {
  walk: '<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/>',
  drive: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  transit: '<path d="M8 3.1V7a4 4 0 0 0 8 0V3.1"/><path d="m9 15-1-1"/><path d="m15 15 1-1"/><path d="M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z"/><path d="m8 19-2 3"/><path d="m16 19 2 3"/>',
  bike: '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
};
const SPREAD_MODE_WORDS = {
  walk: (m) => `${m} min walk`,
  transit: (m) => `${m} min by transit`,
  drive: (m) => `${m} min drive`,
  bike: (m) => `${m} min by bike`,
};
const SPREAD_MODE_BARE = { walk: 'Walk', transit: 'Transit', drive: 'Drive', bike: 'Bike' };

function spreadTravel(mode, minutes) {
  const k = SPREAD_MODE_WORDS[mode] ? mode : 'walk';
  const m = Number(minutes);
  const text = Number.isFinite(m) && m > 0 ? SPREAD_MODE_WORDS[k](Math.round(m)) : SPREAD_MODE_BARE[k];
  return `<span class="sp-travel"><svg ${SPREAD_ICON_ATTRS}>${SPREAD_TRANSPORT[k]}</svg>${esc(text)}</span>`;
}

function spreadStopsOf(t) {
  const raw = Array.isArray(t.stops) ? t.stops : [];
  return raw.map((s, i) => {
    const intent = s && SPREAD_INTENT_LABEL[s.intent_tag] ? s.intent_tag : null;
    const note = typeof s.note === 'string' ? s.note.trim() : '';
    return {
      number: i + 1,
      name: (s && s.name) || 'Unnamed place',
      intent,
      intentLabel: intent ? SPREAD_INTENT_LABEL[intent] : null,
      neighborhood: (s && s.neighborhood) || null,
      shortAddress: (s && s.short_address) || '',
      note: note || null,
      mode: s && s.transport_mode,
      minutes: s && s.duration_minutes,
    };
  });
}

// The Giver, big, at the top (same block as the Menu Card and Ranking).
function giverBlock(creator, trailing = '') {
  const initial = (creator.handle || creator.name || '?').replace(/^@/, '').trim().slice(0, 1).toUpperCase();
  return `<div class="m-author">
      ${creator.avatar
        ? `<img class="m-avatar" src="${esc(creator.avatar)}" alt="" loading="lazy">`
        : `<span class="m-avatar m-avatar--empty">${esc(initial)}</span>`}
      <span class="m-author__name">${esc(creator.handle || creator.name)}</span>
      ${trailing}
    </div>`;
}

function spreadSectionHead(title, count) {
  return `<div class="m-sechd sp-sechd">
      <div class="m-between"><h2 class="m-title m-title--section">${esc(title)}</h2><span class="m-cnt">${count}</span></div>
      ${penRule('pen-rule--spread')}
    </div>`;
}

function spreadHead(kind, t, creator, titleFallback, trailing = '') {
  const cityOnly = String(t.city || '').split(',')[0].trim();
  const title = t.title || titleFallback;
  const longTitle = Array.from(String(title).trim()).length > 24;
  return `
      <div class="m-top">
        <span class="m-kind">${kind}</span>
        ${cityOnly ? `<span class="sp-city">${esc(cityOnly)}</span>` : ''}
      </div>
      ${penRule('pen-rule--spread')}
      <h1 class="m-title m-title--page${longTitle ? ' m-title--long' : ''}" dir="auto">${esc(title)}</h1>`;
}

function spotsGroupsOf(stops) {
  if (!stops.length) return [];
  if (stops.every((s) => !s.intent)) return [{ title: 'The places', stops }];
  return [
    { title: 'For drinks', stops: stops.filter((s) => s.intent === 'drinks') },
    { title: 'For food', stops: stops.filter((s) => s.intent === 'food') },
    { title: 'For food and drinks', stops: stops.filter((s) => s.intent === 'both') },
    { title: 'Also', stops: stops.filter((s) => !s.intent) },
  ].filter((g) => g.stops.length > 0);
}

function spotsBody({ t, creator, appUrl, ctx }) {
  const stops = spreadStopsOf(t);
  const total = Math.max(t.total_stop_count || 0, stops.length);
  const count = `${total} ${total === 1 ? 'place' : 'places'}`;
  const groups = spotsGroupsOf(stops);
  const hidden = Math.max(0, total - stops.length);

  const sections = groups.map((g) => `
      <section aria-label="${esc(g.title)}">
        ${spreadSectionHead(g.title, g.stops.length)}
        <ul class="sp-spots">${g.stops.map((s) => `
          <li class="sp-spot">
            <span class="sp-dot" aria-hidden="true"></span>
            <span class="sp-spot__text">
              <span class="sp-name">${esc(s.name)}</span>
              ${s.shortAddress ? `<span class="sp-sub">${esc(s.shortAddress)}</span>` : ''}
              ${s.note ? `<span class="sp-snote">${esc(s.note)}</span>` : ''}
            </span>
          </li>`).join('')}
        </ul>
      </section>`).join('');

  return `
    <article class="m-sheet sp-sheet">
      ${spreadHead('Spots', t, creator, 'Untitled Spots')}
      ${giverBlock(creator, `<span class="sp-authorcount">${esc(count)}</span>`)}
      ${t.description ? `<p class="sp-desc">${esc(t.description)}</p>` : ''}
      ${sections || '<p class="sp-empty">No places on this list yet.</p>'}
      ${hidden ? `<p class="rk-more">${hidden} more in the app</p>` : ''}
      ${signupCta('See all the spots', appUrl, ctx, { campaign: 'share_spread', note: 'Directions to every place are in the app.', cls: 'm-cta' })}
    </article>`;
}

function routeBody({ t, creator, appUrl, ctx }) {
  if (t.kind === 'spots') return spotsBody({ t, creator, appUrl, ctx });
  let stops = spreadStopsOf(t);
  // Backward compat: the old `start_stop` / `end_stop` payload shape.
  if (stops.length === 0 && (t.start_stop || t.end_stop)) {
    stops = spreadStopsOf({ stops: [t.start_stop, t.end_stop].filter(Boolean) });
  }
  const total = Math.max(t.total_stop_count || 0, stops.length);
  const n = stops.length;

  // Same key the app shows: Drinks, Food, Both always; Not tagged when needed.
  const keys = ['drinks', 'food', 'both'];
  if (stops.some((s) => !s.intent)) keys.push('untagged');
  const key = `<ul class="sp-key" aria-label="Pin colors">${keys
    .map((k) => `<li><span class="sp-keydot" style="background:${SPREAD_PIN[k].bg}"></span>${SPREAD_PIN[k].label}</li>`)
    .join('')}</ul>`;

  const rows = stops.map((s, i) => {
    const isFirst = i === 0;
    const isLast = i === n - 1;
    const edge = n === 1 ? 'only' : isFirst ? 'first' : isLast ? 'last' : 'middle';
    const pin = SPREAD_PIN[s.intent || 'untagged'];
    const sub = [s.intentLabel, s.neighborhood, s.shortAddress].filter(Boolean).join(' · ');
    const after = !isLast || s.note
      ? `<div class="sp-grid">
          <span class="sp-rail">${!isLast ? '<i class="sp-line"></i>' : ''}</span>
          <span class="sp-after">
            ${s.note ? `<span class="sp-note">${esc(s.note)}</span>` : ''}
            ${!isLast ? `<span class="sp-move">${spreadTravel(s.mode, s.minutes)}</span>` : ''}
          </span>
        </div>`
      : '';
    return `
      <li class="sp-stop">
        <div class="sp-grid">
          <span class="sp-rail"><i class="sp-line sp-line--${edge}"></i><b class="sp-pin" style="background:${pin.bg};color:${pin.fg}">${s.number}</b></span>
          <span class="sp-main">
            <span class="sp-name">${esc(s.name)}</span>
            ${sub ? `<span class="sp-sub">${esc(sub)}</span>` : ''}
          </span>
        </div>
        ${after}
      </li>`;
  }).join('');

  const hidden = Math.max(0, total - n);
  const count = `${total} ${total === 1 ? 'stop' : 'stops'}`;

  return `
    <article class="m-sheet sp-sheet">
      ${spreadHead('Route', t, creator, 'Untitled route')}
      <p class="sp-count">${esc(count)}</p>
      ${giverBlock(creator)}
      ${t.map_url ? `<div class="sp-map"><img src="${esc(t.map_url)}" alt="Map of the route" loading="lazy"></div>` : ''}
      ${t.description ? `<p class="sp-desc">${esc(t.description)}</p>` : ''}
      ${spreadSectionHead('The stops', total)}
      ${n ? key : ''}
      ${n ? `<ol class="sp-stops">${rows}</ol>` : '<p class="sp-empty">No stops on this route yet.</p>'}
      ${hidden ? `<p class="rk-more">${hidden} more in the app</p>` : ''}
      ${signupCta('See the full route', appUrl, ctx, { campaign: 'share_spread', note: 'Directions for every stop are in the app.', cls: 'm-cta' })}
    </article>`;
}

// ---------- Shared UI bits ----------
function cardEyebrow(label, meta) {
  const right = meta ? ` \u00b7 ${meta}` : '';
  return `
    <div class="eyebrow">
      <span>${esc(label)}${esc(right)}</span>
    </div>`;
}

// Inline "+ N more" row at the end of a list. Visually echoes the row
// styling (rank or dish) but is non-interactive — a teaser that there's
// more inside the app.
function morePseudoRow(remaining, kind) {
  const noun = kind === 'rank' ? 'ranked' : 'logged';
  const cls = kind === 'rank' ? 'rank__row rank__row--more' : 'dish dish--more';
  return `
    <li class="${cls}" aria-hidden="true">
      <span class="more__plus">+</span>
      <span class="more__count">${esc(String(remaining))}</span>
      <span class="more__label">more ${esc(noun)} in the app</span>
    </li>`;
}

function creatorBlock(creator, badges = {}) {
  const { name, handle, avatar } = creator;
  const initial = (name || '?').trim().slice(0, 1).toLowerCase();

  // Stamp priority: Go-To (highest endorsement) > Comped (industry signal)
  // > Shared (default). At most one stamp on the byline so it stays calm.
  let stampLabel = 'Shared';
  let stampMod = '';
  if (badges.isGoTo) {
    stampLabel = 'Go-To';
    stampMod = ' stamp--goto';
  } else if (badges.isComped) {
    stampLabel = 'Comped';
    stampMod = ' stamp--comped';
  }

  return `
    <div class="byline">
      ${
        avatar
          ? `<img class="byline__avatar" src="${esc(avatar)}" alt="" loading="lazy">`
          : `<div class="byline__avatar byline__avatar--empty">${esc(initial)}</div>`
      }
      <div class="byline__text">
        <div class="byline__name">${esc(name)}</div>
        <div class="byline__handle">${
          handle
            ? `<span class="byline__handle-h">${esc(handle)}</span><span class="byline__handle-sep"> \u00b7 </span><span class="byline__handle-t">WildHeavy Regular</span>`
            : `<span class="byline__handle-t">WildHeavy Regular</span>`
        }</div>
      </div>
      <div class="stamp${stampMod}">${esc(stampLabel)}</div>
    </div>`;
}

function signupCta(label, appUrl, ctx = {}, opts = {}) {
  // On iOS, route the CTA to the App Store when we have an ID configured.
  // The intent: turn share-link traffic into installs. Without an APP_STORE_APP_ID
  // set, this falls through to the existing wildheavy.app behavior.
  const useAppStore = !!(ctx.ios && APP_STORE_APP_ID);
  const href = useAppStore ? appStoreUrl(opts.campaign) : (appUrl || 'https://wildheavy.app');
  const finalLabel = useAppStore ? 'Get on the App Store' : label;
  return `
    <a class="${opts.cls ? esc(opts.cls) : 'btn btn--primary btn--cta'}" href="${esc(href)}">${esc(finalLabel)} \u2192</a>
    <p class="${opts.cls ? 'm-ctanote' : 'cta__note'}">${esc(opts.note || 'Free \u00b7 Your dining file, kept in your pocket')}</p>`;
}

// ---------- OG description builders ----------
function buildRankingDescription(r) {
  const top = (r.items_preview || []).slice(0, 3).map((d) => d.name).filter(Boolean);
  const head = top.length ? top.join(' \u00b7 ') : r.category || '';
  return trim(`${head}${r.city ? ` \u00b7 ${r.city}` : ''}`);
}

function buildRankingSub(r) {
  const parts = [];
  if (r.total_item_count) parts.push(`${r.total_item_count} ${r.total_item_count === 1 ? 'entry' : 'entries'}`);
  if (r.category) parts.push(r.category);
  return parts.join(' \u00b7 ');
}

function buildMenuCardDescription(m) {
  const tier = reservationDifficultyLabel(m.reservation_difficulty);
  const partyMeal = partyMealLine(m.meal_service, m.party_size);
  const total = m.total_dish_count;
  const dishes = total ? `${total} ${total === 1 ? 'dish' : 'dishes'} logged` : '';

  // Lead with the most enticing signal we have: tier > party/meal > dish count.
  const lead = [tier, partyMeal, dishes].filter(Boolean).join(' \u00b7 ');
  const top = (m.dishes_preview || []).slice(0, 3).map((d) => d.name).filter(Boolean);
  const tail = top.length ? top.join(' \u00b7 ') : '';
  return trim([lead, tail].filter(Boolean).join(' \u00b7 '));
}

function buildRouteDescription(t) {
  const stops = Array.isArray(t.stops) ? t.stops : [];
  if (t.kind === 'spots') {
    // Unordered: no start\u2192end arc (it would imply a sequence). Names + count.
    const names = stops.slice(0, 3).map((s) => s?.name).filter(Boolean).join(' \u00b7 ');
    const count = t.total_stop_count
      ? `${t.total_stop_count} ${t.total_stop_count === 1 ? 'place' : 'places'}`
      : '';
    return trim([names, count].filter(Boolean).join(' \u00b7 '));
  }
  const start = stops[0]?.name;
  const end = stops.length > 1 ? stops[stops.length - 1]?.name : null;
  const arc = start && end ? `${start} \u2192 ${end}` : start || '';
  const count = t.total_stop_count
    ? `${t.total_stop_count} ${t.total_stop_count === 1 ? 'stop' : 'stops'}`
    : '';
  return trim([arc, count].filter(Boolean).join(' \u00b7 '));
}

// ---------- OG image (dynamic card, rendered by the og-image Worker) ----------
// The wildheavy-og-image Worker (worker/og-image/) renders a 1200x630 PNG of
// the actual content — top items, ratings, stops — at /og/{prefix}/{slug}.png.
// It falls back to the static og-image.png internally on any failure, so this
// URL is always safe to emit.
const TYPE_TO_PREFIX = { ranking: 'r', menu_card: 'm', route: 't' };

function dynamicOgImage(contentType, slug) {
  const p = TYPE_TO_PREFIX[contentType];
  return p && slug
    ? `https://wildheavy.com/og/${p}/${encodeURIComponent(slug)}.png`
    : 'https://wildheavy.com/og-image.png';
}

// ---------- Helpers ----------
function buildAppUrl(type, contentId) {
  const id = encodeURIComponent(contentId || '');
  switch (type) {
    case 'ranking':   return `https://wildheavy.app/ranking/${id}`;
    case 'menu_card': return `https://wildheavy.app/menu-card/${id}`;
    case 'route':     return `https://wildheavy.app/route/${id}`;
    default:          return 'https://wildheavy.app';
  }
}

// WildHeavy uses a 1-5 rating scale with named tiers. Mirrors
// src/lib/ratingDefinitions.ts in the iOS app — keep in sync.
function ratingLabel(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  const r = Math.round(Number(n));
  switch (r) {
    case 5: return 'Top Rank Worthy';
    case 4: return 'Can\u2019t Miss';
    case 3: return 'Solid';
    case 2: return 'Decent';
    case 1: return 'Skip It';
    default: return '';
  }
}

// Reservation difficulty is a 0-5 scale with named tiers. Mirrors the iOS
// app's reservation difficulty definitions — keep in sync.
function reservationDifficultyLabel(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  const r = Math.round(Number(n));
  switch (r) {
    case 0: return 'Walk-In Friendly';
    case 1: return 'Easy Booking';
    case 2: return 'Plan Ahead';
    case 3: return 'High Demand';
    case 4: return 'Tough Ticket';
    case 5: return 'Insider Only';
    default: return '';
  }
}

// 5-segment difficulty meter (uses bars instead of stars so it doesn't
// visually collide with dish ratings).
function renderDifficultyMeter(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  const filled = Math.max(0, Math.min(5, Math.round(Number(n))));
  let bars = '';
  for (let i = 0; i < 5; i++) {
    bars += i < filled
      ? '<span class="diff-meter__bar diff-meter__bar--on"></span>'
      : '<span class="diff-meter__bar"></span>';
  }
  return `<span class="diff-meter" aria-label="${filled} of 5 difficulty">${bars}</span>`;
}

// Humanize enum keys like `friends_casual` -> `Friends Casual`. Special-cases
// a few common occasion/meal values for nicer copy.
function humanizeEnum(v) {
  if (!v || typeof v !== 'string') return '';
  const overrides = {
    friends_casual: 'Friends',
    solo_visit: 'Solo Visit',
    date_night: 'Date Night',
    happy_hour: 'Happy Hour',
    just_drinks: 'Drinks Only',
    business: 'Business',
    celebration: 'Celebration',
    brunch: 'Brunch',
    lunch: 'Lunch',
    dinner: 'Dinner',
  };
  if (overrides[v]) return overrides[v];
  return v
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// "Dinner for 4" / "Dinner" / "Party of 4" — graceful with missing pieces.
function partyMealLine(mealService, partySize) {
  const meal = humanizeEnum(mealService);
  const hasParty = typeof partySize === 'number' && partySize > 0;
  if (meal && hasParty) return `${meal} for ${partySize}`;
  if (meal) return meal;
  if (hasParty) return `Party of ${partySize}`;
  return '';
}

// Renders five star glyphs as an HTML span. Filled stars use brass gold,
// unfilled stars sit on the same baseline at lower opacity.
function renderStars(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  const filled = Math.max(0, Math.min(5, Math.round(Number(n))));
  let stars = '';
  for (let i = 0; i < 5; i++) {
    stars += i < filled
      ? '<span class="star star--on">\u2605</span>'
      : '<span class="star star--off">\u2606</span>';
  }
  return `<span class="stars" aria-label="${filled} of 5 stars">${stars}</span>`;
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

function trim(s, max = 200) {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Page shell ----------
function renderPage(state, status = 200, ctx = {}) {
  // Smart App Banner — Apple ignores this on non-iOS browsers, so it's safe
  // to emit unconditionally when we have an App ID. The `app-argument` value
  // gives the app a deep-link hint when a user already has it installed.
  const smartBanner = APP_STORE_APP_ID
    ? `<meta name="apple-itunes-app" content="app-id=${esc(APP_STORE_APP_ID)}${APP_STORE_PROVIDER_TOKEN && state.campaign ? `, affiliate-data=pt=${esc(APP_STORE_PROVIDER_TOKEN)}&ct=${esc(state.campaign)}` : ''}, app-argument=${esc(state.appUrl || 'https://wildheavy.app')}">`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(state.ogTitle)}</title>
<meta name="description" content="${esc(state.ogDescription)}">
<meta name="robots" content="noindex, nofollow">
${smartBanner}

<meta property="og:type" content="article">
<meta property="og:title" content="${esc(state.ogTitle)}">
<meta property="og:description" content="${esc(state.ogDescription)}">
<meta property="og:image" content="${esc(state.ogImage)}">
${state.status === 'ok' ? `<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">` : ''}
<meta property="og:site_name" content="WildHeavy">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(state.ogTitle)}">
<meta name="twitter:description" content="${esc(state.ogDescription)}">
<meta name="twitter:image" content="${esc(state.ogImage)}">

<link rel="icon" type="image/png" href="/favicon.png">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@900&family=Bitter:ital,wght@0,300..800;1,300..700&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500;600;700&family=Special+Elite&display=swap">
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@900&family=Bitter:ital,wght@0,300..800;1,300..700&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500;600;700&family=Special+Elite&display=swap" rel="stylesheet">

<style>
:root {
  --paper: #FBFBF9;
  --paper-bright: #F4F2EA;
  --paper-dark: #E3E0D6;
  --ink: #1A3629;
  --ink-soft: #2A4538;
  --ink-mute: rgba(26, 54, 41, 0.58);
  --oxblood: #7A2621;
  --oxblood-soft: #6E2020;
  --gold: #B8904A;
  --gold-soft: #9E7A3B;
  --rule: rgba(26, 54, 41, 0.18);
  --rule-bold: rgba(26, 54, 41, 0.35);
  --rule-gold: rgba(184, 144, 74, 0.55);
  --shadow-press: 0 1px 0 rgba(255,255,255,0.7), 0 10px 24px -14px rgba(26,54,41,0.22);
  --shadow-lift: 0 2px 0 rgba(255,255,255,0.6), 0 18px 40px -20px rgba(26,54,41,0.28);
  --font-display: 'Bitter', 'Clarendon', Georgia, serif;
  --font-body: 'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-type: 'Special Elite', ui-monospace, monospace;
  --radius: 2px;
  --radius-card: 4px;
  --pen-rule-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1000 6' preserveAspectRatio='none'%3E%3Cpath d='M0 3.1L2.5 2.94L5 2.79L7.5 2.64L10 2.51L12.5 2.39L15 2.28L16.67 2.23L17.5 2.2L20 2.14L22.5 2.1L25 2.09L27.5 2.1L30 2.1L32.5 2.1L33.33 2.1L35 2.1L37.5 2.1L40 2.11L50 2.11L66.67 2.13L83.33 2.14L100 2.15L116.67 2.16L133.33 2.18L150 2.19L166.67 2.2L183.33 2.21L200 2.22L216.67 2.23L233.33 2.23L250 2.24L266.67 2.25L283.33 2.26L300 2.26L316.67 2.27L333.33 2.27L350 2.27L366.67 2.27L383.33 2.28L400 2.28L416.67 2.28L433.33 2.27L450 2.27L466.67 2.27L483.33 2.27L500 2.26L516.67 2.26L533.33 2.25L550 2.24L566.67 2.24L583.33 2.23L600 2.22L616.67 2.21L633.33 2.2L650 2.19L666.67 2.18L683.33 2.17L700 2.15L716.67 2.14L733.33 2.13L750 2.11L766.67 2.1L783.33 2.08L800 2.07L816.67 2.05L833.33 2.04L850 2.02L866.67 2L883.33 1.99L900 1.97L916.67 1.96L933.33 1.94L950 1.92L960 1.91L962.5 1.91L965 1.91L966.67 1.91L967.5 1.91L970 1.9L972.5 1.9L975 1.9L977.5 1.91L980 1.94L982.5 1.99L983.33 2.02L985 2.07L987.5 2.16L990 2.27L992.5 2.39L995 2.52L997.5 2.66L1000 2.8L1000 2.8L997.5 2.95L995 3.09L992.5 3.22L990 3.35L987.5 3.46L985 3.56L983.33 3.61L982.5 3.64L980 3.7L977.5 3.73L975 3.75L972.5 3.75L970 3.75L967.5 3.76L966.67 3.76L965 3.76L962.5 3.76L960 3.77L950 3.78L933.33 3.8L916.67 3.82L900 3.84L883.33 3.87L866.67 3.89L850 3.91L833.33 3.94L816.67 3.96L800 3.99L783.33 4.01L766.67 4.04L750 4.06L733.33 4.09L716.67 4.11L700 4.13L683.33 4.16L666.67 4.18L650 4.2L633.33 4.22L616.67 4.25L600 4.27L583.33 4.29L566.67 4.3L550 4.32L533.33 4.34L516.67 4.35L500 4.37L483.33 4.38L466.67 4.39L450 4.4L433.33 4.41L416.67 4.41L400 4.42L383.33 4.42L366.67 4.43L350 4.43L333.33 4.43L316.67 4.42L300 4.42L283.33 4.42L266.67 4.41L250 4.4L233.33 4.39L216.67 4.38L200 4.37L183.33 4.35L166.67 4.34L150 4.32L133.33 4.31L116.67 4.29L100 4.27L83.33 4.25L66.67 4.23L50 4.2L40 4.19L37.5 4.19L35 4.18L33.33 4.18L32.5 4.18L30 4.18L27.5 4.17L25 4.17L22.5 4.15L20 4.11L17.5 4.05L16.67 4.02L15 3.96L12.5 3.85L10 3.72L7.5 3.58L5 3.43L2.5 3.27L0 3.1Z'/%3E%3C/svg%3E");
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html { background: var(--paper); }
body {
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  position: relative;
  min-height: 100dvh;
}
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='7'%3E%3Cpath d='M0 3.5 Q5 1.2 10 3.5 T20 3.5 T30 3.5 T40 3.5' fill='none' stroke='%231A3629' stroke-width='0.6' stroke-opacity='0.075'/%3E%3C/svg%3E");
  pointer-events: none;
  z-index: 0;
}
.wrap {
  position: relative;
  z-index: 1;
  max-width: 560px;
  margin: 0 auto;
  padding: 28px 18px 56px;
}

/* ---- Brand masthead ---- */
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 18px;
  margin-bottom: 28px;
  border-bottom: 1px solid var(--rule);
  position: relative;
}
.brand::after {
  content: '';
  position: absolute;
  left: 0; right: 0; bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gold) 50%, transparent);
  opacity: 0.45;
}
.brand__logo {
  display: block;
  flex-shrink: 0;
  text-decoration: none;
  line-height: 0;
}
.brand__logo img {
  display: block;
  height: 42px;
  width: auto;
}
@media (max-width: 480px) {
  .brand__logo img { height: 36px; }
}
.tm {
  font-size: 0.5em;
  line-height: 0;
  position: relative;
  top: -0.75em;
  margin-left: 0.05em;
}
.brand__tag {
  flex: 1;
  text-align: right;
  font-family: var(--font-display);
  font-style: italic;
  font-weight: 600;
  font-size: 14px;
  color: var(--ink-mute);
  letter-spacing: -0.005em;
}
@media (max-width: 480px) {
  .brand__tag { font-size: 12px; }
}
@media (max-width: 380px) {
  .brand__tag { display: none; }
}

/* ---- Card surface ---- */
.card {
  background: var(--paper-bright);
  border: 1px solid var(--rule);
  border-radius: var(--radius-card);
  padding: 30px 22px 26px;
  box-shadow: var(--shadow-lift);
  position: relative;
}
.card::before {
  content: '';
  position: absolute;
  top: -10px;
  left: 50%;
  transform: translateX(-50%) rotate(-1deg);
  width: 96px;
  height: 18px;
  background: rgba(184, 144, 74, 0.22);
  border: 1px dashed rgba(184, 144, 74, 0.5);
  pointer-events: none;
}

/* Eyebrow / kicker */
.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--gold-soft);
  margin: 0 0 10px;
}
.card__title {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: clamp(1.85rem, 5.4vw, 2.5rem);
  line-height: 1.0;
  letter-spacing: -0.02em;
  color: var(--ink);
  margin: 0 0 8px;
  text-wrap: balance;
}
.card__sub {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink-mute);
  margin: 0 0 22px;
}

/* Byline */
.byline {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 18px;
  margin-bottom: 22px;
  border-bottom: 1px dashed var(--rule);
}
.byline__avatar {
  width: 44px; height: 44px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--paper-dark);
  border: 1px solid var(--rule);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-style: italic;
  font-weight: 600;
  font-size: 22px;
  color: var(--ink);
  flex-shrink: 0;
}
.byline__text { flex: 1; min-width: 0; }
.byline__name {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 16px;
  color: var(--ink);
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.byline__handle {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ink-mute);
  margin-top: 2px;
  line-height: 1.5;
}
.byline__handle-h,
.byline__handle-t { display: inline; }
@media (max-width: 480px) {
  .byline__handle-sep { display: none; }
  .byline__handle-t { display: block; }
}

.stamp {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--oxblood);
  border: 1.5px solid var(--oxblood);
  border-radius: var(--radius);
  padding: 5px 9px 4px;
  transform: rotate(-3deg);
  opacity: 0.88;
  flex-shrink: 0;
}
.stamp--goto {
  color: var(--ink);
  border-color: var(--ink);
  background: rgba(184, 144, 74, 0.18);
  border-width: 2px;
  letter-spacing: 0.28em;
  transform: rotate(-4deg);
  opacity: 1;
}
.stamp--comped {
  color: var(--gold-soft);
  border-color: var(--gold-soft);
  border-style: double;
  border-width: 3px;
  padding: 4px 8px 3px;
  transform: rotate(-2deg);
}

/* ---- Reservation manifest (menu card visit context) ----
   A two-column ledger between byline and dishes. Teases the effort and
   social context the app captures (difficulty, booking service, party,
   occasion, ticket #) without exposing the prose notes. */
.manifest {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px 22px;
  padding: 16px 16px 14px;
  margin: 0 0 22px;
  background:
    repeating-linear-gradient(0deg,
      transparent, transparent 22px,
      rgba(26,54,41,0.045) 22px, rgba(26,54,41,0.045) 23px),
    var(--paper);
  border: 1px solid var(--rule);
  border-top: 1px solid var(--rule-gold);
  border-bottom: 1px solid var(--rule-gold);
  border-radius: var(--radius);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.6);
}
@media (max-width: 480px) {
  .manifest { grid-template-columns: 1fr; gap: 14px; }
}
.manifest__col { min-width: 0; }
.manifest__col--right { text-align: right; }
@media (max-width: 480px) {
  .manifest__col--right { text-align: left; }
}
.manifest__key {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--gold-soft);
  margin-bottom: 6px;
}
.manifest__tier {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 18px;
  color: var(--ink);
  letter-spacing: -0.005em;
  line-height: 1.15;
  margin-bottom: 6px;
}
.manifest__line {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 16px;
  color: var(--ink);
  letter-spacing: -0.005em;
  line-height: 1.2;
  overflow-wrap: anywhere;
}
.manifest__hint {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ink-mute);
  margin-top: 6px;
}

/* Reservation difficulty: 5-segment bar meter (intentionally distinct from
   dish star ratings). */
.diff-meter {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-top: 2px;
}
.manifest__col--right .diff-meter { justify-content: flex-end; }
.diff-meter__bar {
  display: inline-block;
  width: 14px;
  height: 5px;
  border-radius: 1px;
  background: var(--gold);
  opacity: 0.22;
}
.diff-meter__bar--on {
  opacity: 1;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.35),
    inset 0 -1px 0 rgba(0,0,0,0.18);
}

/* ---- Brass rule with diamond ---- */
.rule-gold {
  position: relative;
  height: 1px;
  margin: 22px 0;
  background: linear-gradient(90deg,
    transparent 0%,
    rgba(184,144,74,0.1) 10%,
    var(--gold) 50%,
    rgba(184,144,74,0.1) 90%,
    transparent 100%);
}
.rule-gold::before {
  content: '';
  position: absolute;
  left: 50%; top: 50%;
  transform: translate(-50%, -50%) rotate(45deg);
  width: 7px; height: 7px;
  background: var(--gold);
  box-shadow: 0 0 0 4px var(--paper-bright);
}

/* ---- Ranking list ---- */
.rank { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.rank__row {
  display: grid;
  grid-template-columns: 38px 1fr 56px;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  background: var(--paper);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.6);
}
.rank__pos {
  font-family: var(--font-display);
  font-style: italic;
  font-weight: 600;
  font-size: 24px;
  color: var(--gold);
  text-align: center;
  line-height: 1;
}
.rank__body { min-width: 0; }
.rank__name {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 16px;
  color: var(--ink);
  letter-spacing: -0.005em;
  overflow-wrap: anywhere;
  line-height: 1.2;
}
.rank__meta {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--ink-mute);
  margin-top: 4px;
}
.rank__thumb {
  width: 56px; height: 56px;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--paper-dark);
  border: 1px solid var(--rule);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.4);
  flex-shrink: 0;
}
.rank__thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rank__thumb--empty {
  background:
    repeating-linear-gradient(45deg,
      transparent, transparent 4px,
      rgba(26,54,41,0.05) 4px, rgba(26,54,41,0.05) 5px),
    var(--paper-dark);
}
.rank__empty {
  color: var(--ink-mute);
  font-family: var(--font-display);
  font-style: italic;
  padding: 14px;
  text-align: center;
}

/* ---- Menu card dishes ---- */
.dishes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.dish {
  display: grid;
  grid-template-columns: 64px 1fr;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  background: var(--paper);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.6);
}
.dish__thumb {
  width: 64px; height: 64px;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--paper-dark);
  border: 1px solid var(--rule);
}
.dish__thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dish__thumb--empty {
  background:
    repeating-linear-gradient(45deg,
      transparent, transparent 4px,
      rgba(26,54,41,0.05) 4px, rgba(26,54,41,0.05) 5px),
    var(--paper-dark);
}
.dish__name {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 16px;
  color: var(--ink);
  overflow-wrap: anywhere;
  line-height: 1.2;
}
.dish__rating {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
  flex-wrap: wrap;
}
.dish__tier {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink-mute);
}

/* ---- Stars ---- */
.stars {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  letter-spacing: 0;
  line-height: 1;
  font-size: 13px;
}
.star {
  display: inline-block;
  line-height: 1;
}
.star--on  { color: var(--gold); }
.star--off { color: var(--gold); opacity: 0.28; }

/* ---- "+ N more" pseudo-row tiles ---- */
.rank__row--more,
.dish--more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 14px 14px;
  background:
    repeating-linear-gradient(135deg,
      transparent, transparent 6px,
      rgba(184,144,74,0.06) 6px, rgba(184,144,74,0.06) 7px),
    var(--paper);
  border: 1px dashed var(--rule-gold);
  border-radius: var(--radius);
  box-shadow: none;
  text-align: center;
}
.more__plus {
  font-family: var(--font-display);
  font-style: italic;
  font-weight: 600;
  font-size: 22px;
  color: var(--gold);
  line-height: 1;
}
.more__count {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 18px;
  color: var(--ink);
  letter-spacing: -0.005em;
  line-height: 1;
}
.more__label {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink-mute);
}

/* ---- Route timeline (transit-map style) ----
   Brass numbered nodes connected by a dotted gold rail. No thumbnails —
   the rail itself is the visual; routes live in geography, not photos. */
.timeline {
  list-style: none;
  margin: 4px 0 8px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}
.timeline__row {
  display: grid;
  grid-template-columns: 38px 1fr;
  align-items: stretch;
  gap: 16px;
  padding: 6px 0;
  min-height: 64px;
}
.timeline__rail {
  position: relative;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding-top: 6px;
}
.timeline__node {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--gold);
  color: var(--paper-bright);
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0;
  line-height: 1;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.35),
    inset 0 -1px 0 rgba(0,0,0,0.18),
    0 0 0 4px var(--paper-bright),
    0 0 0 5px var(--rule-gold),
    0 2px 8px -3px rgba(184,144,74,0.55);
  flex-shrink: 0;
  z-index: 1;
}
.timeline__line {
  flex: 1;
  display: block;
  width: 28px;
  margin-top: 4px;
  margin-bottom: -12px;
  min-height: 36px;
  pointer-events: none;
}
.timeline__line svg {
  display: block;
  width: 100%;
  height: 100%;
}
.timeline__body { min-width: 0; padding: 4px 0; }
.timeline__label {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.28em;
  color: var(--gold-soft);
  margin-bottom: 3px;
}
.timeline__name {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 17px;
  color: var(--ink);
  letter-spacing: -0.005em;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

/* ---- Shift note (typewriter) ---- */
.shift-note {
  font-family: var(--font-type);
  font-size: 14px;
  line-height: 1.55;
  color: var(--ink);
  background: repeating-linear-gradient(
    transparent, transparent 23px,
    rgba(26,54,41,0.06) 23px, rgba(26,54,41,0.06) 24px
  );
  padding: 14px 16px;
  border-left: 3px solid var(--oxblood);
  margin: 0 0 26px;
}
.shift-note__label {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--oxblood);
  margin-right: 8px;
}

/* ---- Buttons ---- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  text-decoration: none;
  padding: 17px 26px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  transition: transform 0.12s ease, background 0.18s, color 0.18s, box-shadow 0.18s;
  cursor: pointer;
  color: var(--paper-bright);
}
.btn--primary {
  background: var(--ink);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 8px 20px -10px rgba(26,54,41,0.45);
}
.btn--primary:hover {
  background: #234837;
  transform: translateY(-1px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 12px 24px -10px rgba(26,54,41,0.55);
}
.btn--primary:active { transform: translateY(0); }
.btn--cta {
  display: flex;
  width: 100%;
}
.cta__note {
  text-align: center;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--ink-mute);
  margin: 14px 0 0;
}

/* ---- Empty / error states ---- */
.state {
  text-align: center;
  padding: 48px 24px 44px;
  background: var(--paper-bright);
  border: 1px solid var(--rule);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-press);
  position: relative;
}
.state .eyebrow { justify-content: center; margin-bottom: 16px; }
.state__title {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: clamp(1.55rem, 4.6vw, 2rem);
  color: var(--ink);
  margin: 0 0 14px;
  letter-spacing: -0.02em;
  line-height: 1.05;
  text-wrap: balance;
}
.state__sub {
  color: var(--ink-soft);
  margin: 0 auto 28px;
  font-size: 15px;
  line-height: 1.6;
  max-width: 380px;
}

/* ---- Footer ---- */
.foot {
  position: relative;
  text-align: center;
  margin-top: 36px;
  padding-top: 22px;
  font-family: var(--font-display);
  font-style: italic;
  font-weight: 600;
  font-size: 14px;
  color: var(--ink-mute);
}
.foot::before {
  content: '';
  position: absolute;
  top: 0; left: 50%;
  transform: translateX(-50%);
  width: 80%;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--rule-gold) 50%, transparent);
}
.foot a {
  color: var(--ink);
  text-decoration: underline;
  text-decoration-color: var(--rule-gold);
  text-underline-offset: 3px;
  text-decoration-thickness: 1px;
}
.foot a:hover { color: var(--oxblood); text-decoration-color: var(--oxblood); }

/* ---- The app's Menu Card (m-*) ---- */
.pen-rule {
  display: block; width: 100%; height: 6px; flex-shrink: 0;
  background-color: currentColor;
  -webkit-mask: var(--pen-rule-mask) no-repeat 0 0 / 100% 100%;
  mask: var(--pen-rule-mask) no-repeat 0 0 / 100% 100%;
  color: var(--ink);
}
.m-sheet { --hair: rgba(26,54,41,.16); --strong: #AFB9B4; --star: #A8772B; color: var(--ink); padding: 4px 2px 8px; }
.m-sheet p { margin: 0; color: inherit; }
.m-sheet h1, .m-sheet h2, .m-sheet h3 { margin: 0; }
.m-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-bottom: 8px; }
.m-kind { font-weight: 600; font-size: 15px; white-space: nowrap; }
.m-no { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-weight: 700; font-size: 15px; color: var(--oxblood); }
.m-bear { display: inline-block; width: 18px; height: 17px; background: currentColor;
  -webkit-mask: url(https://wildheavy.com/bear-mark.png) center/contain no-repeat; mask: url(https://wildheavy.com/bear-mark.png) center/contain no-repeat; }
.m-bear--sm { width: 14px; height: 13px; }
.m-title {
  font-family: 'Big Shoulders Display', 'Bitter', system-ui, serif; font-weight: 900; font-style: normal;
  font-synthesis: none; letter-spacing: 0; line-height: 1.05; padding-bottom: .12em; color: var(--ink);
  overflow-wrap: break-word; text-wrap: initial;
}
.m-title--page { font-size: 36px; margin-top: 14px !important; }
.m-title--long { font-size: 30px; }
.m-title--section { font-size: 22px; color: var(--oxblood); }
.m-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 10px; }
.m-facts p { display: flex; flex-wrap: wrap; gap: 0 6px; font-size: 14px; color: rgba(26,54,41,.78); }
.m-marker { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; font-weight: 600; color: #8A5A34; white-space: nowrap; }
.m-marker svg { width: 14px; height: 14px; fill: var(--star); stroke: var(--star); stroke-width: 1.5; stroke-linejoin: round; }
.m-author { display: flex; align-items: center; gap: 16px; margin-top: 22px; min-width: 0; }
.m-avatar { width: 76px; height: 76px; border-radius: 50%; object-fit: cover; flex: none; background: var(--ink); color: #FBFBF9; display: inline-flex; align-items: center; justify-content: center; font-size: 30px; font-weight: 600; box-shadow: 0 0 0 3px #FBFBF9, 0 0 0 4.5px rgba(26,54,41,.35); margin-left: 5px; }
.m-author__name { font-size: 22px; font-weight: 600; line-height: 1.15; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-booked { margin-top: 8px !important; font-size: 14px; color: rgba(26,54,41,.78) !important; }
.m-lbl { font-size: 10.5px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: rgba(26,54,41,.7); }
.m-cnt { font-family: var(--font-mono); font-size: 12px; color: rgba(26,54,41,.7); white-space: nowrap; }
.m-between { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.m-sechd { padding: 28px 0 8px; }
.m-table { margin-top: 16px; border-top: 1px solid var(--hair); border-bottom: 1px solid var(--hair); padding: 12px 0; }
.m-table__row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.m-table__val { font-size: 14px; text-align: right; }
.m-table__val b { font-weight: 600; }
.m-scale { padding-top: 4px; }
.m-scale__track { position: relative; display: flex; justify-content: space-between; align-items: center; height: 18px; margin: 0 4px; }
.m-scale__track::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 2px; transform: translateY(-50%); background: rgba(26,54,41,.18); }
.m-scale__track i { position: relative; width: 9px; height: 9px; border-radius: 50%; border: 2px solid rgba(26,54,41,.35); background: #FBFBF9; box-sizing: border-box; }
.m-scale__track i.on { width: 16px; height: 16px; border: 0; box-shadow: 0 0 0 3px #FBFBF9; }
.m-scale__track i.on--forest { background: #1F4A33; }
.m-scale__track i.on--leather { background: #8A5A34; }
.m-scale__track i.on--ox { background: var(--oxblood); }
.m-scale__ends { display: flex; justify-content: space-between; margin-top: 2px; font-size: 11.5px; color: rgba(26,54,41,.7); }
.m-note { font-size: 14px; line-height: 1.4; margin-top: 8px !important; }
.m-note strong, .m-caption strong { font-weight: 600; }
.m-note--plain { margin-top: 12px !important; }
.m-pre { white-space: pre-line; }
.m-drinks { border-bottom: 1px solid var(--hair); padding: 12px 0; }
.m-drinks ul { list-style: none; margin: 8px 0 0; padding: 0; }
.m-drinks li { display: flex; align-items: center; gap: 12px; padding: 5px 0; }
.m-drinks img { width: 44px; height: 44px; object-fit: cover; flex: none; }
.m-drink__name { flex: 1; min-width: 0; font-family: var(--font-display); font-weight: 600; font-size: 15.5px; line-height: 1.25; }
.m-stars { font-family: var(--font-mono); font-size: 13px; white-space: nowrap; }
.m-stars span { color: var(--star); }
.m-x { margin-left: 5px; font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: rgba(26,54,41,.7); }
.m-name { display: block; font-family: var(--font-display); font-weight: 600; font-size: 16px; line-height: 1.2; }
.m-name--lead { font-size: 17px; line-height: 1.22; }
.m-name--big { font-size: 18px; }
.m-course { display: block; margin-top: 2px; font-size: 12.5px; font-weight: 600; color: rgba(26,54,41,.7); }
.m-verdict { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font-size: 13px; font-weight: 700; color: var(--ink); }
.m-verdict--top { color: var(--oxblood); }
.m-verdict--row, .m-verdict--tile { margin-top: 4px; }
.m-lead { margin-top: 14px; }
.m-lead img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; }
.m-lead__cap { padding-top: 10px; align-items: flex-start; }
.m-bracketed { position: relative; margin-top: 16px; min-height: 104px; padding: 16px 4px 16px 18px; }
.m-hero { display: block; margin-top: 6px; font-family: var(--font-display); font-weight: 700; font-size: 26px; line-height: 1.12; }
.pbr { position: absolute; left: 1px; top: 1px; bottom: 1px; width: 60px; pointer-events: none; color: var(--ink); }
.pbr svg { position: absolute; left: 0; display: block; fill: currentColor; }
.pbr-t { top: 0; }
.pbr-m { top: 9.5px; width: 6px; height: calc(100% - 19px); }
.pbr-b { bottom: 0; transform: scaleY(-1); }
.m-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; margin-top: 20px; }
.m-tile { min-width: 0; }
.m-tile img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; margin-bottom: 8px; }
.m-others, .m-sheet section ul { list-style: none; margin: 0; padding: 0; }
.m-others { margin-top: 12px !important; border-top: 1px solid var(--hair); }
.m-row { display: flex; align-items: center; gap: 14px; min-height: 72px; padding: 8px 0; border-bottom: 1px solid var(--hair); }
.m-row--big { padding: 14px 0; }
.m-row__text { flex: 1; min-width: 0; }
.m-row__img { width: 56px; height: 56px; object-fit: cover; flex: none; }
.m-row__img--big { width: 112px; height: 112px; }
.m-group { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 20px 0 6px; border-bottom: 1px solid var(--strong); }
.m-group h3 { font-family: var(--font-body); font-size: 13px; font-weight: 600; letter-spacing: 0; color: rgba(26,54,41,.7); }
.m-sheet ul li:last-child.m-row { border-bottom: 0; }
.m-rest .m-sechd { padding-top: 32px; }
.m-caption { display: flex; align-items: flex-start; gap: 8px; padding-top: 18px; font-size: 14.5px; line-height: 1.45; color: rgba(26,54,41,.86); }
.m-ic { width: 16px; height: 16px; flex: none; margin-top: 2px; fill: none; stroke: var(--ink); stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.m-comped { padding-top: 8px; font-size: 12.5px; color: rgba(26,54,41,.7) !important; }
.m-cta {
  display: flex; align-items: center; justify-content: center; margin-top: 28px; min-height: 52px; padding: 0 20px;
  background: var(--ink); color: #FBFBF9 !important; border-radius: 2px; text-decoration: none !important;
  font-family: var(--font-body); font-weight: 600; font-size: 16px; letter-spacing: 0; text-transform: none;
}
.m-cta:hover { background: #12271c; color: #FBFBF9 !important; }
.m-ctanote { margin-top: 10px !important; text-align: center; font-size: 13.5px; color: rgba(26,54,41,.7) !important; }
.pen-rule--brass { height: 9px; background: linear-gradient(90deg, #7a5a24 0%, #b8904a 14%, #f3dd9b 30%, #c9a24e 44%, #8a6a2f 58%, #d8bb72 74%, #f6e7b4 84%, #9c7633 100%); }

/* ---- Route and Spots (sp-*) ---- */
.pen-rule--spread { color: #466B8F; }
.sp-city { font-family: var(--font-mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: rgba(26,54,41,.7); }
.sp-count { margin-top: 8px !important; font-family: var(--font-mono); font-size: 12px; font-variant-numeric: tabular-nums; color: rgba(26,54,41,.7) !important; }
.sp-authorcount { margin-left: auto; flex: none; font-family: var(--font-mono); font-size: 12px; font-variant-numeric: tabular-nums; color: rgba(26,54,41,.7); }
.sp-map { margin-top: 18px; border: 1px solid var(--hair); }
.sp-map img { display: block; width: 100%; aspect-ratio: 35 / 23; object-fit: cover; background: #ECEBE6; }
.sp-desc { margin-top: 16px !important; font-size: 15px; line-height: 1.4; color: rgba(26,54,41,.78) !important; white-space: pre-line; }
.sp-sechd { padding-top: 26px; }
.sp-sechd .m-between { padding-bottom: 4px; }
.sp-key { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12.5px; color: rgba(26,54,41,.7); }
.sp-key li { display: flex; align-items: center; gap: 5px; }
.sp-keydot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
.sp-stops { list-style: none; margin: 18px 0 0; padding: 0; }
.sp-grid { display: grid; grid-template-columns: 24px 1fr; column-gap: 12px; }
.sp-rail { position: relative; }
.sp-line { position: absolute; left: 11px; top: 0; bottom: 0; width: 2px; background: #466B8F; }
.sp-line--first { top: 13px; }
.sp-line--last { bottom: auto; height: 13px; }
.sp-line--only { display: none; }
.sp-pin { position: absolute; left: 0; top: 2px; z-index: 1; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-family: var(--font-mono); font-size: 12px; font-weight: 700; box-shadow: 0 0 0 3px #FBFBF9; }
.sp-main { display: block; min-width: 0; padding-bottom: 6px; }
.sp-name { display: block; font-family: var(--font-display); font-weight: 600; font-size: 17px; line-height: 1.22; }
.sp-sub { display: block; margin-top: 2px; font-size: 13px; color: rgba(26,54,41,.7); }
.sp-after { display: block; min-width: 0; padding-bottom: 12px; }
.sp-note { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; padding-top: 8px; font-family: var(--font-display); font-weight: 500; font-style: italic; font-size: 14px; line-height: 1.4; color: #3F4A44; }
.sp-move { display: block; padding-top: 10px; }
.sp-travel { display: flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 11.5px; color: rgba(26,54,41,.7); }
.sp-travel svg { width: 14px; height: 14px; flex: none; }
.sp-spots { list-style: none; margin: 0; padding: 0; }
.sp-spot { display: flex; align-items: center; gap: 14px; min-height: 64px; padding: 10px 0; border-bottom: 1px solid var(--hair); }
.sp-spot:last-child { border-bottom: 0; }
.sp-dot { flex: none; width: 9px; height: 9px; margin-left: 2px; border-radius: 50%; background: #466B8F; }
.sp-spot__text { flex: 1; min-width: 0; }
.sp-snote { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 5px; font-size: 14px; line-height: 1.38; color: #3F4A44; }
.sp-empty { padding: 24px 0; font-size: 14px; color: rgba(26,54,41,.7) !important; }
.rk-head { align-items: baseline; margin-top: 0; }
.rk-head .m-title--page { margin-top: 14px !important; }
.rk-city { flex: none; font-size: 12px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: rgba(26,54,41,.7); }
.rk-n { display: inline-block; flex: none; font-family: 'Big Shoulders Display', 'Bitter', system-ui, serif; font-weight: 900; font-style: normal; font-synthesis: none; line-height: .8; font-variant-numeric: tabular-nums; user-select: none; }
.rk-n--xl { font-size: 52px; } .rk-n--lg { font-size: 40px; } .rk-n--md { font-size: 30px; }
.rk-n--leather { color: #8A5A34; }
.rk-n--brass { background-image: linear-gradient(180deg, #7a5a24 0%, #c9a24e 30%, #f3dd9b 52%, #b8904a 74%, #7a5a24 100%); -webkit-background-clip: text; background-clip: text; color: transparent; }
.rk-name { display: block; font-family: var(--font-display); font-weight: 600; font-size: 16px; line-height: 1.2; }
.rk-name--lead { font-size: 22px; line-height: 1.15; }
.rk-name--tile { font-size: 15px; line-height: 1.2; }
.rk-name--clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; font-size: 17px; }
.rk-sub { display: block; margin-top: 2px; font-size: 13px; line-height: 1.3; color: rgba(26,54,41,.72); }
.rk-top { padding-top: 22px; }
.rk-lead__img { display: block; width: 100%; aspect-ratio: 5 / 3; object-fit: cover; }
.rk-lead__cap { display: flex; align-items: flex-start; gap: 12px; margin-top: 12px; }
.rk-lead__txt { min-width: 0; flex: 1; padding-top: 2px; }
.rk-lead__nophoto { display: flex; align-items: stretch; gap: 12px; }
.rk-lead__nophoto .rk-n { align-self: center; font-size: 92px; }
.rk-bracketed { position: relative; min-width: 0; flex: 1; display: flex; flex-direction: column; justify-content: center; min-height: 112px; padding: 16px 4px 16px 20px; box-sizing: border-box; }
.pbr--short { width: 40px; }
.rk-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; margin-top: 20px; }
.rk-tile { min-width: 0; }
.rk-tile img { display: block; width: 100%; aspect-ratio: 6 / 5; object-fit: cover; }
.rk-tile__box { position: relative; display: flex; align-items: center; width: 100%; aspect-ratio: 6 / 5; padding: 0 4px 0 16px; box-sizing: border-box; }
.rk-tile__cap { display: flex; align-items: flex-start; gap: 8px; margin-top: 8px; }
.rk-tile__cap > span:last-child { min-width: 0; padding-top: 2px; }
.rk-list { padding-top: 8px; }
.rk-list__hd { padding-bottom: 8px; border-bottom: 1px solid var(--hair); }
.rk-list__lbl { font-size: 13px; font-weight: 600; color: rgba(26,54,41,.7); }
.rk-row { display: flex; align-items: center; gap: 16px; min-height: 64px; padding: 12px 0; border-bottom: 1px solid var(--hair); }
.rk-row__n { width: 36px; flex: none; }
.rk-row__text { flex: 1; min-width: 0; }
.rk-row__img { width: 56px; height: 56px; object-fit: cover; flex: none; }
.rk-more { padding: 16px 0; font-size: 14px; font-weight: 600; color: rgba(26,54,41,.78) !important; border-bottom: 1px solid var(--hair); }
</style>
</head>
<body>
  <div class="wrap">
    <header class="brand">
      <a class="brand__logo" href="https://wildheavy.com" aria-label="WildHeavy">
        <img src="https://wildheavy.com/Wild%20Heavy%20-%20Logo%20Branding%20-%20Transparent%20-%20Edited.png" alt="WildHeavy">
      </a>
      <span class="brand__tag">We're all regulars here.<span class="tm">™</span></span>
    </header>
    ${state.bodyHtml}
    <p class="foot">Shared from <a href="https://wildheavy.com">WildHeavy</a></p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60, s-maxage=60',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

// Visit dates show month and year only ("Sep 2026"), matching the app.
function formatMonth(iso) {
  try {
    const d = new Date(String(iso).slice(0, 7) + '-15T12:00:00Z');
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  } catch {
    return null;
  }
}
