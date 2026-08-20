/**
 * "Download statement" — one click, one PDF, in Downloads.
 *
 * The document is drawn in the browser (`statement-pdf.ts`) rather than handed to
 * a print dialog: nobody wants a tab, a dialog and a destination folder between
 * them and a file they were promised. The renderer and the five brand faces are
 * loaded on the first click and kept for the session, so the first statement
 * costs a fetch and the rest cost nothing.
 *
 * Drawing a PDF is CPU work — a fraction of a second each — which matters only
 * for the archive of a whole filtered set. That loop yields to the browser
 * between documents and reports how far it has got, so the page keeps painting
 * and the button can say where it is.
 */
import { useCallback, useState } from "react";
import { statementFileName } from "@/lib/account-statements";
import type { StatementOfAccount } from "@/lib/statement-of-account";
import { zipStored, type ZipEntry } from "@/lib/zip";

/**
 * The renderer and the faces are a megabyte of the bundle, for a button most
 * visits never press, so they arrive on the first click and stay for the session.
 */
async function loadRenderer() {
  const [{ renderStatementPdf }, { statementFonts }] = await Promise.all([
    import("@/lib/statement-pdf"),
    import("@/lib/statement-fonts"),
  ]);
  const fonts = await statementFonts();
  return async (data: StatementOfAccount): Promise<ZipEntry> => ({
    name: statementFileName(data),
    bytes: await renderStatementPdf(data, fonts),
  });
}

/** Hands the browser a file without leaving anything behind. */
export function handOver(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Where an archive has got to, for the button that started it. */
export type StatementProgress = { done: number; total: number };

export function useStatementDownload() {
  const [progress, setProgress] = useState<StatementProgress | null>(null);

  /**
   * A failed download has to say so: the button is the only thing the user is
   * looking at, and a click that produces no file and no message reads as a
   * broken page. There is no toast in this tracker, so this is the message.
   */
  const failed = (error: unknown) => {
    console.error("Statement download failed", error);
    window.alert("The statement could not be built. Reload the page and try again.");
  };

  /** One statement, straight to disk. */
  const one = useCallback(async (data: StatementOfAccount) => {
    try {
      const draw = await loadRenderer();
      const entry = await draw(data);
      handOver(new Blob([entry.bytes], { type: "application/pdf" }), entry.name);
    } catch (error) {
      failed(error);
    }
  }, []);

  /** A set of statements as one archive, named. */
  const many = useCallback(async (data: StatementOfAccount[], filename: string) => {
    setProgress({ done: 0, total: data.length });
    try {
      const draw = await loadRenderer();
      const entries: ZipEntry[] = [];
      for (const statement of data) {
        entries.push(await draw(statement));
        setProgress({ done: entries.length, total: data.length });
        // Give the browser the frame back, so the count moves and the tab lives.
        await new Promise((resume) => setTimeout(resume, 0));
      }
      handOver(new Blob([zipStored(entries)], { type: "application/zip" }), filename);
    } catch (error) {
      failed(error);
    } finally {
      setProgress(null);
    }
  }, []);

  return {
    one,
    many,
    progress,
    /** `12 / 96` while an archive is building, for the button's own label. */
    progressLabel: progress ? `${progress.done} / ${progress.total}` : null,
    busy: progress !== null,
  };
}
