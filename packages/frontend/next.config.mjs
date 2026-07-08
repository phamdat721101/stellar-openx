/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  webpack: (config) => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    return config;
  },
  // PRD-U (2026-07-08) — physical route rename with backwards-compatible
  // rewrites. Legacy `/marketplace` and `/studio` continue to render the
  // moved pages so external inbound links (blog posts, tweets, docs) keep
  // working. Rewrites are stable across the FEATURE_UI_V2 flag.
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
