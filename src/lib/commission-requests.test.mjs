import { pickContact, composeCommissionRequest } from "./commission-requests.ts";

let pass = 0, fail = 0;
const t = (name, cond, got = "") => {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, got); }
};

const partner = (overrides = {}) => ({
  partner_name: "Huttopia Wine Country",
  venue_name: "Huttopia Wine Country",
  partner_currency: "USD",
  gmv_ht: 28502.02,
  commission_ht: 2628.28,
  commission_rate: 0.092,
  rate_house: 0.12,
  rate_food: 0.12,
  rate_activity: 0.12,
  mismatch: false,
  owner_email: "groupsna@huttopia.com",
  owner_full_name: "Contact Huttopia",
  service_owner_email: null,
  ...overrides,
});

const row = {
  readable_id: "C-Q894",
  company_name: "Creatify",
  event_name: "Creatify Team Building Retreat",
  event_type: "NIGHTLY_TRIP",
  start_date: "2026-05-01",
  end_date: "2026-05-03",
  billing_entity: "NABOO_CA",
  currency_client: "USD",
  gross_gmv_ht: 30497.16,
  total_commission_ht: 2628.28,
  effective_rate: 8.62,
  booking_url: null,
  em_referent: "Isabelle Monette",
  sales_referent: "Alice Pessoa de Barros",
  partners: [partner()],
};

// pickContact
const c = pickContact(row.partners);
t("picks owner_email", c.address === "groupsna@huttopia.com");
t("extracts first name", c.name === "Contact");

const { subject, body } = composeCommissionRequest(row, c);
t("subject has client name", subject.includes("Creatify"));
t("subject has booking ID", subject.includes("C-Q894"));
t("subject has date range", subject.includes("May"), subject);
t("body greets first name", body.startsWith("Hi Contact"));
t("body has total event amount", body.includes("30,497.16 USD"), body.slice(200, 400));
t("body has commission line item", body.includes("Huttopia Wine Country"));
t("body has rate", body.includes("12.0 %") || body.includes("12.0%"), body);
t("body has total commission", body.includes("2,628.28 USD"));
t("net 15 terms in body", body.includes("net 15"));
t("ACH/EFT in body", body.includes("ACH/EFT"));

// no address
const noContact = pickContact([{ ...partner(), owner_email: null, service_owner_email: null }]);
t("returns null address when none found", noContact.address === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
