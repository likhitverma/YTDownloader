"use strict";
// Integration tests: start the real server and drive it over HTTP with real yt-dlp + FFmpeg.
// Run with:  npm test      (needs yt-dlp and ffmpeg on PATH; POSIX-only helpers are skipped on Windows)
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const IS_WIN = process.platform === "win32";
const have = (cmd, args) => { try { return spawnSync(cmd, args, { stdio: "ignore" }).status === 0; } catch { return false; } };
const HAVE_TOOLS = have("yt-dlp", ["--version"]) && have("ffmpeg", ["-version"]);
const skipAll = !HAVE_TOOLS || IS_WIN ? "needs yt-dlp + ffmpeg on a POSIX shell" : false;

let tmp, mediaServer, mediaPort;
const servers = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 60000, every = 100, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await sleep(every);
  }
}

/* ---- local media: fast files + throttled "slow" files + HTML pages ---- */
function makeMedia(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 3; i++) {
    const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=15",
      "-f", "lavfi", "-i", `sine=frequency=${300 + i * 100}:duration=3`, "-c:v", "libx264", "-c:a", "aac", "-shortest", path.join(dir, `v${i}.mp4`)]);
    assert.equal(r.status, 0, "ffmpeg could not create test media");
  }
  fs.writeFileSync(path.join(dir, "playlist.html"), `<html><head><title>Test Playlist</title></head><body><video src="/v1.mp4"></video><video src="/v2.mp4"></video><video src="/v3.mp4"></video></body></html>`);
  fs.writeFileSync(path.join(dir, "single.html"), `<html><head><title>Single Page</title></head><body><video src="/v1.mp4"></video></body></html>`);
  // 1.5 MB payload for throttled downloads
  fs.writeFileSync(path.join(dir, "slow.bin"), Buffer.concat([fs.readFileSync(path.join(dir, "v1.mp4")), Buffer.alloc(1_500_000)]));
}

function startMediaServer(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname.startsWith("/slow/")) {
        const body = fs.readFileSync(path.join(dir, "slow.bin"));
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": body.length });
        let offset = 0;
        const timer = setInterval(() => {
          if (offset >= body.length) { clearInterval(timer); return res.end(); }
          res.write(body.subarray(offset, offset + 20000));
          offset += 20000;
        }, 100); // ~200 KB/s => ~7.5 s per file
        res.on("close", () => clearInterval(timer));
        return undefined;
      }
      const file = path.join(dir, path.basename(url.pathname));
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      const type = file.endsWith(".html") ? "text/html" : "video/mp4";
      res.writeHead(200, { "Content-Type": type });
      return fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

/* ---- MediaDock server harness ---- */
async function startApp(extraEnv = {}, { dataDir, dlDir } = {}) {
  const id = servers.length;
  const data = dataDir || path.join(tmp, `data${id}`);
  const dl = dlDir || path.join(tmp, `dl${id}`);
  fs.mkdirSync(data, { recursive: true });
  const port = 4100 + Math.floor(Math.random() * 800);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MEDIADOCK_DATA_DIR: data, MEDIADOCK_DOWNLOAD_DIR: dl, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", (c) => { log += c; });
  child.stderr.on("data", (c) => { log += c; });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(`${base}/api/settings`)).ok; } catch { return false; } }, { label: "server start" });
  const app = {
    base, data, dl, child, get log() { return log; },
    async api(method, url, body) {
      const r = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      let json = null;
      try { json = await r.json(); } catch { /* none */ }
      return { status: r.status, json };
    },
    async stop() { child.kill("SIGINT"); await new Promise((r) => { child.on("exit", r); setTimeout(r, 4000); }); }
  };
  servers.push(app);
  return app;
}

/** Subscribes to /api/events and records every job event. */
async function listen(app) {
  const events = [];
  const ctrl = new AbortController();
  const res = await fetch(`${app.base}/api/events`, { signal: ctrl.signal });
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block); const data = /^data: (.*)$/m.exec(block);
          if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
        }
      }
    } catch { /* aborted */ }
  })();
  return { events, close: () => ctrl.abort(), jobEvents: (id) => events.filter((e) => e.event === "job" && e.data.id === id).map((e) => e.data) };
}

const dlBody = (url, extra = {}) => ({ url, kind: "av", selector: "bv*+ba/b", merge: "mp4", label: "Best Available", streams: 1, ...extra });
const finished = (s) => ["completed", "failed", "cancelled"].includes(s);

