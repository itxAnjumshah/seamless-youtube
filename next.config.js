const binaryTrace = ["./bin/**/*"];

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["ffmpeg-static", "youtubei.js"],
    outputFileTracingIncludes: {
      "/api/analyze": binaryTrace,
      "/api/download": binaryTrace,
    },
    outputFileTracingExcludes: {
      "/api/analyze": ["./node_modules/ffmpeg-static/**/*"],
      "/api/download": ["./node_modules/ffmpeg-static/**/*"],
    },
  },
};

module.exports = nextConfig;
