/* Kit data + SVG renderer.
   All artwork here is original vector work drawn from scratch: silhouette,
   patterns and trim only. No crests, badges, sponsor marks or wordmarks are
   reproduced. Club names are used as plain colourway descriptors. */

export const KITS = [
  {
    id: 'madrid',
    club: 'Real Madrid',
    city: 'Madrid',
    line: 'Merengue',
    accent: '#C9A227',
    price: 58,
    pattern: { type: 'solid', base: '#F7F5F0' },
    trim: '#C9A227',
    collar: 'v',
    ink: '#1B1B1F',
    note: 'Bone white with a struck-gold collar line.'
  },
  {
    id: 'barcelona',
    club: 'Barcelona',
    city: 'Barcelona',
    line: 'Blaugrana',
    accent: '#A50044',
    price: 58,
    pattern: { type: 'stripes', base: '#004D98', alt: '#A50044', count: 6 },
    trim: '#EDBB00',
    collar: 'crew',
    ink: '#FDF6E3',
    note: 'Garnet and blue, cut wide and even.'
  },
  {
    id: 'bayern',
    club: 'Bayern Munich',
    city: 'Munich',
    line: 'Rekordmeister',
    accent: '#DC052D',
    price: 55,
    pattern: { type: 'tonal', base: '#C8072A', alt: '#A9041F' },
    trim: '#0B1D3A',
    collar: 'crew',
    ink: '#FFFFFF',
    note: 'Deep red with a tonal diamond ground.'
  },
  {
    id: 'psg',
    club: 'Paris Saint-Germain',
    city: 'Paris',
    line: 'Hechter',
    accent: '#DA291C',
    price: 60,
    pattern: { type: 'hechter', base: '#0B2A55', alt: '#DA291C', edge: '#F5F3EE' },
    trim: '#F5F3EE',
    collar: 'v',
    ink: '#FFFFFF',
    note: 'Navy split by the centre band.'
  },
  {
    id: 'arsenal',
    club: 'Arsenal',
    city: 'London',
    line: 'Highbury',
    accent: '#EF0107',
    price: 52,
    pattern: { type: 'sleeves', base: '#C7121A', alt: '#F4F2ED' },
    trim: '#F4F2ED',
    collar: 'crew',
    ink: '#FFFFFF',
    note: 'Red body, pale sleeves, nothing else.'
  },
  {
    id: 'liverpool',
    club: 'Liverpool',
    city: 'Liverpool',
    line: 'Anfield',
    accent: '#C8102E',
    price: 52,
    pattern: { type: 'solid', base: '#B4102A' },
    trim: '#E0C36A',
    collar: 'crew',
    ink: '#FFFFFF',
    note: 'One colour, head to hem.'
  },
  {
    id: 'city',
    club: 'Manchester City',
    city: 'Manchester',
    line: 'Maine Road',
    accent: '#6CABDD',
    price: 52,
    pattern: { type: 'solid', base: '#7FBBE8' },
    trim: '#0B1D3A',
    collar: 'v',
    ink: '#0B1D3A',
    note: 'Sky blue with a navy placket.'
  },
  {
    id: 'chelsea',
    club: 'Chelsea',
    city: 'London',
    line: 'Stamford',
    accent: '#1E5AA8',
    price: 52,
    pattern: { type: 'solid', base: '#1B4F9C' },
    trim: '#E4B93C',
    collar: 'crew',
    ink: '#FFFFFF',
    note: 'Royal blue, gold at the neck.'
  },
  {
    id: 'spurs',
    club: 'Tottenham Hotspur',
    city: 'London',
    line: 'Lilywhite',
    accent: '#132257',
    price: 50,
    pattern: { type: 'solid', base: '#F6F5F1' },
    trim: '#132257',
    collar: 'v',
    ink: '#132257',
    note: 'White on white with a navy edge.'
  },
  {
    id: 'united',
    club: 'Manchester United',
    city: 'Manchester',
    line: 'Old Trafford',
    accent: '#DA291C',
    price: 55,
    pattern: { type: 'hoops', base: '#C2241A', alt: '#9E1A12', count: 9 },
    trim: '#111114',
    collar: 'crew',
    ink: '#FFFFFF',
    note: 'Red with shadow hooping across the chest.'
  }
];

export const kitById = (id) => KITS.find((k) => k.id === id);

