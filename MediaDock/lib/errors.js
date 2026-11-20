"use strict";
// Turns raw yt-dlp stderr into a stable code + a message a person can act on.

const RULES = [
  {
    code: "bot", fatal: true,
    test: /Sign in to confirm you.?re not a bot/i,
    message: "YouTube is asking to confirm you're not a bot and blocked this request. MediaDock did NOT retry, to avoid wasting data and triggering more restrictions. Open Settings → Authentication, pick a browser where you are signed in to YouTube (Firefox is the most reliable on Windows) or provide a cookies.txt file, then try again."
  },
  {
    code: "ratelimit", fatal: true,
    test: /HTTP Error 429|Too Many Requests|rate.?limit/i,
    message: "The site is rate-limiting this computer (HTTP 429). MediaDock stopped instead of retrying. Wait a while before trying again."
  },
  {
    code: "cookies", fatal: true,
    test: /Could not copy .*cookie|cookie database|Failed to decrypt|could not find .* cookies|cookies?.*(locked|permission)/i,
    message: "yt-dlp could not read the browser cookies. Close that browser completely and retry, choose Firefox, or export a cookies.txt file and select it in Settings."
  },
  {
    code: "ffmpeg", fatal: true,
    test: /ffmpeg is not installed|ffprobe and ffmpeg not found|ffmpeg not found/i,
    message: "FFmpeg was not found, but this download needs it (merging or audio conversion). Install FFmpeg (winget install Gyan.FFmpeg) and restart MediaDock, or set FFMPEG_LOCATION."
  },
  {
    code: "disk", fatal: true,
    test: /No space left on device|ENOSPC|not enough space|There is not enough space on the disk/i,
    message: "The disk is full. Free some space or choose another download folder."
  },
  {
    code: "permission", fatal: true,
    test: /Permission denied|EACCES|Errno 13|Access is denied/i,
    message: "Windows denied write access to the download folder. Choose another folder in Settings."
  },
  {
    code: "unsupported", fatal: false,
    test: /Unsupported URL/i,
    message: "This URL is not supported by yt-dlp (or the page contains no downloadable media)."
  },
  {
    code: "private", fatal: false,
    test: /Private video|members-only|Join this channel|login required|only available for registered users|requires authentication/i,
    message: "This video is private or requires an account. Sign in via browser cookies in Settings (only if you have access)."
  },
  {
    code: "age", fatal: false,
    test: /confirm your age|age-restricted/i,
    message: "This video is age-restricted. Browser cookies from a signed-in account are required (Settings → Authentication)."
  },
  {
    code: "geo", fatal: false,
    test: /not available in your country|geo.?restrict|blocked it in your country/i,
    message: "This video is not available in your country."
  },
  {
    code: "unavailable", fatal: false,
    test: /Video unavailable|has been removed|no longer available|does not exist|This video is not available/i,
    message: "This video is unavailable (removed, deleted or restricted)."
  },
  {
    code: "format", fatal: false,
    test: /Requested format is not available/i,
    message: "The selected quality/format is not available for this video. Fetch the information again and pick another option."
  },
  {
    code: "network", fatal: false,
    test: /Unable to download|timed out|getaddrinfo|Name or service not known|Connection (reset|refused|aborted)|Temporary failure|SSL|IncompleteRead|Network is unreachable|No address associated/i,
    message: "Network problem while talking to the site. Check your internet connection and try again."
  }
];

function classify(text) {
  const source = String(text || "");
  for (const rule of RULES) {
    if (rule.test.test(source)) return { code: rule.code, fatal: rule.fatal, message: rule.message };
  }
  return null;
}

/** Last meaningful "ERROR:" line, trimmed for display. */
function lastErrorLine(text) {
  const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const errors = lines.filter(l => /^ERROR:/i.test(l));
  const line = (errors.length ? errors[errors.length - 1] : lines[lines.length - 1]) || "";
  return line.replace(/^ERROR:\s*/i, "").slice(0, 400);
}

module.exports = { classify, lastErrorLine };
