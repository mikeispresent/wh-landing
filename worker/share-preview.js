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

const EDGE_FN = 'https://kufhzivrzvqayvzbwrpn.supabase.co/functions/v1/share-preview';
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
const APP_STORE_APP_ID = '';

function appStoreUrl() {
  return APP_STORE_APP_ID
    ? `https://apps.apple.com/app/id${APP_STORE_APP_ID}`
    : 'https://wildheavy.app';
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
    const remaining = Math.max(0, (r.total_item_count || 0) - (r.items_preview?.length || 0));
    const appUrl = buildAppUrl('ranking', r.id);
    return {
      status: 'ok',
      ogTitle: `${r.title} \u2014 by ${creatorName}`,
      ogDescription: buildRankingDescription(r),
      ogImage: pickRankingOgImage(r),
      appUrl,
      bodyHtml: rankingBody({ r, creator: { name: creatorName, handle: creatorHandle, avatar }, remaining, appUrl, ctx }),
    };
  }

  if (data.content_type === 'menu_card') {
    const m = data.menu_card;
    const remaining = Math.max(0, (m.total_dish_count || 0) - (m.dishes_preview?.length || 0));
    const appUrl = buildAppUrl('menu_card', m.id);
    return {
      status: 'ok',
      ogTitle: `${m.restaurant_name} \u2014 a menu card by ${creatorName}`,
      ogDescription: buildMenuCardDescription(m),
      ogImage: pickMenuCardOgImage(m),
      appUrl,
      bodyHtml: menuCardBody({ m, creator: { name: creatorName, handle: creatorHandle, avatar }, remaining, appUrl, ctx }),
    };
  }

  // route
  const t = data.route;
  const appUrl = buildAppUrl('route', t.id);
  return {
    status: 'ok',
    ogTitle: `${t.title} \u2014 a route by ${creatorName}`,
    ogDescription: buildRouteDescription(t),
    ogImage: pickRouteOgImage(t),
    appUrl,
    bodyHtml: routeBody({ t, creator: { name: creatorName, handle: creatorHandle, avatar }, appUrl, ctx }),
  };
}

