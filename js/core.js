// PrintHub Mobile - document core.
// Pages come from PDF files, images and camera scans. Edits (rotate, crop, drawings) are
// non-destructive; export writes vector PDF pages with pdf-lib. Everything runs on the device.
//
// Coordinates: annotations are normalized (0..1) to the *displayed* page (after rotation + crop).
// Stroke widths / font sizes are fractions of the displayed page's shorter side.

import * as pdfjsLib from "../vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;
// one worker for every document (a worker per file wastes memory on phones)
let pdfWorker = null;
const worker = () => (pdfWorker ||= new pdfjsLib.PDFWorker({ name: "printhub" }));

const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = window.PDFLib;

// ------------------------------------------------------------------ sources
const sources = new Map(); // id -> { kind: "pdf", bytes, name, pdfjs, libDoc } | { kind: "img", ... }
let nextId = 1;
const uid = () => `p${Date.now().toString(36)}${(nextId++).toString(36)}`;

export async function addFile(file) {
  const name = file.name || "file";
  const type = file.type || "";
  if (type === "application/pdf" || /\.pdf$/i.test(name)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({ data: bytes.slice(), worker: worker() }).promise;
    } catch (e) {
      if (e && e.name === "PasswordException") throw new Error(`"${name}" מוגן בסיסמה. הסר את הסיסמה ונסה שוב.`);
      throw new Error(`לא ניתן לפתוח את "${name}": ${e.message || e}`);
    }
    const id = uid();
    sources.set(id, { kind: "pdf", bytes, name, pdfjs: pdf, libDoc: null });
    const pages = [];
    for (let i = 0; i < pdf.numPages; i++) {
      const pg = await pdf.getPage(i + 1);
      const vp = pg.getViewport({ scale: 1 }); // includes the source /Rotate
      pages.push(newPage({ kind: "pdf", src: id, index: i, srcRot: pg.rotate || 0,
        baseW: vp.width, baseH: vp.height, label: `${name} · עמוד ${i + 1}` }));
    }
    return pages;
  }
  if (type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(name)) {
    return [await pageFromImage(file, name)];
  }
  throw new Error(`סוג קובץ לא נתמך: ${name}`);
}

export async function pageFromImage(blob, label = "תמונה", opts = {}) {
  const bmp = await loadImage(blob);
  const id = uid();
  sources.set(id, { kind: "img", blob, url: URL.createObjectURL(blob), w: bmp.width, h: bmp.height, bmp });
  // page size: never wider than A4 (595pt) - phone photos are huge
  const dpi = Math.max(opts.dpi || 150, bmp.width / 8.27);
  return newPage({ kind: "img", src: id, baseW: (bmp.width / dpi) * 72, baseH: (bmp.height / dpi) * 72,
    label });
}

async function loadImage(blob) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); } catch (_) { /* fall back */ }
  }
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("לא ניתן לקרוא את התמונה"));
    im.src = URL.createObjectURL(blob);
  });
}

function newPage(p) {
  return { id: uid(), rot: 0, crop: null, annots: [], srcRot: 0, ...p };
}

export const clonePage = (p) => ({ ...p, id: uid(), annots: p.annots.map((a) => structuredClone(a)),
  crop: p.crop ? [...p.crop] : null });

// ------------------------------------------------------------------ geometry
export function displaySize(p) {
  let w = p.baseW, h = p.baseH;
  if (p.rot % 180) [w, h] = [h, w];
  if (p.crop) { w *= p.crop[2] - p.crop[0]; h *= p.crop[3] - p.crop[1]; }
  return [w, h];
}

const rot90 = ([x, y]) => [1 - y, x];            // one clockwise quarter turn, normalized coords
function rotPts(pt, steps) { for (let i = 0; i < steps; i++) pt = rot90(pt); return pt; }

function mapAnnot(a, fn) {
  const b = structuredClone(a);
  if (b.t === "ink") b.pts = b.pts.map((s) => s.map(fn));
  for (const k of ["r", "p"]) {
    if (!b[k]) continue;
    let [x0, y0, x1, y1] = b[k];
    const [ax, ay] = fn([x0, y0]), [bx, by] = fn([x1, y1]);
    b[k] = k === "r" ? [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)] : [ax, ay, bx, by];
  }
  return b;
}

