import {
  ratePctFromStored,
  serviceBase,
  commissionOfServices,
  netOfDocuments,
  reconcile,
  latestDue,
  commissionStatementFilename,
  clientEventLabel,
  buildCommissionStatementHtml,
} from "./commission-statement.ts";

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

// ── The real C-P222 / H-A9319 payload ───────────────────────────────────────
// Services: the pricing table returns Guestrooms and two sibling ROH rows at the
// same unit price. Documents: five NABCO documents, cancelled ones included.
const GUESTROOMS = {
  service: "Guestrooms",
  qty: 297,
  unit: "GROUP",
  unit_excl_tax: 169,
  rate_pct: 7,
};
const ROH_INDIVIDUAL = {
  service: "ROH Default - Single room",
  qty: 80,
  unit: "INDIVIDUAL",
  unit_excl_tax: 169,
  rate_pct: 7,
};
const ROH_GROUP = { ...ROH_INDIVIDUAL, unit: "GROUP" };
const CP222_SERVICES = [GUESTROOMS, ROH_INDIVIDUAL, ROH_GROUP];

const doc = (ref, amount, o = {}) => ({
  ref,
  kind: amount < 0 ? "CREDIT_NOTE" : "INVOICE",
  status: "ISSUED",
  currency: "USD",
  amount,
  issued: "2026-07-08",
  due: "2026-07-15",
  ...o,
});

const CP222_DOCS = [
  doc("NABCO-FR26-00973", 4732.0),
  doc("NABCO-FR26-00974", -1159.34),
  doc("NABCO-FR26-02190", -59.15, {
    status: "CANCELLED",
    issued: "2026-07-23",
    due: "2026-07-30",
  }),
  doc("NABCO-FR26-02623", 59.15, { issued: "2026-07-28", due: "2026-07-28" }),
  doc("NABCO-FR26-02627", -59.15, { issued: "2026-07-28", due: "2026-08-04" }),
];

const CP222 = {
  booking: {
    readable_id: "C-P222",
    client_name: "Altman Solon",
    event: "June Training Event",
    billing_entity: "NABOO GROUP (WOME STAY)",
  },
  provider: {
    name: "Hyatt Regency Long Island",
    house_code: "H-A9319",
    owner_code: "O-X801",
  },
  services: CP222_SERVICES,
  documents: CP222_DOCS,
  currency: "USD",
  commission_ht: 3513.51,
  commission_ttc: 3513.51,
  generatedOn: "2026-07-31",
};

console.log("\n[ratePctFromStored]");
t("70000 is 7%", ratePctFromStored(70000) === 7, ratePctFromStored(70000));
t("120000 is 12%", ratePctFromStored(120000) === 12);
t("70500 is 7.05%", ratePctFromStored(70500) === 7.05);
t("1000000 is 100%", ratePctFromStored(1000000) === 100);
t("never 70% for a 7% rate", ratePctFromStored(70000) !== 70);
t("zero is no rate", ratePctFromStored(0) === null);
t("null is no rate", ratePctFromStored(null) === null && ratePctFromStored(undefined) === null);

console.log("\n[bases and nets]");
t("line base is quantity times unit price", serviceBase(GUESTROOMS) === 50193);
t("commission of one line at its own rate", commissionOfServices([GUESTROOMS]) === 3513.51);
t(
  "every document counts, cancelled included",
  netOfDocuments(CP222_DOCS) === 3513.51,
  netOfDocuments(CP222_DOCS),
);
t(
  "excluding cancelled documents breaks the net",
  netOfDocuments(CP222_DOCS.filter((d) => d.status !== "CANCELLED")) !== 3513.51,
);
t("latest due date across all documents", latestDue(CP222_DOCS) === "2026-08-04");

console.log("\n[reconcile — C-P222 / H-A9319]");
{
  const rec = reconcile(CP222_SERVICES, CP222_DOCS);
  t("reconciles", rec.ok === true, rec.reason);
  t("on Guestrooms alone", rec.services.length === 1 && rec.services[0].service === "Guestrooms");
  t("base is 50,193.00, not 77,233.00", rec.base === 50193, rec.base);
  t("commission is 3,513.51", rec.commission === 3513.51, rec.commission);
  t("net of the documents is 3,513.51", rec.net === 3513.51);
  t("rate is 7%", rec.rates.length === 1 && rec.rates[0] === 7);
  t("two duplicate lines were left out", rec.dropped === 2, rec.dropped);
  t("no reason to report", rec.reason === null);
}
{
  // The ordinary case: every line belongs and nothing is dropped.
  const rec = reconcile([GUESTROOMS], [doc("NABCO-1", 3513.51)]);
  t("a quote with no duplicates keeps every line", rec.ok && rec.dropped === 0);
}
{
  // Mixed rates on one quote — each line at its own.
  const services = [
    { service: "Rooms", qty: 10, unit: "GROUP", unit_excl_tax: 100, rate_pct: 12 },
    { service: "Transport", qty: 2, unit: "UNIT", unit_excl_tax: 500, rate_pct: 5 },
  ];
  t("commission sums each line at its own rate", commissionOfServices(services) === 170);
  const rec = reconcile(services, [doc("NABCO-1", 170)]);
  t("mixed rates reconcile", rec.ok === true, rec.reason);
  t("and both rates are reported", rec.rates.join("/") === "5/12", rec.rates.join("/"));
}

