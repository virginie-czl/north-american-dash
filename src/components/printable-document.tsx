/**
 * A document rendered as a page, printed by the browser.
 *
 * There is no PDF engine in this project and there cannot be one: Vercel runs it on
 * the Node runtime, so a Python renderer has nothing to run in and a bundled Chrome
 * is a second engine to keep in agreement with the first. The design was authored as
 * HTML for a browser, so the browser renders it — flex, grid, `break-inside` and
 * webfonts all behave as specified, and what the reader sees on screen is what comes
 * out of the print dialog.
 *
 * The markup and its stylesheet both come from the server function, already escaped
 * by the builders in statement.ts. Nothing user-typed reaches them unescaped.
 */
import { useEffect, useRef } from "react";

export type PrintableDoc = {
  title: string;
  body_html: string;
  css: string;
};

export function PrintableDocument({ doc }: { doc: PrintableDoc }) {
  // Print once per document, not once per render: the effect re-runs whenever React
  // re-renders the route, and a second dialog on top of the first is unusable.
  const printed = useRef<string | null>(null);

  useEffect(() => {
    document.title = doc.title;
  }, [doc.title]);

  useEffect(() => {
    if (printed.current === doc.title) return;
    printed.current = doc.title;
    let cancelled = false;
    // Wait for the webfonts. Printing on the first paint uses a fallback face, and
    // the metrics differ enough to wrap the section headings and shift every column.
    const ready = document.fonts?.ready ?? Promise.resolve();
    ready.then(() => {
      if (!cancelled) window.print();
    });
    return () => {
      cancelled = true;
    };
  }, [doc.title]);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: doc.css }} />
      {/* doc-viewport: the document's own stylesheet frames this on screen and
          unwinds it for print — the sheet is the page there, and the grey field's
          padding is enough to push the footnote onto a second one. */}
      <div className="doc-viewport min-h-0 flex-1 overflow-auto">
        <PrintToolbar />
        <div dangerouslySetInnerHTML={{ __html: doc.body_html }} />
      </div>
    </>
  );
}

/**
 * Screen-only chrome. The paper size is the print dialog's to choose — the document
 * declares nothing but a zero margin, as the design spec requires — so the reminder
 * to pick Letter has to be here, where the reader is looking when the dialog opens.
 */
function PrintToolbar() {
  return (
    <div className="no-print mx-auto mb-4 flex w-[8.5in] max-w-full flex-wrap items-center justify-between gap-3 px-1">
      <p className="text-[12px] text-slate-600">
        Set the paper size to <strong className="font-semibold text-navy">Letter</strong> in the
        print dialog, and leave margins at <strong className="font-semibold text-navy">None</strong>{" "}
        — headers and footers come from the document itself.
      </p>
      <button
        type="button"
        onClick={() => window.print()}
        className="inline-flex h-8 flex-none items-center rounded-md border-0 bg-naboo px-3 text-[12.5px] font-semibold text-navy"
      >
        Print / Save as PDF
      </button>
    </div>
  );
}

/** Shown instead of the document when the server refuses to produce one. */
export function DocumentError({ title, error }: { title: string; error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="mx-auto max-w-2xl px-6 py-14">
      <h1 className="font-display text-xl font-extrabold tracking-tight text-navy">{title}</h1>
      <p className="mt-3 whitespace-pre-line text-[13.5px] leading-relaxed text-slate-700">
        {message}
      </p>
      <button
        type="button"
        onClick={() => window.close()}
        className="mt-6 inline-flex h-8 items-center rounded-md border border-input bg-white px-3 text-[12.5px] text-slate-700"
      >
        Close this tab
      </button>
    </div>
  );
}
