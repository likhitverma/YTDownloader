"use strict";

const express = require("express");
const helmet = require("helmet");
const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("./lib/config");
const store = require("./lib/store");
const deps = require("./lib/deps");
const system = require("./lib/system");
const formats = require("./lib/formats");
const { runCapture, killTree } = require("./lib/proc");
const { classify, lastErrorLine } = require("./lib/errors");
const { JobManager } = require("./lib/jobs");
const {
  HttpError, validateUrl, normalizeDownloadRequest, normalizeSettingsPatch, prepareDownloadDir, isInside
} = require("./lib/validate");

const app = express();
const jobs = new JobManager();
const PORT = config.PORT;

fs.mkdirSync(store.getSettings().downloadDir, { recursive: true });

/* ------------------------------------------------------------------ security */

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));

// Local-only hardening: block DNS-rebinding (Host check) and cross-site requests (Origin check).
const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
app.use((req, res, next) => {
  if (!allowedHosts.has(String(req.headers.host || "").toLowerCase())) {
    return res.status(403).json({ error: "Forbidden host." });
  }
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let originHost = "";
    try { originHost = new URL(origin).host.toLowerCase(); } catch { /* invalid */ }
    if (!allowedHosts.has(originHost)) return res.status(403).json({ error: "Forbidden origin." });
  } else if (origin === "null") {
    return res.status(403).json({ error: "Forbidden origin." });
  }
  next();
});

app.use(express.json({ limit: "32kb" }));
app.use(express.static(config.PUBLIC_DIR, { maxAge: 0, etag: true }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ----------------------------------------------------------------------- SSE */

const sseClients = new Set();

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const client of sseClients) sseSend(client, event, data);
}
jobs.on("job", (view) => broadcast("job", view));
jobs.on("history", (info) => broadcast("history", info));

app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  // Reconnecting only re-sends state. It can never start or restart a download.
  sseSend(res, "snapshot", { jobs: jobs.list() });
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

setInterval(() => {
  for (const client of sseClients) client.write(": ping\n\n");
}, 25000).unref();

/* ---------------------------------------------------------------- settings */

function publicSettings() {
  const s = store.getSettings();
  return {
    theme: s.theme,
    downloadDir: s.downloadDir,
    maxConcurrent: s.maxConcurrent,
    maxConcurrentLimit: config.MAX_CONCURRENT_LIMIT,
    cookiesBrowser: s.cookiesBrowser,
    cookiesFile: s.cookiesFile,
    canPickFolder: process.platform === "win32",
    platform: process.platform
  };
}

app.get("/api/settings", (_req, res) => res.json(publicSettings()));

app.post("/api/settings", (req, res) => {
  const patch = normalizeSettingsPatch(req.body, { maxConcurrentLimit: config.MAX_CONCURRENT_LIMIT });
  const current = store.getSettings();
  const next = { ...current };
  if ("downloadDir" in patch) {
    next.downloadDir = prepareDownloadDir(patch.downloadDir);
    if (!next.knownDirs.includes(next.downloadDir)) next.knownDirs = [...next.knownDirs, next.downloadDir].slice(-30);
    delete patch.downloadDir;
  }
  Object.assign(next, patch);
  store.saveSettings(next);
  jobs.pump(); // a higher concurrency limit may release queued jobs immediately
  res.json(publicSettings());
});

app.post("/api/select-folder", wrap(async (_req, res) => {
  try {
    const chosen = await system.pickFolder(store.getSettings().downloadDir);
    res.json({ path: chosen, cancelled: !chosen });
  } catch (error) {
    throw new HttpError(error.status || 500, error.message, error.status === 501 ? "unsupported" : "picker_failed");
  }
}));

app.post("/api/open-folder", wrap(async (_req, res) => {
  const dir = store.getSettings().downloadDir; // never taken from the request
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new HttpError(400, `The download folder does not exist: ${dir}`, "bad_dir");
  }
  try {
    await system.openFolder(dir);
  } catch (error) {
    throw new HttpError(500, `Could not open the folder: ${error.message}`);
  }
  res.json({ ok: true, path: dir });
}));

/* ------------------------------------------------------------------ health */

app.get("/api/health", wrap(async (req, res) => {
  const d = await deps.checkDeps(req.query.refresh === "1");
  const dir = store.getSettings().downloadDir;
  let dirOk = true;
  try { fs.accessSync(dir, fs.constants.W_OK); } catch { dirOk = false; }
  res.json({
    ok: true,
    platform: os.platform(),
    node: process.version,
    ytdlp: d.ytdlp,
    ffmpeg: d.ffmpeg,
    downloadDir: { path: dir, ok: dirOk }
  });
}));

/* -------------------------------------------------------------------- info */

let infoRunning = 0;

