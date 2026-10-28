export function getYouTubeVideoId(url) {
  const parsed = url instanceof URL ? url : new URL(String(url));
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be") {
    return parsed.pathname.replace("/", "").split("/")[0] || "";
  }
  const fromQuery = parsed.searchParams.get("v");
  if (fromQuery) return fromQuery;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] && ["shorts", "embed", "live", "v"].includes(parts[0])) {
    return parts[1] || "";
  }
  return "";
}

export function qualityLabel(height) {
  if (height >= 2160) return `${height}p 4K`;
  if (height >= 1440) return `${height}p QHD`;
  if (height >= 1080) return `${height}p Full HD`;
  if (height >= 720) return `${height}p HD`;
  return `${height}p`;
}

export function safeFileName(title, extension) {
  const base =
    String(title || "youtube-video")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "youtube-video";
  return `${base}.${extension}`;
}

export function parseRequestedFormat(formatId) {
  if (!formatId || formatId === "best") return { kind: "best" };
  if (formatId === "audio") return { kind: "audio" };
  const match = /^(\d{3,4})p$/.exec(formatId);
  if (!match) return null;
  return { kind: "height", height: Number(match[1]) };
}
