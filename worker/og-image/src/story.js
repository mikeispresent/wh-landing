/**
 * WildHeavy — Story card renderer (1080x1920, 9:16)
 *
 * Rendered at /story/{r|m|t}/{slug}.png for Instagram / Facebook Stories.
 * Shares the share-preview payload, palette, and font loading with the OG
 * cards so the two can never drift.
 *
 * Two variants:
 *   clean  — Warm Linen page, bright panel, forest ink. Always available.
 *   photo  — full-bleed user photo, scrim, cream text. Needs ?photo=<url>.
 *
 * Layout is pure flex — no absolute positioning — because satori's flex
 * support is the well-trodden path and every div here carries an explicit
 * display:flex (workers-og throws otherwise; see index.js notes).
 *
 * Instagram overlays its own chrome on roughly the top and bottom 250px,
 * so all content lives inside y:250..1610. The brand lockup sits at the
 * bottom of that band, never flush to the canvas edge.
 */

import { WORDMARK_FOREST, WORDMARK_CREAM } from './brand.js';

export const STORY_W = 1080;
export const STORY_H = 1920;

const MAX_ROWS = 5;
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];

// Only user-uploaded content photos may back a Story image. Restaurant
// imagery from Google Places is excluded by policy (Places attribution
// terms) and by this allowlist — the storage host is the only source.
const PHOTO_HOST = /^https:\/\/kufhzivrzvqayvzbwrpn\.supabase\.co\/storage\/v1\/object\/public\//;

export function isAllowedPhotoUrl(u) {
  return typeof u === 'string' && PHOTO_HOST.test(u);
}

// Palette. `clean` mirrors the OG cards exactly; `photo` is the same family
// inverted for legibility over a darkened photograph.
const CLEAN = {
  page: '#EDEBE3',
  panel: '#F4F2EA',
  rowBg: '#EDEBE3',
  ink: '#1A3629',
  mute: 'rgba(26,54,41,0.58)',
  gold: '#B8904A',
  goldSoft: '#9E7A3B',
  oxblood: '#8B2A2A',
  rule: 'rgba(26,54,41,0.18)',
  neutralDot: 'rgba(26,54,41,0.40)',
  wordmark: WORDMARK_FOREST,
  urlColor: 'rgba(26,54,41,0.70)',
};

const PHOTO = {
  page: '#121212',
  panel: 'transparent',
  rowBg: 'rgba(18,18,18,0.46)',
  ink: '#F4F2EA',
  mute: 'rgba(244,242,234,0.72)',
  gold: '#D8B072',
  goldSoft: '#D8B072',
  oxblood: '#E9C6C6',
  rule: 'rgba(244,242,234,0.22)',
  neutralDot: 'rgba(244,242,234,0.50)',
  wordmark: WORDMARK_CREAM,
  urlColor: 'rgba(244,242,234,0.70)',
};

// Deterministic truncation. Fixed type sizes beat auto-fit: a different
// size on every card destroys the repetition the lockup depends on.
const LIMITS = {
  title: 42,
  dish: 34,
  restaurant: 30,
  place: 30,
  eyebrow: 28,
  handle: 24,
};

// ---------- Entry ----------
export function buildStory(data, variant, photoUri, avatarUri) {
  const usePhoto = variant === 'photo' && !!photoUri;
  const C = usePhoto ? PHOTO : CLEAN;

  const creator = data.creator || {};
  const handle = creator.username
    ? `@${clip(creator.username, LIMITS.handle)}`
    : creator.display_name
      ? clip(creator.display_name, LIMITS.handle)
      : '';

  let body = null;
  if (data.content_type === 'ranking') body = rankingBody(data.ranking, C);
  else if (data.content_type === 'menu_card') body = menuCardBody(data.menu_card, C);
  else if (data.content_type === 'route') body = routeBody(data.route, C);
  if (!body) return null;

  return shell({ C, body, handle, usePhoto, photoUri, avatarUri });
}

