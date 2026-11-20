# MediaDock

A local web UI for [yt-dlp](https://github.com/yt-dlp/yt-dlp) that runs on your Windows PC.
Paste a link, pick a type and quality, and watch several downloads at once.
It listens only on `127.0.0.1`, so it is not reachable from other machines.

**Features**

- Video + Audio, Video only (no audio) and Audio only, with quality choices read from the formats yt-dlp actually reports for that URL
- Playlists as **one** job with aggregate progress
- Up to 10 simultaneous downloads (default 5), the rest wait in a queue
- Cancel any single download; its whole process tree (yt-dlp + FFmpeg) is stopped
- Persistent history; open files, show them in Explorer, retry, remove entries
- Dark / Light theme, native "choose folder" dialog, "open downloads folder"
- Live progress (Server-Sent Events) that survives a page refresh

## Setup (Windows)

1. Install **Node.js 20 or newer** – <https://nodejs.org> (or `winget install OpenJS.NodeJS.LTS`)
2. Install **yt-dlp** – `winget install yt-dlp.yt-dlp`
3. Install **FFmpeg** – `winget install Gyan.FFmpeg`
   (needed for merging video+audio and for MP3/M4A/Opus/WAV conversion)
4. Extract this ZIP somewhere (e.g. `C:\MediaDock`)
5. Open PowerShell in that folder and run:
   ```powershell
   npm install
   npm start
   ```
6. Open <http://127.0.0.1:3000>

Shortcut: double-click **`start.bat`**. It checks the tools, installs dependencies on first run, opens the browser and starts the server.

> After installing yt-dlp/FFmpeg with winget, **open a new PowerShell window** so the updated PATH is picked up.
> Keep yt-dlp current (`yt-dlp -U`, or `winget upgrade yt-dlp.yt-dlp`). Sites change often and old versions break.

Optional environment variables: `PORT` (default 3000), `YTDLP_PATH`, `FFMPEG_LOCATION` (folder or file), `MEDIADOCK_DATA_DIR`, `MEDIADOCK_DOWNLOAD_DIR`.

## Using it

1. Paste a URL and click **Fetch Info**. You get a preview (title, thumbnail, duration, channel, views, playlist size) and real format choices.
2. Pick **Video + Audio**, **Video only** or **Audio only**, then a quality. **Best Available** is always first and the default.
3. Click **Download**. Watch it in the queue; cancel with ✕ Cancel.
4. Finished, failed and cancelled downloads move to **History**.

**Format choices**

- *Video + Audio*: "Best MP4 – 1080p", "Best WebM – 720p" … only combinations that exist for that video. MP4 choices prefer H.264 (plays everywhere on Windows).
- *Video only*: only genuine video-only streams. If a site has none (many direct-file links), the mode is disabled instead of faking it.
- *Audio only*: the source streams yt-dlp lists (container, codec, bitrate). The **output type** (MP3 / M4A / Opus / WAV / Original) is separate: converting a low-bitrate source to WAV or MP3 does **not** improve quality. "Original" keeps the source stream untouched.
- *Playlists*: items differ, so quality choices are upper limits ("Up to 1080p" = best at or below 1080p for each item).

**Settings** (⚙): download folder (with native Browse dialog), simultaneous downloads (1–10; lower it if your PC or connection struggles), optional cookies.

## "Sign in to confirm you're not a bot"

YouTube sometimes blocks anonymous requests. MediaDock **does not retry** this error (retrying wastes data and makes it worse). Instead the job fails with an explanation. To proceed, open **Settings → Authentication** and either choose a browser where you are signed in to YouTube (Firefox is most reliable; Chrome/Edge cookies are often locked while the browser is open), or point to a `cookies.txt` export. MediaDock never reads or uploads cookies; it only passes your choice to yt-dlp.

## The playlist bug (what was wrong)

Symptoms: progress reached 100 %, dropped to 0 % and began again; status stayed "Running".

What the original code did, and what I found by reading it:

- It took the percentage straight from yt-dlp's per-**file** progress. yt-dlp downloads *every file* separately — for "best video + best audio" that is a video stream then an audio stream, and in a playlist that repeats for every item. So the bar legitimately went 0→100 many times. That looks exactly like "the download restarted", even though no data was downloaded twice.
- A playlist was never modelled as one job: no item index, no item count, no aggregate.
- The server and UI had no reliable end-of-job signal beyond the raw process events, and stderr noise overwrote status messages.

I could not reproduce your exact YouTube run (no access to your screenshot or to YouTube from my environment), so I can't promise the original behaviour was *only* the percentage reset. I can say what the new design guarantees, and these behaviours are covered by automated tests against a real yt-dlp and a real 3-item playlist:

- A playlist is **one job** and **one** yt-dlp process (the test counts process launches).
- Progress = `((item − 1) + itemProgress) / totalItems`, with per-stream progress folded into the item; it never decreases. If yt-dlp gives no index/total, the UI says "Current item" rather than inventing an overall %.
- A job is **Completed** only when the process has exited (code 0, or output exists after a partial playlist), after FFmpeg post-processing, never earlier. Terminal states can't be overwritten by late output, and nothing is ever restarted automatically.
- Retries are limited (`--retries 3`, `--fragment-retries 3`, `--extractor-retries 2`). Bot checks, HTTP 429, disk-full, permission errors and missing FFmpeg stop the whole job immediately.
- Reconnecting the progress stream only re-sends state; it can't start anything. Repeated clicks are de-duplicated (client request id + server-side identical-job check).

## Files & layout

```
server.js            Express app, API, SSE, security checks
lib/jobs.js          Job manager: queue, process lifecycle, progress, cancel
lib/formats.js       Builds quality choices from yt-dlp's format list
lib/system.js        Explorer / folder picker (fixed commands, argument arrays)
lib/validate.js      URL, selector and path validation
lib/{store,deps,proc,errors,config}.js
public/              index.html, style.css, app.js, theme-init.js
data/                settings.json, history.json (created at runtime)
downloads/           default download folder
test/                integration tests (npm test)
start.bat            Windows launcher
```

API: `GET /api/info`, `POST /api/download`, `GET /api/downloads`, `GET /api/events` (SSE), `POST /api/download/:id/cancel`, `GET/POST /api/settings`, `POST /api/open-folder`, `POST /api/select-folder`, `GET /api/health`, `GET|DELETE /api/history[/:id]`, `POST /api/history/:id/{open-file|reveal|delete-file}`, `GET /api/files/:id/:index`.

## Security notes

- Binds to `127.0.0.1` only; requests with a foreign `Host` or `Origin` are rejected (DNS-rebinding / cross-site protection).
- yt-dlp/FFmpeg/Explorer/PowerShell are started with `spawn` and **argument arrays**, never `shell: true`. URLs must be http(s); format selectors are matched against a strict pattern; the URL always follows `--`.
- The folder to open comes from saved settings, never from the request. Files can only be opened, served or deleted if they are recorded outputs inside a folder MediaDock has downloaded into. Only media/subtitle file types can be opened; deleting a file requires an explicit confirmation. Removing a history entry never touches the file.

## Behaviour to know about

- If MediaDock is closed, active downloads are stopped and recorded as cancelled. After a hard crash they are shown in History as "Interrupted". Nothing resumes automatically.
- If a file with the same name already exists, yt-dlp skips it; MediaDock says so in a warning rather than claiming a fresh download.
- Changing the folder never moves or deletes existing files; queued downloads keep the folder they were created with.
- Subtitles (English & Hindi, `.srt`) are optional and not applied to audio-only downloads.

## Tests

`npm test` runs integration tests that start the real server and drive real yt-dlp + FFmpeg against local media (single video, MP3 conversion, a 3-item playlist, cancel + concurrency, queue limit, duplicate protection, bot-check handling with a fake yt-dlp, missing FFmpeg/yt-dlp, validation, settings persistence, history safety, graceful shutdown). They need yt-dlp and FFmpeg on `PATH` and a POSIX shell, so they are skipped on Windows. Windows-specific code (Explorer, folder picker, `taskkill`) cannot be exercised by them.

## Limitations (honest list)

- Windows-only pieces — `explorer.exe` opening/selecting, the PowerShell folder dialog and `taskkill /T /F` — were written to documented behaviour but **not executed** in my Linux test environment. Process-tree termination was verified on Linux (process groups). If something misbehaves on Windows, please report it.
- I could not test against live YouTube (no access from my environment): real format lists were tested with a unit fixture shaped like YouTube's, and real downloads with local media.
- Browser cookie access depends on yt-dlp and your browser (Chrome/Edge often lock their cookie database).
- Playlist overall progress is exact only when yt-dlp reports the item index and count (it does for YouTube).
