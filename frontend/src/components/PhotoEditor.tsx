import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { ModalPortal } from "@components/ModalPortal";
import { confirm } from "@components/ConfirmDialog";
import { Icon, type IconName } from "@lib/icons";
import { t } from "@lib/i18n";

/**
 * Telegram's pattern for a photo about to be sent: crop it, paint over what should not be seen,
 * then send. Only those two tools — filters and tuning were explicitly not wanted.
 *
 * Non-destructive: the result carries the EditDoc that produced it, and reopening a staged photo
 * starts from the ORIGINAL plus that doc, so a crop can be widened again and a blur erased.
 */

type Tool = "pen" | "arrow" | "blur" | "pixelate" | "eraser";
interface Pt { readonly x: number; readonly y: number }
interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
interface Stroke { readonly tool: Tool; readonly color: string; readonly size: number; readonly pts: readonly Pt[] }

/** One edit. Crop and strokes are in SOURCE pixels, so a rotation or a flip touches neither of
 *  them — it only changes how the source is laid onto the screen and into the output. */
export interface EditDoc {
  readonly rot: 0 | 1 | 2 | 3; // quarter turns clockwise
  readonly flip: boolean;      // mirrored left↔right, after the rotation
  readonly crop: Rect;
  readonly strokes: readonly Stroke[];
}

/** "unchanged": Done without touching anything — the caller keeps what it already has. */
export type EditResult = { file: File; doc: EditDoc | null } | "unchanged";

/** What the editor can open. GIF is left out on purpose: editing it would flatten the animation. */
export function isEditablePhoto(f: File): boolean {
  return /^image\/(jpeg|png|webp|bmp|avif|heic|heif)$/.test(f.type);
}

// Past this the canvases cost more memory than a phone browser will give a tab, and the server
// stores a screen-sized copy of a photo anyway.
const MAX_SIDE = 2560;
const COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#af52de", "#ffffff", "#000000"];
const TOOLS: { tool: Tool; icon: IconName; label: string }[] = [
  { tool: "pen", icon: "pencil", label: "photoEditor.pen" },
  { tool: "arrow", icon: "arrow-up-right", label: "photoEditor.arrow" },
  { tool: "blur", icon: "droplet", label: "photoEditor.blur" },
  { tool: "pixelate", icon: "grid-3x3", label: "photoEditor.pixelate" },
  { tool: "eraser", icon: "eraser", label: "photoEditor.eraser" },
];
const RATIOS = ["free", "orig", "1:1", "4:3", "3:4", "16:9", "9:16"];

interface Source {
  readonly W: number;
  readonly H: number;
  readonly base: HTMLCanvasElement;  // the photo at working size
  readonly layer: HTMLCanvasElement; // the strokes, replayed
  // Small copies, upscaled at draw time. Pixelate is 90 blocks across: coarser than a brush
  // width filled the stroke with one flat colour and it read as paint, not mosaic.
  readonly blur: HTMLCanvasElement;
  readonly pixel: HTMLCanvasElement;
  drawn: readonly Stroke[];          // the strokes the layer currently shows
}

// ── geometry ────────────────────────────────────────────────

function orient(d: EditDoc, W: number, H: number): DOMMatrix {
  const m = [
    [1, 0, 0, 1, 0, 0],
    [0, 1, -1, 0, H, 0],
    [-1, 0, 0, -1, W, H],
    [0, -1, 1, 0, 0, W],
  ][d.rot]!;
  const M = new DOMMatrix(m);
  return d.flip ? new DOMMatrix([-1, 0, 0, 1, d.rot % 2 ? H : W, 0]).multiply(M) : M;
}

function orientedSize(d: EditDoc, W: number, H: number) {
  return d.rot % 2 ? { w: H, h: W } : { w: W, h: H };
}

/** Axis-aligned in, axis-aligned out: every transform here is a quarter turn, a mirror or a
 *  scale, so two opposite corners are enough. */
