/**
 * The per-provider commission statement, as a printable page.
 *
 * The server function refuses to produce one when the commissionable base does not
 * imply the commission the NABCO documents net to — a statement whose own base does
 * not lead to its own total is worse than none, because the provider will check it
 * line by line. That refusal arrives here as a loader error, and the message says
 * which figures disagreed, so it is shown in full rather than as "something failed".
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { DocumentError, PrintableDocument } from "@/components/printable-document";
import { getNaCommissionDocument } from "@/lib/commission-statement.functions";

export const Route = createFileRoute("/_authenticated/commission/$ref/$houseCode")({
  ssr: false,
  beforeLoad: ({ context }) => {
    const allowed = (context as { allowedTrackers?: string[] }).allowedTrackers ?? [];
    if (!allowed.includes("na")) throw redirect({ to: "/" });
  },
  loader: ({ params }) =>
    getNaCommissionDocument({
      data: { readable_id: params.ref, house_code: params.houseCode },
    }),
  component: CommissionStatementPage,
  errorComponent: ({ error }) => (
    <DocumentError title="This commission statement could not be produced" error={error} />
  ),
});

function CommissionStatementPage() {
  const doc = Route.useLoaderData();
  return <PrintableDocument doc={doc} />;
}
