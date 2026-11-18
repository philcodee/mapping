// Page 3: webcam. Each mapping set has a homography relating the camera image
// to the true geometry, defined by where that set's reference points A–D are
// seen in the camera image (its four draggable handles).
//
//   true geometry -> camera : draws each set's polygons over the video
//   camera -> true geometry : maps detected points back, and broadcasts them
//
// A detected camera point is tried against every set. It is attributed to the
// sets where it lands inside one of that set's polygons; failing that, to the
// sets whose A–D outline contains it; failing that, to the active set.
//
// Drawing here uses the same inverse: a corner clicked on the video is mapped
// through the active set's camera -> true geometry homography before it is
// stored, so polygons can be traced over what the camera sees.
//
// This tab is one camera "view" (?view=N). Each view keeps its own handles,
// its own choice of visible mapping sets and its own webcam, and publishes
// its detections separately, so several cameras can run in separate tabs.
// Hidden sets are neither drawn nor used for detection.
//
// Pointer tags (ArUco DICT_4X4_50, ids in POINTER_TAGS, as printed by
// prototype/tools/make_pointer_tags.py) are found by aruco.worker.js. Each
// tag's centre and the middle of its printed top edge are mapped into the
// true geometry; the line between them is its heading, and PM.castBeam finds
// the polygon it is aimed at. These run alongside whichever detection mode
// is picked.
//
// Hand mode tracks index fingertips with MediaPipe's hand landmarker, loaded
// on demand from a CDN. A fingertip that stays inside a polygon for DWELL_MS
// flips that polygon's `on` state (saved with the geometry, so every page
// shows it); it has to leave the polygon before it can flip it again.
//
// Camera coordinates are normalised (0..1) to the video frame so they do not
// depend on how large the video is drawn. If the view is set to rotate 180°
// (an upside-down camera), they refer to the frame as displayed, the right way
// up; only drawing the video and reading its pixels see the raw orientation.

