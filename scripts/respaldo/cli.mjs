#!/usr/bin/env node
// cli.mjs — pegamento entre los .sh de scripts/respaldo/ y lib.mjs.
// Subcomandos (todos imprimen a stdout y salen != 0 al fallar):
//   conn-env                           (stdin: URL) imprime export PG*=... para eval
//   check-target                       guardia de restauración sobre PGHOST (RESTORE_ALLOW_NON_LOCAL)
//   is-local-conn                      sale 0 si PGHOST apunta a esta máquina
//   schemas <lista>                    valida y normaliza la lista de esquemas
//   write-manifest <dir> <json-meta>   escribe manifest.json con sha256 de cada archivo
//   verify-manifest <dir>              recalcula sha256 y compara con manifest.json
//   retention <dest> <keepLast> <keepDays>   imprime los directorios a borrar
//   report <outdir> <backupdir> <catalogo-restaurado|-> <json-extra>   compara catálogos, evalúa RPO/RTO, escribe reporte
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildReport,
  checkRestoreTarget,
  compareCatalogs,
  evaluateTargets,
  parseHost,
  parseSchemas,
  reportToMarkdown,
  selectRetention,
  sha256File,
} from "./lib.mjs";

const [cmd, ...args] = process.argv.slice(2);
const die = (m) => {
  console.error(`respaldo: ${m}`);
  process.exit(1);
};

if (cmd === "conn-env") {
  // Lee una URL postgres:// por STDIN (nunca por argv: se vería en ps) y la convierte en
  // asignaciones PG* para `eval`, así ninguna herramienta recibe credenciales en argv.
  const url = readFileSync(0, "utf8").trim();
  let u;
  try {
    u = new URL(url);
  } catch {
    die("URL de conexión ilegible (no se imprime por si contiene credenciales)");
  }
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const sock = u.searchParams.get("host");
  const out = {
    PGHOST: sock ?? u.hostname,
    PGPORT: u.searchParams.get("port") ?? u.port,
    PGUSER: decodeURIComponent(u.username) || (u.searchParams.get("user") ?? ""),
    PGPASSWORD: decodeURIComponent(u.password) || (u.searchParams.get("password") ?? ""),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
    PGSSLMODE: u.searchParams.get("sslmode") ?? "",
  };
  for (const [k, v] of Object.entries(out)) console.log(v === "" ? `unset ${k}` : `export ${k}=${q(v)}`);
} else if (cmd === "check-target") {
  // El destino viaja por entorno (PGHOST), nunca por argv (se vería en ps).
  const raw = process.env.PGHOST;
  const r = checkRestoreTarget(raw, { allowRemote: process.env.RESTORE_ALLOW_NON_LOCAL === "1" });
  if (!r.ok) die(`destino rechazado: ${r.reason}`);
  console.log(r.reason);
} else if (cmd === "is-local-conn") {
  // Sale 0 si la conexión (PGHOST) apunta a una máquina local.
  const h = parseHost(process.env.PGHOST);
  process.exit(h.socket || ["localhost", "127.0.0.1", "::1", "[::1]"].includes(h.host) ? 0 : 3);
} else if (cmd === "schemas") {
  try {
    console.log(parseSchemas(args[0]).join(","));
  } catch (e) {
    die(e.message);
  }
} else if (cmd === "write-manifest") {
  const [dir, metaJson] = args;
  const meta = JSON.parse(metaJson);
  const files = {};
  for (const f of readdirSync(dir)) {
    if (f === "manifest.json") continue;
    files[f] = await sha256File(join(dir, f));
  }
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ format: 1, ...meta, files }, null, 2)}\n`);
} else if (cmd === "verify-manifest") {
  const dir = args[0];
  if (!existsSync(join(dir, "manifest.json"))) die("falta manifest.json");
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const bad = [];
  for (const [f, sha] of Object.entries(m.files ?? {})) {
    if (!existsSync(join(dir, f))) bad.push(`${f}: falta`);
    else if ((await sha256File(join(dir, f))) !== sha) bad.push(`${f}: sha256 distinto (archivo alterado o truncado)`);
  }
  if (Object.keys(m.files ?? {}).length === 0) bad.push("el manifest no lista archivos");
  if (bad.length) die(`respaldo corrupto: ${bad.join("; ")}`);
  console.log(`manifest OK (${Object.keys(m.files).length} archivos)`);
} else if (cmd === "retention") {
  const [dest, keepLast, keepDays] = args;
  const entries = [];
  for (const name of readdirSync(dest)) {
    const mp = join(dest, name, "manifest.json");
    if (!name.startsWith("atiende-") || !existsSync(mp)) continue; // solo toca lo que este script creó
    entries.push({ name, createdAtMs: Date.parse(JSON.parse(readFileSync(mp, "utf8")).created_at) });
  }
  console.log(selectRetention(entries, { keepLast: Number(keepLast), keepDays: Number(keepDays) }).remove.join("\n"));
} else if (cmd === "report") {
  // report <outdir> <backupdir> <restored-catalog.json|-> <extra-json>
  // extra: { timing, meta, preChecks, strictInvariants }
  const [outdir, backupDir, restoredPath, extraJson] = args;
  const extra = JSON.parse(extraJson);
  const source = JSON.parse(readFileSync(join(backupDir, "catalog.json"), "utf8"));
  const restored = restoredPath === "-" ? null : JSON.parse(readFileSync(restoredPath, "utf8"));
  const checks = [
    ...(extra.preChecks ?? []),
    ...(restored ? compareCatalogs(source, restored, { strictInvariants: extra.strictInvariants }) : []),
  ];
  const targets = evaluateTargets(extra.timing);
  const rep = buildReport({
    checks,
    targets,
    meta: { ...extra.meta, source_server_version: source.server_version, target_server_version: restored?.server_version },
  });
  writeFileSync(join(outdir, "report.json"), `${JSON.stringify(rep, null, 2)}\n`);
  writeFileSync(join(outdir, "report.md"), `${reportToMarkdown(rep)}\n`);
  console.log(reportToMarkdown(rep));
  process.exit(rep.verdict === "PASS" ? 0 : 2);
} else {
  die("subcomando desconocido");
}