// ---------- Shell ----------
function shell({ C, body, handle, usePhoto, photoUri, avatarUri }) {
  const inner = `
    <div style="display:flex;flex-direction:column;width:${STORY_W}px;height:${STORY_H}px;padding:250px 60px 310px;${
      usePhoto
        ? `background-image:linear-gradient(180deg, rgba(18,18,18,0.62) 0%, rgba(18,18,18,0.28) 34%, rgba(18,18,18,0.90) 100%);`
        : ''
    }">
      <div style="display:flex;flex-direction:column;flex:1;min-height:0;">
        ${body}
      </div>
      ${footer(C, handle, avatarUri)}
    </div>`;

  if (!usePhoto) {
    return `<div style="display:flex;width:${STORY_W}px;height:${STORY_H}px;background:${C.page};">${inner}</div>`;
  }

  // Photo sits as a background layer on the root; the scrim is a plain
  // child with its own gradient. Two stacked flex boxes, no absolute.
  return `<div style="display:flex;width:${STORY_W}px;height:${STORY_H}px;background:${C.page};background-image:url('${photoUri}');background-size:cover;background-position:center;">${inner}</div>`;
}

// The lockup. Identical on every template and both variants — same asset,
// same size, same order, same position. The variant toggle changes the card
// above it and never touches this block. Recognition is repetition.
function footer(C, handle, avatarUri) {
  const mark = C.wordmark;
  const markW = 240;
  const markH = Math.round((mark.h / mark.w) * markW);

  // Avatar + handle as one row. The face does most of the recognition work
  // for very little vertical space — people know their friends before they
  // read a username.
  const AV = 72;
  const identity = handle
    ? `<div style="display:flex;align-items:center;justify-content:center;margin-bottom:22px;">
         ${
           avatarUri
             ? `<div style="display:flex;width:${AV}px;height:${AV}px;border-radius:${AV / 2}px;overflow:hidden;border:2px solid ${C.rule};margin-right:18px;"><img src="${avatarUri}" width="${AV}" height="${AV}" style="width:${AV}px;height:${AV}px;object-fit:cover;" /></div>`
             : ''
         }
         <div style="display:flex;font-family:'Instrument Sans';font-weight:600;font-size:46px;color:${C.ink};">${esc(handle)}</div>
       </div>`
    : '';

  // The 64px gap matters: without it the content's "+N more" line reads as
  // part of the lockup instead of as the end of the card.
  return `
  <div style="display:flex;flex-direction:column;align-items:center;margin-top:64px;">
    ${identity}
    <div style="display:flex;width:${markW}px;height:${markH}px;">
      <img src="${mark.uri}" width="${markW}" height="${markH}" style="width:${markW}px;height:${markH}px;" />
    </div>
    <div style="display:flex;font-family:'JetBrains Mono';font-weight:700;font-size:24px;letter-spacing:6px;color:${C.urlColor};margin-top:16px;">WILDHEAVY.COM</div>
  </div>`;
}

function header(C, { eyebrow, title, sub }) {
  const t = clip(title, LIMITS.title);
  const size = t.length > 24 ? 62 : 76;
  return `
    <div style="display:flex;align-items:center;">
      <div style="display:flex;width:34px;height:3px;background:${C.gold};margin-right:16px;"></div>
      <div style="display:flex;font-family:'JetBrains Mono';font-weight:700;font-size:22px;letter-spacing:6px;color:${C.goldSoft};">${esc(clip(eyebrow, LIMITS.eyebrow + 20))}</div>
    </div>
    <div style="display:flex;font-family:Fraunces;font-weight:500;font-size:${size}px;line-height:1.06;color:${C.ink};margin-top:22px;">${esc(t)}</div>
    ${sub ? `<div style="display:flex;font-family:'JetBrains Mono';font-size:22px;letter-spacing:3px;color:${C.mute};margin-top:16px;">${esc(sub)}</div>` : ''}`;
}

function rowsBox(C, rows, empty) {
  return `
    <div style="display:flex;flex-direction:column;flex:1;min-height:0;justify-content:center;gap:14px;margin-top:34px;">
      ${rows || `<div style="display:flex;font-family:Fraunces;font-size:38px;color:${C.mute};">${esc(empty)}</div>`}
    </div>`;
}

function foot(C, text) {
  return `
    <div style="display:flex;flex-direction:column;margin-top:24px;">
      <div style="display:flex;height:1px;background:${C.rule};"></div>
      <div style="display:flex;justify-content:center;margin-top:18px;">
        <div style="display:flex;font-family:'JetBrains Mono';font-weight:700;font-size:22px;letter-spacing:5px;color:${C.oxblood};">${esc(text)}</div>
      </div>
    </div>`;
}

