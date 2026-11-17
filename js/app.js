// PrintHub Mobile - UI
import * as core from "./core.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
// pointer capture can throw (synthetic or already-released pointers); drawing must not depend on it
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } };
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// ------------------------------------------------------------------ state
let pages = [];               // ordered list of page objects (immutable updates)
const selected = new Set();   // page ids
let undoStack = [];
const thumbCache = new Map(); // key -> object URL

function pushUndo() {
  undoStack.push(pages.slice());
  if (undoStack.length > 40) undoStack.shift();
  $("#btnUndo").disabled = false;
}
function undo() {
  if (!undoStack.length) return;
  pages = undoStack.pop();
  for (const id of [...selected]) if (!pages.some((p) => p.id === id)) selected.delete(id);
  $("#btnUndo").disabled = !undoStack.length;
  render();
  toast("הפעולה האחרונה בוטלה");
}

// ------------------------------------------------------------------ helpers
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
async function busy(text, fn) {
  $("#busyText").textContent = text; $("#busy").hidden = false;
  try { return await fn((t) => ($("#busyText").textContent = t)); }
  catch (e) { console.error(e); toast(e.message || String(e), 5000); }
  finally { $("#busy").hidden = true; }
}
const selPages = () => pages.filter((p) => selected.has(p.id));
const selIdx = () => pages.map((p, i) => (selected.has(p.id) ? i : -1)).filter((i) => i >= 0);
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
const thumbKey = (p) => `${p.src}|${p.index}|${p.rot}|${p.crop}|${hash(JSON.stringify(p.annots))}`;
const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ grid
async function thumbUrl(p) {
  const k = thumbKey(p);
  if (thumbCache.has(k)) return thumbCache.get(k);
  const c = await core.renderPage(p, 260);
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
  c.width = c.height = 0;
  const url = URL.createObjectURL(blob);
  thumbCache.set(k, url);
  return url;
}

let sortable = null;
function render() {
  const has = pages.length > 0;
  $("#empty").hidden = has;
  $("#pagesWrap").hidden = !has;
  $("#mainBar").hidden = !has || selected.size > 0;
  $("#selBar").hidden = selected.size === 0;
  $("#docInfo").textContent = has ? `${pages.length} עמודים` : "עריכת PDF וסריקה";
  $("#selCount").textContent = `${selected.size} נבחרו`;
  const grid = $("#grid");
  grid.replaceChildren(...pages.map((p, i) => {
    const t = document.createElement("div");
    t.className = "tile" + (selected.has(p.id) ? " sel" : "");
    t.dataset.id = p.id;
    t.innerHTML = `<div class="thumb"><img alt=""></div><div class="num">${i + 1}</div>
      <div class="check"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></div>
      ${p.annots.length ? `<div class="marks">${p.annots.length} סימונים</div>` : ""}`;
    t.title = p.label || "";
    thumbUrl(p).then((u) => { const im = t.querySelector("img"); if (im) im.src = u; });
    return t;
  }));
  if (!sortable && window.Sortable) {
    sortable = Sortable.create(grid, {
      animation: 160, delay: 220, delayOnTouchOnly: true, touchStartThreshold: 6,
      onEnd: (e) => {
        if (e.oldIndex === e.newIndex) return;
        pushUndo();
        const arr = pages.slice();
        const [m] = arr.splice(e.oldIndex, 1);
        arr.splice(e.newIndex, 0, m);
        pages = arr;
        render();
      },
    });
  }
}

$("#grid").addEventListener("click", (e) => {
  const t = e.target.closest(".tile");
  if (!t) return;
  const id = t.dataset.id;
  selected.has(id) ? selected.delete(id) : selected.add(id);
  render();
});
$("#grid").addEventListener("dblclick", (e) => {
  const t = e.target.closest(".tile");
  if (!t) return;
  selected.clear(); selected.add(t.dataset.id);
  render(); openEditor();
});
$("#btnSelNone").onclick = () => { selected.clear(); render(); };
$("#btnSelAll").onclick = () => { pages.forEach((p) => selected.add(p.id)); render(); };
$("#btnUndo").onclick = undo;

