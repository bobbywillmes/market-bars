import fs from "fs/promises";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

export async function readCsv(path) {
  const txt = await fs.readFile(path, "utf8");
  return parse(txt, { columns: true, skip_empty_lines: true, trim: true });
}

export async function writeCsv(path, rows) {
  if (!rows || rows.length === 0) {
    await fs.writeFile(path, "");
    return;
  }
  const csv = stringify(rows, { header: true });
  await fs.writeFile(path, csv, "utf8");
}

export async function readRunConfig(path) {
  const rows = await readCsv(path);
  // expected: key,value
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  return cfg;
}