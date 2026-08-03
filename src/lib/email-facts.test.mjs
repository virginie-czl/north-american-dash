import { extractFacts } from "./email-facts.ts";
import { cardOutreach } from "./card-tracking.ts";
const ME = "shayma.ndiaye@naboo.app";
const cases = [
  [
    "ask bank + tax, no reply",
    [
      {
        outbound: true,
        at: "2026-04-10T09:00:00Z",
        from: ME,
        subject: "Naboo — F-B694 paiement",
        body: "Bonjour, pourriez-vous nous transmettre vos coordonnées bancaires ainsi que votre numéro de TPS/TVQ ?",
      },
    ],
    { bankDetails: "asked", taxInfo: "asked", cardPayment: "unknown", repliedAt: null },
  ],

  [
    "partner replies with IBAN",
    [
      {
        outbound: true,
        at: "2026-04-10T09:00:00Z",
        from: ME,
        subject: "F-B694",
        body: "Vos coordonnées bancaires SVP",
      },
      {
        outbound: false,
        at: "2026-04-12T10:00:00Z",
        from: "compta@traiteur.ca",
        subject: "Re: F-B694",
        body: "Bonjour, voici notre IBAN : FR76 3000 6000 0112 3456 7890 189. Cordialement.",
      },
    ],
    { bankDetails: "received", taxInfo: "not_asked", repliedAt: "2026-04-12T10:00:00Z" },
  ],

  [
    "canadian bank coordinates",
    [
      {
        outbound: true,
        at: "2026-04-01T09:00:00Z",
        from: ME,
        subject: "x",
        body: "banking details please",
      },
      {
        outbound: false,
        at: "2026-04-02T09:00:00Z",
        from: "a@b.ca",
        subject: "Re",
        body: "Transit: 12345 Institution 004 Account number 7654321",
      },
    ],
    { bankDetails: "received" },
  ],

  [
    "GST/TVQ numbers received",
    [
      {
        outbound: false,
        at: "2026-04-03T09:00:00Z",
        from: "a@b.ca",
        subject: "Facture",
        body: "TPS 123456789 RT0001 / TVQ 1234567890 TQ0001",
      },
    ],
    { taxInfo: "received" },
  ],

  [
    "card refused",
    [
      {
        outbound: false,
        at: "2026-04-05T09:00:00Z",
        from: "a@b.ca",
        subject: "Re",
        body: "Malheureusement nous n'acceptons pas la carte, virement uniquement.",
      },
    ],
    { cardPayment: "refused" },
  ],

  [
    "card accepted",
    [
      {
        outbound: false,
        at: "2026-04-05T09:00:00Z",
        from: "a@b.ca",
        subject: "Re",
        body: "Oui, le paiement par carte de crédit nous convient très bien.",
      },
    ],
    { cardPayment: "accepted" },
  ],

  [
    "refusal wins in mixed sentence",
    [
      {
        outbound: false,
        at: "2026-04-05T09:00:00Z",
        from: "a@b.ca",
        subject: "Re",
        body: "Le paiement par carte serait possible mais malheureusement nous n'acceptons pas la carte cette année.",
      },
    ],
    { cardPayment: "refused" },
  ],

  [
    "attachment RIB counts",
    [
      {
        outbound: false,
        at: "2026-04-06T09:00:00Z",
        from: "a@b.ca",
        subject: "Doc",
        body: "Ci-joint.",
        attachmentNames: ["RIB_Traiteur.pdf"],
      },
    ],
    { bankDetails: "received" },
  ],

  [
    "contacted attribution and dates",
    [
      {
        outbound: true,
        at: "2026-04-10T09:00:00Z",
        from: "virginie@naboo.app",
        subject: "s",
        body: "coordonnées bancaires",
      },
      { outbound: true, at: "2026-04-14T09:00:00Z", from: ME, subject: "s", body: "relance" },
    ],
    { contactedBy: ME, bankAskedBy: "virginie@naboo.app" },
  ],

  [
    "no signals at all",
    [
      {
        outbound: true,
        at: "2026-04-10T09:00:00Z",
        from: ME,
        subject: "Bonjour",
        body: "Merci pour l'événement !",
      },
    ],
    { bankDetails: "not_asked", taxInfo: "not_asked", cardPayment: "unknown" },
  ],
];

let pass = 0,
  fail = 0;
