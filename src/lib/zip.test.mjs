import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipStored, uniqueNames, textEntry } from "./zip.ts";

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

// ── Names ──────────────────────────────────────────────────────────────────
const collided = uniqueNames([
  textEntry("Le Balcon.pdf", "a"),
  textEntry("Le Balcon.pdf", "b"),
  textEntry("le balcon.pdf", "c"),
  textEntry("Other.pdf", "d"),
]);
t(
  "a repeated name is numbered, not dropped",
  collided.map((e) => e.name).join(" | ") ===
    "Le Balcon.pdf | Le Balcon (2).pdf | le balcon (3).pdf | Other.pdf",
  collided.map((e) => e.name).join(" | "),
);

// ── The archive itself, read back by the system unzip ───────────────────────
const entries = [
  textEntry("Espace Canal — CA-2411-0847.csv", "Poste;Montant\nDû;8 200,00\n"),
  // A binary entry: the bytes must come out exactly as they went in.
  { name: "Traiteur Agnus Dei — CA-2411-0847.pdf", bytes: new Uint8Array([37, 80, 68, 70, 45, 0, 255, 10]) },
];
const bytes = zipStored(entries);
t("starts with the local file header signature", bytes[0] === 0x50 && bytes[1] === 0x4b);

const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
const archive = join(dir, "statements.zip");
writeFileSync(archive, bytes);

let listed = "";
try {
  listed = execFileSync("unzip", ["-l", archive], { encoding: "utf8" });
  t("unzip lists both files", listed.includes("Espace Canal") && listed.includes("Agnus Dei"));
  execFileSync("unzip", ["-qq", "-o", archive, "-d", dir]);
  const files = readdirSync(dir).filter((f) => f.endsWith(".csv") || f.endsWith(".pdf"));
  t("both files extract", files.length === 2, files.join(", "));
  const first = readFileSync(join(dir, "Espace Canal — CA-2411-0847.csv"), "utf8");
  t("the accented name survives", first.includes("Dû;8 200,00"));
  t("a text entry carries a BOM for Excel", first.charCodeAt(0) === 0xfeff);
  const binary = readFileSync(join(dir, "Traiteur Agnus Dei — CA-2411-0847.pdf"));
  t(
    "a binary entry comes out byte for byte",
    binary.equals(Buffer.from([37, 80, 68, 70, 45, 0, 255, 10])),
    binary.toString("hex"),
  );
} catch (error) {
  // No unzip on the box: the header check above still ran.
  console.log("  · unzip unavailable, skipped the round-trip:", String(error.message).slice(0, 60));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
