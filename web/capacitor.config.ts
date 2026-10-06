import type { CapacitorConfig } from "@capacitor/core";

// No native code yet — the parent will run `npx cap add android` / `cap sync`
// when the native shell is needed. The web build (dist/) is already
// Capacitor-ready thanks to HashRouter (works over file://).
const config: CapacitorConfig = {
  appId: "com.obulu.app",
  appName: "OBULU",
  webDir: "dist",
};

export default config;
