import type { NextConfig } from "next";

// Dev mode only hydrates pages for hosts it knows. Opening the app by another
// name (a LAN hostname, a reverse proxy's domain) needs it listed in
// POLYREADER_DEV_ORIGINS, comma-separated, e.g. in .env.local.
const devOrigins = (process.env.POLYREADER_DEV_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  devIndicators: false,
  allowedDevOrigins: ["127.0.0.1", ...devOrigins],
};

export default nextConfig;
