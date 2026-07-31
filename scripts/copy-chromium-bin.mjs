/**
 * Copies @sparticuz/chromium's binary payload into the built function.
 *
 * The package is ~65 MB of Brotli-packed binaries under its own `bin/`, and only its
 * JavaScript is bundled: nitro inlines the module and leaves the archives behind, so at
 * runtime `executablePath()` resolves to a directory that does not exist in the
 * deployment — the failure the package's own error message calls out for bundlers.
 *
 * So the payload is copied next to the function and pointed at explicitly (see
 * `brotliBinDir` in src/lib/pdf.server.ts). Runs as npm's `postbuild`, which fires after
 * `npm run build` here and on Vercel alike.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "node_modules/@sparticuz/chromium/bin";
/** Where the built function looks for it — must match pdf.server.ts. */
const DIR_NAME = "chromium-bin";

function functionRoots() {
  const roots = [];
  // Vercel preset.
  const vercelFns = ".vercel/output/functions";
  if (existsSync(vercelFns)) {
    for (const entry of readdirSync(vercelFns)) {
      if (entry.endsWith(".func")) roots.push(join(vercelFns, entry));
    }
  }
  // Default nitro output, so a local `npm run build` can be exercised the same way.
  if (existsSync(".output/server")) roots.push(".output/server");
  return roots;
}

if (!existsSync(SOURCE)) {
  console.log(`[chromium] ${SOURCE} not found — nothing to copy.`);
  process.exit(0);
}

const roots = functionRoots();
if (roots.length === 0) {
  console.log("[chromium] no build output found — nothing to copy.");
  process.exit(0);
}

for (const root of roots) {
  const target = join(root, DIR_NAME);
  mkdirSync(target, { recursive: true });
  cpSync(SOURCE, target, { recursive: true });
  const bytes = readdirSync(target).reduce((sum, f) => sum + statSync(join(target, f)).size, 0);
  console.log(`[chromium] ${(bytes / 1024 / 1024).toFixed(1)} MB → ${target}`);
}