console.log("\n[reconcile — refusals]");
{
  const rec = reconcile(CP222_SERVICES, [doc("NABCO-1", 9999)]);
  t("no subset reconciles", rec.ok === false);
  t(
    "the reason names both sides",
    /77,233.00/.test(rec.reason) && /9,999.00/.test(rec.reason),
    rec.reason,
  );
  t("and mentions a document that may be missing", /warehouse/.test(rec.reason));
}
{
  const rec = reconcile([], CP222_DOCS);
  t(
    "no service lines is a refusal",
    rec.ok === false && /No commissionable service/.test(rec.reason),
  );
}
{
  const rec = reconcile(CP222_SERVICES, []);
  t(
    "no commission document is a refusal",
    rec.ok === false && /No commission document/.test(rec.reason),
  );
}
{
  // The task's own failure signature: if NABCO-FR26-03130 is missing from the
  // warehouse the sides differ by 59.15 and nothing should be rendered.
  const partial = CP222_DOCS.filter(
    (d) => d.ref === "NABCO-FR26-00973" || d.ref === "NABCO-FR26-00974",
  );
  const rec = reconcile(CP222_SERVICES, partial);
  t("a stale warehouse is a refusal, not a rounding", rec.ok === false);
  t("and the gap is visible in the reason", /3,572.66/.test(rec.reason), rec.reason);
}

console.log("\n[filename]");
t(
  "carries booking, provider and the day of download",
  commissionStatementFilename("C-P222", "H-A9319", "2026-07-31") ===
    "Naboo_commission_C-P222_H-A9319_2026-07-31.pdf",
);

console.log("\n[clientEventLabel]");
t(
  "a real event name follows the client",
  clientEventLabel("Altman Solon", "June Training Event") === "Altman Solon · June Training Event",
);
t(
  "an auto-generated event name is not repeated",
  clientEventLabel("Altman Solon", "Altman Solon · 21–26 Jun 2026") ===
    "Altman Solon · 21–26 Jun 2026",
  clientEventLabel("Altman Solon", "Altman Solon · 21–26 Jun 2026"),
);
t("identical strings collapse", clientEventLabel("Acme", "Acme") === "Acme");
t("missing event", clientEventLabel("Acme", "") === "Acme");
t("missing client", clientEventLabel("", "Some event") === "Some event");

console.log("\n[buildCommissionStatementHtml]");
{
  const rec = reconcile(CP222_SERVICES, CP222_DOCS);
  const html = buildCommissionStatementHtml(CP222, rec, {
    contact: { email: "christian.bonadio@naboo.app", name: "Christian Bonadio" },
  });
  t("header label", html.includes("COMMISSION STATEMENT"));
  t("H1 names the booking", html.includes('Commission statement <span class="ref">· C-P222'));
  t("addressee is the provider, never the client", html.includes("Hyatt Regency Long Island"));
  t("client and event are their own cell", html.includes("Altman Solon · June Training Event"));
  t("client is never printed twice", !html.includes("Altman Solon · Altman Solon"));
  t("two tiles, not three", html.includes("tiles tiles-2"));
  t("provider codes", html.includes("H-A9319 · O-X801"));
  t("quantity reads in nights", html.includes("297 nights × 169.00"), html.slice(0, 0));
  t("base", html.includes("50,193.00"));
  t("rate", html.includes("7%"));
  t("commission excl. and incl. tax both appear", html.split("3,513.51").length - 1 >= 4);
  t(
    "all five documents are listed",
    CP222_DOCS.every((d) => html.includes(d.ref)),
  );
  t("credit notes get the chip", html.includes(">Credit note<"));
  t("negative amounts use a true minus", html.includes("−1,159.34"));
  t("net commission due", html.includes("Net commission due"));
  t("due date from the latest document", html.includes("Due 4 Aug 2026"));
  t("closing bar names the provider reference", html.includes("reference C-P222 · H-A9319"));
  t(
    "footnote says it does not replace the originals",
    /does not replace them, and it\s+is not itself an invoice/.test(html),
  );
  t("footnote explains the dropped duplicates", /duplicate services already priced/.test(html));
  t("event manager is the contact", html.includes("christian.bonadio@naboo.app"));
  t("no GMV figure anywhere", !html.includes("179,753.03"));
  t("no summed-duplicates base anywhere", !html.includes("77,233.00"));
  t("no commission gross tile", !/Commission gross/i.test(html));
}
{
  // A European provider: the commission carries tax, so the two columns diverge.
  const euro = {
    ...CP222,
    currency: "EUR",
    commission_ht: 1000,
    commission_ttc: 1200,
    services: [{ service: "Rooms", qty: 10, unit: "GROUP", unit_excl_tax: 1000, rate_pct: 10 }],
    documents: [doc("NABCO-9", 1000, { currency: "EUR" })],
  };
  const rec = reconcile(euro.services, euro.documents);
  const html = buildCommissionStatementHtml(euro, rec, {
    contact: { email: "finance@naboo.app", name: null },
  });
  t("excl. tax commission", html.includes("1,000.00"));
  t("incl. tax commission is allocated from the master ratio", html.includes("1,200.00"));
  t("no manager named on the finance fallback", !html.includes("event manager)"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
