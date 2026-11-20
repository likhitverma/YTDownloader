"use strict";
// JobManager: owns every download. One yt-dlp process per job, a bounded queue, and a strict
// state machine:  queued -> preparing -> downloading <-> processing -> completed | failed | cancelled
// Terminal states are final: late output from a dying process can never change them.

const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const config = require("./config");
const store = require("./store");
const deps = require("./deps");
const { spawnOptions, killTree, killTreeSync } = require("./proc");
const { classify, lastErrorLine } = require("./errors");
const { HttpError, isInside } = require("./validate");

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const IS_WIN = process.platform === "win32";
const TAB = "\t";
const MARKER_RE = /(?:^|\r)(MDP|MDI|MDF|MDQ)\t(.*)$/;
const RETAIN_FINISHED_MS = 10 * 60 * 1000;

const PP_LABELS = {
  Merger: "Merging video and audio",
  ExtractAudio: "Converting audio",
  VideoConvertor: "Converting video",
  VideoRemuxer: "Remuxing video",
  FFmpegMerger: "Merging video and audio",
  EmbedSubtitle: "Embedding subtitles",
  FFmpegSubtitlesConvertor: "Converting subtitles",
  MoveFiles: "Finalizing files",
  Concat: "Finalizing playlist"
};

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const nowIso = () => new Date().toISOString();

