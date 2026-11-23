import type { NextConfig } from "next";
const config: NextConfig = {
  distDir: process.env.QA_DIST_DIR || ".next",
  outputFileTracingIncludes: {
    "/api/check-documents": ["./assets/workbook-templates/**/*"],
  },
};
export default config;
