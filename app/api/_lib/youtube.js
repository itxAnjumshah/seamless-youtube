import { spawn, spawnSync } from "child_process";
import { chmodSync, createReadStream, existsSync, readdirSync, statSync } from "fs";
import { mkdir, rm } from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import ffmpegStatic from "ffmpeg-static";
import { isServerlessRuntime } from "./runtime";
import { parseRequestedFormat as parseFormatId, qualityLabel as heightQualityLabel, safeFileName as makeSafeFileName } from "./youtube-id";

const BIN_DIR = path.join(process.cwd(), "bin");

let ffmpegCache;
let ytDlpCache;

function ensureExecutable(filePath) {
  if (!filePath || process.platform === "win32") return;
  try {
    chmodSync(filePath, 0o755);
  } catch {
    // The binary may already be executable, or the filesystem may be read-only except chmod.
  }
}

function resolveYtDlp() {
  if (ytDlpCache !== undefined) return ytDlpCache;

  const names = process.platform === "win32" ? ["yt-dlp.exe", "yt-dlp"] : ["yt-dlp", "yt-dlp.exe"];
  const candidates = names.flatMap((name) => [
    path.join(BIN_DIR, name),
    path.join(process.cwd(), "bin", name),
  ]);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      ensureExecutable(candidate);
      ytDlpCache = candidate;
      return ytDlpCache;
    }
  }

  ytDlpCache = null;
  return ytDlpCache;
}

function ytDlpExists() {
  return Boolean(resolveYtDlp());
}

export function findFfmpeg() {
  if (ffmpegCache !== undefined) return ffmpegCache;

  const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const extra = [
    process.env.FFMPEG_PATH,
    path.join(process.cwd(), "node_modules", "ffmpeg-static", binaryName),
    path.join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg"),
    ffmpegStatic,
    path.join(BIN_DIR, binaryName),
  ].filter(Boolean);

  for (const candidate of extra) {
    if (existsSync(candidate)) {
      ensureExecutable(candidate);
      ffmpegCache = candidate;
      return ffmpegCache;
    }
  }

  const locator = process.platform === "win32" ? "where" : "which";
  const located = spawnSync(locator, ["ffmpeg"], { encoding: "utf8", windowsHide: true });
  if (located.status === 0) {
    const first = String(located.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first && existsSync(first)) {
      ffmpegCache = first;
      return ffmpegCache;
    }
  }

  ffmpegCache = null;
  return ffmpegCache;
}

function friendlyYtError(stderr) {
  const text = String(stderr || "").toLowerCase();
  if (text.includes("private video") || text.includes("this video is private")) {
    return "This video is private, so it cannot be downloaded.";
  }
  if (text.includes("sign in to confirm you’re not a bot") || text.includes("sign in to confirm you're not a bot") || text.includes("not a bot")) {
    return "YouTube blocked this request from the server. Try again later, or run the app on your computer.";
  }
  if (text.includes("sign in to confirm your age") || text.includes("age-restricted")) {
    return "This video is age-restricted and cannot be downloaded without login.";
  }
  if (text.includes("video unavailable") || text.includes("this video is not available")) {
    return "This YouTube video is unavailable.";
  }
  if (text.includes("premiere") && text.includes("live")) {
    return "This premiere or live stream is not ready to download yet.";
  }
  if (text.includes("live event will begin") || text.includes("is currently live")) {
    return "Live streams cannot be downloaded until they have ended.";
  }
  if (text.includes("copyright") || text.includes("drm")) {
    return "This video is protected and cannot be downloaded.";
  }
  if (text.includes("http error 429") || text.includes("too many requests")) {
    return "YouTube is rate-limiting requests. Wait a moment and try again.";
  }
  if (text.includes("ffmpeg") && (text.includes("not found") || text.includes("is not installed"))) {
    return "FFmpeg is missing, so video and audio cannot be combined. Run npm run setup, then restart the app.";
  }
  if (text.includes("timed out")) {
    return "The download timed out. Try a lower quality or try again.";
  }
  if (text.includes("enoent") || text.includes("downloader is missing")) {
    return "YouTube downloader is missing from the server. Redeploy so the build can download yt-dlp.";
  }
  return "Unable to read this YouTube video. Check the link and try again.";
}

function makeYtDlpError(error) {
  const friendlyError = new Error(friendlyYtError(error.message));
  friendlyError.name = "YtDlpError";
  friendlyError.cause = error;
  return friendlyError;
}

