// Pen line art, ported from the app (PenRule mask, PenBracket, BrassCrown).
// Rendered as SVG data URIs so Satori draws the exact same strokes.
const RULE_PATH = "M0 3.1L2.5 2.94L5 2.79L7.5 2.64L10 2.51L12.5 2.39L15 2.28L17.5 2.2L20 2.14L25 2.09L40 2.11L100 2.15L200 2.22L300 2.26L400 2.28L500 2.26L600 2.22L700 2.15L800 2.07L900 1.97L960 1.91L975 1.9L980 1.94L985 2.07L990 2.27L995 2.52L1000 2.8L1000 2.8L995 3.09L990 3.35L985 3.56L980 3.7L975 3.75L960 3.77L900 3.84L800 3.99L700 4.13L600 4.27L500 4.37L400 4.42L300 4.42L200 4.37L100 4.27L40 4.19L25 4.17L20 4.11L15 3.96L10 3.72L5 3.43L2.5 3.27L0 3.1Z";
const CORNER = "M56 2.90L52.49 2.68L48.11 2.45L43.74 2.30L39.37 2.26L35 2.29L28 2.29L21.01 2.23L14.02 2.13L7.89 2.02L6.96 2L6.02 2.10L5.09 2.38L4.22 2.84L3.46 3.46L2.84 4.22L2.38 5.09L2.10 6.02L2 6.95L2 10L4 10L4 7.05L4.06 6.41L4.23 5.85L4.51 5.33L4.88 4.88L5.33 4.51L5.85 4.23L6.41 4.06L7.04 4L7.86 4.02L14.86 4.14L21.86 4.24L28.87 4.30L35.88 4.29L42.89 4.16L47.26 3.91L51.63 3.53L56 3.10Z";
const MIDDLE = "M2.09 0L2.18 150L2.24 400L2.22 500L2.14 650L1.88 1000L3.78 1000L4.04 783L4.25 600L4.36 400L4.29 200L4.09 0Z";

export const BRASS = [[0,'#7a5a24'],[0.14,'#b8904a'],[0.3,'#f3dd9b'],[0.44,'#c9a24e'],[0.58,'#8a6a2f'],[0.74,'#d8bb72'],[0.84,'#f6e7b4'],[1,'#9c7633']];

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const uri = (svg) => `data:image/svg+xml;base64,${b64(svg)}`;
const grad = (id, stops, vertical) =>
  `<defs><linearGradient id="${id}" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient></defs>`;

/** The pen rule: nearly straight, slight bow, tapered ends. ink = a color or 'brass'. */
export function penRuleImg(w, h, ink) {
  const fill = ink === 'brass' ? 'url(#g)' : ink;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1000 6" preserveAspectRatio="none">${ink === 'brass' ? grad('g', BRASS) : ''}<path d="${RULE_PATH}" fill="${fill}"/></svg>`;
  return `<img src="${uri(svg)}" width="${w}" height="${h}" style="width:${w}px;height:${h}px;" />`;
}

/** The pen bracket down the left edge, turning both corners. scale = px per app px. */
export function penBracketImg(h, ink, scale = 2) {
  const H = h / scale;
  const fill = ink === 'brass' ? 'url(#g)' : ink;
  const sy = (H - 19) / 1000;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${60 * scale}" height="${h}" viewBox="0 0 60 ${H}">${ink === 'brass' ? grad('g', BRASS, true) : ''}
    <path d="${CORNER}" fill="${fill}"/>
    <g transform="translate(0 9.5) scale(1 ${sy})"><path d="${MIDDLE}" fill="${fill}"/></g>
    <g transform="translate(0 ${H}) scale(1 -1)"><path d="${CORNER}" fill="${fill}"/></g></svg>`;
  return `<img src="${uri(svg)}" width="${60 * scale}" height="${h}" style="position:absolute;left:0;top:0;width:${60 * scale}px;height:${h}px;" />`;
}

/** A filled map-pin dot with a number, colored like the route map pins. */
export function pinImg(size, bg, fg, label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40"><circle cx="20" cy="20" r="19" fill="${bg}"/></svg>`;
  return `<div style="display:flex;position:relative;width:${size}px;height:${size}px;flex-shrink:0;align-items:center;justify-content:center;">
    <img src="${uri(svg)}" width="${size}" height="${size}" style="position:absolute;left:0;top:0;width:${size}px;height:${size}px;" />
    ${label ? `<div style="display:flex;font-family:'JetBrains Mono';font-weight:700;font-size:${Math.round(size * 0.5)}px;color:${fg};">${label}</div>` : ''}
  </div>`;
}
