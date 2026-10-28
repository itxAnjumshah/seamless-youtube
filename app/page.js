"use client";

import { useState } from "react";

const initialForm = { url: "" };
const FILE_SEPARATOR = "\n---STREAMLINE-FILE---\n";

function formatDuration(seconds) {
  if (!seconds) return "—";
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function indexOfBytes(haystack, needle) {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let cursor = 0; cursor < needle.length; cursor += 1) {
      if (haystack[index + cursor] !== needle[cursor]) continue outer;
    }
    return index;
  }
  return -1;
}

function triggerBrowserDownload(href, filename) {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function readProgressDownload(response, onProgress) {
  if (!response.body) {
    const blob = await response.blob();
    onProgress(100, "done");
    return { blob, filename: null };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const separatorBytes = new TextEncoder().encode(FILE_SEPARATOR);
  let headerBuffer = new Uint8Array();
  let headerDone = false;
  let leftoverText = "";
  let filename = null;
  let contentType = "application/octet-stream";
  let expectedSize = 0;
  const fileChunks = [];
  let received = 0;

  const handleHeaderLine = (line) => {
    if (!line) return null;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return null;
    }
    if (message.type === "error") throw new Error(message.error || "Unable to download this video.");
    if (message.type === "progress") onProgress(Number(message.percent) || 0, message.phase || "downloading");
    if (message.type === "direct") return message;
    if (message.type === "file") {
      filename = message.filename || filename;
      contentType = message.contentType || contentType;
      expectedSize = Number(message.size) || 0;
    }
    return null;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (!headerDone) {
      headerBuffer = concatBytes([headerBuffer, value]);
      const separatorIndex = indexOfBytes(headerBuffer, separatorBytes);
      const headerText = decoder.decode(separatorIndex === -1 ? headerBuffer : headerBuffer.slice(0, separatorIndex));
      const lines = `${leftoverText}${headerText}`.split("\n");
      leftoverText = separatorIndex === -1 ? lines.pop() || "" : "";
      for (const line of lines) {
        const direct = handleHeaderLine(line.trim());
        if (direct?.url) return { direct };
      }

      if (separatorIndex === -1) continue;

      headerDone = true;
      const rest = headerBuffer.slice(separatorIndex + separatorBytes.length);
      headerBuffer = new Uint8Array();
      if (rest.byteLength) {
        fileChunks.push(rest);
        received += rest.byteLength;
        if (expectedSize) onProgress(Math.min(99, Math.round((received / expectedSize) * 100)), "sending");
      }
      continue;
    }

    fileChunks.push(value);
    received += value.byteLength;
    if (expectedSize) {
      onProgress(Math.min(99, Math.round((received / expectedSize) * 100)), "sending");
    }
  }

  if (!headerDone) {
    const lines = `${leftoverText}${decoder.decode(headerBuffer)}`.split("\n");
    for (const line of lines) {
      const direct = handleHeaderLine(line.trim());
      if (direct?.url) return { direct };
    }
  }

  onProgress(100, "done");
  return {
    blob: new Blob(fileChunks, { type: contentType }),
    filename,
  };
}

export default function Home() {
  const [form, setForm] = useState(initialForm);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [downloadingFormat, setDownloadingFormat] = useState("");
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadPhase, setDownloadPhase] = useState("");
  const [loading, setLoading] = useState(false);

  async function analyzeVideo(event) {
    event.preventDefault();
    setError("");
    setDownloadError("");
    setResult(null);
    setLoading(true);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: form.url }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to analyze this video.");
      setResult(data);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setForm(initialForm);
    setResult(null);
    setError("");
    setDownloadError("");
    setDownloadingFormat("");
    setDownloadPercent(0);
    setDownloadPhase("");
  }

  async function downloadVideo(format) {
    if (!result || !format.available) return;

    setDownloadError("");
    setDownloadingFormat(format.id);
    setDownloadPercent(1);
    setDownloadPhase("starting");
    try {
      const response = await fetch(
        `/api/download?url=${encodeURIComponent(result.url)}&format=${encodeURIComponent(format.id)}`,
      );
      const protocol = response.headers.get("X-Streamline-Protocol");
      const contentType = response.headers.get("Content-Type") || "";

      if (!response.ok) {
        let message = "Unable to download this video.";
        try {
          const data = await response.json();
          message = data.error || message;
        } catch {
          // Keep the user-facing fallback for non-JSON upstream failures.
        }
        throw new Error(message);
      }

      if (contentType.includes("application/json")) {
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        if (data.mode === "direct" && data.url) {
          setDownloadPercent(100);
          setDownloadPhase("done");
          window.open(data.url, "_blank", "noopener,noreferrer");
          return;
        }
        throw new Error("Unable to download this video.");
      }

      if (protocol === "v1") {
        const payload = await readProgressDownload(response, (percent, phase) => {
          setDownloadPercent(percent);
          setDownloadPhase(phase);
        });
        if (payload.direct?.url) {
          triggerBrowserDownload(payload.direct.url, payload.direct.filename || `${result.title || "video"}.${format.extension.toLowerCase()}`);
          return;
        }
        const downloadUrl = URL.createObjectURL(payload.blob);
        triggerBrowserDownload(downloadUrl, payload.filename || `${result.title || "video"}.${format.extension.toLowerCase()}`);
        URL.revokeObjectURL(downloadUrl);
        return;
      }

      const total = Number(response.headers.get("Content-Length")) || 0;
      if (!response.body) {
        const blob = await response.blob();
        const downloadUrl = URL.createObjectURL(blob);
        const headerName = response.headers.get("Content-Disposition")?.match(/filename="?([^"]+)"?/i)?.[1];
        triggerBrowserDownload(downloadUrl, headerName || `${result.title || "video"}.${format.extension.toLowerCase()}`);
        URL.revokeObjectURL(downloadUrl);
        setDownloadPercent(100);
        return;
      }

      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        setDownloadPercent(total ? Math.min(99, Math.round((received / total) * 100)) : Math.min(95, 10 + Math.round(received / 250000)));
        setDownloadPhase("downloading");
      }
      const blob = new Blob(chunks);
      const downloadUrl = URL.createObjectURL(blob);
      const headerName = response.headers.get("Content-Disposition")?.match(/filename="?([^"]+)"?/i)?.[1];
      triggerBrowserDownload(downloadUrl, headerName || `${result.title || "video"}.${format.extension.toLowerCase()}`);
      URL.revokeObjectURL(downloadUrl);
      setDownloadPercent(100);
      setDownloadPhase("done");
    } catch (downloadRequestError) {
      setDownloadError(downloadRequestError.message);
    } finally {
      setDownloadingFormat("");
      setDownloadPhase("");
    }
  }

  const progressLabel = {
    starting: "Preparing download",
    downloading: "Downloading",
    processing: "Processing video",
    sending: "Saving file",
    done: "Download complete",
  }[downloadPhase] || "Downloading";

  return (
    <main>
      <nav className="nav container">
        <a className="brand" href="/" aria-label="Streamline home">
          <span className="brand-mark">S</span>
          <span>streamline</span>
        </a>
        <span className="nav-caption">Simple video downloads</span>
      </nav>

      <section className="hero container">
        <div className="eyebrow"><span className="eyebrow-dot" /> Simple. Fast. Responsible.</div>
        <h1>Keep the moments<br /><em>that matter.</em></h1>
        <p className="hero-copy">
          Paste a YouTube video, Shorts, or replay link, choose a quality, and download it.
        </p>

        <form className="analyzer-card" onSubmit={analyzeVideo}>
          <label htmlFor="video-url">Paste a video link to get started</label>
          <div className="input-row">
            <div className="url-input-wrap">
              <span className="link-icon" aria-hidden="true">⌁</span>
              <input
                id="video-url"
                type="url"
                placeholder="https://www.youtube.com/watch?v=..."
                value={form.url}
                onChange={(event) => setForm({ url: event.target.value })}
                required
                aria-describedby={error ? "form-error" : undefined}
              />
              {form.url && <button className="clear-button" type="button" onClick={reset} aria-label="Clear URL">×</button>}
            </div>
            <button className="primary-button" type="submit" disabled={loading}>
              {loading ? <><span className="spinner" /> Analyzing</> : <>Analyze video <span>→</span></>}
            </button>
          </div>
          {error && <p className="error-message" id="form-error"><span>!</span>{error}</p>}
          <p className="legal-note"><span>✓</span> Supports YouTube videos, Shorts, embeds, live replays, and direct MP4/WebM files.</p>
        </form>

        {result && (
          <section className="results" aria-live="polite">
            <div className="results-heading">
              <div>
                <div className="eyebrow"><span className="eyebrow-dot" /> Video found</div>
                <h2>{result.title}</h2>
                <p className="muted">{result.provider} <span>•</span> {formatDuration(result.duration)}</p>
              </div>
              <span className="authorized-badge"><span>✓</span> Link recognized</span>
            </div>
            <div className="preview-grid">
              <div className="video-preview">
                {result.thumbnail ? <img src={result.thumbnail} alt="" /> : <div className="preview-unavailable">Preview unavailable</div>}
                {result.thumbnail && <div className="preview-overlay"><span className="play-icon">▶</span></div>}
              </div>
              <div className="download-panel">
                <div className="panel-title">Choose a format</div>
                <p className="muted">Select the quality that works best for you.</p>
                <div className="format-list">
                  {result.formats.map((format) => (
                    <button
                      type="button"
                      className={`format-option ${format.available ? "" : "disabled"} ${downloadingFormat === format.id ? "downloading" : ""}`}
                      key={format.id}
                      onClick={() => downloadVideo(format)}
                      disabled={!format.available || Boolean(downloadingFormat)}
                      aria-label={format.available ? `Download ${format.label}` : `${format.label} unavailable`}
                    >
                      <span className="format-icon">{format.type === "video" ? "▣" : "♫"}</span>
                      <span className="format-detail"><strong>{format.label}</strong><small>{format.extension} · {format.size}</small></span>
                      <span className="format-action">
                        {downloadingFormat === format.id ? `${Math.max(1, downloadPercent)}%` : format.available ? "↓" : "—"}
                      </span>
                    </button>
                  ))}
                </div>
                {downloadingFormat && (
                  <div className="download-progress" role="status" aria-live="polite">
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${Math.max(1, downloadPercent)}%` }} />
                    </div>
                    <p className="progress-label">{progressLabel} · {Math.max(1, downloadPercent)}%</p>
                  </div>
                )}
                {downloadError && <p className="error-message download-error" role="alert"><span>!</span>{downloadError}</p>}
                {!result.downloadsAvailable && <p className="availability-note">{result.availabilityMessage}</p>}
              </div>
            </div>
          </section>
        )}
      </section>

      <footer className="footer container"><span>© 2025 Streamline</span><span>Only download content you have permission to use.</span></footer>
    </main>
  );
}