/* ---- geometry -------------------------------------------------------- */
/* Front-view short-sleeve silhouette on a 400x380 canvas.
   Landmarks, so the numbers below are readable:
     neck corners  (162,46) (238,46)      shoulder points (120,54) (280,54)
     cuff outer/inner  (42,128)/(91,176)  armpit (112,132)
     waist x=104      hem y=326           body spans x 108..292
   Body length : chest width lands at ~1.48, which is a football shirt's
   proportion — a tee is closer to 1.2 and reads instantly wrong. */
/* Neckline, left corner to right corner. The body path walks it in reverse to
   close the outline; the collar is the same curve stroked on top. */
const NECKLINE = {
  crew: { fwd: 'C 168 74 183 85 200 85 C 217 85 232 74 238 46',
          rev: 'C 232 74 217 85 200 85 C 183 85 168 74 162 46' },
  v:    { fwd: 'C 177 66 192 86 200 90 C 208 86 223 66 238 46',
          rev: 'C 223 66 208 86 200 90 C 192 86 177 66 162 46' }
};

const neckPath = (collar) => `M 162 46 ${NECKLINE[collar].fwd}`;

const bodyPath = (collar) =>
  'M 162 46 L 120 54 L 42 128 C 38 132 38 138 42 143 ' +
  'L 78 178 C 82 182 88 181 91 176 L 112 132 ' +
  'C 106 200 104 250 108 322 C 108 328 112 332 118 332 ' +
  'L 282 332 C 288 332 292 328 292 322 ' +
  'C 296 250 294 200 288 132 L 309 176 C 312 181 318 182 322 178 ' +
  'L 358 143 C 362 138 362 132 358 128 L 280 54 L 238 46 ' +
  NECKLINE[collar].rev + ' Z';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const key in attrs) node.setAttribute(key, attrs[key]);
  return node;
}

/* ponytail: one pattern switch, no per-club subclasses. Add a case when a
   colourway genuinely needs geometry these six cannot express.
   Rects are drawn oversized and clipped to the silhouette, so none of them
   need to know where the shirt's edges are. Body spans x 108..292. */
function patternNodes(kit) {
  const p = kit.pattern;
  const full = { x: 0, y: 0, width: 400, height: 380 };
  const nodes = [el('rect', { ...full, fill: p.base })];

  if (p.type === 'stripes') {
    const w = 400 / p.count;
    for (let i = 0; i < p.count; i += 2) {
      nodes.push(el('rect', { x: i * w, y: 0, width: w, height: 380, fill: p.alt }));
    }
  } else if (p.type === 'hoops') {
    const h = 380 / p.count;
    for (let i = 1; i < p.count; i += 2) {
      nodes.push(el('rect', { x: 0, y: i * h, width: 400, height: h, fill: p.alt }));
    }
  } else if (p.type === 'hechter') {
    nodes.push(el('rect', { x: 174, y: 0, width: 52, height: 380, fill: p.edge }));
    nodes.push(el('rect', { x: 183, y: 0, width: 34, height: 380, fill: p.alt }));
  } else if (p.type === 'sleeves') {
    // Contrast sleeves: everything outside the side seams.
    nodes.push(el('rect', { x: 0, y: 0, width: 110, height: 380, fill: p.alt }));
    nodes.push(el('rect', { x: 290, y: 0, width: 110, height: 380, fill: p.alt }));
  } else if (p.type === 'tonal') {
    nodes.push(el('rect', { ...full, fill: 'url(#kitTonal)' }));
  }
  return nodes;
}

/**
 * Render a jersey into an <svg> element.
 * @param {object} kit    entry from KITS
 * @param {object} [opts] { name, number, uid } — uid keeps defs ids unique
 * @returns {SVGSVGElement}
 */
