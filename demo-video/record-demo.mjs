import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(ROOT, "output");
const FINAL = path.join(OUTPUT, "majalis-alharamain-demo.mp4");
const ORIGIN = process.env.DEMO_ORIGIN || "http://127.0.0.1:8791";
const DRY_RUN = process.argv.includes("--dry-run");
const TRANSLATION_ONLY = process.argv.includes("--translation-only");
const AUTO_START = process.argv.includes("--auto-start");
const VIEWPORT_WIDTH = 1600;
const VIEWPORT_HEIGHT = 900;
const WIDTH = 1920;
const HEIGHT = 1080;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH,
  "C:\\ffmpeg\\ffmpeg\\bin\\ffmpeg.exe",
  "ffmpeg",
].filter(Boolean);
const FFPROBE_CANDIDATES = [
  process.env.FFPROBE_PATH,
  "C:\\ffmpeg\\ffmpeg\\bin\\ffprobe.exe",
  "ffprobe",
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const firstExisting = (items) => items.find((item) => !path.isAbsolute(item) || existsSync(item));
const chromePath = firstExisting(CHROME_CANDIDATES);
const ffmpegPath = firstExisting(FFMPEG_CANDIDATES);
const ffprobePath = firstExisting(FFPROBE_CANDIDATES);

if (!chromePath) throw new Error("لم يتم العثور على Chrome أو Edge.");
if (!DRY_RUN && (!ffmpegPath || !ffprobePath)) throw new Error("لم يتم العثور على FFmpeg/FFprobe.");

async function assertServer() {
  const response = await fetch(ORIGIN);
  if (!response.ok) throw new Error(`الخادم المحلي غير جاهز: HTTP ${response.status}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    if (options.input) child.stdin.end(options.input);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}\n${stderr}`));
    });
  });
}

function demoDashboardData() {
  const today = new Date().toISOString().slice(0, 10);
  const lessons = {};
  const registrations = {};
  const attendance = {};
  for (let index = 1; index <= 8; index += 1) {
    const id = `demo_lesson_${index}`;
    lessons[id] = {
      title: ["شرح كتاب التوحيد", "تفسير جزء عمّ", "أحكام العمرة", "شرح الأربعين النووية"][index % 4],
      status: "published",
      recurrence: "daily",
      prayer: ["fajr", "asr", "maghrib", "isha"][index % 4],
      placeId: index % 2 ? "haram_place" : "nabawi_place",
      capacity: 80 + index * 10,
      audience: index === 8 ? "women" : "men",
      createdAt: new Date(Date.now() - index * 3600000).toISOString(),
    };
  }
  for (let index = 1; index <= 18; index += 1) {
    const lessonId = `demo_lesson_${(index % 8) + 1}`;
    const id = `demo_reg_${index}`;
    registrations[id] = {
      lessonId,
      name: `زائر ${index}`,
      phone: `050000${String(index).padStart(4, "0")}`,
      code: `HR-${String(24000 + index)}`,
      status: "active",
      gender: index % 3 ? "male" : "female",
      lang: "العربية",
      createdAt: new Date(Date.now() - index * 900000).toISOString(),
    };
    if (index <= 12) {
      attendance[`${id}_${today}`] = {
        regId: id,
        lessonId,
        date: today,
        at: new Date(Date.now() - index * 240000).toISOString(),
        byName: "المنظّم",
      };
    }
  }
  return {
    categories: { c1: { name: "العقيدة" }, c2: { name: "الفقه" } },
    languages: { ar: { name: "العربية" }, ur: { name: "الأردية" }, en: { name: "الإنجليزية" } },
    places: {
      haram_place: { name: "توسعة الملك فهد", masjid: "haram" },
      nabawi_place: { name: "الساحات الشرقية", masjid: "nabawi" },
    },
    sheikhs: { s1: { title: "الشيخ د.", name: "خالد بن إبراهيم" } },
    users: {
      u1: { name: "المدير العام", email: "demo@example.test", role: "super", active: true },
      u2: { name: "مشرف الدروس", email: "supervisor@example.test", role: "supervisor", active: true },
      u3: { name: "منظّم الحضور", email: "organizer@example.test", role: "organizer", active: true },
    },
    lessons,
    registrations,
    attendance,
    audit: {
      a1: { at: new Date().toISOString(), byName: "المدير العام", role: "super", text: "راجع جدول دروس اليوم" },
      a2: { at: new Date(Date.now() - 900000).toISOString(), byName: "مشرف الدروس", role: "supervisor", text: "حدّث موقع درس التفسير" },
    },
    settings: {},
  };
}

async function seedTemporaryDemoState(context) {
  const dashboard = demoDashboardData();
  await context.addInitScript(({ dashboardData }) => {
    localStorage.removeItem("hl_notes");
    localStorage.removeItem("hl_regs");
    localStorage.setItem("hl_tlang", "ur");
    if (location.pathname.startsWith("/dashboard")) {
      localStorage.setItem("hd_local_v1", JSON.stringify(dashboardData));
      localStorage.removeItem("hd_as");
    }
  }, { dashboardData: dashboard });
}

