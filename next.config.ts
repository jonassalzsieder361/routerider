import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev only: lets a phone on the local network load the dev server's JS (real-device testing,
  // Phase 9). Next 16 blocks dev assets for any hostname other than localhost by default.
  allowedDevOrigins: ["192.168.2.35"],
};

export default nextConfig;
