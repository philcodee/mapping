// Shared state, messaging and math for the three projection-mapping pages.
// Loaded as a classic script; everything hangs off the global `PM`.
//
// A "mapping set" is one surface: four reference points A–D with three
// representations (true geometry, projector, camera) and therefore two
// homographies (true geometry -> projector, true geometry <-> camera).
// Every polygon belongs to one mapping set.
//
// The projector and camera pages are "views". Any number of each can be
// open: a view is named by the `?view=` number in its URL (default 1) and has
// its own handles and its own choice of visible sets, so two projector tabs
// with different numbers are two independent projectors. Tabs opened on the
// same view number mirror each other.
//
// Messages on the BroadcastChannel are { topic, key?, data }:
//   geometry            { polygons, sets }; editable from every page. A set's
//                       `refs` are its A–D in true-geometry units
//   active              id of the set being edited, shared by all pages
//   projector, key=view { quads: { setId: [[x,y] x4] }, hidden: { setId: true } }
//                       one projector view; quads normalised to the window
//   camera,    key=view the same for one camera view; quads normalised to the
//                       video frame
//   detections, key=tab [{ x, y, source, setId, view }] in true-geometry
//                       coordinates, from one camera tab. Pointer tags add
//                       name and aim: { heading, hit: { polyId, name, dist, pt } | null }
//   hello               a page just opened; the others re-broadcast their own state

