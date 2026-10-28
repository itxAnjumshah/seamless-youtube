import os from "os";
import path from "path";
import { Innertube, UniversalCache } from "youtubei.js";
import { getYouTubeVideoId, parseRequestedFormat, qualityLabel, safeFileName } from "./youtube-id";

const CLIENTS = ["ANDROID", "IOS", "TV_EMBEDDED", "WEB"];
let tubePromise;

function formatHasAudio(format) {
  return Boolean(format?.has_audio) || (format?.audio_quality && format?.mime_type?.includes("audio"));
}

function formatHasVideo(format) {
  return Boolean(format?.has_video) || Number(format?.height) > 0;
}

function formatHeight(format) {
  return Number(format?.height) || 0;
}

function formatSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "Video + audio";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function getTube() {
  if (!tubePromise) {
    tubePromise = Innertube.create({
      generate_session_locally: true,
      cache: new UniversalCache(true, path.join(os.tmpdir(), "youtubei")),
    }).catch((error) => {
      tubePromise = null;
      throw error;
    });
  }
  return tubePromise;
}

async function decipherUrl(yt, format) {
  if (!format) return "";
  if (format.url && /^https?:\/\//i.test(format.url)) return format.url;
  try {
    if (typeof format.decipher === "function") {
      const url = await format.decipher(yt.session.player);
      if (url) return url;
    }
  } catch (error) {
    console.error("Format decipher failed:", error);
  }
  return format.deciphered_url || format.url || "";
}

async function getPlayableInfo(videoId) {
  const yt = await getTube();
  let lastError = new Error("Unable to read this YouTube video. Check the link and try again.");

  for (const client of CLIENTS) {
    try {
      const info = await yt.getBasicInfo(videoId, { client });
      const streaming = info.streaming_data;
      if (!streaming) {
        lastError = new Error("This video does not provide downloadable streams.");
        continue;
      }
      const progressive = (streaming.formats || []).filter((format) => formatHasVideo(format) && formatHasAudio(format));
      const adaptive = streaming.adaptive_formats || [];
      if (progressive.length || adaptive.length) {
        return { yt, info, client, progressive, adaptive };
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function pickThumbnail(info) {
  const thumbs = info.basic_info?.thumbnail || info.basic_info?.thumbnails || [];
  const list = Array.isArray(thumbs) ? thumbs : thumbs?.contents || [];
  const best = [...list].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return best?.url || null;
}

function pickProgressive(progressive, height) {
  const sorted = [...progressive].sort((a, b) => formatHeight(b) - formatHeight(a));
  if (!height) return sorted[0] || null;
  return sorted.find((format) => formatHeight(format) <= height) || sorted.at(-1) || null;
}

function pickAudio(adaptive, progressive) {
  const audioOnly = (adaptive || [])
    .filter((format) => formatHasAudio(format) && !formatHasVideo(format))
    .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));
  const m4a = audioOnly.find((format) => /mp4a|audio\/mp4/i.test(String(format.mime_type || "")));
  return m4a || audioOnly[0] || pickProgressive(progressive);
}

export async function analyzeYouTubeInnertube(url) {
  const videoId = getYouTubeVideoId(url);
  if (!videoId) {
    throw new Error("Paste a YouTube video, Shorts, embed, or live replay link.");
  }

  const { info, progressive, adaptive } = await getPlayableInfo(videoId);
  if (info.basic_info?.is_live) {
    throw new Error("Live streams cannot be downloaded until they have ended.");
  }

  const heights = [...new Set(progressive.map(formatHeight).filter((height) => height > 0))].sort((a, b) => b - a);
  const audio = pickAudio(adaptive, progressive);
  const formats = heights.map((height) => {
    const match = pickProgressive(progressive, height);
    return {
      id: `${height}p`,
      label: qualityLabel(height),
      extension: "MP4",
      size: formatSize(match?.content_length),
      type: "video",
      available: true,
    };
  });

  if (!formats.length && pickProgressive(progressive)) {
    formats.push({
      id: "best",
      label: "Best available",
      extension: "MP4",
      size: "Video + audio",
      type: "video",
      available: true,
    });
  }

  formats.push({
    id: "audio",
    label: "Audio only",
    extension: "M4A",
    size: audio ? formatSize(audio.content_length) : "Audio",
    type: "audio",
    available: Boolean(audio),
  });

  if (!formats.some((format) => format.available && format.type === "video")) {
    throw new Error("This video has no combined video+audio file that can be downloaded on Vercel. Try another link.");
  }

  return {
    url,
    provider: "YouTube",
    title: info.basic_info?.title || "YouTube video",
    duration: Number.isFinite(info.basic_info?.duration) ? Math.round(info.basic_info.duration) : null,
    thumbnail: pickThumbnail(info),
    downloadsAvailable: true,
    availabilityMessage: heights.some((height) => height >= 1080)
      ? ""
      : "Server downloads use YouTube’s combined files (usually up to 360p or 720p) so audio stays in the video.",
    formats,
  };
}

export async function streamYouTubeInnertube(url, formatId) {
  const requested = parseRequestedFormat(formatId);
  if (!requested) {
    throw new Error("Choose a valid download format.");
  }

  const videoId = getYouTubeVideoId(url);
  const { yt, info, progressive, adaptive } = await getPlayableInfo(videoId);
  const audioOnly = requested.kind === "audio";
  const selected = audioOnly
    ? pickAudio(adaptive, progressive)
    : pickProgressive(progressive, requested.kind === "height" ? requested.height : undefined);

  if (!selected) {
    throw new Error("Unable to resolve a downloadable YouTube file. Try a lower quality.");
  }

  const mediaUrl = await decipherUrl(yt, selected);
  if (!mediaUrl) {
    throw new Error("Unable to resolve a downloadable YouTube file. Try a lower quality.");
  }

  const upstream = await fetch(mediaUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      Accept: "*/*",
    },
    redirect: "follow",
  });

  if (!upstream.ok || !upstream.body) {
    throw new Error("YouTube could not provide this file from the server. Try again in a moment.");
  }

  const extension = audioOnly ? "m4a" : "mp4";
  const contentType =
    upstream.headers.get("content-type") || (audioOnly ? "audio/mp4" : "video/mp4");
  const size = Number(selected.content_length || upstream.headers.get("content-length") || 0);
  const filename = safeFileName(info.basic_info?.title || "youtube-video", extension);

  return {
    stream: upstream.body,
    filename,
    extension,
    contentType,
    size,
  };
}
