/**
 * inline-dist.mjs — post-processes the Vite build into a SINGLE index.html
 * with JS + CSS inlined.
 *
 * Why: the Android WebView loads the app from file:///android_asset/.
 * ES module <script src> + <link> subresource fetches from file:// URLs
 * are unreliable in WebView (opaque origin / CORS). A single self-contained
 * index.html has zero subresource fetches, so it renders everywhere.
 *
 * Usage: node inline-dist.mjs   (run after `vite build`)
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("./dist/", import.meta.url).pathname;

const assets = readdirSync(join(DIST, "assets"));
const jsFile = assets.find((f) => f.endsWith(".js"));
const cssFile = assets.find((f) => f.endsWith(".css"));
if (!jsFile || !cssFile) throw new Error("build assets not found");

const js = readFileSync(join(DIST, "assets", jsFile), "utf8");
const css = readFileSync(join(DIST, "assets", cssFile), "utf8");
if (js.includes("</script") || css.includes("</style"))
  throw new Error("unsafe inline sequence found");

let html = readFileSync(join(DIST, "index.html"), "utf8");
html = html.replace(
  /<script type="module"[^>]*><\/script>/,
  () => `<script type="module">\n${js}\n</script>`
);
html = html.replace(
  /<link rel="stylesheet"[^>]*>/,
  () => `<style>\n${css}\n</style>`
);

writeFileSync(join(DIST, "index.html"), html);
console.log(`inlined ${jsFile} (${(js.length / 1024).toFixed(0)}KB) + ${cssFile} (${(css.length / 1024).toFixed(0)}KB) into index.html`);