// ---------- Ranking ----------
function rankingBody(r, C) {
  if (!r) return null;
  const total = r.total_item_count || (r.items_preview || []).length;
  const items = (r.items_preview || []).slice(0, MAX_ROWS);
  const remaining = Math.max(0, total - items.length);

  const rows = items
    .map(
      (d, i) => `
      <div style="display:flex;align-items:center;background:${C.rowBg};border:1px solid ${C.rule};border-radius:6px;padding:20px 24px;">
        <div style="display:flex;width:78px;justify-content:center;font-family:Fraunces;font-weight:500;font-size:50px;color:${C.gold};">${esc(ROMAN[i] || String(i + 1))}</div>
        <div style="display:flex;flex-direction:column;flex:1;min-width:0;margin-left:20px;">
          <div style="display:flex;font-family:Fraunces;font-weight:500;font-size:40px;color:${C.ink};">${esc(clip(d.name || 'Unnamed', LIMITS.dish))}</div>
          ${
            d.restaurant_name
              ? `<div style="display:flex;font-family:'JetBrains Mono';font-size:20px;letter-spacing:3px;color:${C.mute};margin-top:8px;">${esc(clip(String(d.restaurant_name).toUpperCase(), LIMITS.restaurant))}</div>`
              : ''
          }
        </div>
      </div>`
    )
    .join('');

  const eyebrow = `RANKING${total ? ` · ${total} ${total === 1 ? 'ENTRY' : 'ENTRIES'}` : ''}`;
  return (
    header(C, { eyebrow, title: r.title || 'Untitled ranking', sub: subLine(r.category, r.city) }) +
    rowsBox(C, rows, 'Nothing plated yet.') +
    foot(C, remaining > 0 ? `+ ${remaining} MORE — IN THE APP` : 'FULL LIST IN THE APP')
  );
}

// ---------- Menu card ----------
function menuCardBody(m, C) {
  if (!m) return null;
  // `dishes_preview` pools menu_card_dishes + menu_card_drinks, so the
  // counter has to cover both or the card contradicts itself. Falls back to
  // total_dish_count for payloads served before that field existed.
  const total = m.total_item_count ?? m.total_dish_count ?? (m.dishes_preview || []).length;
  const dishes = (m.dishes_preview || []).slice(0, MAX_ROWS);
  const remaining = Math.max(0, total - dishes.length);

  const rows = dishes
    .map(
      (d) => `
      <div style="display:flex;flex-direction:column;background:${C.rowBg};border:1px solid ${C.rule};border-radius:6px;padding:20px 24px;">
        <div style="display:flex;font-family:Fraunces;font-weight:500;font-size:40px;color:${C.ink};">${esc(clip(d.name || 'Unnamed dish', LIMITS.dish))}</div>
        ${d.rating != null ? ratingRow(d.rating, C) : ''}
      </div>`
    )
    .join('');

  // Visit context: date · service · party size · go-to. All already in the
  // share-preview teaser payload; the gatekept prose stays in the app.
  const party =
    typeof m.party_size === 'number' && m.party_size > 0
      ? `PARTY OF ${m.party_size}`
      : null;

  return (
    header(C, {
      // "7 DISHES" is a lie once a cocktail is one of the rows shown. Only
      // say DISHES when the card genuinely has no drinks logged.
      eyebrow: `MENU CARD${total ? ` · ${total} ${itemNoun(total, m.total_drink_count)}` : ''}`,
      title: m.restaurant_name || 'Restaurant',
      // Date · service · party size only. `is_go_to` ships in the payload but
      // isn't surfaced anywhere in the app, so a story card is the wrong
      // place for it to debut.
      sub: subLine(
        m.visit_date ? formatDate(m.visit_date) : null,
        mealServiceLabel(m.meal_service),
        party,
      ),
    }) +
    accessMeter(m.reservation_difficulty, C) +
    rowsBox(C, rows, 'Nothing logged yet.') +
    foot(C, remaining > 0 ? `+${remaining} MORE · EVERY NOTE IN THE APP` : 'EVERY NOTE IN THE APP')
  );
}

function itemNoun(total, drinkCount) {
  const hasDrinks = typeof drinkCount === 'number' && drinkCount > 0;
  if (hasDrinks) return total === 1 ? 'ITEM' : 'ITEMS';
  return total === 1 ? 'DISH' : 'DISHES';
}

