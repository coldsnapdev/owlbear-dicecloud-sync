// The dice tray every player sees in Owlbear. Opened as a transparent popover by the
// extension's background script with the roll in the URL hash; the dice tumble in,
// bounce and settle showing exactly the values the DM panel rolled.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { ShownDie, ShownRoll } from "./diceTypes";

// --- Input ------------------------------------------------------------------------------
function readRoll(): ShownRoll | undefined {
  try {
    return JSON.parse(decodeURIComponent(location.hash.slice(1))) as ShownRoll;
  } catch {
    return undefined;
  }
}

// --- Palette ----------------------------------------------------------------------------
interface Look { body: string; ink: string; glow?: string }
const PALETTE: Record<string, Look> = {
  brass: { body: "#c9a25e", ink: "#2a1b0a" },
  ivory: { body: "#ece2cb", ink: "#3a2814" },
  verdigris: { body: "#4f9c87", ink: "#0d221c" },
  fire: { body: "#c4502a", ink: "#fff0d2", glow: "#ff8a3d" },
  cold: { body: "#a7d6ee", ink: "#10303f" },
  poison: { body: "#4f7d2f", ink: "#eef8de" },
  acid: { body: "#a3c23c", ink: "#1b2406" },
  necrotic: { body: "#2f2539", ink: "#d5c2f4", glow: "#9a73d6" },
  radiant: { body: "#f1dc8a", ink: "#5a4010", glow: "#fff1b0" },
  lightning: { body: "#3a60c8", ink: "#eef3ff", glow: "#8fb2ff" },
  thunder: { body: "#5a6e8e", ink: "#eef3fb" },
  psychic: { body: "#8c4db6", ink: "#f7ebff" },
  force: { body: "#6a49d0", ink: "#f0eaff" },
  piercing: { body: "#8b9099", ink: "#15171b" },
  slashing: { body: "#a6abb3", ink: "#15171b" },
  bludgeoning: { body: "#7b6a57", ink: "#f4ecdf" },
  healing: { body: "#e9f4e5", ink: "#2c6a3b" },
};
const look = (tint?: string) => PALETTE[tint ?? ""] ?? PALETTE.brass;
export const TINT_CSS: Record<string, string> = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, v.glow ?? v.body]));

// --- Geometry -----------------------------------------------------------------------------
interface Face { normal: THREE.Vector3; center: THREE.Vector3; verts: THREE.Vector3[]; u: THREE.Vector3; v: THREE.Vector3; r: number }
interface DieShape { geometry: THREE.BufferGeometry; faces: Face[]; restHeight: number }

function d10Geometry(): THREE.BufferGeometry {
  const h = 1.08;
  const c36 = Math.cos(Math.PI / 5);
  const e = (h * (1 - c36)) / (1 + c36);
  const top = new THREE.Vector3(0, h, 0);
  const bot = new THREE.Vector3(0, -h, 0);
  const U = (k: number) => new THREE.Vector3(Math.cos((k * 2 * Math.PI) / 5), e, Math.sin((k * 2 * Math.PI) / 5));
  const L = (k: number) => new THREE.Vector3(Math.cos(((k + 0.5) * 2 * Math.PI) / 5), -e, Math.sin(((k + 0.5) * 2 * Math.PI) / 5));
  const tris: THREE.Vector3[] = [];
  const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    // keep outward winding
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const mid = new THREE.Vector3().add(a).add(b).add(c);
    if (n.dot(mid) < 0) tris.push(a, c, b);
    else tris.push(a, b, c);
  };
  for (let k = 0; k < 5; k++) {
    const u0 = U(k), u1 = U(k + 1), l0 = L(k), lm = L(k - 1);
    push(top, u0, l0); push(top, l0, u1); // upper kite
    push(bot, l0, u1); push(bot, u1, L(k + 1)); // lower kite
    void lm;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(tris.flatMap((p) => [p.x, p.y, p.z]), 3));
  return g;
}