const PM = (() => {
  const WORLD = { w: 1200, h: 800 }; // extent of the "true geometry" drawing space
  const REF_LABELS = ['A', 'B', 'C', 'D'];
  const SET_COLORS = ['#ffe14d', '#4dd8ff', '#ff8cf0', '#9dff6b', '#ffa04d', '#b8a6ff'];
  const PALETTE = ['#ff5a5f', '#ffb400', '#00c2a8', '#3d9bff', '#b56bff', '#ff7ac6', '#8bd450'];

  // Staggered starting positions so a new set's handles don't hide another's.
  const defaultRefs = (i) => {
    const o = 40 * (i % 5);
    return [[150 + o, 100 + o], [1050 - o, 100 + o], [1050 - o, 700 - o], [150 + o, 700 - o]];
  };
  const defaultQuad = (i) => {
    const a = 0.15 + 0.05 * (i % 4);
    return [[a, a], [1 - a, a], [1 - a, 1 - a], [a, 1 - a]];
  };

  const PERSISTED = ['geometry', 'active'];
  const VIEW_TOPICS = ['projector', 'camera'];
  const state = {
    geometry: {
      polygons: [], // { id, name, color, setId, points: [[x,y], ...], on?, toggledAt?, explodedAt?,
                    //   game?, need?, holdMs? (targets spawned by a projector's game mode),
                    //   sprite?: 'fly', center?, size?, heading? (drawn as a fruit fly; points = hit area) }
      sets: [],     // { id, name, color, refs: [[x,y] x4] }
    },
    active: null,
    projector: {},  // view id -> { quads, hidden }
    camera: {},     // view id -> { quads, hidden }
    detections: [], // every camera tab's detections, flattened (read-only)
  };
  const detectionsByTab = {};
  const listeners = [];
  let onHello = () => {};

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const tabId = uid();

  const read = (key) => {
    try { return JSON.parse(localStorage.getItem(key)); } catch (err) { return null; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* storage unavailable */ }
  };

  for (const topic of PERSISTED) {
    const saved = read('pm:' + topic);
    if (saved) state[topic] = saved;
  }

  // Keep the state self-consistent (and upgrade data saved before mapping
  // sets existed, when there was a single set of reference points).
  function normalise() {
    const g = state.geometry;
    if (!g.sets || !g.sets.length) {
      g.sets = [{ id: 'set1', name: 'Set 1', color: SET_COLORS[0], refs: g.refs || defaultRefs(0) }];
      delete g.refs;
    }
    const first = g.sets[0].id;
    for (const poly of g.polygons) if (!g.sets.some((s) => s.id === poly.setId)) poly.setId = first;
    if (!g.sets.some((s) => s.id === state.active)) state.active = first;
  }
  normalise();

  // Each view is saved under its own key so tabs never overwrite each other.
  for (const topic of VIEW_TOPICS) {
    const prefix = `pm:${topic}:`;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith(prefix)) state[topic][key.slice(prefix.length)] = read(key) || {};
      }
      // Upgrade data saved when there was only one projector and one camera.
      const legacy = read('pm:' + topic);
      if (legacy) {
        const quads = Array.isArray(legacy) ? { [state.geometry.sets[0].id]: legacy } : legacy;
        if (!state[topic]['1']) {
          state[topic]['1'] = { quads, hidden: {} };
          write(prefix + '1', state[topic]['1']);
        }
        localStorage.removeItem('pm:' + topic);
      }
    } catch (err) { /* storage unavailable */ }
  }

  const sets = () => state.geometry.sets;
  const activeSet = () => sets().find((s) => s.id === state.active) || sets()[0];

  function setActive(id) {
    if (state.active === id) return;
    state.active = id;
    publish('active');
  }

  function addSet() {
    const n = sets().length;
    let k = n + 1;
    while (sets().some((s) => s.name === `Set ${k}`)) k++;
    const set = { id: uid(), name: `Set ${k}`, color: SET_COLORS[n % SET_COLORS.length], refs: defaultRefs(n) };
    sets().push(set);
    return set;
  }

  const channel = new BroadcastChannel('projection-mapping');

  channel.onmessage = (e) => {
    const { topic, key, data } = e.data || {};
    if (topic === 'hello') { onHello(); return; }
    if (topic === 'detections') {
      setTabDetections(key, data);
    } else if (VIEW_TOPICS.includes(topic)) {
      state[topic][key] = data;
    } else if (PERSISTED.includes(topic)) {
      state[topic] = data;
      normalise();
    } else {
      return;
    }
    listeners.forEach((fn) => fn(topic, key));
  };

  // Call once per page. `onChange(topic, key)` runs when another tab changes
  // something; `rebroadcast` should re-publish what this page is showing, for
  // the benefit of a tab that has just opened.
  function init(onChange, rebroadcast) {
    if (onChange) listeners.push(onChange);
    if (rebroadcast) onHello = rebroadcast;
    channel.postMessage({ topic: 'hello' });
  }

  // Save and broadcast 'geometry' or 'active' after mutating PM.state.
  function publish(topic) {
    write('pm:' + topic, state[topic]);
    channel.postMessage({ topic, data: state[topic] });
  }

  // ---- Views (one projector or one camera) ---------------------------------

  // The view this page shows, from `?view=` in the URL. Its data is looked up
  // on every call because a mirroring tab may replace it at any time.
  function openView(topic) {
    const id = new URLSearchParams(location.search).get('view') || '1';
    const data = () => {
      const v = state[topic][id] || (state[topic][id] = {});
      if (!v.quads) v.quads = {};
      if (!v.hidden) v.hidden = {};
      return v;
    };
    const save = () => {
      write(`pm:${topic}:${id}`, data());
      channel.postMessage({ topic, key: id, data: data() });
    };
    const ids = () => [...new Set([...Object.keys(state[topic]), id])].sort((a, b) => a - b || a.localeCompare(b));
    const view = {
      id, topic, data, save, ids,
      // A set's four handles in this view, normalised 0..1.
      quad(set) {
        const quads = data().quads;
        return quads[set.id] || (quads[set.id] = defaultQuad(sets().indexOf(set)));
      },
      resetQuad(set) {
        data().quads[set.id] = defaultQuad(sets().indexOf(set));
        save();
      },
      visible: (set) => !data().hidden[set.id],
      setVisible(set, on) {
        if (on) delete data().hidden[set.id];
        else data().hidden[set.id] = true;
        save();
      },
      visibleSets: () => sets().filter(view.visible),
      nextId: () => String(Math.max(0, ...ids().map(Number).filter(Number.isFinite)) + 1),
    };
    save(); // so other tabs list this view
    return view;
  }

  // Checkbox list of mapping sets for a view: the checkbox shows or hides the
  // set in that view, clicking the name makes it the active set.
  function renderSetToggles(listEl, view, { onToggle, onActivate }) {
    listEl.innerHTML = '';
    for (const set of sets()) {
      const li = document.createElement('li');
      li.classList.toggle('selected', set === activeSet());
      li.title = 'Click to make this the active set';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = view.visible(set);
      box.title = 'Show in this view';
      box.onclick = (e) => e.stopPropagation();
      box.onchange = () => { view.setVisible(set, box.checked); onToggle(set); };
      const dot = document.createElement('span');
      dot.className = 'swatch';
      dot.style.cssText = `background:${set.color};border-radius:50%`;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = set.name;
      li.onclick = () => onActivate(set);
      li.append(box, dot, name);
      listEl.append(li);
    }
  }

  // "Projector 1 / Projector 2 / ..." switcher plus an "open another" button.
  function bindViewControls(view, label, select, newButton) {
    const fill = () => {
      select.innerHTML = '';
      for (const id of view.ids()) select.add(new Option(`${label} ${id}`, id));
      select.value = view.id;
    };
    fill();
    document.title = `${label} ${view.id} · Projection Mapping`;
    select.onfocus = fill;
    select.onchange = () => { location.search = '?view=' + encodeURIComponent(select.value); };
    newButton.onclick = () => window.open(`${location.pathname}?view=${view.nextId()}`, '_blank');
    return fill;
  }

  // ---- Detections ---------------------------------------------------------

  function setTabDetections(tab, list) {
    if (list && list.length) detectionsByTab[tab] = list;
    else delete detectionsByTab[tab];
    state.detections = Object.values(detectionsByTab).flat();
  }

  // Replace this tab's detections (other camera tabs keep theirs).
  function publishDetections(list) {
    setTabDetections(tabId, list);
    channel.postMessage({ topic: 'detections', key: tabId, data: list });
  }

  // ---- Homography -------------------------------------------------------

  // Solve for the 3x3 matrix H (row-major, 9 numbers) that maps each src[i]
  // to dst[i] for four point pairs. Returns null if the points are degenerate.
  function solveHomography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i];
      const [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    // Gaussian elimination with partial pivoting on the 8x9 augmented matrix.
    for (let col = 0; col < 8; col++) {
      let pivot = col;
      for (let row = col + 1; row < 8; row++) {
        if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
      }
      if (Math.abs(A[pivot][col]) < 1e-10) return null;
      [A[col], A[pivot]] = [A[pivot], A[col]];
      for (let row = 0; row < 8; row++) {
        if (row === col) continue;
        const f = A[row][col] / A[col][col];
        for (let k = col; k < 9; k++) A[row][k] -= f * A[col][k];
      }
    }
    const H = A.map((row, i) => row[8] / row[i]);
    H.push(1);
    // Keep w positive on the source points so "behind the plane" is w <= 0.
    const w = H[6] * src[0][0] + H[7] * src[0][1] + H[8];
    return w < 0 ? H.map((v) => -v) : H;
  }

  function invertHomography(H) {
    if (!H) return null;
    const [a, b, c, d, e, f, g, h, i] = H;
    const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    return [
      A, c * h - b * i, b * f - c * e,
      B, a * i - c * g, c * d - a * f,
      C, b * g - a * h, a * e - b * d,
    ].map((v) => v / det);
  }

  // Apply H to a 2D point. Returns null if the point falls on or behind the
  // horizon of the mapping (cannot be drawn).
  function applyHomography(H, [x, y]) {
    if (!H) return null;
    const w = H[6] * x + H[7] * y + H[8];
    if (w <= 1e-9) return null;
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  // ---- Geometry helpers -------------------------------------------------

  function pointInPolygon([x, y], pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function centroid(pts) {
    let x = 0, y = 0;
    for (const p of pts) { x += p[0]; y += p[1]; }
    return [x / pts.length, y / pts.length];
  }

  // Polygons of the detection's own mapping set that contain it.
  // Polygons blown up by a pointer don't count until they have come back.
  const polygonsAt = (d) => state.geometry.polygons
    .filter((poly) => poly.setId === d.setId && !isGone(poly) && pointInPolygon([d.x, d.y], poly.points));

  // ---- Explosions -------------------------------------------------------
  // A pointer held on a polygon blows it up: `explodedAt` (a Date.now() time,
  // set by the camera page and shared with the geometry) starts a burst on
  // every page, then the polygon stays away and fades back in. Display only:
  // its points never change.

  const EXPLODE = {
    dwellMs: 1000, // how long a pointer must stay on a polygon
    burstMs: 1200, // flash, shockwave and flying pieces
    goneMs: 3000,  // then nothing
    fadeMs: 800,   // then it fades back in
  };
  const EXPLODE_TOTAL = EXPLODE.burstMs + EXPLODE.goneMs + EXPLODE.fadeMs;
  const explodeAge = (poly) => (poly.explodedAt ? Date.now() - poly.explodedAt : Infinity);
  function isGone(poly) {
    const age = explodeAge(poly);
    return age >= 0 && age < EXPLODE_TOTAL;
  }

  // Small seeded random generator, so every page breaks a polygon the same way.
  function seededRandom(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return () => {
      h = (h + 0x6d2b79f5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- Fruit fly sprites --------------------------------------------------
  // Game targets are drawn as pixel-art fruit flies instead of polygons. A
  // fly's polygon is only its (invisible) hit area for pointer beams; the
  // sprite is drawn around `center` at `size` (true-geometry units across),
  // facing `heading`. Each sprite pixel is mapped as its own quad, so a fly
  // lies flat on the surface in the projector's perspective.

  // A projector can't show black, so the darkest parts are still mid-tones.
  const FLY_COLORS = {
    A: '#9a7048', // antennae
    R: '#e8262b', // eyes: big and red, the fruit fly's tell
    r: '#ff8a7a', // eye shine
    H: '#a8825c', // head
    T: '#9c7a58', // thorax: muted tan-brown, nothing yellow or striped
    t: '#7d5e42', // thorax marks
    Y: '#b39370', // abdomen
    D: '#7d5e42', // darker tip
    L: '#9a7048', // legs
    W: '#e8f6ff', // wing
    w: '#9fbccc', // wing vein
  };
  const WING_ALPHA = 0.45;
  // Two frames, head up: wings folded back over the body past the tail (at
  // rest), then swung out mid-beat.
  const FLY = [[
    '......A...A......',
    '.......A.A.......',
    '....RRRHHHRRR....',
    '....RrRHHHRrR....',
    '.....RRTTTRR.....',
    '...L..TTtTT..L...',
    '....L.TTTTT.L....',
    '...L.WWTTTWW.L...',
    '.....WWYYYWW.....',
    '....WWwYYYwWW....',
    '....WWWYYYWWW....',
    '...WWwWYYYWwWW...',
    '...WWWWYYYWWWW...',
    '...WWwWDDDWwWW...',
    '...WWWW.D.WWWW...',
    '....WWW...WWW....',
    '.....W.....W.....',
  ], [
    '......A...A......',
    '.......A.A.......',
    '....RRRHHHRRR....',
    '....RrRHHHRrR....',
    '.....RRTTTRR.....',
    'WW.L..TTtTT..L.WW',
    'WWWWL.TTTTT.LWWWW',
    '.WWwWWTTTTTWWwWW.',
    '..WWWWWYYYWWWWW..',
    '....WWwYYYwWW....',
    '.......YYY.......',
    '...L...YYY...L...',
    '.......YYY.......',
    '.......DDD.......',
    '........D........',
    '.................',
    '.................',
  ]];

  // Where a fly is right now: hovering, wobbling and flapping, the same on
  // every page because it depends only on the clock and the fly's id.
  function flyPose(poly, now) {
    const phase = seededRandom(poly.id)() * Math.PI * 2;
    const s = poly.size;
    return {
      c: [
        poly.center[0] + Math.sin(now / 170 + phase) * s * 0.05 + Math.sin(now / 53 + phase * 2) * s * 0.015,
        poly.center[1] + Math.cos(now / 190 + phase * 1.3) * s * 0.05 + Math.cos(now / 61 + phase) * s * 0.015,
      ],
      heading: poly.heading + Math.sin(now / 400 + phase) * 0.2,
      frame: Math.floor(now / 45 + phase * 3) % 2, // about 11 wing beats a second
    };
  }

  // The sprite's pixels as quads in true geometry: { pts, c, color, alpha }.
  function spritePixels(poly, pose) {
    const grid = FLY[pose.frame];
    const cols = grid[0].length, rows = grid.length;
    const px = poly.size / cols, e = px * 0.04; // a hair of overlap hides seams
    // Head is up (-y) in the grid; heading 0 means facing +x.
    const a = pose.heading + Math.PI / 2, cos = Math.cos(a), sin = Math.sin(a);
    const at = (x, y) => [pose.c[0] + x * cos - y * sin, pose.c[1] + x * sin + y * cos];
    const out = [];
    grid.forEach((line, row) => {
      for (let col = 0; col < cols; col++) {
        const ch = line[col];
        if (ch === '.') continue;
        const x0 = (col - cols / 2) * px - e, x1 = x0 + px + 2 * e;
        const y0 = (row - rows / 2) * px - e, y1 = y0 + px + 2 * e;
        out.push({
          pts: [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)],
          c: at((x0 + x1) / 2, (y0 + y1) / 2),
          color: FLY_COLORS[ch],
          alpha: ch === 'W' || ch === 'w' ? WING_ALPHA : 1,
        });
      }
    });
    return out;
  }

  function drawFly(ctx, map, poly, fade, hit) {
    const pose = flyPose(poly, Date.now());
    // One path per colour, so a fly is a dozen fills rather than hundreds.
    const groups = new Map();
    for (const p of spritePixels(poly, pose)) {
      const key = p.color + p.alpha;
      if (!groups.has(key)) groups.set(key, { color: p.color, alpha: p.alpha, quads: [] });
      groups.get(key).quads.push(p.pts);
    }
    ctx.save();
    for (const g of groups.values()) {
      ctx.beginPath();
      for (const quad of g.quads) {
        const q = quad.map(map);
        if (q.some((p) => !p)) continue;
        q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
      }
      ctx.globalAlpha = fade * g.alpha;
      ctx.fillStyle = g.color;
      ctx.fill();
    }
    if (hit) { // aimed at: a ring around it, flat on the surface
      const r = poly.size * 0.65;
      const ring = Array.from({ length: 32 }, (_, i) => {
        const a = (i / 32) * Math.PI * 2;
        return map([pose.c[0] + Math.cos(a) * r, pose.c[1] + Math.sin(a) * r]);
      });
      if (ring.every(Boolean)) {
        ctx.beginPath();
        ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.globalAlpha = fade * 0.8;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Pieces of one explosion, in true geometry. A fly bursts into its own
  // sprite pixels. A polygon has each edge cut into short segments, and each
  // slice from the centre to a segment cut again into an inner triangle and
  // an outer quad.
  const bursts = new Map();
  function burstPieces(poly) {
    const key = `${poly.id}:${poly.explodedAt}`;
    if (bursts.has(key)) return bursts.get(key);
    const rnd = seededRandom(key);
    if (poly.sprite === 'fly') {
      const pose = flyPose(poly, poly.explodedAt);
      const pieces = spritePixels(poly, pose).map((p) => {
        let angle = Math.atan2(p.c[1] - pose.c[1], p.c[0] - pose.c[0]) + (rnd() - 0.5) * 0.8;
        return {
          pts: p.pts, c: p.c, color: p.color, alpha: p.alpha,
          dir: [Math.cos(angle), Math.sin(angle)],
          speed: poly.size * (0.6 + 1.8 * rnd()),
          spin: (rnd() - 0.5) * 10,
        };
      });
      const burst = { c0: pose.c, size: poly.size * 0.6, pieces };
      bursts.set(key, burst);
      return burst;
    }
    const c0 = centroid(poly.points);
    const xs = poly.points.map((p) => p[0]), ys = poly.points.map((p) => p[1]);
    const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 || 1;
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

    const rim = [];
    const K = 4;
    poly.points.forEach((a, i) => {
      const b = poly.points[(i + 1) % poly.points.length];
      for (let k = 0; k < K; k++) rim.push(lerp(a, b, (k + (k ? rnd() * 0.6 - 0.3 : 0)) / K));
    });

    const pieces = [];
    rim.forEach((a, i) => {
      const b = rim[(i + 1) % rim.length];
      const cut = 0.35 + 0.3 * rnd();
      const ia = lerp(c0, a, cut), ib = lerp(c0, b, cut);
      for (const pts of [[c0, ia, ib], [ia, a, b, ib]]) {
        const c = centroid(pts);
        let angle = Math.atan2(c[1] - c0[1], c[0] - c0[0]);
        if (Math.hypot(c[0] - c0[0], c[1] - c0[1]) < 1e-6) angle = rnd() * Math.PI * 2;
        angle += (rnd() - 0.5) * 0.6;
        pieces.push({
          pts, c,
          dir: [Math.cos(angle), Math.sin(angle)],
          speed: size * (0.8 + 1.4 * rnd()), // how far it flies
          spin: (rnd() - 0.5) * 8,           // radians over the burst
        });
      }
    });

    const burst = { c0, size, pieces };
    bursts.set(key, burst);
    if (bursts.size > 50) bursts.delete(bursts.keys().next().value);
    return burst;
  }

  // One frame of a polygon's burst; `t` runs 0..1.
  function drawBurst(ctx, map, poly, t) {
    const { c0, size, pieces } = burstPieces(poly);
    const path = (pts) => {
      const px = pts.map(map);
      if (px.some((p) => !p)) return false;
      ctx.beginPath();
      px.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      return true;
    };
    ctx.save();

    // Flash of the whole shape (a fly's round hit area).
    if (t < 0.25 && path(poly.points)) {
      ctx.globalAlpha = 0.9 * (1 - t / 0.25);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }

    // Shockwave: a circle in true geometry, so it lies flat on the surface.
    const r = size * (0.3 + 1.7 * t);
    const circle = Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * Math.PI * 2;
      return [c0[0] + Math.cos(a) * r, c0[1] + Math.sin(a) * r];
    });
    if (path(circle)) {
      ctx.globalAlpha = 0.8 * (1 - t);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // Pieces flying out, turning and shrinking as they fade.
    const ease = 1 - Math.pow(1 - t, 3);
    const scale = 1 - 0.6 * t;
    for (const piece of pieces) {
      const a = piece.spin * ease, cos = Math.cos(a), sin = Math.sin(a);
      const ox = piece.c[0] + piece.dir[0] * piece.speed * ease;
      const oy = piece.c[1] + piece.dir[1] * piece.speed * ease;
      const moved = piece.pts.map(([x, y]) => {
        const dx = (x - piece.c[0]) * scale, dy = (y - piece.c[1]) * scale;
        return [ox + dx * cos - dy * sin, oy + dx * sin + dy * cos];
      });
      if (!path(moved)) continue;
      ctx.globalAlpha = (piece.alpha ?? 1) * (1 - t * t);
      ctx.fillStyle = piece.color || poly.color;
      ctx.fill();
      if (piece.color) continue; // sprite pixels stay crisp, without outlines
      ctx.globalAlpha = 0.6 * (1 - t);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Ids of polygons containing at least one current detection. A pointer tag
  // highlights the polygon it is aimed at rather than the one it sits in.
  function hitIds() {
    const ids = new Set();
    for (const d of state.detections) {
      if (d.aim) { if (d.aim.hit) ids.add(d.aim.hit.polyId); } else polygonsAt(d).forEach((poly) => ids.add(poly.id));
    }
    return ids;
  }

  // ---- Pointer tags -----------------------------------------------------
  // A pointer tag casts a narrow beam from its top edge; the beam stops at the
  // first polygon edge it meets. Ported from prototype/pointer.js, with this
  // app's polygons as the targets. Distances are in true-geometry units.

  const BEAM = {
    beamDeg: 2,      // half-angle of the beam
    rays: 9,
    nearDist: 10,    // pulse fastest at this distance or closer
    farDist: 500,    // pulse slowest at this distance or further
    fastMs: 125,     // 8 pulses a second
    slowMs: 1000,    // 1 pulse a second
  };

  // Distance along the ray (o + t·d, |d| = 1) to the first edge of `poly`, or Infinity.
  function rayToEdge(o, d, poly) {
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[j], [bx, by] = poly[i];
      const ex = bx - ax, ey = by - ay;
      const den = d[0] * ey - d[1] * ex;
      if (Math.abs(den) < 1e-9) continue; // parallel
      const qx = ax - o[0], qy = ay - o[1];
      const t = (qx * ey - qy * ex) / den, u = (qx * d[1] - qy * d[0]) / den;
      if (t > 1e-6 && u >= 0 && u <= 1 && t < best) best = t;
    }
    return best;
  }

  // The nearest polygon edge in the beam from `origin` along `heading`
  // (radians, true-geometry axes). From outside a polygon the beam enters it;
  // from inside it hits that polygon's own edge. Where two polygons share an
  // edge, entering the neighbour wins. `selfR` is the tag's half-size, so the
  // distance is measured from its front edge.
  // Returns { polyId, name, inside, dist, pt } or null.
  function castBeam(origin, heading, polygons, selfR = 0) {
    const half = (BEAM.beamDeg * Math.PI) / 180;
    const inside = polygons.map((p) => pointInPolygon(origin, p.points));
    let best = null;
    for (let i = 0; i < BEAM.rays; i++) {
      const a = heading - half + (2 * half * i) / (BEAM.rays - 1);
      const d = [Math.cos(a), Math.sin(a)];
      const off = Math.abs(a - heading);
      polygons.forEach((poly, k) => {
        const t = rayToEdge(origin, d, poly.points);
        if (t === Infinity) return;
        const rank = inside[k] ? 1 : 0;
        const better = !best || t < best.t - 0.5 ||
          (Math.abs(t - best.t) <= 0.5 && (rank < best.rank || (rank === best.rank && off < best.off)));
        if (better) best = { poly, inside: inside[k], t, a, rank, off };
      });
    }
    if (!best) return null;
    const name = best.poly.name || '(unnamed)';
    return {
      polyId: best.poly.id,
      name: best.inside ? `the edge of ${name}` : name,
      inside: best.inside,
      dist: Math.max(0, best.t - selfR),
      pt: [origin[0] + Math.cos(best.a) * best.t, origin[1] + Math.sin(best.a) * best.t],
    };
  }

  // Pulse period for a target `dist` away: faster the closer it is.
  function beamPeriodMs(dist) {
    const f = Math.min(1, Math.max(0, (dist - BEAM.nearDist) / (BEAM.farDist - BEAM.nearDist)));
    return BEAM.fastMs + (BEAM.slowMs - BEAM.fastMs) * f;
  }

  // Draw every pointer tag's beam through `map` (true geometry -> canvas
  // pixels). A beam that hits something pulses, faster the closer the target;
  // one that hits nothing is drawn dashed and steady.
  function drawBeams(ctx, map, { setId = null } = {}) {
    const now = performance.now();
    for (const d of state.detections) {
      if (!d.aim || (setId && d.setId !== setId)) continue;
      const { heading, hit } = d.aim;
      const from = map([d.x, d.y]);
      const to = map(hit ? hit.pt : [d.x + Math.cos(heading) * 300, d.y + Math.sin(heading) * 300]);
      if (!from || !to) continue;
      const phase = hit ? (now % beamPeriodMs(hit.dist)) / beamPeriodMs(hit.dist) : 0;
      const pulse = hit ? Math.exp(-phase * 5) : 0; // sharp flash, then fade
      ctx.save();
      ctx.strokeStyle = ctx.fillStyle = '#ffd23f';
      ctx.lineCap = 'round';
      ctx.globalAlpha = hit ? 0.4 + 0.6 * pulse : 0.5;
      ctx.lineWidth = hit ? 3 + 3 * pulse : 2;
      ctx.setLineDash(hit ? [] : [8, 8]);
      ctx.beginPath();
      ctx.moveTo(...from);
      ctx.lineTo(...to);
      ctx.stroke();
      ctx.setLineDash([]);
      if (hit) {
        ctx.beginPath();
        ctx.arc(...to, 6, 0, Math.PI * 2);
        ctx.fill();
        if (d.aim.charge > 0) { // filling up towards blowing the target up
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(...to, 18, -Math.PI / 2, -Math.PI / 2 + d.aim.charge * Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = '#ffd23f';
        }
        ctx.globalAlpha = 1 - phase; // a ring spreading out from the hit point
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(...to, 6 + 22 * phase, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Pages that only redraw when something changes need redrawing every frame
  // while a beam is pulsing, a polygon is exploding or a fly is buzzing.
  // Call after each update.
  let animating = false;
  const moving = () => state.detections.some((d) => d.aim)
    || state.geometry.polygons.some((p) => isGone(p) || p.sprite);
  function animate(render) {
    if (animating || !moving()) return;
    animating = true;
    const step = () => {
      render();
      if (moving()) requestAnimationFrame(step);
      else { animating = false; render(); } // one last frame with everything settled
    };
    requestAnimationFrame(step);
  }

  // One line of text per detection, for the sidebars.
  function describeDetections() {
    if (!state.detections.length) return '—';
    return state.detections.map((d) => {
      const set = sets().find((s) => s.id === d.setId);
      if (d.aim) {
        const { hit } = d.aim;
        return `cam ${d.view} ${d.name} · ${set ? set.name : '?'}: `
          + (hit ? `aimed at ${hit.name}, ${Math.round(hit.dist)} away` : 'aimed at nothing');
      }
      const inside = polygonsAt(d).map((p) => p.name || '(unnamed)');
      return `cam ${d.view} ${d.source} · ${set ? set.name : '?'}: (${Math.round(d.x)}, ${Math.round(d.y)})`
        + (inside.length ? `\n  in ${inside.join(', ')}` : '');
    }).join('\n');
  }

  // Find a handle under (x, y) across all sets, preferring the active set.
  // `pointsOf(set)` returns that set's four handles in canvas pixels.
  function pickHandle(pointsOf, x, y, radius = 14) {
    const order = [activeSet(), ...sets().filter((s) => s !== activeSet())];
    for (const set of order) {
      const index = pick(pointsOf(set), x, y, radius);
      if (index >= 0) return { set, index };
    }
    return null;
  }

  // Index of the first point within `radius` of (x, y), or -1.
  function pick(points, x, y, radius = 12) {
    for (let i = 0; i < points.length; i++) {
      if (points[i] && Math.hypot(points[i][0] - x, points[i][1] - y) <= radius) return i;
    }
    return -1;
  }

  // ---- Canvas helpers ---------------------------------------------------

  // Match the canvas backing store to its CSS size; returns CSS-pixel size.
  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  // Draw polygons through `map` (true geometry -> canvas pixels). Pass
  // `setId` to draw only one mapping set's polygons.
  // Straight lines stay straight under a homography, so mapping the vertices
  // is an exact warp of the shape.
  function drawPolygons(ctx, map, opts = {}) {
    const { fillAlpha = 0.35, selectedId = null, labels = true, setId = null } = opts;
    const hits = hitIds();
    for (const poly of state.geometry.polygons) {
      if (setId && poly.setId !== setId) continue;

      // Blown up by a pointer: burst, then away, then fading back in.
      const age = explodeAge(poly);
      if (age >= 0 && age < EXPLODE.burstMs) { drawBurst(ctx, map, poly, age / EXPLODE.burstMs); continue; }
      if (age >= 0 && age < EXPLODE.burstMs + EXPLODE.goneMs) continue;
      const fade = age >= 0 ? Math.min(1, (age - EXPLODE.burstMs - EXPLODE.goneMs) / EXPLODE.fadeMs) : 1;
      if (poly.sprite === 'fly') { drawFly(ctx, map, poly, fade, hits.has(poly.id)); continue; }

      const pts = poly.points.map(map);
      if (pts.some((p) => !p)) continue;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      // A polygon switched on (by a fingertip) is drawn solid; one with a
      // detection inside it is brightened and outlined in white.
      const hit = hits.has(poly.id);
      ctx.globalAlpha = fade * (poly.on ? 1 : hit ? Math.min(1, fillAlpha + 0.25) : fillAlpha);
      ctx.fillStyle = poly.color;
      ctx.fill();
      ctx.globalAlpha = fade;
      ctx.lineWidth = poly.id === selectedId || hit ? 4 : 2;
      ctx.strokeStyle = hit ? '#fff' : poly.color;
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (labels && poly.name && fade === 1) {
        const c = map(centroid(poly.points));
        if (c) drawLabel(ctx, poly.name, c[0], c[1]);
      }
    }
  }

  // Draw the true-geometry grid through homography H (true geometry -> canvas
  // pixels) as an unbounded plane: lines are generated for whatever part of
  // the plane is visible inside `rect` {x, y, w, h}, wherever the mapping set
  // sits in the true geometry. `refs` are the set's reference points.
  function drawGrid(ctx, H, rect, refs, spacing = 100) {
    const inverse = invertHomography(H);
    if (!inverse) return;

    // Never generate lines further than this from the reference points, so
    // a view that looks towards the plane's horizon stays cheap to draw.
    const xs = refs.map((p) => p[0]), ys = refs.map((p) => p[1]);
    const reach = 10 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), spacing);
    let x0 = Math.min(...xs) - reach, x1 = Math.max(...xs) + reach;
    let y0 = Math.min(...ys) - reach, y1 = Math.max(...ys) + reach;

    // The part of the plane seen through `rect`. If a corner looks past the
    // horizon the visible part is unbounded, and the limit above applies.
    const corners = [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x + rect.w, rect.y + rect.h], [rect.x, rect.y + rect.h]]
      .map((p) => applyHomography(inverse, p));
    if (corners.every(Boolean)) {
      x0 = Math.max(x0, Math.min(...corners.map((p) => p[0])));
      x1 = Math.min(x1, Math.max(...corners.map((p) => p[0])));
      y0 = Math.max(y0, Math.min(...corners.map((p) => p[1])));
      y1 = Math.min(y1, Math.max(...corners.map((p) => p[1])));
    }
    if (x0 >= x1 || y0 >= y1) return;

    let step = spacing;
    while ((x1 - x0) / step > 300 || (y1 - y0) / step > 300) step *= 2;

    // Clip each line to the visible side of the horizon (w > 0) before
    // projecting it; the canvas clips the rest.
    const w = ([x, y]) => H[6] * x + H[7] * y + H[8];
    const near = 0.02 * Math.abs(w(refs[0]));
    const project = ([x, y]) => {
      const k = w([x, y]);
      return [(H[0] * x + H[1] * y + H[2]) / k, (H[3] * x + H[4] * y + H[5]) / k];
    };
    const line = (a, b) => {
      const wa = w(a), wb = w(b);
      if (wa < near && wb < near) return;
      const cut = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (wa < near) a = cut((near - wa) / (wb - wa));
      else if (wb < near) b = cut((near - wa) / (wb - wa));
      ctx.moveTo(...project(a));
      ctx.lineTo(...project(b));
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.beginPath();
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) line([x, y0], [x, y1]);
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) line([x0, y], [x1, y]);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  function drawLabel(ctx, text, x, y, color = '#fff', align = 'center') {
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  // A draggable/reference marker: ring with a centre dot and a letter.
  function drawHandle(ctx, x, y, label, color = '#ffe14d') {
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    drawLabel(ctx, label, x + 12, y - 15, color, 'left');
  }

  // A mapping set's four handles joined by a dashed outline. Inactive sets
  // are dimmed; handle A also carries the set's name.
  function drawQuad(ctx, pts, set) {
    ctx.save();
    ctx.globalAlpha = set === activeSet() ? 1 : 0.4;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = set.color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    pts.forEach(([x, y], i) => drawHandle(ctx, x, y, i ? REF_LABELS[i] : `A · ${set.name}`, set.color));
    ctx.restore();
  }

  // Fill a <select> with the mapping sets and keep it on `value`.
  function fillSetSelect(select, value) {
    select.innerHTML = '';
    for (const set of sets()) select.add(new Option(set.name, set.id));
    select.value = value;
  }

  // Crosshair for a detected point.
  // `progress` (0..1, optional) draws a ring filling up towards a touch toggle.
  function drawDetection(ctx, x, y, progress = 0) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.moveTo(x - 22, y); ctx.lineTo(x - 6, y);
    ctx.moveTo(x + 6, y); ctx.lineTo(x + 22, y);
    ctx.moveTo(x, y - 22); ctx.lineTo(x, y - 6);
    ctx.moveTo(x, y + 6); ctx.lineTo(x, y + 22);
    ctx.stroke();
    if (progress > 0) {
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(x, y, 28, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();
    }
  }

  return {
    WORLD, REF_LABELS, PALETTE, state,
    init, publish, uid, defaultRefs,
    sets, activeSet, setActive, addSet,
    openView, renderSetToggles, bindViewControls, publishDetections,
    polygonsAt, describeDetections, pickHandle, drawQuad, drawGrid, fillSetSelect,
    solveHomography, invertHomography, applyHomography,
    pointInPolygon, centroid, hitIds, pick, castBeam, EXPLODE, isGone,
    fitCanvas, drawPolygons, drawLabel, drawHandle, drawDetection, drawBeams, animate,
  };
})();