app.get("/api/info", wrap(async (req, res) => {
  const url = validateUrl(req.query.url);
  const wantPlaylist = req.query.playlist === "1";
  if (infoRunning >= 4) throw new HttpError(429, "Too many information requests at once. Try again in a moment.");

  const d = await deps.checkDeps();
  if (!d.ytdlp.ok) {
    throw new HttpError(503, "yt-dlp was not found. Install it (winget install yt-dlp.yt-dlp) or set YTDLP_PATH, then restart MediaDock.", "missing_ytdlp");
  }

  const settings = store.getSettings();
  const args = ["-J", "--no-warnings", "--flat-playlist", wantPlaylist ? "--yes-playlist" : "--no-playlist",
    "--retries", "2", "--extractor-retries", "1", "--socket-timeout", "30"];
  if (settings.cookiesFile) args.push("--cookies", settings.cookiesFile);
  else if (settings.cookiesBrowser) args.push("--cookies-from-browser", settings.cookiesBrowser);
  args.push("--", url);

  infoRunning += 1;
  let aborted = false;
  let childRef = null;
  const onClose = () => { if (!res.writableEnded) { aborted = true; killTree(childRef); } };
  res.on("close", onClose);

  let result;
  try {
    result = await runCapture(deps.ytdlpCommand(), args, {
      timeoutMs: 90000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      onChild: (child) => { childRef = child; }
    });
  } finally {
    infoRunning -= 1;
    res.off("close", onClose);
  }
  if (aborted) return;

  if (result.error) {
    if (result.error.code === "ENOENT") throw new HttpError(503, "yt-dlp was not found.", "missing_ytdlp");
    throw new HttpError(500, `Could not run yt-dlp: ${result.error.message}`);
  }
  if (result.timedOut) throw new HttpError(504, "Reading the video information took too long. Check your connection and try again.");
  if (result.tooBig) throw new HttpError(413, "The information response was unexpectedly large.");
  if (result.code !== 0) {
    const cls = classify(result.stderr);
    throw new HttpError(cls && cls.code === "bot" ? 403 : 400, cls ? cls.message : (lastErrorLine(result.stderr) || "Could not read information for this URL."), cls ? cls.code : "info_failed");
  }
  let info;
  try { info = JSON.parse(result.stdout); } catch { throw new HttpError(502, "yt-dlp returned information in an unexpected format."); }
  if (!info || typeof info !== "object") throw new HttpError(502, "yt-dlp returned no information for this URL.");
  res.json(formats.describeInfo(info, url));
}));

/* --------------------------------------------------------------- downloads */

app.post("/api/download", wrap(async (req, res) => {
  const request = normalizeDownloadRequest(req.body);
  const d = await deps.checkDeps();
  if (!d.ytdlp.ok) {
    throw new HttpError(503, "yt-dlp was not found. Install it (winget install yt-dlp.yt-dlp) or set YTDLP_PATH, then restart MediaDock.", "missing_ytdlp");
  }
  const needsFfmpeg = request.kind === "av" || (request.kind === "audio" && request.audioFormat !== "original");
  if (needsFfmpeg && !d.ffmpeg.ok) {
    throw new HttpError(503, "FFmpeg was not found, but this download needs it (merging or audio conversion). Install FFmpeg (winget install Gyan.FFmpeg) and restart MediaDock, or set FFMPEG_LOCATION.", "missing_ffmpeg");
  }
  const { job, duplicate } = jobs.create(request);
  res.status(duplicate ? 200 : 202).json({ ...jobs.view(job), duplicate });
}));

app.get("/api/downloads", (_req, res) => res.json({ jobs: jobs.list() }));

app.post("/api/download/:id/cancel", (req, res) => {
  res.json(jobs.cancel(String(req.params.id)));
});

/* ----------------------------------------------------------------- history */

function allowedRoots() {
  const roots = new Set(store.getSettings().knownDirs || []);
  roots.add(store.getSettings().downloadDir);
  return [...roots];
}

/** Resolves a recorded output file, refusing anything outside a folder MediaDock has downloaded into. */
function resolveHistoryFile(id, indexValue) {
  const entry = store.getHistory().find((h) => h.id === id);
  if (!entry) throw new HttpError(404, "History entry not found.", "not_found");
  const index = Number.parseInt(indexValue, 10);
  const file = Number.isInteger(index) && entry.files ? entry.files[index] : null;
  if (!file) throw new HttpError(404, "That file is not part of this download.", "not_found");
  const resolved = path.resolve(file.path);
  if (!allowedRoots().some((root) => isInside(root, resolved)) || (entry.dir && !isInside(entry.dir, resolved))) {
    throw new HttpError(403, "That file is outside the download folders.", "forbidden");
  }
  return { entry, file, resolved };
}