/** Splits a polyhedron into flat faces (by normal), groups triangles per face and gives each face its own UV square. */
function shape(base: THREE.BufferGeometry, scale: number): DieShape {
  const g0 = base.index ? base.toNonIndexed() : base;
  g0.scale(scale, scale, scale);
  const pos = g0.getAttribute("position");
  const triCount = pos.count / 3;
  const faces: Face[] = [];
  const faceOfTri: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    let idx = faces.findIndex((f) => f.normal.dot(n) > 0.999);
    if (idx < 0) {
      idx = faces.length;
      faces.push({ normal: n, center: new THREE.Vector3(), verts: [], u: new THREE.Vector3(), v: new THREE.Vector3(), r: 1 });
    }
    faceOfTri.push(idx);
    for (const p of [a, b, c]) if (!faces[idx].verts.some((q) => q.distanceTo(p) < 1e-5)) faces[idx].verts.push(p.clone());
  }
  for (const f of faces) {
    f.verts.forEach((p) => f.center.add(p));
    f.center.divideScalar(f.verts.length);
    // text "up" in the face: towards the first vertex (re-chosen per die type below when it matters)
    f.v.subVectors(f.verts[0], f.center).normalize();
    f.u.crossVectors(f.v, f.normal).normalize();
    f.r = Math.max(...f.verts.map((p) => Math.hypot(p.clone().sub(f.center).dot(f.u), p.clone().sub(f.center).dot(f.v))));
  }
  // rebuild ordered by face, with groups and UVs
  const out: number[] = [], uvs: number[] = [], normals: number[] = [];
  const g = new THREE.BufferGeometry();
  let start = 0;
  faces.forEach((f, fi) => {
    let count = 0;
    for (let t = 0; t < triCount; t++) {
      if (faceOfTri[t] !== fi) continue;
      for (let k = 0; k < 3; k++) {
        a.fromBufferAttribute(pos, t * 3 + k);
        out.push(a.x, a.y, a.z);
        normals.push(f.normal.x, f.normal.y, f.normal.z);
        const d = a.clone().sub(f.center);
        uvs.push(0.5 + d.dot(f.u) / (2 * f.r), 0.5 + d.dot(f.v) / (2 * f.r));
        count++;
      }
    }
    g.addGroup(start, count, fi);
    start += count;
  });
  g.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  const restHeight = Math.min(...faces.map((f) => Math.abs(f.center.dot(f.normal))));
  return { geometry: g, faces, restHeight };
}

const SHAPES = new Map<number, DieShape>();
function shapeFor(sides: number): DieShape {
  let s = SHAPES.get(sides);
  if (s) return s;
  switch (sides) {
    case 4: s = shape(new THREE.TetrahedronGeometry(1.05), 1); break;
    case 6: s = shape(new THREE.BoxGeometry(1.2, 1.2, 1.2), 1); break;
    case 8: s = shape(new THREE.OctahedronGeometry(0.98), 1); break;
    case 10: s = shape(d10Geometry(), 0.86); break;
    case 12: s = shape(new THREE.DodecahedronGeometry(0.92), 1); break;
    default: s = shape(new THREE.IcosahedronGeometry(1.0), 1); break; // d20
  }
  SHAPES.set(sides, s);
  return s;
}

/** Face values with opposite faces summing like real dice (d10: 0–9, summing to 9). */
function faceValues(sides: number, faces: Face[]): number[] {
  const n = faces.length;
  const values = new Array<number>(n).fill(0);
  if (sides === 4) return faces.map((_, i) => i + 1); // d4 reads at the vertex; see vertexValues
  const used = new Set<number>();
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue;
    const j = faces.findIndex((f, x) => !used.has(x) && x !== i && f.normal.dot(faces[i].normal) < -0.999);
    used.add(i);
    if (j >= 0) used.add(j);
    if (sides === 10) {
      values[i] = k; if (j >= 0) values[j] = 9 - k;
    } else {
      values[i] = k + 1; if (j >= 0) values[j] = n - k;
    }
    k++;
  }
  return values;
}

