/**
 * The two shared screens, rendered.
 *
 * They hold no data logic, so what is worth testing is that they render at all
 * and that the design's few load-bearing states survive: a breached row takes
 * the highlight, a ticked row reads as checked, a currency suffix appears, the
 * subtotal and caption are there, and the palette marks the row Enter would
 * open. Run with `npx tsx src/components/paper-screens.test.tsx`.
 */
import { renderToString } from "react-dom/server";
import { ListScreen, EventScreen } from "./paper-screens";
import { CommandPalette } from "./command-palette";

const rows = [
  {
    id: "a",
    ref: "CA-2411-0847",
    lead: "Ask",
    strong: "Espace Canal",
    tail: "for bank details and a GST number",
    meta: "CA-2411-0847 · PO 4501277318 · master class · booked 14 May, 94 d · 3 partners",
    state: "Never contacted · invoice sent, client due in 21 d",
    a: "8 200,00",
    b: "18 900,00",
    trail: "—",
    target: {},
  },
  {
    id: "b",
    ref: "CA-2411-0798",
    lead: "Ask",
    strong: "Traiteur Agnus Dei",
    tail: "for a GST and QST number",
    meta: "CA-2411-0798 · PO 4501276742 · seminar",
    state: "Payout breached 34 days ago · bank details received 12 June",
    stateAlert: true,
    a: "4 120,00",
    aCcy: "CAD",
    b: "6 420,00",
    trail: "34 d",
    trailAlert: true,
  },
];

const list = renderToString(
  <ListScreen
    crumb="Ask partners for details"
    title="Ask 12 partners for bank details and tax numbers"
    explanation="One email per partner."
    columns={["Owed to partner", "Client outstanding", "Waiting"]}
    unitNoun="partners"
    rows={rows}
    selected={new Set(["a"])}
    onToggle={() => {}}
    primary={{ label: "Review & send 1", onClick: () => {} }}
    secondary={{ label: "Create drafts", onClick: () => {} }}
    siblings={[{ key: "pay", label: "Pay partners", count: 6, onClick: () => {} }]}
    isLoading={false}
    onBack={() => {}}
    onDownload={() => {}}
    onOpen={() => {}}
  />,
);

const event = renderToString(
  <EventScreen
    crumbs={[{ label: "Overview", onClick: () => {} }, { label: "CA-2411-0847" }]}
    backOffice="https://example.com"
    eventLabel="master class"
    reference="CA-2411-0847"
    po="4501277318"
    meta="L'Oréal Canada · CA · Naboo Canada"
    stats={[
      { label: "Client outstanding", value: "18 900,00" },
      { label: "Owed to partners", value: "12 480,00", alert: true },
    ]}
    clientAlert
    caption="Amounts in $CA."
    moves={[
      {
        id: "1",
        lead: "Ask",
        strong: "Espace Canal",
        tail: "for bank details",
        reason: "Never contacted.",
        action: { label: "Review & send", primary: true, onClick: () => {} },
      },
    ]}
    partners={[
      {
        key: "p",
        name: "Espace Canal",
        contact: "compta@espacecanal.ca · venue",
        state: "Never contacted.",
        figures: [
          { label: "Due", value: "8 200,00" },
          { label: "Paid", value: "0,00" },
        ],
        links: <span>link</span>,
      },
    ]}
    partnerLabel="Supplier side"
    partnersNote="3 payable suppliers, 1 provision line excluded from what is payable"
    clientLabel="Client side"
    subtotal={{ label: "Subtotal · $CA", values: ["69 960,00", "72 960,00", "6 420,00"] }}
    invoices={[{ id: "i", ref: "FA-2026-0412", prose: "Emitted 20 May", amount: "31 400,00" }]}
    onClientStatement={() => {}}
    clientStatementLabel="Client statement · L’Oréal Canada, this event"
    history={[{ id: "h", title: "PO received", meta: "14 July" }]}
    rail={[
      { id: "r", label: "Emails", onClick: () => {}, active: true },
      { id: "d", label: "Partner invoices — load the PDFs", onClick: () => {} },
    ]}
    notes={<div>notes</div>}
    panel={<div>the PDFs</div>}
    panelTitle="Partner invoices — PDFs"
    onClosePanel={() => {}}
  />,
);