function parseYtProgress(chunk, onProgress) {
  if (!onProgress) return;
  const text = String(chunk || "");
  const percentMatch = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
  if (percentMatch) {
    const percent = Math.min(90, Math.max(1, Math.round(Number(percentMatch[1]) * 0.9)));
    onProgress({ percent, phase: "downloading" });
    return;
  }
  if (/\[merger\]|\[extractaudio\]|\[ffmpeg\]/i.test(text)) {
    onProgress({ percent: 92, phase: "processing" });
  }
}

function runProcess(command, args, { timeoutMs = 90000, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (onStderr) onStderr(chunk);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The media process timed out. Try again."));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `Process failed with code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function youtubeClientArgs() {
  return [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--extractor-args",
    "youtube:player_client=android,ios,web",
  ];
}

function runYtDlp(args, { timeoutMs = 90000, onProgress } = {}) {
  const ytDlpPath = resolveYtDlp();
  if (!ytDlpPath) {
    return Promise.reject(makeYtDlpError(new Error("YouTube downloader is missing.")));
  }

  const ffmpeg = findFfmpeg();
  const finalArgs = [...args];
  if (ffmpeg) finalArgs.unshift("--ffmpeg-location", ffmpeg);

  return runProcess(ytDlpPath, finalArgs, {
    timeoutMs,
    onStderr: (chunk) => parseYtProgress(chunk, onProgress),
  }).catch((error) => {
    throw makeYtDlpError(error);
  });
}

function qualityLabel(height) {
  return heightQualityLabel(height);
}

function uniqueHeights(formats) {
  const heights = (formats || [])
    .filter((format) => format && format.vcodec && format.vcodec !== "none" && Number(format.height) > 0)
    .map((format) => Number(format.height));
  return [...new Set(heights)].sort((a, b) => b - a);
}

function pickThumbnail(info) {
  if (info.thumbnail) return info.thumbnail;
  const thumbs = Array.isArray(info.thumbnails) ? info.thumbnails : [];
  const best = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return best?.url || null;
}

function safeFileName(title, extension) {
  return makeSafeFileName(title, extension);
}

function videoFormatSelector(height) {
  const cap = Number.isFinite(height) ? `[height<=${height}]` : "";
  return [
    `bv*[vcodec^=avc1]${cap}+ba[acodec^=mp4a]`,
    `bv*[vcodec^=avc1]${cap}+ba[ext=m4a]`,
    `bv*[ext=mp4]${cap}+ba[ext=m4a]`,
    `bv*${cap}+ba`,
    `b[ext=mp4]${cap}`,
    `b${cap}`,
  ].join("/");
}

function progressiveFormatSelector(height) {
  const cap = Number.isFinite(height) ? `[height<=${height}]` : "";
  return [
    `b[ext=mp4][acodec!=none][vcodec!=none]${cap}`,
    `b[acodec!=none][vcodec!=none]${cap}`,
    `b${cap}`,
    "b",
  ].join("/");
}

function probeMedia(filePath) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg || !existsSync(filePath)) {
    return { hasVideo: false, hasAudio: false, h264: false, aac: false };
  }

  const result = spawnSync(ffmpeg, ["-hide_banner", "-i", filePath], {
    encoding: "utf8",
    windowsHide: true,
  });
  const text = `${result.stdout || ""}\n${result.stderr || ""}`.toLowerCase();
  return {
    hasVideo: /stream\s*#\d+:\d+.+:\s*video:/.test(text),
    hasAudio: /stream\s*#\d+:\d+.+:\s*audio:/.test(text),
    h264: /video:\s*(h264|avc)/.test(text),
    aac: /audio:\s*aac/.test(text),
  };
}

async function makeWindowsCompatible(inputPath, tmpDir, { audioOnly, onProgress }) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return inputPath;
  if (onProgress) onProgress({ percent: 93, phase: "processing" });

  const inputExt = path.extname(inputPath).toLowerCase();
  if (audioOnly) {
    if (inputExt === ".mp3") return inputPath;
    const outputPath = path.join(tmpDir, `audio-${randomUUID()}.mp3`);
    await runProcess(
      ffmpeg,
      ["-y", "-i", inputPath, "-vn", "-c:a", "libmp3lame", "-q:a", "2", outputPath],
      { timeoutMs: 10 * 60 * 1000 },
    );
    return outputPath;
  }

  const probe = probeMedia(inputPath);
  if (inputExt === ".mp4" && probe.h264 && probe.aac && probe.hasAudio) {
    return inputPath;
  }

  const outputPath = path.join(tmpDir, `playable-${randomUUID()}.mp4`);
  const transcodeArgs = [
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  if (probe.h264) {
    try {
      await runProcess(
        ffmpeg,
        [
          "-y",
          "-i",
          inputPath,
          "-map",
          "0:v:0?",
          "-map",
          "0:a:0?",
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-ac",
          "2",
          "-movflags",
          "+faststart",
          outputPath,
        ],
        { timeoutMs: 10 * 60 * 1000 },
      );
      return outputPath;
    } catch (error) {
      console.error("Fast AAC remux failed, transcoding instead:", error);
    }
  }

  await runProcess(ffmpeg, transcodeArgs, { timeoutMs: 10 * 60 * 1000 });
  return outputPath;
}