// Mirrors MEAL_SERVICE_CONFIG in src/components/menu-cards/OccasionIcon.tsx.
// Values are stored snake_case, so raw uppercasing would print "HAPPY_HOUR".
const MEAL_SERVICE_LABELS = {
  brunch: 'Brunch',
  lunch: 'Lunch',
  dinner: 'Dinner',
  happy_hour: 'Happy Hour',
  just_drinks: 'Just Drinks',
};

function mealServiceLabel(v) {
  if (!v) return null;
  return MEAL_SERVICE_LABELS[v] || String(v).replace(/_/g, ' ');
}

// The reservation friction meter — the thing no other food app shows. Scale
// and labels mirror getReservationDifficultyLabel() in ratingDefinitions.ts.
// 0 is a real value ("Walk-In Friendly"), so only null/undefined skips this.
function accessMeter(difficulty, C) {
  if (difficulty == null || Number.isNaN(Number(difficulty))) return '';
  const n = Math.max(0, Math.min(5, Math.round(Number(difficulty))));
  const LABELS = [
    'WALK-IN FRIENDLY',
    'EASY BOOKING',
    'PLAN AHEAD',
    'HIGH DEMAND',
    'TOUGH TICKET',
    'INSIDER ONLY',
  ];
  let segs = '';
  for (let i = 1; i <= 5; i++) {
    segs += `<div style="display:flex;width:44px;height:10px;border-radius:3px;background:${C.oxblood};opacity:${i <= n ? 1 : 0.2};margin-right:8px;"></div>`;
  }
  return `
    <div style="display:flex;align-items:center;margin-top:26px;">
      <div style="display:flex;font-family:'JetBrains Mono';font-weight:700;font-size:17px;letter-spacing:4px;color:${C.mute};margin-right:18px;">ACCESS</div>
      <div style="display:flex;align-items:center;">${segs}</div>
      <div style="display:flex;font-family:'JetBrains Mono';font-weight:700;font-size:17px;letter-spacing:3px;color:${C.oxblood};margin-left:10px;">${esc(LABELS[n])}</div>
    </div>`;
}

function ratingRow(n, C) {
  const filled = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
  let bars = '';
  for (let i = 0; i < 5; i++) {
    bars += `<div style="display:flex;width:34px;height:10px;border-radius:3px;background:${C.gold};opacity:${i < filled ? 1 : 0.22};margin-right:7px;"></div>`;
  }
  const label = ratingLabel(n);
  return `
    <div style="display:flex;align-items:center;margin-top:12px;">
      <div style="display:flex;align-items:center;">${bars}</div>
      ${label ? `<div style="display:flex;font-family:'JetBrains Mono';font-size:19px;letter-spacing:3px;color:${C.mute};margin-left:16px;">${esc(label.toUpperCase())}</div>` : ''}
    </div>`;
}

// Mirrors src/lib/ratingDefinitions.ts and index.js — keep all three in sync.
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