const clientSide = renderToString(
  <EventScreen
    crumbs={[{ label: "Overview" }]}
    eventLabel="master class"
    reference="CA-2411-0847"
    po={null}
    meta="L'Oréal Canada"
    stats={[{ label: "Client outstanding", value: "18 900,00" }]}
    moves={[]}
    partners={[]}
    invoices={[{ id: "i", ref: "FA-2026-0412", prose: "Emitted 20 May", amount: "31 400,00" }]}
    onClientStatement={() => {}}
    clientStatementLabel="Client statement · L’Oréal Canada, this event"
    history={[]}
    rail={[]}
    notes={<div>notes</div>}
    defaultSide="client"
  />,
);

const palette = renderToString(
  <CommandPalette
    open
    query="0847"
    onQuery={() => {}}
    onClose={() => {}}
    groups={[
      {
        label: "Event",
        items: [
          {
            id: "e",
            title: "CA-2411-0847 · master class",
            meta: "L'Oréal Canada",
            amount: "18 900,00",
            amountLabel: "client outstanding",
            note: "2 moves waiting",
            onPick: () => {},
          },
        ],
      },
    ]}
    placeholder="Event code"
    intro="Type an event code, a PO number, a partner name or an invoice reference."
    hint="Partial codes work"
    cursor={0}
    onCursor={() => {}}
  />,
);

/** SSR inserts comment markers between text nodes; the copy is what matters. */
const text = (html: string) => html.replace(/<!--[^>]*-->/g, "");

const checks: Array<[string, boolean]> = [
  ["list renders the title", list.includes("Ask 12 partners for bank details")],
  ["list renders both rows", list.includes("Espace Canal") && list.includes("Traiteur Agnus Dei")],
  ["a breached row takes the row highlight", list.includes("bg-paper-row")],
  ["a currency suffix renders", list.includes("$CA")],
  ["the selection square is filled for a ticked row", list.includes('aria-checked="true"')],
  ["event renders the display title", event.includes("master class")],
  ["event renders the subtotal", event.includes("Subtotal")],
  ["event renders the caption", event.includes("Amounts in")],
  [
    "the client side lists the invoices and names its statement",
    clientSide.includes("FA-2026-0412") &&
      clientSide.includes("Client statement · L’Oréal Canada, this event"),
  ],
  ["an open rail link says so", event.includes("showing")],
  [
    "the booking is split into a partner and a client side",
    event.includes("Supplier side") && event.includes("Client side"),
  ],
  [
    "the partner side is the one showing, with its own caption",
    event.includes("Espace Canal") && event.includes("provision line excluded"),
  ],
  ["the client side is not rendered until it is picked", !event.includes("FA-2026-0412")],
  [
    "a side with something wrong on it is marked, even when hidden",
    // Espace Canal's row carries an alert figure, so the partner tab is marked.
    event.includes("text-paper-alert") && event.includes(" !"),
  ],
  [
    "the panel it opened is titled and closable",
    event.includes('id="event-panel"') &&
      event.includes("Partner invoices") &&
      event.includes("Close"),
  ],
  ["palette renders the match count", text(palette).includes("1 match")],
  ["palette says what it searches over", palette.includes("⌘K from any screen")],
  ["palette highlights the cursor row", palette.includes("bg-paper-selected")],
];

let fail = 0;
for (const [name, ok] of checks) {
  console.log(ok ? "  ✓ " + name : "  ✗ " + name);
  if (!ok) fail++;
}
console.log(`\n${checks.length - fail} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
