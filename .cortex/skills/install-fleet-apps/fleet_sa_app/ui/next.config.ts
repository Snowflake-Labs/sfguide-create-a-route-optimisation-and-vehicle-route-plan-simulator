import type { NextConfig } from 'next';
import path from 'node:path';

// deck.gl / luma.gl MUST resolve to a single physical copy in the bundle. The
// @fleet-kit/core package is symlinked via a file: dependency and carries its
// own nested node_modules (its devDependencies install @deck.gl/* and the
// transitive @luma.gl/*). With resolve.symlinks=false the kit's imports resolve
// from its realpath tree, picking up that nested duplicate. Two copies of
// @luma.gl/shadertools means two ShaderAssembler singletons: deck.gl registers
// the DECKGL_FILTER_* shader hooks on one instance while layer Models compile
// against the other, so every map fails with
// "DECKGL_FILTER_COLOR : no matching overloaded function found".
// Aliasing each shared GPU package to the CONSUMER app's own node_modules
// collapses both copies to one and is authoritative over symlink resolution.
const SHARED_GPU_PACKAGES = [
  '@luma.gl/core',
  '@luma.gl/engine',
  '@luma.gl/webgl',
  '@luma.gl/shadertools',
  '@luma.gl/constants',
  '@luma.gl/gltf',
  '@deck.gl/core',
  '@deck.gl/layers',
  '@deck.gl/geo-layers',
  '@deck.gl/aggregation-layers',
  '@deck.gl/mesh-layers',
  '@deck.gl/react',
  '@deck.gl/extensions',
  '@deck.gl/widgets',
];

const nextConfig: NextConfig = {
  devIndicators: false,
  output: 'standalone',
  // Compile the shared UI kit (linked via a file: dependency) through Next's own
  // pipeline. Paired with webpack resolve.symlinks=false below so the kit's
  // peer-dep imports (@deck.gl/*, h3-js) resolve to the CONSUMER's single copy
  // (the kit is symlinked into node_modules; without this they'd resolve from the
  // kit's realpath tree where deck.gl is not hoisted, yielding a duplicate deck.gl
  // instance that silently breaks map rendering).
  transpilePackages: ['@fleet-kit/core'],
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.symlinks = false;
    // Force every shared deck.gl/luma.gl package to the consumer's single
    // physical copy (cwd during `next build` is this ui/ dir). This is the
    // load-bearing dedup; it overrides the nested copy under the symlinked kit.
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      ...Object.fromEntries(
        SHARED_GPU_PACKAGES.map((pkg) => [
          pkg,
          path.resolve(process.cwd(), 'node_modules', pkg),
        ]),
      ),
    };
    return config;
  },
};

export default nextConfig;
