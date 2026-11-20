"use strict";
// Builds the Video+Audio / Video-only / Audio-only choices from yt-dlp's real format list.
// Nothing here is hardcoded per video: options only exist if matching formats exist.

const AUDIO_OUTPUTS = [
  { value: "mp3", label: "MP3" },
  { value: "m4a", label: "M4A (AAC)" },
  { value: "opus", label: "Opus" },
  { value: "wav", label: "WAV (lossless container, large)" },
  { value: "original", label: "Original (no conversion)" }
];

const hasVideo = (f) => !!f.vcodec && f.vcodec !== "none";
const hasAudio = (f) => !!f.acodec && f.acodec !== "none";
const isJunk = (f) => f.ext === "mhtml" || f.protocol === "mhtml" || /storyboard/i.test(f.format_note || "") || !f.format_id;

function classify(f) {
  if (isJunk(f)) return null;
  if (hasVideo(f) && f.acodec === "none") return "videoOnly";
  if (hasAudio(f) && f.vcodec === "none") return "audioOnly";
  return "combined"; // has both, or codecs unknown (direct links)
}

const sizeOf = (f) => f.filesize || f.filesize_approx || null;
const rate = (f) => f.tbr || f.vbr || f.abr || 0;

function fmtSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `~${n.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

const vcodecName = (c) => (c ? String(c).split(".")[0] : "");
function acodecName(c) {
  const base = String(c || "").split(".")[0].toLowerCase();
  if (base === "mp4a") return "AAC";
  if (base === "opus") return "Opus";
  if (base === "vorbis") return "Vorbis";
  if (base === "ec-3" || base === "ac-3") return "Dolby";
  return base ? base.toUpperCase() : "";
}

const EXT_NAMES = { mp4: "MP4", webm: "WebM", mkv: "MKV", m4a: "M4A", mov: "MOV", flv: "FLV" };
const extLabel = (ext) => EXT_NAMES[ext] || String(ext || "").toUpperCase();
const best = (list) => list.slice().sort((a, b) => rate(b) - rate(a))[0];

/** Options for "Video + Audio". */
function buildAudioVideoOptions(formats) {
  const videoOnly = formats.filter((f) => classify(f) === "videoOnly" && f.height);
  const audioOnly = formats.filter((f) => classify(f) === "audioOnly");
  const combined = formats.filter((f) => classify(f) === "combined" && f.height);
  const canMerge = videoOnly.length > 0 && audioOnly.length > 0;

  const options = [{
    id: "best",
    label: "Best Available (Recommended)",
    detail: canMerge
      ? "Highest quality video and audio, merged with FFmpeg into MP4."
      : "Best single file the site offers.",
    selector: "bv*+ba/b",
    merge: "mp4",
    sort: "",
    streams: canMerge ? 2 : 1
  }];

  const buckets = new Map(); // "ext|height" -> { ext, height, v:[], c:[] }
  const bucket = (ext, height) => {
    const key = `${ext}|${height}`;
    if (!buckets.has(key)) buckets.set(key, { ext, height, v: [], c: [] });
    return buckets.get(key);
  };
  videoOnly.forEach((f) => bucket(f.ext, f.height).v.push(f));
  combined.forEach((f) => bucket(f.ext, f.height).c.push(f));

  const audioFor = (ext) => {
    if (ext === "mp4") return audioOnly.filter((a) => a.ext === "m4a");
    if (ext === "webm") return audioOnly.filter((a) => a.ext === "webm");
    return audioOnly;
  };

  const rows = [];
  for (const b of buckets.values()) {
    const partners = b.v.length ? audioFor(b.ext) : [];
    const merged = b.v.length > 0 && partners.length > 0;
    if (!merged && !b.c.length) continue; // nothing playable with sound at this size
    const video = merged ? best(b.v) : best(b.c);
    const audio = merged ? best(partners) : null;
    const container = b.ext === "mp4" ? "mp4" : b.ext === "webm" ? "webm" : "mkv";
    const fps = Math.max(...(merged ? b.v : b.c).map((f) => f.fps || 0));
    const heightLabel = `${b.height}p${fps > 30 ? Math.round(fps) : ""}`;

    let selector;
    if (merged) {
      const audioSel = b.ext === "mp4" ? "ba[ext=m4a]" : b.ext === "webm" ? "ba[ext=webm]" : "ba";
      selector = `bv*[height=${b.height}][ext=${b.ext}]+${audioSel}`;
      if (b.c.length) selector += `/b[height=${b.height}][ext=${b.ext}]`;
    } else {
      selector = `b[height=${b.height}][ext=${b.ext}]`;
    }

    const parts = [vcodecName(video.vcodec), merged ? `+ ${acodecName(audio.acodec)}` : (hasAudio(video) ? `+ ${acodecName(video.acodec)}` : "")].filter(Boolean);
    const size = merged ? ((sizeOf(video) || 0) + (sizeOf(audio) || 0)) || null : sizeOf(video);
    rows.push({
      height: b.height,
      extRank: b.ext === "mp4" ? 0 : b.ext === "webm" ? 1 : 2,
      option: {
        id: `av-${b.ext}-${b.height}`,
        label: `Best ${extLabel(b.ext)} – ${heightLabel}`,
        detail: [parts.join(" "), fmtSize(size), merged ? "merged with FFmpeg" : "single file"].filter(Boolean).join(" · "),
        selector,
        merge: container,
        // Prefer H.264 inside MP4: plays everywhere on Windows without extra codecs.
        sort: b.ext === "mp4" ? "vcodec:h264,acodec:aac" : "",
        streams: merged ? 2 : 1
      }
    });
  }
  rows.sort((a, b) => b.height - a.height || a.extRank - b.extRank);
  rows.forEach((r) => options.push(r.option));
  return options;
}

/** Options for "Video only (no audio)". Only genuine video-only streams are offered. */
function buildVideoOnlyOptions(formats) {
  const videoOnly = formats.filter((f) => classify(f) === "videoOnly" && f.height);
  if (!videoOnly.length) return [];
  const options = [{
    id: "best",
    label: "Best Video Only (Recommended)",
    detail: "Highest resolution video stream, without any audio track.",
    selector: "bv",
    merge: "mp4",
    sort: "",
    streams: 1
  }];
  const buckets = new Map();
  videoOnly.forEach((f) => {
    const key = `${f.height}|${f.ext}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(f);
  });
  const rows = [...buckets.entries()].map(([key, list]) => {
    const [height, ext] = [Number(key.split("|")[0]), key.split("|")[1]];
    const top = best(list);
    const fps = Math.max(...list.map((f) => f.fps || 0));
    return {
      height, ext,
      option: {
        id: `v-${ext}-${height}`,
        label: `${height}p${fps > 30 ? Math.round(fps) : ""} · ${extLabel(ext)}`,
        detail: [vcodecName(top.vcodec), fmtSize(sizeOf(top)), "no audio"].filter(Boolean).join(" · "),
        selector: `bv[height=${height}][ext=${ext}]`,
        merge: "mp4",
        sort: "",
        streams: 1
      }
    };
  });
  rows.sort((a, b) => b.height - a.height || a.ext.localeCompare(b.ext));
  rows.forEach((r) => options.push(r.option));
  return options;
}

