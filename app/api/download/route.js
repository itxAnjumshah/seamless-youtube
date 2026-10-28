import { NextResponse } from "next/server";
import {
  isAuthorizedHost,
  isDirectMediaUrl,
  isYouTubeHost,
} from "../_lib/authorized-media";
import { isServerlessRuntime } from "../_lib/runtime";
import {
  downloadYouTube,
  isYouTubeVideoUrl,
  parseRequestedFormat,
  safeFileName,
  streamYouTubeServer,
} from "../_lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const FILE_SEPARATOR = "\n---STREAMLINE-FILE---\n";

function getYouTubeContentType(extension, format) {
  const ext = String(extension || "").toLowerCase();
  if (format === "audio" || ["mp3", "m4a", "aac", "ogg", "opus"].includes(ext)) {
    const audioTypes = {
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      aac: "audio/aac",
      ogg: "audio/ogg",
      opus: "audio/ogg",
      webm: "audio/webm",
    };
    return audioTypes[ext] || "audio/mpeg";
  }
  return ext === "webm" ? "video/webm" : "video/mp4";
}

function progressHeaders() {
  return {
    "Content-Type": "application/octet-stream",
    "X-Streamline-Protocol": "v1",
    "Cache-Control": "no-store",
  };
}

export async function GET(request) {
  const url = request.nextUrl.searchParams.get("url");
  const format = request.nextUrl.searchParams.get("format") || "best";
  if (!url) return NextResponse.json({ error: "A video URL is required." }, { status: 400 });

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !isAuthorizedHost(parsed.hostname)) {
      return NextResponse.json({ error: "Downloads are available only for supported HTTPS video links." }, { status: 403 });
    }

    const encoder = new TextEncoder();
    const sendJson = (controller, payload) => {
      controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
    };

    if (isYouTubeHost(parsed.hostname)) {
      if (!isYouTubeVideoUrl(parsed) || !parseRequestedFormat(format)) {
        return NextResponse.json({ error: "Choose a YouTube video link and a valid format." }, { status: 400 });
      }

      if (isServerlessRuntime()) {
        const result = await streamYouTubeServer(url, format);
        const headers = {
          "Content-Type": result.contentType || getYouTubeContentType(result.extension, format),
          "Content-Disposition": `attachment; filename="${(result.filename || safeFileName("youtube-video", result.extension)).replace(/"/g, "")}"`,
          "Cache-Control": "no-store",
        };
        if (result.size) headers["Content-Length"] = String(result.size);
        return new Response(result.stream, { status: 200, headers });
      }

      const stream = new ReadableStream({
        async start(controller) {
          try {
            sendJson(controller, { type: "progress", percent: 1, phase: "starting" });
            const result = await downloadYouTube(url, format, {
              onProgress: (progress) => sendJson(controller, { type: "progress", ...progress }),
            });
            const downloadName = result.filename ? result.filename.replace(/"/g, "") : safeFileName("youtube-video", result.extension);
            sendJson(controller, {
              type: "file",
              filename: downloadName,
              contentType: getYouTubeContentType(result.extension, format),
              size: result.size || 0,
            });
            controller.enqueue(encoder.encode(FILE_SEPARATOR));

            const reader = result.stream.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          } catch (error) {
            console.error("Media download failed:", error);
            try {
              sendJson(controller, { type: "error", error: error.message || "Unable to download this media file right now." });
              controller.close();
            } catch {
              controller.error(error);
            }
          }
        },
      });

      return new Response(stream, { status: 200, headers: progressHeaders() });
    }

    if (!isDirectMediaUrl(parsed)) {
      return NextResponse.json({ error: "Downloads are available only for YouTube links or direct media URLs." }, { status: 403 });
    }

    const upstream = await fetch(parsed.toString(), {
      headers: { Accept: "video/*,audio/*" },
      redirect: "follow",
    });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: "The video host could not provide this file. Check the link and try again." }, { status: 502 });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    if (!contentType.startsWith("video/") && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
      return NextResponse.json({ error: "That link does not point to a downloadable media file." }, { status: 415 });
    }

    const extension = parsed.pathname.split(".").pop().toLowerCase();
    const size = Number(upstream.headers.get("content-length") || 0);
    const fileStream = new ReadableStream({
      async start(controller) {
        try {
          sendJson(controller, { type: "progress", percent: 1, phase: "downloading" });
          sendJson(controller, {
            type: "file",
            filename: `video.${extension}`,
            contentType,
            size,
          });
          controller.enqueue(encoder.encode(FILE_SEPARATOR));

          const reader = upstream.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          try {
            sendJson(controller, { type: "error", error: error.message || "Unable to download this media file right now." });
            controller.close();
          } catch {
            controller.error(error);
          }
        }
      },
    });

    return new Response(fileStream, { status: 200, headers: progressHeaders() });
  } catch (error) {
    console.error("Media download failed:", error);
    return NextResponse.json(
      { error: error.message || "Unable to download this media file right now." },
      { status: 502 },
    );
  }
}