export function renderKit(kit, opts = {}) {
  const uid = opts.uid || kit.id;
  const body = bodyPath(kit.collar);
  const printed = [opts.name, opts.number].filter(Boolean).join(' ');
  const svg = el('svg', {
    viewBox: '0 0 400 380',
    xmlns: SVG_NS,
    role: 'img',
    'aria-label': printed
      ? `${kit.club} colourway shirt printed with ${printed}`
      : `${kit.club} colourway shirt — ${kit.note}`
  });

  const defs = el('defs', {});

  const clip = el('clipPath', { id: `body-${uid}` });
  clip.appendChild(el('path', { d: body }));
  defs.appendChild(clip);

  // Soft studio lighting: bright down the centre, falling off at the seams.
  const shade = el('linearGradient', { id: `shade-${uid}`, x1: '0', y1: '0', x2: '1', y2: '0' });
  [
    ['0%', '#000', '0.30'],
    ['18%', '#000', '0.06'],
    ['42%', '#fff', '0.10'],
    ['62%', '#fff', '0.04'],
    ['86%', '#000', '0.10'],
    ['100%', '#000', '0.34']
  ].forEach(([offset, color, op]) => {
    shade.appendChild(el('stop', { offset, 'stop-color': color, 'stop-opacity': op }));
  });
  defs.appendChild(shade);

  // Fabric fall — slightly darker toward the hem.
  const drop = el('linearGradient', { id: `drop-${uid}`, x1: '0', y1: '0', x2: '0', y2: '1' });
  drop.appendChild(el('stop', { offset: '0%', 'stop-color': '#fff', 'stop-opacity': '0.08' }));
  drop.appendChild(el('stop', { offset: '55%', 'stop-color': '#000', 'stop-opacity': '0' }));
  drop.appendChild(el('stop', { offset: '100%', 'stop-color': '#000', 'stop-opacity': '0.22' }));
  defs.appendChild(drop);

  const tonal = el('pattern', {
    id: `tonal-${uid}`, width: '24', height: '24', patternUnits: 'userSpaceOnUse',
    patternTransform: 'rotate(45)'
  });
  tonal.appendChild(el('rect', { width: '12', height: '24', fill: '#000', 'fill-opacity': '0.07' }));
  defs.appendChild(tonal);

  svg.appendChild(defs);

  const shirt = el('g', { 'clip-path': `url(#body-${uid})` });
  patternNodes(kit).forEach((n) => {
    if (n.getAttribute('fill') === 'url(#kitTonal)') n.setAttribute('fill', `url(#tonal-${uid})`);
    shirt.appendChild(n);
  });

  // Number sits mid-back; the name arcs above it across the shoulders.
  if (opts.number) {
    const num = el('text', {
      x: 200, y: 262, 'text-anchor': 'middle', fill: kit.ink,
      'font-family': 'Archivo, sans-serif', 'font-size': 116,
      'font-weight': 700, 'letter-spacing': '-4'
    });
    num.textContent = opts.number;
    shirt.appendChild(num);
  }

  if (opts.name) {
    const chars = opts.name.trim().length;
    const nm = el('text', {
      x: 200, y: opts.number ? 142 : 210, 'text-anchor': 'middle', fill: kit.ink,
      'font-family': 'Archivo, sans-serif',
      'font-size': chars > 8 ? 22 : 27,
      'font-weight': 600, 'letter-spacing': chars > 8 ? '2' : '3.5'
    });
    nm.textContent = opts.name.toUpperCase();
    shirt.appendChild(nm);
  }

  /* Collar rib and cuff bands are stroked inside the clip, so the outer half
     of each stroke is cut away by the silhouette and what is left sits flush
     with the edge — the way a knitted rib actually does. They pick up the
     shading pass below for free. */
  const trim = el('g', {
    fill: 'none', stroke: kit.trim, 'stroke-linecap': 'butt'
  });
  trim.appendChild(el('path', { d: neckPath(kit.collar), 'stroke-width': 15 }));
  trim.appendChild(el('path', { d: 'M 40 141 L 80 180', 'stroke-width': 13 }));
  trim.appendChild(el('path', { d: 'M 360 141 L 320 180', 'stroke-width': 13 }));
  shirt.appendChild(trim);

  const cover = { x: 0, y: 0, width: 400, height: 380 };
  shirt.appendChild(el('rect', { ...cover, fill: `url(#shade-${uid})` }));
  shirt.appendChild(el('rect', { ...cover, fill: `url(#drop-${uid})` }));

  // Seam lines: shoulder-to-armpit joins, plus a soft fold across the body.
  const seams = el('g', { stroke: '#000', 'stroke-opacity': '0.15', 'stroke-width': '1.3', fill: 'none' });
  seams.appendChild(el('path', { d: 'M 120 54 L 112 132' }));
  seams.appendChild(el('path', { d: 'M 280 54 L 288 132' }));
  shirt.appendChild(seams);

  svg.appendChild(shirt);

  svg.appendChild(el('path', {
    d: body, fill: 'none', stroke: '#000', 'stroke-opacity': '0.3', 'stroke-width': 1.5
  }));

  return svg;
}
