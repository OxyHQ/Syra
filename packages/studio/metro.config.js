const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Explicitly set projectRoot
config.projectRoot = projectRoot;

// CRITICAL: Watch the studio package and shared-types so Metro can resolve
// the workspace packages it imports.
config.watchFolders = [
  projectRoot,
  path.join(monorepoRoot, 'packages/shared-types'),
];

// Helper to create block patterns
const blockPath = (dir) => {
  const resolved = path.resolve(dir);
  return new RegExp(`${resolved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*`);
};

config.resolver = {
  ...config.resolver,
  blockList: [
    // Block sibling packages we don't bundle from this app
    blockPath(path.join(monorepoRoot, 'packages/backend')),
    blockPath(path.join(monorepoRoot, 'packages/frontend')),
    blockPath(path.join(monorepoRoot, 'packages/shared-types/src')),
    blockPath(path.join(monorepoRoot, 'docs')),
    // Block ALL generated/cache directories - these cause infinite loops
    /\.expo\/.*/,
    /\.expo-shared\/.*/,
    /\.metro\/.*/,
    /\.cache\/.*/,
    /node_modules\/\.cache\/.*/,
    /\.tsbuildinfo$/,
    // Block .expo/types specifically to avoid infinite loops with typedRoutes
    /.*\.expo\/types\/.*/,
    // Block test files
    /__tests__\/.*/,
    /\.test\.(js|ts|tsx|jsx)$/,
    /\.spec\.(js|ts|tsx|jsx)$/,
    // Block documentation files
    /\.md$/,
    /README/,
    // Block source maps in production (they can be large)
    /\.map$/,
  ],
  extraNodeModules: {
    '@syra/shared-types': path.join(monorepoRoot, 'packages/shared-types'),
  },
  // Resolve from studio node_modules first, then root (for workspaces)
  nodeModulesPaths: [
    path.join(projectRoot, 'node_modules'),
    path.join(monorepoRoot, 'node_modules'),
  ],
  // Enable symlinks for workspace package resolution
  unstable_enableSymlinks: true,
  // Enable package.json "exports" field resolution (required by @oxyhq/bloom subpath exports)
  unstable_enablePackageExports: true,
  sourceExts: [...config.resolver.sourceExts, 'ts', 'tsx'],
  // Bloom bundles its font system by importing `.woff2`/`.woff` files directly from JS.
  // When Metro bundles for web (`bundler: "metro"` in app.config.js) it picks the web
  // font-face module, which has module-level `.woff2` imports. Metro does not include
  // `.woff2` in default `assetExts`, so register them here as static assets.
  assetExts: [...config.resolver.assetExts, 'wasm', 'woff2', 'woff'],
};

module.exports = withNativeWind(config, {
  inlineRem: 16,
  inlineVariables: false,
});
