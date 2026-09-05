#!/usr/bin/env node
/** Turn a probe report into a markdown step summary. */
import fs from "node:fs";
const file = process.argv[2] ?? "ci-report/report.json";
if (!fs.existsSync(file)) {
  console.log("no report file");
  process.exit(0);
}
const r = JSON.parse(fs.readFileSync(file, "utf8"));
const lines = [];
lines.push(`## real end-to-end (${r.provider?.host ?? "?"})`);
lines.push("");
if (r.error) lines.push(`**probe error:** \`${String(r.error).split("\n")[0]}\``);
lines.push("");
lines.push("| check | result | detail |");
lines.push("|---|---|---|");
for (const c of r.checks ?? []) lines.push(`| ${c.name} | ${c.pass ? "✅" : "❌"} | ${String(c.detail).slice(0, 160)} |`);
lines.push("");
for (const f of r.findings ?? []) lines.push(`- **[${f.sev}]** ${f.msg}`);
if (r.items?.length) {
  lines.push("");
  lines.push("**release contents**");
  lines.push("");
  lines.push("| file | size | container | method | playable |");
  lines.push("|---|---|---|---|---|");
  for (const i of r.items.slice(0, 12)) lines.push(`| ${i.name} | ${(i.size / 1048576).toFixed(1)} MB | ${i.container} | ${i.method ?? "-"} | ${i.playable ? "yes" : "no"} |`);
}
if (r.codecs) {
  lines.push("");
  lines.push(`**container/codecs:** \`${JSON.stringify(r.codecs).slice(0, 600)}\``);
}
if (r.playability?.notes?.length) {
  lines.push("");
  for (const n of r.playability.notes) lines.push(`- ${n}`);
}
if (r.firstRange) lines.push("");
if (r.firstRange) lines.push(`**first 1 MB:** status ${r.firstRange.status}, TTFB ${r.firstRange.ttfbMs}ms, ${r.firstRange.kbps ?? "?"} KB/s`);
if (r.seeks?.length) lines.push(`**seeks:** ${r.seeks.map((s) => `${(s.frac * 100).toFixed(0)}%→${s.ttfbMs}ms`).join(", ")}`);
console.log(lines.join("\n"));
