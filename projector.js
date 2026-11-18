// Page 2: projector output. Each mapping set has one homography from the
// true geometry onto the projector's pixels, defined by where that set's
// reference points A–D should appear on screen (its four draggable handles).
// A polygon is warped by the homography of the set it belongs to, so
// different sets can land on different surfaces.
//
// Drawing here goes the other way: a corner clicked on the projector is sent
// through the inverse of the active set's homography and stored in true
// geometry, so it reappears exactly where it was clicked.
//
// This tab is one projector "view" (?view=N). Each view keeps its own handles
// and its own choice of which mapping sets it shows, so several projectors
// can run side by side in separate tabs.
//
// Game mode (T): this tab keeps GAME.targets fruit flies ("targets") in the
// active mapping set's A–D area for the pointer tags to blow up. Each needs
// its beam held on it for `holdMs` by `need` pointers at once: 1, or 2 for a
// big fly. With too few, its charge drains instead. This tab watches every
// camera's pointers, so it decides when a target blows up, removes it after
// the burst and spawns a new one elsewhere. Run the game on one projector
// tab only.

(() => {
  const { state } = PM;
  const canvas = document.getElementById('canvas');
  const setsEl = document.getElementById('sets');
  const view = PM.openView('projector');

  let showGrid = true;
  let game = !!view.data().game; // see "Game" below
  let clean = false;   // true = output only: no handles, no controls
  let size = { w: 1, h: 1 };

  const quadPx = (set) => view.quad(set).map(([x, y]) => [x * size.w, y * size.h]);
  const handlesPx = (set) => (view.visible(set) ? quadPx(set) : []); // hidden sets can't be grabbed
  const homography = (set) => PM.solveHomography(set.refs, quadPx(set)); // true geometry -> pixels

  const editor = PM.createEditor({
    canvas,
    toScreen: (set, p) => PM.applyHomography(homography(set), p),
    toWorld: (set, x, y) => PM.applyHomography(PM.invertHomography(homography(set)), [x, y]),
    handlesOf: handlesPx,
    moveHandle(set, index, x, y) {
      view.quad(set)[index] = [x / size.w, y / size.h];
      view.save();
    },
    render,
    enabled: () => !clean,
    visible: view.visible,
    onRefresh: refreshSets,
  });

  function refreshSets() {
    PM.renderSetToggles(setsEl, view, {
      onToggle() { editor.refresh(); render(); },
      onActivate: (set) => editor.activate(set.id),
    });
  }

  function render() {
    const { ctx, w, h } = PM.fitCanvas(canvas);
    size = { w, h };
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const shown = view.visibleSets();
    for (const set of shown) renderSet(ctx, set, w, h);
    if (!clean) {
      editor.drawOverlay(ctx);
      // Active set last so its handles sit on top.
      const active = PM.activeSet();
      for (const set of [...shown.filter((s) => s !== active), ...shown.filter((s) => s === active)]) PM.drawQuad(ctx, quadPx(set), set);
    }
  }

  function renderSet(ctx, set, w, h) {
    // True geometry -> projector pixels, for this set
    const H = homography(set);
    const map = (p) => PM.applyHomography(H, p);

    if (H && showGrid && set === PM.activeSet()) PM.drawGrid(ctx, H, { x: 0, y: 0, w, h }, set.refs);

    if (H) {
      PM.drawPolygons(ctx, map, { fillAlpha: 0.55, setId: set.id, selectedId: clean ? null : editor.selectedId });
      if (game) drawCharges(ctx, map, set);
      PM.drawBeams(ctx, map, { setId: set.id });
      for (const d of state.detections) {
        const p = !d.aim && d.setId === set.id && map([d.x, d.y]); // a tag needs no crosshair on itself
        if (p) PM.drawDetection(ctx, ...p, d.progress);
      }
    } else if (set === PM.activeSet()) {
      PM.drawLabel(ctx, `${set.name}: reference points are degenerate — move a corner.`, w / 2, h / 2, '#ff6b6b');
    }
  }

  // ---- Game ---------------------------------------------------------------

  const GAME = {
    targets: 4,             // how many to keep on the table
    twoPlayerChance: 0.35,  // share of targets that need two pointers
    holds: [1000, 2000, 3000], // possible hold times, ms
    drainMs: 400,           // a full charge drains in this long without enough pointers
    respawnMs: 800,         // pause after a target goes before the next appears
    fly: 0.12,              // fly size, as a share of the A–D area's shorter side
    bigFly: 0.2,            // the big flies that need two players
  };
  const charges = new Map(); // target id -> 0..1
  const waiting = new Set(); // two-pointer targets with only one pointer on them
  let lastStep = 0, nextSpawnAt = 0;

  const targets = () => state.geometry.polygons.filter((p) => p.game);
  const gameSet = () => PM.sets().find((s) => s.id === view.data().gameSet) || PM.activeSet();
  const radiusOf = (pts) => { const c = PM.centroid(pts); return Math.max(...pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1]))); };

  // A fruit fly somewhere inside the set's A–D, clear of other polygons.
  // Its polygon is a round hit area a little wider than the sprite.
  function spawnTarget() {
    const set = gameSet();
    const xs = set.refs.map((p) => p[0]), ys = set.refs.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const extent = Math.min(x1 - x0, y1 - y0);
    const need = Math.random() < GAME.twoPlayerChance ? 2 : 1;
    const size = extent * (need === 2 ? GAME.bigFly : GAME.fly); // big flies need two players
    const r = size * 0.6;
    for (let attempt = 0; attempt < 40; attempt++) {
      const c = [x0 + Math.random() * (x1 - x0), y0 + Math.random() * (y1 - y0)];
      const pts = Array.from({ length: 8 }, (_, k) => {
        const a = (k / 8) * Math.PI * 2;
        return [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
      });
      if (pts.some((p) => !PM.pointInPolygon(p, set.refs))) continue;
      const clear = state.geometry.polygons.every((o) => {
        if (o.setId !== set.id || (o.game && o.explodedAt)) return true;
        const oc = PM.centroid(o.points);
        return Math.hypot(oc[0] - c[0], oc[1] - c[1]) > r * 1.3 + radiusOf(o.points) + 10;
      });
      if (!clear) continue;
      state.geometry.polygons.push({
        id: PM.uid(), name: '', setId: set.id, points: pts, game: true, need,
        holdMs: GAME.holds[Math.floor(Math.random() * GAME.holds.length)],
        color: '#c9a26b', sprite: 'fly', center: c, size, heading: Math.random() * Math.PI * 2,
      });
      return true;
    }
    return false; // no room
  }

  function gameStep(now) {
    const dt = Math.min(100, now - lastStep);
    lastStep = now;
    let changed = false;

    // Which pointers are aimed at each target, across every camera.
    const aimedBy = new Map();
    for (const d of state.detections) {
      const id = d.aim && d.aim.hit && d.aim.hit.polyId;
      if (!id) continue;
      if (!aimedBy.has(id)) aimedBy.set(id, new Set());
      aimedBy.get(id).add(`${d.view}:${d.name}`);
    }

    waiting.clear();
    for (const t of targets()) {
      if (t.explodedAt) { // gone for good once the burst has played
        if (Date.now() - t.explodedAt > PM.EXPLODE.burstMs) {
          state.geometry.polygons = state.geometry.polygons.filter((p) => p !== t);
          charges.delete(t.id);
          nextSpawnAt = now + GAME.respawnMs;
          changed = true;
        }
        continue;
      }
      const n = aimedBy.has(t.id) ? aimedBy.get(t.id).size : 0;
      let c = charges.get(t.id) || 0;
      if (n >= t.need) c += dt / t.holdMs;
      else {
        c = Math.max(0, c - dt / GAME.drainMs);
        if (n > 0) waiting.add(t.id);
      }
      if (c >= 1) {
        t.explodedAt = Date.now();
        c = 0;
        changed = true;
      }
      charges.set(t.id, c);
    }

    // Keep the table stocked, one target at a time.
    if (targets().length < GAME.targets && now >= nextSpawnAt) {
      if (spawnTarget()) changed = true;
      nextSpawnAt = now + 300;
    }
    if (changed) PM.publish('geometry');
  }

  function gameLoop(now) {
    if (!game) return;
    gameStep(now);
    render();
    requestAnimationFrame(gameLoop);
  }

  function setGame(on) {
    game = on;
    view.data().game = on;
    if (on) view.data().gameSet = PM.activeSet().id;
    view.save();
    document.getElementById('game').classList.toggle('active', on);
    if (on) {
      lastStep = performance.now();
      requestAnimationFrame(gameLoop);
    } else {
      state.geometry.polygons = state.geometry.polygons.filter((p) => !p.game);
      charges.clear();
      PM.publish('geometry');
      editor.refresh();
      render();
    }
  }

  // Charge rings, and a hint on two-pointer targets with only one pointer.
  function drawCharges(ctx, map, set) {
    for (const t of targets()) {
      if (t.setId !== set.id || t.explodedAt) continue;
      const c = map(PM.centroid(t.points));
      if (!c) continue;
      const charge = charges.get(t.id) || 0;
      if (charge > 0) {
        ctx.save();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(c[0], c[1], 26, -Math.PI / 2, -Math.PI / 2 + charge * Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      if (waiting.has(t.id)) {
        ctx.save();
        ctx.globalAlpha = 0.55 + 0.45 * Math.sin(performance.now() / 150);
        PM.drawLabel(ctx, 'Needs 2 players', c[0], c[1] + 40);
        ctx.restore();
      }
    }
  }

  // ---- Controls ---------------------------------------------------------

  const actions = {
    game() { setGame(!game); },
    fullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    },
    grid() { showGrid = !showGrid; render(); },
    reset() { view.resetQuad(PM.activeSet()); render(); },
    hide() {
      clean = !clean;
      document.body.classList.toggle('clean', clean);
      render();
    },
  };

  for (const id of Object.keys(actions)) document.getElementById(id).onclick = actions[id];

  PM.bindViewControls(view, 'Projector', document.getElementById('view'), document.getElementById('new-view'));

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input[type="text"], select')) return;
    const action = { f: 'fullscreen', g: 'grid', r: 'reset', h: 'hide', t: 'game' }[e.key.toLowerCase()];
    if (action) actions[action]();
  });

  PM.init((topic, key) => {
    editor.sync(topic);
    if (topic === 'projector' && key === view.id) editor.refresh(); // a mirroring tab changed this view
    render();
    PM.animate(render); // pulsing pointer beams and explosions
  }, view.save);
  window.addEventListener('resize', render);
  render();
  if (game) setGame(true); // carry on a game left running
})();
