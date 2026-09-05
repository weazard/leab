import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep 7-Zip WASM out of the bundler so Node/Wasmer/OpenNext can load 7zz.wasm from disk.
  serverExternalPackages: ["7z-wasm"],
};

export default nextConfig;