/** Options for "Audio only". */
function buildAudioOnlyOptions(formats) {
  const audioOnly = formats.filter((f) => classify(f) === "audioOnly");
  const options = [{
    id: "best",
    label: "Best Available Audio (Recommended)",
    detail: "Highest quality audio stream the site provides.",
    selector: "ba/b",
    merge: "mp4",
    sort: "",
    streams: 1
  }];
  for (const [ext, label] of [["m4a", "Best M4A Audio"], ["webm", "Best WebM/Opus Audio"]]) {
    const list = audioOnly.filter((f) => f.ext === ext);
    if (!list.length) continue;
    const top = best(list);
    options.push({
      id: `a-best-${ext}`,
      label,
      detail: [acodecName(top.acodec), top.abr ? `${Math.round(top.abr)} kbps` : "", fmtSize(sizeOf(top))].filter(Boolean).join(" · "),
      selector: `ba[ext=${ext}]`,
      merge: "mp4",
      sort: "",
      streams: 1
    });
  }
  // Individual streams (deduplicated by container/codec/bitrate/language).
  const seen = new Set();
  const languages = new Set(audioOnly.map((f) => f.language).filter(Boolean));
  audioOnly
    .slice()
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))
    .forEach((f) => {
      const key = [f.ext, f.acodec, Math.round(f.abr || f.tbr || 0), f.language || ""].join("|");
      if (seen.has(key)) return;
      seen.add(key);
      const kbps = f.abr || f.tbr;
      const lang = languages.size > 1 && f.language ? ` · ${f.language}` : "";
      options.push({
        id: `a-${f.format_id}`,
        label: `${extLabel(f.ext)} · ${acodecName(f.acodec) || "audio"}${kbps ? ` · ${Math.round(kbps)} kbps` : ""}${lang}`,
        detail: [fmtSize(sizeOf(f)), f.asr ? `${Math.round(f.asr / 1000)} kHz` : "", `stream ${f.format_id}`].filter(Boolean).join(" · "),
        selector: String(f.format_id),
        merge: "mp4",
        sort: "",
        streams: 1
      });
    });
  return options;
}

/**
 * Playlists: items have different formats, so only height-capped selectors are offered.
 * These are limits ("best at or below"), and they say so.
 */