// ------------------------------------------------------------------ adding files / camera
async function addFiles(files) {
  const list = [...files];
  if (!list.length) return;
  await busy("פותח קבצים...", async (say) => {
    const added = [], errors = [];
    for (const [k, f] of list.entries()) {
      say(`פותח ${k + 1} מתוך ${list.length}...`);
      try { added.push(...(await core.addFile(f))); } catch (e) { errors.push(e.message); }
    }
    if (added.length) {
      pushUndo();
      pages = pages.concat(added);
      render();
      toast(`נוספו ${added.length} עמודים`);
      setTimeout(() => $("#grid").lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" }), 150);
    }
    if (errors.length) toast(errors.join(" · "), 6000);
  });
}
$("#fileInput").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
$("#cameraInput").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) scanPhoto(f); };
const openFiles = () => $("#fileInput").click();
const openCamera = () => $("#cameraInput").click();

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  ({ open: openFiles, camera: openCamera, add: addMenu, save: saveMenu, print: printDoc })[b.dataset.act]?.();
});

// drag & drop (desktop browsers)
document.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
document.addEventListener("drop", (e) => { if (e.dataTransfer?.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });

// ------------------------------------------------------------------ bottom sheets
function sheet(html, bind) {
  const s = $("#sheet"), b = $("#sheetBack");
  s.innerHTML = html; s.hidden = b.hidden = false;
  const close = () => { s.hidden = b.hidden = true; s.innerHTML = ""; };
  b.onclick = close;
  bind && bind(s, close);
  return close;
}
const item = (act, icon, title, sub = "") =>
  `<button class="item" data-i="${act}"><svg viewBox="0 0 24 24">${icon}</svg><span>${title}${sub ? `<small>${sub}</small>` : ""}</span></button>`;
const IC = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  share: '<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7h14v-7"/>',
  down: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M4 18v2h16v-2"/>',
  pages: '<rect x="4" y="3" width="11" height="14" rx="1.5"/><path d="M9 21h9a2 2 0 0 0 2-2V8"/>',
  split: '<path d="M6 3h8l4 4v14H6z"/><path d="M3 12h18"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-9 8"/>',
  sign: '<path d="M3 17c3-6 5-9 6-7s-3 8 0 7 4-6 6-5 1 4 3 4 3-2 3-2"/><path d="M3 21h18"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  install: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M12 7v7"/><path d="M9 11l3 3 3-3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.01"/>',
};

function addMenu() {
  sheet(`<h3>הוספת עמודים</h3>${item("files", IC.folder, "קבצים מהטלפון", "PDF ותמונות, אפשר כמה בבת אחת")}
    ${item("camera", IC.camera, "סריקה במצלמה", "צילום, חיתוך ושיפור מסמך")}`, (s, close) => {
    s.querySelector('[data-i="files"]').onclick = () => { close(); openFiles(); };
    s.querySelector('[data-i="camera"]').onclick = () => { close(); openCamera(); };
  });
}

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; });
$("#btnMenu").onclick = () => {
  const hasSig = !!loadSignature();
  sheet(`<h3>אפשרויות</h3>
    ${item("sig", IC.sign, hasSig ? "ציור חתימה חדשה" : "ציור חתימה", "נשמרת בטלפון לשימוש חוזר")}
    ${pages.length ? item("clear", IC.trash, "ניקוי המסמך", "הקבצים המקוריים לא נמחקים") : ""}
    ${installPrompt ? item("install", IC.install, "התקנה במסך הבית") : ""}
    ${!standalone && isIOS ? item("iosinstall", IC.install, "התקנה באייפון", "שיתוף ← הוסף למסך הבית") : ""}
    ${item("about", IC.info, "אודות PrintHub", "עובד גם בלי אינטרנט אחרי הפתיחה הראשונה")}`, (s, close) => {
    s.querySelector('[data-i="sig"]').onclick = () => { close(); openSigPad(); };
    s.querySelector('[data-i="clear"]')?.addEventListener("click", () => {
      close(); pushUndo(); pages = []; selected.clear(); render(); toast("המסמך נוקה. אפשר לבטל עם החץ למעלה");
    });
    s.querySelector('[data-i="install"]')?.addEventListener("click", async () => { close(); installPrompt.prompt(); installPrompt = null; });
    s.querySelector('[data-i="iosinstall"]')?.addEventListener("click", () => { close(); toast("בספארי: כפתור השיתוף ← 'הוסף למסך הבית'", 6000); });
    s.querySelector('[data-i="about"]').onclick = () => { close(); toast("PrintHub Mobile · עריכת PDF, סריקה והדפסה. הקבצים לא יוצאים מהטלפון.", 5000); };
  });
};