// --- Face textures --------------------------------------------------------------------------
const FONT = '"Cinzel", "Trajan Pro", Georgia, serif';
function faceTexture(lk: Look, label: string | null, cornerLabels?: { text: string; x: number; y: number; angle: number }[], dim = false): THREE.CanvasTexture {
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const ctx = cv.getContext("2d")!;
  // body: soft radial sheen + fine grain so the faces don't read as flat plastic
  const grad = ctx.createRadialGradient(S * 0.42, S * 0.38, S * 0.05, S / 2, S / 2, S * 0.75);
  const body = new THREE.Color(lk.body);
  grad.addColorStop(0, `#${body.clone().offsetHSL(0, -0.02, 0.07).getHexString()}`);
  grad.addColorStop(1, `#${body.clone().offsetHSL(0, 0.02, -0.06).getHexString()}`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, S, S);
  const img = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const ink = dim ? "rgba(40,30,20,.55)" : lk.ink;
  const engrave = (text: string, x: number, y: number, size: number, angle: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.font = `700 ${size}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // light catch below/right, shadow above/left: reads as cut into the face
    ctx.fillStyle = "rgba(255,248,230,.35)";
    ctx.fillText(text, 1.6, 2);
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.fillText(text, -1.2, -1.4);
    ctx.fillStyle = ink;
    ctx.fillText(text, 0, 0);
    if (text === "6" || text === "9") {
      const w = ctx.measureText(text).width;
      ctx.fillRect(-w * 0.42, size * 0.42, w * 0.84, Math.max(3, size * 0.06));
    }
    ctx.restore();
  };
  if (label !== null) engrave(label, S / 2, S / 2 + 6, label.length > 1 ? 96 : 118, 0);
  for (const c of cornerLabels ?? []) engrave(c.text, c.x * S, (1 - c.y) * S, 54, c.angle);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// --- Building a die -------------------------------------------------------------------------
interface BuiltDie {
  group: THREE.Group;
  mesh: THREE.Mesh;
  materials: THREE.MeshPhysicalMaterial[];
  finalQ: THREE.Quaternion;
  restHeight: number;
}

function buildDie(spec: { sides: number; value: number; tint?: string; label?: (v: number) => string }): BuiltDie {
  const sides = spec.sides === 100 ? 10 : spec.sides;
  const sh = shapeFor(sides);
  const lk = look(spec.tint);
  const values = faceValues(sides, sh.faces);
  const show = spec.label ?? ((v: number) => String(v));
  let target: THREE.Vector3; // local direction that must end up pointing at the sky
  let textUp: THREE.Vector3 | undefined; // local in-face "up" of the result's numeral
  let materials: THREE.MeshPhysicalMaterial[];

  if (sides === 4) {
    // d4: every face shows the three numbers of its corners; the result is the corner on top
    const verts: THREE.Vector3[] = [];
    sh.faces.forEach((f) => f.verts.forEach((p) => { if (!verts.some((q) => q.distanceTo(p) < 1e-5)) verts.push(p); }));
    const vval = (p: THREE.Vector3) => verts.findIndex((q) => q.distanceTo(p) < 1e-5) + 1;
    materials = sh.faces.map((f) => {
      const corners = f.verts.map((p) => {
        const d = p.clone().sub(f.center);
        const x = 0.5 + d.dot(f.u) / (2 * f.r), y = 0.5 + d.dot(f.v) / (2 * f.r);
        const cx = 0.5 + (x - 0.5) * 0.58, cy = 0.5 + (y - 0.5) * 0.58;
        return { text: String(vval(p)), x: cx, y: cy, angle: Math.atan2(x - 0.5, y - 0.5) };
      });
      return material(faceTexture(lk, null, corners));
    });
    target = verts[Math.max(0, Math.min(3, spec.value - 1))].clone().normalize();
  } else {
    materials = sh.faces.map((_, i) => material(faceTexture(lk, show(values[i]))));
    const want = sides === 10 ? spec.value % 10 : spec.value;
    let fi = values.indexOf(want);
    if (fi < 0) fi = 0;
    target = sh.faces[fi].normal.clone();
    textUp = sh.faces[fi].v.clone();
  }

  const mesh = new THREE.Mesh(sh.geometry, materials);
  mesh.castShadow = true;
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(sh.geometry, 20),
    new THREE.LineBasicMaterial({ color: new THREE.Color(lk.body).multiplyScalar(0.45), transparent: true, opacity: 0.55 }),
  );
  mesh.add(edges);
  const group = new THREE.Group();
  group.add(mesh);

  // final rest: result face (or d4 corner) to the sky, numeral turned to read upright from the camera
  const q1 = new THREE.Quaternion().setFromUnitVectors(target, new THREE.Vector3(0, 1, 0));
  let turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
  if (textUp) {
    const up = textUp.clone().applyQuaternion(q1).setY(0).normalize();
    turn = new THREE.Quaternion()
      .setFromUnitVectors(up, new THREE.Vector3(0, 0, -1)) // top of the numeral away from the camera = upright on screen
      .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * 0.35));
  }
  const finalQ = turn.multiply(q1);
  return { group, mesh, materials, finalQ, restHeight: sh.restHeight };
}

function material(map: THREE.Texture): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    map,
    roughness: 0.46,
    metalness: 0.02,
    clearcoat: 0.3,
    clearcoatRoughness: 0.35,
    envMapIntensity: 0.35,
    flatShading: true,
  });
}

// --- Motion -----------------------------------------------------------------------------------
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** Height above rest for a die thrown from y0, landing with three diminishing bounces. */
function bounceHeight(s: number, y0: number): number {
  if (s < 0.36) return y0 * (1 - Math.pow(s / 0.36, 2));
  const hops: [number, number, number][] = [[0.36, 0.64, 0.62], [0.64, 0.82, 0.2], [0.82, 0.92, 0.06]];
  for (const [a, b, h] of hops) if (s < b) { const u = (s - a) / (b - a); return h * 4 * u * (1 - u); }
  return 0;
}
/** Contact moments, for the little squash on impact. */
const CONTACTS = [0.36, 0.64, 0.82, 0.92];

interface Flight {
  die: BuiltDie;
  from: THREE.Vector3;
  to: THREE.Vector3;
  y0: number;
  delay: number;
  dur: number;
  spinAxis: THREE.Vector3;
  spin: number;
  dropped: boolean;
  dice: ShownDie;
}

// --- Scene ------------------------------------------------------------------------------------
async function main() {
  const roll = readRoll();
  if (!roll) return;
  try {
    await Promise.race([document.fonts.load(`700 100px "Cinzel"`), new Promise((r) => setTimeout(r, 700))]);
  } catch {
    // fall back to Georgia
  }

  const stage = document.getElementById("stage")!;
  const W = stage.clientWidth || window.innerWidth;
  const H = stage.clientHeight || window.innerHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W, H);
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping; // keeps the dice colours true (ACES washes them out)
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);
  // steep, near-overhead view: the face on top (the result) reads clearly, as it would on a real table
  camera.position.set(0, 12.6, 4.4);
  camera.lookAt(0, 0, 0.35);

  scene.add(new THREE.HemisphereLight(0xfff1d8, 0x2a2018, 0.4));
  const key = new THREE.DirectionalLight(0xffefd6, 1.9);
  key.position.set(-5, 10, 1.5); // from the upper left, so faces towards the camera don't blow out
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -9; key.shadow.camera.right = 9; key.shadow.camera.top = 6; key.shadow.camera.bottom = -6;
  key.shadow.radius = 5;
  key.shadow.bias = -0.0008;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd6ff, 0.6);
  rim.position.set(6, 4, -6);
  scene.add(rim);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.34 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // expand d100 into tens + units d10s; cap what we draw
  const draw: { die: ShownDie; sides: number; value: number; label?: (v: number) => string }[] = [];
  for (const d of roll.dice) {
    if (d.sides === 100) {
      const v = d.value % 100; // 100 shows as 00 + 0
      draw.push({ die: d, sides: 10, value: Math.floor(v / 10), label: (x) => `${x}0` });
      draw.push({ die: d, sides: 10, value: v % 10 });
    } else if ([4, 6, 8, 10, 12, 20].includes(d.sides)) draw.push({ die: d, sides: d.sides, value: d.value });
  }
  const shown = draw.slice(0, 12);

  // layout: one or two rows centred in view
  const perRow = shown.length > 6 ? Math.ceil(shown.length / 2) : shown.length;
  const gap = Math.min(2.1, 8.6 / Math.max(1, perRow - 0.2));
  const flights: Flight[] = shown.map((s, i) => {
    const row = Math.floor(i / perRow), col = i % perRow;
    const inRow = Math.min(perRow, shown.length - row * perRow);
    const to = new THREE.Vector3((col - (inRow - 1) / 2) * gap, 0, (shown.length > 6 ? (row === 0 ? -1.0 : 1.1) : 0) + 0.2);
    const die = buildDie({ sides: s.sides, value: s.value, tint: s.die.tint, label: s.label });
    const from = new THREE.Vector3(to.x - 6.5 - Math.random() * 2, 0, to.z + (Math.random() - 0.5) * 3);
    const travel = new THREE.Vector3().subVectors(to, from).setY(0).normalize();
    const spinAxis = new THREE.Vector3(travel.z, 0, -travel.x).add(new THREE.Vector3((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.5)).normalize();
    scene.add(die.group);
    die.group.visible = false;
    return {
      die, from, to, dice: s.die,
      y0: 2.6 + Math.random() * 1.2,
      delay: i * 0.075 + Math.random() * 0.05,
      dur: 1.25 + Math.random() * 0.25,
      spinAxis,
      spin: Math.PI * 2 * (2.2 + Math.random() * 1.3),
      dropped: s.die.kept === false,
    };
  });

  // crit / fumble flourish: a ring on the table and sparks rising from the kept d20
  const flourish = roll.tone ? makeFlourish(scene, roll.tone) : undefined;
  const landAt = Math.max(0, ...flights.map((f) => f.delay + f.dur));

  const hud = document.getElementById("hud")!;
  hud.className = roll.tone ?? "";
  hud.innerHTML = `
    <div class="who">${esc(roll.who)}${roll.action ? ` · ${esc(roll.action)}` : ""}</div>
    <div class="results">${roll.results.map((r) => `<span class="res" style="--c:${TINT_CSS[r.tint ?? ""] ?? "#d9c9a6"}"><b>${r.value}</b><span>${esc(r.label)}</span></span>`).join("")}</div>
    ${roll.tag ? `<div class="tag">${esc(roll.tag)}</div>` : ""}
    ${roll.detail ? `<div class="detail">${esc(roll.detail)}</div>` : ""}`;

  const clock = new THREE.Clock();
  const tmpQ = new THREE.Quaternion();
  let hudShown = false;
  let fadeStarted = false;
  const critDie = flights.find((f) => f.dice.sides === 20 && f.dice.kept !== false);

  // ?t=1.6 freezes the animation at that moment (for checking frames)
  const frozen = Number(new URLSearchParams(location.search).get("t") ?? NaN);
  renderer.setAnimationLoop(() => {
    const t = Number.isFinite(frozen) ? frozen : clock.getElapsedTime();
    for (const f of flights) {
      const s = clamp01((t - f.delay) / f.dur);
      if (t < f.delay) continue;
      f.die.group.visible = true;
      const h = easeOutCubic(s);
      f.die.group.position.set(
        f.from.x + (f.to.x - f.from.x) * h,
        f.die.restHeight + bounceHeight(s, f.y0),
        f.from.z + (f.to.z - f.from.z) * h,
      );
      // tumble: spin about the rolling axis, unwinding exactly onto the result
      const remaining = f.spin * (1 - easeOutQuart(s));
      tmpQ.setFromAxisAngle(f.spinAxis, -remaining);
      f.die.group.quaternion.copy(tmpQ).multiply(f.die.finalQ);
      // a whisper of settle wobble after the last bounce
      if (s > 0.92 && s < 1) {
        const w = Math.sin((s - 0.92) * 70) * (1 - s) * 0.5;
        f.die.group.rotateX(w * 0.12);
      }
      // squash on each contact
      let squash = 0;
      for (const c of CONTACTS) { const d = Math.abs(s - c); if (d < 0.03) squash = Math.max(squash, (0.03 - d) / 0.03); }
      f.die.group.scale.set(1 + squash * 0.05, 1 - squash * 0.07, 1 + squash * 0.05);
      // the dropped die of an advantage pair fades back once everything has landed
      if (f.dropped) {
        f.die.materials.forEach((m) => (m.transparent = true));
        const fade = clamp01((t - landAt - 0.15) / 0.45);
        f.die.materials.forEach((m) => (m.opacity = 1 - fade * 0.62));
        f.die.group.scale.multiplyScalar(1 - fade * 0.12);
      }
    }
    if (!hudShown && t > landAt - 0.05) {
      hudShown = true;
      hud.classList.add("show");
      if (flourish && critDie) flourish.start(critDie.to.clone().setY(critDie.die.restHeight), critDie.die, landAt);
    }
    flourish?.update(t);
    if (!fadeStarted && t > landAt + 2.7) {
      fadeStarted = true;
      document.getElementById("fade")!.classList.add("out");
    }
    renderer.render(scene, camera);
  });
}

function makeFlourish(scene: THREE.Scene, tone: "crit" | "fumble") {
  const colour = tone === "crit" ? 0xf6cf6a : 0xd8573c;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.0, 1.1, 96),
    new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  scene.add(ring);
  const glowTex = (() => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    const g = cv.getContext("2d")!;
    const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    rg.addColorStop(0, "rgba(255,255,255,1)");
    rg.addColorStop(0.35, "rgba(255,255,255,.45)");
    rg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = rg;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(4.2, 4.2),
    new THREE.MeshBasicMaterial({ map: glowTex, color: colour, transparent: true, opacity: 0, depthWrite: false }),
  );
  pool.rotation.x = -Math.PI / 2;
  scene.add(pool);
  const N = tone === "crit" ? 90 : 40;
  const geo = new THREE.BufferGeometry();
  const posArr = new Float32Array(N * 3);
  geo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
  const sparks = new THREE.Points(geo, new THREE.PointsMaterial({ map: glowTex, color: colour, size: tone === "crit" ? 0.55 : 0.4, transparent: true, opacity: 0, depthWrite: false }));
  scene.add(sparks);
  const vel: THREE.Vector3[] = [];
  const spawn: THREE.Vector2[] = [];
  let t0 = -1;
  let origin = new THREE.Vector3();
  let die: BuiltDie | undefined;
  return {
    start(at: THREE.Vector3, d: BuiltDie, when: number) {
      origin = at;
      die = d;
      ring.position.set(at.x, 0.02, at.z);
      pool.position.set(at.x, 0.03, at.z);
      for (let i = 0; i < N; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 1.4 + Math.random() * 2.2;
        vel.push(new THREE.Vector3(Math.cos(a) * sp, (tone === "crit" ? 2.4 : 0.9) + Math.random() * 2, Math.sin(a) * sp));
        posArr.set([at.x + Math.cos(a) * 1.05, at.y + 0.2, at.z + Math.sin(a) * 1.05], i * 3);
        spawn.push(new THREE.Vector2(Math.cos(a) * 1.05, Math.sin(a) * 1.05));
      }
      t0 = when;
    },
    update(t: number) {
      if (t0 === -1) return;
      const e = Math.max(0, t - t0);
      const rs = 1 + e * 2.6;
      ring.scale.set(rs, rs, rs);
      (ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - e / 0.9));
      (pool.material as THREE.MeshBasicMaterial).opacity = Math.min(1, e * 4) * Math.max(0, 1 - e / 2.6) * 0.9;
      for (let i = 0; i < N; i++) {
        const v = vel[i];
        posArr[i * 3] = origin.x + spawn[i].x + v.x * e;
        posArr[i * 3 + 1] = Math.max(0.05, origin.y + 0.2 + v.y * e - 3.2 * e * e);
        posArr[i * 3 + 2] = origin.z + spawn[i].y + v.z * e;
      }
      geo.attributes.position.needsUpdate = true;
      (sparks.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - e / 1.4);
      if (die && tone === "crit") {
        // a short heartbeat: the die swells and settles back
        const pop = e < 0.35 ? Math.sin((e / 0.35) * Math.PI) * 0.12 : 0;
        die.group.scale.setScalar(1 + pop);
      }
      if (die) {
        const pulse = Math.max(0, Math.sin(Math.min(e, 1.2) * Math.PI / 1.2));
        die.materials.forEach((m) => { m.emissive.setHex(colour); m.emissiveIntensity = pulse * (tone === "crit" ? 0.28 : 0.22); });
      }
    },
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

main();
