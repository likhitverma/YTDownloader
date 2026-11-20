"use strict";
// OS integration: open folders/files, reveal a file, native folder picker.
// Only fixed executables are launched, always with argument arrays. The only paths ever passed
// are ones the server itself resolved (configured download dir / recorded output files).
const { spawn } = require("child_process");
const path = require("path");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// Files MediaDock may open with the default application. Executables/scripts are never opened.
const OPENABLE_EXT = new Set([
  ".mp4", ".mkv", ".webm", ".mov", ".avi", ".flv", ".m4v", ".ts", ".3gp",
  ".mp3", ".m4a", ".opus", ".wav", ".ogg", ".flac", ".aac", ".weba",
  ".srt", ".vtt", ".jpg", ".jpeg", ".png", ".webp"
]);

function launch(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore", shell: false, windowsHide: false, ...options });
    } catch (error) {
      return reject(error);
    }
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(true); });
  });
}

function stripTrailingSep(p) {
  const root = path.parse(p).root;
  return p.length > root.length ? p.replace(/[\\/]+$/, "") : p;
}

async function openFolder(dir) {
  const target = stripTrailingSep(dir);
  if (IS_WIN) return launch("explorer.exe", [target]);
  if (IS_MAC) return launch("open", [target]);
  return launch("xdg-open", [target]);
}

async function revealFile(file) {
  if (IS_WIN) {
    // explorer needs `/select,"path"` as ONE verbatim argument (Node would otherwise quote it wrongly).
    return launch("explorer.exe", [`/select,"${file}"`], { windowsVerbatimArguments: true });
  }
  if (IS_MAC) return launch("open", ["-R", file]);
  return launch("xdg-open", [path.dirname(file)]);
}

async function openFile(file) {
  if (!OPENABLE_EXT.has(path.extname(file).toLowerCase())) {
    const error = new Error("This file type cannot be opened from MediaDock. Use \"Show in folder\" instead.");
    error.status = 400;
    throw error;
  }
  if (IS_WIN) return launch("explorer.exe", [file]);
  if (IS_MAC) return launch("open", [file]);
  return launch("xdg-open", [file]);
}

const PICKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose the MediaDock download folder'
$dialog.ShowNewFolderButton = $true
if ($env:MEDIADOCK_INITIAL_DIR -and (Test-Path -LiteralPath $env:MEDIADOCK_INITIAL_DIR)) { $dialog.SelectedPath = $env:MEDIADOCK_INITIAL_DIR }
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(0,0)
$owner.Show()
$owner.Activate()
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }
`;

let pickerBusy = false;

/**
 * Native Windows folder dialog via PowerShell (-EncodedCommand, so no quoting problems).
 * Resolves with the chosen path, or null if the user cancelled.
 */
function pickFolder(initialDir) {
  if (!IS_WIN) {
    const error = new Error("The native folder picker is only available on Windows. Type the folder path instead.");
    error.status = 501;
    return Promise.reject(error);
  }
  if (pickerBusy) {
    const error = new Error("A folder picker is already open.");
    error.status = 409;
    return Promise.reject(error);
  }
  pickerBusy = true;
  const encoded = Buffer.from(PICKER_SCRIPT, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      shell: false,
      windowsHide: true,
      env: { ...process.env, MEDIADOCK_INITIAL_DIR: initialDir || "" }
    });
    child.stdout.on("data", (c) => { out += c.toString("utf8"); });
    child.stderr.on("data", (c) => { err += c.toString("utf8"); });
    child.on("error", (e) => { pickerBusy = false; reject(e); });
    child.on("close", (code) => {
      pickerBusy = false;
      const chosen = out.replace(/^\uFEFF/, "").trim().split(/\r?\n/).filter(Boolean).pop();
      if (code === 0) return resolve(chosen || null);
      const error = new Error("The folder picker failed to open. Type the folder path instead.");
      error.status = 500;
      error.details = err.slice(0, 300);
      reject(error);
    });
  });
}

module.exports = { openFolder, revealFile, openFile, pickFolder, OPENABLE_EXT };
