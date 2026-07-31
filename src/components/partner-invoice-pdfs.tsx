/**
 * Partner invoice PDF panel.
 *
 * Signed S3 URLs expire after ~15 minutes, so they are fetched on demand and
 * never stored. The panel shows nothing until the user clicks — no background
 * fetch that would produce stale links.
 */
import { useState } from "react";
import { ExternalLink, FileText, RefreshCw } from "lucide-react";
import { fetchReInvoicingPdfs } from "@/lib/reinvoicing.functions";

function filename(url: string): string {
  try {
    const path = new URL(url).pathname;
    const raw = decodeURIComponent(path.split("/").pop() ?? url);
    // Strip the UUID prefix if present (uuid-filename.pdf → filename.pdf)
    return raw.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-?/i, "");
  } catch {
    return url;
  }
}

export function PartnerInvoicePdfs({ clientRequestId }: { clientRequestId: string | null }) {
  const [pdfs, setPdfs] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!clientRequestId) return null;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchReInvoicingPdfs({
        data: { client_request_id: clientRequestId! },
      });
      setPdfs(result.pdfs);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-3.5 py-2">
        <FileText className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-600">
          Factures partenaires
        </span>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-slate-600 underline-offset-2 hover:underline disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          {pdfs === null ? "Charger" : "Actualiser"}
        </button>
      </header>

      {pdfs === null && !loading && !error && (
        <p className="px-3.5 py-2.5 text-[11.5px] text-slate-500">
          Les liens expirent après 15 min — cliquez sur Charger pour obtenir des URLs valides.
        </p>
      )}

      {loading && <p className="px-3.5 py-2.5 text-[11.5px] text-slate-500">Chargement…</p>}

      {error && (
        <p role="alert" className="px-3.5 py-2.5 text-[11.5px] text-rose-800">
          {error}
        </p>
      )}

      {pdfs !== null &&
        !loading &&
        (pdfs.length === 0 ? (
          <p className="px-3.5 py-2.5 text-[11.5px] text-slate-500">
            Aucune facture soumise pour cet événement.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {pdfs.map((url, i) => (
              <li key={i} className="flex items-center gap-2 px-3.5 py-2">
                <FileText className="h-3.5 w-3.5 flex-none text-slate-400" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[12px]">
                  {filename(url) || `Facture ${i + 1}`}
                </span>
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-sky-800 underline-offset-2 hover:underline"
                >
                  Ouvrir
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
