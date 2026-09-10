import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pins the workspace root to this directory. Without this, Turbopack's
  // root-detection walks up the filesystem looking for a lockfile and can
  // land on an unrelated package-lock.json above this repo (e.g. one in a
  // developer's home directory), producing a spurious
  // "ignored package-lock.json ... outside the current Git repository"
  // warning at build time.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
