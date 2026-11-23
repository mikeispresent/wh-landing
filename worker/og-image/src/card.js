/**
 * WildHeavy link-preview card (1200x630), drawn by Satori via workers-og.
 * Every <div> needs display:flex. Do not HTML-escape & (see esc()).
 */
import { WORDMARK_FOREST, WORDMARK_CREAM } from './brand.js';
import { penRuleImg, penBracketImg, pinImg } from './pen.js';

export const W = 1200, H = 630;

// App tokens (src/index.css, Oct 2026 brand pass).
export const T = {
  paper: '#FBFBF9',
  forest: '#1A3629',
  forestSoft: '#2B4639',     // --muted-foreground
  rule: '#D3D7CF',           // --border hairline
  leather: '#8A5A34',
  oxblood: '#7A2621',
  spread: '#466B8F',         // Spreads steel blue
  cream: '#FBFBF9',
};
const PIN = {
  drinks: { bg: '#C9A84C', fg: '#1A3629' },
  food: { bg: '#A0522D', fg: '#FBFBF9' },
  both: { bg: '#B87B3A', fg: '#FBFBF9' },
  untagged: { bg: '#2D2D2D', fg: '#FBFBF9' },
};
const VERDICT = { 5: 'Top Rank Worthy', 4: "Can't Miss", 3: 'Solid', 2: 'Decent', 1: 'Skip It' };

// ---------- data shaping, shared by every direction ----------
export function shape(data) {
  const c = data.creator || {};
  const handle = c.username ? `@${c.username}` : (c.display_name || '');
  const avatar = c.avatar_uri || null;
  if (data.content_type === 'ranking') {
    const r = data.ranking;
    const items = (r.items_preview || []).slice(0, 3);
    const total = r.total_item_count || items.length;
    const cat = (r.category || '').trim().toLowerCase();
    const sameDish = items.length > 0 && items.every((d) => (d.name || '').trim().toLowerCase() === (items[0].name || '').trim().toLowerCase());
    const restFirst = r.is_restaurant_only || sameDish || items.every((d) => (d.name || '').trim().toLowerCase() === cat);
    return {
      type: 'r', kind: 'Ranking', ink: 'brass', handle, avatar,
      title: stripTail(r.title, r.city) || 'Untitled ranking', city: cityOnly(r.city),
      count: `${total} ${total === 1 ? 'spot' : 'spots'} ranked`,
      rows: items.map((d, i) => ({
        n: i + 1,
        main: restFirst ? (d.restaurant_name || d.name) : d.name,
        sub: restFirst ? '' : (d.restaurant_name || ''),
        photo: d.image_url || null,
      })),
      more: Math.max(0, total - items.length),
      hero: items.find((d) => d.image_url)?.image_url || null,
    };
  }
  if (data.content_type === 'menu_card') {
    const m = data.menu_card;
    const items = (m.dishes_preview || []).slice(0, 3);
    const total = m.total_item_count ?? items.length;
    const serial = typeof m.ticket_number === 'number' ? `N° ${String(m.ticket_number).padStart(3, '0')}` : '';
    return {
      type: 'm', kind: 'Menu Card', ink: T.forest, handle, avatar, serial,
      title: m.restaurant_name || 'Restaurant', city: monthYear(m.visit_date),
      count: `${total} ${total === 1 ? 'item' : 'items'} ordered`,
      rows: items.map((d) => ({ main: d.name || 'Unnamed', verdict: VERDICT[Math.round(Number(d.rating))] || '', photo: d.image_url || null })),
      more: Math.max(0, total - items.length),
      hero: items.find((d) => d.image_url)?.image_url || null,
    };
  }
  if (data.content_type === 'route') {
    const t = data.route;
    const spots = t.kind === 'spots';
    const stops = Array.isArray(t.stops) ? t.stops : [];
    const total = t.total_stop_count || stops.length;
    const shown = stops.slice(0, 4);
    return {
      type: 't', kind: spots ? 'List' : 'Route', ink: T.spread, handle, avatar, spots,
      title: stripTail(t.title, t.city) || (spots ? 'Untitled list' : 'Untitled route'), city: cityOnly(t.city),
      count: `${total} ${spots ? (total === 1 ? 'place' : 'places') : (total === 1 ? 'stop' : 'stops')}`,
      rows: shown.map((s, i) => ({ n: i + 1, main: s.name || 'Unnamed', sub: s.short_address || s.neighborhood || '', pin: PIN[s.intent_tag] || PIN.untagged, photo: s.image_url || null })),
      more: Math.max(0, total - shown.length),
      hero: t.map_uri || null,
    };
  }
  if (data.content_type === 'list') {
    // A My Recs list: the first four places, best dish first, as the page shows them.
    const l = data.list;
    const places = Array.isArray(l.places) ? l.places : [];
    const total = l.place_count || places.length;
    const shown = places.slice(0, 4);
    return {
      type: 'l', kind: 'Where to eat', ink: T.forest, handle, avatar,
      title: l.title || 'My Recs', city: cityOnly(l.city) === l.title ? '' : cityOnly(l.city),
      count: `${total} ${total === 1 ? 'place' : 'places'}`,
      rows: shown.map((p) => ({ main: p.name || 'Unnamed', sub: p.best_dish?.name || '', photo: p.image_url || null })),
      more: Math.max(0, total - shown.length),
      hero: shown.find((p) => p.image_url)?.image_url || null,
    };
  }
  if (data.content_type === 'want') {
    // A sent Want to try list or collection: the first four places.
    const w = data.want;
    const places = Array.isArray(w.places) ? w.places : [];
    const total = w.place_count || places.length;
    const shown = places.slice(0, 4);
    return {
      // The whole list is itself titled Want to try, so its label says My list.
      type: 'l', kind: w.is_collection ? 'Want to try' : 'My list', ink: T.spread, handle, avatar,
      title: w.title || 'Want to try', city: w.city_line && w.city_line !== w.title ? w.city_line : '',
      count: `${total} ${total === 1 ? 'place' : 'places'}`,
      rows: shown.map((p) => ({ main: p.name || 'A place', sub: p.neighborhood || '', photo: p.image_url || null })),
      more: Math.max(0, total - shown.length),
      hero: shown.find((p) => p.image_url)?.image_url || null,
    };
  }
  return null;
}

