// Printer scanning over eSCL (AirScan / Mopria), the same protocol the desktop app uses.
// Browsers block it (the printer sends no CORS headers), so in the Android app requests go
// through Capacitor's native HTTP. For tests, a proxy base URL can be injected instead.

const NS = { scan: "http://schemas.hp.com/imaging/escl/2011/05/03", pwg: "http://www.pwg.org/schemas/2010/12/sm" };
const COLOR = { color: "RGB24", gray: "Grayscale8", bw: "BlackAndWhite1" };
const STORE = "printhub.scanners";

export const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

// ------------------------------------------------------------------ transport
let testBase = null;                      // e.g. "http://127.0.0.1:8766/__printer/" (test proxy)
export function useTestProxy(base) { testBase = base; }
export const available = () => isNative() || !!testBase;

const lower = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]));
function b64ToBytes(b64) {
  const bin = atob(b64.replace(/^data:[^,]*,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// returns { status, headers (lowercase), text?, bytes? }
async function http(ip, method, path, { body = null, binary = false, timeout = 15000 } = {}) {
  if (testBase) {
    // browsers queue requests to one origin (6 at a time); the proxy answers fast, so allow queueing time
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.max(timeout, 30000));
    try {
      const r = await fetch(`${testBase}${ip}${path}`, { method, body, signal: ctl.signal,
        headers: body ? { "Content-Type": "text/xml" } : {} });
      const headers = lower(Object.fromEntries(r.headers.entries()));
      return binary ? { status: r.status, headers, bytes: new Uint8Array(await r.arrayBuffer()) }
                    : { status: r.status, headers, text: await r.text() };
    } finally { clearTimeout(t); }
  }
  const Http = window.Capacitor.Plugins.CapacitorHttp;
  const r = await Http.request({
    url: `http://${ip}${path}`, method, data: body || undefined,
    headers: body ? { "Content-Type": "text/xml" } : {},
    responseType: binary ? "blob" : "text", connectTimeout: timeout, readTimeout: timeout,
  });
  const headers = lower(r.headers);
  if (binary) {
    const bytes = typeof r.data === "string" ? b64ToBytes(r.data) : new Uint8Array(r.data || []);
    return { status: r.status, headers, bytes };
  }
  return { status: r.status, headers, text: typeof r.data === "string" ? r.data : JSON.stringify(r.data) };
}

// ------------------------------------------------------------------ printer info
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`));
  return m ? m[1].trim() : "";
};

export async function probe(ip, timeout = 2500) {
  const r = await http(ip, "GET", "/eSCL/ScannerCapabilities", { timeout });
  if (r.status !== 200 || !/ScannerCapabilities/.test(r.text)) throw new Error("not an eSCL scanner");
  return { ip, model: tag(r.text, "MakeAndModel") || "Scanner", serial: tag(r.text, "SerialNumber"),
           uuid: tag(r.text, "UUID") };
}

export async function status(ip) {
  const r = await http(ip, "GET", "/eSCL/ScannerStatus", { timeout: 5000 });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return tag(r.text, "State") || "Unknown";
}

// Look for scanners on the usual home subnets (a web view cannot read the phone's own IP).
export async function discover(onProgress, subnets = ["192.168.1", "192.168.0", "10.0.0", "192.168.2", "10.0.1"]) {
  const found = [];
  for (const net of subnets) {
    const ips = Array.from({ length: 254 }, (_, i) => `${net}.${i + 1}`);
    let done = 0;
    const queue = ips.slice();
    const worker = async () => {
      while (queue.length) {
        const ip = queue.shift();
        try { found.push(await probe(ip, 900)); } catch (_) { /* nothing there */ }
        done++;
        onProgress && onProgress(`מחפש ב-${net}.x (${done}/254)`);
      }
    };
    await Promise.all(Array.from({ length: 32 }, worker));
    if (found.length) break;                // stop at the first subnet that has scanners
  }
  return found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

// ------------------------------------------------------------------ saved scanners
export function saved() { try { return JSON.parse(localStorage.getItem(STORE)) || { list: [], active: "" }; } catch (_) { return { list: [], active: "" }; } }
export function save(s) { localStorage.setItem(STORE, JSON.stringify(s)); }
export function active() { const s = saved(); return s.list.find((p) => p.serial === s.active) || s.list[0] || null; }

// Re-find a saved scanner by serial if its IP changed (DHCP), so we never scan from the wrong printer.
export async function resolve(p, onProgress) {
  try { const info = await probe(p.ip, 3000); if (!p.serial || info.serial === p.serial) return p; } catch (_) { /* moved */ }
  onProgress && onProgress("המדפסת לא בכתובת הקודמת, מחפש אותה ברשת...");
  const hit = (await discover(onProgress)).find((x) => x.serial === p.serial);
  if (!hit) throw new Error("המדפסת לא נמצאה ברשת. ודא שהטלפון מחובר ל-Wi-Fi של הבית ושהמדפסת דולקת.");
  const s = saved();
  s.list = s.list.map((x) => (x.serial === p.serial ? { ...x, ip: hit.ip } : x));
  save(s);
  return { ...p, ip: hit.ip };
}

// ------------------------------------------------------------------ scan
export async function scan(ip, { dpi = 300, mode = "color", onProgress } = {}) {
  const w = Math.min(Math.round((210 / 25.4) * 300), 2550), h = Math.min(Math.round((297 / 25.4) * 300), 3508);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="${NS.scan}" xmlns:pwg="${NS.pwg}">
  <pwg:Version>2.0</pwg:Version>
  <pwg:ScanRegions><pwg:ScanRegion>
    <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
    <pwg:XOffset>0</pwg:XOffset><pwg:YOffset>0</pwg:YOffset>
    <pwg:Width>${w}</pwg:Width><pwg:Height>${h}</pwg:Height>
  </pwg:ScanRegion></pwg:ScanRegions>
  <pwg:InputSource>Platen</pwg:InputSource>
  <scan:ColorMode>${COLOR[mode] || "RGB24"}</scan:ColorMode>
  <scan:XResolution>${dpi}</scan:XResolution><scan:YResolution>${dpi}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat><scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>
</scan:ScanSettings>`;
  // the scan head needs a few seconds to park after the previous page (503 meanwhile)
  let r;
  for (let i = 0; i < 16; i++) {
    r = await http(ip, "POST", "/eSCL/ScanJobs", { body: xml, timeout: 15000 });
    if (r.status === 201 || r.status === 200) break;
    if (r.status !== 503) throw new Error(`המדפסת דחתה את הסריקה (HTTP ${r.status})`);
    onProgress && onProgress("הסורק עסוק, ממתין...");
    await new Promise((res) => setTimeout(res, 2000));
  }
  if (r.status === 503) throw new Error("הסורק לא זמין. בדוק שאין הודעת שגיאה במדפסת (למשל דלת פתוחה) ונסה שוב.");
  let loc = r.headers.location || "";
  if (!loc) throw new Error("המדפסת לא החזירה כתובת לעבודת הסריקה");
  if (/^https?:/i.test(loc)) loc = "/" + loc.split("/").slice(3).join("/");
  else if (!loc.startsWith("/")) loc = `/eSCL/ScanJobs/${loc}`;
  onProgress && onProgress("סורק...");
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const d = await http(ip, "GET", `${loc.replace(/\/$/, "")}/NextDocument`, { binary: true, timeout: 120000 });
    if (d.status === 200 && d.bytes.length) return new Blob([d.bytes], { type: "image/jpeg" });
    if (![503, 409, 200].includes(d.status)) throw new Error(`הסריקה נכשלה (HTTP ${d.status})`);
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error("הסריקה לא הסתיימה בזמן");
}
