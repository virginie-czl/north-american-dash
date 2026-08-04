/**
 * HTML to PDF, in the engine the documents were designed for (server-only).
 *
 * Chromium via puppeteer-core. Two earlier attempts are worth recording, because both
 * looked reasonable:
 *
 *  - WeasyPrint. There is no Python on Vercel's Node runtime, so it failed with
 *    "renderer not found" and would only have failed with "python3 not found" once the
 *    script was committed. It also needed workarounds the browser does not: a
 *    `white-space: nowrap` on every heading because its flex implementation shrinks a
 *    heading below its own content, and a renderer-level stylesheet for the paper size.
 *  - A printable route the reader printed by hand. Exact fidelity, but a button reading
 *    "Download statement" that opens a tab and raises a dialog does not do what it says.
 *
 * `puppeteer-core` rather than `puppeteer`: the full package bundles its own Chromium
 * and would take the function past the deployment size limit. The binary comes from
 * @sparticuz/chromium, which ships it Brotli-compressed and expands it into /tmp on
 * first use — hence a cold start of a second or two, which is why the buttons show
 * progress rather than pretending the wait is not happening.
 */
import type { Browser } from "puppeteer-core";

/**
 * One browser per warm instance.
 *
 * Kept on globalThis rather than in a module variable: the server bundle can hold more
 * than one copy of this module, and a per-copy singleton would launch a second Chromium
 * — the expensive thing this exists to avoid.
 */
const BROWSER = Symbol.for("naboo.tracker.pdfBrowser");
type BrowserHost = { [BROWSER]?: Promise<Browser> | null };

/** Set locally to a system Chromium; unset in production, where @sparticuz provides it. */
function localExecutable(): string | null {
  return process.env.CHROMIUM_EXECUTABLE_PATH?.trim() || null;
}

async function launch(): Promise<Browser> {
  const puppeteer = await import("puppeteer-core");
  const local = localExecutable();
  if (local) {
    // Development only. CHROMIUM_LAUNCH_ARGS exists because a dev container may sit
    // behind an outbound proxy that Chromium has to be told about; production takes
    // neither variable and launches with the package's own args below.
    const extra = (process.env.CHROMIUM_LAUNCH_ARGS ?? "").split(",").filter(Boolean);
    return puppeteer.launch({
      executablePath: local,
      // No sandbox: the container already is one, and the renderer only ever loads
      // markup this server produced.
      args: ["--no-sandbox", "--disable-dev-shm-usage", ...extra],
    });
  }
  // The args and the path come from the package — they encode which flags this
  // particular build needs on this particular runtime, and hardcoding them is how a
  // working deploy breaks on the next Chromium bump.
  const chromium = (await import("@sparticuz/chromium")).default;
  return puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(await brotliBinDir()),
    headless: true,
  });
}

/**
 * Where the Brotli-packed binaries live in the deployment.
 *
 * Only the package's JavaScript is bundled — nitro inlines the module and leaves its
 * ~65 MB `bin/` behind, so the default location does not exist in the built function.
 * scripts/copy-chromium-bin.mjs puts the payload beside the function as `chromium-bin/`
 * and this points at it; `undefined` falls back to the package's own default, which is
 * the right answer when node_modules is intact (locally, or in a test).
 */
async function brotliBinDir(): Promise<string | undefined> {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const candidates = [
    process.env.CHROMIUM_BIN_PATH,
    join(process.cwd(), "chromium-bin"),
    join(process.cwd(), "node_modules/@sparticuz/chromium/bin"),
  ].filter((dir): dir is string => Boolean(dir));
  return candidates.find((dir) => existsSync(dir));
}

async function browser(): Promise<Browser> {
  const host = globalThis as BrowserHost;
  if (!host[BROWSER]) {
    host[BROWSER] = launch().catch((error) => {
      // Let the next request try again rather than caching a dead launch forever.
      host[BROWSER] = null;
      throw error;
    });
  }
  const instance = await host[BROWSER];
  // A crashed or disconnected browser survives as a resolved promise; relaunch.
  if (!instance.connected) {
    host[BROWSER] = null;
    return browser();
  }
  return instance;
}

/**
 * Renders a whole HTML document to a Letter-sized PDF.
 *
 * The page size is set here rather than in the document's CSS: the design spec allows
 * `@page { margin: 0 }` and nothing else, and this is also the only way the reader
 * cannot end up with A4 because that is what their dialog was set to.
 */
export async function renderPdf(html: string): Promise<Buffer> {
  const page = await (await browser()).newPage();
  try {
    // "load" is as far as setContent goes in puppeteer-core 25 — the network-idle
    // variants were dropped. It is enough here: the only external request the document
    // makes is the font stylesheet, and the wait below is what actually covers it.
    await page.setContent(html, { waitUntil: "load" });
    // Printing on the first paint uses a fallback face, and the metrics differ enough
    // to wrap the section headings and shift every column.
    await page.evaluateHandle("document.fonts.ready");

    // …and if the stylesheet never arrived, `ready` resolves just the same and the
    // document renders in Liberation Sans — a substitution nobody sees until a client
    // has the PDF. Better to fail the download and say why.
    //
    // The test is a face that actually loaded, which is narrower than it looks:
    //  - document.fonts.check() answers true for a family the browser does not have,
    //    because an unmatched family in the font shorthand is simply ignored;
    //  - a FontFace exists as soon as the @font-face rule is parsed, whether or not its
    //    file ever arrived — a stylesheet that loads while the font files 404 leaves a
    //    full font set and a document rendered in Liberation Sans.
    // Only `status === "loaded"` means the glyphs are there. Faces the document does not
    // use stay "unloaded" by design, so one loaded face per family is the bar.
    const missing = await page.evaluate(() => {
      const loaded = new Set(
        [...document.fonts]
          .filter((face) => face.status === "loaded")
          .map((face) => face.family.replace(/["']/g, "")),
      );
      return ["Bricolage Grotesque", "Roboto"].filter((family) => !loaded.has(family));
    });
    if (missing.length > 0) {
      throw new Error(
        `The document fonts did not load (${missing.join(", ")}), so it would print in a ` +
          "substitute face. Check that fonts.googleapis.com is reachable from the server.",
      );
    }

    const pdf = await page.pdf({ format: "letter", printBackground: true });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}