async function interceptTemporaryNotes(page) {
  const demoNotes = [];
  let noteCounter = 0;
  await page.route("**/api/notes**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notes: demoNotes }) });
      return;
    }
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      noteCounter += 1;
      const note = {
        id: `demo-note-${noteCounter}`,
        lesson_id: body.lesson_id,
        note_date: body.note_date,
        title: body.title,
        body: body.body,
        kind: body.kind || "note",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      demoNotes.unshift(note);
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: note.id }) });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
}

async function installDemoLayer(page) {
  await page.addStyleTag({ content: `
    html { scroll-behavior: smooth !important; }
    #demo-cursor { position:fixed; z-index:2147483647; width:15px; height:15px; border-radius:50%; background:#17684f; border:2px solid #fff; box-shadow:0 2px 10px #0005; pointer-events:none; left:92vw; top:88vh; transform:translate(-50%,-50%); transition:left .36s cubic-bezier(.22,.8,.32,1),top .36s cubic-bezier(.22,.8,.32,1),opacity .2s; animation:demoCursorPulse 1.4s ease-in-out infinite; }
    #demo-spotlight { position:fixed; z-index:2147483645; border-radius:16px; pointer-events:none; opacity:0; box-shadow:0 0 0 200vmax rgba(4,30,22,.32),0 8px 36px rgba(0,0,0,.18); transition:all .36s cubic-bezier(.22,.8,.32,1),opacity .22s; }
    .demo-focus { position:relative !important; z-index:2147483646 !important; transform:scale(1.075); transition:transform .32s cubic-bezier(.22,.8,.32,1),box-shadow .32s !important; box-shadow:0 18px 44px rgba(13,86,64,.22) !important; }
    .demo-ripple { position:fixed; z-index:2147483647; width:10px; height:10px; border:2px solid rgba(23,104,79,.65); border-radius:50%; pointer-events:none; animation:demoRipple .46s ease-out forwards; }
    @keyframes demoRipple { to { transform:scale(5.8); opacity:0; } }
    @keyframes demoCursorPulse { 50% { box-shadow:0 2px 14px rgba(23,104,79,.5); } }
  ` });
  await page.evaluate(() => {
    if (!document.querySelector("#demo-cursor")) {
      const cursor = document.createElement("div");
      cursor.id = "demo-cursor";
      document.body.append(cursor);
      const spotlight = document.createElement("div");
      spotlight.id = "demo-spotlight";
      document.body.append(spotlight);
    }
  });
}