// ------------------------------------------------------------------ selection tools
$("#selBar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tool]");
  if (!b) return;
  const act = b.dataset.tool;
  const idx = selIdx();
  if (!idx.length) return;
  if (act === "draw") return openEditor();
  if (act === "crop") return openPageCrop();
  pushUndo();
  if (act === "rotate") {
    pages = pages.map((p) => (selected.has(p.id) ? core.rotatePage(p, 90) : p));
  } else if (act === "dup") {
    const copies = selPages().map(core.clonePage);
    const at = idx[idx.length - 1] + 1;
    pages = [...pages.slice(0, at), ...copies, ...pages.slice(at)];
    selected.clear(); copies.forEach((c) => selected.add(c.id));
  } else if (act === "delete") {
    pages = pages.filter((p) => !selected.has(p.id));
    toast(`${idx.length} עמודים נמחקו · אפשר לבטל`);
    selected.clear();
  } else if (act === "earlier" || act === "later") {
    const step = act === "earlier" ? -1 : 1;
    if ((step < 0 && idx[0] === 0) || (step > 0 && idx[idx.length - 1] === pages.length - 1)) { undoStack.pop(); return; }
    const moving = selPages(), rest = pages.filter((p) => !selected.has(p.id));
    const at = Math.max(0, Math.min(rest.length, idx[0] + step));
    pages = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  }
  render();
});

// ------------------------------------------------------------------ crop (pages + camera)
let cropState = null;
function fitCanvas(stage, canvas, w, h) {
  const r = stage.getBoundingClientRect();
  const s = Math.min((r.width - 24) / w, (r.height - 24) / h);
  canvas.style.width = `${w * s}px`; canvas.style.height = `${h * s}px`;
  return s;
}
async function openCropper(source, { title = "חיתוך", scan = false, initial = null, onDone }) {
  // source: canvas with the content to crop
  $("#cropper").hidden = false;
  $("#crTitle").textContent = title;
  $("#crEnhanceWrap").hidden = !scan;
  $("#crDone").textContent = scan ? "הוספה" : "חיתוך";
  const cv = $("#crCanvas");
  cv.width = source.width; cv.height = source.height;
  cv.getContext("2d").drawImage(source, 0, 0);
  await new Promise((r) => requestAnimationFrame(r));
  fitCanvas($("#crStage"), cv, cv.width, cv.height);
  cropState = { box: initial || [0, 0, 1, 1], onDone, source };
  layoutCropBox();
}
function layoutCropBox() {
  const cv = $("#crCanvas"), st = $("#crStage").getBoundingClientRect(), r = cv.getBoundingClientRect();
  const [x0, y0, x1, y1] = cropState.box, b = $("#crBox");
  Object.assign(b.style, { left: `${r.left - st.left + x0 * r.width}px`, top: `${r.top - st.top + y0 * r.height}px`,
    width: `${(x1 - x0) * r.width}px`, height: `${(y1 - y0) * r.height}px` });
}
(function cropHandles() {
  let drag = null;
  const box = $("#crBox");
  box.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    capture(box, e);
    drag = { h: e.target.dataset.h || "move", x: e.clientX, y: e.clientY, start: cropState.box.slice() };
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const r = $("#crCanvas").getBoundingClientRect();
    const dx = (e.clientX - drag.x) / r.width, dy = (e.clientY - drag.y) / r.height;
    let [x0, y0, x1, y1] = drag.start;
    const min = 0.05, cl = (v) => Math.max(0, Math.min(1, v));
    if (drag.h === "move") { const w = x1 - x0, h = y1 - y0; x0 = cl(x0 + dx); y0 = cl(y0 + dy); x0 = Math.min(x0, 1 - w); y0 = Math.min(y0, 1 - h); x1 = x0 + w; y1 = y0 + h; }
    if (drag.h.includes("n")) y0 = Math.min(cl(y0 + dy), y1 - min);
    if (drag.h.includes("s")) y1 = Math.max(cl(y1 + dy), y0 + min);
    if (drag.h.includes("w")) x0 = Math.min(cl(x0 + dx), x1 - min);
    if (drag.h.includes("e")) x1 = Math.max(cl(x1 + dx), x0 + min);
    cropState.box = [x0, y0, x1, y1];
    layoutCropBox();
  });
  box.addEventListener("pointerup", () => (drag = null));
})();
function autoTrim(canvas, pad = 0.015) {
  const w = Math.min(500, canvas.width), h = Math.round((canvas.height * w) / canvas.width);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d"); x.drawImage(canvas, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = (j * w + i) * 4;
    if (d[k] * 0.3 + d[k + 1] * 0.59 + d[k + 2] * 0.11 < 225) { x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, j); y1 = Math.max(y1, j); }
  }
  if (x1 < 0) return [0, 0, 1, 1];
  return [Math.max(0, x0 / w - pad), Math.max(0, y0 / h - pad), Math.min(1, x1 / w + pad), Math.min(1, y1 / h + pad)];
}
$("#crAuto").onclick = () => { cropState.box = autoTrim(cropState.source); layoutCropBox(); };
$("#crFull").onclick = () => { cropState.box = [0, 0, 1, 1]; layoutCropBox(); };
$("#crCancel").onclick = () => { $("#cropper").hidden = true; cropState = null; };
$("#crDone").onclick = async () => {
  const st = cropState; $("#cropper").hidden = true; cropState = null;
  await st.onDone(st.box, $("#crEnhance").checked);
};
window.addEventListener("resize", () => { if (cropState) { fitCanvas($("#crStage"), $("#crCanvas"), $("#crCanvas").width, $("#crCanvas").height); layoutCropBox(); } });