export function rotatePage(p, degCW) {
  const steps = (((degCW / 90) % 4) + 4) % 4;
  const q = { ...p, rot: (p.rot + degCW + 360) % 360 };
  if (p.crop) {
    let [x0, y0, x1, y1] = p.crop;
    for (let i = 0; i < steps; i++) [x0, y0, x1, y1] = [1 - y1, x0, 1 - y0, x1];
    q.crop = [x0, y0, x1, y1];
  }
  q.annots = p.annots.map((a) => {
    const b = mapAnnot(a, (pt) => rotPts(pt, steps));
    if (b.t === "sig" || b.t === "text") b.arot = ((b.arot || 0) + 90 * steps) % 360;
    return b;
  });
  return q;
}

export function cropPage(p, box) {                // box: fractions of the displayed page
  const [ow, oh] = displaySize(p);
  const [fx0, fy0, fx1, fy1] = box;
  const sx = fx1 - fx0, sy = fy1 - fy0;
  const scale = Math.min(ow, oh) / Math.max(1e-6, Math.min(ow * sx, oh * sy));
  const annots = p.annots.map((a) => {
    const b = mapAnnot(a, ([x, y]) => [(x - fx0) / sx, (y - fy0) / sy]);
    if (b.w) b.w *= scale;
    if (b.fs) b.fs *= scale;
    return b;
  });
  let crop = box;
  if (p.crop) {
    const [x0, y0, x1, y1] = p.crop, w = x1 - x0, h = y1 - y0;
    crop = [x0 + fx0 * w, y0 + fy0 * h, x0 + fx1 * w, y0 + fy1 * h];
  }
  return { ...p, crop, annots };
}

export function annotBBox(a) {
  if (["rect", "ellipse", "text", "sig"].includes(a.t)) return a.r;
  if (a.t === "arrow") { const [x0, y0, x1, y1] = a.p; return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]; }
  const xs = a.pts.flat().map((q) => q[0]), ys = a.pts.flat().map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function translateAnnot(a, dx, dy) {
  return mapAnnot(a, ([x, y]) => [x + dx, y + dy]);
}

export function sigStrokes(a) {                   // signature strokes mapped into its page box
  const [x0, y0, x1, y1] = a.r;
  const steps = ((a.arot || 0) / 90) % 4;
  return a.pts.map((s) => s.map((pt) => { const [u, v] = rotPts(pt, steps); return [x0 + u * (x1 - x0), y0 + v * (y1 - y0)]; }));
}

