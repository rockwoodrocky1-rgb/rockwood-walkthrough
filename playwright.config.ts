import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8791",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
    permissions: ["camera", "microphone"],
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx next start --hostname 127.0.0.1 --port 8791",
    url: "http://127.0.0.1:8791",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
