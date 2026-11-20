"use strict";
// Child-process helpers: capture output, and terminate a whole process tree.
const { spawn, spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";

/** Spawn options that make the child killable as a tree on every platform. */
function spawnOptions(extra = {}) {
  return { windowsHide: true, shell: false, detached: !IS_WIN, ...extra };
}

/**
 * Kill a child and everything it spawned (yt-dlp -> ffmpeg).
 * Windows: taskkill /T /F.  POSIX: signal the process group.
 */
function killTree(child) {
  if (!child || !child.pid) return;
  if (IS_WIN) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
    killer.on("error", () => { try { child.kill(); } catch { /* ignore */ } });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* ignore */ } }
    setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, 3000).unref();
  }
}

/** Synchronous variant for use inside process 'exit' handlers. */
function killTreeSync(child) {
  if (!child || !child.pid) return;
  if (IS_WIN) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  }
}

/** Run a command to completion and capture output (used for metadata + probes). */
function runCapture(command, args, { timeoutMs = 60000, maxBytes = 30_000_000, env, onChild } = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let tooBig = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut, tooBig, child });
    };

    try {
      child = spawn(command, args, spawnOptions({ env: env || process.env, stdio: ["ignore", "pipe", "pipe"] }));
    } catch (error) {
      return finish({ code: null, error });
    }

    if (onChild) onChild(child);
    timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > maxBytes) { tooBig = true; killTree(child); }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on("error", (error) => finish({ code: null, error }));
    child.on("close", (code) => finish({ code }));
  });
}

module.exports = { IS_WIN, spawnOptions, killTree, killTreeSync, runCapture };