// ---------- shared pieces ----------
const div = (style, inner = '') => `<div style="display:flex;${style}">${inner}</div>`;
const txt = (style, s) => div(style, esc(s));

function wordmark(h, cream) {
  const m = cream ? WORDMARK_CREAM : WORDMARK_FOREST;
  const w = Math.round((m.w / m.h) * h);
  return `<img src="${m.uri}" width="${w}" height="${h}" style="width:${w}px;height:${h}px;" />`;
}
function avatarImg(uri, size) {
  return uri ? `<img src="${uri}" width="${size}" height="${size}" style="width:${size}px;height:${size}px;border-radius:${size / 2}px;object-fit:cover;" />` : '';
}
function photo(uri, w, h) {
  return `<img src="${uri}" width="${w}" height="${h}" style="width:${w}px;height:${h}px;object-fit:cover;" />`;
}
// Rank numerals: brass for #1 (the metal), leather after. Big Shoulders like the app.
function numeral(n, size, onDark) {
  if (n === 1) {
    return div(`font-family:'Big Shoulders Display';font-weight:900;font-size:${size}px;line-height:0.8;background-image:linear-gradient(180deg,#7a5a24 0%,#c9a24e 30%,#f3dd9b 52%,#b8904a 74%,#7a5a24 100%);background-clip:text;color:transparent;`, String(n));
  }
  return div(`font-family:'Big Shoulders Display';font-weight:900;font-size:${size}px;line-height:0.8;color:${onDark ? '#C9A24E' : T.leather};`, String(n));
}

