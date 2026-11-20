/* MediaDock frontend. Vanilla JS. All server text is inserted with textContent (never innerHTML). */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SVG_NS = "http://www.w3.org/2000/svg";
  const TERMINAL = new Set(["completed", "failed", "cancelled"]);
  const KIND_NAMES = { av: "Video + Audio", video: "Video only", audio: "Audio only" };
  const KIND_ICONS = { av: "sound", video: "mute", audio: "music" };
  const DEFAULT_OPTIONS = {
    av: [{ id: "best", label: "Best Available (Recommended)", detail: "Highest quality video and audio, merged with FFmpeg into MP4.", selector: "bv*+ba/b", merge: "mp4", sort: "", streams: 2 }],
    video: [{ id: "best", label: "Best Video Only (Recommended)", detail: "Highest resolution video stream, without any audio track.", selector: "bv", merge: "mp4", sort: "", streams: 1 }],
    audio: [{ id: "best", label: "Best Available Audio (Recommended)", detail: "Highest quality audio stream the site provides.", selector: "ba/b", merge: "mp4", sort: "", streams: 1 }]
  };
  const DEFAULT_AUDIO_OUTPUTS = [
    { value: "mp3", label: "MP3" }, { value: "m4a", label: "M4A (AAC)" }, { value: "opus", label: "Opus" },
    { value: "wav", label: "WAV (lossless container, large)" }, { value: "original", label: "Original (no conversion)" }
  ];

  const state = {
    settings: null,
    health: null,
    info: null,          // last fetched metadata
    infoUrl: "",
    fetching: false,
    submitting: false,
    cards: new Map(),    // job id -> { root, refs, seq, view, timer }
    history: [],
    historyShown: 20,
    events: null,
    autoPlaylist: false  // playlist switch was turned on by a fetch, not by the user
  };

  /* ---------------------------------------------------------------- helpers */

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "i");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function button(label, iconName, onClick, cls = "btn btn-secondary btn-sm", title) {
    return el("button", { type: "button", class: cls, title, onclick: onClick }, iconName ? icon(iconName) : null, el("span", { text: label }));
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n === null) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : 1)} ${units[i]}`;
  }
  function fmtSpeed(bps) { return Number.isFinite(bps) && bps !== null ? `${fmtBytes(bps)}/s` : ""; }
  function fmtDuration(sec) {
    if (!Number.isFinite(sec) || sec === null) return "";
    const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
  }
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
  function fmtViews(n) {
    if (!Number.isFinite(n) || n === null) return "";
    return `${new Intl.NumberFormat(undefined, { notation: "compact" }).format(n)} views`;
  }

  async function api(method, url, body) {
    let response;
    try {
      response = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error("Cannot reach MediaDock. Is it still running?");
    }
    let data = null;
    try { data = await response.json(); } catch { /* empty */ }
    if (!response.ok) {
      const error = new Error((data && data.error) || `Request failed (${response.status})`);
      error.status = response.status;
      error.code = data && data.code;
      throw error;
    }
    return data;
  }

  function toast(text, type = "") {
    const node = el("div", { class: `toast ${type}`, text });
    $("toasts").append(node);
    setTimeout(() => node.remove(), type === "error" ? 7000 : 4000);
  }

  function setMessage(id, text, type = "") {
    const node = $(id);
    node.textContent = text || "";
    node.className = `message ${type}`;
  }

  /* ------------------------------------------------------------------ theme */

  function applyTheme(theme) {
    const t = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("mediadock-theme", t); } catch { /* ignore */ }
    $("theme-icon").firstElementChild.setAttribute("href", t === "dark" ? "#i-moon" : "#i-sun");
    $("btn-theme").title = t === "dark" ? "Dark theme (click for light)" : "Light theme (click for dark)";
  }

  async function toggleTheme() {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
    try { await api("POST", "/api/settings", { theme: next }); } catch { /* local choice still applies */ }
  }

  /* --------------------------------------------------------- format selection */

  const currentKind = () => document.querySelector('input[name="kind"]:checked').value;

  function optionsForKind(kind) {
    const fromInfo = state.info && state.info.options && state.info.options[kind];
    return fromInfo || (state.info ? [] : DEFAULT_OPTIONS[kind]);
  }

  function renderFormats() {
    const kind = currentKind();
    const select = $("format-select");
    const options = optionsForKind(kind);
    select.textContent = "";
    $("format-label").textContent = kind === "audio" ? "Audio quality / source stream" : kind === "video" ? "Video resolution (no audio)" : "Quality / format";

    if (!options.length) {
      select.append(el("option", { text: "Not available for this source" }));
      select.disabled = true;
      $("format-detail").textContent = kind === "video"
        ? "This source has no separate video-only streams, so a silent download is not possible."
        : "No matching formats were reported for this source.";
    } else {
      select.disabled = false;
      options.forEach((o, index) => select.append(el("option", { value: String(index), text: o.label })));
      select.selectedIndex = 0; // Best Available is always first and the default
      updateFormatDetail();
    }

    const audioField = $("audio-output-field");
    audioField.classList.toggle("hidden", kind !== "audio");
    $("subtitles-switch").classList.toggle("hidden", kind === "audio");
    if (kind === "audio" && !$("audio-output").options.length) {
      const outputs = (state.info && state.info.audioOutputs) || DEFAULT_AUDIO_OUTPUTS;
      outputs.forEach((o) => $("audio-output").append(el("option", { value: o.value, text: o.label })));
      $("audio-output").value = "mp3";
    }
    updateDownloadEnabled();
  }

  function selectedOption() {
    const options = optionsForKind(currentKind());
    const select = $("format-select");
    return select.disabled ? null : options[Number(select.value)] || null;
  }

  function updateFormatDetail() {
    const option = selectedOption();
    $("format-detail").textContent = option ? option.detail || "" : "";
  }

  function updateDownloadEnabled() {
    $("btn-download").disabled = state.submitting || !$("url-input").value.trim() || !selectedOption();
  }

  function clearInfo() {
    if (state.autoPlaylist) { $("playlist-toggle").checked = false; state.autoPlaylist = false; }
    if (!state.info) return;
    state.info = null;
    state.infoUrl = "";
    $("preview").classList.add("hidden");
    $("preview").textContent = "";
    $("audio-output").textContent = "";
    setMessage("fetch-message", "");
    renderFormats();
  }

  /* ---------------------------------------------------------------- preview */

  function renderPreview(info) {
    const box = $("preview");
    box.textContent = "";
    const thumb = info.thumbnail
      ? el("img", { class: "thumb", src: info.thumbnail, alt: "", referrerpolicy: "no-referrer", loading: "lazy" })
      : el("div", { class: "thumb thumb-ph" }, icon("video"));
    const meta = el("div", { class: "meta" });
    if (info.uploader) meta.append(el("span", { text: info.uploader }));
    if (info.type === "video") {
      if (info.duration) meta.append(el("span", { text: fmtDuration(info.duration) }));
      const views = fmtViews(info.viewCount);
      if (views) meta.append(el("span", { text: views }));
    }
    const chips = el("div", { class: "chips" });
    if (info.type === "playlist") chips.append(el("span", { class: "chip", text: `Playlist · ${info.playlist.count} video${info.playlist.count === 1 ? "" : "s"}` }));
    if (info.type === "video" && info.counts) {
      chips.append(el("span", { class: "chip", text: `${info.counts.videoOnly} video-only · ${info.counts.audioOnly} audio-only · ${info.counts.combined} combined` }));
    }
    if (info.isLive) chips.append(el("span", { class: "chip warn", text: "Live stream" }));
    (info.notes || []).forEach((n) => chips.append(el("span", { class: "chip warn", text: n })));

    const body = el("div", {}, el("h3", { text: info.title }), meta, chips);
    if (info.type === "playlist" && info.playlist.entries.length) {
      const list = el("ol");
      info.playlist.entries.slice(0, 50).forEach((e) => list.append(el("li", { text: e.title })));
      body.append(el("details", {}, el("summary", { text: `Show videos (${Math.min(50, info.playlist.entries.length)} of ${info.playlist.count})` }), list));
    }
    box.append(thumb, body);
    box.classList.remove("hidden");
  }

  async function fetchInfo() {
    if (state.fetching) return;
    const url = $("url-input").value.trim();
    if (!url) { setMessage("fetch-message", "Paste a URL first.", "error"); return; }
    state.fetching = true;
    $("btn-fetch").disabled = true;
    $("btn-fetch").lastElementChild.textContent = "Fetching…";
    setMessage("fetch-message", "Reading video information from yt-dlp… this can take a few seconds.");
    try {
      const info = await api("GET", `/api/info?url=${encodeURIComponent(url)}&playlist=${$("playlist-toggle").checked ? 1 : 0}`);
      state.info = info;
      state.infoUrl = url;
      if (info.type === "playlist" && !$("playlist-toggle").checked) {
        $("playlist-toggle").checked = true;
        state.autoPlaylist = true;
        setMessage("fetch-message", "This URL is a playlist, so playlist mode was switched on.", "ok");
      } else {
        setMessage("fetch-message", "Information loaded. Pick a type and quality below.", "ok");
      }
      renderPreview(info);
      $("audio-output").textContent = "";
      renderFormats();
    } catch (error) {
      state.info = null;
      $("preview").classList.add("hidden");
      renderFormats();
      setMessage("fetch-message", error.message, "error");
    } finally {
      state.fetching = false;
      $("btn-fetch").disabled = false;
      $("btn-fetch").lastElementChild.textContent = "Fetch Info";
    }
  }

  /* --------------------------------------------------------------- download */

  async function startDownload() {
    if (state.submitting) return;
    const url = $("url-input").value.trim();
    const option = selectedOption();
    if (!url || !option) return;
    const kind = currentKind();
    const audioFormat = $("audio-output").value || "mp3";
    const info = state.info && state.infoUrl === url ? state.info : null;
    const playlist = $("playlist-toggle").checked && !(info && info.type === "video");

    let label = `${KIND_NAMES[kind]} · ${option.label.replace(" (Recommended)", "")}`;
    if (kind === "audio") label += ` → ${audioFormat === "original" ? "original format" : audioFormat.toUpperCase()}`;

    state.submitting = true;
    updateDownloadEnabled();
    setMessage("form-message", "Adding to queue…");
    try {
      const job = await api("POST", "/api/download", {
        requestId: crypto.randomUUID(),
        url, playlist, kind,
        selector: option.selector, merge: option.merge, sort: option.sort, streams: option.streams,
        audioFormat,
        subtitles: kind !== "audio" && $("subtitles-toggle").checked,
        label,
        title: info ? info.title : "",
        thumbnail: info ? info.thumbnail : "",
        playlistCount: info && info.type === "playlist" ? info.playlist.count : undefined
      });
      upsertJob(job);
      setMessage("form-message", job.duplicate ? "That download was already added." : "Added to the download queue.", "ok");
      toast(job.duplicate ? "Already in the queue." : "Download added to the queue.", "success");
    } catch (error) {
      setMessage("form-message", error.message, "error");
      toast(error.message, "error");
    } finally {
      state.submitting = false;
      updateDownloadEnabled();
    }
  }

  /* ------------------------------------------------------------------ queue */

  const STATUS_TEXT = { queued: "Queued", preparing: "Preparing", downloading: "Downloading", processing: "Processing", completed: "Completed", failed: "Failed", cancelled: "Cancelled" };

  function thumbNode(url) {
    return url
      ? el("img", { class: "thumb", src: url, alt: "", referrerpolicy: "no-referrer", loading: "lazy" })
      : el("div", { class: "thumb thumb-ph" }, icon("video"));
  }

  function createCard(view) {
    const refs = {
      title: el("p", { class: "job-title" }),
      url: el("div", { class: "job-url" }),
      status: el("span", { class: "status" }),
      kind: el("span", { class: "tag" }),
      bar: el("span"),
      track: el("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" }),
      stats: el("div", { class: "stats" }),
      note: el("p", { class: "job-note" }),
      details: el("details", { class: "hidden" }),
      cancel: button("Cancel", "x", () => cancelJob(view.id), "btn btn-danger btn-sm", "Cancel this download")
    };
    refs.track.append(refs.bar);
    const root = el("article", { class: "job", "data-id": view.id },
      thumbNode(view.thumbnail),
      el("div", {}, refs.title, refs.url, el("div", { class: "job-tags" }, refs.status, refs.kind), refs.track, refs.stats, refs.note, refs.details),
      el("div", { class: "job-actions" }, refs.cancel));
    return { root, refs, seq: -1, view, timer: null };
  }

  function updateCard(card, v) {
    const r = card.refs;
    r.title.textContent = v.title || (v.isPlaylist ? "Playlist" : "Fetching title…");
    r.url.textContent = v.url;
    r.url.title = v.url;
    const statusText = v.cancelling ? "Cancelling…" : v.status === "queued" && v.queuePosition ? `Queued #${v.queuePosition}` : STATUS_TEXT[v.status] || v.status;
    r.status.textContent = statusText;
    r.status.className = `status ${v.status}`;
    r.kind.textContent = "";
    r.kind.append(icon(KIND_ICONS[v.kind] || "video"), document.createTextNode(` ${v.label}`));
    if (v.isPlaylist) r.kind.append(el("span", { class: "chip", text: "Playlist" }));

    r.track.className = `progress ${v.status}`;
    r.bar.style.width = `${Math.max(0, Math.min(100, v.percent))}%`;
    r.track.setAttribute("aria-valuenow", String(Math.round(v.percent)));

    r.stats.textContent = "";
    const stat = (label, value) => r.stats.append(el("span", {}, label ? `${label} ` : "", el("strong", { text: value })));
    if (v.status === "queued") {
      stat("", "Waiting for a free slot");
    } else {
      stat(v.isPlaylist && v.percentScope === "overall" ? "Overall" : v.percentScope === "item" ? "Current item" : "", `${Math.round(v.percent)}%`);
      if (v.isPlaylist && v.currentItem && v.currentItem.index) stat("Item", `${v.currentItem.index}${v.currentItem.total ? ` of ${v.currentItem.total}` : ""}`);
      if (v.isPlaylist) stat("Saved", String(v.itemsDone));
      if (v.speedBps) stat("Speed", fmtSpeed(v.speedBps));
      if (v.etaSec !== null && v.etaSec !== undefined && !v.isPlaylist && v.status === "downloading") stat("ETA", fmtDuration(v.etaSec));
    }

    let note = v.message || "";
    if (v.isPlaylist && v.currentItem && v.currentItem.title && !TERMINAL.has(v.status)) note = `${v.message} — ${v.currentItem.title}`;
    r.note.textContent = note;
    r.note.className = `job-note ${v.status === "failed" ? "error" : v.warning ? "warn" : ""}`;
    if (v.warning) r.note.textContent = `${note} ${v.warning}`;

    if (v.errorDetails && v.status === "failed") {
      r.details.classList.remove("hidden");
      r.details.textContent = "";
      r.details.append(el("summary", { text: "Technical details" }), el("div", { text: v.errorDetails }));
    } else r.details.classList.add("hidden");

    const active = !TERMINAL.has(v.status);
    r.cancel.classList.toggle("hidden", !active);
    r.cancel.disabled = v.cancelling;
  }

  function upsertJob(view) {
    let card = state.cards.get(view.id);
    if (card && view.seq < card.seq) return; // stale event: ignore
    if (card && TERMINAL.has(card.view.status)) return; // terminal state is final
    if (!card) {
      card = createCard(view);
      state.cards.set(view.id, card);
      $("queue").prepend(card.root);
    }
    card.seq = view.seq;
    card.view = view;
    updateCard(card, view);
    if (TERMINAL.has(view.status)) {
      // Show the final state briefly, then the entry lives on in History.
      card.timer = setTimeout(() => removeCard(view.id), view.status === "completed" ? 5000 : 9000);
      if (view.status === "completed") toast(`Finished: ${view.title || view.url}`, "success");
      else if (view.status === "failed") toast(`Failed: ${view.title || view.url}`, "error");
      loadHistory();
    }
    refreshQueueCount();
  }

  function removeCard(id) {
    const card = state.cards.get(id);
    if (!card) return;
    clearTimeout(card.timer);
    card.root.remove();
    state.cards.delete(id);
    refreshQueueCount();
  }

  function refreshQueueCount() {
    const active = [...state.cards.values()].filter((c) => !TERMINAL.has(c.view.status)).length;
    $("queue-count").textContent = String(active);
    const queue = $("queue");
    let empty = queue.querySelector(".empty");
    if (!state.cards.size) {
      if (!empty) queue.append(el("div", { class: "empty", text: "No active downloads. Paste a URL above to start." }));
    } else if (empty) empty.remove();
  }

  async function cancelJob(id) {
    const card = state.cards.get(id);
    if (card) card.refs.cancel.disabled = true;
    try {
      const view = await api("POST", `/api/download/${encodeURIComponent(id)}/cancel`);
      upsertJob({ ...view, seq: Math.max(view.seq, card ? card.seq : 0) });
    } catch (error) {
      toast(error.message, "error");
      if (card) card.refs.cancel.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- history */

  async function loadHistory() {
    try {
      const data = await api("GET", "/api/history");
      state.history = data.items;
      renderHistory();
    } catch { /* keep the old list */ }
  }

  function renderHistory() {
    const box = $("history");
    box.textContent = "";
    $("history-count").textContent = String(state.history.length);
    $("btn-clear-history").disabled = !state.history.length;
    const shown = state.history.slice(0, state.historyShown);
    if (!shown.length) box.append(el("div", { class: "empty", text: "Nothing here yet. Finished, failed and cancelled downloads appear here." }));
    shown.forEach((entry) => box.append(historyRow(entry)));
    $("btn-more-history").classList.toggle("hidden", state.history.length <= state.historyShown);
  }

  function historyRow(entry) {
    const files = entry.files || [];
    const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
    const firstExisting = files.find((f) => !f.missing);
    const tags = el("div", { class: "job-tags" },
      el("span", { class: `status ${entry.status}`, text: STATUS_TEXT[entry.status] || entry.status }),
      el("span", { class: "tag" }, icon(KIND_ICONS[entry.kind] || "video"), ` ${entry.label}`));
    if (entry.isPlaylist) tags.append(el("span", { class: "chip", text: "Playlist" }));

    const stats = el("div", { class: "stats" });
    if (entry.finishedAt) stats.append(el("span", { text: fmtDate(entry.finishedAt) }));
    if (entry.fileCount) stats.append(el("span", { text: `${entry.fileCount} file${entry.fileCount === 1 ? "" : "s"}${totalSize ? ` · ${fmtBytes(totalSize)}` : ""}` }));

    const main = el("div", {}, el("p", { class: "job-title", text: entry.title }), el("div", { class: "job-url", title: entry.url, text: entry.url }), tags, stats);
    if (files.length === 1) main.append(el("p", { class: "job-note", text: files[0].missing ? `${files[0].name} (file was moved or deleted)` : files[0].name }));
    else if (files.length > 1) {
      const list = el("ul", { class: "file-list" });
      files.forEach((f) => list.append(el("li", { text: `${f.name}${f.size ? ` (${fmtBytes(f.size)})` : ""}${f.missing ? " — missing" : ""}` })));
      main.append(el("details", {}, el("summary", { text: `Show files${entry.fileCount > files.length ? ` (first ${files.length} of ${entry.fileCount})` : ""}` }), list));
    }
    if (entry.status === "failed" && entry.error) main.append(el("p", { class: "job-note error", text: entry.error }));
    else if (entry.status === "cancelled") main.append(el("p", { class: "job-note", text: entry.message }));
    if (entry.warning) main.append(el("p", { class: "job-note warn", text: entry.warning }));
    if (entry.errorDetails && entry.status !== "cancelled") main.append(el("details", {}, el("summary", { text: "Technical details" }), el("div", { text: entry.errorDetails })));

    const actions = el("div", { class: "job-actions" });
    if (firstExisting) {
      if (files.length === 1) actions.append(button("Open file", "play", () => historyAction(entry.id, "open-file", firstExisting.index)));
      actions.append(button("Show in folder", "folder", () => historyAction(entry.id, "reveal", firstExisting.index)));
      if (files.length === 1) {
        actions.append(el("a", { class: "btn btn-secondary btn-sm", href: `/api/files/${encodeURIComponent(entry.id)}/${firstExisting.index}`, download: firstExisting.name, title: "Save a copy through the browser" }, icon("download"), el("span", { text: "Save copy" })));
      }
    } else if (entry.dir && files.length) {
      actions.append(button("Show in folder", "folder", () => historyAction(entry.id, "reveal", 0)));
    }
    if (entry.request && entry.status !== "completed") actions.append(button("Try again", "refresh", () => retry(entry)));
    actions.append(button("Remove", "x", () => removeHistory(entry.id), "btn btn-secondary btn-sm", "Remove from the list. Downloaded files are kept."));
    if (files.length === 1 && firstExisting) {
      actions.append(button("Delete file", "trash", () => deleteFile(entry, firstExisting), "btn btn-danger btn-sm", "Permanently delete the downloaded file"));
    }
    return el("article", { class: "job", "data-id": entry.id }, thumbNode(entry.thumbnail), main, actions);
  }

  async function historyAction(id, action, index) {
    try { await api("POST", `/api/history/${encodeURIComponent(id)}/${action}`, { index }); }
    catch (error) { toast(error.message, "error"); loadHistory(); }
  }

  async function removeHistory(id) {
    try { await api("DELETE", `/api/history/${encodeURIComponent(id)}`); await loadHistory(); toast("Removed from history. The file was not deleted.", "success"); }
    catch (error) { toast(error.message, "error"); }
  }

  async function deleteFile(entry, file) {
    if (!window.confirm(`Permanently delete this file from disk?\n\n${file.name}\n\nThis cannot be undone.`)) return;
    try {
      await api("POST", `/api/history/${encodeURIComponent(entry.id)}/delete-file`, { index: file.index, confirm: true });
      toast("File deleted.", "success");
      loadHistory();
    } catch (error) { toast(error.message, "error"); }
  }

  async function retry(entry) {
    try {
      const job = await api("POST", "/api/download", { ...entry.request, requestId: crypto.randomUUID() });
      upsertJob(job);
      toast("Download added to the queue again.", "success");
    } catch (error) { toast(error.message, "error"); }
  }

  /* --------------------------------------------------------------- settings */

  async function loadSettings() {
    state.settings = await api("GET", "/api/settings");
    applyTheme(state.settings.theme);
    $("set-concurrent").max = String(state.settings.maxConcurrentLimit);
  }

  function renderBanners() {
    const box = $("banners");
    box.textContent = "";
    const h = state.health;
    if (!h) return;
    const add = (cls, ...text) => box.append(el("div", { class: `banner ${cls}` }, icon("alert"), el("p", {}, ...text)));
    if (!h.ytdlp.ok) add("error", el("strong", { text: "yt-dlp was not found. " }), "Install it with ", el("code", { text: "winget install yt-dlp.yt-dlp" }), ", then restart MediaDock. Downloads cannot start until then.");
    if (!h.ffmpeg.ok) add("", el("strong", { text: "FFmpeg was not found. " }), "Video + Audio merging and audio conversion need it. Install with ", el("code", { text: "winget install Gyan.FFmpeg" }), " and restart MediaDock. \"Video only\" and \"Audio only → Original\" still work.");
    if (!h.downloadDir.ok) add("error", el("strong", { text: "The download folder is not available: " }), h.downloadDir.path, ". Use Change Location to pick another one.");
  }

  async function loadHealth(refresh = false) {
    try { state.health = await api("GET", `/api/health${refresh ? "?refresh=1" : ""}`); renderBanners(); } catch { /* offline banner handled by SSE */ }
  }

  function openSettings() {
    const s = state.settings;
    $("set-dir").value = s.downloadDir;
    $("set-concurrent").value = String(s.maxConcurrent);
    $("set-concurrent-value").textContent = String(s.maxConcurrent);
    $("set-cookie-browser").value = s.cookiesBrowser || "";
    $("set-cookie-file").value = s.cookiesFile || "";
    $("set-browse").classList.toggle("hidden", !s.canPickFolder);
    setMessage("settings-message", "");
    renderDeps();
    $("settings-dialog").showModal();
    loadHealth(true).then(renderDeps);
  }

  function renderDeps() {
    const box = $("deps-status");
    box.textContent = "";
    const h = state.health;
    if (!h) return;
    const row = (name, dep) => el("div", { class: `dep ${dep.ok ? "ok" : "bad"}` }, icon(dep.ok ? "check" : "alert"), el("span", { text: dep.ok ? `${name}: ${dep.version}` : `${name}: not found` }));
    box.append(el("label", { text: "Installed tools" }), row("yt-dlp", h.ytdlp), row("FFmpeg", h.ffmpeg));
  }

  async function saveSettings(event) {
    event.preventDefault();
    const patch = {
      downloadDir: $("set-dir").value.trim(),
      maxConcurrent: Number($("set-concurrent").value),
      cookiesBrowser: $("set-cookie-browser").value,
      cookiesFile: $("set-cookie-file").value.trim()
    };
    $("settings-save").disabled = true;
    try {
      state.settings = await api("POST", "/api/settings", patch);
      toast("Settings saved.", "success");
      $("settings-dialog").close();
      loadHealth();
    } catch (error) {
      setMessage("settings-message", error.message, "error");
    } finally {
      $("settings-save").disabled = false;
    }
  }

  async function browseFolder(forSettings) {
    try {
      const result = await api("POST", "/api/select-folder");
      if (!result.path) return; // user cancelled the dialog
      if (forSettings) { $("set-dir").value = result.path; return; }
      state.settings = await api("POST", "/api/settings", { downloadDir: result.path });
      toast(`Download folder: ${state.settings.downloadDir}`, "success");
      loadHealth();
    } catch (error) {
      toast(error.message, "error");
      if (!forSettings) openSettings();
    }
  }

  async function openDownloads() {
    try { await api("POST", "/api/open-folder"); }
    catch (error) { toast(error.message, "error"); }
  }

  /* -------------------------------------------------------------- live feed */

  function connectEvents() {
    const source = new EventSource("/api/events");
    state.events = source;
    source.addEventListener("open", () => {
      const lost = document.getElementById("conn-banner");
      if (lost) lost.remove();
    });
    source.addEventListener("snapshot", (e) => {
      const { jobs } = JSON.parse(e.data);
      const live = new Set(jobs.map((j) => j.id));
      // Cards that vanished while we were disconnected finished in the meantime.
      for (const [id, card] of state.cards) {
        if (!TERMINAL.has(card.view.status) && !live.has(id)) removeCard(id);
      }
      jobs.forEach((j) => { const c = state.cards.get(j.id); if (c) c.seq = -1; upsertJob(j); });
      loadHistory();
      refreshQueueCount();
    });
    source.addEventListener("job", (e) => upsertJob(JSON.parse(e.data)));
    source.addEventListener("history", () => loadHistory());
    source.addEventListener("error", () => {
      if (!document.getElementById("conn-banner")) {
        const banner = el("div", { class: "banner error", id: "conn-banner" }, icon("alert"), el("p", { text: "Lost connection to MediaDock. Reconnecting… (downloads keep running in the background if MediaDock is still open.)" }));
        $("banners").prepend(banner);
      }
    });
  }

  /* ------------------------------------------------------------------- init */

  function bind() {
    $("btn-fetch").addEventListener("click", fetchInfo);
    $("btn-download").addEventListener("click", startDownload);
    $("url-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fetchInfo(); } });
    $("url-input").addEventListener("input", () => {
      if ($("url-input").value.trim() !== state.infoUrl) clearInfo();
      updateDownloadEnabled();
    });
    document.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener("change", renderFormats));
    $("format-select").addEventListener("change", updateFormatDetail);
    $("playlist-toggle").addEventListener("change", () => {
      state.autoPlaylist = false; // the user decided
      if (state.info && $("url-input").value.trim() === state.infoUrl) fetchInfo(); // options differ for playlists
    });
    $("btn-theme").addEventListener("click", toggleTheme);
    $("btn-open-folder").addEventListener("click", openDownloads);
    $("btn-change-folder").addEventListener("click", () => (state.settings.canPickFolder ? browseFolder(false) : openSettings()));
    $("btn-settings").addEventListener("click", openSettings);
    $("settings-close").addEventListener("click", () => $("settings-dialog").close());
    $("settings-cancel").addEventListener("click", () => $("settings-dialog").close());
    $("settings-form").addEventListener("submit", saveSettings);
    $("set-browse").addEventListener("click", () => browseFolder(true));
    $("set-concurrent").addEventListener("input", (e) => { $("set-concurrent-value").textContent = e.target.value; });
    $("btn-more-history").addEventListener("click", () => { state.historyShown += 20; renderHistory(); });
    $("btn-clear-history").addEventListener("click", async () => {
      if (!window.confirm("Clear the whole history list?\n\nDownloaded files are NOT deleted.")) return;
      try { await api("DELETE", "/api/history"); await loadHistory(); } catch (error) { toast(error.message, "error"); }
    });
  }

  async function init() {
    bind();
    renderFormats();
    refreshQueueCount();
    try { await loadSettings(); } catch (error) { toast(error.message, "error"); }
    loadHealth();
    connectEvents();
  }

  init();
})();