async function openPageCrop() {
  const idx = selIdx();
  if (!idx.length) return;
  const i = idx[0];
  await busy("מכין...", async () => {
    const c = await core.renderPage(pages[i], 1100);
    await openCropper(c, { title: `חיתוך עמוד ${i + 1}`, onDone: (box) => {
      if (box.join() === "0,0,1,1") return;
      pushUndo();
      pages = pages.map((p, k) => (k === i ? core.cropPage(p, box) : p));
      render(); toast(`עמוד ${i + 1} נחתך`);
    } });
  });
}

// camera scan: crop + optional "document" enhancement, then add as an image page
async function scanPhoto(file) {
  await busy("מכין את הצילום...", async () => {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
    const img = bmp || await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); });
    const scale = Math.min(1, 2400 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    await openCropper(c, { title: "סריקה במצלמה", scan: true, initial: autoTrim(c, 0.01), onDone: async (box, enhance) => {
      const [x0, y0, x1, y1] = box;
      const out = document.createElement("canvas");
      out.width = Math.round((x1 - x0) * c.width); out.height = Math.round((y1 - y0) * c.height);
      const ctx = out.getContext("2d");
      ctx.drawImage(c, -x0 * c.width, -y0 * c.height);
      if (enhance) enhanceDocument(ctx, out.width, out.height);
      const blob = await new Promise((r) => out.toBlob(r, "image/jpeg", 0.9));
      const page = await core.pageFromImage(blob, "סריקה במצלמה");
      pushUndo(); pages = pages.concat(page); render();
      toast("העמוד נסרק ונוסף · אפשר לסרוק עוד");
    } });
  });
}
// grayscale + white background + stronger text, keeps signatures/stamps readable
function enhanceDocument(ctx, w, h) {
  const im = ctx.getImageData(0, 0, w, h), d = im.data, hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) | 0; d[i] = g; hist[g]++; }
  const n = w * h; let acc = 0, lo = 0, hi = 255;
  for (let g = 0; g < 256; g++) { acc += hist[g]; if (acc < n * 0.02) lo = g; if (acc < n * 0.6) hi = g; }
  hi = Math.max(hi, lo + 40);
  for (let i = 0; i < d.length; i += 4) {
    let v = (d[i] - lo) / (hi - lo); v = Math.max(0, Math.min(1, v)); v = Math.pow(v, 1.6);
    d[i] = d[i + 1] = d[i + 2] = Math.round(v * 255);
  }
  ctx.putImageData(im, 0, 0);
}

// ------------------------------------------------------------------ drawing editor
const COLORS = ["#111111", "#1f4fd1", "#d0302a", "#1a8f3c", "#f2c200"];
const WIDTHS = { pen: [0.0025, 0.004, 0.007], marker: [0.015, 0.024, 0.036], shape: [0.002, 0.0035, 0.006],
                 text: [0.022, 0.03, 0.045] };
const TOOLS = [
  ["select", "בחירה", '<path d="M5 3l14 7-6 2-2 6z"/>'],
  ["pen", "עט", '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M14 7l3 3"/>'],
  ["marker", "מרקר", '<path d="M9 15l-3 5h5l1.5-2.5"/><path d="M9 15l7-11 4 2.5-7 11z"/>'],
  ["text", "טקסט", '<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>'],
  ["sign", "חתימה", IC.sign],
  ["rect", "מלבן", '<rect x="4" y="5" width="16" height="14" rx="1.5"/>'],
  ["ellipse", "עיגול", '<ellipse cx="12" cy="12" rx="8.5" ry="7"/>'],
  ["arrow", "חץ", '<path d="M5 19L19 5"/><path d="M10 5h9v9"/>'],
];
const HINTS = { select: "הקש על סימון כדי לבחור אותו, גרור להזזה. הקשה כפולה על טקסט לעריכה.",
  pen: "צייר עם האצבע", marker: "סמן מעל טקסט", text: "הקש במקום שבו יתחיל הטקסט",
  sign: "הקש במקום שבו תופיע החתימה", rect: "גרור לציור מלבן", ellipse: "גרור לציור עיגול", arrow: "גרור מההתחלה אל החץ" };