function parseNum(value) {
  if (value === undefined) return null;
  const text = String(value).trim();
  if (!text || text === "NA" || text === "None") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Output filename template (placed under -P <download dir>). */
function outputTemplate(request) {
  let name = "%(title).150B [%(id)s]";
  if (request.kind === "av") name += "%(height& {}p|)s";
  if (request.kind === "video") name += "%(height& {}p|)s (video only)";
  name += ".%(ext)s";
  if (request.playlist) name = `%(playlist_title|Playlist).100B/%(playlist_index&{} - |)s${name}`;
  return name;
}

function cookieArgs(settings) {
  if (settings.cookiesFile) return ["--cookies", settings.cookiesFile];
  if (settings.cookiesBrowser) return ["--cookies-from-browser", settings.cookiesBrowser];
  return [];
}

/** The complete yt-dlp argument list for a job. Pure function, so it can be unit-tested. */
function buildArgs(request, settings, ffmpegLocation = "") {
  const args = [
    "--newline", "--no-warnings", "--progress", "--no-simulate", "--no-mtime",
    "--retries", "3", "--fragment-retries", "3", "--extractor-retries", "2", "--socket-timeout", "30",
    // Machine-readable markers (see handleMarker). Tab-separated; title is always last.
    "--progress-template", ["download:MDP", "%(progress.status)s", "%(progress.downloaded_bytes)s", "%(progress.total_bytes)s",
      "%(progress.total_bytes_estimate)s", "%(progress.speed)s", "%(progress.eta)s", "%(progress.fragment_index)s",
      "%(progress.fragment_count)s", "%(info.playlist_index)s", "%(info.n_entries)s", "%(progress.filename)s", "%(info.title)s"].join(TAB),
    "--progress-template", ["postprocess:MDQ", "%(progress.status)s", "%(progress.postprocessor)s"].join(TAB),
    "--print", ["before_dl:MDI", "%(playlist_index)s", "%(n_entries)s", "%(title)s"].join(TAB),
    "--print", ["after_move:MDF", "%(filepath)s"].join(TAB),
    "-P", request.dir,
    "-o", outputTemplate(request)
  ];
  if (IS_WIN) args.push("--windows-filenames");
  if (ffmpegLocation) args.push("--ffmpeg-location", ffmpegLocation);

  if (request.playlist) args.push("--yes-playlist", "--ignore-errors");
  else args.push("--no-playlist");

  args.push(...cookieArgs(settings));
  args.push("-f", request.selector);
  if (request.sort) args.push("-S", request.sort);

  if (request.kind === "av") {
    args.push("--merge-output-format", request.merge || "mp4");
  } else if (request.kind === "audio" && request.audioFormat !== "original") {
    args.push("-x", "--audio-format", request.audioFormat, "--audio-quality", "0");
  }
  if (request.subtitles) {
    args.push("--write-subs", "--write-auto-subs", "--sub-langs", "en,hi", "--convert-subs", "srt");
  }
  args.push("--", request.url);
  return args;
}

class JobManager extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.queue = [];            // ids of queued jobs, FIFO
    this.active = new Set();    // ids of jobs with a live process
    this.recentRequests = new Map(); // requestId -> jobId (duplicate-click protection)
    this.recoverInterrupted();
  }

  /* ---------- public API ---------- */

  create(request) {
    const settings = store.getSettings();

    if (request.requestId && this.recentRequests.has(request.requestId)) {
      const existing = this.jobs.get(this.recentRequests.get(request.requestId));
      if (existing) return { job: existing, duplicate: true };
    }

    const dir = settings.downloadDir;
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      throw new HttpError(400, `The download folder is not available or not writable: ${dir}. Choose another folder in Settings.`, "bad_dir");
    }

    const signature = JSON.stringify([request.url, request.kind, request.selector, request.merge, request.sort,
      request.audioFormat, request.playlist, request.subtitles, dir]);
    for (const other of this.jobs.values()) {
      if (!TERMINAL.has(other.status) && other.signature === signature) {
        throw new HttpError(409, "This exact download is already queued or running.", "duplicate");
      }
    }
    if (this.queue.length >= config.MAX_QUEUE) {
      throw new HttpError(429, `The queue is full (${config.MAX_QUEUE} waiting downloads).`, "queue_full");
    }

    const job = {
      id: crypto.randomUUID(),
      request: { ...request, dir },
      signature,
      url: request.url,
      kind: request.kind,
      label: request.label,
      isPlaylist: request.playlist,
      title: request.title || "",
      thumbnail: request.thumbnail || "",
      status: "queued",
      message: "Waiting for a free download slot…",
      percent: 0,
      percentScope: "overall",
      speedBps: null,
      etaSec: null,
      item: { index: null, total: request.playlistCount || null, title: "", done: false, sawProgress: false },
      stream: { index: 0, file: null, frac: 0 },
      expectedStreams: request.streams,
      itemsDone: 0,
      skipped: 0,
      errors: [],
      stderrTail: [],
      seenFiles: new Set(),
      files: [],
      fileRecords: [],
      dir,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      error: "",
      errorCode: "",
      errorDetails: "",
      warning: "",
      cancelRequested: false,
      finalized: false,
      child: null,
      seq: 0,
      lastEmit: 0,
      emitTimer: null
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    if (request.requestId) {
      this.recentRequests.set(request.requestId, job.id);
      setTimeout(() => this.recentRequests.delete(request.requestId), 10 * 60 * 1000).unref();
    }
    this.journal();
    this.publish(job, { force: true });
    this.pump();
    return { job, duplicate: false };
  }

  get(id) { return this.jobs.get(id) || null; }

  /** Jobs that are still queued or running. */
  list() {
    return [...this.jobs.values()].filter((j) => !TERMINAL.has(j.status)).map((j) => this.view(j));
  }

  /** Re-evaluates the queue (call after the concurrency setting changes). */
  pump() {
    const limit = store.getSettings().maxConcurrent;
    let changed = false;
    while (this.active.size < limit && this.queue.length) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job || job.status !== "queued") continue;
      changed = true;
      this.start(job);
    }
    if (changed || this.queue.length) this.refreshQueuePositions();
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, "Unknown download.", "not_found");
    if (TERMINAL.has(job.status)) throw new HttpError(409, "This download has already finished.", "finished");

    if (job.status === "queued") {
      this.queue = this.queue.filter((q) => q !== id);
      job.cancelRequested = true;
      this.finalize(job, { code: null });
      this.refreshQueuePositions();
      return this.view(job);
    }

    if (!job.cancelRequested) {
      job.cancelRequested = true;
      job.message = "Cancelling… waiting for the download process to stop.";
      this.publish(job, { force: true });
      killTree(job.child);
      // The job is only shown as Cancelled after the process is really gone (see finalize).
      job.cancelWatchdog = setTimeout(() => {
        if (!job.finalized) {
          job.message = "Still stopping… forcing the process to end.";
          killTree(job.child);
          this.publish(job, { force: true });
        }
      }, 8000);
      job.cancelWatchdog.unref();
    }
    return this.view(job);
  }

  /** Stop everything (server shutdown). Synchronous so it can run from process 'exit'. */
  shutdown() {
    for (const job of this.jobs.values()) {
      if (TERMINAL.has(job.status)) continue;
      job.cancelRequested = true;
      job.shutdown = true;
      if (job.child) killTreeSync(job.child);
      this.queue = this.queue.filter((q) => q !== job.id);
      this.finalize(job, { code: null });
    }
  }

  view(job) {
    return {
      id: job.id,
      url: job.url,
      kind: job.kind,
      label: job.label,
      title: job.title || job.item.title || "",
      thumbnail: job.thumbnail,
      isPlaylist: job.isPlaylist,
      status: job.status,
      cancelling: job.cancelRequested && !TERMINAL.has(job.status),
      message: job.message,
      percent: Math.round(job.percent * 10) / 10,
      percentScope: job.percentScope,
      speedBps: job.speedBps,
      etaSec: job.etaSec,
      currentItem: job.isPlaylist ? { index: job.item.index, total: job.item.total, title: job.item.title } : null,
      itemsDone: job.itemsDone,
      queuePosition: job.status === "queued" ? this.queue.indexOf(job.id) + 1 : 0,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      errorCode: job.errorCode,
      errorDetails: job.errorDetails,
      warning: job.warning,
      files: job.fileRecords.map((f, index) => ({ index, name: f.name, size: f.size })),
      seq: job.seq
    };
  }

  /* ---------- starting a process ---------- */

  start(job) {
    // Single synchronous section: status flips BEFORE spawning so no second start is possible.
    job.status = "preparing";
    job.startedAt = nowIso();
    job.message = "Starting yt-dlp…";
    this.active.add(job.id);
    this.journal();

    const settings = store.getSettings();
    const args = buildArgs(job.request, settings, deps.ffmpegLocation());
    let child;
    try {
      child = spawn(deps.ytdlpCommand(), args, spawnOptions({
        cwd: job.dir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
      }));
    } catch (error) {
      this.finalize(job, { error });
      return;
    }
    job.child = child;
    this.publish(job, { force: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const feed = (stream) => {
      let buffer = "";
      return (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\n/);
        buffer = lines.pop() || "";
        for (const line of lines) this.handleLine(job, line.replace(/\r$/, ""), stream);
        if (buffer.length > 20000) buffer = buffer.slice(-5000);
      };
    };
    child.stdout.on("data", feed("stdout"));
    child.stderr.on("data", feed("stderr"));

    child.on("error", (error) => this.finalize(job, { error }));
    child.on("exit", (code, signal) => {
      // 'close' normally follows immediately; this timer only covers an orphaned grandchild that
      // keeps the stdio pipes open after yt-dlp itself has exited.
      job.exitTimer = setTimeout(() => this.finalize(job, { code, signal }), 3000);
      job.exitTimer.unref();
    });
    child.on("close", (code, signal) => this.finalize(job, { code, signal }));
  }

  /* ---------- output parsing ---------- */

  handleLine(job, line, stream) {
    if (job.finalized) return; // terminal states are never overwritten by late output
    const match = MARKER_RE.exec(line);
    if (match) {
      this.handleMarker(job, match[1], match[2].split(TAB));
      return;
    }
    if (stream === "stderr" && line.trim()) {
      job.stderrTail.push(line.trim().slice(0, 600));
      if (job.stderrTail.length > 80) job.stderrTail.shift();
      if (/^ERROR:/i.test(line.trim())) {
        job.errors.push(line.trim());
        const cls = classify(line);
        if (cls && cls.fatal && !job.fatal && !job.cancelRequested) {
          // e.g. bot check / rate limit / disk full: stop now instead of repeating the failure per item.
          job.fatal = cls;
          killTree(job.child);
        }
      }
    }
  }

  handleMarker(job, kind, f) {
    if (kind === "MDI") this.onItemStart(job, f);
    else if (kind === "MDP") this.onProgress(job, f);
    else if (kind === "MDQ") this.onPostProcess(job, f);
    else if (kind === "MDF") this.onFile(job, f.join(TAB));
  }

  setActiveStatus(job, status, message) {
    if (TERMINAL.has(job.status)) return;
    job.status = status;
    if (!job.cancelRequested && message !== undefined) job.message = message;
  }

  onItemStart(job, [index, total, ...titleParts]) {
    const i = parseNum(index);
    const t = parseNum(total);
    job.item = {
      index: i ?? job.item.index,
      total: t ?? job.item.total,
      title: titleParts.join(TAB).trim(),
      done: false,
      sawProgress: false
    };
    if (!job.isPlaylist && !job.title) job.title = job.item.title;
    job.stream = { index: 0, file: null, frac: 0 };
    this.setActiveStatus(job, "downloading", job.isPlaylist && job.item.index
      ? `Item ${job.item.index}${job.item.total ? ` of ${job.item.total}` : ""}: starting…` : "Starting download…");
    this.recompute(job);
    this.publish(job);
  }

  onProgress(job, f) {
    const [status, downloaded, total, estimate, speed, eta, fragIdx, fragCnt, plIndex, plTotal, filename, ...titleParts] = f;
    const idx = parseNum(plIndex);
    const tot = parseNum(plTotal);
    if (idx !== null) job.item.index = idx;
    if (tot !== null) job.item.total = tot;
    const title = titleParts.join(TAB).trim();
    if (title && title !== "NA") {
      job.item.title = title;
      if (!job.isPlaylist && !job.title) job.title = title;
    }

    // A new filename within the same item means yt-dlp moved on to the next stream (video -> audio).
    if (filename && filename !== job.stream.file) {
      if (job.stream.file !== null) job.stream.index += 1;
      job.stream.file = filename;
      job.stream.frac = 0;
      if (job.seenFiles.size < 5000) job.seenFiles.add(filename);
    }

    const done = parseNum(downloaded);
    const size = parseNum(total) ?? parseNum(estimate);
    const fi = parseNum(fragIdx);
    const fc = parseNum(fragCnt);
    if (status === "finished") job.stream.frac = 1;
    else if (size && done !== null) job.stream.frac = Math.max(job.stream.frac, clamp01(done / size));
    else if (fc && fi !== null) job.stream.frac = Math.max(job.stream.frac, clamp01(fi / fc));
    // else: size unknown -> keep the previous fraction. Never invent progress.

    if (status === "downloading") {
      job.item.sawProgress = true;
      job.speedBps = parseNum(speed);
      job.etaSec = job.isPlaylist ? null : parseNum(eta);
      const itemText = job.isPlaylist && job.item.index
        ? `Item ${job.item.index}${job.item.total ? ` of ${job.item.total}` : ""}`
        : "Downloading";
      this.setActiveStatus(job, "downloading", itemText);
    }
    this.recompute(job);
    this.publish(job);
  }

  onPostProcess(job, [status, name]) {
    if (status !== "started") return;
    const label = PP_LABELS[name] || (name ? `Post-processing (${name})` : "Post-processing");
    job.speedBps = null;
    job.etaSec = null;
    if (job.isPlaylist) {
      const prefix = job.item.index ? `Item ${job.item.index}${job.item.total ? ` of ${job.item.total}` : ""}: ` : "";
      this.setActiveStatus(job, "downloading", `${prefix}${label.toLowerCase()}…`);
    } else {
      this.setActiveStatus(job, "processing", `${label}…`);
    }
    this.publish(job);
  }

  onFile(job, filePath) {
    const file = filePath.trim();
    if (!file || file === "NA") return;
    if (!job.files.includes(file)) job.files.push(file);
    job.itemsDone += 1;
    if (!job.item.sawProgress) job.skipped += 1;
    job.item.done = true;
    this.recompute(job);
    this.publish(job);
  }

  /** Overall percentage. Playlists: ((index-1) + itemFraction) / total, never reset per item. */
  recompute(job) {
    const streams = Math.max(job.expectedStreams, job.stream.index + 1);
    const itemFrac = job.item.done ? 1 : clamp01((job.stream.index + job.stream.frac) / streams);
    let pct;
    let scope = "overall";
    if (job.isPlaylist) {
      if (job.item.index && job.item.total) {
        pct = ((job.item.index - 1 + itemFrac) / job.item.total) * 100;
      } else {
        pct = itemFrac * 100; // index/total unknown: honest per-item progress
        scope = "item";
      }
    } else {
      pct = itemFrac * 100;
    }
    pct = Math.min(pct, 99); // 100% is reserved for the real "process exited successfully"
    job.percentScope = scope;
    job.percent = scope === "overall" ? Math.max(job.percent, pct) : pct; // never jumps backwards
  }

  /* ---------- finishing ---------- */

  finalize(job, { code = null, signal = null, error = null } = {}) {
    if (job.finalized) return;
    job.finalized = true;
    clearTimeout(job.exitTimer);
    clearTimeout(job.cancelWatchdog);
    clearTimeout(job.emitTimer);
    job.emitTimer = null;
    this.active.delete(job.id);
    job.child = null;
    job.finishedAt = nowIso();
    job.speedBps = null;
    job.etaSec = null;

    // Only report files that really exist on disk.
    job.fileRecords = [];
    let missing = 0;
    for (const p of job.files) {
      try {
        const stat = fs.statSync(p);
        if (stat.isFile()) job.fileRecords.push({ path: p, name: path.basename(p), size: stat.size });
        else missing += 1;
      } catch { missing += 1; }
    }

    const errorText = job.stderrTail.join("\n");
    const classified = job.fatal || classify(errorText);

    if (job.cancelRequested) {
      job.status = "cancelled";
      job.message = job.shutdown ? "Stopped because MediaDock was closed." : "Cancelled.";
      this.cleanupPartials(job);
    } else if (error) {
      job.status = "failed";
      job.errorCode = error.code === "ENOENT" ? "missing_ytdlp" : "spawn";
      job.error = error.code === "ENOENT"
        ? "yt-dlp was not found. Install it (winget install yt-dlp.yt-dlp) or set YTDLP_PATH, then restart MediaDock."
        : `Could not start yt-dlp: ${error.message}`;
      job.message = job.error;
    } else if (job.fatal) {
      job.status = "failed";
      job.errorCode = job.fatal.code;
      job.error = job.fatal.message;
      job.message = job.error;
      job.errorDetails = lastErrorLine(errorText);
    } else if (code === 0) {
      job.status = "completed";
      job.percent = 100;
      job.message = job.isPlaylist
        ? `Playlist finished: ${job.itemsDone} file${job.itemsDone === 1 ? "" : "s"} saved.`
        : "Download completed.";
      if (job.fileRecords.length === 0) job.warning = "yt-dlp finished, but the output file could not be identified. Check the download folder.";
    } else if (job.fileRecords.length > 0) {
      // Non-zero exit but real output exists (typical for playlists where some items failed).
      job.status = "completed";
      job.percent = 100;
      job.message = job.isPlaylist
        ? `Finished with problems: ${job.itemsDone} saved, ${job.errors.length} item${job.errors.length === 1 ? "" : "s"} failed.`
        : "Download completed with warnings.";
      job.warning = job.isPlaylist
        ? `${job.errors.length} item(s) could not be downloaded (e.g. private or removed videos).`
        : "yt-dlp reported an error after saving the file.";
      job.errorDetails = lastErrorLine(errorText);
    } else {
      job.status = "failed";
      job.errorCode = (classified && classified.code) || "failed";
      job.error = classified ? classified.message : (lastErrorLine(errorText) || `yt-dlp exited with code ${code}${signal ? ` (${signal})` : ""}.`);
      job.message = job.error;
      job.errorDetails = lastErrorLine(errorText);
    }

    if (job.status === "completed") {
      const notes = [];
      if (job.skipped > 0) notes.push(`${job.skipped} file${job.skipped === 1 ? "" : "s"} already existed and ${job.skipped === 1 ? "was" : "were"} not downloaded again`);
      if (missing > 0) notes.push(`${missing} output file${missing === 1 ? "" : "s"} could not be found afterwards`);
      if (notes.length) job.warning = [job.warning, notes.join("; ") + "."].filter(Boolean).join(" ");
    }

    this.recordHistory(job);
    this.journal();
    this.publish(job, { force: true });
    setTimeout(() => this.jobs.delete(job.id), RETAIN_FINISHED_MS).unref();
    this.pump();
  }

  /** Remove temp files left by an interrupted download. Never touches finished outputs. */
  cleanupPartials(job) {
    const attempt = () => {
      const keep = new Set(job.files.map((f) => path.resolve(f)));
      const unlink = (p) => {
        try {
          if (isInside(job.dir, p) && !keep.has(path.resolve(p))) fs.unlinkSync(p);
        } catch { /* locked or already gone */ }
      };
      for (const file of job.seenFiles) {
        const dir = path.dirname(file);
        const base = path.basename(file);
        let names = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const name of names) {
          if (name === `${base}.ytdl` || name.startsWith(`${base}.part`)) unlink(path.join(dir, name));
        }
        // Intermediate per-format stream (name.f137.mp4); the merged output has a different name.
        if (/\.f[\w-]+\.[A-Za-z0-9]+$/.test(base)) unlink(file);
      }
    };
    attempt();
    setTimeout(attempt, 1500).unref(); // Windows may still hold the file handle for a moment
  }

  recordHistory(job) {
    const entry = {
      id: job.id,
      title: job.title || job.item.title || (job.fileRecords[0] && job.fileRecords[0].name) || job.url,
      url: job.url,
      kind: job.kind,
      label: job.label,
      isPlaylist: job.isPlaylist,
      status: job.status,
      message: job.message,
      error: job.error,
      errorCode: job.errorCode,
      errorDetails: job.errorDetails,
      warning: job.warning,
      thumbnail: job.thumbnail,
      dir: job.dir,
      files: job.fileRecords.slice(0, 500).map((f) => ({ path: f.path, name: f.name, size: f.size })),
      fileCount: job.fileRecords.length,
      itemsTotal: job.item.total || null,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      request: { ...job.request, dir: undefined, requestId: undefined }
    };
    store.saveHistory([entry, ...store.getHistory()]);
    this.emit("history", { type: "added", id: job.id });
  }

  /* ---------- publishing / persistence ---------- */

  publish(job, { force = false } = {}) {
    job.seq += 1;
    const now = Date.now();
    if (force || TERMINAL.has(job.status) || now - job.lastEmit >= 300) {
      clearTimeout(job.emitTimer);
      job.emitTimer = null;
      job.lastEmit = now;
      this.emit("job", this.view(job));
    } else if (!job.emitTimer) {
      job.emitTimer = setTimeout(() => {
        job.emitTimer = null;
        if (job.finalized) return;
        job.lastEmit = Date.now();
        this.emit("job", this.view(job));
      }, 300 - (now - job.lastEmit));
    }
  }

  refreshQueuePositions() {
    for (const id of this.queue) {
      const job = this.jobs.get(id);
      if (job && job.status === "queued") this.publish(job, { force: true });
    }
  }

  /** Journal of unfinished jobs, so an unexpected crash/power loss is reported on next start. */
  journal() {
    try {
      const pending = [...this.jobs.values()].filter((j) => !TERMINAL.has(j.status)).map((j) => ({
        id: j.id, title: j.title, url: j.url, kind: j.kind, label: j.label, isPlaylist: j.isPlaylist,
        dir: j.dir, createdAt: j.createdAt, startedAt: j.startedAt
      }));
      store.writeActive(pending);
    } catch { /* journal is best-effort */ }
  }

  recoverInterrupted() {
    let leftovers = [];
    try { leftovers = store.readActive(); } catch { /* ignore */ }
    if (!Array.isArray(leftovers) || !leftovers.length) return;
    const entries = leftovers.map((j) => ({
      id: j.id, title: j.title || j.url, url: j.url, kind: j.kind, label: j.label, isPlaylist: !!j.isPlaylist,
      status: "failed", errorCode: "interrupted",
      message: "Interrupted: MediaDock stopped while this download was unfinished. Nothing was restarted automatically.",
      error: "Interrupted: MediaDock stopped while this download was unfinished. Nothing was restarted automatically.",
      errorDetails: "", warning: "", thumbnail: "", dir: j.dir, files: [], fileCount: 0, itemsTotal: null,
      createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: nowIso()
    }));
    store.saveHistory([...entries, ...store.getHistory()]);
    store.writeActive([]);
  }
}

module.exports = { JobManager, buildArgs, outputTemplate, TERMINAL };
