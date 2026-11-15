// Two modes are tested:
// - external (recommended): got-api-engine and got are loaded by Node at runtime;
// - bundled (GAE_BUNDLE=1): Next bundles them into the server build.
// The option was renamed in Next 15; the runner passes the major version.
const major = Number(process.env.NEXT_MAJOR ?? "15");
const external = ["got-api-engine", "got"];

/** @type {import('next').NextConfig} */
const config =
  process.env.GAE_BUNDLE === "1"
    ? {}
    : major >= 15
      ? { serverExternalPackages: external }
      : { experimental: { serverComponentsExternalPackages: external } };

export default config;