async function locatorBox(locator) {
  await locator.waitFor({ state: "visible", timeout: 7000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error("العنصر المطلوب غير ظاهر.");
  return box;
}

async function smoothMove(page, locator, duration = 380) {
  const box = await locatorBox(locator);
  const x = box.x + box.width * 0.76;
  const y = box.y + Math.min(box.height * 0.55, box.height - 8);
  await page.evaluate(({ x, y, duration }) => {
    const cursor = document.querySelector("#demo-cursor");
    cursor.style.transitionDuration = `${duration}ms`;
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
  }, { x, y, duration });
  await sleep(duration);
  return { x, y };
}

async function clickWithRipple(page, locator, pause = 240, semanticClick = false) {
  const point = await smoothMove(page, locator, 300);
  await page.evaluate(({ x, y }) => {
    const ripple = document.createElement("div");
    ripple.className = "demo-ripple";
    ripple.style.left = `${x - 5}px`;
    ripple.style.top = `${y - 5}px`;
    document.body.append(ripple);
    setTimeout(() => ripple.remove(), 550);
  }, point);
  if (semanticClick) await locator.evaluate((element) => element.click());
  else await locator.click();
  await sleep(pause);
}

async function smoothScroll(page, locator, pause = 500) {
  await locator.evaluate((element) => element.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" }));
  await sleep(pause);
}

async function spotlight(page, locator, hold = 650) {
  const box = await locatorBox(locator);
  await page.evaluate(({ box }) => {
    const spot = document.querySelector("#demo-spotlight");
    spot.style.left = `${box.x - 10}px`;
    spot.style.top = `${box.y - 10}px`;
    spot.style.width = `${box.width + 20}px`;
    spot.style.height = `${box.height + 20}px`;
    spot.style.opacity = "1";
  }, { box });
  await sleep(hold);
}

async function clearSpotlight(page) {
  await page.evaluate(() => {
    const spot = document.querySelector("#demo-spotlight");
    if (spot) spot.style.opacity = "0";
  });
  await sleep(180);
}

async function smoothZoom(page, locator, hold = 620) {
  await locator.evaluate((element) => element.classList.add("demo-focus"));
  await sleep(hold);
  await locator.evaluate((element) => element.classList.remove("demo-focus"));
  await sleep(220);
}

async function centerAndZoom(page, locator, hold = 900) {
  await smoothScroll(page, locator, 650);
  await sleep(300);
  await smoothZoom(page, locator, hold);
}

async function showSelectMenu(page, locator, labels, hold = 1200) {
  await smoothScroll(page, locator, 520);
  await smoothMove(page, locator, 280);
  await locator.focus();
  const box = await locatorBox(locator);
  await page.evaluate(({ box, labels }) => {
    document.querySelector("#demo-select-menu")?.remove();
    const menu = document.createElement("div");
    menu.id = "demo-select-menu";
    menu.style.cssText = `position:fixed;z-index:2147483646;left:${box.x}px;top:${box.y + box.height + 8}px;width:${Math.max(box.width, 260)}px;background:#fff;border:1px solid #d8dfdc;border-radius:12px;box-shadow:0 18px 44px rgba(0,0,0,.16);padding:8px;opacity:0;transform:translateY(-6px);transition:.25s ease;direction:rtl;font:15px system-ui;`;
    menu.innerHTML = labels.map((label, index) => `<div style="padding:10px 12px;border-radius:8px;${index === 0 ? "background:#eef5f2;color:#17684f;font-weight:650" : ""}">${label}</div>`).join("");
    document.body.append(menu);
    requestAnimationFrame(() => { menu.style.opacity = "1"; menu.style.transform = "none"; });
  }, { box, labels });
  await sleep(hold);
  await page.evaluate(() => {
    const menu = document.querySelector("#demo-select-menu");
    if (menu) { menu.style.opacity = "0"; menu.style.transform = "translateY(-6px)"; setTimeout(() => menu.remove(), 260); }
  });
  await sleep(280);
}

async function demoQrCheckin(page) {
  const scanner = page.locator("#vf");
  await smoothScroll(page, scanner, 650);
  await sleep(400);
  const cameraButton = page.locator("#camBtn");
  await spotlight(page, cameraButton, 800);
  await clearSpotlight(page);
  await page.evaluate(() => {
    const button = document.querySelector("#camBtn");
    button?.addEventListener("click", (event) => { event.preventDefault(); event.stopImmediatePropagation(); }, { capture: true, once: true });
  });
  await clickWithRipple(page, cameraButton, 300);
  await page.evaluate(() => {
    const vf = document.querySelector("#vf");
    if (!vf) return;
    vf.innerHTML = `<div class="demo-qr-stage"><div class="demo-qr">
      <svg viewBox="0 0 210 210" aria-label="QR تجريبي"><rect width="210" height="210" rx="12" fill="#fff"/><g fill="#102c25">
      <path d="M18 18h54v54H18zm12 12v30h30V30zM138 18h54v54h-54zm12 12v30h30V30zM18 138h54v54H18zm12 12v30h30v-30z" fill-rule="evenodd"/>
      <path d="M86 22h18v18H86zm22 0h16v34h-16zM84 58h20v18H84zm24 20h18v18h-18zM82 86h18v18H82zm24 18h20v20h-20zM134 86h18v38h-18zm24 0h34v18h-34zm0 24h18v18h-18zM82 132h18v18H82zm24 0h18v38h-18zm28 0h18v18h-18zm24 0h34v18h-34zm-76 42h18v18H82zm52-18h18v36h-18zm24 4h18v18h-18zm20 18h14v14h-14z"/>
      </g></svg><div class="demo-scan-line"></div></div><b id="demoQrStatus">جارٍ قراءة رمز الحجز…</b></div>`;
    const style = document.createElement("style");
    style.id = "demo-qr-style";
    style.textContent = `.demo-qr-stage{height:100%;display:grid;place-items:center;align-content:center;gap:14px;background:linear-gradient(145deg,#edf6f2,#f9fbfa)}.demo-qr{width:230px;height:230px;padding:10px;background:#fff;border-radius:18px;box-shadow:0 12px 36px #0b4d3930;position:relative;overflow:hidden}.demo-qr svg{width:100%;height:100%}.demo-scan-line{position:absolute;left:8px;right:8px;height:3px;top:8px;background:#22a06b;box-shadow:0 0 18px #22a06b;animation:demoScan 1.35s ease-in-out infinite alternate}@keyframes demoScan{to{top:218px}}`;
    document.head.append(style);
  });
  await sleep(1700);
  await page.evaluate(() => {
    const status = document.querySelector("#demoQrStatus");
    if (status) status.textContent = "جارٍ التحقق من التسجيل…";
  });
  await sleep(1100);
  await page.evaluate(() => {
    const status = document.querySelector("#demoQrStatus");
    if (status) { status.textContent = "✓ تم تسجيل الحضور بنجاح"; status.style.color = "#17684f"; }
    const result = document.querySelector("#result");
    if (result) result.innerHTML = `<div class="card" style="padding:20px;border-color:#9ad0bc;background:#f1faf6"><b style="color:#17684f;font-size:18px">تم تسجيل الحضور</b><div style="margin-top:8px">HR-24018 · شرح كتاب التوحيد</div><div class="hint">تم التحقق من الحجز وإضافته إلى حضور اليوم.</div></div>`;
  });
  await sleep(1400);
}

async function enhanceTranslationView(page) {
  await page.evaluate(async () => {
    const lesson = document.querySelector("#trLesson")?.value;
    const lang = document.querySelector("#trLang")?.value;
    try {
      const response = await fetch(`/api/transcripts?lesson_id=${encodeURIComponent(lesson)}&target_language=${encodeURIComponent(lang)}`);
      const data = await response.json();
      const segments = (data.segments || []).slice(-4);
      if (!segments.length) return;
      const box = document.querySelector("#trBox");
      box.innerHTML = segments.map((segment) => `<div class="tr-line" style="display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start"><div dir="rtl" style="color:#52605c;font-size:15px;line-height:1.8;border-inline-end:1px solid #e2e8e5;padding-inline-end:14px">${segment.text}</div><div class="tr" lang="ur" dir="auto">${segment.translated_text || ""}</div></div>`).join("");
    } catch {}
  });
}

async function showOutro(page) {
  const imageData = async (name) => `data:image/png;base64,${(await readFile(path.join(ROOT, "assets", name))).toString("base64")}`;
  const slides = [
    { image: await imageData("majalis-logo.png"), label: "مجالس الحرمين", mode: "logo" },
    { image: await imageData("partners.png"), label: "شركاء الابتكار", mode: "partners" },
    { image: await imageData("award.png"), label: "هاكاثون الابتكار", mode: "award" },
  ];
  await page.setContent(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#fff;color:#101814;font-family:system-ui;overflow:hidden}.frame{height:100vh;display:grid;place-items:center;padding:64px;opacity:0;transform:scale(.975);transition:opacity .55s ease,transform .7s cubic-bezier(.22,.8,.32,1)}.frame.show{opacity:1;transform:scale(1)}.panel{display:grid;place-items:center;gap:24px;text-align:center}.panel img{display:block;max-width:min(1100px,86vw);max-height:62vh;object-fit:contain}.panel.logo img{width:430px;image-rendering:auto}.panel.partners img{width:1100px}.panel.award img{width:1220px;border-radius:16px}.eyebrow{color:#17684f;font-weight:650;letter-spacing:.04em}.line{width:90px;height:3px;background:#b9923b;border-radius:999px}</style></head><body><main id="frame" class="frame"><div id="panel" class="panel"></div></main></body></html>`);
  for (const slide of slides) {
    await page.evaluate((slide) => {
      const frame = document.querySelector("#frame");
      const panel = document.querySelector("#panel");
      frame.classList.remove("show");
      panel.className = `panel ${slide.mode}`;
      panel.innerHTML = `<img src="${slide.image}" alt="${slide.label}">${slide.mode === "logo" ? '<div class="line"></div><div class="eyebrow">مجالس العلم في الحرمين الشريفين</div>' : ""}`;
      requestAnimationFrame(() => requestAnimationFrame(() => frame.classList.add("show")));
    }, slide);
    await sleep(slide.mode === "award" ? 1900 : 1500);
  }
}

async function typeText(locator, text, delay = 55) {
  await locator.click();
  await locator.pressSequentially(text, { delay });
}

async function countUpDashboard(page) {
  await page.evaluate(async () => {
    const arabic = new Intl.NumberFormat("ar-SA");
    const targets = [8, 126, 100, 340];
    const nodes = [...document.querySelectorAll(".stats .stat > b")];
    const start = performance.now();
    await new Promise((resolve) => {
      const frame = (now) => {
        const progress = Math.min(1, (now - start) / 760);
        const eased = 1 - Math.pow(1 - progress, 3);
        nodes.forEach((node, index) => {
          const value = Math.round(targets[index] * eased);
          node.textContent = arabic.format(value) + (index === 2 ? "٪" : "");
        });
        if (progress < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });
  });
}

async function startCapture(context, page, outputPath) {
  const cdp = await context.newCDPSession(page);
  const ffmpeg = spawn(ffmpegPath, [
    "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", "60", "-vcodec", "mjpeg", "-i", "-",
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-vf", `fps=30,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
    "-movflags", "+faststart", outputPath,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  ffmpeg.stderr.on("data", (chunk) => (stderr += chunk));
  ffmpeg.stdin.on("error", (error) => {
    if (error.code !== "ERR_STREAM_WRITE_AFTER_END" && error.code !== "EPIPE") console.error(error);
  });
  let pending = Promise.resolve();
  let active = true;
  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    if (!active) {
      void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      return;
    }
    pending = pending.then(async () => {
      if (active && !ffmpeg.stdin.destroyed && !ffmpeg.stdin.writableEnded) ffmpeg.stdin.write(Buffer.from(data, "base64"));
      await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
  return async () => {
    active = false;
    await cdp.send("Page.stopScreencast").catch(() => {});
    await pending;
    ffmpeg.stdin.end();
    await new Promise((resolve, reject) => {
      ffmpeg.on("close", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg capture failed (${code}): ${stderr}`)));
    });
    await cdp.detach().catch(() => {});
  };
}

async function startBrowserAudioCapture(page) {
  await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      video: false,
    });
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
    window.__demoAudioCapture = { recorder, stream, chunks, mimeType };
    recorder.start(200);
  });
}

async function stopBrowserAudioCapture(page, outputPath) {
  const result = await page.evaluate(async () => {
    const capture = window.__demoAudioCapture;
    if (!capture) throw new Error("Audio capture was not started");
    await new Promise((resolve) => {
      capture.recorder.addEventListener("stop", resolve, { once: true });
      capture.recorder.stop();
    });
    capture.stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(capture.chunks, { type: capture.mimeType });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    delete window.__demoAudioCapture;
    return { base64: btoa(binary), mimeType: capture.mimeType };
  });
  await writeFile(outputPath, Buffer.from(result.base64, "base64"));
}

async function prepareCleanTranslation(page) {
  await page.route("**/api/transcripts**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ segments: [] }) });
      return;
    }
    await route.continue();
  });
  await page.goto(`${ORIGIN}/#profile/translate`, { waitUntil: "domcontentloaded" });
  await installDemoLayer(page);
  await page.getByRole("heading", { name: /الترجمة الفورية/ }).waitFor();
  await page.evaluate(() => {
    const box = document.querySelector("#trBox");
    if (box) box.innerHTML = "";
    const interim = document.querySelector("#trInterim");
    if (interim) interim.textContent = "";
  });
  await smoothScroll(page, page.locator("#trPanel"), 650);
  await sleep(850);
  await centerAndZoom(page, page.locator(".tr-controls"), 700);
  await showSelectMenu(page, page.locator("#trLesson"), ["شرح كتاب التوحيد — المسجد الحرام", "تفسير جزء عمّ — المسجد الحرام", "شرح صحيح البخاري — المسجد النبوي"], 700);
  await page.locator("#trLesson").selectOption("h1");
  await showSelectMenu(page, page.locator("#trLang"), ["English", "اردو", "Bahasa Indonesia", "Français", "Türkçe"], 850);
  await page.locator("#trLang").selectOption("ur");
  await page.getByRole("tab", { name: "كتابة نص" }).click();
  await sleep(420);
  await page.getByRole("tab", { name: "استماع مباشر" }).click();
  const listen = page.getByRole("button", { name: "ابدأ الاستماع" });
  await smoothScroll(page, listen, 420);
  await spotlight(page, listen, 650);
  await clearSpotlight(page);
}

async function recordCleanLiveTranslation(page) {
  const listen = page.getByRole("button", { name: "ابدأ الاستماع" });
  const alreadyListening = page.getByRole("button", { name: "إيقاف الاستماع" });
  if (await listen.isVisible().catch(() => false)) {
    await clickWithRipple(page, listen, 450);
  } else if (!(await alreadyListening.isVisible().catch(() => false))) {
    await Promise.race([
      listen.waitFor({ state: "visible", timeout: 7000 }),
      alreadyListening.waitFor({ state: "visible", timeout: 7000 }),
    ]).catch(() => {});
    if (await listen.isVisible().catch(() => false)) await clickWithRipple(page, listen, 450);
  }
  await page.getByText(/يستمع الآن|جارٍ الاتصال/).first().waitFor({ state: "visible", timeout: 10000 });
  try {
    await page.waitForFunction(() => document.querySelectorAll("#trBox .tr-line .tr:not(.pending)").length >= 2, null, { timeout: 18000 });
  } catch {
    await page.waitForFunction(() => document.querySelectorAll("#trBox .tr-line .tr:not(.pending)").length >= 1, null, { timeout: 8000 });
  }
  const box = page.locator("#trBox");
  await smoothScroll(page, box, 520);
  await spotlight(page, box, 950);
  await smoothZoom(page, box, 900);
  await clearSpotlight(page);
  await sleep(900);
  const stop = page.getByRole("button", { name: "إيقاف الاستماع" });
  if (await stop.isVisible().catch(() => false)) await clickWithRipple(page, stop, 350);
  await sleep(350);
}

async function buildTranslationReplacement() {
  const original = path.join(OUTPUT, "majalis-alharamain-demo-final.mp4");
  const pre = path.join(OUTPUT, "translation-pre.mp4");
  const liveVideo = path.join(OUTPUT, "translation-live-video.mp4");
  const liveAudio = path.join(OUTPUT, "translation-live-audio.webm");
  const live = path.join(OUTPUT, "translation-live.mp4");
  const scene = path.join(OUTPUT, "translation-scene.mp4");
  const final = path.join(OUTPUT, "majalis-alharamain-demo-final-with-audio.mp4");
  if (!existsSync(original)) throw new Error(`الفيديو الأساسي غير موجود: ${original}`);

  await run(ffmpegPath, ["-y", "-loglevel", "error", "-i", liveVideo, "-i", liveAudio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-af", "highpass=f=80,lowpass=f=12000,volume=1.35,apad", "-shortest", "-movflags", "+faststart", live]);
  const preProbe = await run(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", pre]);
  const preDuration = Number(preProbe.stdout.trim());
  await run(ffmpegPath, ["-y", "-loglevel", "error", "-i", pre, "-f", "lavfi", "-t", String(preDuration), "-i", "anullsrc=r=48000:cl=mono", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", path.join(OUTPUT, "translation-pre-av.mp4")]);
  await run(ffmpegPath, ["-y", "-loglevel", "error", "-i", path.join(OUTPUT, "translation-pre-av.mp4"), "-i", live, "-filter_complex", "[0:v]setpts=PTS-STARTPTS[v0];[0:a]asetpts=PTS-STARTPTS[a0];[1:v]setpts=PTS-STARTPTS[v1];[1:a]asetpts=PTS-STARTPTS[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]", "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", scene]);
  await run(ffmpegPath, ["-y", "-loglevel", "error", "-i", original, "-i", scene, "-filter_complex", "[0:v]trim=start=0:end=91,setpts=PTS-STARTPTS[v0];anullsrc=r=48000:cl=mono:d=91[a0];[1:v]setpts=PTS-STARTPTS[v1];[1:a]asetpts=PTS-STARTPTS[a1];[0:v]trim=start=105,setpts=PTS-STARTPTS[v2];anullsrc=r=48000:cl=mono:d=9.8[a2];[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]", "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", final]);
  return final;
}

async function runTranslationOnly(browser, context, page) {
  await Promise.all(["translation-pre.mp4", "translation-live-video.mp4", "translation-live-audio.webm", "translation-live.mp4", "translation-pre-av.mp4", "translation-scene.mp4", "majalis-alharamain-demo-final-with-audio.mp4"].map((name) => rm(path.join(OUTPUT, name), { force: true })));
  await prepareCleanTranslation(page);
  let stopPre = await startCapture(context, page, path.join(OUTPUT, "translation-pre.mp4"));
  await page.evaluate(() => { const box = document.querySelector("#trBox"); if (box) box.innerHTML = ""; });
  await sleep(900);
  await centerAndZoom(page, page.locator(".tr-controls"), 620);
  await spotlight(page, page.getByRole("button", { name: "ابدأ الاستماع" }), 650);
  await clearSpotlight(page);
  await stopPre();
  stopPre = null;

  if (!AUTO_START) {
    console.log("\n=========================================");
    console.log("READY FOR LIVE TRANSLATION WITH AUDIO");
    console.log("اضغط Enter أولًا، ثم عند ظهور «إيقاف الاستماع» شغّل المقطع الصوتي");
    console.log("=========================================\n");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("");
    rl.close();
  } else {
    console.log("AUTO START: live translation recording begins now");
  }

  const stopLive = await startCapture(context, page, path.join(OUTPUT, "translation-live-video.mp4"));
  await startBrowserAudioCapture(page);
  await recordCleanLiveTranslation(page);
  await stopBrowserAudioCapture(page, path.join(OUTPUT, "translation-live-audio.webm"));
  await stopLive();
  const final = await buildTranslationReplacement();
  const info = await run(ffprobePath, ["-v", "error", "-show_entries", "stream=width,height,codec_name:format=duration", "-of", "json", final]);
  console.log(`FINAL_VIDEO=${final}`);
  console.log(`FINAL_INFO=${info.stdout.trim()}`);
}

async function sceneHome(page) {
  await page.goto(`${ORIGIN}/#top`, { waitUntil: "domcontentloaded" });
  await installDemoLayer(page);
  await page.getByRole("heading", { name: "مجالس العلم في الحرمين الشريفين" }).waitFor();
  await sleep(3000);
  const haramPick = page.locator('[data-jump="haram"]');
  const nabawiPick = page.locator('[data-jump="nabawi"]');
  await spotlight(page, haramPick, 780);
  await spotlight(page, nabawiPick, 780);
  await clearSpotlight(page);
  const about = page.locator("#about .about-grid");
  await smoothScroll(page, about, 780);
  await sleep(650);
  await spotlight(page, page.locator("#about .about-card").first(), 720);
  await spotlight(page, page.locator("#about .about-card").nth(1), 720);
  await clearSpotlight(page);
  await smoothZoom(page, about, 1050);
  const steps = page.locator("#how .steps");
  await smoothScroll(page, steps, 760);
  await smoothZoom(page, steps, 950);
  await sleep(550);
}

async function sceneLessons(page) {
  const lessons = page.locator("#lessons");
  await smoothScroll(page, lessons, 760);
  await sleep(550);
  const swiper = page.locator("#swiper");
  await swiper.evaluate((element) => element.scrollBy({ left: -360, behavior: "smooth" }));
  await sleep(900);
  await swiper.evaluate((element) => element.scrollBy({ left: -360, behavior: "smooth" }));
  await sleep(900);
  await centerAndZoom(page, page.locator("#swiper .lesson").nth(1), 900);
  await smoothScroll(page, page.getByRole("link", { name: "عرض كل الدروس" }), 450);
  await clickWithRipple(page, page.getByRole("link", { name: "عرض كل الدروس" }), 520);
  await page.getByRole("heading", { name: "جميع الدروس" }).waitFor();
  await installDemoLayer(page);
  const toolbar = page.locator(".toolbar");
  await centerAndZoom(page, toolbar, 850);
  for (const name of ["المسجد الحرام", "المسجد النبوي", "الكل"]) {
    await clickWithRipple(page, page.getByRole("tab", { name, exact: true }), 620);
  }
  await showSelectMenu(page, page.locator("#cat"), ["كل المجالات", "العقيدة", "التفسير", "الفقه", "الحديث"], 1350);
  await page.locator("#cat").selectOption({ label: "التفسير" });
  await sleep(1100);
  await page.locator("#cat").selectOption("");
  const search = page.locator("#q");
  await smoothScroll(page, search, 520);
  await spotlight(page, search, 650);
  await clearSpotlight(page);
  await smoothMove(page, search, 320);
  await typeText(search, "خالد بن", 95);
  await sleep(1050);
  const result = page.locator("#grid .lesson").filter({ hasText: "خالد بن إبراهيم" }).first();
  await smoothScroll(page, result, 650);
  await spotlight(page, result, 950);
  await smoothZoom(page, result, 950);
  await clearSpotlight(page);
}

async function sceneDashboard(page) {
  await clickWithRipple(page, page.getByRole("link", { name: "لوحة التحكم" }), 450);
  await page.waitForURL("**/dashboard/**", { timeout: 8000 });
  await page.getByRole("heading", { name: "نظرة عامة", exact: true }).waitFor();
  await installDemoLayer(page);
  const stats = page.locator(".stats");
  await smoothScroll(page, stats, 620);
  await stats.evaluate((element) => element.classList.add("demo-focus"));
  await countUpDashboard(page);
  await sleep(1200);
  await stats.evaluate((element) => element.classList.remove("demo-focus"));
  await sleep(350);

  const visit = async (hash, heading, selector, hold = 1200, zoom = true) => {
    const link = page.locator(`#nav a[href="#${hash}"]`);
    await clickWithRipple(page, link, 350);
    await page.locator("#page h2").filter({ hasText: heading }).first().waitFor({ state: "visible", timeout: 5000 });
    const target = page.locator(selector).first();
    await target.waitFor({ state: "visible", timeout: 5000 });
    await smoothScroll(page, target, 600);
    if (zoom) await smoothZoom(page, target, 760);
    await sleep(hold);
  };

  await clickWithRipple(page, page.locator('#nav a[href="#checkin"]'), 350);
  await page.locator("#scanRoot").waitFor({ state: "visible" });
  await demoQrCheckin(page);
  await visit("registrations", "التسجيلات", "#page .table-wrap", 1350);
  await visit("lessons", "الدروس", "#page .table-wrap", 1200);
  await visit("users", "المستخدمون", "#page .stats", 900);
  const usersTable = page.locator("#page .table-wrap").first();
  if (await usersTable.isVisible().catch(() => false)) await centerAndZoom(page, usersTable, 850);
  await visit("roles", "الأدوار والصلاحيات", "#page .table-wrap", 1450);
  await spotlight(page, page.locator("#page .table-wrap tbody tr").nth(1), 750);
  await clearSpotlight(page);
  await visit("config", "الإعدادات", "#page .tabs", 1000);
  await visit("audit", "سجل النشاط", "#page .table-wrap", 1200);
}

async function sceneNotes(page) {
  await page.goto(`${ORIGIN}/#profile`, { waitUntil: "domcontentloaded" });
  await installDemoLayer(page);
  await centerAndZoom(page, page.locator(".p-tabs"), 700);
  await clickWithRipple(page, page.getByRole("link", { name: "ملاحظاتي", exact: true }), 420);
  await page.getByRole("heading", { name: "ملاحظاتي", exact: true }).waitFor();
  await smoothScroll(page, page.locator("#ntPanel"), 550);
  await clickWithRipple(page, page.getByRole("button", { name: "ملاحظة جديدة" }), 420);
  await page.locator("#ntLesson").selectOption("h1");
  const body = page.locator("#ntBody");
  await smoothScroll(page, body, 520);
  await smoothMove(page, body, 300);
  await typeText(body, "ملاحظة 1\nملاحظة 2", 90);
  await sleep(500);
  await clickWithRipple(page, page.getByRole("button", { name: "حفظ الملاحظة" }), 650);
  const saved = page.locator('[data-note="demo-note-1"]');
  await saved.waitFor({ state: "visible", timeout: 5000 });
  await smoothScroll(page, saved, 620);
  await spotlight(page, saved, 1050);
  await smoothZoom(page, saved, 900);
  await clearSpotlight(page);
}

async function prepareTranslation(page) {
  await clickWithRipple(page, page.getByRole("link", { name: "الترجمة الفورية", exact: true }), 420);
  await page.getByRole("heading", { name: /الترجمة الفورية/ }).waitFor();
  await centerAndZoom(page, page.locator(".tr-controls"), 850);
  await showSelectMenu(page, page.locator("#trLesson"), ["شرح كتاب التوحيد — المسجد الحرام", "تفسير جزء عمّ — المسجد الحرام", "شرح صحيح البخاري — المسجد النبوي"], 1050);
  await page.locator("#trLesson").selectOption("h1");
  await showSelectMenu(page, page.locator("#trLang"), ["English", "اردو", "Bahasa Indonesia", "Français", "Türkçe"], 1250);
  await page.locator("#trLang").selectOption("ur");
  await page.getByRole("tab", { name: "استماع مباشر" }).click();
  const listen = page.getByRole("button", { name: "ابدأ الاستماع" });
  await smoothScroll(page, listen, 520);
  await spotlight(page, listen, 900);
  await clearSpotlight(page);
  await sleep(450);
}

async function liveTranslationAndEnding(page) {
  const listen = page.getByRole("button", { name: "ابدأ الاستماع" });
  await clickWithRipple(page, listen, 750);
  await page.getByText(/يستمع الآن|جارٍ الاتصال/).first().waitFor({ state: "visible", timeout: 10000 });
  let translated = false;
  try {
    await page.waitForFunction(() => document.querySelectorAll("#trBox .tr-line .tr:not(.pending)").length >= 3, null, { timeout: 17000 });
    translated = true;
  } catch {
    const stop = page.getByRole("button", { name: "إيقاف الاستماع" });
    if (await stop.isVisible().catch(() => false)) await clickWithRipple(page, stop, 350);
    try {
      await page.waitForFunction(() => document.querySelectorAll("#trBox .tr-line .tr:not(.pending)").length >= 1, null, { timeout: 10000 });
      translated = true;
    } catch {}
  }
  if (!translated) throw new Error("لم تظهر ترجمة نهائية أثناء مهلة التسجيل.");
  await enhanceTranslationView(page);
  const translationBox = page.locator("#trBox");
  await smoothScroll(page, translationBox, 650);
  await spotlight(page, translationBox, 1400);
  await smoothZoom(page, translationBox, 1200);
  await clearSpotlight(page);

  const saveTranslation = page.getByRole("button", { name: "حفظ في ملاحظاتي" });
  await smoothScroll(page, saveTranslation, 480);
  await spotlight(page, saveTranslation, 850);
  await clearSpotlight(page);
  await clickWithRipple(page, saveTranslation, 500);
  const saveNote = page.getByRole("button", { name: "حفظ الملاحظة" });
  await saveNote.waitFor({ state: "visible" });
  await clickWithRipple(page, saveNote, 650);
  const translationNote = page.locator('[data-note="demo-note-2"]');
  await translationNote.waitFor({ state: "visible", timeout: 5000 });
  await smoothScroll(page, translationNote, 500);
  await spotlight(page, translationNote, 800);
  await clearSpotlight(page);

  await page.goto(`${ORIGIN}/#top`, { waitUntil: "domcontentloaded" });
  await installDemoLayer(page);
  await page.getByRole("heading", { name: "مجالس العلم في الحرمين الشريفين" }).waitFor();
  const cta = page.locator(".cta-band");
  await smoothScroll(page, cta, 1500);
  await smoothZoom(page, cta, 950);
  const register = page.getByRole("link", { name: "سجّل في درس" });
  await spotlight(page, register, 900);
  await clearSpotlight(page);
  await page.evaluate(() => document.querySelector('.cta-band a')?.addEventListener('click', (event) => event.preventDefault(), { capture:true, once:true }));
  await clickWithRipple(page, register, 350);
  await showOutro(page);
}

async function combineVideo(parts) {
  const concatFile = path.join(OUTPUT, "parts.txt");
  const joined = path.join(OUTPUT, "joined.mp4");
  await writeFile(concatFile, parts.map((part) => `file '${part.replaceAll("'", "'\\''")}'`).join("\n"));
  await run(ffmpegPath, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", joined]);
  const probe = await run(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", joined]);
  const duration = Number(probe.stdout.trim());
  const args = ["-y", "-loglevel", "error", "-i", joined];
  if (duration > 119.8) args.push("-t", "119.8");
  args.push("-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", FINAL);
  await run(ffmpegPath, args);
  const finalProbe = await run(ffprobePath, ["-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "json", FINAL]);
  return JSON.parse(finalProbe.stdout);
}

async function main() {
  await assertServer();
  await mkdir(OUTPUT, { recursive: true });
  if (!DRY_RUN) {
    await Promise.all(["part-a.mp4", "part-b.mp4", "joined.mp4", "parts.txt", path.basename(FINAL)].map((name) => rm(path.join(OUTPUT, name), { force: true })));
  }
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: DRY_RUN,
    args: ["--autoplay-policy=no-user-gesture-required", "--disable-infobars", "--no-default-browser-check", "--no-first-run"],
  });
  const context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    screen: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    deviceScaleFactor: 1.2,
    isMobile: false,
    hasTouch: false,
    locale: "ar-SA",
    colorScheme: "light",
  });
  await context.grantPermissions(["microphone"], { origin: ORIGIN });
  await seedTemporaryDemoState(context);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await interceptTemporaryNotes(page);
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`[browser] ${message.text()}`);
  });

  if (TRANSLATION_ONLY) {
    try {
      await runTranslationOnly(browser, context, page);
    } finally {
      await browser.close();
    }
    return;
  }

  let stopA = null;
  let stopB = null;
  try {
    if (!DRY_RUN) stopA = await startCapture(context, page, path.join(OUTPUT, "part-a.mp4"));
    await sceneHome(page);
    await sceneLessons(page);
    await sceneDashboard(page);
    await sceneNotes(page);
    await prepareTranslation(page);

    if (DRY_RUN) {
      const liveButton = page.getByRole("button", { name: "ابدأ الاستماع" });
      if (!(await liveButton.isVisible())) throw new Error("زر الاستماع المباشر غير ظاهر.");
      console.log("DRY RUN PASSED: routes, filters, dashboard, notes, and live translation entry are ready.");
      return;
    }

    await stopA();
    stopA = null;
    console.log("\n================================================");
    console.log("READY FOR LIVE TRANSLATION");
    console.log("شغّل المقطع الصوتي الآن ثم اضغط Enter");
    console.log("================================================\n");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("");
    rl.close();

    stopB = await startCapture(context, page, path.join(OUTPUT, "part-b.mp4"));
    await liveTranslationAndEnding(page);
    await stopB();
    stopB = null;
    const info = await combineVideo([path.join(OUTPUT, "part-a.mp4"), path.join(OUTPUT, "part-b.mp4")]);
    console.log(`FINAL_VIDEO=${FINAL}`);
    console.log(`FINAL_INFO=${JSON.stringify(info)}`);
  } finally {
    if (stopA) await stopA().catch(() => {});
    if (stopB) await stopB().catch(() => {});
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
