/**
 * The client statement of account for one booking, as a printable page.
 *
 * Inside `_authenticated`, so the layout's own gate applies before anything loads,
 * and the server function checks `requireTracker("na")` on top of it. The figures
 * are read from BigQuery on every visit — never from the tracker's cached payload —
 * and dated with the day of the request, so a statement is always current.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { DocumentError, PrintableDocument } from "@/components/printable-document";
import { getNaStatementDocument } from "@/lib/statement.functions";

export const Route = createFileRoute("/_authenticated/statement/$ref")({
  ssr: false,
  beforeLoad: ({ context }) => {
    const allowed = (context as { allowedTrackers?: string[] }).allowedTrackers ?? [];
    if (!allowed.includes("na")) throw redirect({ to: "/" });
  },
  loader: ({ params }) => getNaStatementDocument({ data: { readable_id: params.ref } }),
  component: StatementPage,
  errorComponent: ({ error }) => (
    <DocumentError title="This statement could not be produced" error={error} />
  ),
});

function StatementPage() {
  const doc = Route.useLoaderData();
  return <PrintableDocument doc={doc} />;
}
