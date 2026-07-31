/**
 * WeasyPrint bridge (server-only).
 *
 * The statement is HTML, rendered by scripts/render_statement.py. HTML goes in on
 * stdin and the PDF comes back on stdout, so no temporary file survives the
 * request. `base_url` points at assets/fonts so the document's `@font-face` rules
 * resolve to the committed Bricolage Grotesque and Roboto files rather than
 * whatever the host happens to have installed — a substituted font would change
 * every column width in the document.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Overridable so a container can name its interpreter. */
const PYTHON = process.env.PYTHON_BIN || "python3";

function repoPath(...parts: string[]): string {
  return path.join(process.cwd(), ...parts);
}

export function statementFontDir(): string {
  return repoPath("assets", "fonts");
}

export function statementRendererPath(): string {
  return repoPath("scripts", "render_statement.py");
}

/**
 * Renders the document, or throws with what the renderer said.
 *
 * WeasyPrint writes layout warnings to stderr on a good run too, so stderr is only
 * surfaced when the exit code says something actually went wrong.
 */
export async function renderStatementPdf(html: string): Promise<Buffer> {
  const script = statementRendererPath();
  if (!existsSync(script)) {
    throw new Error(`Statement renderer not found at ${script}`);
  }
  const fontDir = statementFontDir();

  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(PYTHON, [script, "--base-url", `${fontDir}${path.sep}`], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));

    child.on("error", (error) =>
      reject(
        new Error(
          `Could not run the PDF renderer (${PYTHON}): ${error.message}. ` +
            "The statement needs Python with WeasyPrint — see scripts/requirements.txt.",
        ),
      ),
    );

    child.on("close", (code) => {
      const pdf = Buffer.concat(out);
      if (code !== 0) {
        const detail = Buffer.concat(err).toString("utf8").trim().split("\n").slice(-4).join(" ");
        reject(new Error(`PDF rendering failed (exit ${code})${detail ? `: ${detail}` : ""}`));
        return;
      }
      if (pdf.length === 0 || !pdf.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
        reject(new Error("PDF rendering produced no document"));
        return;
      }
      resolve(pdf);
    });

    child.stdin.on("error", () => {
      /* the close handler reports it */
    });
    child.stdin.end(html, "utf8");
  });
}