for (const [name, msgs, expect] of cases) {
  const got = extractFacts(msgs, ME);
  const bad = Object.entries(expect).filter(([k, v]) => got[k] !== v);
  if (bad.length === 0) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log(
      "  ✗",
      name,
      "→",
      bad.map(([k, v]) => `${k}: expected ${v}, got ${got[k]}`).join("; "),
    );
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

// --- Card acceptance must be explicit (regression) ---
{
  let p = 0,
    f = 0;
  const t = (n, c, g = "") => {
    if (c) {
      p++;
      console.log("  ✓", n);
    } else {
      f++;
      console.log("  ✗", n, g);
    }
  };
  const inbound = (body) =>
    extractFacts(
      [{ outbound: false, at: "2026-04-05T09:00:00Z", from: "a@b.ca", subject: "Re", body }],
      ME,
    );

  // Should be ACCEPTED
  for (const b of [
    "Oui, le paiement par carte de crédit nous convient très bien.",
    "La carte accepté sans problème.",
    "Nous acceptons la carte de crédit.",
    "Vous pouvez régler par carte.",
    "Yes, credit card works for us.",
    "We accept credit cards.",
    "Card is fine.",
  ]) {
    t(`accepted: ${b.slice(0, 40)}`, inbound(b).cardPayment === "accepted", inbound(b).cardPayment);
  }

  // Should NOT be accepted — these were false positives before
  for (const b of [
    "Le paiement par carte serait possible mais je dois vérifier.",
    "Merci pour votre message concernant le paiement par carte.",
    "Pouvez-vous confirmer si vous payez par carte ?",
    "Je reviens vers vous au sujet de la carte.",
    "Regarding your question about credit card payment, I'll check.",
  ]) {
    t(
      `not accepted: ${b.slice(0, 45)}`,
      inbound(b).cardPayment !== "accepted",
      inbound(b).cardPayment,
    );
  }

  // Refusals still win
  for (const b of [
    "Malheureusement nous n'acceptons pas la carte, virement uniquement.",
    "Le paiement par carte serait possible mais malheureusement nous n'acceptons pas la carte.",
    "We cannot accept credit card, bank transfer only.",
  ]) {
    t(`refused: ${b.slice(0, 40)}`, inbound(b).cardPayment === "refused", inbound(b).cardPayment);
  }

  console.log(`\n[card explicit] ${p} passed, ${f} failed`);
  if (f) process.exitCode = 1;
}

// --- Asked, then a reply that never says yes: resolves to refused ---
{
  let p = 0,
    f = 0;
  const t = (n, c, g = "") => {
    if (c) {
      p++;
      console.log("  ✓", n);
    } else {
      f++;
      console.log("  ✗", n, g);
    }
  };
  const asked = {
    outbound: true,
    at: "2026-04-05T09:00:00Z",
    from: ME,
    subject: "Card payment for your upcoming booking",
    body: cardOutreach({ provider_name: "Traiteur X" }).body,
  };
  const facts = (reply) => extractFacts([asked, reply], ME);

  const bankOnly = facts({
    outbound: false,
    at: "2026-04-06T09:00:00Z",
    from: "a@b.ca",
    subject: "Re",
    body: "Bonjour, voici notre IBAN : FR76 3000 6000 0112 3456 7890 189. Cordialement.",
  });
  t(
    "bank details with no card mention, after asking → refused",
    bankOnly.cardPayment === "refused" && bankOnly.cardDecidedAt === "2026-04-06T09:00:00Z",
    JSON.stringify(bankOnly),
  );
  t("flags the implicit signal", bankOnly.signals.includes("card:refused_implicit"));

  const offTopic = facts({
    outbound: false,
    at: "2026-04-06T09:00:00Z",
    from: "a@b.ca",
    subject: "Re",
    body: "Thanks, see you at the event!",
  });
  t(
    "a reply about something else entirely, after asking → refused",
    offTopic.cardPayment === "refused",
    offTopic.cardPayment,
  );

  const paymentLink = facts({
    outbound: false,
    at: "2026-04-06T09:00:00Z",
    from: "a@b.ca",
    subject: "Re",
    body: "Sure! Here is our payment link: https://buy.stripe.com/abc123",
  });
  t(
    "a payment link, after asking → accepted",
    paymentLink.cardPayment === "accepted",
    paymentLink.cardPayment,
  );

  const noReplyYet = extractFacts([asked], ME);
  t(
    "asked, no reply yet → still unknown",
    noReplyYet.cardPayment === "unknown",
    noReplyYet.cardPayment,
  );

  const neverAsked = extractFacts(
    [
      {
        outbound: false,
        at: "2026-04-06T09:00:00Z",
        from: "a@b.ca",
        subject: "Facture",
        body: "Bonjour, voici notre IBAN : FR76 3000 6000 0112 3456 7890 189. Cordialement.",
      },
    ],
    ME,
  );
  t(
    "bank details with no prior card ask → still unknown",
    neverAsked.cardPayment === "unknown",
    neverAsked.cardPayment,
  );

  t(
    "our own outreach template is recognised as asking about card",
    (() => {
      const outboundOnly = extractFacts([asked], ME);
      return outboundOnly.signals.includes("card:asked");
    })(),
  );

  console.log(`\n[card silence] ${p} passed, ${f} failed`);
  if (f) process.exitCode = 1;
}