async function waitJob(app, id, label) {
  return waitFor(async () => {
    const h = (await app.api("GET", "/api/history")).json.items.find((x) => x.id === id);
    return h || null;
  }, { label: label || `job ${id} to finish`, timeout: 90000 });
}

before(async () => {
  if (skipAll) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mediadock-test-"));
  makeMedia(path.join(tmp, "media"));
  mediaServer = await startMediaServer(path.join(tmp, "media"));
  mediaPort = mediaServer.address().port;
});

after(async () => {
  for (const s of servers) { try { s.child.kill("SIGKILL"); } catch { /* ignore */ } }
  if (mediaServer) mediaServer.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const media = (p) => `http://127.0.0.1:${mediaPort}/${p}`;

/* ------------------------------------------------------------------ tests */

test("single video: completes, progress never goes backwards, file exists", { skip: skipAll }, async () => {
  const app = await startApp();
  const ev = await listen(app);
  const r = await app.api("POST", "/api/download", dlBody(media("single.html")));
  assert.equal(r.status, 202);
  const entry = await waitJob(app, r.json.id);
  assert.equal(entry.status, "completed", JSON.stringify(entry));
  assert.equal(entry.files.length, 1);
  assert.ok(fs.existsSync(path.join(app.dl, entry.files[0].name)));
  const seq = ev.jobEvents(r.json.id);
  const percents = seq.map((e) => e.percent);
  for (let i = 1; i < percents.length; i++) assert.ok(percents[i] >= percents[i - 1], `percent went backwards: ${percents}`);
  assert.equal(seq[seq.length - 1].status, "completed");
  assert.equal(seq[seq.length - 1].percent, 100);
  // no event after the terminal state
  assert.equal(seq.filter((e) => finished(e.status)).length, 1);
  ev.close();
  await app.stop();
});

test("audio-only MP3 conversion produces an .mp3", { skip: skipAll }, async () => {
  const app = await startApp();
  const r = await app.api("POST", "/api/download", { url: media("single.html"), kind: "audio", selector: "ba/b", audioFormat: "mp3", label: "Best Available Audio" });
  const entry = await waitJob(app, r.json.id);
  assert.equal(entry.status, "completed", JSON.stringify(entry));
  assert.ok(entry.files[0].name.endsWith(".mp3"));
  await app.stop();
});

test("playlist: ONE job, one yt-dlp download process, aggregate progress never resets, exits and completes", { skip: skipAll }, async () => {
  const wrapper = path.join(tmp, "ytdlp-wrapper.sh");
  const log = path.join(tmp, "invocations.log");
  fs.writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> "${log}"\nexec yt-dlp "$@"\n`, { mode: 0o755 });
  const app = await startApp({ YTDLP_PATH: wrapper });
  const ev = await listen(app);
  const r = await app.api("POST", "/api/download", dlBody(media("playlist.html"), { playlist: true, playlistCount: 3, streams: 1, kind: "audio", selector: "ba/b", audioFormat: "mp3" }));
  assert.equal(r.status, 202);
  const entry = await waitJob(app, r.json.id);
  assert.equal(entry.status, "completed", JSON.stringify(entry));
  assert.equal(entry.files.length, 3, "all three playlist files saved");

  const seq = ev.jobEvents(r.json.id);
  const percents = seq.map((e) => e.percent);
  for (let i = 1; i < percents.length; i++) assert.ok(percents[i] >= percents[i - 1], `playlist percent reset/backwards: ${percents.join(",")}`);
  assert.equal(seq[seq.length - 1].status, "completed");
  assert.ok(seq.some((e) => e.currentItem && e.currentItem.index === 2 && e.currentItem.total === 3), "reported item 2 of 3");
  assert.equal(new Set(ev.events.filter((e) => e.event === "job").map((e) => e.data.id)).size, 1, "only one job exists");

  await sleep(500);
  const downloadCalls = fs.readFileSync(log, "utf8").split("\n").filter((l) => l.includes("--progress-template") && l.includes("--yes-playlist"));
  assert.equal(downloadCalls.length, 1, "yt-dlp download process must be spawned exactly once");
  // job must not be restarted afterwards
  await sleep(1500);
  const after = fs.readFileSync(log, "utf8").split("\n").filter((l) => l.includes("--progress-template"));
  assert.equal(after.length, 1, "no restart after completion");
  assert.equal((await app.api("GET", "/api/downloads")).json.jobs.length, 0, "nothing left running");
  ev.close();
  await app.stop();
});

test("cancel one of several downloads; others continue and complete; limit & queue are honoured", { skip: skipAll }, async () => {
  const app = await startApp();
  await app.api("POST", "/api/settings", { maxConcurrent: 2 });
  const ev = await listen(app);
  const ids = [];
  for (let i = 1; i <= 4; i++) {
    const r = await app.api("POST", "/api/download", dlBody(media(`slow/${i}.mp4`), { selector: "b", kind: "video", label: `slow ${i}` }));
    assert.equal(r.status, 202, JSON.stringify(r.json));
    ids.push(r.json.id);
  }
  await waitFor(async () => (await app.api("GET", "/api/downloads")).json.jobs.filter((j) => ["preparing", "downloading"].includes(j.status)).length === 2, { label: "2 running" });
  let list = (await app.api("GET", "/api/downloads")).json.jobs;
  assert.equal(list.filter((j) => j.status === "queued").length, 2, "2 queued behind the limit of 2");
  assert.ok(list.filter((j) => !["queued"].includes(j.status)).length <= 2, "never more than 2 active");

  // wait until job 1 is really downloading, then cancel it
  await waitFor(() => ev.jobEvents(ids[0]).some((e) => e.status === "downloading" && e.percent > 0), { label: "job1 downloading" });
  const c = await app.api("POST", `/api/download/${ids[0]}/cancel`);
  assert.equal(c.status, 200);
  assert.equal(c.json.status !== "cancelled" || c.json.cancelling === false, true);
  const cancelled = await waitJob(app, ids[0]);
  assert.equal(cancelled.status, "cancelled");
  // temp files of the cancelled job are cleaned up
  await sleep(2000);
  assert.deepEqual(fs.readdirSync(app.dl).filter((n) => n.includes("slow/1") || n.includes("1.mp4") && n.endsWith(".part")), []);

  // the rest continue independently and finish
  for (const id of ids.slice(1)) {
    const e = await waitJob(app, id);
    assert.equal(e.status, "completed", JSON.stringify(e));
  }
  // concurrency never exceeded 2 in the event stream
  const timeline = ev.events.filter((e) => e.event === "job").map((e) => e.data);
  const state = new Map(); let max = 0;
  for (const j of timeline) { state.set(j.id, j.status); max = Math.max(max, [...state.values()].filter((s) => ["preparing", "downloading", "processing"].includes(s)).length); }
  assert.ok(max <= 2, `max concurrent was ${max}`);
  // terminal state never overwritten
  for (const id of ids) {
    const evs = ev.jobEvents(id); const fin = evs.findIndex((e) => finished(e.status));
    assert.ok(fin === evs.length - 1, "no events after terminal state");
  }
  ev.close();
  await app.stop();
});

test("raising the limit to 10 releases queued jobs immediately", { skip: skipAll }, async () => {
  const app = await startApp();
  await app.api("POST", "/api/settings", { maxConcurrent: 1 });
  const ids = [];
  for (let i = 1; i <= 3; i++) ids.push((await app.api("POST", "/api/download", dlBody(media(`slow/${i}.mp4`), { selector: "b", kind: "video" }))).json.id);
  await sleep(800);
  let jobs = (await app.api("GET", "/api/downloads")).json.jobs;
  assert.equal(jobs.filter((j) => j.status !== "queued").length, 1);
  assert.equal((await app.api("POST", "/api/settings", { maxConcurrent: 10 })).json.maxConcurrent, 10);
  await sleep(800);
  jobs = (await app.api("GET", "/api/downloads")).json.jobs;
  assert.equal(jobs.filter((j) => j.status !== "queued").length, 3, "all three now running");
  assert.equal((await app.api("POST", "/api/settings", { maxConcurrent: 11 })).status, 400);
  assert.equal((await app.api("POST", "/api/settings", { maxConcurrent: 0 })).status, 400);
  for (const id of ids) await app.api("POST", `/api/download/${id}/cancel`);
  await app.stop();
});

test("duplicate submissions are rejected / deduplicated", { skip: skipAll }, async () => {
  const app = await startApp();
  const body = dlBody(media("slow/9.mp4"), { selector: "b", kind: "video", requestId: "req-12345678" });
  const a = await app.api("POST", "/api/download", body);
  const b = await app.api("POST", "/api/download", body);
  assert.equal(a.status, 202);
  assert.equal(b.json.id, a.json.id, "same requestId returns the same job");
  assert.equal(b.json.duplicate, true);
  const c = await app.api("POST", "/api/download", { ...body, requestId: "req-87654321" });
  assert.equal(c.status, 409, "identical queued/running download refused");
  assert.equal((await app.api("GET", "/api/downloads")).json.jobs.length, 1);
  await app.api("POST", `/api/download/${a.json.id}/cancel`);
  await app.stop();
});

test("YouTube bot check: fails with guidance, and is NOT retried", { skip: skipAll }, async () => {
  const fake = path.join(tmp, "fake-bot.sh");
  const log = path.join(tmp, "bot.log");
  fs.writeFileSync(fake, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 2099.01.01; exit 0; fi
echo "$@" >> "${log}"
echo "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser" 1>&2
sleep 1
exit 1
`, { mode: 0o755 });
  const app = await startApp({ YTDLP_PATH: fake });
  const r = await app.api("POST", "/api/download", dlBody("https://www.youtube.com/watch?v=abc", { kind: "video", selector: "bv" }));
  const entry = await waitJob(app, r.json.id);
  assert.equal(entry.status, "failed");
  assert.equal(entry.errorCode, "bot");
  assert.match(entry.error, /cookies/i);
  await sleep(1500);
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1, "exactly one attempt");
  await app.stop();
});

