"use strict";
// Tiny JSON persistence layer (settings, history, interrupted-job journal).
const fs = require("fs");
const path = require("path");
const config = require("./config");

fs.mkdirSync(config.DATA_DIR, { recursive: true });

const SETTINGS_FILE = path.join(config.DATA_DIR, "settings.json");
const HISTORY_FILE = path.join(config.DATA_DIR, "history.json");
const ACTIVE_FILE = path.join(config.DATA_DIR, "active.json");

function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Keep a copy of a corrupt file instead of silently discarding the user's data.
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  const text = JSON.stringify(value, null, 2);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch {
    // Some Windows setups (antivirus/indexers) refuse the rename; fall back to a direct write.
    fs.writeFileSync(file, text);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

const DEFAULT_SETTINGS = {
  theme: "dark",
  downloadDir: config.DEFAULT_DOWNLOAD_DIR,
  maxConcurrent: config.DEFAULT_CONCURRENT,
  cookiesBrowser: "",
  cookiesFile: "",
  knownDirs: []
};

let settings = { ...DEFAULT_SETTINGS, ...(readJson(SETTINGS_FILE, {}) || {}) };
if (!Array.isArray(settings.knownDirs)) settings.knownDirs = [];
if (!settings.knownDirs.includes(settings.downloadDir)) settings.knownDirs.push(settings.downloadDir);

let history = readJson(HISTORY_FILE, []);
if (!Array.isArray(history)) history = [];

module.exports = {
  getSettings: () => settings,
  saveSettings(next) {
    settings = next;
    writeJson(SETTINGS_FILE, settings);
    return settings;
  },
  getHistory: () => history,
  saveHistory(next) {
    history = next.slice(0, config.MAX_HISTORY);
    writeJson(HISTORY_FILE, history);
    return history;
  },
  readActive: () => readJson(ACTIVE_FILE, []),
  writeActive: (list) => writeJson(ACTIVE_FILE, list)
};