const ed = { pageIdx: -1, page: null, annots: [], undo: [], tool: "pen", color: COLORS[1], size: 1, sel: -1,
             cur: null, drag: null, W: 0, H: 0, penColor: null };

$("#toolRow").innerHTML = TOOLS.map(([k, t, ic]) => `<button data-t="${k}"><svg viewBox="0 0 24 24">${ic}</svg>${t}</button>`).join("");
$("#swatches").innerHTML = COLORS.map((c) => `<button data-c="${c}" style="background:${c}"></button>`).join("");
$("#toolRow").onclick = (e) => { const b = e.target.closest("[data-t]"); if (b) setTool(b.dataset.t); };
$("#swatches").onclick = (e) => { const b = e.target.closest("[data-c]"); if (b) setColor(b.dataset.c); };
$("#sizeSeg").onclick = (e) => { const b = e.target.closest("[data-size]"); if (!b) return; ed.size = +b.dataset.size;
  $$("#sizeSeg button").forEach((x) => x.classList.toggle("on", x === b)); };

function setTool(t) {
  const prev = ed.tool;
  if (t === "marker" && prev !== "marker") { ed.penColor = ed.color; setColor("#f2c200"); }
  else if (prev === "marker" && t !== "marker" && ed.penColor) setColor(ed.penColor);
  ed.tool = t;
  if (t !== "select") ed.sel = -1;
  $$("#toolRow button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
  $("#edHint").textContent = HINTS[t] || "";
  drawInk();
}
function setColor(c) { ed.color = c; $$("#swatches button").forEach((b) => b.classList.toggle("on", b.dataset.c === c)); }

async function openEditor() {
  const idx = selIdx();
  if (!idx.length) return;
  ed.pageIdx = idx[0];
  ed.page = pages[ed.pageIdx];
  ed.annots = ed.page.annots.map((a) => structuredClone(a));
  ed.undo = []; ed.sel = -1; ed.cur = null;
  $("#edTitle").textContent = `עמוד ${ed.pageIdx + 1}`;
  $("#editor").hidden = false;
  await new Promise((r) => requestAnimationFrame(r));
  await busy("טוען עמוד...", async () => {
    const stage = $("#edStage").getBoundingClientRect();
    const [dw, dh] = core.displaySize(ed.page);
    const s = Math.min((stage.width - 24) / dw, (stage.height - 24) / dh);
    const cssW = dw * s, cssH = dh * s, dpr = Math.min(2, window.devicePixelRatio || 1);
    const base = await core.renderPage(ed.page, cssW * dpr, { withAnnots: false });
    for (const id of ["#edBase", "#edInk"]) {
      const c = $(id); c.width = base.width; c.height = base.height;
      c.style.width = `${cssW}px`; c.style.height = `${cssH}px`;
    }
    $("#edBase").getContext("2d").drawImage(base, 0, 0);
    ed.W = base.width; ed.H = base.height;
    setTool(ed.tool); setColor(ed.color);
  });
}
function drawInk() {
  const c = $("#edInk"); if (!ed.W) return;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  core.drawAnnots(ctx, ed.cur ? [...ed.annots, ed.cur] : ed.annots, ed.W, ed.H, ed.sel);
}
const edPush = () => { ed.undo.push(ed.annots.map((a) => structuredClone(a))); if (ed.undo.length > 60) ed.undo.shift(); };
function norm(e) {
  const r = $("#edInk").getBoundingClientRect();
  return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
}
function hitTest(pt) {
  const tol = 14 / $("#edInk").getBoundingClientRect().width;
  for (let i = ed.annots.length - 1; i >= 0; i--) {
    const [x0, y0, x1, y1] = core.annotBBox(ed.annots[i]);
    if (pt[0] >= x0 - tol && pt[0] <= x1 + tol && pt[1] >= y0 - tol && pt[1] <= y1 + tol) return i;
  }
  return -1;
}
let lastTap = 0;
(function inkEvents() {
  const c = $("#edInk");
  c.addEventListener("pointerdown", (e) => {
    e.preventDefault(); capture(c, e);
    const pt = norm(e), t = ed.tool, w = (k) => WIDTHS[k][ed.size];
    if (t === "select") {
      ed.sel = hitTest(pt);
      const now = Date.now();
      if (ed.sel >= 0 && ed.annots[ed.sel].t === "text" && now - lastTap < 350) { editText(ed.sel); lastTap = 0; return; }
      lastTap = now;
      if (ed.sel >= 0) { edPush(); ed.drag = { start: pt, orig: ed.annots[ed.sel] }; }
    } else if (t === "pen" || t === "marker") {
      ed.cur = { t: "ink", pts: [[pt]], c: ed.color, w: w(t), op: t === "marker" ? 0.38 : 1 };
    } else if (t === "rect" || t === "ellipse") {
      ed.cur = { t, r: [pt[0], pt[1], pt[0], pt[1]], c: ed.color, w: w("shape"), o: pt };
    } else if (t === "arrow") {
      ed.cur = { t: "arrow", p: [pt[0], pt[1], pt[0], pt[1]], c: ed.color, w: w("shape") };
    } else if (t === "text") {
      addText(pt);
    } else if (t === "sign") {
      placeSignature(pt);
    }
    drawInk();
  });
  c.addEventListener("pointermove", (e) => {
    const pt = norm(e);
    if (ed.drag) {
      ed.annots[ed.sel] = core.translateAnnot(ed.drag.orig, pt[0] - ed.drag.start[0], pt[1] - ed.drag.start[1]);
    } else if (ed.cur) {
      if (ed.cur.t === "ink") ed.cur.pts[0].push(pt);
      else if (ed.cur.t === "arrow") ed.cur.p = [ed.cur.p[0], ed.cur.p[1], pt[0], pt[1]];
      else { const [ox, oy] = ed.cur.o; ed.cur.r = [Math.min(ox, pt[0]), Math.min(oy, pt[1]), Math.max(ox, pt[0]), Math.max(oy, pt[1])]; }
    } else return;
    drawInk();
  });
  const end = () => {
    if (ed.drag) { ed.drag = null; return; }
    if (!ed.cur) return;
    const a = ed.cur; ed.cur = null; delete a.o;
    const [x0, y0, x1, y1] = core.annotBBox(a);
    if (a.t === "ink" || (x1 - x0) > 0.01 || (y1 - y0) > 0.01) { edPush(); ed.annots.push(a); }
    drawInk();
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);
})();
$("#edUndo").onclick = () => { if (ed.undo.length) { ed.annots = ed.undo.pop(); ed.sel = -1; drawInk(); } };
$("#edDelete").onclick = () => { if (ed.sel >= 0) { edPush(); ed.annots.splice(ed.sel, 1); ed.sel = -1; drawInk(); } else toast("בחר סימון בכלי 'בחירה'"); };
$("#edCancel").onclick = () => { $("#editor").hidden = true; };
$("#edDone").onclick = () => {
  $("#editor").hidden = true;
  if (JSON.stringify(ed.annots) === JSON.stringify(ed.page.annots)) return;
  pushUndo();
  pages = pages.map((p, k) => (k === ed.pageIdx ? { ...p, annots: ed.annots } : p));
  render();
  toast("העמוד עודכן · לחץ 'שמירה ושיתוף' ליצירת הקובץ");
};

// text
function askText(initial = "") {
  return new Promise((resolve) => {
    const m = $("#textSheet"), t = $("#textInput");
    t.value = initial; m.hidden = false;
    setTimeout(() => t.focus(), 50);
    const done = (v) => { m.hidden = true; $("#textOk").onclick = $("#textCancel").onclick = null; resolve(v); };
    $("#textOk").onclick = () => done(t.value);
    $("#textCancel").onclick = () => done(null);
  });
}
function textBox(pt, s, fs) {
  // Hebrew reads right-to-left: the tapped point is where the text starts (its right edge)
  const [wn, hn] = core.measureText(s, fs, ed.W, ed.H);
  const x0 = Math.max(0, pt[0] - wn), x1 = Math.min(1, x0 + wn);
  return [x0, pt[1], x1, Math.min(1, pt[1] + hn)];
}
async function addText(pt) {
  const s = await askText();
  if (!s || !s.trim()) return;
  const fs = WIDTHS.text[ed.size];
  edPush();
  ed.annots.push({ t: "text", r: textBox(pt, s, fs), s, c: ed.color, fs });
  setTool("select"); ed.sel = ed.annots.length - 1; drawInk();
}
async function editText(i) {
  const a = ed.annots[i];
  const s = await askText(a.s);
  if (s === null) return;
  edPush();
  if (!s.trim()) ed.annots.splice(i, 1);
  else ed.annots[i] = { ...a, s, r: textBox(a.r.slice(0, 2), s, a.fs) };
  ed.sel = -1; drawInk();
}

// signature
const SIG_KEY = "printhub.signature";
const loadSignature = () => { try { return JSON.parse(localStorage.getItem(SIG_KEY)); } catch (_) { return null; } };
let sigResolve = null;
function openSigPad() {
  return new Promise((resolve) => {
    sigResolve = resolve;
    $("#sigPad").hidden = false;
    const c = $("#sigCanvas");
    requestAnimationFrame(() => {
      const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      c.width = r.width * dpr; c.height = r.height * dpr;
      sigStrokes = []; drawSig();
    });
  });
}
let sigStrokes = [];
let sigDown = false;
function drawSig() {
  const c = $("#sigCanvas"), x = c.getContext("2d"), dpr = window.devicePixelRatio || 1;
  x.clearRect(0, 0, c.width, c.height);
  x.strokeStyle = "#d0d4da"; x.setLineDash([6, 6]); x.lineWidth = dpr;
  x.beginPath(); x.moveTo(24 * dpr, c.height - 40 * dpr); x.lineTo(c.width - 24 * dpr, c.height - 40 * dpr); x.stroke();
  x.setLineDash([]); x.strokeStyle = "#111"; x.lineWidth = 2.6 * dpr; x.lineCap = x.lineJoin = "round";
  for (const s of sigStrokes) { x.beginPath(); s.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py))); x.stroke(); }
}
(function sigEvents() {
  const c = $("#sigCanvas");
  const pos = (e) => { const r = c.getBoundingClientRect(), dpr = c.width / r.width; return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
  c.addEventListener("pointerdown", (e) => { e.preventDefault(); capture(c, e); sigDown = true; sigStrokes.push([pos(e)]); drawSig(); });
  c.addEventListener("pointerup", () => (sigDown = false));
  c.addEventListener("pointercancel", () => (sigDown = false));
  c.addEventListener("pointermove", (e) => { if (e.buttons || e.pointerType === "touch") { const s = sigStrokes[sigStrokes.length - 1]; if (s && sigDown) { s.push(pos(e)); drawSig(); } } });
})();
$("#sigClear").onclick = () => { sigStrokes = []; drawSig(); };
$("#sigCancel").onclick = () => { $("#sigPad").hidden = true; sigResolve && sigResolve(null); };
$("#sigSave").onclick = () => {
  const strokes = sigStrokes.filter((s) => s.length > 1);
  if (!strokes.length) { toast("לא צוירה חתימה"); return; }
  const xs = strokes.flat().map((p) => p[0]), ys = strokes.flat().map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(1, Math.max(...xs) - x0), h = Math.max(1, Math.max(...ys) - y0);
  const sig = { pts: strokes.map((s) => s.map(([x, y]) => [(x - x0) / w, (y - y0) / h])), aspect: w / h };
  localStorage.setItem(SIG_KEY, JSON.stringify(sig));
  $("#sigPad").hidden = true;
  toast("החתימה נשמרה בטלפון");
  sigResolve && sigResolve(sig);
};
async function placeSignature(pt) {
  const sig = loadSignature() || (await openSigPad());
  if (!sig) return;
  const ok = (v) => Number.isFinite(v);
  if (!ok(pt[0]) || !ok(pt[1])) pt = [0.5, 0.5];
  const aspect = Math.min(8, Math.max(0.5, ok(sig.aspect) ? sig.aspect : 3));
  const wN = 0.32, hN = (wN * (ed.W || 1)) / (ed.H || 1) / aspect;
  let x0 = Math.min(Math.max(0, pt[0] - wN / 2), 1 - wN), y0 = Math.min(Math.max(0, pt[1] - hN / 2), 1 - hN);
  if (!ok(x0) || !ok(y0)) { x0 = 0.34; y0 = 0.45; }
  edPush();
  ed.annots.push({ t: "sig", r: [x0, y0, x0 + wN, y0 + hN], pts: sig.pts, c: ed.color === "#f2c200" ? COLORS[1] : ed.color,
                   w: WIDTHS.pen[1] });
  setTool("select"); ed.sel = ed.annots.length - 1; drawInk();
  toast("גרור את החתימה למקום המדויק");
}

// ------------------------------------------------------------------ save / share / print
function fileName(base) {
  const n = (base || `PrintHub_${today()}`).trim().replace(/[\\/:*?"<>|]+/g, "_");
  return /\.pdf$/i.test(n) ? n : `${n}.pdf`;
}
async function deliver(files, preferShare) {
  // Share sheet on phones (save to Files / Drive, send by WhatsApp or mail, print on iPhone), else download.
  if (preferShare && navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title: files[0].name }); return "shared"; }
    catch (e) { if (e.name === "AbortError") return "cancelled"; }
  }
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    await new Promise((r) => setTimeout(r, 350));
  }
  return "downloaded";
}
async function exportPdf(list, name, share) {
  await busy("יוצר PDF...", async (say) => {
    const bytes = await core.savePdfBytes(list, (i, n) => say(`מעבד עמוד ${i} מתוך ${n}...`));
    const r = await deliver([new File([bytes], fileName(name), { type: "application/pdf" })], share);
    if (r !== "cancelled") toast(r === "shared" ? "הקובץ שותף" : `נשמר: ${fileName(name)}`);
  });
}
function saveMenu() {
  const canShare = !!navigator.canShare;
  const nSel = selected.size;
  sheet(`<h3>שמירה ושיתוף</h3>
    <div class="field"><input type="text" id="fname" value="PrintHub_${today()}" aria-label="שם הקובץ"></div>
    ${canShare ? item("share", IC.share, "שיתוף PDF", "וואטסאפ, מייל, Drive, שמירה לקבצים") : ""}
    ${item("download", IC.down, "הורדה לטלפון", "PDF אחד מכל העמודים")}
    ${nSel ? item("selected", IC.pages, `רק ${nSel} העמודים שנבחרו`) : ""}
    ${item("split", IC.split, "פיצול לעמודים", "קובץ PDF נפרד לכל עמוד")}
    ${item("jpg", IC.image, "תמונות JPG", "תמונה לכל עמוד")}`, (s, close) => {
    const name = () => s.querySelector("#fname").value;
    const on = (k, fn) => s.querySelector(`[data-i="${k}"]`)?.addEventListener("click", () => { const n = name(); close(); fn(n); });
    on("share", (n) => exportPdf(pages, n, true));
    on("download", (n) => exportPdf(pages, n, false));
    on("selected", (n) => exportPdf(selPages(), n, canShare));
    on("split", (n) => busy("מפצל...", async (say) => {
      const files = [];
      for (const [i, p] of pages.entries()) {
        say(`עמוד ${i + 1} מתוך ${pages.length}...`);
        files.push(new File([await core.savePdfBytes([p])], fileName(`${n}_${String(i + 1).padStart(2, "0")}`), { type: "application/pdf" }));
      }
      const r = await deliver(files, canShare);
      if (r !== "cancelled") toast(`${files.length} קבצים`);
    }));
    on("jpg", (n) => busy("יוצר תמונות...", async (say) => {
      const files = [];
      for (const [i, p] of pages.entries()) {
        say(`עמוד ${i + 1} מתוך ${pages.length}...`);
        const c = await core.renderPage(p, 1600);
        const b = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
        files.push(new File([b], `${n}_${String(i + 1).padStart(2, "0")}.jpg`, { type: "image/jpeg" }));
      }
      const r = await deliver(files, canShare);
      if (r !== "cancelled") toast(`${files.length} תמונות`);
    }));
  });
}

