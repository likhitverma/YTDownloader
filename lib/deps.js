"use strict";
// Locating and probing yt-dlp / FFmpeg.
const path = require("path");
const fs = require("fs");
const { runCapture, IS_WIN } = require("./proc");

function ytdlpCommand() {
  return process.env.YTDLP_PATH || (IS_WIN ? "yt-dlp.exe" : "yt-dlp");
}

/** Directory (or file) given in FFMPEG_LOCATION, or "" when FFmpeg should come from PATH. */
function ffmpegLocation() {
  return process.env.FFMPEG_LOCATION || "";
}

function ffmpegExecutable() {
  const loc = ffmpegLocation();
  const exe = IS_WIN ? "ffmpeg.exe" : "ffmpeg";
  if (!loc) return exe;
  try {
    if (fs.statSync(loc).isDirectory()) return path.join(loc, exe);
  } catch { /* fall through */ }
  return loc;
}

let cache = null;
let cacheTime = 0;

async function probe(command, args) {
  const r = await runCapture(command, args, { timeoutMs: 15000 });
  if (r.error || r.code !== 0) return { ok: false, version: "" };
  return { ok: true, version: r.stdout.split(/\r?\n/)[0].trim().slice(0, 120) };
}

async function checkDeps(force = false) {
  if (!force && cache && Date.now() - cacheTime < 60_000) return cache;
  const [ytdlp, ffmpeg] = await Promise.all([
    probe(ytdlpCommand(), ["--version"]),
    probe(ffmpegExecutable(), ["-version"])
  ]);
  cache = { ytdlp, ffmpeg };
  cacheTime = Date.now();
  return cache;
}

module.exports = { ytdlpCommand, ffmpegLocation, ffmpegExecutable, checkDeps };
