/**
 * WildHeavy — "Paper" share cards, rendered by a real Chrome
 * (Cloudflare Browser Rendering) instead of Satori.
 *
 * Every card is a physical object the content would live on:
 *   menu_card -> Guest Check   (diner order pad)
 *   ranking   -> Lineup Card   (dugout batting order)
 *   route     -> Route Card / Spots Card (punch card)
 *
 * Two sizes, chosen by the app (it cannot know where the user will post):
 *   story -> 1080x1920 (Instagram/Facebook Stories)
 *   post  -> 1080x1440 (3:4, the tallest feed post Instagram allows)
 *
 * Shared ink rules: forest = the printed form, pen blue = what the user
 * wrote, oxblood = serial numbers and the rubber stamp. Faces: Bitter
 * (printed headings), Instrument Sans (printed labels), JetBrains Mono
 * (serial + the Certified Heavy maker's mark), Reenie Beanie (the pen).
 *
 * The page signals readiness with window.__WH_READY, and window.__WH_FONTS_OK
 * is false if the pen face fell back (width probe), so the Worker can refuse
 * to ship a card in the wrong font.
 */

export const PAPER_SIZES = {
  story: { w: 1080, h: 1920, top: 250, bottom: 250, extraBlank: 3 },
  post: { w: 1080, h: 1440, top: 60, bottom: 60, extraBlank: 1 },
};

const RATING_WORDS = {
  5: 'top rank worthy',
  4: "can't miss",
  3: 'solid',
  2: 'decent',
  1: 'skip it',
};

// Mirrors getReservationDifficultyLabel() in ratingDefinitions.ts (0..5).
const ACCESS = ['Walk-in friendly', 'Easy booking', 'Plan ahead', 'High demand', 'Tough ticket', 'Insider only'];

const MEAL = { brunch: 'brunch', lunch: 'lunch', dinner: 'dinner', happy_hour: 'happy hour', just_drinks: 'drinks' };

const PHOTO_HOST = /^https:\/\/dxwjkuqsncatvovjwrzv\.supabase\.co\/storage\/v1\/object\/public\//;