function mapRect(m: DOMMatrix, r: Rect): Rect {
  const a = m.transformPoint({ x: r.x, y: r.y });
  const b = m.transformPoint({ x: r.x + r.w, y: r.y + r.h });
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function ratioOf(key: string, o: { w: number; h: number }): number | null {
  if (key === "free") return null;
  if (key === "orig") return o.w / o.h;
  const [a, b] = key.split(":").map(Number);
  return a! / b!;
}

// ── painting ────────────────────────────────────────────────

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function shrink(base: HTMLCanvasElement, side: number): HTMLCanvasElement {
  const k = side / Math.max(base.width, base.height);
  const c = makeCanvas(Math.max(1, Math.round(base.width * k)), Math.max(1, Math.round(base.height * k)));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(base, 0, 0, c.width, c.height);
  return c;
}

/** What the blur brush reveals: a small copy blurred here, by hand, then upscaled at draw time.
 *  By hand because upscaling a tiny copy looked like blur in Chrome (bicubic) and like a mosaic
 *  in Safari (bilinear) — a number plate under it could still be read — and Safari's canvas has
 *  no `filter` to do it properly. Three box passes approximate a Gaussian; clamping at the
 *  borders keeps the edges of the photo from going transparent. */
function blurred(base: HTMLCanvasElement): HTMLCanvasElement {
  const c = shrink(base, 240);
  const ctx = c.getContext("2d")!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  let d = img.data;
  for (let i = 0; i < 3; i++) d = boxBlur(d, c.width, c.height, 4);
  img.data.set(d);
  ctx.putImageData(img, 0, 0);
  return c;
}

/** One separable box blur of radius r, running sums, edges clamped. */
function boxBlur(src: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray<ArrayBuffer> {
  const n = r * 2 + 1;
  const mid = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let ch = 0; ch < 4; ch++) {
      const at = (x: number) => src[(y * w + clamp(x, 0, w - 1)) * 4 + ch]!;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += at(k);
      for (let x = 0; x < w; x++) {
        mid[(y * w + x) * 4 + ch] = sum / n;
        sum += at(x + r + 1) - at(x - r);
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let ch = 0; ch < 4; ch++) {
      const at = (y: number) => mid[(clamp(y, 0, h - 1) * w + x) * 4 + ch]!;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += at(k);
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 4 + ch] = sum / n;
        sum += at(y + r + 1) - at(y - r);
      }
    }
  }
  return out;
}

/** Midpoint-smoothed: raw pointer samples draw a polyline with visible corners. */
function trace(ctx: CanvasRenderingContext2D, pts: readonly Pt[]): void {
  const first = pts[0]!;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  if (pts.length === 1) { ctx.lineTo(first.x + 0.01, first.y); return; } // a tap leaves a dot
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!, n = pts[i + 1]!;
    ctx.quadraticCurveTo(p.x, p.y, (p.x + n.x) / 2, (p.y + n.y) / 2);
  }
  const last = pts[pts.length - 1]!;
  ctx.lineTo(last.x, last.y);
}

function arrowhead(ctx: CanvasRenderingContext2D, st: Stroke): void {
  const end = st.pts[st.pts.length - 1]!;
  // Aim from a few widths back, not from the previous sample: the last two samples of a
  // hand-drawn line point anywhere.
  let from: Pt | null = null;
  for (let i = st.pts.length - 2; i >= 0; i--) {
    const p = st.pts[i]!;
    from = p;
    if (Math.hypot(end.x - p.x, end.y - p.y) >= st.size * 3) break;
  }
  if (!from || (from.x === end.x && from.y === end.y)) return;
  const a = Math.atan2(end.y - from.y, end.x - from.x);
  const len = st.size * 3.2;
  ctx.beginPath();
  ctx.moveTo(end.x - len * Math.cos(a - 0.5), end.y - len * Math.sin(a - 0.5));
  ctx.lineTo(end.x, end.y);
  ctx.lineTo(end.x - len * Math.cos(a + 0.5), end.y - len * Math.sin(a + 0.5));
  ctx.stroke();
}