function publicHistoryEntry(entry) {
  return {
    id: entry.id,
    title: entry.title,
    url: entry.url,
    kind: entry.kind,
    label: entry.label,
    isPlaylist: !!entry.isPlaylist,
    status: entry.status,
    message: entry.message || "",
    error: entry.error || "",
    errorCode: entry.errorCode || "",
    errorDetails: entry.errorDetails || "",
    warning: entry.warning || "",
    thumbnail: entry.thumbnail || "",
    dir: entry.dir || "",
    fileCount: entry.fileCount ?? (entry.files ? entry.files.length : 0),
    itemsTotal: entry.itemsTotal || null,
    createdAt: entry.createdAt,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    files: (entry.files || []).slice(0, 200).map((f, index) => {
      let missing = false;
      try { fs.accessSync(f.path); } catch { missing = true; }
      return { index, name: f.name, size: f.size, missing };
    }),
    request: entry.request || null
  };
}

app.get("/api/history", (_req, res) => {
  res.json({ items: store.getHistory().map(publicHistoryEntry) });
});

app.delete("/api/history/:id", (req, res) => {
  const list = store.getHistory();
  const next = list.filter((h) => h.id !== req.params.id);
  if (next.length === list.length) throw new HttpError(404, "History entry not found.", "not_found");
  store.saveHistory(next); // removes the entry only; files on disk are untouched
  res.json({ ok: true });
});

app.delete("/api/history", (_req, res) => {
  store.saveHistory([]);
  res.json({ ok: true });
});

app.post("/api/history/:id/open-file", wrap(async (req, res) => {
  const { resolved } = resolveHistoryFile(req.params.id, req.body && req.body.index);
  if (!fs.existsSync(resolved)) throw new HttpError(404, "The file no longer exists on disk.", "missing");
  try {
    await system.openFile(resolved);
  } catch (error) {
    throw new HttpError(error.status || 500, error.message);
  }
  res.json({ ok: true });
}));

app.post("/api/history/:id/reveal", wrap(async (req, res) => {
  const { entry, resolved } = resolveHistoryFile(req.params.id, req.body && req.body.index);
  try {
    if (fs.existsSync(resolved)) await system.revealFile(resolved);
    else if (entry.dir && fs.existsSync(entry.dir)) await system.openFolder(path.dirname(resolved));
    else throw new HttpError(404, "The file and its folder no longer exist.", "missing");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, `Could not open Explorer: ${error.message}`);
  }
  res.json({ ok: true });
}));

app.post("/api/history/:id/delete-file", wrap(async (req, res) => {
  if (!req.body || req.body.confirm !== true) throw new HttpError(400, "Deleting a file requires confirmation.", "confirm_required");
  const { resolved } = resolveHistoryFile(req.params.id, req.body.index);
  try {
    fs.unlinkSync(resolved);
  } catch (error) {
    if (error.code === "ENOENT") throw new HttpError(404, "The file was already deleted.", "missing");
    throw new HttpError(500, `Could not delete the file: ${error.code || error.message}`);
  }
  res.json({ ok: true });
}));

// Browser download of a recorded output file.
app.get("/api/files/:id/:index", (req, res, next) => {
  const { resolved } = resolveHistoryFile(req.params.id, req.params.index);
  if (!fs.existsSync(resolved)) throw new HttpError(404, "The file no longer exists on disk.", "missing");
  res.download(resolved, path.basename(resolved), (error) => { if (error && !res.headersSent) next(error); });
});

/* ------------------------------------------------------------------ errors */

app.use("/api", (req, res) => res.status(404).json({ error: "Unknown API endpoint." }));

app.use((error, _req, res, _next) => {
  if (error && error.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON request." });
  if (error && error.type === "entity.too.large") return res.status(413).json({ error: "Request too large." });
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message, code: error.code });
  console.error("[MediaDock] Unexpected error:", error);
  if (res.headersSent) return undefined;
  return res.status(500).json({ error: "Unexpected server error. See the MediaDock terminal for details." });
});

/* ----------------------------------------------------------------- startup */

const server = app.listen(PORT, config.HOST, () => {
  const s = store.getSettings();
  console.log(`MediaDock running at http://${config.HOST}:${PORT}`);
  console.log(`Download folder: ${s.downloadDir}`);
  console.log(`Simultaneous downloads: ${s.maxConcurrent}`);
  deps.checkDeps(true).then((d) => {
    console.log(`yt-dlp: ${d.ytdlp.ok ? d.ytdlp.version : "NOT FOUND (install it, see README)"}`);
    console.log(`FFmpeg: ${d.ffmpeg.ok ? d.ffmpeg.version : "NOT FOUND (merging and audio conversion will not work)"}`);
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Is MediaDock already running? Close it, or start with a different port (PORT=3001).`);
  } else {
    console.error("Server error:", error);
  }
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nShutting down (${signal}). Stopping active downloads…`);
  jobs.shutdown(); // kills yt-dlp/ffmpeg process trees and records them in the history
  for (const client of sseClients) client.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGBREAK", () => shutdown("SIGBREAK"));
process.on("exit", () => { if (!shuttingDown) jobs.shutdown(); });
process.on("unhandledRejection", (reason) => console.error("[MediaDock] Unhandled rejection:", reason));
process.on("uncaughtException", (error) => console.error("[MediaDock] Uncaught exception:", error));

module.exports = { app, server };