async function printDoc() {
  if (!pages.length) return;
  if (isIOS && standalone) {
    // iOS home-screen apps cannot open the print dialog; the share sheet has "Print"
    toast("בחר 'הדפסה' בתפריט השיתוף", 5000);
    return exportPdf(pages, `PrintHub_${today()}`, true);
  }
  await busy("מכין להדפסה...", async (say) => {
    const area = $("#printArea");
    area.replaceChildren();
    for (const [i, p] of pages.entries()) {
      say(`מכין עמוד ${i + 1} מתוך ${pages.length}...`);
      const c = await core.renderPage(p, 1240);
      const b = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
      const im = new Image(); im.src = URL.createObjectURL(b);
      await im.decode().catch(() => {});
      const d = document.createElement("div"); d.className = "pp"; d.appendChild(im); area.appendChild(d);
    }
  });
  window.print();
  toast("בחר את המדפסת שלך בחלון ההדפסה");
}
window.addEventListener("afterprint", () => {
  $$("#printArea img").forEach((im) => URL.revokeObjectURL(im.src));
  $("#printArea").replaceChildren();
});

// ------------------------------------------------------------------ PWA: offline + files shared from other apps
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW registration failed", e));
}
async function receiveShared() {
  if (!new URLSearchParams(location.search).has("shared") || !("caches" in window)) return;
  history.replaceState(null, "", location.pathname);
  const cache = await caches.open("printhub-shared");
  const files = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    const b = await res.blob();
    files.push(new File([b], decodeURIComponent(res.headers.get("x-name") || "shared"), { type: b.type }));
    await cache.delete(req);
  }
  if (files.length) addFiles(files);
}

render();
receiveShared();
window.__printhub = { core, get pages() { return pages; }, set pages(v) { pages = v; render(); }, selected, render, ed, addFiles };
