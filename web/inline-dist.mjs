/**
 * inline-dist.mjs — post-processes the Vite build into a SINGLE index.html
 * with the main JS + CSS inlined.
 *
 * Why: the Android WebView loads the app from file:///android_asset/.
 * ES module <script src> + <link> subresource fetches from file:// URLs
 * are unreliable in WebView (opaque origin / CORS). A single self-contained
 * index.html has zero subresource fetches, so it renders everywhere.
 *
 * Code-split lazy chunks (e.g. the AI assistant panel) are left as separate
 * files under assets/: they load on demand over https (Render web). The
 * offline Android build does not use them.
 *
 * Usage: node inline-dist.mjs   (run after `vite build`)
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const DIST = new URL("./dist/", import.meta.url).pathname;

let html = readFileSync(join(DIST, "index.html"), "utf8");

// Find the entry script referenced by the HTML — not just the first .js
// file, because code-split chunks share the assets dir.
const scriptMatch = html.match(
  /<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/
);
if (!scriptMatch) throw new Error("entry script tag not found");
const jsFile = basename(scriptMatch[1]);

const cssMatch = html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
if (!cssMatch) throw new Error("stylesheet link not found");
const cssFile = basename(cssMatch[1]);

const js = readFileSync(join(DIST, "assets", jsFile), "utf8");
const css = readFileSync(join(DIST, "assets", cssFile), "utf8");
if (js.includes("</script") || css.includes("</style"))
  throw new Error("unsafe inline sequence found");

// The entry bundle is inlined into index.html, so relative dynamic-import
// URLs ("./Chunk-hash.js") would resolve against the document instead of
// /assets/. Rewrite code-split chunk references to absolute /assets/ paths
// so the lazy chunks load on the https deployment.
let inlinedJs = js;
for (const f of readdirSync(join(DIST, "assets"))) {
  if (f.endsWith(".js") && f !== jsFile) {
    inlinedJs = inlinedJs.split(`"./${f}"`).join(`"/assets/${f}"`);
    inlinedJs = inlinedJs.split(`'./${f}'`).join(`'/assets/${f}'`);
  }
}
if (inlinedJs.includes("</script"))
  throw new Error("unsafe inline sequence found");

html = html.replace(
  /<script type="module"[^>]*><\/script>/,
  () => `<script type="module">\n${inlinedJs}\n</script>`
);
html = html.replace(
  /<link rel="stylesheet"[^>]*>/,
  () => `<style>\n${css}\n</style>`
);

writeFileSync(join(DIST, "index.html"), html);
console.log(
  `inlined ${jsFile} (${(js.length / 1024).toFixed(0)}KB) + ${cssFile} (${(css.length / 1024).toFixed(0)}KB) into index.html`
);
