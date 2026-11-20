"use strict";
// Input validation. Everything that reaches yt-dlp passes through here.
const fs = require("fs");
const path = require("path");

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || "bad_request";
  }
}

function validateUrl(value) {
  const text = String(value || "").trim();
  if (!text) throw new HttpError(400, "Paste a video or playlist URL first.");
  if (text.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(text)) {
    throw new HttpError(400, "That does not look like a valid URL.");
  }
  let url;
  try { url = new URL(text); } catch { throw new HttpError(400, "Enter a valid http:// or https:// URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "Only http:// and https:// URLs are supported.");
  }
  if (!url.hostname) throw new HttpError(400, "Enter a valid http:// or https:// URL.");
  return url.toString();
}

const KINDS = ["av", "video", "audio"];
const MERGE = ["mp4", "webm", "mkv"];
const AUDIO_FORMATS = ["original", "mp3", "m4a", "opus", "wav"];
// yt-dlp format selector syntax only; no spaces, quotes, backslashes or '%'.
const SELECTOR_RE = /^[A-Za-z0-9_\-+/[\]<>=!*.,()^$~:&|?@]{1,300}$/;
const SORT_RE = /^[A-Za-z0-9_:,+\-~*<>=.]{1,80}$/;

function cleanText(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function httpsUrlOrEmpty(value) {
  try {
    const u = new URL(String(value || ""));
    return u.protocol === "https:" && String(value).length <= 600 ? u.toString() : "";
  } catch { return ""; }
}

function intInRange(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** Validates the POST /api/download body and returns a clean request object. */
function normalizeDownloadRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Malformed request.");
  const url = validateUrl(body.url);
  const kind = KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) throw new HttpError(400, "Unknown download type.");

  const selector = String(body.selector || "");
  if (!SELECTOR_RE.test(selector)) throw new HttpError(400, "Invalid format selection.");

  const merge = body.merge === undefined || body.merge === "" ? "mp4" : String(body.merge);
  if (!MERGE.includes(merge)) throw new HttpError(400, "Invalid merge container.");

  let sort = "";
  if (body.sort) {
    sort = String(body.sort);
    if (!SORT_RE.test(sort)) throw new HttpError(400, "Invalid sort option.");
  }

  const audioFormat = body.audioFormat === undefined ? "mp3" : String(body.audioFormat);
  if (!AUDIO_FORMATS.includes(audioFormat)) throw new HttpError(400, "Invalid audio output format.");

  const requestId = body.requestId === undefined ? "" : String(body.requestId);
  if (requestId && !/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new HttpError(400, "Invalid request id.");

  return {
    requestId,
    url,
    kind,
    selector,
    merge,
    sort,
    audioFormat,
    playlist: body.playlist === true,
    subtitles: body.subtitles === true && kind !== "audio",
    label: cleanText(body.label, 120) || "Best Available",
    title: cleanText(body.title, 200),
    thumbnail: httpsUrlOrEmpty(body.thumbnail),
    playlistCount: intInRange(body.playlistCount, 1, 100000, null),
    streams: intInRange(body.streams, 1, 2, kind === "av" ? 2 : 1)
  };
}

const COOKIE_BROWSERS = ["", "firefox", "chrome", "edge", "brave", "opera", "vivaldi", "chromium"];

/** Validates a settings patch. Returns only the keys that are valid & present. */
function normalizeSettingsPatch(body, { maxConcurrentLimit }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Malformed request.");
  const patch = {};
  if ("theme" in body) {
    if (body.theme !== "dark" && body.theme !== "light") throw new HttpError(400, "Theme must be dark or light.");
    patch.theme = body.theme;
  }
  if ("maxConcurrent" in body) {
    const n = Number.parseInt(body.maxConcurrent, 10);
    if (!Number.isFinite(n) || n < 1 || n > maxConcurrentLimit) {
      throw new HttpError(400, `Simultaneous downloads must be between 1 and ${maxConcurrentLimit}.`);
    }
    patch.maxConcurrent = n;
  }
  if ("cookiesBrowser" in body) {
    if (!COOKIE_BROWSERS.includes(String(body.cookiesBrowser))) throw new HttpError(400, "Unknown browser.");
    patch.cookiesBrowser = String(body.cookiesBrowser);
  }
  if ("cookiesFile" in body) {
    const file = String(body.cookiesFile || "").trim();
    if (file) {
      if (file.length > 1000 || /[\u0000-\u001f]/.test(file) || !path.isAbsolute(file)) {
        throw new HttpError(400, "Cookies file must be a full path, e.g. C:\\Users\\you\\cookies.txt");
      }
      let stat;
      try { stat = fs.statSync(file); } catch { throw new HttpError(400, "Cookies file was not found."); }
      if (!stat.isFile()) throw new HttpError(400, "Cookies path is not a file.");
    }
    patch.cookiesFile = file;
  }
  if ("downloadDir" in body) patch.downloadDir = String(body.downloadDir || "").trim();
  return patch;
}

/** Validates (and creates, if needed) a download directory. Returns the normalised path. */
function prepareDownloadDir(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new HttpError(400, "Enter a folder path.");
  if (raw.length > 1000 || /[\u0000-\u001f<>"|?*]/.test(raw)) throw new HttpError(400, "That folder path contains invalid characters.");
  if (!path.isAbsolute(raw)) throw new HttpError(400, "Use a full folder path, e.g. D:\\Videos\\MediaDock");
  const dir = path.resolve(raw);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new HttpError(400, `Cannot use that folder: ${friendlyFsError(error)}`);
  }
  // Prove we can actually write there.
  const probe = path.join(dir, `.mediadock-write-test-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
  } catch (error) {
    throw new HttpError(400, `That folder is not writable: ${friendlyFsError(error)}`);
  }
  return dir;
}

function friendlyFsError(error) {
  const code = error && error.code;
  if (code === "EACCES" || code === "EPERM") return "permission denied.";
  if (code === "ENOENT") return "a parent drive or folder does not exist.";
  if (code === "ENOTDIR") return "part of the path is a file, not a folder.";
  if (code === "ENOSPC") return "the disk is full.";
  return String((error && error.message) || error).slice(0, 160);
}

/** True when `target` is inside `root` (or equal). Resolves `..`; case-insensitive on Windows. */
function isInside(root, target) {
  const norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const r = norm(root);
  const t = norm(target);
  const rel = path.relative(r, t);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

module.exports = {
  HttpError, validateUrl, normalizeDownloadRequest, normalizeSettingsPatch,
  prepareDownloadDir, isInside, friendlyFsError, AUDIO_FORMATS, COOKIE_BROWSERS
};