// =====================================================================
// THE PLATE, on forest (picked 2026-11-10). Half the card is the real
// photo, as shot, edge to edge; a Route shows its own map. The other half
// is the forest ground with cream type, brass numerals, the cream wordmark.
// No photo: the app's own fallback, a pen bracket around the top entry.
// A photo that isn't the #1 entry's is labelled with its number and name,
// on a neutral black scrim (allowed: it carries text).
// =====================================================================
export function plateCard(s, dark = true) {
  const ink = dark ? T.cream : T.forest;
  const soft = dark ? "rgba(251,251,249,0.72)" : T.forestSoft;
  const ground = dark ? T.forest : T.paper;
  const lead = dark ? "#D8BB72" : T.leather;
  const lineInk = s.ink === "brass" ? "brass" : dark ? (s.type === "t" ? "#8FB0CF" : "#9DBFA8") : s.ink;
  const PW = 560;
  let leftPanel;
  if (s.hero) {
    const hr = s.rows.find((r) => r.photo === s.hero);
    const cap = s.type === 'r' && hr && hr.n !== 1
      ? div(`position:absolute;left:0;bottom:0;width:${PW}px;padding:60px 36px 28px;background-image:linear-gradient(180deg,rgba(0,0,0,0) 0%,rgba(0,0,0,0.62) 100%);align-items:flex-end;`,
          div(`font-family:'Big Shoulders Display';font-weight:900;font-size:56px;line-height:0.8;color:#F3DD9B;`, String(hr.n)) +
          txt(`font-family:Bitter;font-weight:700;font-size:30px;color:#FBFBF9;margin-left:14px;`, hr.main))
      : '';
    leftPanel = div(`position:relative;width:${PW}px;height:${H}px;flex-shrink:0;overflow:hidden;`, photo(s.hero, PW, H) + cap);
  } else {
    const top = s.rows[0];
    leftPanel = div(`width:${PW}px;height:${H}px;flex-shrink:0;padding:70px 40px 70px 64px;`,
      div(`position:relative;flex-direction:column;justify-content:center;width:100%;height:100%;padding-left:56px;color:${ink};`,
        penBracketImg(H - 140, lineInk, 2.4) +
        (top ? (s.type === 'r' ? numeral(1, 150, dark) : '') +
          txt(`font-family:'Big Shoulders Display';font-weight:900;font-size:${top.main.length > 18 ? 58 : 72}px;line-height:1;padding-bottom:6px;color:${ink};margin-top:${s.type === 'r' ? 18 : 0}px;max-width:400px;`, clip(top.main, 34)) +
          (top.sub || top.verdict ? txt(`font-family:'Instrument Sans';font-weight:600;font-size:28px;color:${soft};margin-top:12px;`, top.sub || top.verdict) : '')
        : '')));
  }
  const long = s.title.length > 30;
  const ts = s.title.length <= 16 ? 96 : long ? 58 : 76;
  const lines = long ? 3 : 2;
  const list = s.rows.slice(0, s.type === 't' || s.type === 'l' ? 4 : 3).map((r) => {
    const mark = s.type === 'r' ? div(`width:44px;`, numeral(r.n, 44, dark))
      : s.type === 't' ? div(`width:48px;`, pinImg(34, r.pin.bg, r.pin.fg, s.spots ? '' : String(r.n))) : '';
    const tail = s.type === 'm' && r.verdict ? txt(`font-family:'JetBrains Mono';font-weight:700;font-size:20px;color:${lead};text-transform:uppercase;margin-left:14px;flex-shrink:0;`, r.verdict) : '';
    return div(`align-items:center;margin-top:${s.rows.length > 3 ? 10 : 16}px;`, mark +
      txt(`font-family:Bitter;font-weight:700;font-size:34px;color:${ink};max-width:${tail ? 330 : 470}px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;`, r.main) + tail);
  }).join('');
  const right = div(`flex-direction:column;flex:1;height:${H}px;padding:52px 56px 46px 52px;`,
    div(`justify-content:space-between;align-items:flex-start;`,
      div(`flex-direction:column;`, penRuleImg(200, s.ink === 'brass' ? 12 : 9, lineInk) +
        div(`margin-top:20px;`, txt(`font-family:'Instrument Sans';font-weight:600;font-size:26px;letter-spacing:2px;color:${soft};text-transform:uppercase;`, s.kind) + txt(`font-family:'Instrument Sans';font-weight:600;font-size:26px;letter-spacing:2px;color:${soft};opacity:0.7;text-transform:uppercase;margin-left:18px;`, s.type === 'm' ? s.serial : s.city))) +
      wordmark(58, dark)) +
    txt(`font-family:'Big Shoulders Display';font-weight:900;font-size:${ts}px;line-height:1;padding-bottom:6px;color:${ink};margin-top:16px;max-height:${ts * lines + 8}px;overflow:hidden;`, clip(s.title, 52)) +
    div(`flex-direction:column;flex:1;justify-content:center;`, list) +
    div(`align-items:center;`, avatarImg(s.avatar, 44) +
      txt(`font-family:'Instrument Sans';font-weight:600;font-size:28px;color:${ink};margin-left:${s.avatar ? 14 : 0}px;max-width:${s.avatar ? 290 : 330}px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;`, s.handle) +
      txt(`font-family:'JetBrains Mono';font-weight:700;font-size:20px;color:${soft};margin-left:auto;padding-left:16px;flex-shrink:0;`, s.count)));
  return div(`width:${W}px;height:${H}px;background:${ground};`, leftPanel + right);
}

// ---------- helpers ----------
// satori-html does NOT decode HTML entities, so classic escaping (&amp;)
// renders literally. Only neutralize tag-opening characters.
function esc(s) { return String(s ?? '').replace(/</g, '‹').replace(/>/g, '›'); }
// Shorten on a word boundary so a name never ends on a stray letter.
function clip(s, max) {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  let cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.5) cut = cut.slice(0, sp);
  cut = cut.replace(/[\s,;:&(\-]+$/, '').replace(/\s+(and|with|of|the|a|in|on|&)$/i, '');
  return `${cut}…`;
}
export function cityOnly(c) { return (c || '').split(',')[0].trim(); }
// "My Tiramisu Rankings — Chicago, IL, USA" -> "My Tiramisu Rankings". Also drops a pasted em dash.
export function stripTail(title, city) {
  let t = String(title || '').trim();
  t = t.replace(/\s*[—–-]\s*[^—–-]*,\s*[A-Z]{2}(,\s*USA)?\s*$/i, '');
  if (city) {
    const full = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\s*[—–-]\\s*${full}\\s*$`, 'i'), '');
  }
  return t.replace(/\s*[—–]\s*/g, ' ').trim();
}
function monthYear(d) {
  if (!d) return '';
  const dt = new Date(d.length === 10 ? `${d}T12:00:00Z` : d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
