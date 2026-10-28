import { NextResponse } from "next/server";
import {
  getProvider,
  isAuthorizedHost,
  isDirectMediaUrl,
  isYouTubeHost,
} from "../_lib/authorized-media";
import { analyzeYouTube, isYouTubeVideoUrl } from "../_lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function parseVideoUrl(raw) {
  const url = typeof raw === "string" ? raw.trim() : "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "Enter a valid video URL, including https://.", status: 400 };
  }
  if (parsed.protocol !== "https:") {
    return { error: "Only secure HTTPS links are supported.", status: 400 };
  }
  if (!isAuthorizedHost(parsed.hostname)) {
    return { error: "This source is not supported. Use a YouTube link or a direct video file URL.", status: 403 };
  }
  return { url, parsed };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const parsedRequest = parseVideoUrl(body.url);
    if (parsedRequest.error) {
      return NextResponse.json({ error: parsedRequest.error }, { status: parsedRequest.status });
    }

    const { url, parsed } = parsedRequest;

    if (isYouTubeHost(parsed.hostname)) {
      if (!isYouTubeVideoUrl(parsed)) {
        return NextResponse.json(
          { error: "Paste a YouTube video, Shorts, embed, or live replay link." },
          { status: 400 },
        );
      }
      const data = await analyzeYouTube(url);
      return NextResponse.json(data);
    }

    const provider = getProvider(parsed.hostname);
    const isDirectMedia = isDirectMediaUrl(parsed);
    return NextResponse.json({
      url,
      provider,
      title: `${provider} video preview`,
      duration: null,
      thumbnail:
        "https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&w=1200&q=80",
      downloadsAvailable: isDirectMedia,
      availabilityMessage: isDirectMedia
        ? ""
        : "This link is not a direct media file. Use a YouTube link or a URL ending in .mp4, .webm, .mov, or .m4v.",
      formats: [
        { id: "1080p", label: "Full HD", extension: "MP4", size: "Original", type: "video", available: isDirectMedia },
        { id: "720p", label: "HD", extension: "MP4", size: "Optimized", type: "video", available: false },
        { id: "audio", label: "Audio only", extension: "MP3", size: "Optimized", type: "audio", available: false },
      ],
    });
  } catch (error) {
    const isYtDlpError = error.name === "YtDlpError";
    if (isYtDlpError) {
      const details = String(error.cause?.message || "")
        .replace(/https?:\/\/\S+/gi, "[URL]")
        .slice(0, 1000);
      console.error("YouTube analysis failed:", details || error.message);
    } else {
      console.error("Video analysis failed:", error);
    }
    return NextResponse.json(
      {
        error: isYtDlpError
          ? error.message
          : error.message || "We could not read that request. Please try again.",
      },
      { status: isYtDlpError ? 502 : 400 },
    );
  }
}