(() => {
  const { state } = PM;
  const canvas = document.getElementById('canvas');
  const video = document.getElementById('video');
  const startBtn = document.getElementById('start');
  const statusEl = document.getElementById('status');
  const modeEl = document.getElementById('mode');
  const sensitivityEl = document.getElementById('sensitivity');
  const readoutEl = document.getElementById('readout');
  const setsEl = document.getElementById('sets');
  const deviceEl = document.getElementById('device');
  const gridEl = document.getElementById('grid');
  const rotateEl = document.getElementById('rotate');
  const tagsEl = document.getElementById('tags');
  const view = PM.openView('camera');

  // Small offscreen copy of each frame for the pixel-based detectors.
  const probe = document.createElement('canvas');
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });
  const PROBE_W = 160;

  let stream = null;
  let frame = { x: 0, y: 0, w: 1, h: 1 }; // where the video is drawn on the canvas
  let pointer = null;      // hovered point, normalised to the video frame
  let prevLuma = null;     // earlier frame, for motion detection
  let prevTime = 0;
  let lastSent = '[]';
  let mine = [];           // this tab's current detections

  const toPx = ([x, y]) => [frame.x + x * frame.w, frame.y + y * frame.h];
  const toNorm = (x, y) => [(x - frame.x) / frame.w, (y - frame.y) / frame.h];
  const handlesPx = (set) => (view.visible(set) ? view.quad(set).map(toPx) : []); // hidden sets can't be grabbed
  const homography = (set) => PM.solveHomography(set.refs, view.quad(set)); // true geometry -> video frame

  const editor = PM.createEditor({
    canvas,
    toScreen(set, p) {
      const c = PM.applyHomography(homography(set), p);
      return c && toPx(c);
    },
    toWorld: (set, x, y) => PM.applyHomography(PM.invertHomography(homography(set)), toNorm(x, y)),
    handlesOf: handlesPx,
    moveHandle(set, index, x, y) {
      view.quad(set)[index] = toNorm(x, y).map((v) => Math.max(0, Math.min(1, v)));
      view.save();
    },
    visible: view.visible,
    onRefresh: refreshSets,
  });

  function refreshSets() {
    PM.renderSetToggles(setsEl, view, {
      onToggle: () => editor.refresh(),
      onActivate: (set) => editor.activate(set.id),
    });
  }
  const live = () => stream && video.videoWidth > 0;
  const rotated = () => !!view.data().rotate;

  // ---- Webcam -----------------------------------------------------------

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          ...(view.data().device ? { deviceId: { exact: view.data().device } } : { facingMode: 'environment' }),
        },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      await listDevices(); // labels are only available once permission is granted
      startBtn.textContent = 'Stop webcam';
      statusEl.textContent = '';
    } catch (err) {
      stream = null;
      statusEl.textContent = navigator.mediaDevices
        ? `Could not start the webcam: ${err.message}`
        : 'Webcam access needs a secure page — serve this folder from http://localhost.';
    }
  }

  function stop() {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    prevLuma = null;
    startBtn.textContent = 'Start webcam';
  }

  // Each camera view remembers which webcam it uses.
  async function listDevices() {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    deviceEl.innerHTML = '';
    deviceEl.add(new Option('Default webcam', ''));
    cams.forEach((d, i) => deviceEl.add(new Option(d.label || `Webcam ${i + 1}`, d.deviceId)));
    deviceEl.value = view.data().device || '';
  }

  deviceEl.onchange = async () => {
    view.data().device = deviceEl.value;
    view.save();
    if (stream) { stop(); await start(); }
  };

  gridEl.checked = view.data().grid !== false;
  gridEl.onchange = () => {
    view.data().grid = gridEl.checked;
    view.save();
  };

  // Turning the image also turns every set's handles, so they stay on the
  // same physical points and the existing calibration keeps working.
  rotateEl.checked = rotated();
  rotateEl.onchange = () => {
    const data = view.data();
    data.rotate = rotateEl.checked;
    for (const quad of Object.values(data.quads)) {
      quad.forEach((p, i) => { quad[i] = [1 - p[0], 1 - p[1]]; });
    }
    view.save();
    editor.refresh();
  };

  startBtn.onclick =() => (stream ? stop() : start());
  document.getElementById('reset').onclick = () => view.resetQuad(PM.activeSet());
  PM.bindViewControls(view, 'Camera', document.getElementById('view'), document.getElementById('new-view'));
  modeEl.onchange = () => {
    prevLuma = null;
    handPoints = [];
    if (modeEl.value === 'hand') loadHands();
  };

  // ---- Detection --------------------------------------------------------

  // Returns the detected points normalised to the displayed video frame.
  function detect() {
    const mode = modeEl.value;
    if (mode === 'none' || !live()) return [];
    const raw = mode === 'hand' ? detectHands() : [detectPixels(mode)].filter(Boolean);
    return raw.map(([x, y]) => (rotated() ? [1 - x, 1 - y] : [x, y]));
  }

  // The current frame, shrunk to PROBE_W wide, as luma values (raw frame).
  function readLuma() {
    const pw = PROBE_W, ph = Math.max(1, Math.round((PROBE_W * video.videoHeight) / video.videoWidth));
    if (probe.width !== pw || probe.height !== ph) { probe.width = pw; probe.height = ph; prevLuma = null; }
    probeCtx.drawImage(video, 0, 0, pw, ph);
    const rgba = probeCtx.getImageData(0, 0, pw, ph).data;
    const luma = new Uint8Array(pw * ph);
    for (let i = 0; i < luma.length; i++) {
      luma[i] = (rgba[i * 4] * 3 + rgba[i * 4 + 1] * 6 + rgba[i * 4 + 2]) / 10;
    }
    return { luma, pw, ph };
  }

  // ---- Pointer tags -------------------------------------------------------

  const POINTER_TAGS = { 40: 'Pointer 1', 41: 'Pointer 2' };
  const TAG_GRACE_MS = 400; // keep a beam through a briefly missed detection
  const TAG_SMOOTHING = 0.35;
  const tagGrab = document.createElement('canvas');
  const tagGrabCtx = tagGrab.getContext('2d', { willReadFrequently: true });
  let tagWorker = null;
  let tagBusy = false;
  const tags = new Map(); // id -> { c, top, at }: centre and top-edge midpoint, displayed frame

  tagsEl.checked = !!view.data().tags;
  tagsEl.onchange = () => {
    view.data().tags = tagsEl.checked;
    view.save();
    if (!tagsEl.checked) tags.clear();
  };

  // Send the current frame to the detector, unless it is still busy.
  function sendTagFrame() {
    if (!tagsEl.checked || !live() || tagBusy) return;
    if (!tagWorker) {
      tagWorker = new Worker('aruco.worker.js');
      tagWorker.onmessage = ({ data }) => onTags(data);
      tagWorker.onerror = (e) => { statusEl.textContent = `Tag detector failed: ${e.message}`; tagBusy = false; };
    }
    const w = video.videoWidth, h = video.videoHeight;
    if (tagGrab.width !== w || tagGrab.height !== h) { tagGrab.width = w; tagGrab.height = h; }
    tagGrabCtx.drawImage(video, 0, 0, w, h);
    const img = tagGrabCtx.getImageData(0, 0, w, h);
    tagBusy = true;
    tagWorker.postMessage({ w, h, buffer: img.data.buffer }, [img.data.buffer]);
  }

  function onTags({ markers }) {
    tagBusy = false;
    if (!tagsEl.checked) return;
    const w = tagGrab.width, h = tagGrab.height, now = Date.now();
    const norm = ([x, y]) => (rotated() ? [1 - x / w, 1 - y / h] : [x / w, y / h]);
    for (const m of markers) {
      if (!POINTER_TAGS[m.id]) continue;
      const k = m.corners.map(norm);
      const c = [(k[0][0] + k[1][0] + k[2][0] + k[3][0]) / 4, (k[0][1] + k[1][1] + k[2][1] + k[3][1]) / 4];
      const top = [(k[0][0] + k[1][0]) / 2, (k[0][1] + k[1][1]) / 2]; // corners 0 -> 1 are the printed top edge
      const old = tags.get(m.id);
      const ease = (a, b) => [a[0] + (b[0] - a[0]) * TAG_SMOOTHING, a[1] + (b[1] - a[1]) * TAG_SMOOTHING];
      tags.set(m.id, old && now - old.at < 1000 ? { c: ease(old.c, c), top: ease(old.top, top), at: now } : { c, top, at: now });
    }
  }

  // Holding a beam on one polygon for PM.EXPLODE.dwellMs blows it up. The
  // beam must leave that polygon before it can blow it up again.
  const aimHold = new Map(); // tag id -> { polyId, since, done }

  function holdAim(id, hit, now) {
    let hold = aimHold.get(id);
    // While its target is blown up, the beam passes through; don't let that
    // count as leaving, or it would blow up again the moment it returns.
    const target = hold && state.geometry.polygons.find((p) => p.id === hold.polyId);
    if (hold && hold.done && target && PM.isGone(target)) return 0;
    // Game targets are blown up by the projector running the game, which
    // can count every player's pointer at once.
    const aimed = hit && state.geometry.polygons.find((p) => p.id === hit.polyId);
    if (!hit || (aimed && aimed.game)) { aimHold.delete(id); return 0; }
    if (!hold || hold.polyId !== hit.polyId) aimHold.set(id, (hold = { polyId: hit.polyId, since: now, done: false }));
    if (hold.done) return 0;
    const charge = Math.min(1, (now - hold.since) / PM.EXPLODE.dwellMs);
    if (charge < 1) return charge;
    hold.done = true;
    const poly = state.geometry.polygons.find((p) => p.id === hit.polyId);
    if (poly && !PM.isGone(poly)) {
      poly.explodedAt = now;
      PM.publish('geometry');
    }
    return 0;
  }

  // One detection per tag seen recently, with the beam it casts.
  function tagDetections(maps) {
    const now = Date.now(), out = [];
    const round = (v, step) => Math.round(v / step) * step; // fewer broadcasts for sub-pixel jitter
    for (const id of aimHold.keys()) if (!tags.has(id)) aimHold.delete(id);
    for (const [id, t] of tags) {
      if (now - t.at > TAG_GRACE_MS) { tags.delete(id); continue; }
      // The set whose camera outline holds the tag, else the active set.
      const m = maps.find((s) => s.camToWorld && PM.pointInPolygon(t.c, s.quad))
        || maps.find((s) => s.camToWorld && s.set === PM.activeSet());
      if (!m) continue;
      const c = PM.applyHomography(m.camToWorld, t.c), top = PM.applyHomography(m.camToWorld, t.top);
      if (!c || !top) continue;
      const heading = Math.atan2(top[1] - c[1], top[0] - c[0]);
      const polygons = state.geometry.polygons.filter((p) => p.setId === m.set.id && !PM.isGone(p));
      const hit = PM.castBeam(c, heading, polygons, Math.hypot(top[0] - c[0], top[1] - c[1]));
      const charge = holdAim(id, hit, now);
      out.push({
        x: round(c[0], 0.5), y: round(c[1], 0.5), source: 'tag', name: POINTER_TAGS[id], setId: m.set.id, view: view.id,
        aim: {
          heading: round(heading, 0.005),
          charge: round(charge, 0.05),
          hit: hit && { polyId: hit.polyId, name: hit.name, dist: round(hit.dist, 0.5), pt: hit.pt.map((v) => round(v, 0.5)) },
        },
      });
    }
    return out;
  }

  // ---- Hand tracking ------------------------------------------------------

  const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
  const INDEX_TIP = 8; // landmark number of the index fingertip
  let hands = null;    // the HandLandmarker, once loaded
  let handsLoading = null;
  let handPoints = []; // fingertips in the latest processed frame (raw frame)
  let lastVideoTime = -1;

  function loadHands() {
    if (hands || handsLoading) return;
    statusEl.textContent = 'Loading hand tracking…';
    handsLoading = (async () => {
      const { FilesetResolver, HandLandmarker } = await import(`${MP_BASE}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      const create = (delegate) => HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate },
        runningMode: 'VIDEO',
        numHands: 4,
      });
      hands = await create('GPU').catch(() => create('CPU'));
      statusEl.textContent = '';
    })().catch((err) => {
      statusEl.textContent = `Could not load hand tracking: ${err.message}`;
      handsLoading = null; // picking Hand again retries
    });
  }

  function detectHands() {
    if (!hands) return [];
    if (video.currentTime !== lastVideoTime) { // only new frames
      lastVideoTime = video.currentTime;
      const result = hands.detectForVideo(video, performance.now());
      handPoints = result.landmarks.map((lm) => [lm[INDEX_TIP].x, lm[INDEX_TIP].y]);
    }
    return handPoints;
  }

  // ---- Touch to toggle ----------------------------------------------------

  const DWELL_MS = 600;     // how long a fingertip must rest on a polygon
  const GRACE_MS = 250;     // tolerate the tracker losing the finger briefly
  const COOLDOWN_MS = 1000; // don't flip back a polygon another camera just flipped
  const dwell = new Map();  // polygon id -> { since, seen, done }

  // `found` entries carry the detections made from them in `ds`. Flips the
  // polygons fingertips have rested on and records each one's progress.
  function touchToggle(found) {
    const now = Date.now();
    const touching = new Map();
    for (const f of found) {
      if (f.source !== 'hand') continue;
      for (const d of f.ds) for (const poly of PM.polygonsAt(d)) touching.set(poly.id, poly);
    }

    let changed = false;
    for (const [id, poly] of touching) {
      let t = dwell.get(id);
      if (!t) dwell.set(id, (t = { since: now, done: false }));
      t.seen = now;
      if (!t.done && now - t.since >= DWELL_MS) {
        t.done = true;
        if (!(now - (poly.toggledAt || 0) < COOLDOWN_MS)) {
          poly.on = !poly.on;
          poly.toggledAt = now;
          changed = true;
        }
      }
    }
    for (const [id, t] of dwell) if (now - t.seen > GRACE_MS) dwell.delete(id);
    if (changed) PM.publish('geometry');

    // 0..1 towards the next flip, shown as a ring around the fingertip.
    for (const f of found) {
      if (f.source !== 'hand') continue;
      for (const d of f.ds) {
        const p = Math.max(0, ...PM.polygonsAt(d).map((poly) => {
          const t = dwell.get(poly.id);
          return t && !t.done ? Math.min(1, (now - t.since) / DWELL_MS) : 0;
        }));
        if (p > 0) d.progress = Math.round(p * 20) / 20;
        f.progress = Math.max(f.progress || 0, d.progress || 0);
      }
    }
  }

  // ---- Pixel detectors ----------------------------------------------------

  // Returns one point normalised to the raw video frame, or null.
  function detectPixels(mode) {
    const { luma, pw, ph } = readLuma();
    const sensitivity = sensitivityEl.value / 100; // 0..1
    let sx = 0, sy = 0, n = 0;
    const add = (i) => { sx += i % pw; sy += Math.floor(i / pw); n++; };

    if (mode === 'bright') {
      // Centroid of the pixels close to the brightest value, if bright enough.
      const floor = 250 - sensitivity * 120;
      let max = 0;
      for (let i = 0; i < luma.length; i++) if (luma[i] > max) max = luma[i];
      if (max >= floor) for (let i = 0; i < luma.length; i++) if (luma[i] >= max - 8) add(i);
    } else {
      // Centroid of the pixels that changed since a frame ~100 ms ago.
      const threshold = 90 - sensitivity * 75;
      if (prevLuma) for (let i = 0; i < luma.length; i++) if (Math.abs(luma[i] - prevLuma[i]) > threshold) add(i);
      if (!prevLuma || performance.now() - prevTime > 100) { prevLuma = luma; prevTime = performance.now(); }
      if (n < 12) n = 0; // ignore sensor noise
    }
    return n ? [(sx / n + 0.5) / pw, (sy / n + 0.5) / ph] : null;
  }

  // ---- Frame loop -------------------------------------------------------

  function tick() {
    const { ctx, w, h } = PM.fitCanvas(canvas);

    // Letterbox the video (or a 16:9 placeholder) into the canvas.
    const aspect = live() ? video.videoWidth / video.videoHeight : 16 / 9;
    const fw = Math.min(w, h * aspect), fh = fw / aspect;
    frame = { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh };

    ctx.clearRect(0, 0, w, h);
    if (live()) {
      if (rotated()) {
        ctx.save();
        ctx.translate(frame.x + frame.w / 2, frame.y + frame.h / 2);
        ctx.rotate(Math.PI);
        ctx.drawImage(video, -frame.w / 2, -frame.h / 2, frame.w, frame.h);
        ctx.restore();
      } else {
        ctx.drawImage(video, frame.x, frame.y, frame.w, frame.h);
      }
    } else {
      ctx.fillStyle = '#0e1013';
      ctx.fillRect(frame.x, frame.y, frame.w, frame.h);
      PM.drawLabel(ctx, 'Webcam not started', w / 2, h / 2, '#6f7785');
    }

    // Both directions of every visible set's camera homography.
    const active = PM.activeSet();
    const maps = view.visibleSets().map((set) => {
      const quad = view.quad(set);
      const worldToCam = PM.solveHomography(set.refs, quad);
      return { set, quad, worldToCam, camToWorld: PM.invertHomography(worldToCam) };
    });

    // Detect in camera space, convert to true geometry, broadcast on change.
    const found = [];
    if (pointer) found.push({ source: 'pointer', cam: pointer });
    for (const cam of detect()) found.push({ source: modeEl.value, cam });

    const detections = [];
    for (const f of found) {
      f.ds = [];
      const candidates = [];
      for (const m of maps) {
        const world = PM.applyHomography(m.camToWorld, f.cam);
        if (!world) continue;
        const d = { x: world[0], y: world[1], source: f.source, setId: m.set.id, view: view.id };
        const rank = PM.polygonsAt(d).length ? 2 : PM.pointInPolygon(f.cam, m.quad) ? 1 : m.set === active ? 0 : -1;
        candidates.push({ d, rank });
      }
      const best = Math.max(-1, ...candidates.map((c) => c.rank));
      if (best >= 0) f.ds = candidates.filter((c) => c.rank === best).map((c) => c.d);
      detections.push(...f.ds);
    }
    touchToggle(found);
    sendTagFrame();
    detections.push(...tagDetections(maps));
    const json = JSON.stringify(detections);
    if (json !== lastSent) {
      lastSent = json;
      mine = detections;
      PM.publishDetections(mine);
      updateReadout();
    }

    // Overlay
    ctx.save();
    ctx.beginPath();
    ctx.rect(frame.x, frame.y, frame.w, frame.h);
    ctx.clip();
    const activeMap = maps.find((m) => m.set === active);
    if (gridEl.checked && activeMap && activeMap.worldToCam) {
      // Straight to canvas pixels, so the grid can be clipped at the horizon.
      const toPixels = PM.solveHomography(active.refs, activeMap.quad.map(toPx));
      if (toPixels) PM.drawGrid(ctx, toPixels, frame, active.refs);
    }
    for (const m of maps) {
      PM.drawPolygons(ctx, (p) => {
        const c = PM.applyHomography(m.worldToCam, p);
        return c && toPx(c);
      }, { setId: m.set.id, selectedId: editor.selectedId });
      PM.drawBeams(ctx, (p) => {
        const c = PM.applyHomography(m.worldToCam, p);
        return c && toPx(c);
      }, { setId: m.set.id });
    }
    ctx.restore();
    editor.drawOverlay(ctx);

    for (const f of found) PM.drawDetection(ctx, ...toPx(f.cam), f.progress);

    // Active set last so its handles sit on top.
    for (const m of [...maps.filter((m) => m.set !== active), ...maps.filter((m) => m.set === active)]) {
      PM.drawQuad(ctx, m.quad.map(toPx), m.set);
    }

    if (maps.some((m) => m.set === active && !m.worldToCam)) {
      PM.drawLabel(ctx, `${active.name}: reference points are degenerate — move a corner.`, w / 2, frame.y + 20, '#ff6b6b');
    }

    requestAnimationFrame(tick);
  }

  function updateReadout() {
    readoutEl.textContent = PM.describeDetections();
  }

  // ---- Pointer probe ------------------------------------------------------
  // With the Edit tool, the hovered point stands in for a detection.

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const [nx, ny] = toNorm(e.clientX - r.left, e.clientY - r.top);
    const inside = nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
    pointer = inside && editor.tool === 'edit' && !editor.busy ? [nx, ny] : null;
  });

  canvas.addEventListener('pointerleave', () => { pointer = null; });

  // Don't leave a stale marker on the other pages when this one closes.
  window.addEventListener('pagehide', () => PM.publishDetections([]));

  PM.init((topic, key) => {
    editor.sync(topic);
    if (topic === 'camera' && key === view.id) { // a mirroring tab changed this view
      rotateEl.checked = rotated();
      tagsEl.checked = !!view.data().tags;
      editor.refresh();
    }
    if (topic === 'geometry' || topic === 'detections') updateReadout();
  }, () => {
    view.save();
    PM.publishDetections(mine);
  });
  requestAnimationFrame(tick);
})();
