import {
  RECOVERY_GRACE_DAYS,
  liveClientDocs,
  naClientRecovery,
  naClientContactFor,
  composeNaClientRecovery,
  prettyEntity,
} from "./na-client-recovery.ts";

let pass = 0,
  fail = 0;
const t = (name, cond, got = "") => {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, got);
  }
};

const NOW = new Date("2026-07-31T12:00:00Z");
const day = (iso) => `${iso} 09:00:00.000+00`;

const invoice = (overrides = {}) => ({
  invoice_id: "i1",
  invoice_ref: "CAI-CA26-00129",
  party: "CLIENT",
  doc_kind: "INVOICE",
  status: "ISSUED",
  currency: "USD",
  amount_ttc: 1000,
  emission_date: day("2026-06-01"),
  due_date: day("2026-06-08"),
  is_sent: true,
  cancels_invoice_id: null,
  pdf_url: "https://pdf.example/CAI-CA26-00129.pdf",
  seller_name: "NABOO CA Events Inc.",
  buyer_email: null,
  payment_means: "BANK_TRANSFER",
  bank_details: "NABOO CA Events, Inc. · account 963624580",
  ...overrides,
});

const creditNote = (overrides = {}) =>
  invoice({
    invoice_id: "c1",
    invoice_ref: "CAI-CA26-00130",
    doc_kind: "CREDIT_NOTE",
    amount_ttc: -1000,
    cancels_invoice_id: "i1",
    ...overrides,
  });

const receipt = (overrides = {}) => ({
  amount: 400,
  currency: "USD",
  paid_on: "2026-06-20",
  method: "bank transfer",
  reference: "INV NO - CAI-CA26-00129",
  ...overrides,
});

const row = (overrides = {}) => ({
  readable_id: "C-O621",
  client_request_id: "crid",
  company_name: "SOPAC",
  billing_entity: "NABOO_CA",
  currency_client: "USD",
  start_date: "2026-06-04",
  end_date: "2026-06-05",
  client_contact_email: "bgarcia@sopacins.com",
  client_contact_name: "Britney Garcia",
  ...overrides,
});

console.log("\n[liveClientDocs]");
{
  t("keeps a plain issued invoice", liveClientDocs([invoice()]).length === 1);
  t(
    "drops an invoice and the credit note that fully reverses it",
    liveClientDocs([invoice({ status: "CANCELLED" }), creditNote()]).length === 0,
  );
  t(
    "drops the pair even when the invoice was left ISSUED",
    liveClientDocs([invoice(), creditNote()]).length === 0,
  );
  const partial = liveClientDocs([invoice(), creditNote({ amount_ttc: -250 })]);
  t("keeps both when the credit note only partly offsets", partial.length === 2, partial.length);
  t(
    "drops a cancelled invoice with no credit note at all",
    liveClientDocs([invoice({ status: "CANCELLED" })]).length === 0,
  );
  t(
    "drops a cancelled invoice only partly credited",
    liveClientDocs([invoice({ status: "CANCELLED" }), creditNote({ amount_ttc: -250 })]).length ===
      0,
  );
  t(
    "never lists our commission note to a provider",
    liveClientDocs([invoice({ party: "PARTNER", invoice_id: "p1" })]).length === 0,
  );
  t(
    "ignores documents from a payload cached before `party` existed",
    liveClientDocs([invoice({ party: undefined })]).length === 0,
  );
  const ordered = liveClientDocs([
    invoice({ invoice_id: "b", invoice_ref: "B", emission_date: day("2026-06-10") }),
    invoice({ invoice_id: "a", invoice_ref: "A", emission_date: day("2026-06-01") }),
  ]);
  t("lists oldest first", ordered.map((d) => d.invoice_ref).join(",") === "A,B");
}

console.log("\n[naClientRecovery]");
{
  const rec = naClientRecovery(row(), [invoice()], [receipt()], NOW);
  t(
    "outstanding is invoiced less received",
    Math.abs(rec.outstanding - 600) < 0.001,
    rec.outstanding,
  );
  t("currency comes from the documents", rec.currency === "USD");
  t("eligible past both grace periods", rec.eligible === true);
  t("entity name comes from the invoice", rec.entityName === "NABOO CA Events Inc.");
  t("bank details carried when unanimous", rec.bankDetails?.includes("963624580") === true);
  t("overdue invoice noticed", rec.anyOverdue === true);
}
{
  const rec = naClientRecovery(row(), [invoice(), creditNote()], [], NOW);
  t("fully cancelling documents are not a balance", rec.outstanding === 0 && !rec.eligible);
}
{
  // Event five days ago: too early whatever the invoice says.
  const rec = naClientRecovery(
    row({ start_date: "2026-07-26", end_date: "2026-07-26" }),
    [invoice()],
    [],
    NOW,
  );
  t("not eligible inside the week after the event", rec.eligible === false, rec.daysSinceEvent);
  t("days since event is measured", rec.daysSinceEvent === 5, rec.daysSinceEvent);
}
{
  // Invoice issued yesterday: not late, even long after the event.
  const rec = naClientRecovery(row(), [invoice({ emission_date: day("2026-07-30") })], [], NOW);
  t("not eligible inside the week after the last invoice", rec.eligible === false);
  t("days since invoice is measured", rec.daysSinceInvoice === 1, rec.daysSinceInvoice);
}
{
  const exactly = new Date("2026-07-31T12:00:00Z");
  const rec = naClientRecovery(
    row({ start_date: "2026-07-24", end_date: "2026-07-24" }),
    [invoice({ emission_date: day("2026-07-24") })],
    [],
    exactly,
  );
  t(`eligible on day ${RECOVERY_GRACE_DAYS} exactly`, rec.eligible === true, rec.daysSinceEvent);
}
{
  const rec = naClientRecovery(row(), [invoice()], [receipt({ amount: 1500 })], NOW);
  t("an overpaid client is not a recovery", rec.eligible === false && rec.outstanding === 0);
}
{
  // A credit note issued yesterday must not restart the clock on the invoice.
  const rec = naClientRecovery(
    row(),
    [invoice(), creditNote({ amount_ttc: -250, emission_date: day("2026-07-30") })],
    [],
    NOW,
  );
  t("credit note does not reset the invoice clock", rec.eligible === true);
  t("outstanding nets the partial credit note", Math.abs(rec.outstanding - 750) < 0.001);
}
{
  const rec = naClientRecovery(
    row(),
    [
      invoice(),
      invoice({ invoice_id: "i2", invoice_ref: "EU-1", currency: "EUR", amount_ttc: 300 }),
    ],
    [receipt({ amount: 900 })],
    NOW,
  );
  t("currencies are never netted against each other", rec.byCurrency.size === 2);
  t("headline is the currency owed the most", rec.currency === "EUR", rec.currency);
  t("headline outstanding is that currency's", Math.abs(rec.outstanding - 300) < 0.001);
}
{
  const rec = naClientRecovery(row(), [invoice({ due_date: day("2026-09-30") })], [], NOW);
  t("an invoice inside its terms is not overdue", rec.anyOverdue === false);
}
{
  const rec = naClientRecovery(
    row(),
    [invoice(), invoice({ invoice_id: "i2", bank_details: "Other account · account 111" })],
    [],
    NOW,
  );
  t("bank details withheld when the invoices disagree", rec.bankDetails === null);
}

