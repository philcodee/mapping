# Session log — 18 Nov 2026

The changes made in this session, on top of `78c8ee2` (Merge pull request #1). Nothing has been
committed yet. Use this log to bring the work into a fork or branch.

## At a glance

| Area | What changed |
| --- | --- |
| Camera | **Rotate 180°** option for an upside-down webcam |
| Camera | **Hand** detection mode: MediaPipe fingertip tracking. Resting a fingertip on a polygon switches it on or off |
| Camera | **Pointer tags**: ArUco tags 40 and 41 cast a beam at polygons. Ported from `prototype/` |
| All pages | Projected pulsing beams in place of the prototype's sonar clicks |
| All pages | Polygons **explode** when a pointer is held on them |
| Projector | **Game mode**: pixel-art fruit flies to blow up; big ones need 2 players |
| Removed | **Cover** mode was built and then removed at the user's request (none of it remains) |

Diff against `78c8ee2`: 7 tracked files changed, about 950 lines added and 26 removed. There are also new untracked files (see [Files](#files)).

## Files

### Modified

| File | Changes |
| --- | --- |
| `camera.js` | Rotate 180°, Hand mode, touch-to-toggle, pointer-tag detection and beams, the hold that blows polygons up, and a shared `readLuma()` helper |
| `camera.html` | Rotate checkbox, Hand mode option, Track pointer tags checkbox, help text |
| `shared.js` | Polygon on/off drawing, detection progress ring, `castBeam` (beam casting), pulsing beams, explosions, fruit-fly sprites, `animate()` redraw loop |
| `projector.js` | Draws beams; redraws continuously while things animate; game mode |
| `projector.html` | **Game** button (key T) |
| `geometry.js` | Draws beams and progress rings; redraws continuously while things animate |
| `README.md` | Docs for Rotate, Hand mode, pointer tags, explosions and the game |

### New (untracked)

| Path | What |
| --- | --- |
| `aruco.worker.js` | ArUco detector Web Worker, copied from `prototype/detector.worker.js` (unchanged) |
| `vendor/` | js-aruco2 (`cv.js`, `aruco.js`, `aruco_4x4_1000.js`) and its `LICENSE.txt` (MIT), copied from `prototype/vendor/` |
| `session-log.md` | This file |
| `aruco/`, `prototype/` | Were already in the folder before this session and are untracked. Not changed. `prototype/` is the source of the pointer feature |

When forking, commit `aruco.worker.js` and `vendor/` together with the code. The camera page loads both.
Whether `aruco/` and `prototype/` belong in the repo is up to you.

## Changes in detail

### 1. Camera Rotate 180°

**Problem:** the camera feed looked upside down. The code wasn't flipping anything (`ctx.drawImage` drew frames as they came). The webcam was physically mounted 180° round from the projector's view. The camera's A–D handles were also misplaced, so overlays didn't line up.

**Change:** a per-camera-view **Rotate 180° (camera mounted upside down)** checkbox.
- Camera coordinates are now stored for the frame as displayed, the right way up. Only drawing the video and reading its pixels see the raw orientation.
- Ticking or unticking it turns every set's A–D handles with the image, so existing calibration stays on the same physical points.
- Saved per view as `view.data().rotate`. Tabs mirroring the same view stay in step.

### 2. Hand mode and touch-to-toggle

- New detection mode **Hand (fingertip touches toggle polygons)**. It uses MediaPipe Tasks Vision `HandLandmarker` 0.10.14, loaded from jsDelivr when first picked, with its model from Google Storage. It tries the GPU first and falls back to the CPU. It tracks the index fingertip (landmark 8) of up to 4 hands.
- **Touch-to-toggle:** a fingertip that stays on a polygon for 600 ms flips that polygon's new `on` field.
  - **Grace:** a 250 ms grace period covers brief tracking losses.
  - **Leave first:** the finger must leave before it can flip the same polygon again.
  - **Two cameras:** a 1 s cooldown (`toggledAt`) stops two cameras both flipping the same polygon.
- **Display:**
  - Polygons that are on are drawn solid on every page.
  - A ring around the detection marker fills during the hold (`drawDetection(…, progress)`).
  - A detection merely passing over a polygon now gives a lighter highlight (+0.25 alpha, down from +0.45), so it doesn't look like "on".
- **Limitation:** this needs internet access the first time. The user found it unreliable in dim light, which led to the cover-mode experiment below.

### 3. Cover mode (removed)

An experiment that watched each projected polygon for a hand blocking its light, with a calibration step. The user asked for it to be removed, and all of its code, UI and docs are gone. The only leftover is the `readLuma()` helper in `camera.js`, which the brightest-spot and motion detectors now use too.

### 4. Pointer tags (ported from `prototype/`)

Source: `prototype/pointer.js` (`castBeam`), `prototype/sheetcam.js` (heading from the tag's top edge), `prototype/detector.worker.js`.

- **Turning it on:** a **Track pointer tags (ArUco 40, 41)** checkbox on the camera page, saved per view (`view.data().tags`). It runs alongside any detection mode.
- **Detection:**
  - Full video frames go to `aruco.worker.js`, which uses `DICT_4X4_50`, the first 50 codes of `ARUCO_4X4_1000`.
  - Each tag's centre and the middle of its top edge (corners 0 → 1) are smoothed (factor 0.35) and kept through 400 ms of missed frames.
  - Both points are then mapped into true geometry through the camera homography of the set whose outline contains the tag, or the active set otherwise.
- **Beam:** `PM.castBeam(origin, heading, polygons, selfR)` in `shared.js` follows the prototype's rules:
  - It's a ±2° cone of 9 rays.
  - From outside a polygon, the beam stops where it enters it.
  - From inside, it stops at that polygon's own edge ("the edge of X").
  - On a shared edge, the neighbour wins.
  - Distance is measured from the tag's front edge.
  - Tested in Node against the prototype's cases.
- **Detections** gain `name` and `aim: { heading, charge, hit: { polyId, name, dist, pt } | null }`. `hitIds()` highlights the polygon a tag is aimed at rather than the one it sits in. The sidebars read "aimed at X, N away".
- **Display, in place of sound:** `PM.drawBeams()` draws a yellow beam on the projector, geometry and camera pages.
  - On a target, it flashes and fades with a ring spreading from the hit point.
  - Flash rate: every 125 ms (8 a second) at a distance of 10 units or less, slowing to every 1000 ms at 500 or more (`BEAM` in `shared.js`).
  - With no target, the beam is dashed and steady.
- **Not ported:** the prototype's `zones.json` zones, walls and easter egg (draw them as polygons instead), the per-tag `offsetDeg`, and all audio.

### 5. Explosions

- **Trigger:** holding one tag's beam on a polygon for 1 s blows it up. A white charge ring fills at the hit point (`aim.charge`).
  - The camera sets `explodedAt = Date.now()` on the polygon and publishes the geometry.
  - The beam must leave the polygon before it can blow it up again. Time spent aimed at the gap while the polygon is gone doesn't count as leaving.
- **Display only:** the polygon's points never change. `EXPLODE` in `shared.js`:

  | Phase | Duration |
  | --- | --- |
  | Hold to trigger | 1000 ms |
  | Burst: white flash, a shockwave lying flat on the surface, 32 seeded pieces flying, spinning, shrinking and fading | 1200 ms |
  | Gone | 3000 ms |
  | Fading back in | 800 ms |

- **Same on every page:** the pieces come from a random generator seeded with `id:explodedAt`.
- **While gone,** a polygon is skipped by `polygonsAt()` (so touches miss it) and by beam casting (so beams pass through it).
- **Redrawing:** `PM.animate(render)` keeps the event-driven projector and geometry pages redrawing every frame while beams pulse, polygons explode or flies buzz.

### 6. Game mode (projector)

- **T** or the **Game** button keeps `GAME.targets` (4) targets inside the active set's A–D area. It's saved per view and resumes when the page is reopened. Turning it off removes all the targets.
- **Targets:** polygons with `game`, `need` (1 or 2), `holdMs` (1, 2 or 3 s). They're placed clear of other polygons, and 35% need two players.
- **Who decides:** the projector tab running the game, because it sees every camera's pointers.
  - It counts the different pointers aimed at each target.
  - The charge fills while there are enough of them and drains over 400 ms otherwise.
  - A 2-player target with one pointer shows a flashing "Needs 2 players".
  - Once a target's burst has played, it's removed, and a new one spawns after 800 ms.
  - The camera ignores game targets for its own 1 s rule.
- **Run the game on one projector tab only.** Charge rings show only on that tab.
- **Tested** with a Node simulation using fake pointers: spawning, 1-player, 2-player with one pointer (no explosion), 2-player with two (explosion), and respawning.

### 7. Fruit-fly sprites

- **Targets are pixel-art fruit flies:** `sprite: 'fly'`, `center`, `size`, `heading`. Each fly's polygon is an invisible eight-sided hit area 0.6 × its size across. Small flies need one pointer; big flies (`GAME.bigFly` 0.2 vs `GAME.fly` 0.12 of the area's shorter side) need two.
- **Sprite:** `FLY` in `shared.js` holds two 17×17 frames written as text, with colours in `FLY_COLORS`.
  - Big red eyes with a shine, a slim muted tan-brown body with a darker tail tip, and no stripes or yellow.
  - Translucent wings folded back past the tail, and swung out mid-beat.
  - Redesigned twice after "looks like a bumblebee" feedback.
- **Mapping:** each sprite pixel is mapped through the homography as its own quad (grouped by colour), so the flies lie flat in perspective.
- **Motion:** hovering, wobbling and wing beats (about 11 a second) depend only on the clock and the fly's id, so they look the same on every page.
- **Projector colours:** dark colours are lifted to mid-tones, because a projector can't show black.
- **Blowing up:** a fly bursts into its own sprite pixels.
- **Hold time is no longer shown.** The thicker outline went with the polygons.

## Data model additions

Polygons in `geometry` may now carry:

```
on?, toggledAt?          touch-to-toggle state
explodedAt?              Date.now() when blown up
game?, need?, holdMs?    game target
sprite?, center?, size?, heading?   drawn as a fruit fly (points = hit area)
```

Camera view data (`pm:camera:<view>`): `rotate`, `tags`. Projector view data (`pm:projector:<view>`): `game`, `gameSet`.
Detections: `progress`, `name`, `aim`.

## Tuning knobs

| Constant | File | Controls |
| --- | --- | --- |
| `DWELL_MS`, `GRACE_MS`, `COOLDOWN_MS` | `camera.js` | Touch-to-toggle timing |
| `POINTER_TAGS`, `TAG_GRACE_MS`, `TAG_SMOOTHING` | `camera.js` | Which tags are pointers, and their tracking |
| `BEAM` | `shared.js` | Beam width and pulse rate against distance |
| `EXPLODE` | `shared.js` | Hold, burst, gone and fade timings |
| `GAME` | `projector.js` | Target count, 2-player share, hold times, drain, respawn, fly sizes |
| `FLY`, `FLY_COLORS`, `WING_ALPHA` | `shared.js` | Fly sprite |

## Testing status

- `node --check` passes for every script.
- **Node tests** (scratch scripts, not in the repo):
  - `castBeam` cases
  - every phase of the explosion drawing
  - the game simulation
  - both sprite frames, which have consistent dimensions and were rendered to an image for review
- **Not tested in a browser** with the real webcam, projector or tags: Hand mode, tag detection, beams, explosions, the game and the flies.

## Known limitations

- Hand mode needs internet the first time and struggles in dim light.
- 0.75″ pointer tags may be marginal at the C270's 1280×720 maximum. The prototype filmed at 1920×1080.
- Beam distances are in true-geometry units, not inches.
- A geometry edit published by another page at the same moment can overwrite a toggle or explosion. The whole geometry is sent each time.
- The game's charge rings show only on the projector tab running the game.
