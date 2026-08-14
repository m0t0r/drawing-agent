import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  cacheComponents: true,
  // Both shared packages ship TypeScript source rather than build output.
  transpilePackages: ["@repo/agent", "@repo/design-system"],
};

export default nextConfig;
