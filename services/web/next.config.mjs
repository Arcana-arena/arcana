/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Nothing here is a static site. Every page reads live numbers, and a page
  // that silently served a cached 3-hour-old score would be the same class of
  // lie this codebase keeps removing — so the data layer opts out of caching
  // explicitly (see src/lib/api.ts) rather than relying on a default.
  poweredByHeader: false,
  output: 'standalone',
};

export default nextConfig;
