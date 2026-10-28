const BUILT_IN_HOSTS = new Set([
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "vimeo.com",
  "dailymotion.com",
]);

const MEDIA_EXTENSION_PATTERN = /\.(mp4|webm|mov|m4v)$/i;

export function getAuthorizedHosts() {
  const customHosts = (process.env.AUTHORIZED_VIDEO_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...BUILT_IN_HOSTS, ...customHosts]);
}

export function isAuthorizedHost(hostname) {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return [...getAuthorizedHosts()].some(
    (host) => normalizedHostname === host || normalizedHostname.endsWith(`.${host}`),
  );
}

export function isDirectMediaUrl(url) {
  return MEDIA_EXTENSION_PATTERN.test(url.pathname);
}

export function isYouTubeHost(hostname) {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return (
    normalizedHostname === "youtu.be" ||
    normalizedHostname === "youtube.com" ||
    normalizedHostname.endsWith(".youtube.com") ||
    normalizedHostname === "youtube-nocookie.com"
  );
}

export function getProvider(hostname) {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "");
  if (normalizedHostname.includes("vimeo")) return "Vimeo";
  if (normalizedHostname.includes("dailymotion")) return "Dailymotion";
  if (isYouTubeHost(hostname)) return "YouTube";
  return "Authorized source";
}