// ------------------------------------------------------------------ rendering
// Renders the page as displayed (rotation + crop) into a canvas `targetW` px wide.
// withAnnots draws the marks on top (thumbnails, print); the editor draws them itself.
export async function renderPage(p, targetW, { withAnnots = true } = {}) {
  const [dw, dh] = displaySize(p);
  const W = Math.max(1, Math.round(targetW)), H = Math.max(1, Math.round((targetW * dh) / dw));
  const cx = p.crop || [0, 0, 1, 1];
  const fullW = W / (cx[2] - cx[0]), fullH = H / (cx[3] - cx[1]); // size of the uncropped rotated page
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  const src = sources.get(p.src);
  if (p.kind === "pdf") {
    const pg = await src.pdfjs.getPage(p.index + 1);
    const base = pg.getViewport({ scale: 1, rotation: (p.srcRot + p.rot) % 360 });
    const scale = fullW / base.width;
    const vp = pg.getViewport({ scale, rotation: (p.srcRot + p.rot) % 360 });
    const full = document.createElement("canvas");
    full.width = Math.ceil(vp.width); full.height = Math.ceil(vp.height);
    const fctx = full.getContext("2d");
    fctx.fillStyle = "#fff"; fctx.fillRect(0, 0, full.width, full.height);
    await pg.render({ canvasContext: fctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    ctx.drawImage(full, -cx[0] * fullW, -cx[1] * fullH, fullW, fullH);
    full.width = full.height = 0;
  } else {
    ctx.save();
    ctx.translate(-cx[0] * fullW, -cx[1] * fullH);
    drawRotatedImage(ctx, src.bmp, p.rot, fullW, fullH);
    ctx.restore();
  }
  if (withAnnots && p.annots.length) drawAnnots(ctx, p.annots, W, H);
  return out;
}

function drawRotatedImage(ctx, img, rot, W, H) {   // draw `img` rotated clockwise into W x H
  ctx.save();
  if (rot === 90) { ctx.translate(W, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(img, 0, 0, H, W); }
  else if (rot === 180) { ctx.translate(W, H); ctx.rotate(Math.PI); ctx.drawImage(img, 0, 0, W, H); }
  else if (rot === 270) { ctx.translate(0, H); ctx.rotate(-Math.PI / 2); ctx.drawImage(img, 0, 0, H, W); }
  else ctx.drawImage(img, 0, 0, W, H);
  ctx.restore();
}

export const TEXT_FONT = "'Noto Sans Hebrew', 'Segoe UI', Arial, sans-serif";

export function drawAnnots(ctx, annots, W, H, selected = -1) {
  const unit = Math.min(W, H);
  const P = ([x, y]) => [x * W, y * H];
  annots.forEach((a, i) => {
    ctx.save();
    const lw = Math.max(1, (a.w || 0.004) * unit);
    ctx.strokeStyle = ctx.fillStyle = a.c || "#000";
    ctx.lineWidth = lw; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (a.t === "ink" || a.t === "sig") {
      ctx.globalAlpha = a.op ?? 1;
      if (a.op && a.op < 1) ctx.globalCompositeOperation = "multiply";
      for (const s of a.t === "ink" ? a.pts : sigStrokes(a)) {
        ctx.beginPath();
        const [sx, sy] = P(s[0]); ctx.moveTo(sx, sy);
        if (s.length === 1) ctx.lineTo(sx + 0.1, sy + 0.1);
        for (const q of s.slice(1)) { const [x, y] = P(q); ctx.lineTo(x, y); }
        ctx.stroke();
      }
    } else if (a.t === "rect" || a.t === "ellipse") {
      const [x0, y0] = P(a.r.slice(0, 2)), [x1, y1] = P(a.r.slice(2));
      ctx.beginPath();
      if (a.t === "rect") ctx.rect(x0, y0, x1 - x0, y1 - y0);
      else ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (a.t === "arrow") {
      const [x0, y0] = P(a.p.slice(0, 2)), [x1, y1] = P(a.p.slice(2));
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      const ang = Math.atan2(y1 - y0, x1 - x0), L = Math.max(unit * 0.022, lw * 5);
      ctx.beginPath(); ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - L * Math.cos(ang - 0.42), y1 - L * Math.sin(ang - 0.42));
      ctx.lineTo(x1 - L * Math.cos(ang + 0.42), y1 - L * Math.sin(ang + 0.42));
      ctx.closePath(); ctx.fill();
    } else if (a.t === "text") {
      const fs = Math.max(6, (a.fs || 0.03) * unit);
      const [x0, y0] = P(a.r.slice(0, 2)), [x1, y1] = P(a.r.slice(2));
      ctx.translate((x0 + x1) / 2, (y0 + y1) / 2);
      ctx.rotate(((a.arot || 0) * Math.PI) / 180);
      const rw = (a.arot || 0) % 180 ? y1 - y0 : x1 - x0, rh = (a.arot || 0) % 180 ? x1 - x0 : y1 - y0;
      ctx.font = `${fs}px ${TEXT_FONT}`;
      ctx.direction = "rtl"; ctx.textAlign = "right"; ctx.textBaseline = "top";
      a.s.split("\n").forEach((line, k) => ctx.fillText(line, rw / 2, -rh / 2 + k * fs * 1.2));
    }
    ctx.restore();
    if (i === selected) {
      const [x0, y0, x1, y1] = annotBBox(a);
      ctx.save();
      ctx.setLineDash([6, 4]); ctx.strokeStyle = "#2f5bd3"; ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 * W - 6, y0 * H - 6, (x1 - x0) * W + 12, (y1 - y0) * H + 12);
      ctx.restore();
    }
  });
}

// Size of a text box (normalized), measured with the same font the editor draws with.
export function measureText(s, fsFrac, W, H) {
  const c = document.createElement("canvas").getContext("2d");
  const fs = Math.max(6, fsFrac * Math.min(W, H));
  c.font = `${fs}px ${TEXT_FONT}`;
  const lines = s.split("\n");
  const w = Math.max(...lines.map((l) => c.measureText(l).width)) + 4;
  const h = lines.length * fs * 1.2 + 2;
  return [w / W, h / H];
}

// ------------------------------------------------------------------ Hebrew / mixed text (visual order)
const isHeb = (ch) => /[֐-׿יִ-ﭏ₪]/.test(ch);
const isLtr = (ch) => /[A-Za-z0-9À-ɏ]/.test(ch);
const MIRROR = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<" };

// Simplified bidi for an RTL paragraph: returns runs in visual (left-to-right) order.
export function visualRuns(line) {
  const chars = [...line];
  const dir = chars.map((ch) => (isHeb(ch) ? "R" : isLtr(ch) ? "L" : "N"));
  // neutrals take the direction of their neighbours when both sides agree, else the paragraph's (R)
  for (let i = 0; i < dir.length; i++) {
    if (dir[i] !== "N") continue;
    let a = i - 1; while (a >= 0 && dir[a] === "N") a--;
    let b = i + 1; while (b < dir.length && dir[b] === "N") b++;
    const left = a >= 0 ? dir[a] : "R", right = b < dir.length ? dir[b] : "R";
    dir[i] = left === "L" && right === "L" ? "L" : "R";
  }
  const runs = [];
  chars.forEach((ch, i) => {
    if (runs.length && runs[runs.length - 1].d === dir[i]) runs[runs.length - 1].t += ch;
    else runs.push({ d: dir[i], t: ch });
  });
  runs.reverse();
  return runs.map((r) => (r.d === "R" ? { d: "R", t: [...r.t].reverse().map((c) => MIRROR[c] || c).join("") } : r));
}

// ------------------------------------------------------------------ export
let hebFontBytes = null;
async function hebBytes() {
  if (!hebFontBytes) {
    const r = await fetch(new URL("../vendor/NotoSansHebrew-Regular.ttf", import.meta.url));
    hebFontBytes = new Uint8Array(await r.arrayBuffer());
  }
  return hebFontBytes;
}

const hex = (c) => {
  const n = parseInt((c || "#000000").slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

async function libDoc(src) {
  if (!src.libDoc) src.libDoc = await PDFDocument.load(src.bytes, { ignoreEncryption: true });
  return src.libDoc;
}

async function imageBytes(p, maxPx = 2600) {
  // bake rotation + crop into pixels (images have no vector content to preserve)
  const src = sources.get(p.src);
  const [dw] = displaySize(p);
  const scale = Math.min(1, maxPx / Math.max(src.w, src.h));
  const fullW = (p.rot % 180 ? src.h : src.w) * scale;
  const cx = p.crop || [0, 0, 1, 1];
  const c = await renderPage({ ...p, annots: [] }, fullW * (cx[2] - cx[0]), { withAnnots: false });
  const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.88));
  c.width = c.height = 0;
  return new Uint8Array(await blob.arrayBuffer());
}

export async function buildPdf(pages, onProgress) {
  const out = await PDFDocument.create();
  out.registerFontkit(window.fontkit);
  let heb = null, helv = null, hebHas = null;
  const needText = pages.some((p) => p.annots.some((a) => a.t === "text"));
  if (needText) {
    const bytes = await hebBytes();
    heb = await out.embedFont(bytes, { subset: true });
    helv = await out.embedFont(StandardFonts.Helvetica);
    const fk = window.fontkit.create(bytes);
    hebHas = (ch) => fk.hasGlyphForCodePoint(ch.codePointAt(0));
  }
  for (let n = 0; n < pages.length; n++) {
    const p = pages[n];
    onProgress && onProgress(n + 1, pages.length);
    let page, box, R;
    if (p.kind === "pdf") {
      const src = sources.get(p.src);
      const [cp] = await out.copyPages(await libDoc(src), [p.index]);
      page = out.addPage(cp);
      const cb = page.getCropBox();
      box = { x: cb.x, y: cb.y, w: cb.width, h: cb.height };
      R = (p.srcRot + p.rot) % 360;
      page.setRotation(degrees(R));
      if (p.crop) {
        const [x0, y0, x1, y1] = p.crop;
        const a = visToPdf(x0, y0, box, R), b = visToPdf(x1, y1, box, R);
        const minX = Math.min(a[0], b[0]), minY = Math.min(a[1], b[1]);
        page.setCropBox(minX, minY, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      }
    } else {
      const jpg = await out.embedJpg(await imageBytes(p));
      const [w, h] = displaySize(p);
      page = out.addPage([w, h]);
      page.drawImage(jpg, { x: 0, y: 0, width: w, height: h });
      box = { x: 0, y: 0, w, h };
      R = 0;
    }
    if (p.annots.length) drawAnnotsPdf(page, p, box, R, { heb, helv, hebHas });
  }
  return out;
}

// normalized point on the *displayed* page (after rotation R and crop) -> PDF user space
function visToPdf(u, v, box, R, crop = null) {
  if (crop) { u = crop[0] + u * (crop[2] - crop[0]); v = crop[1] + v * (crop[3] - crop[1]); }
  for (let i = 0; i < R / 90; i++) [u, v] = [v, 1 - u];         // undo clockwise quarter turns
  return [box.x + u * box.w, box.y + (1 - v) * box.h];
}

function drawAnnotsPdf(page, p, box, R, fonts) {
  const [W, H] = displaySize(p);
  const unit = Math.min(W, H);
  const crop = p.kind === "pdf" ? p.crop : null;
  const T = (u, v) => visToPdf(u, v, box, R, crop);
  const svgPath = (pts) => pts.map(([u, v], i) => { const [x, y] = T(u, v); return `${i ? "L" : "M"} ${x.toFixed(2)} ${(-y).toFixed(2)}`; }).join(" ");
  for (const a of p.annots) {
    const color = hex(a.c);
    const bw = Math.max(0.3, (a.w || 0.004) * unit);
    if (a.t === "ink" || a.t === "sig") {
      for (const s of a.t === "ink" ? a.pts : sigStrokes(a)) {
        const pts = s.length > 1 ? s : [s[0], [s[0][0] + 0.0005, s[0][1] + 0.0005]];
        page.drawSvgPath(svgPath(pts), { x: 0, y: 0, borderColor: color, borderWidth: bw,
          borderOpacity: a.op ?? 1, borderLineCap: LineCapStyle.Round });
      }
    } else if (a.t === "rect") {
      const [x0, y0, x1, y1] = a.r;
      page.drawSvgPath(svgPath([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]),
        { x: 0, y: 0, borderColor: color, borderWidth: bw });
    } else if (a.t === "ellipse") {
      const [x0, y0, x1, y1] = a.r;
      const c = T((x0 + x1) / 2, (y0 + y1) / 2);
      const e1 = T(x1, (y0 + y1) / 2), e2 = T((x0 + x1) / 2, y1);
      const rx = Math.hypot(e1[0] - c[0], e1[1] - c[1]), ry = Math.hypot(e2[0] - c[0], e2[1] - c[1]);
      const swap = R % 180 !== 0;
      page.drawEllipse({ x: c[0], y: c[1], xScale: swap ? ry : rx, yScale: swap ? rx : ry,
        borderColor: color, borderWidth: bw });
    } else if (a.t === "arrow") {
      const [x0, y0, x1, y1] = a.p;
      page.drawSvgPath(svgPath([[x0, y0], [x1, y1]]), { x: 0, y: 0, borderColor: color, borderWidth: bw,
        borderLineCap: LineCapStyle.Round });
      // arrow head computed on the displayed page (pt), then mapped
      const ax = x0 * W, ay = y0 * H, bx = x1 * W, by = y1 * H;
      const ang = Math.atan2(by - ay, bx - ax), L = Math.max(unit * 0.022, bw * 5);
      const h1 = [(bx - L * Math.cos(ang - 0.42)) / W, (by - L * Math.sin(ang - 0.42)) / H];
      const h2 = [(bx - L * Math.cos(ang + 0.42)) / W, (by - L * Math.sin(ang + 0.42)) / H];
      page.drawSvgPath(svgPath([[x1, y1], h1, h2, [x1, y1]]) + " Z", { x: 0, y: 0, color, borderWidth: 0 });
    } else if (a.t === "text") {
      drawTextPdf(page, a, W, H, unit, T, R, fonts, color);
    }
  }
}

function drawTextPdf(page, a, W, H, unit, T, R, fonts, color) {
  const fs = Math.max(4, (a.fs || 0.03) * unit);
  const arot = a.arot || 0;
  const [x0, y0, x1, y1] = a.r;
  // work in a frame where the text is upright: box corners rotated back by arot
  const cxn = (x0 + x1) / 2, cyn = (y0 + y1) / 2;
  const bwPt = (arot % 180 ? (y1 - y0) * H : (x1 - x0) * W);
  const bhPt = (arot % 180 ? (x1 - x0) * W : (y1 - y0) * H);
  const th = (arot * Math.PI) / 180;
  const ux = [Math.cos(th), Math.sin(th)];     // text "right" direction on the displayed page (pt)
  const uy = [-Math.sin(th), Math.cos(th)];    // text "down" direction
  const toNorm = (dx, dy) => [cxn + (dx * ux[0] + dy * uy[0]) / W, cyn + (dx * ux[1] + dy * uy[1]) / H];
  a.s.split("\n").forEach((line, k) => {
    const runs = visualRuns(line).flatMap((r) => splitByFont(r.t, fonts));
    const sw = fonts.helv.widthOfTextAtSize(" ", fs);
    const total = runs.reduce((s, r) => s + r.t.split(/( +)/).reduce((t, seg) =>
      t + (!seg ? 0 : seg[0] === " " ? sw * seg.length : r.font.widthOfTextAtSize(seg, fs)), 0), 0);
    let dx = bwPt / 2 - total;                                   // right aligned
    const dy = -bhPt / 2 + k * fs * 1.2 + fs * 0.92;             // baseline
    const spaceW = fonts.helv.widthOfTextAtSize(" ", fs);
    for (const r of runs) {
      // spaces are advanced, not drawn: subset fonts may drop the space glyph's width in viewers
      for (const seg of r.t.split(/( +)/)) {
        if (!seg) continue;
        if (seg[0] === " ") { dx += spaceW * seg.length; continue; }
        const [u, v] = toNorm(dx, dy);
        const [x, y] = T(u, v);
        page.drawText(seg, { x, y, size: fs, font: r.font, color, rotate: degrees((R - arot + 360) % 360) });
        dx += r.font.widthOfTextAtSize(seg, fs);
      }
    }
  });
}

function splitByFont(text, { heb, helv, hebHas }) {
  const out = [];
  for (const ch of text) {
    let font = hebHas(ch) ? heb : helv;
    let c = ch;
    if (font === helv) { try { helv.encodeText(ch); } catch (_) { c = "?"; } }
    if (out.length && out[out.length - 1].font === font) out[out.length - 1].t += c;
    else out.push({ font, t: c });
  }
  return out;
}

export async function savePdfBytes(pages, onProgress) {
  if (!pages.length) throw new Error("אין עמודים לשמירה");
  const doc = await buildPdf(pages, onProgress);
  return doc.save({ useObjectStreams: true });
}

// test hook
export const _internal = { visToPdf, sources };
