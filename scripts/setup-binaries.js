const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");

const BIN_DIR = path.join(__dirname, "..", "bin");
const IS_VERCEL = Boolean(process.env.VERCEL);
const YT_DLP_NAME = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
const YT_DLP_URL =
  process.platform === "win32"
    ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (target) => {
      https
        .get(target, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            request(response.headers.location);
            return;
          }
          if (response.statusCode !== 200) {
            file.close();
            fs.unlink(dest, () => {});
            reject(new Error(`Failed to download ${target} (${response.statusCode})`));
            return;
          }
          response.pipe(file);
          file.on("finish", () => file.close(resolve));
        })
        .on("error", (error) => {
          file.close();
          fs.unlink(dest, () => {});
          reject(error);
        });
    };
    request(url);
  });
}

async function ensureYtDlp() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const dest = path.join(BIN_DIR, YT_DLP_NAME);
  process.stdout.write(`Downloading ${YT_DLP_NAME} for ${process.platform}...\n`);
  await download(YT_DLP_URL, dest);
  if (process.platform !== "win32") fs.chmodSync(dest, 0o755);
  process.stdout.write(`Saved ${dest}\n`);
}

function tryInstallFfmpeg() {
  if (IS_VERCEL || process.platform !== "win32") {
    process.stdout.write("Using ffmpeg-static for FFmpeg on this platform.\n");
    return;
  }
  process.stdout.write("Installing FFmpeg with winget (needed for HD/4K merges)...\n");
  const result = spawnSync(
    "winget",
    [
      "install",
      "--id",
      "Gyan.FFmpeg",
      "-e",
      "--disable-interactivity",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.status !== 0) {
    process.stdout.write("FFmpeg install skipped or failed. 360p/720p progressive downloads can still work.\n");
  }
}

(async () => {
  try {
    await ensureYtDlp();
  } catch (error) {
    console.error(error.message || error);
    if (IS_VERCEL) {
      process.stdout.write("Continuing Vercel build without yt-dlp; Innertube will be used instead.\n");
    } else {
      process.exit(1);
    }
  }
  tryInstallFfmpeg();
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
