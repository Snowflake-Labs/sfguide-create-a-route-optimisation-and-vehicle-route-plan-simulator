import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  devIndicators: false,
  output: 'standalone',
  // Compile the shared UI kit (linked via a file: dependency) through Next's own
  // pipeline. Paired with webpack resolve.symlinks=false below so the kit's
  // peer-dep imports (@deck.gl/*, h3-js) resolve to the CONSUMER's single copy
  // (the kit is symlinked into node_modules; without this they'd resolve from the
  // kit's realpath tree where deck.gl is not hoisted, yielding a duplicate deck.gl
  // instance that silently breaks map rendering). See APP_RESTRUCTURE_PLAN R1.2.
  transpilePackages: ['@fleet-kit/core'],
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.symlinks = false;
    return config;
  },
};

export default nextConfig;