// ---------- Route / Spots ----------
// Everything here flips on `kind`. Spots have no order, so: no step numbers,
// no START/END labels, no connectors, no travel time. Never the word "route".
// No map imagery in either mode — the pin/marker treatment stands in for it.
function routeBody(t, C) {
  if (!t) return null;
  const isSpots = t.kind === 'spots';
  const stops = Array.isArray(t.stops) ? t.stops : [];
  const total = t.total_stop_count || stops.length;
  const shown = stops.slice(0, MAX_ROWS);
  const remaining = Math.max(0, total - shown.length);
  const lastIdx = shown.length - 1;

  const rows = shown
    .map((s, i) => {
      const isTrueEnd = i === lastIdx && remaining === 0 && stops.length > 1;
      const posLabel = isSpots ? '' : i === 0 ? 'START' : isTrueEnd ? 'END' : `STOP ${i + 1}`;
      const intent = intentLabel(s && s.intent_tag);
      const label = [posLabel, intent].filter(Boolean).join(' · ');
      const dot = intentColor(s && s.intent_tag, C);
      const marker = isSpots
        ? `<div style="display:flex;width:26px;height:26px;border-radius:13px;background:${dot};"></div>`
        : `<div style="display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:28px;background:${dot};font-family:'JetBrains Mono';font-weight:700;font-size:24px;color:${onIntent(s && s.intent_tag)};">${i + 1}</div>`;
      return `
      <div style="display:flex;align-items:center;background:${C.rowBg};border:1px solid ${C.rule};border-radius:6px;padding:20px 24px;">
        <div style="display:flex;width:72px;justify-content:center;">${marker}</div>
        <div style="display:flex;flex-direction:column;flex:1;min-width:0;margin-left:16px;">
          ${label ? `<div style="display:flex;font-family:'JetBrains Mono';font-size:19px;letter-spacing:4px;color:${C.goldSoft};margin-bottom:6px;">${esc(label)}</div>` : ''}
          <div style="display:flex;font-family:Fraunces;font-weight:500;font-size:40px;color:${C.ink};">${esc(clip((s && s.name) || 'Unnamed', LIMITS.place))}</div>
        </div>
      </div>`;
    })
    .join('');

  const noun = isSpots
    ? total === 1 ? 'PLACE' : 'PLACES'
    : total === 1 ? 'STOP' : 'STOPS';

  return (
    header(C, {
      eyebrow: `${isSpots ? 'SPOTS' : 'ROUTE'}${total ? ` · ${total} ${noun}` : ''}`,
      title: t.title || (isSpots ? 'Untitled Spots' : 'Untitled route'),
      sub: subLine(t.city),
    }) +
    rowsBox(C, rows, isSpots ? 'No places yet.' : 'No stops yet.') +
    // Name what's behind the tap. "In the app" alone doesn't tell anyone
    // what they'd get; travel times and the map are the Route payoff, and
    // Spots have neither, so the two modes promise different things.
    foot(
      C,
      [
        remaining > 0 ? `+${remaining} MORE` : '',
        isSpots ? 'NOTES + MAP IN THE APP' : 'TRAVEL TIMES + MAP IN THE APP',
      ]
        .filter(Boolean)
        .join(' · ')
    )
  );
}

// Marker colour by intent. MUST mirror src/lib/intentColors.ts in the app —
// food = burnt sienna, drinks = gold, both = solid copper (same value the
// route static map uses). These are deliberately variant-independent: the
// app renders the same dots on light and dark surfaces, and a story card
// that recolours them stops matching what the user just saw in the feed.
const INTENT_FILL = {
  food: '#8B2A2A',   // --burnt-sienna
  drinks: '#BC8E49', // --gold
  both: '#B87333',   // INTENT_BOTH_COPPER
};

function intentColor(tag, C) {
  return INTENT_FILL[tag] || C.neutralDot;
}

// Mirrors intentLabel() in src/lib/intentColors.ts. Colour alone doesn't
// survive out of context — someone seeing a WildHeavy card for the first
// time has no key for what gold vs sienna means.
function intentLabel(tag) {
  if (tag === 'food') return 'FOOD';
  if (tag === 'drinks') return 'DRINKS';
  if (tag === 'both') return 'FOOD & DRINKS';
  return '';
}

// Numerals sit inside the marker on ordered Routes. Cream on sienna, forest
// on the two brass tones — gold-on-cream is unreadable at 24px.
function onIntent(tag) {
  return tag === 'drinks' || tag === 'both' ? '#1A3629' : '#F4F2EA';
}

// ---------- Helpers ----------
function subLine(...parts) {
  const s = parts
    .filter(Boolean)
    .map((p) => String(p).toUpperCase())
    .join(' · ');
  // 54 fits the full "DATE · SERVICE · PARTY OF N · A GO-TO" chain at 22px
  // mono with 3px tracking inside the 960px content width.
  return s ? clip(s, 54) : '';
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  } catch {
    return null;
  }
}

// Truncate on a word boundary when one sits within 6 chars of the limit,
// otherwise hard-cut. Keeps "Chef's Tasting Menu at…" from becoming
// "Chef's Tasting Menu a…".
function clip(s, max) {
  const str = String(s ?? '').trim();
  if (str.length <= max) return str;
  const cut = str.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${sp >= max - 7 ? cut.slice(0, sp) : cut}…`;
}

// satori-html does NOT decode HTML entities, so classic escaping renders
// literally ("&amp;" on the card). Only neutralize tag-opening characters.
function esc(s) {
  return String(s ?? '')
    .replace(/</g, '‹')
    .replace(/>/g, '›');
}