function pickDownloadedFile(tmpDir) {
  const skip = new Set([".part", ".ytdl", ".json", ".jpg", ".jpeg", ".png", ".webp", ".vtt", ".srt"]);
  const files = readdirSync(tmpDir)
    .map((name) => {
      const filePath = path.join(tmpDir, name);
      return {
        name,
        path: filePath,
        ext: path.extname(name).toLowerCase(),
        size: statSync(filePath).size,
      };
    })
    .filter((file) => file.size > 0 && !skip.has(file.ext) && !file.name.endsWith(".part"));

  if (!files.length) return null;

  const preferredExts = new Set([".mp4", ".m4a", ".mp3"]);
  const preferred = files.filter((file) => preferredExts.has(file.ext));
  const pool = preferred.length ? preferred : files;
  pool.sort((a, b) => b.size - a.size);
  return pool[0];
}

export function isYouTubeVideoUrl(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be") return Boolean(url.pathname.replace("/", "").trim());
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtube-nocookie.com") {
    return (
      url.searchParams.has("v") ||
      url.pathname.startsWith("/shorts/") ||
      url.pathname.startsWith("/embed/") ||
      url.pathname.startsWith("/live/") ||
      url.pathname.startsWith("/watch")
    );
  }
  return false;
}

export async function analyzeYouTube(url) {
  try {
    const { analyzeYouTubeInnertube } = await import("./youtube-innertube");
    return await analyzeYouTubeInnertube(url);
  } catch (error) {
    console.error("Innertube analysis failed, falling back to yt-dlp:", error);
  }
  return analyzeYouTubeWithYtDlp(url);
}

async function analyzeYouTubeWithYtDlp(url) {
  const { stdout } = await runYtDlp(
    [
      ...youtubeClientArgs(),
      "--dump-single-json",
      "--no-download",
      "--skip-download",
      url,
    ],
    { timeoutMs: 90000 },
  );

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error("YouTube returned an unexpected response. Try the link again.");
  }

  if (info._type === "playlist") {
    throw new Error("This looks like a playlist. Paste a single video, Shorts, or live replay link.");
  }

  if (info.is_live) {
    throw new Error("Live streams cannot be downloaded until they have ended.");
  }

  const heights = uniqueHeights(info.formats);
  const hasFfmpeg = Boolean(findFfmpeg());
  const serverless = isServerlessRuntime();
  const formats = [
    ...heights.slice(0, 8).map((height) => ({
      id: `${height}p`,
      label: qualityLabel(height),
      extension: "MP4",
      size: serverless || hasFfmpeg || height <= 720 ? "Video + audio" : "Needs FFmpeg for audio",
      type: "video",
      available: serverless || hasFfmpeg || height <= 720,
    })),
    {
      id: "audio",
      label: "Audio only",
      extension: serverless || !hasFfmpeg ? "M4A" : "MP3",
      size: "Audio",
      type: "audio",
      available: true,
    },
  ];

  if (!heights.length && info.acodec && info.acodec !== "none") {
    formats.unshift({
      id: "best",
      label: "Best available",
      extension: "MP4",
      size: "Video + audio",
      type: "video",
      available: true,
    });
  }

  if (!formats.some((format) => format.available && format.type === "video")) {
    formats.unshift({
      id: "best",
      label: "Best available",
      extension: "MP4",
      size: "Video + audio",
      type: "video",
      available: true,
    });
  }

  return {
    url,
    provider: "YouTube",
    title: info.title || "YouTube video",
    duration: Number.isFinite(info.duration) ? Math.round(info.duration) : null,
    thumbnail: pickThumbnail(info),
    downloadsAvailable: formats.some((format) => format.available),
    availabilityMessage: hasFfmpeg || serverless
      ? ""
      : "FFmpeg is recommended so HD files include playable audio.",
    formats,
  };
}

export function parseRequestedFormat(formatId) {
  return parseFormatId(formatId);
}

