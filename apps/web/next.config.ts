import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  cacheComponents: true,
  // @repo/design-system ships TypeScript source rather than build output.
  transpilePackages: ["@repo/design-system"],
};

export default nextConfig;