{
  // Two entities on one booking: the email can only name one.
  const rec = naClientRecovery(
    row(),
    [
      invoice({ amount_ttc: 200, seller_name: "NABOO GROUP" }),
      invoice({
        invoice_id: "i2",
        invoice_ref: "USI-1",
        amount_ttc: 900,
        seller_name: "NABOO US Inc.",
      }),
    ],
    [],
    NOW,
  );
  t("names the entity that issued the most", rec.entityName === "NABOO US Inc.", rec.entityName);
}

console.log("\n[naClientContactFor]");
{
  const c = naClientContactFor(row(), [invoice({ buyer_email: "ap@sopacins.com" })]);
  t("prefers the address the invoice was billed to", c.address === "ap@sopacins.com");
  const f = naClientContactFor(row(), [invoice()]);
  t("falls back to the booking contact", f.address === "bgarcia@sopacins.com");
  t("greets on the first name only", f.name === "Britney");
  const none = naClientContactFor(row({ client_contact_email: null }), [invoice()]);
  t("no address when nothing is on file", none.address === null);
}

console.log("\n[composeNaClientRecovery]");
{
  const r = row();
  const rec = naClientRecovery(r, [invoice(), creditNote({ amount_ttc: -250 })], [receipt()], NOW);
  const mail = composeNaClientRecovery(r, rec, NOW);
  t(
    "subject names the entity and the balance",
    mail.subject === "NABOO CA Events Inc. – Balance due: 350.00 USD",
    mail.subject,
  );
  t(
    "body lists the invoice with its link",
    mail.body.includes("https://pdf.example/CAI-CA26-00129.pdf"),
  );
  t("body marks the credit note as one", mail.body.includes("(credit note)"));
  t("body totals what it invoiced", mail.body.includes("Total invoiced : 750.00 USD"));
  t("body totals what was received", mail.body.includes("Total paid : 400.00 USD"));
  t("body states the balance due", mail.body.includes("Balance due: 350.00 USD"));
  t("body asks for settlement a week out", mail.body.includes("by August 7, 2026"));
  t("body names the receiving account", mail.body.includes("963624580"));
  t("body says the invoices are past due", mail.body.includes("past their due date"));
  t("no double full stop after an entity ending in Inc.", !mail.body.includes("Inc.."));
  t(
    "receipt line carries its reference and method",
    mail.body.includes("400.00 USD – INV NO - CAI-CA26-00129 (bank transfer)"),
  );
  t("body never mentions a partner commission", !/commission/i.test(mail.body));
  t(
    "invoiced total minus paid total equals the balance shown",
    750 - 400 === Math.round(rec.outstanding * 100) / 100,
  );
}
{
  const r = row();
  const rec = naClientRecovery(r, [invoice({ due_date: day("2026-09-30") })], [], NOW);
  const mail = composeNaClientRecovery(r, rec, NOW);
  t("no false 'past due' claim when terms still run", !mail.body.includes("past their due date"));
  t("says so when nothing has been received", mail.body.includes("none recorded on our side"));
}
{
  const r = row();
  const rec = naClientRecovery(r, [invoice()], [receipt({ amount: 1000 })], NOW);
  t("nothing to compose with no balance", composeNaClientRecovery(r, rec, NOW) === null);
}
{
  const r = row({ billing_entity: "NABOO_US" });
  const rec = naClientRecovery(r, [invoice({ seller_name: null })], [], NOW);
  const mail = composeNaClientRecovery(r, rec, NOW);
  t("falls back to the billing entity for the name", mail.subject.startsWith("NABOO US Inc."));
}

console.log("\n[prettyEntity]");
{
  t("known entity", prettyEntity("NABOO_US") === "NABOO US Inc.");
  t("unknown entity is readable", prettyEntity("NABOO_MX") === "NABOO MX");
  t("empty falls back to Naboo", prettyEntity(null) === "Naboo");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