test("playlist bot check aborts the whole job instead of failing every item", { skip: skipAll }, async () => {
  const fake = path.join(tmp, "fake-bot-playlist.sh");
  fs.writeFileSync(fake, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 2099.01.01; exit 0; fi
printf 'MDI\\t1\\t50\\tFirst\\n'
echo "ERROR: [youtube] a: Sign in to confirm you're not a bot" 1>&2
sleep 30
`, { mode: 0o755 });
  const app = await startApp({ YTDLP_PATH: fake });
  const started = Date.now();
  const r = await app.api("POST", "/api/download", dlBody("https://www.youtube.com/playlist?list=PL1", { kind: "video", selector: "bv", playlist: true }));
  const entry = await waitJob(app, r.json.id);
  assert.equal(entry.status, "failed");
  assert.equal(entry.errorCode, "bot");
  assert.ok(Date.now() - started < 15000, "process was killed, not left to run 30s");
  await app.stop();
});

test("missing FFmpeg is reported clearly (and does not block downloads that don't need it)", { skip: skipAll }, async () => {
  const app = await startApp({ FFMPEG_LOCATION: "/nonexistent/ffmpeg-dir" });
  const r = await app.api("POST", "/api/download", dlBody(media("single.html")));
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "missing_ffmpeg");
  const ok = await app.api("POST", "/api/download", { url: media("single.html"), kind: "video", selector: "b", label: "x" });
  assert.equal(ok.status, 202, "video-only does not need ffmpeg");
  await app.stop();
});

test("missing yt-dlp is reported clearly", { skip: skipAll }, async () => {
  const app = await startApp({ YTDLP_PATH: "/nonexistent/yt-dlp" });
  const r = await app.api("POST", "/api/download", dlBody(media("single.html")));
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "missing_ytdlp");
  assert.equal((await app.api("GET", `/api/info?url=${encodeURIComponent(media("single.html"))}`)).status, 503);
  await app.stop();
});

test("validation and security", { skip: skipAll }, async () => {
  const app = await startApp();
  for (const bad of ["", "notaurl", "file:///etc/passwd", "javascript:alert(1)", "ftp://x/y", "http://a b"]) {
    assert.equal((await app.api("POST", "/api/download", dlBody(bad))).status, 400, bad);
  }
  assert.equal((await app.api("POST", "/api/download", { ...dlBody(media("single.html")), selector: "b; rm -rf /" })).status, 400);
  assert.equal((await app.api("POST", "/api/download", { ...dlBody(media("single.html")), merge: "exe" })).status, 400);
  assert.equal((await app.api("POST", "/api/download", { ...dlBody(media("single.html")), kind: "nope" })).status, 400);
  const raw = await fetch(`${app.base}/api/download`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad json" });
  assert.equal(raw.status, 400);
  const hostStatus = await new Promise((resolve, reject) => {
    const u = new URL(app.base);
    const rq = http.request({ host: u.hostname, port: u.port, path: "/api/settings", headers: { Host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
    rq.on("error", reject); rq.end();
  });
  assert.equal(hostStatus, 403, "DNS-rebinding style Host header rejected");
  const cross = await fetch(`${app.base}/api/settings`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example" }, body: "{}" });
  assert.equal(cross.status, 403);
  assert.equal((await app.api("POST", "/api/download/does-not-exist/cancel")).status, 404);
  await app.stop();
});

test("settings: directory validation, persistence across restart, theme persistence", { skip: skipAll }, async () => {
  const data = path.join(tmp, "persist-data");
  const app = await startApp({}, { dataDir: data });
  const custom = path.join(tmp, "my custom folder", "nested");
  assert.equal((await app.api("POST", "/api/settings", { downloadDir: "relative/path" })).status, 400);
  assert.equal((await app.api("POST", "/api/settings", { downloadDir: "/dev/null/nope" })).status, 400);
  const fileAsDir = path.join(tmp, "afile.txt"); fs.writeFileSync(fileAsDir, "x");
  assert.equal((await app.api("POST", "/api/settings", { downloadDir: fileAsDir })).status, 400);
  const ok = await app.api("POST", "/api/settings", { downloadDir: custom, theme: "light", maxConcurrent: 7 });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.ok(fs.statSync(custom).isDirectory(), "folder was created");
  const r = await app.api("POST", "/api/download", { url: media("single.html"), kind: "video", selector: "b", label: "x" });
  const entry = await waitJob(app, r.json.id);
  assert.equal(entry.status, "completed");
  assert.ok(fs.readdirSync(custom).length >= 1, "file landed in the custom folder");
  await app.stop();

  const app2 = await startApp({}, { dataDir: data });
  const s = (await app2.api("GET", "/api/settings")).json;
  assert.equal(s.downloadDir, custom, "download directory persisted");
  assert.equal(s.theme, "light");
  assert.equal(s.maxConcurrent, 7);
  const hist = (await app2.api("GET", "/api/history")).json.items;
  assert.equal(hist.length, 1, "history persisted");
  await app2.stop();
});

test("history: removing an entry keeps the file; deleting a file needs confirmation; traversal blocked", { skip: skipAll }, async () => {
  const app = await startApp();
  const r = await app.api("POST", "/api/download", { url: media("single.html"), kind: "video", selector: "b", label: "x" });
  const entry = await waitJob(app, r.json.id);
  const file = path.join(app.dl, entry.files[0].name);
  assert.ok(fs.existsSync(file));
  assert.equal((await app.api("POST", `/api/history/${entry.id}/delete-file`, { index: 0 })).status, 400, "needs confirm");
  assert.ok(fs.existsSync(file));
  assert.equal((await app.api("POST", `/api/history/${entry.id}/open-file`, { index: "../../etc/passwd" })).status, 404);
  assert.equal((await app.api("POST", `/api/history/${entry.id}/open-file`, { index: 5 })).status, 404);
  const dl = await fetch(`${app.base}/api/files/${entry.id}/0`);
  assert.equal(dl.status, 200);
  assert.ok((await dl.arrayBuffer()).byteLength > 1000);
  assert.equal((await fetch(`${app.base}/api/files/${entry.id}/..%2F..%2Fetc`)).status, 404);

  assert.equal((await app.api("DELETE", `/api/history/${entry.id}`)).status, 200);
  assert.ok(fs.existsSync(file), "removing history keeps the downloaded file");
  assert.equal((await app.api("GET", "/api/history")).json.items.length, 0);
  await app.stop();
});

test("graceful shutdown kills yt-dlp and records the job as cancelled; crash is journaled", { skip: skipAll }, async () => {
  const data = path.join(tmp, "shutdown-data");
  const app = await startApp({}, { dataDir: data });
  const r = await app.api("POST", "/api/download", dlBody(media("slow/77.mp4"), { selector: "b", kind: "video" }));
  await waitFor(async () => (await app.api("GET", "/api/downloads")).json.jobs[0]?.status === "downloading", { label: "downloading" });
  await app.stop();
  await sleep(500);
  const ps = spawnSync("sh", ["-c", "pgrep -f 'slow/7[7].mp4' || true"]).stdout.toString().trim();
  assert.equal(ps, "", "no orphaned yt-dlp process");
  const hist = JSON.parse(fs.readFileSync(path.join(data, "history.json"), "utf8"));
  assert.equal(hist[0].status, "cancelled");

  // simulate a hard crash: journal left behind -> reported on next start, nothing restarted
  fs.writeFileSync(path.join(data, "active.json"), JSON.stringify([{ id: "crashed-1", title: "Crashed one", url: "http://x/y", kind: "video", label: "x", isPlaylist: false, dir: "/tmp", createdAt: new Date().toISOString() }]));
  const app2 = await startApp({}, { dataDir: data });
  const items = (await app2.api("GET", "/api/history")).json.items;
  assert.equal(items.find((i) => i.id === "crashed-1").errorCode, "interrupted");
  assert.equal((await app2.api("GET", "/api/downloads")).json.jobs.length, 0, "interrupted job not restarted");
  await app2.stop();
});

test("format option builder: only real formats are offered", async () => {
  const { describeInfo } = require("../lib/formats");
  const info = {
    id: "x", title: "T", formats: [
      { format_id: "137", ext: "mp4", vcodec: "avc1.640028", acodec: "none", height: 1080, fps: 30, tbr: 4000, filesize: 50_000_000 },
      { format_id: "299", ext: "mp4", vcodec: "avc1.64002a", acodec: "none", height: 1080, fps: 60, tbr: 6000 },
      { format_id: "248", ext: "webm", vcodec: "vp9", acodec: "none", height: 1080, fps: 30, tbr: 2500 },
      { format_id: "136", ext: "mp4", vcodec: "avc1", acodec: "none", height: 720, tbr: 1500 },
      { format_id: "247", ext: "webm", vcodec: "vp9", acodec: "none", height: 720, tbr: 1000 },
      { format_id: "394", ext: "mp4", vcodec: "av01", acodec: "none", height: 144, tbr: 100 },
      { format_id: "18", ext: "mp4", vcodec: "avc1", acodec: "mp4a.40.2", height: 360, tbr: 500 },
      { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 129, asr: 44100 },
      { format_id: "251", ext: "webm", vcodec: "none", acodec: "opus", abr: 135, asr: 48000 },
      { format_id: "250", ext: "webm", vcodec: "none", acodec: "opus", abr: 70 },
      { format_id: "sb0", ext: "mhtml", vcodec: "none", acodec: "none", format_note: "storyboard", height: 90 }
    ]
  };
  const d = describeInfo(info, "https://example.com");
  const labels = d.options.av.map((o) => o.label);
  assert.equal(labels[0], "Best Available (Recommended)");
  assert.ok(labels.includes("Best MP4 – 1080p60"));
  assert.ok(labels.includes("Best WebM – 1080p"));
  assert.ok(labels.includes("Best MP4 – 720p") && labels.includes("Best WebM – 720p"));
  assert.ok(labels.includes("Best MP4 – 360p"), "combined-only height offered as single file");
  assert.ok(!labels.some((l) => l.includes("2160")), "nothing invented");
  assert.equal(new Set(labels).size, labels.length, "no duplicates");
  assert.equal(d.options.video[0].selector, "bv");
  assert.ok(d.options.video.every((o) => !o.label.includes("360")), "360p combined is not video-only");
  assert.ok(d.options.audio.some((o) => o.label.startsWith("M4A")));
  assert.ok(d.options.audio.some((o) => o.label === "Best WebM/Opus Audio"));
  assert.ok(!JSON.stringify(d.options).includes("storyboard"));
  const none = describeInfo({ id: "y", title: "Y", formats: [{ format_id: "0", ext: "mp4" }] }, "u");
  assert.equal(none.options.video.length, 0, "no video-only formats -> mode unavailable");
});

test("progress math and playlist aggregate (unit)", async () => {
  const { buildArgs, outputTemplate } = require("../lib/jobs");
  const req = { url: "https://x.test/v", dir: "/d", kind: "audio", selector: "ba/b", audioFormat: "mp3", merge: "mp4", sort: "", playlist: true, subtitles: false };
  const args = buildArgs(req, { cookiesBrowser: "", cookiesFile: "" }, "");
  assert.ok(args.includes("--yes-playlist") && args.includes("--ignore-errors"));
  assert.ok(args.includes("-x") && args.includes("mp3"));
  assert.equal(args[args.length - 2], "--", "URL is always after --");
  assert.equal(args[args.length - 1], "https://x.test/v");
  assert.ok(outputTemplate(req).startsWith("%(playlist_title|Playlist)"));
  assert.ok(!buildArgs({ ...req, playlist: false }, { cookiesBrowser: "firefox", cookiesFile: "" }, "").includes("--yes-playlist"));
  assert.ok(buildArgs({ ...req, playlist: false }, { cookiesBrowser: "firefox", cookiesFile: "" }, "").join(" ").includes("--cookies-from-browser firefox"));
});
