/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Keep OTEL out of the vendor-chunk splitter. `@opentelemetry/api` is a
  // transitive optional dep of Next.js itself (tracing); when webpack tries to
  // split it into `.next/server/vendor-chunks/@opentelemetry.js` during
  // `next dev`, a partial write can leave the runtime manifest pointing at a
  // chunk file that was never emitted → "Cannot find module ...@opentelemetry.js"
  // 500 on every page. Marking it external makes it a plain Node `require` at
  // runtime — no chunk, no race, no bundle bloat.
  experimental: {
    serverComponentsExternalPackages: ['@opentelemetry/api'],
  },
  webpack: (config) => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    return config;
  },
  // Physical route rename with backwards-compatible rewrites. Legacy
  // `/marketplace` and `/studio` continue to render the moved pages so
  // external inbound links (blog posts, tweets, docs) keep working.
  async rewrites() {
    return [
      { source: '/marketplace', destination: '/browse' },
      { source: '/marketplace/:path*', destination: '/browse/:path*' },
      { source: '/studio', destination: '/publish' },
      { source: '/studio/:path*', destination: '/publish/:path*' },
    ];
  },
};

export default config;