function buildPlaylistOptions() {
  const caps = [2160, 1440, 1080, 720, 480, 360];
  const av = [{
    id: "best", label: "Best Available (Recommended)", detail: "Best video and audio for every item.",
    selector: "bv*+ba/b", merge: "mp4", sort: "", streams: 2
  }];
  const vo = [{
    id: "best", label: "Best Video Only (Recommended)", detail: "Best video-only stream for every item (items without one will fail).",
    selector: "bv", merge: "mp4", sort: "", streams: 1
  }];
  caps.forEach((h) => {
    av.push({
      id: `av-cap-${h}`, label: `Up to ${h}p`, detail: "Best quality at or below this height for each item (limit, not a guarantee).",
      selector: `bv*[height<=${h}]+ba/b[height<=${h}]`, merge: "mp4", sort: "", streams: 2
    });
    vo.push({
      id: `v-cap-${h}`, label: `Up to ${h}p · video only`, detail: "Best video-only stream at or below this height (limit, not a guarantee).",
      selector: `bv[height<=${h}]`, merge: "mp4", sort: "", streams: 1
    });
  });
  const ao = [{
    id: "best", label: "Best Available Audio (Recommended)", detail: "Highest quality audio for every item.",
    selector: "ba/b", merge: "mp4", sort: "", streams: 1
  }];
  return { av, video: vo, audio: ao };
}

function normalizeThumbnail(info) {
  let thumb = info.thumbnail || "";
  if (!thumb && Array.isArray(info.thumbnails) && info.thumbnails.length) {
    thumb = info.thumbnails[info.thumbnails.length - 1].url || "";
  }
  return /^https:\/\//i.test(thumb) ? thumb : "";
}

/** Converts yt-dlp's -J output into what the UI needs. */
function describeInfo(info, requestedUrl) {
  const isPlaylist = Array.isArray(info.entries);
  const base = {
    id: info.id || "",
    title: info.title || "Untitled",
    uploader: info.uploader || info.channel || info.playlist_uploader || "",
    thumbnail: normalizeThumbnail(info),
    webpageUrl: info.webpage_url || requestedUrl,
    extractor: info.extractor_key || info.extractor || ""
  };

  if (isPlaylist) {
    const entries = info.entries.filter(Boolean);
    const count = info.playlist_count || entries.length;
    let thumbnail = base.thumbnail;
    if (!thumbnail) {
      const withThumb = entries.find((e) => normalizeThumbnail(e));
      if (withThumb) thumbnail = normalizeThumbnail(withThumb);
    }
    return {
      ...base,
      thumbnail,
      type: "playlist",
      playlist: {
        count,
        entries: entries.slice(0, 100).map((e) => ({
          id: e.id || "", title: e.title || "Untitled", duration: e.duration || null
        }))
      },
      options: buildPlaylistOptions(),
      audioOutputs: AUDIO_OUTPUTS,
      notes: ["Playlist items can differ, so quality choices are upper limits applied to every item."]
    };
  }

  const formats = Array.isArray(info.formats) ? info.formats : [];
  const options = {
    av: buildAudioVideoOptions(formats),
    video: buildVideoOnlyOptions(formats),
    audio: buildAudioOnlyOptions(formats)
  };
  const notes = [];
  if (!options.video.length) notes.push("This source has no video-only streams, so \"Video only\" is unavailable.");
  if (!formats.length) notes.push("yt-dlp reported no format list; only the default selection is offered.");
  return {
    ...base,
    type: "video",
    duration: info.duration || null,
    viewCount: info.view_count ?? null,
    isLive: !!info.is_live,
    counts: {
      combined: formats.filter((f) => classify(f) === "combined").length,
      videoOnly: formats.filter((f) => classify(f) === "videoOnly").length,
      audioOnly: formats.filter((f) => classify(f) === "audioOnly").length
    },
    options,
    audioOutputs: AUDIO_OUTPUTS,
    notes
  };
}

/** Selection used when the user has not fetched any information. */
function defaultOptions() {
  return {
    av: [{ id: "best", label: "Best Available (Recommended)", detail: "Highest quality video and audio, merged with FFmpeg into MP4.", selector: "bv*+ba/b", merge: "mp4", sort: "", streams: 2 }],
    video: [{ id: "best", label: "Best Video Only (Recommended)", detail: "Highest resolution video stream, without any audio track.", selector: "bv", merge: "mp4", sort: "", streams: 1 }],
    audio: [{ id: "best", label: "Best Available Audio (Recommended)", detail: "Highest quality audio stream the site provides.", selector: "ba/b", merge: "mp4", sort: "", streams: 1 }]
  };
}

module.exports = { describeInfo, defaultOptions, AUDIO_OUTPUTS, classify };