function unavailableState() {
  return {
    status: 'unavailable',
    ogTitle: 'WildHeavy',
    ogDescription: 'This link isn\u2019t available right now.',
    ogImage: 'https://wildheavy.com/og-image.png',
    appUrl: 'https://wildheavy.app',
    bodyHtml: stateHtml({
      kicker: 'Off the menu',
      title: 'This link isn\u2019t on the menu.',
      sub: 'The regular who made this either set it private or pulled it down. Happens.',
      ctaLabel: 'Open WildHeavy',
      ctaHref: 'https://wildheavy.app',
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
      kicker: 'Not in the kitchen',
      title: 'Nothing in the kitchen by that name.',
      sub: 'That link doesn\u2019t match anything in our house.',
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
      <div class="eyebrow"><span class="eyebrow__dash"></span><span>${esc(kicker)}</span></div>
      <h1 class="state__title">${esc(title)}</h1>
      <p class="state__sub">${esc(sub)}</p>
      <a class="btn btn--primary" href="${esc(ctaHref)}">${esc(ctaLabel)} \u2192</a>
    </section>`;
}

// ---------- Body templates ----------
function rankingBody({ r, creator, remaining, appUrl, ctx }) {
  const items = (r.items_preview || [])
    .map((d, i) => {
      const pos = ROMAN[i] || String(i + 1);
      // Each ranking entry is a specific dish at a specific restaurant —
      // restaurant_name is the credit line under the dish name.
      const meta = d.restaurant_name ? esc(d.restaurant_name) : '';
      return `
      <li class="rank__row">
        <div class="rank__pos">${esc(pos)}</div>
        <div class="rank__body">
          <div class="rank__name">${esc(d.name || 'Unnamed')}</div>
          ${meta ? `<div class="rank__meta">${meta}</div>` : ''}
        </div>
        ${
          d.image_url
            ? `<div class="rank__thumb"><img src="${esc(d.image_url)}" alt="" loading="lazy"></div>`
            : `<div class="rank__thumb rank__thumb--empty"></div>`
        }
      </li>`;
    })
    .join('');

  const moreTile = remaining > 0 ? morePseudoRow(remaining, 'rank') : '';

  const remainingLine =
    remaining > 0
      ? `+ ${remaining} more ranked \u2014 the full list, with notes & receipts, in the app.`
      : `Sign up to see full details and build your own.`;

  return `
    <article class="card">
      ${cardEyebrow('Ranking', null)}
      <h1 class="card__title">${esc(r.title || 'Untitled ranking')}</h1>
      <p class="card__sub">${esc(buildRankingSub(r))}</p>
      ${creatorBlock(creator)}
      <ol class="rank">${items || '<li class="rank__empty">Nothing plated yet.</li>'}${moreTile}</ol>
      <div class="rule-gold"></div>
      <div class="shift-note">
        <span class="shift-note__label">Shift Note \u2014</span>${remainingLine}
      </div>
      ${signupCta('See the full ranking', appUrl, ctx)}
    </article>`;
}

function menuCardBody({ m, creator, remaining, appUrl, ctx }) {
  const dishes = (m.dishes_preview || [])
    .map((d) => {
      const stars = d.rating != null ? renderStars(d.rating) : '';
      const label = d.rating != null ? ratingLabel(d.rating) : '';
      const ratingRow = (stars || label)
        ? `<div class="dish__rating">${stars}${label ? `<span class="dish__tier">${esc(label)}</span>` : ''}</div>`
        : '';
      return `
      <li class="dish">
        ${
          d.image_url
            ? `<div class="dish__thumb"><img src="${esc(d.image_url)}" alt="" loading="lazy"></div>`
            : `<div class="dish__thumb dish__thumb--empty"></div>`
        }
        <div class="dish__body">
          <div class="dish__name">${esc(d.name || 'Unnamed dish')}</div>
          ${ratingRow}
        </div>
      </li>`;
    })
    .join('');

  const moreTile = remaining > 0 ? morePseudoRow(remaining, 'dish') : '';

  const remainingLine =
    remaining > 0
      ? `+ ${remaining} more dishes \u2014 every note, every bite, in the app.`
      : `Sign up to see every note from this visit.`;

  // Visit date sits in the sub. Numeric overall_rating stays out of the
  // preview entirely — the app uses a 1-5 scale and we only show stars/labels
  // at the dish level.
  const total = m.total_dish_count ?? (m.dishes_preview?.length ?? 0);
  const eyebrowMeta = total > 0
    ? `${total} ${total === 1 ? 'Dish Logged' : 'Dishes Logged'}`
    : null;

  const sub = m.visit_date ? `Visited ${formatDate(m.visit_date)}` : '';

  return `
    <article class="card">
      ${cardEyebrow('Menu Card', eyebrowMeta)}
      <h1 class="card__title">${esc(m.restaurant_name || 'Restaurant')}</h1>
      ${sub ? `<p class="card__sub">${esc(sub)}</p>` : ''}
      ${creatorBlock(creator, { isGoTo: m.is_go_to, isComped: m.is_comped })}
      ${reservationManifest(m)}
      <ul class="dishes">${dishes || '<li class="rank__empty">No dishes plated yet.</li>'}${moreTile}</ul>
      <div class="rule-gold"></div>
      <div class="shift-note">
        <span class="shift-note__label">Shift Note \u2014</span>${remainingLine}
      </div>
      ${signupCta('See the full menu card', appUrl, ctx)}
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

function routeBody({ t, creator, appUrl, ctx }) {
  // Edge function returns ALL place stops as `t.stops` (notes are filtered
  // out server-side). Per-leg duration_minutes and step notes are gatekept —
  // those only show up inside the app.
  //
  // Backward compat: while the edge function is being redeployed, payloads
  // may still arrive with the old `start_stop` / `end_stop` shape. Fall
  // back to those so the preview renders something sensible in the gap.
  let stops = Array.isArray(t.stops) ? t.stops : [];
  if (stops.length === 0 && (t.start_stop || t.end_stop)) {
    stops = [t.start_stop, t.end_stop].filter(Boolean);
  }
  const total = t.total_stop_count || stops.length;

  const lastIdx = stops.length - 1;
  const stopRows = stops
    .map((s, i) => {
      const labelParts = [];
      if (i === 0) labelParts.push('Start');
      else if (i === lastIdx && stops.length > 1) labelParts.push('End');
      else labelParts.push(`Stop ${i + 1}`);
      const label = labelParts.join(' ');

      // Old-map node + dashed wavy connector. The rail itself is the visual:
      // numbered brass markers stitched together by a hand-drawn-ish dotted
      // route path. Alternates curve direction so it reads as a meander, not
      // a straight subway line.
      const curveLeft = i % 2 === 0;
      const connector = i < lastIdx
        ? `<span class="timeline__line">
             <svg viewBox="0 0 28 48" preserveAspectRatio="none" aria-hidden="true">
               <path d="${
                 curveLeft
                   ? 'M 14 0 C 2 12, 26 24, 14 36 S 6 48, 14 48'
                   : 'M 14 0 C 26 12, 2 24, 14 36 S 22 48, 14 48'
               }"
                     fill="none"
                     stroke="var(--gold)"
                     stroke-width="1.4"
                     stroke-linecap="round"
                     stroke-dasharray="2.5 4"
                     opacity="0.62"/>
             </svg>
           </span>`
        : '';

      return `
      <li class="timeline__row">
        <div class="timeline__rail" aria-hidden="true">
          <span class="timeline__node">${i + 1}</span>
          ${connector}
        </div>
        <div class="timeline__body">
          <div class="timeline__label">${esc(label)}</div>
          <div class="timeline__name">${esc(s.name || 'Unnamed stop')}</div>
        </div>
      </li>`;
    })
    .join('');

  // Eyebrow shows stop count instead of city (city is in title context anyway
  // for most routes, and durations are gatekept).
  const eyebrowMeta = total > 0
    ? `${total} ${total === 1 ? 'Stop' : 'Stops'}`
    : null;

  const sub = t.city ? t.city : '';

  return `
    <article class="card">
      ${cardEyebrow('Route', eyebrowMeta)}
      <h1 class="card__title">${esc(t.title || 'Untitled route')}</h1>
      ${sub ? `<p class="card__sub">${esc(sub)}</p>` : ''}
      ${creatorBlock(creator)}
      <ol class="timeline">${stopRows || '<li class="rank__empty">No stops on this walk yet.</li>'}</ol>
      <div class="rule-gold"></div>
      <div class="shift-note">
        <span class="shift-note__label">Shift Note \u2014</span>Time between stops & notes from the table live in the app.
      </div>
      ${signupCta('See the full route', appUrl, ctx)}
    </article>`;
}

// ---------- Shared UI bits ----------
function cardEyebrow(label, meta) {
  const right = meta ? ` \u00b7 ${meta}` : '';
  return `
    <div class="eyebrow">
      <span class="eyebrow__dash"></span>
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
      <span class="more__label">more ${esc(noun)} \u2014 in the app</span>
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

function signupCta(label, appUrl, ctx = {}) {
  // On iOS, route the CTA to the App Store when we have an ID configured.
  // The intent: turn share-link traffic into installs. Without an APP_STORE_APP_ID
  // set, this falls through to the existing wildheavy.app behavior.
  const useAppStore = !!(ctx.ios && APP_STORE_APP_ID);
  const href = useAppStore ? appStoreUrl() : (appUrl || 'https://wildheavy.app');
  const finalLabel = useAppStore ? 'Get on the App Store' : label;
  return `
    <a class="btn btn--primary btn--cta" href="${esc(href)}">${esc(finalLabel)} \u2192</a>
    <p class="cta__note">Free \u00b7 Your dining file, kept in your pocket</p>`;
}

// ---------- OG description builders ----------
function buildRankingDescription(r) {
  const top = (r.items_preview || []).slice(0, 3).map((d) => d.name).filter(Boolean);
  const head = top.length ? top.join(' \u00b7 ') : r.category || '';
  return trim(`${head}${r.city ? ` \u2014 ${r.city}` : ''}`);
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
  return trim([lead, tail].filter(Boolean).join(' \u2014 '));
}

function buildRouteDescription(t) {
  const stops = Array.isArray(t.stops) ? t.stops : [];
  const start = stops[0]?.name;
  const end = stops.length > 1 ? stops[stops.length - 1]?.name : null;
  const arc = start && end ? `${start} \u2192 ${end}` : start || '';
  const count = t.total_stop_count
    ? `${t.total_stop_count} ${t.total_stop_count === 1 ? 'stop' : 'stops'}`
    : '';
  return trim([arc, count].filter(Boolean).join(' \u2014 '));
}

// ---------- OG image pickers (fall back to site default) ----------
function pickRankingOgImage(r) {
  const withPhoto = (r.items_preview || []).find((d) => d.image_url);
  return withPhoto?.image_url || 'https://wildheavy.com/og-image.png';
}
function pickMenuCardOgImage(m) {
  const withPhoto = (m.dishes_preview || []).find((d) => d.image_url);
  return withPhoto?.image_url || 'https://wildheavy.com/og-image.png';
}
function pickRouteOgImage(t) {
  const stops = Array.isArray(t.stops) ? t.stops : [];
  const withPhoto = stops.find((s) => s && s.image_url);
  return withPhoto?.image_url || 'https://wildheavy.com/og-image.png';
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
    ? `<meta name="apple-itunes-app" content="app-id=${esc(APP_STORE_APP_ID)}, app-argument=${esc(state.appUrl || 'https://wildheavy.app')}">`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(state.ogTitle)}</title>
<meta name="description" content="${esc(state.ogDescription)}">
${smartBanner}

<meta property="og:type" content="article">
<meta property="og:title" content="${esc(state.ogTitle)}">
<meta property="og:description" content="${esc(state.ogDescription)}">
<meta property="og:image" content="${esc(state.ogImage)}">
<meta property="og:site_name" content="WildHeavy">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(state.ogTitle)}">
<meta name="twitter:description" content="${esc(state.ogDescription)}">
<meta name="twitter:image" content="${esc(state.ogImage)}">

<link rel="icon" type="image/png" href="/favicon.png">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300..600&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500;600;700&family=Special+Elite&display=swap">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300..600&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500;600;700&family=Special+Elite&display=swap" rel="stylesheet">

<style>
:root {
  --paper: #EDEBE3;
  --paper-bright: #F4F2EA;
  --paper-dark: #E3E0D6;
  --ink: #1A3629;
  --ink-soft: #2A4538;
  --ink-mute: rgba(26, 54, 41, 0.58);
  --oxblood: #8B2A2A;
  --oxblood-soft: #6E2020;
  --gold: #B8904A;
  --gold-soft: #9E7A3B;
  --rule: rgba(26, 54, 41, 0.18);
  --rule-bold: rgba(26, 54, 41, 0.35);
  --rule-gold: rgba(184, 144, 74, 0.55);
  --shadow-press: 0 1px 0 rgba(255,255,255,0.7), 0 10px 24px -14px rgba(26,54,41,0.22);
  --shadow-lift: 0 2px 0 rgba(255,255,255,0.6), 0 18px 40px -20px rgba(26,54,41,0.28);
  --font-display: 'Fraunces', 'Cormorant Garamond', Georgia, serif;
  --font-body: 'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-type: 'Special Elite', ui-monospace, monospace;
  --radius: 2px;
  --radius-card: 4px;
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
  background:
    url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.10   0 0 0 0 0.08   0 0 0 0 0.05  0 0 0 0.28 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"),
    radial-gradient(ellipse at 50% 0%, #F4F2EA 0%, var(--paper) 45%, #E6E3D8 100%);
  opacity: 0.6;
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
.brand__tag {
  flex: 1;
  text-align: right;
  font-family: var(--font-display);
  font-style: italic;
  font-weight: 400;
  font-size: 14px;
  color: var(--ink-mute);
  font-variation-settings: "opsz" 72, "SOFT" 50;
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
.eyebrow__dash {
  width: 18px;
  height: 1px;
  background: var(--gold);
  display: inline-block;
}

.card__title {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(1.85rem, 5.4vw, 2.5rem);
  line-height: 1.0;
  letter-spacing: -0.02em;
  color: var(--ink);
  margin: 0 0 8px;
  font-variation-settings: "opsz" 144, "SOFT" 30;
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
  font-weight: 400;
  font-size: 22px;
  color: var(--ink);
  font-variation-settings: "opsz" 72, "SOFT" 50;
  flex-shrink: 0;
}
.byline__text { flex: 1; min-width: 0; }
.byline__name {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 16px;
  color: var(--ink);
  letter-spacing: -0.01em;
  font-variation-settings: "opsz" 72;
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
  font-weight: 500;
  font-size: 18px;
  color: var(--ink);
  letter-spacing: -0.005em;
  font-variation-settings: "opsz" 72;
  line-height: 1.15;
  margin-bottom: 6px;
}
.manifest__line {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 16px;
  color: var(--ink);
  letter-spacing: -0.005em;
  font-variation-settings: "opsz" 72;
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
  font-weight: 400;
  font-size: 24px;
  color: var(--gold);
  text-align: center;
  line-height: 1;
  font-variation-settings: "opsz" 72, "SOFT" 50;
}
.rank__body { min-width: 0; }
.rank__name {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 16px;
  color: var(--ink);
  letter-spacing: -0.005em;
  font-variation-settings: "opsz" 72;
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
  font-variation-settings: "opsz" 72, "SOFT" 50;
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
  font-weight: 500;
  font-size: 16px;
  color: var(--ink);
  font-variation-settings: "opsz" 72;
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
  font-weight: 400;
  font-size: 22px;
  color: var(--gold);
  font-variation-settings: "opsz" 72, "SOFT" 50;
  line-height: 1;
}
.more__count {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 18px;
  color: var(--ink);
  font-variation-settings: "opsz" 72;
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
  font-weight: 500;
  font-size: 17px;
  color: var(--ink);
  letter-spacing: -0.005em;
  font-variation-settings: "opsz" 72;
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
  font-weight: 400;
  font-size: clamp(1.55rem, 4.6vw, 2rem);
  color: var(--ink);
  margin: 0 0 14px;
  letter-spacing: -0.02em;
  line-height: 1.05;
  font-variation-settings: "opsz" 144, "SOFT" 30;
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
  font-weight: 400;
  font-size: 14px;
  color: var(--ink-mute);
  font-variation-settings: "opsz" 72, "SOFT" 50;
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
</style>
</head>
<body>
  <div class="wrap">
    <header class="brand">
      <a class="brand__logo" href="https://wildheavy.com" aria-label="WildHeavy">
        <img src="https://wildheavy.com/Wild%20Heavy%20-%20Logo%20Branding%20-%20Transparent%20-%20Edited.png" alt="WildHeavy">
      </a>
      <span class="brand__tag">what the kitchen knows.</span>
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
    },
  });
}