export async function streamYouTubeServer(url, formatId) {
  try {
    const { streamYouTubeInnertube } = await import("./youtube-innertube");
    return await streamYouTubeInnertube(url, formatId);
  } catch (error) {
    console.error("Innertube stream failed, falling back to yt-dlp proxy:", error);
  }

  const direct = await getYouTubeDirectDownload(url, formatId);
  const upstream = await fetch(direct.url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      Accept: "*/*",
    },
    redirect: "follow",
  });
  if (!upstream.ok || !upstream.body) {
    throw new Error("YouTube could not provide this file from the server. Try a lower quality.");
  }
  const audioOnly = parseRequestedFormat(formatId)?.kind === "audio";
  return {
    stream: upstream.body,
    filename: direct.filename,
    extension: direct.extension,
    contentType: audioOnly ? "audio/mp4" : "video/mp4",
    size: Number(upstream.headers.get("content-length") || 0),
  };
}

export async function getYouTubeDirectDownload(url, formatId) {
  const requested = parseRequestedFormat(formatId);
  if (!requested) {
    throw new Error("Choose a valid download format.");
  }

  const audioOnly = requested.kind === "audio";
  const height = requested.kind === "height" ? requested.height : undefined;
  const selector = audioOnly
    ? "ba[ext=m4a]/ba/b"
    : progressiveFormatSelector(height);

  const { stdout } = await runYtDlp(
    [
      ...youtubeClientArgs(),
      "-f",
      selector,
      "-j",
      "--skip-download",
      url,
    ],
    { timeoutMs: 90000 },
  );

  let info;
  try {
    info = JSON.parse(String(stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}");
  } catch {
    info = {};
  }

  let mediaUrl = info.url;
  if (!mediaUrl && Array.isArray(info.requested_formats)) {
    mediaUrl = info.requested_formats.find((item) => item?.url)?.url;
  }
  if (!mediaUrl) {
    const fallback = await runYtDlp(
      [...youtubeClientArgs(), "-g", "-f", selector, url],
      { timeoutMs: 90000 },
    );
    mediaUrl = String(fallback.stdout || "").trim().split(/\r?\n/).find((item) => /^https?:\/\//i.test(item)) || "";
  }

  if (!mediaUrl) {
    throw new Error("Unable to resolve a downloadable YouTube file. Try a lower quality.");
  }

  const extension = audioOnly ? "m4a" : String(info.ext || "mp4").replace(/^\./, "");
  return {
    url: mediaUrl,
    filename: safeFileName(info.title || "youtube-video", extension),
    extension,
  };
}

export async function downloadYouTube(url, formatId, { onProgress } = {}) {
  const requested = parseRequestedFormat(formatId);
  if (!requested) {
    throw new Error("Choose a valid download format.");
  }

  const tmpDir = path.join(os.tmpdir(), `streamline-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  const outputTemplate = path.join(tmpDir, "%(title).80s.%(ext)s");
  const hasFfmpeg = Boolean(findFfmpeg());
  const audioOnly = requested.kind === "audio";
  if (onProgress) onProgress({ percent: 2, phase: "starting" });

  const args = [
    ...youtubeClientArgs(),
    "--restrict-filenames",
    "-o",
    outputTemplate,
  ];

  if (audioOnly) {
    if (hasFfmpeg) {
      args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    } else {
      args.push("-f", "ba[ext=m4a]/ba/b");
    }
  } else {
    const height = requested.kind === "height" ? requested.height : undefined;
    args.push("-f", videoFormatSelector(height));
    args.push("-S", "res,vcodec:h264,acodec:aac,ext:mp4:m4a");
    if (hasFfmpeg) {
      args.push("--merge-output-format", "mp4");
    }
  }

  args.push(url);

  try {
    await runYtDlp(args, { timeoutMs: 10 * 60 * 1000, onProgress });
    const downloaded = pickDownloadedFile(tmpDir);
    if (!downloaded) {
      throw new Error("The download finished but no file was created.");
    }

    let filePath = downloaded.path;
    if (hasFfmpeg && !isServerlessRuntime()) {
      try {
        filePath = await makeWindowsCompatible(filePath, tmpDir, { audioOnly, onProgress });
      } catch (error) {
        console.error("FFmpeg compatibility pass failed:", error);
        if (!audioOnly) {
          throw new Error("The video downloaded, but audio could not be converted for playback. Try a lower quality.");
        }
      }
    }

    if (onProgress) onProgress({ percent: 96, phase: "sending" });
    const extension = path.extname(filePath).replace(".", "") || (audioOnly ? "mp3" : "mp4");
    const filename = safeFileName(path.basename(downloaded.name, path.extname(downloaded.name)), extension);
    const size = statSync(filePath).size;
    const nodeStream = createReadStream(filePath);
    const cleanup = () => rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    nodeStream.on("close", cleanup);
    nodeStream.on("error", cleanup);
    return {
      stream: Readable.toWeb(nodeStream),
      extension,
      filename,
      size,
      cleanup,
    };
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export { safeFileName };
