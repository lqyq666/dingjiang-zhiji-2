import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  async rewrites() {
    // The production reverse proxy owns /api. Never bake a server or employee's
    // loopback address into the browser bundle. Dev gets a same-origin proxy too.
    return process.env.NODE_ENV === "development"
      ? [
          {
            source: "/api/:path*",
            destination: "http://127.0.0.1:3001/api/:path*",
          },
        ]
      : [];
  },
};
export default nextConfig;