export function buildPaperHtml(data, { format = 'story', wordmarkUri }) {
  const size = PAPER_SIZES[format] || PAPER_SIZES.story;
  const creator = data.creator || {};
  const handle = creator.username ? `@${creator.username}` : creator.display_name || '';

  let body = null;
  let kind = '';
  if (data.content_type === 'menu_card' && data.menu_card) {
    body = guestCheck(data.menu_card, handle, size, wordmarkUri);
    kind = 'check';
  } else if (data.content_type === 'ranking' && data.ranking) {
    body = lineupCard(data.ranking, handle, size, wordmarkUri);
    kind = 'lineup';
  } else if (data.content_type === 'route' && data.route) {
    body = punchCard(data.route, handle, size, wordmarkUri);
    kind = 'punch';
  }
  if (!body) return null;

  // Table photos: the top 3 photos behind the paper, each a different dish.
  // 0 -> plain forest, 1 -> that photo stacked three times, 2-3 -> stacked bands.
  // Capped at 3 on purpose: the rest live in the app.
  let tablePhotos = topPhotos(data).slice(0, 3);
  if (tablePhotos.length === 1) tablePhotos = [tablePhotos[0], tablePhotos[0], tablePhotos[0]];
  const table = tablePhotos.length
    ? `<div class="table n${tablePhotos.length}">${tablePhotos.map((u) => `<img src="${escAttr(u)}" alt="">`).join('')}</div>`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bitter:ital,wght@0,600;0,700;0,800;1,600&family=Instrument+Sans:wght@400;600&family=JetBrains+Mono:wght@700&family=Reenie+Beanie&display=block" rel="stylesheet">
<style>${CSS(size)}</style></head>
<body class="${format}">
<svg width="0" height="0" style="position:absolute"><filter id="rough"><feTurbulence type="fractalNoise" baseFrequency=".06" numOctaves="3" seed="4"/><feDisplacementMap in="SourceGraphic" scale="5"/></filter></svg>
${table}<div class="stage"><div class="paper ${kind}">${body}</div></div>
<script>${READY_SCRIPT}</script>
</body></html>`;
}

// ---------- Guest Check (Menu Card) ----------
function guestCheck(m, handle, size, wordmarkUri) {
  const total = m.total_item_count ?? m.total_dish_count ?? (m.dishes_preview || []).length;
  const dishes = (m.dishes_preview || []).slice(0, 3);
  const remaining = Math.max(0, total - dishes.length);
  const hasDrinks = typeof m.total_drink_count === 'number' && m.total_drink_count > 0;
  const noun = hasDrinks ? (total === 1 ? 'item' : 'items') : total === 1 ? 'dish' : 'dishes';
  const serial = typeof m.ticket_number === 'number' ? `Nº ${String(m.ticket_number).padStart(3, '0')}` : '';

  let stamped = false;
  const rows = dishes
    .map((d) => {
      const r = d.rating == null ? null : Math.round(Number(d.rating));
      let verdict = '';
      if (r === 5 && !stamped) {
        stamped = true;
        verdict = `<div class="stamp">Top Rank<br>Worthy</div>`;
      } else if (RATING_WORDS[r]) {
        verdict = pen(RATING_WORDS[r], 'wrap');
      }
      return `<div class="row d">${photoCell(d.image_url)}<div class="c">${pen(d.name || 'Unnamed dish', 'fit')}</div><div class="c v">${verdict}</div></div>`;
    })
    .join('');

  const more = remaining > 0 ? `+ ${remaining} more, every note in the app` : 'every note in the app';
  const diff = m.reservation_difficulty == null ? null : Math.max(0, Math.min(5, Math.round(Number(m.reservation_difficulty))));
  const boxes = ACCESS.map(
    (label, i) => `<span class="opt"><i>${i === diff ? '<b class="tick">✓</b>' : ''}</i>${label}</span>`
  ).join('');

  return `
  ${masthead(wordmarkUri, 'Guest Check', serial)}
  <div class="fields f4">
    ${field('Date', monthYear(m.visit_date))}
    ${field('Guests', m.party_size > 0 ? String(m.party_size) : '')}
    ${field('Meal', MEAL[m.meal_service] || '')}
    ${field('Ordered by', handle)}
  </div>
  <div class="line big"><div class="lbl">Restaurant</div>${pen(m.restaurant_name || 'Restaurant', 'fit name')}</div>
  <div class="opts">${boxes}</div>
  <div class="grid g3${hasPhoto(dishes) ? '' : ' nph'}">
    <div class="row hd"><div class="c"></div><div class="c"><span class="lbl">Order</span></div><div class="c"><span class="lbl">Verdict</span></div></div>
    ${rows}
    <div class="row">${'<div class="c"></div>'}<div class="c">${pen(more, 'fit small')}</div><div class="c"></div></div>
    ${blankRows(3, size.extraBlank)}
  </div>
  <div class="total"><div class="c tl">Total</div><div class="c">${pen(`${total} ${noun}`, 'fit')}</div></div>
  ${stub(serial)}`;
}

// ---------- Lineup Card (Ranking) ----------
function lineupCard(r, handle, size, wordmarkUri) {
  const total = r.total_item_count || (r.items_preview || []).length;
  const items = (r.items_preview || []).slice(0, 3);
  const remaining = Math.max(0, total - items.length);

  const rows = items
    .map(
      (d, i) => `<div class="row d"><div class="c num">${i === 0 ? `<span class="circled">1</span>` : i + 1}</div>${photoCell(d.image_url)}
        <div class="c stack">${pen(d.name || 'Unnamed', 'fit')}${d.restaurant_name ? pen(d.restaurant_name, 'fit sub') : ''}</div></div>`
    )
    .join('');

  const next = items.length + 1;
  const more =
    remaining > 0 ? `+ ${remaining} more, full lineup in the app` : 'full lineup in the app';
  let blanks = '';
  const nBlank = Math.max(0, 9 - next) ;
  for (let i = 0; i < Math.min(nBlank, size.extraBlank + 2); i++) {
    blanks += `<div class="row blank"><div class="c num">${next + 1 + i}</div><div class="c"></div><div class="c"></div></div>`;
  }

  return `
  ${masthead(wordmarkUri, 'Lineup Card', '')}
  <div class="line big"><div class="lbl">Team</div>${pen(stripLocationTail(r.title, r.city) || 'Untitled ranking', 'fit name')}</div>
  <div class="fields f3">
    ${field('Date', monthYear(r.created_at))}
    ${field('City', cityOnly(r.city))}
    ${field('Manager', handle)}
  </div>
  <div class="grid gl${hasPhoto(items) ? '' : ' nph'}">
    <div class="row hd"><div class="c"><span class="lbl">No.</span></div><div class="c"></div><div class="c"><span class="lbl">Player</span></div></div>
    ${rows}
    <div class="row"><div class="c num">${next}</div><div class="c"></div><div class="c">${pen(more, 'fit small')}</div></div>
    ${blanks}
  </div>
  <div class="total"><div class="c tl">Roster</div><div class="c">${pen(`${total} ${total === 1 ? 'dish' : 'dishes'}`, 'fit')}</div></div>
  ${stub('')}`;
}

// ---------- Route Card / Spots Card ----------
function punchCard(t, handle, size, wordmarkUri) {
  const isSpots = t.kind === 'spots';
  const stops = Array.isArray(t.stops) ? t.stops : [];
  const total = t.total_stop_count || stops.length;
  const cap = size === PAPER_SIZES.post ? 4 : 6;
  const shown = stops.slice(0, cap);
  const remaining = Math.max(0, total - shown.length);

  const rows = shown
    .map((s, i) => {
      const tag = s && s.intent_tag;
      const food = tag === 'food' || tag === 'both';
      const drinks = tag === 'drinks' || tag === 'both';
      return `<div class="row d">
        <div class="c hole-c">${isSpots ? '' : `<span class="stopn">${i + 1}</span>`}<span class="hole"></span></div>
        ${photoCell(s && s.image_url)}
        <div class="c">${pen((s && s.name) || 'Unnamed', 'fit')}</div>
        <div class="c x">${food ? pen('X', '') : ''}</div>
        <div class="c x">${drinks ? pen('X', '') : ''}</div>
      </div>`;
    })
    .join('');

  const tail = isSpots ? 'notes + map in the app' : 'travel times + map in the app';
  const more = remaining > 0 ? `+ ${remaining} more, ${tail}` : tail;
  const noun = isSpots ? (total === 1 ? 'place' : 'places') : total === 1 ? 'stop' : 'stops';

  return `
  ${masthead(wordmarkUri, isSpots ? 'Spots Card' : 'Route Card', '')}
  <div class="line big"><div class="lbl">${isSpots ? 'Spots' : 'Route'}</div>${pen(stripLocationTail(t.title, t.city) || (isSpots ? 'Untitled Spots' : 'Untitled route'), 'fit name')}</div>
  <div class="fields f3">
    ${field('City', cityOnly(t.city))}
    ${field(isSpots ? 'Places' : 'Stops', `${total} ${noun}`)}
    ${field('Mapped by', handle)}
  </div>
  <div class="grid gp${hasPhoto(shown) ? '' : ' nph'}">
    <div class="row hd"><div class="c">${isSpots ? '' : '<span class="lbl">Stop</span>'}</div><div class="c"></div><div class="c"><span class="lbl">Place</span></div><div class="c"><span class="lbl">Food</span></div><div class="c"><span class="lbl">Drinks</span></div></div>
    ${rows}
    <div class="row"><div class="c"></div><div class="c"></div><div class="c wide">${pen(more, 'fit small')}</div></div>
    ${blankRows(5, size.extraBlank - 1)}
  </div>
  ${stub('')}`;
}

// ---------- Pieces ----------
function masthead(wordmarkUri, title, serial) {
  return `<div class="top">
    ${wordmarkUri ? `<img class="wm" src="${wordmarkUri}">` : ''}
    <div class="gc">${esc(title)}</div>
    <div class="no">${esc(serial)}</div>
  </div>`;
}

function field(label, value) {
  return `<div class="f"><div class="lbl">${esc(label)}</div>${value ? pen(value, 'fit') : ''}</div>`;
}

function photoCell(url) {
  const ok = typeof url === 'string' && PHOTO_HOST.test(url);
  return `<div class="c ph">${ok ? `<img src="${escAttr(url)}">` : ''}</div>`;
}

function blankRows(cols, n) {
  let s = '';
  for (let i = 0; i < Math.max(0, n); i++) {
    s += `<div class="row blank">${'<div class="c"></div>'.repeat(cols)}</div>`;
  }
  return s;
}

function stub(serial) {
  return `<div class="perf"></div>
  <div class="stub">
    <div class="say">We're all regulars here.<em>wildheavy.com</em></div>
    <div class="mk">${serial ? `<span class="no">${esc(serial)}</span>` : ''}<span class="cert">Certified Heavy</span></div>
  </div>`;
}

function pen(text, cls) {
  const body = esc(text).replace(/&amp;/g, '<span class="amp">&amp;</span>');
  return `<div class="h ${cls || ''}">${body}</div>`;
}

function cityOnly(c) {
  return String(c || '').split(',')[0].trim();
}

// "My Wings Rankings — Chicago, IL, USA" -> "My Wings Rankings". Only strips
// a trailing dash segment that starts with the content's own city.
function stripLocationTail(title, city) {
  const t = String(title || '');
  const c = cityOnly(city);
  if (!c) return t;
  const m = t.match(/^(.*\S)\s*[—–-]\s*([^—–-]+)$/);
  return m && m[2].trim().toLowerCase().startsWith(c.toLowerCase()) ? m[1] : t;
}

function topPhotos(data) {
  const ok = (u) => typeof u === 'string' && PHOTO_HOST.test(u);
  let list = [];
  if (data.content_type === 'menu_card') list = data.menu_card?.dishes_preview || [];
  else if (data.content_type === 'ranking') list = data.ranking?.items_preview || [];
  else if (data.content_type === 'route') list = data.route?.stops || [];
  return list.map((x) => x && x.image_url).filter(ok);
}

function hasPhoto(list) {
  return (list || []).some((x) => x && typeof x.image_url === 'string' && PHOTO_HOST.test(x.image_url));
}

function monthYear(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 7) + '-15T12:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;');
}

// ---------- Styles ----------
function CSS(size) {
  return `
*{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#24442f;--pen:#1d2a55;--ox:#8f2f2a;--hair:1.5px solid var(--ink);--heavy:3px solid var(--ink)}
html,body{width:${size.w}px;height:${size.h}px;overflow:hidden}
body{background:radial-gradient(ellipse at 50% 40%,#2b4a37 0%,#1a2f22 75%);font-family:'Instrument Sans',sans-serif;color:var(--ink)}
.table{position:absolute;inset:0;display:grid;gap:6px;background:#1a2f22}
.table.n1{grid-template-rows:1fr}.table.n2{grid-template-rows:1fr 1fr}.table.n3{grid-template-rows:1fr 1fr 1fr}
.table img{width:100%;height:100%;object-fit:cover;display:block;min-height:0}
.table ~ .stage .paper{box-shadow:0 4px 0 rgba(0,0,0,.12),0 40px 80px rgba(0,0,0,.55)}
.stage{position:absolute;left:0;right:0;top:${size.top}px;bottom:${size.bottom}px;display:flex;align-items:center;justify-content:center}
.paper{position:relative;width:880px;padding:40px 46px 34px;background:var(--paper);box-shadow:0 2px 0 rgba(0,0,0,.08),0 30px 60px rgba(0,0,0,.35);transform-origin:50% 50%}
.paper::after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.35;mix-blend-mode:multiply;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/><feColorMatrix values='0 0 0 0 .55  0 0 0 0 .6  0 0 0 0 .5  0 0 0 .5 0'/></filter><rect width='300' height='300' filter='url(%23n)'/></svg>")}
.check{--paper:#e6ecd8;--rot:-1.6deg}
.lineup{--paper:#efe6cf;--rot:1.2deg}
.punch{--paper:#ecd6c9;--rot:-0.9deg}
.lbl{font-size:17px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;line-height:1}
.h{font-family:'Reenie Beanie',cursive;color:var(--pen);font-size:54px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:clip;max-width:100%}
.top{display:flex;align-items:flex-end;justify-content:space-between;border-bottom:var(--heavy);padding-bottom:14px;gap:20px}
.top .wm{height:88px;width:auto}
.top .gc{font-family:Bitter,serif;font-weight:800;font-size:56px;letter-spacing:-.01em;line-height:1;flex:1;text-align:center;white-space:nowrap}
.top .no{font-family:'JetBrains Mono',monospace;font-weight:700;color:var(--ox);font-size:28px;min-width:60px;text-align:right}
.fields{display:grid;border-bottom:var(--heavy)}
.f4{grid-template-columns:1.15fr .7fr .9fr 1.7fr}
.f3{grid-template-columns:1fr 1fr 1.4fr}
.f{border-right:var(--hair);padding:9px 12px 6px;height:100px;display:flex;flex-direction:column;justify-content:space-between;min-width:0}
.f:last-child{border-right:0}
.f .h{font-size:48px}
.line{border-bottom:var(--hair);padding:9px 0 4px;display:flex;flex-direction:column;gap:6px;min-width:0}
.line.big .h{font-size:76px;padding-left:2px}
.opts{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 18px;padding:14px 0;border-bottom:var(--heavy);font-size:20px;font-weight:600}
.opt{display:flex;align-items:center;gap:10px;white-space:nowrap}
.opt i{width:24px;height:24px;border:2px solid var(--ink);position:relative;flex:none}
.tick{position:absolute;left:-2px;top:-22px;font-family:'Reenie Beanie',cursive;font-weight:400;color:var(--pen);font-size:48px;line-height:1}
.grid{position:relative}
.row{display:grid;height:88px;border-bottom:var(--hair)}
.row.hd{height:38px}
.row.d{height:122px}
.g3 .row{grid-template-columns:128px 1fr 205px}
.gl .row{grid-template-columns:76px 128px 1fr}
.gp .row{grid-template-columns:96px 128px 1fr 92px 92px}
.g3.nph .row{grid-template-columns:1fr 205px}
.g3.nph .row>.c:nth-child(1){display:none}
.gl.nph .row{grid-template-columns:76px 1fr}
.gl.nph .row>.c:nth-child(2){display:none}
.gp.nph .row{grid-template-columns:96px 1fr 92px 92px}
.gp.nph .row>.c:nth-child(2){display:none}
.row .c{border-right:var(--hair);position:relative;display:flex;align-items:center;padding:0 12px;min-width:0}
.row .c:last-child{border-right:0}
.row.hd .c{align-items:flex-end;padding-bottom:6px}
.row .c.wide{grid-column:span 3}
.row .h.small{font-size:44px}
.h.wrap{white-space:normal;font-size:44px;line-height:.82;overflow:visible}
.amp{font-family:Bitter,serif;font-style:italic;font-weight:600;font-size:.72em;margin:0 .06em}
.c.ph{padding:8px 10px 8px 8px}
.c.ph img{position:absolute;left:8px;top:8px;width:calc(100% - 18px);height:calc(100% - 16px);object-fit:cover;display:block}
.c.v{overflow:visible}
.c.stack{flex-direction:column;align-items:flex-start;justify-content:center;gap:4px}
.c.stack .h.sub{font-size:36px;opacity:.85}
.c.num{justify-content:center;font-family:Bitter,serif;font-weight:800;font-size:40px;color:var(--ink)}
.circled{position:relative;display:inline-block}
.circled::after{content:"";position:absolute;left:-18px;top:-10px;right:-18px;bottom:-8px;border:3px solid var(--pen);border-radius:50%;transform:rotate(-8deg)}
.c.x{justify-content:center}
.c.x .h{font-size:64px}
.hole-c{justify-content:center;gap:10px}
.stopn{font-family:Bitter,serif;font-weight:800;font-size:30px}
.hole{width:30px;height:30px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#1a2f22 0%,#203a2a 70%);box-shadow:inset 0 2px 3px rgba(0,0,0,.5);flex:none}
.stamp{position:absolute;right:-26px;top:50%;transform:translateY(-50%) rotate(-7deg);color:var(--ox);border:5px solid var(--ox);padding:8px 16px 6px;font-family:Bitter,serif;font-weight:800;font-size:36px;line-height:1;text-transform:uppercase;letter-spacing:.02em;opacity:.88;filter:url(#rough);text-align:center;white-space:nowrap;z-index:2}
.total{display:grid;grid-template-columns:1fr 205px;height:92px;border-bottom:var(--heavy)}
.total .c{position:relative;display:flex;align-items:center;padding:0 12px;min-width:0}
.total .tl{justify-content:flex-end;padding-right:22px;font-family:Bitter,serif;font-weight:800;font-size:34px;border-right:var(--hair)}
.perf{margin:26px -46px 0;border-top:4px dotted rgba(36,68,47,.55)}
.stub{display:flex;justify-content:space-between;align-items:center;padding-top:26px}
.stub .say{font-family:Bitter,serif;font-weight:700;font-size:38px;line-height:1.1}
.stub .say em{display:block;font-style:normal;font-family:'Instrument Sans',sans-serif;font-weight:600;font-size:22px;margin-top:10px;letter-spacing:.03em}
.stub .mk{display:flex;flex-direction:column;align-items:flex-end;gap:10px}
.stub .no{font-family:'JetBrains Mono',monospace;font-weight:700;color:var(--ox);font-size:24px}
.stub .cert{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:19px;letter-spacing:.32em;text-transform:uppercase;margin-right:-.32em}
`;
}

// Runs inside Chrome. Waits for real fonts and photos, shrinks any pen line
// that overflows its cell, drops spare blank rows until the paper fits its
// band, then tilts the paper and raises the ready flag.
const READY_SCRIPT = `
(async () => {
  const specs = ['400 54px "Reenie Beanie"', 'italic 600 40px Bitter', '800 56px Bitter', '700 38px Bitter', '600 20px "Instrument Sans"', '700 24px "JetBrains Mono"'];
  try { await Promise.all(specs.map(s => document.fonts.load(s))); } catch (e) {}
  // Width probe: the pen face must measure differently from a bogus family,
  // or it fell back and the card would ship in the wrong handwriting.
  const cv = document.createElement('canvas').getContext('2d');
  const w = f => { cv.font = f; return cv.measureText('Spicy Korean Pickles').width; };
  window.__WH_FONTS_OK = w('54px "Reenie Beanie"') !== w('54px WHBogusFace') && w('800 56px Bitter') !== w('800 56px WHBogusFace');

  await Promise.all([...document.images].map(img => {
    if (img.complete && img.naturalWidth) return null;
    return new Promise(res => {
      const done = () => res();
      img.addEventListener('load', done); img.addEventListener('error', () => { img.remove(); res(); });
      setTimeout(() => { if (!img.naturalWidth) img.remove(); res(); }, 6000);
    });
  }));

  for (const el of document.querySelectorAll('.h.fit')) {
    let size = parseFloat(getComputedStyle(el).fontSize);
    const min = Math.max(26, size * 0.55);
    while (el.scrollWidth > el.clientWidth + 1 && size > min) { size -= 1; el.style.fontSize = size + 'px'; }
    if (el.scrollWidth > el.clientWidth + 1) {
      let t = el.textContent;
      while (t.length > 1 && el.scrollWidth > el.clientWidth + 1) { t = t.slice(0, -1); el.textContent = t.trimEnd() + '…'; }
    }
  }

  const paper = document.querySelector('.paper');
  const stage = document.querySelector('.stage');
  const room = stage.clientHeight - 30;
  const blanks = [...document.querySelectorAll('.row.blank')];
  while (paper.offsetHeight > room && blanks.length) blanks.pop().remove();
  const rot = getComputedStyle(paper).getPropertyValue('--rot') || '0deg';
  const scale = paper.offsetHeight > room ? room / paper.offsetHeight : 1;
  paper.style.transform = 'rotate(' + rot.trim() + ') scale(' + scale + ')';
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__WH_READY = true;
})();
`;