/** ctx must already be in source coordinates. */
function paintStroke(ctx: CanvasRenderingContext2D, st: Stroke, s: Source): void {
  ctx.save();
  if (st.tool === "blur" || st.tool === "pixelate") {
    // Covering, not painting: the stroke is a window onto a ruined copy of the photo. A union
    // of discs along the path, because clip() takes an area and a stroke is only an outline.
    const r = st.size / 2;
    const step = Math.max(1, st.size / 4);
    ctx.beginPath();
    for (let i = 0; i < st.pts.length; i++) {
      const b = st.pts[i]!, a = st.pts[Math.max(0, i - 1)]!;
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let k = i === 0 ? n : 1; k <= n; k++) {
        const x = a.x + ((b.x - a.x) * k) / n, y = a.y + ((b.y - a.y) * k) / n;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    ctx.clip();
    ctx.imageSmoothingEnabled = st.tool === "blur";
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(st.tool === "blur" ? s.blur : s.pixel, 0, 0, s.W, s.H);
  } else {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = st.size;
    ctx.strokeStyle = st.color;
    if (st.tool === "eraser") ctx.globalCompositeOperation = "destination-out";
    trace(ctx, st.pts);
    ctx.stroke();
    if (st.tool === "arrow") arrowhead(ctx, st);
  }
  ctx.restore();
}

/** Bring the layer up to `strokes`: append when they extend what is drawn, replay after undo. */
function syncLayer(s: Source, strokes: readonly Stroke[]): void {
  const ctx = s.layer.getContext("2d")!;
  const extendsDrawn = s.drawn.length <= strokes.length && s.drawn.every((x, i) => x === strokes[i]);
  if (!extendsDrawn) {
    ctx.clearRect(0, 0, s.W, s.H);
    s.drawn = [];
  }
  for (const st of strokes.slice(s.drawn.length)) paintStroke(ctx, st, s);
  s.drawn = strokes;
}

// ── component ───────────────────────────────────────────────

interface CropDrag { l: boolean; r: boolean; t: boolean; b: boolean; start: Pt; c0: Rect }

export function PhotoEditor({ file, initial, startMode = "crop", onDone, onCancel }: {
  file: File;
  initial?: EditDoc | null;
  /** Which tool is open first — the send screen has a button for each, as Telegram does. */
  startMode?: "crop" | "draw";
  onDone: (r: EditResult) => void;
  onCancel: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const srcRef = useRef<Source | null>(null);
  const [hist, setHist] = useState<{ docs: readonly EditDoc[]; i: number } | null>(null);
  const [draft, setDraftState] = useState<EditDoc | null>(null); // a crop being dragged
  // pointerup can arrive before React has rendered the last pointermove's draft.
  const draftRef = useRef<EditDoc | null>(null);
  const setDraft = (d: EditDoc | null) => { draftRef.current = d; setDraftState(d); };
  const [mode, setMode] = useState<"crop" | "draw">(startMode);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]!);
  // Screen pixels, per tool: a pen is a few pixels wide, a blur that hides a face is not.
  const [sizes, setSizes] = useState<Record<Tool, number>>({ pen: 6, arrow: 6, blur: 36, pixelate: 36, eraser: 28 });
  const [ratioKey, setRatioKey] = useState("free");
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [busy, setBusy] = useState(false);
  const live = useRef<Stroke | null>(null);
  const drag = useRef<CropDrag | null>(null);
  const raf = useRef(0);
  const asking = useRef(false);

  const committed = hist ? hist.docs[hist.i]! : null;
  const doc = draft ?? committed;
  // render() runs from rAF during a drag, long after the closure that scheduled it.
  const now = useRef({ doc, mode, box });
  now.current = { doc, mode, box };

  useEffect(() => {
    let gone = false;
    createImageBitmap(file)
      .then((bmp) => {
        if (gone) return;
        const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
        const W = Math.round(bmp.width * k), H = Math.round(bmp.height * k);
        const base = makeCanvas(W, H);
        const ctx = base.getContext("2d")!;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bmp, 0, 0, W, H);
        bmp.close();
        srcRef.current = { W, H, base, layer: makeCanvas(W, H), blur: blurred(base), pixel: shrink(base, 90), drawn: [] };
        setHist({ docs: [initial ?? { rot: 0, flip: false, crop: { x: 0, y: 0, w: W, h: H }, strokes: [] }], i: 0 });
      })
      // A format this browser cannot decode (HEIC outside Safari): nothing to edit, so it goes
      // as it came rather than the send silently failing.
      .catch(() => { if (!gone) onDone({ file, doc: null }); });
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e!.contentRect.width, h: e!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function view(d: EditDoc, s: Source, m: "crop" | "draw", b: { w: number; h: number }): DOMMatrix {
    const pad = m === "crop" ? 28 : 12; // room for the crop handles to be grabbed
    const o = orientedSize(d, s.W, s.H);
    const r = m === "crop" ? { x: 0, y: 0, w: o.w, h: o.h } : mapRect(orient(d, s.W, s.H), d.crop);
    const k = Math.max(0.01, Math.min((b.w - pad * 2) / r.w, (b.h - pad * 2) / r.h));
    return new DOMMatrix([k, 0, 0, k, (b.w - r.w * k) / 2 - r.x * k, (b.h - r.h * k) / 2 - r.y * k]);
  }

  function render(): void {
    const s = srcRef.current, cv = canvasRef.current;
    const { doc: d, mode: m, box: b } = now.current;
    if (!s || !cv || !d || b.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(b.w * dpr), ch = Math.round(b.h * dpr);
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    syncLayer(s, d.strokes);
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const V = view(d, s, m, b), M = orient(d, s.W, s.H);
    ctx.save();
    ctx.setTransform(new DOMMatrix([dpr, 0, 0, dpr, 0, 0]).multiply(V).multiply(M));
    if (m === "draw") {
      ctx.beginPath();
      ctx.rect(d.crop.x, d.crop.y, d.crop.w, d.crop.h);
      ctx.clip();
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(s.base, 0, 0);
    ctx.drawImage(s.layer, 0, 0);
    // The eraser works on the layer itself as it moves; drawn here it would erase the photo.
    const lv = live.current;
    if (lv && lv.tool !== "eraser") paintStroke(ctx, lv, s);
    ctx.restore();

    if (m === "crop") {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const o = orientedSize(d, s.W, s.H);
      const img = mapRect(V, { x: 0, y: 0, w: o.w, h: o.h });
      const c = mapRect(V, mapRect(M, d.crop));
      ctx.fillStyle = "rgba(0, 0, 0, .62)";
      ctx.beginPath();
      ctx.rect(img.x, img.y, img.w, img.h);
      ctx.rect(c.x, c.y, c.w, c.h);
      ctx.fill("evenodd");
      ctx.strokeStyle = "rgba(255, 255, 255, .35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const f of [1 / 3, 2 / 3]) {
        ctx.moveTo(c.x + c.w * f, c.y); ctx.lineTo(c.x + c.w * f, c.y + c.h);
        ctx.moveTo(c.x, c.y + c.h * f); ctx.lineTo(c.x + c.w, c.y + c.h * f);
      }
      ctx.stroke();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(c.x, c.y, c.w, c.h);
      ctx.lineWidth = 4;
      ctx.lineCap = "square";
      const L = Math.min(22, c.w / 3, c.h / 3);
      ctx.beginPath();
      for (const [x, y, sx, sy] of [[c.x, c.y, 1, 1], [c.x + c.w, c.y, -1, 1], [c.x, c.y + c.h, 1, -1], [c.x + c.w, c.y + c.h, -1, -1]] as const) {
        ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y);
      }
      ctx.stroke();
    }
  }

  function schedule(): void {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => { raf.current = 0; render(); });
  }
  useEffect(schedule, [doc, mode, box]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  function commit(next: EditDoc): void {
    setHist((h) => (h ? { docs: [...h.docs.slice(0, h.i + 1), next], i: h.i + 1 } : h));
    setDraft(null);
  }
  const canUndo = !!hist && hist.i > 0;
  const canRedo = !!hist && hist.i < hist.docs.length - 1;
  const undo = () => canUndo && setHist({ ...hist!, i: hist!.i - 1 });
  const redo = () => canRedo && setHist({ ...hist!, i: hist!.i + 1 });

  function point(e: PointerEvent<HTMLCanvasElement>, m: DOMMatrix): Pt {
    const r = e.currentTarget.getBoundingClientRect();
    const p = m.inverse().transformPoint({ x: e.clientX - r.left, y: e.clientY - r.top });
    return { x: p.x, y: p.y };
  }

  function cropHit(c: Rect, p: Pt, tol: number): Omit<CropDrag, "start" | "c0"> | null {
    const inX = p.x > c.x - tol && p.x < c.x + c.w + tol;
    const inY = p.y > c.y - tol && p.y < c.y + c.h + tol;
    if (!inX || !inY) return null;
    const l = Math.abs(p.x - c.x) < tol, r = !l && Math.abs(p.x - c.x - c.w) < tol;
    const t = Math.abs(p.y - c.y) < tol, b = !t && Math.abs(p.y - c.y - c.h) < tol;
    const corner = (l || r) && (t || b);
    // With a locked ratio an edge alone would have to drag the other axis along with it; only
    // corners resize then, as in Telegram.
    if (corner || (ratioKey === "free" && (l || r || t || b))) return { l, r, t, b };
    if (p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h) return { l: true, r: true, t: true, b: true };
    return null;
  }

  function onDown(e: PointerEvent<HTMLCanvasElement>): void {
    const s = srcRef.current;
    if (!s || !committed || busy) return;
    const V = view(committed, s, mode, box), M = orient(committed, s.W, s.H);
    if (mode === "crop") {
      const p = point(e, V);
      const c0 = mapRect(M, committed.crop);
      const h = cropHit(c0, p, 22 / V.a);
      if (!h) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { ...h, start: p, c0 };
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e, V.multiply(M));
    live.current = { tool, color, size: sizes[tool] / V.a, pts: [p] };
    if (tool === "eraser") paintStroke(s.layer.getContext("2d")!, live.current, s);
    schedule();
  }

  function onMove(e: PointerEvent<HTMLCanvasElement>): void {
    const s = srcRef.current;
    if (!s || !committed) return;
    const V = view(committed, s, mode, box), M = orient(committed, s.W, s.H);
    if (mode === "crop") {
      const p = point(e, V);
      const dg = drag.current;
      if (!dg) {
        const h = cropHit(mapRect(M, committed.crop), p, 22 / V.a);
        const all = h && h.l && h.r && h.t && h.b;
        e.currentTarget.style.cursor = !h ? "" : all ? "move"
          : (h.l && h.t) || (h.r && h.b) ? "nwse-resize" : (h.r && h.t) || (h.l && h.b) ? "nesw-resize"
          : h.l || h.r ? "ew-resize" : "ns-resize";
        return;
      }
      const o = orientedSize(committed, s.W, s.H);
      const dx = p.x - dg.start.x, dy = p.y - dg.start.y, c0 = dg.c0;
      let x: number, y: number, w: number, h: number;
      if (dg.l && dg.r && dg.t && dg.b) {
        w = c0.w; h = c0.h;
        x = clamp(c0.x + dx, 0, o.w - w);
        y = clamp(c0.y + dy, 0, o.h - h);
      } else {
        const min = 40 / V.a;
        let l = c0.x, r = c0.x + c0.w, t = c0.y, b = c0.y + c0.h;
        if (dg.l) l = clamp(l + dx, 0, r - min);
        if (dg.r) r = clamp(r + dx, l + min, o.w);
        if (dg.t) t = clamp(t + dy, 0, b - min);
        if (dg.b) b = clamp(b + dy, t + min, o.h);
        const ratio = ratioOf(ratioKey, o);
        if (ratio) {
          // The width leads, the height follows, pinned at the opposite corner.
          let nw = r - l, nh = nw / ratio;
          const room = dg.t ? b : o.h - t;
          if (nh > room) { nh = room; nw = nh * ratio; }
          if (dg.l) l = r - nw; else r = l + nw;
          if (dg.t) t = b - nh; else b = t + nh;
        }
        x = l; y = t; w = r - l; h = b - t;
      }
      setDraft({ ...committed, crop: mapRect(M.inverse(), { x, y, w, h }) });
      return;
    }
    const lv = live.current;
    if (!lv) return;
    const p = point(e, V.multiply(M));
    const last = lv.pts[lv.pts.length - 1]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) < 0.75 / V.a) return;
    live.current = { ...lv, pts: [...lv.pts, p] };
    if (lv.tool === "eraser") paintStroke(s.layer.getContext("2d")!, { ...lv, pts: [last, p] }, s);
    schedule();
  }

  function onUp(): void {
    if (drag.current) {
      drag.current = null;
      if (draftRef.current) commit(draftRef.current);
      return;
    }
    const lv = live.current;
    if (!lv || !committed) return;
    live.current = null;
    commit({ ...committed, strokes: [...committed.strokes, lv] });
  }

  function pickRatio(key: string): void {
    const s = srcRef.current;
    setRatioKey(key);
    if (!s || !committed) return;
    const o = orientedSize(committed, s.W, s.H);
    const r = ratioOf(key, o);
    if (!r) return;
    // The largest rect of that shape the photo holds, centred where the crop was.
    const M = orient(committed, s.W, s.H);
    const c = mapRect(M, committed.crop);
    let w = o.w, h = w / r;
    if (h > o.h) { h = o.h; w = h * r; }
    const x = clamp(c.x + c.w / 2 - w / 2, 0, o.w - w), y = clamp(c.y + c.h / 2 - h / 2, 0, o.h - h);
    commit({ ...committed, crop: mapRect(M.inverse(), { x, y, w, h }) });
  }

  function rotate(): void {
    if (!committed) return;
    // Always counter-clockwise ON SCREEN; a mirror reverses what a quarter turn looks like.
    commit({ ...committed, rot: ((committed.rot + (committed.flip ? 1 : 3)) % 4) as EditDoc["rot"] });
    if (ratioKey.includes(":")) setRatioKey(ratioKey.split(":").reverse().join(":"));
  }

  const s = srcRef.current;
  const full = s && committed && committed.crop.x < 0.5 && committed.crop.y < 0.5
    && Math.abs(committed.crop.w - s.W) < 0.5 && Math.abs(committed.crop.h - s.H) < 0.5;
  const geometryChanged = !!committed && (committed.rot !== 0 || committed.flip || !full);

  function resetGeometry(): void {
    if (!committed || !s) return;
    setRatioKey("free");
    commit({ ...committed, rot: 0, flip: false, crop: { x: 0, y: 0, w: s.W, h: s.H } });
  }

  async function finish(): Promise<void> {
    if (!hist || !committed || !s || busy) return;
    if (hist.i === 0) { onDone("unchanged"); return; }
    if (!geometryChanged && committed.strokes.length === 0) { onDone({ file, doc: null }); return; }
    setBusy(true);
    syncLayer(s, committed.strokes);
    const M = orient(committed, s.W, s.H);
    const c = mapRect(M, committed.crop);
    const out = makeCanvas(Math.max(1, Math.round(c.w)), Math.max(1, Math.round(c.h)));
    const ctx = out.getContext("2d")!;
    ctx.setTransform(new DOMMatrix([1, 0, 0, 1, -c.x, -c.y]).multiply(M));
    ctx.drawImage(s.base, 0, 0);
    ctx.drawImage(s.layer, 0, 0);
    // A screenshot stays PNG — JPEG smears the very text people crop screenshots to share.
    const png = file.type === "image/png";
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, png ? "image/png" : "image/jpeg", 0.92));
    setBusy(false);
    if (!blob) return;
    const name = file.name.replace(/\.[^.]*$/, "") + (png ? ".png" : ".jpg");
    onDone({ file: new File([blob], name, { type: blob.type }), doc: committed });
  }

  async function cancel(): Promise<void> {
    if (asking.current) return;
    if (hist && hist.i > 0) {
      asking.current = true;
      const ok = await confirm({
        message: t("photoEditor.discard"),
        confirmLabel: t("photoEditor.discardConfirm"),
        danger: true,
      });
      asking.current = false;
      if (!ok) return;
    }
    onCancel();
  }

  // Keyboard as in any editor. Skipped while the discard dialog is up: it listens for the very
  // same Escape and Enter.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (asking.current) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") { e.preventDefault(); void cancel(); }
    // Not on a focused control: Enter there means "press this", not "done".
    else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement)) {
      e.preventDefault(); void finish();
    }
    else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    else return;
    e.stopPropagation();
  };
  useEffect(() => {
    // The composer keeps focus otherwise, and keystrokes land in a textarea nobody can see.
    (document.activeElement as HTMLElement | null)?.blur();
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);

  const ready = !!hist;
  const coverTool = tool === "blur" || tool === "pixelate" || tool === "eraser";

  return (
    <ModalPortal>
      <div className="pe" role="dialog" aria-modal="true" aria-label={t("photoEditor.title")}>
        <div className="pe-top">
          <button className="pe-text-btn" onClick={() => void cancel()}>{t("photoEditor.cancel")}</button>
          <div className="pe-history">
            <button className="pe-icon-btn" disabled={!canUndo} onClick={undo} title={t("photoEditor.undo")} aria-label={t("photoEditor.undo")}>
              <Icon name="undo-2" size={20} />
            </button>
            <button className="pe-icon-btn" disabled={!canRedo} onClick={redo} title={t("photoEditor.redo")} aria-label={t("photoEditor.redo")}>
              <Icon name="redo-2" size={20} />
            </button>
          </div>
          <button className="pe-done" disabled={!ready || busy} onClick={() => void finish()}>
            {busy ? <Icon name="loader" size={18} /> : t("photoEditor.done")}
          </button>
        </div>

        <div className="pe-stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            className={mode === "draw" ? "drawing" : undefined}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
          {!ready && <div className="pe-loading"><Icon name="loader" size={28} /></div>}
        </div>

        <div className="pe-panel">
          {mode === "crop" ? (
            <div className="pe-row">
              <button className="pe-icon-btn" onClick={rotate} title={t("photoEditor.rotate")} aria-label={t("photoEditor.rotate")}>
                <Icon name="rotate-ccw" size={20} />
              </button>
              <button className="pe-icon-btn" onClick={() => committed && commit({ ...committed, flip: !committed.flip })}
                title={t("photoEditor.flip")} aria-label={t("photoEditor.flip")}>
                <Icon name="flip-horizontal" size={20} />
              </button>
              <div className="pe-chips">
                {RATIOS.map((k) => (
                  <button key={k} className="pe-chip" aria-pressed={ratioKey === k} onClick={() => pickRatio(k)}>
                    {k === "free" ? t("photoEditor.free") : k === "orig" ? t("photoEditor.original") : k}
                  </button>
                ))}
              </div>
              {geometryChanged && (
                <button className="pe-text-btn" onClick={resetGeometry}>{t("photoEditor.reset")}</button>
              )}
            </div>
          ) : (
            <>
              <div className="pe-row pe-tools">
                {TOOLS.map((x) => (
                  <button key={x.tool} className="pe-tool" aria-pressed={tool === x.tool} onClick={() => setTool(x.tool)}>
                    <Icon name={x.icon} size={20} />
                    <span>{t(x.label)}</span>
                  </button>
                ))}
              </div>
              <div className="pe-row">
                {!coverTool && (
                  <div className="pe-colors">
                    {COLORS.map((c) => (
                      <button key={c} className="pe-swatch" style={{ background: c }} aria-pressed={color === c}
                        aria-label={c} onClick={() => setColor(c)} />
                    ))}
                  </div>
                )}
                <label className="pe-size">
                  <span>{t("photoEditor.size")}</span>
                  <input type="range" min={2} max={coverTool ? 96 : 40} value={sizes[tool]}
                    onChange={(e) => setSizes({ ...sizes, [tool]: Number(e.target.value) })} />
                </label>
              </div>
            </>
          )}
          <div className="pe-tabs" role="tablist">
            <button role="tab" className="pe-tab" aria-selected={mode === "crop"} onClick={() => setMode("crop")}>
              <Icon name="crop" size={22} />
              <span>{t("photoEditor.crop")}</span>
            </button>
            <button role="tab" className="pe-tab" aria-selected={mode === "draw"} onClick={() => setMode("draw")}>
              <Icon name="brush" size={22} />
              <span>{t("photoEditor.draw")}</span>
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
