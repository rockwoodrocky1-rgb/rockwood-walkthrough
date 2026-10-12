import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: ["pdf-lib", "@pdf-lib/fontkit", "nodemailer"],
  turbopack: { root: process.cwd() },
  outputFileTracingIncludes: {
    "/api/deliveries": [
      "./server/assets/*",
      "./public/brand/rockwood-logo.png",
    ],
    "/api/cron/report-deliveries": [
      "./server/assets/*",
      "./public/brand/rockwood-logo.png",
    ],
  },
};
export default config;
