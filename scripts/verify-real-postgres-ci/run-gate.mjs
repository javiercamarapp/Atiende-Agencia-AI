#!/usr/bin/env node
// run-gate.mjs — convierte un directorio scripts/verify-*/ (bootstrap.sql +
// post-migrations.sql + assertions.sql, ya auditados y verificados a mano) en un
// gate de CI totalmente automático, sin intervención manual.
//
// Qué hace, contra un Postgres YA CORRIENDO (host/puerto vía variables de entorno
// estándar de psql — PGHOST/PGPORT/PGUSER/PGPASSWORD; en GitHub Actions lo da el
// `services: postgres:` del workflow):
//
//   1. Crea una base de datos efímera dedicada (drop + create).
//   2. Aplica bootstrap.sql (mock mínimo de plataforma Supabase), ANTES de las
//      migraciones — mismo orden que el run.sh manual de cada verify-*/ (auth.uid()
//      y los roles anon/authenticated/service_role tienen que existir antes de
//      que cualquier migración los use).
//   3. Aplica supabase/migrations/*.sql en orden (las migraciones REALES).
//   4. Aplica post-migrations.sql (el mismo par de archivos que ya usa el run.sh
//      manual de cada verify-*/, sin tocarlos) — GRANT USAGE de schema.
//   5. Parsea assertions.sql (SIN modificarlo) y ejecuta cada escenario
//      `begin; ... rollback;` como su propia conexión psql, determinando el
//      resultado esperado a partir de las convenciones que el propio archivo ya
//      usa (ver `deriveExpectation` abajo) — NO por lectura humana de la salida.
//   6. Imprime un reporte pass/fail por escenario y sale con código != 0 si
//      cualquier paso (migraciones, bootstrap, post-migraciones, o cualquier
//      escenario) no se comporta como el archivo dice que debe comportarse.
//
// Qué NO hace (ver también cada scripts/verify-*/README.md):
//   - No reemplaza `scripts/verify-*/run.sh` (ese sigue sirviendo para correr la
//     misma verificación a mano contra un Postgres local efímero vía
//     initdb/pg_ctl). Este script asume que YA hay un Postgres escuchando.
//   - No modifica ni reinterpreta el contenido SQL de bootstrap.sql/
//     post-migrations.sql/assertions.sql — son la fuente de verdad auditada.
//   - Solo cubre lo que cada assertions.sql ya cubre (ver el README de cada
//     verify-*/ para el alcance exacto de cada fix).
//
// Uso:
//   node scripts/verify-real-postgres-ci/run-gate.mjs
//     (sin argumento: descubre y corre TODO scripts/verify-*/ que tenga
//      bootstrap.sql + post-migrations.sql + assertions.sql — incluye
//      automáticamente cualquier verify-* nuevo que se agregue después)
//   node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-outbox-grants
//   node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-rentas-cron-rls
//   node scripts/verify-real-postgres-ci/run-gate.mjs --shard 2/6 --report r.json
//     (CI: corre solo la parte i de N del conjunto descubierto; ver "Shards")
//   node scripts/verify-real-postgres-ci/run-gate.mjs --list-shards 6
//     (imprime el reparto y comprueba que es una partición exacta; no toca Postgres)
//   node scripts/verify-real-postgres-ci/run-gate.mjs --verify-reports dir
//     (agregador de CI: comprueba que los --report de los N shards cubren
//      EXACTAMENTE lo descubierto, cada carpeta una sola vez, y que ninguno falló)
//
// Plantillas de base (rapidez, misma semántica): bootstrap.sql + las ~300
// migraciones son idénticas para todas las carpetas que comparten el mismo
// bootstrap.sql, y eran el 90% del tiempo (≈16 s de ≈18 s por carpeta). Ahora se
// construyen UNA vez por bootstrap distinto como base plantilla y cada carpeta
// hace `create database … template …` (copia exacta del estado), luego aplica su
// propio post-migrations.sql y sus escenarios, igual que antes. `--no-template`
// restituye el camino antiguo (una base nueva + todas las migraciones por carpeta).
//
// Shards: `--shard i/N` reparte las carpetas con un reparto determinista por
// costo (nº de escenarios + constante por carpeta, voraz de mayor a menor, empate
// por nombre). El propio runner comprueba antes de correr que la partición es
// exacta (cada carpeta en un solo shard, ninguna sin shard). Sin `--shard` corre
// TODO, como siempre (ejecución local y `npm run` existentes).
//
// Variables de entorno relevantes (todas con default razonable para correr en
// GitHub Actions con el servicio `postgres:16` estándar, o contra un Postgres
// local ya arrancado):
//   PGHOST      default: 127.0.0.1
//   PGPORT      default: 5432
//   PGUSER      default: postgres
//   PGPASSWORD  default: postgres
//   PGSSLMODE   no se fuerza — se hereda del entorno si está presente

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const PG_ENV = {
  PGHOST: process.env.PGHOST || "127.0.0.1",
  PGPORT: process.env.PGPORT || "5432",
  PGUSER: process.env.PGUSER || "postgres",
  PGPASSWORD: process.env.PGPASSWORD || "postgres",
};

function runPsqlFile(dbName, filePath, extraArgs = []) {
  return execFileSync(
    "psql",
    ["-h", PG_ENV.PGHOST, "-p", PG_ENV.PGPORT, "-U", PG_ENV.PGUSER, "-d", dbName, "-v", "ON_ERROR_STOP=1", ...extraArgs, "-f", filePath],
    { env: { ...process.env, ...PG_ENV }, encoding: "utf8" },
  );
}

function withTempSqlFile(sql, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "atiende-pg-ci-"));
  const file = path.join(dir, "step.sql");
  writeFileSync(file, sql, "utf8");
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createDatabase(dbName) {
  execFileSync(
    "psql",
    ["-h", PG_ENV.PGHOST, "-p", PG_ENV.PGPORT, "-U", PG_ENV.PGUSER, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${dbName};`],
    { env: { ...process.env, ...PG_ENV }, encoding: "utf8" },
  );
  execFileSync(
    "psql",
    ["-h", PG_ENV.PGHOST, "-p", PG_ENV.PGPORT, "-U", PG_ENV.PGUSER, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `create database ${dbName};`],
    { env: { ...process.env, ...PG_ENV }, encoding: "utf8" },
  );
}

function createDatabaseFromTemplate(dbName, templateName) {
  const run = (sql) =>
    execFileSync(
      "psql",
      ["-h", PG_ENV.PGHOST, "-p", PG_ENV.PGPORT, "-U", PG_ENV.PGUSER, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql],
      { env: { ...process.env, ...PG_ENV }, encoding: "utf8" },
    );
  run(`drop database if exists ${dbName};`);
  run(`create database ${dbName} template ${templateName};`);
}

function dropDatabase(dbName) {
  try {
    execFileSync(
      "psql",
      ["-h", PG_ENV.PGHOST, "-p", PG_ENV.PGPORT, "-U", PG_ENV.PGUSER, "-d", "postgres", "-c", `drop database if exists ${dbName};`],
      { env: { ...process.env, ...PG_ENV }, encoding: "utf8" },
    );
  } catch {
    // best-effort cleanup — no debe hacer fallar el gate si el drop final falla
  }
}

function applyMigrations(dbName) {
  const migrationsDir = path.join(REPO_ROOT, "supabase", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error(`no se encontró ninguna migración .sql en ${migrationsDir}`);
  }
  for (const f of files) {
    runPsqlFile(dbName, path.join(migrationsDir, f));
  }
  return files.length;
}

// --- parseo de assertions.sql ------------------------------------------------
//
// Convenciones YA presentes en el archivo (no inventadas por este script, ver
// scripts/verify-outbox-grants/assertions.sql y scripts/verify-rentas-cron-rls/
// assertions.sql):
//   - Cada escenario vive en su propio bloque `begin; ... rollback;` en líneas
//     propias (columna 0), sin anidar.
//   - Un escenario que DEBE terminar en ERROR usa el alias de columna
//     `as should_fail` en la consulta que se espera que falle.
//   - Un escenario donde RLS filtra en silencio (sin lanzar excepción) usa un
//     alias `..._deberia_ser_N` (el valor esperado es el entero N) o
//     `deberia_fallar` (equivalente a `deberia_ser_0`).
//   - Cualquier otro escenario debe completar SIN error (no se valida un valor
//     puntual, solo ausencia de excepción).
const SHOULD_FAIL_RE = /\bas\s+should_fail\b/i;
const DEBERIA_SER_N_RE = /deberia_ser_(\d+)/i;
const DEBERIA_FALLAR_RE = /\bdeberia_fallar\b/i;

function deriveExpectation(blockText) {
  if (SHOULD_FAIL_RE.test(blockText)) return { kind: "error" };
  const m = blockText.match(DEBERIA_SER_N_RE);
  if (m) return { kind: "value", expected: m[1], matchIndex: m.index, matchText: m[0] };
  if (DEBERIA_FALLAR_RE.test(blockText)) {
    const idx = blockText.search(DEBERIA_FALLAR_RE);
    return { kind: "value", expected: "0", matchIndex: idx, matchText: "deberia_fallar" };
  }
  return { kind: "success" };
}

// Para escenarios "value": aísla, dentro del bloque begin;...rollback;, todo lo
// que precede al alias objetivo (setup de rol/sesión, y cualquier INSERT que el
// propio escenario necesite antes de su SELECT de verificación) más la propia
// sentencia objetivo — evita tener que contar líneas de salida de sentencias
// intermedias (set_config también imprime una línea con -t -A).
function isolateTargetStatement(innerText, matchIndex) {
  const afterMatch = innerText.slice(matchIndex);
  // termina la sentencia objetivo en el siguiente ';' seguido de fin de línea
  const endRel = afterMatch.search(/;\s*\n/);
  const targetEnd = endRel === -1 ? innerText.length : matchIndex + endRel + 1;
  return innerText.slice(0, targetEnd);
}

// Algunos assertions.sql (p. ej. verify-outbox-grants/) rematan con un \echo
// final que enumera EXPLÍCITAMENTE, por número, qué escenarios deben terminar
// en ERROR — ej.: "los escenarios 2/4/7/10/11/14/16 deben terminar en ERROR".
// Esa lista es la fuente de verdad definitiva y anula al heurístico de alias
// (que no detecta un escenario esperado-a-fallar cuando la consulta no usa
// "select *"/una llamada sin alias posible, como los escenarios 4/14/16). Si
// el archivo no trae una línea así (p. ej. verify-rentas-cron-rls/, que solo
// describe el criterio en prosa), esta función no encuentra nada y el
// heurístico de alias por bloque sigue siendo la única fuente.
function parseExplicitErrorList(sql) {
  const re = /(\d+(?:\/\d+)+)\s+deben\s+terminar\s+en\s+ERROR/i;
  const m = sql.match(re);
  if (!m) return new Set();
  return new Set(m[1].split("/").map((s) => Number.parseInt(s, 10)));
}

function parseAssertions(sql) {
  const steps = [];
  const explicitErrorScenarios = parseExplicitErrorList(sql);
  const scenarioRe = /^begin;\n([\s\S]*?)\nrollback;/gm;
  let lastIndex = 0;
  let m;
  let n = 0;
  while ((m = scenarioRe.exec(sql)) !== null) {
    const fixtureText = sql.slice(lastIndex, m.index).trim();
    if (fixtureText.length > 0) {
      // filtra líneas puramente de metacomandos/echo/comentarios: si no queda
      // SQL real, no vale la pena una conexión aparte.
      const meaningful = fixtureText
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t.length > 0 && !t.startsWith("--") && !t.startsWith("\\echo") && !t.startsWith("\\set") && !t.startsWith("\\pset");
        })
        .join("\n")
        .trim();
      if (meaningful.length > 0) {
        steps.push({ type: "fixture", sql: fixtureText });
      }
    }
    n += 1;
    const inner = m[1];
    const blockFull = m[0]; // "begin;\n...\nrollback;"
    const expectation = deriveExpectation(blockFull);
    if (explicitErrorScenarios.has(n)) {
      if (expectation.kind === "success") {
        expectation.kind = "error";
      } else if (expectation.kind === "value") {
        console.warn(
          `   [WARN] #${n}: la lista explícita de ERRORes del archivo lo incluye, pero su alias de columna indica un chequeo de valor — se respeta el chequeo de valor (revisar si assertions.sql cambió de forma).`,
        );
      }
    }
    // label: última línea \echo antes de este bloque
    const before = sql.slice(0, m.index);
    const echoMatches = [...before.matchAll(/^\\echo\s+'(.*)'\s*$/gm)];
    const label = echoMatches.length > 0 ? echoMatches[echoMatches.length - 1][1] : `escenario ${n}`;
    steps.push({
      type: "scenario",
      index: n,
      label,
      blockText: blockFull,
      innerText: inner,
      expectation,
    });
    lastIndex = scenarioRe.lastIndex;
  }
  return steps;
}

function runScenario(dbName, step) {
  const { expectation } = step;
  if (expectation.kind === "success" || expectation.kind === "error") {
    let stderrOut = "";
    let ok;
    try {
      withTempSqlFile(step.blockText + "\n", (file) => runPsqlFile(dbName, file));
      ok = expectation.kind === "success";
    } catch (err) {
      stderrOut = (err.stderr || err.message || "").toString();
      ok = expectation.kind === "error";
    }
    return { ok, detail: ok ? "" : stderrOut || "(sin salida de error — se esperaba un ERROR de Postgres y no ocurrió)" };
  }
  // expectation.kind === "value"
  const matchIndexInInner = expectation.matchIndex - step.blockText.indexOf(step.innerText);
  const isolatedInner = isolateTargetStatement(step.innerText, matchIndexInInner);
  const isolatedScript = `begin;\n${isolatedInner}\nrollback;\n`;
  try {
    const out = withTempSqlFile(isolatedScript, (file) => runPsqlFile(dbName, file, ["-t", "-A", "-q"]));
    const lines = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const actual = lines.length > 0 ? lines[lines.length - 1] : "";
    const ok = actual === expectation.expected;
    return {
      ok,
      detail: ok ? "" : `esperado ${expectation.expected}, obtuve "${actual}" (salida completa: ${JSON.stringify(out)})`,
    };
  } catch (err) {
    return { ok: false, detail: `error inesperado ejecutando el chequeo de valor: ${(err.stderr || err.message || "").toString()}` };
  }
}

function existsSyncSafe(p) {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

// Descubre automáticamente cualquier scripts/verify-*/ que siga el mismo
// contrato de 3 archivos (bootstrap.sql + post-migrations.sql + assertions.sql)
// — así un verify-* nuevo que se agregue después queda cubierto por el gate de
// CI sin tener que tocar el workflow ni este script.
function discoverVerifyDirs() {
  const scriptsDir = path.join(REPO_ROOT, "scripts");
  return readdirSync(scriptsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("verify-"))
    .map((e) => path.join(scriptsDir, e.name))
    .filter(
      (dir) =>
        existsSyncSafe(path.join(dir, "bootstrap.sql")) &&
        existsSyncSafe(path.join(dir, "post-migrations.sql")) &&
        existsSyncSafe(path.join(dir, "assertions.sql")),
    )
    .sort();
}

// Una plantilla por bootstrap.sql distinto (clave: sha256 del contenido). Se
// construye la primera vez que una carpeta la necesita; si falla, el error queda
// cacheado y TODAS las carpetas de ese bootstrap fallan con ese mismo error (nunca
// se salta una carpeta en silencio).
const templateCache = new Map();

function templateNameFor(bootstrapPath) {
  const hash = createHash("sha256").update(readFileSync(bootstrapPath)).digest("hex").slice(0, 12);
  return `atiende_ci_tpl_${hash}`;
}

function ensureTemplate(bootstrapPath) {
  const tpl = templateNameFor(bootstrapPath);
  if (!templateCache.has(tpl)) {
    const entry = { name: tpl };
    try {
      console.log(`\n=== plantilla "${tpl}": bootstrap.sql (${path.relative(REPO_ROOT, bootstrapPath)}) + migraciones reales ===`);
      createDatabase(tpl);
      console.log(`==> aplicando bootstrap.sql (mock mínimo de plataforma, antes de las migraciones — mismo orden que run.sh)`);
      runPsqlFile(tpl, bootstrapPath);
      console.log(`==> aplicando migraciones reales de supabase/migrations/`);
      entry.count = applyMigrations(tpl);
      console.log(`    ${entry.count} migraciones aplicadas sin error`);
    } catch (err) {
      entry.error = err;
    }
    templateCache.set(tpl, entry);
  }
  const entry = templateCache.get(tpl);
  if (entry.error) throw entry.error;
  return entry;
}

function dropTemplates() {
  for (const { name } of templateCache.values()) dropDatabase(name);
}

async function runOneGate(verifyDir, keepDb, useTemplates) {
  const name = path.basename(verifyDir);
  const dbName = `atiende_ci_${name.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;
  const outcome = { name, failed: false, pass: 0, scenarios: 0 };

  const bootstrapPath = path.join(verifyDir, "bootstrap.sql");
  const postMigrationsPath = path.join(verifyDir, "post-migrations.sql");
  const assertionsPath = path.join(verifyDir, "assertions.sql");
  for (const p of [bootstrapPath, postMigrationsPath, assertionsPath]) {
    if (!existsSyncSafe(p)) {
      console.error(`falta ${p} — ¿es este un directorio scripts/verify-*/ válido?`);
      outcome.failed = true;
      return outcome;
    }
  }

  console.log(`\n=== ${name}: preparando base de datos efímera "${dbName}" en ${PG_ENV.PGHOST}:${PG_ENV.PGPORT} ===`);

  let failed = false;
  try {
    if (useTemplates) {
      const tpl = ensureTemplate(bootstrapPath);
      console.log(`==> clonando la plantilla "${tpl.name}" (bootstrap.sql + ${tpl.count} migraciones ya aplicadas, idéntico a aplicarlas aquí)`);
      createDatabaseFromTemplate(dbName, tpl.name);
    } else {
      createDatabase(dbName);
      console.log(`==> aplicando bootstrap.sql (mock mínimo de plataforma, antes de las migraciones — mismo orden que run.sh)`);
      runPsqlFile(dbName, bootstrapPath);

      console.log(`==> aplicando migraciones reales de supabase/migrations/`);
      const count = applyMigrations(dbName);
      console.log(`    ${count} migraciones aplicadas sin error`);
    }

    console.log(`==> aplicando post-migrations.sql (GRANT USAGE de schema)`);
    runPsqlFile(dbName, postMigrationsPath);

    console.log(`==> parseando y ejecutando assertions.sql`);
    const assertionsSql = readFileSync(assertionsPath, "utf8");
    const steps = parseAssertions(assertionsSql);
    const scenarios = steps.filter((s) => s.type === "scenario");
    if (scenarios.length === 0) {
      throw new Error("no se encontró ningún escenario begin;/rollback; en assertions.sql — ¿cambió el formato del archivo?");
    }
    outcome.scenarios = scenarios.length;

    let passCount = 0;
    for (const step of steps) {
      if (step.type === "fixture") {
        withTempSqlFile(step.sql + "\n", (file) => runPsqlFile(dbName, file));
        continue;
      }
      const result = runScenario(dbName, step);
      const expKind = step.expectation.kind === "value" ? `valor=${step.expectation.expected}` : step.expectation.kind;
      if (result.ok) {
        passCount += 1;
        console.log(`   [PASS] #${step.index} (${expKind}) — ${step.label}`);
      } else {
        failed = true;
        console.log(`   [FAIL] #${step.index} (${expKind}) — ${step.label}`);
        console.log(`          ${result.detail.split("\n").join("\n          ")}`);
      }
    }
    outcome.pass = passCount;

    console.log(`\n=== ${name}: ${passCount}/${scenarios.length} escenarios OK ===`);
    if (failed) {
      console.log(`=== ${name}: GATE FALLIDO — al menos un escenario no se comportó como assertions.sql documenta ===`);
    }
  } catch (err) {
    failed = true;
    console.error(`\n=== ${name}: GATE FALLIDO — error preparando el entorno (no llegó a correr los escenarios) ===`);
    console.error((err.stderr || err.stdout || err.message || err).toString());
  } finally {
    if (!keepDb) {
      dropDatabase(dbName);
    }
  }

  outcome.failed = failed;
  return outcome;
}

// --- shards ------------------------------------------------------------------

// Costo estimado de una carpeta: cada escenario es una conexión psql, y cada
// carpeta paga un clon de plantilla + post-migrations (constante). Determinista:
// depende solo del contenido del repo.
const PER_DIR_COST = 6;
function estimateCost(verifyDir) {
  const sql = readFileSync(path.join(verifyDir, "assertions.sql"), "utf8");
  const scenarios = (sql.match(/^begin;$/gm) || []).length;
  return PER_DIR_COST + scenarios;
}

// Reparto voraz (LPT): carpetas por costo descendente (empate: nombre), cada una
// al shard con menos costo acumulado (empate: el de menor índice). Devuelve N
// arreglos (índice 0 = shard 1) de rutas, ordenadas por nombre dentro de cada shard.
function partitionShards(dirs, total) {
  const bins = Array.from({ length: total }, () => ({ cost: 0, dirs: [] }));
  const items = dirs
    .map((d) => ({ d, cost: estimateCost(d), name: path.basename(d) }))
    .sort((a, b) => b.cost - a.cost || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const it of items) {
    let best = 0;
    for (let i = 1; i < total; i += 1) if (bins[i].cost < bins[best].cost) best = i;
    bins[best].cost += it.cost;
    bins[best].dirs.push(it.d);
  }
  return bins.map((b) => ({ cost: b.cost, dirs: b.dirs.sort() }));
}

// Garantía de cobertura: la unión de los N shards es EXACTAMENTE el conjunto
// descubierto; ninguna carpeta queda sin shard ni en dos. Lanza si no.
function assertExactPartition(allDirs, bins) {
  const seen = new Map();
  bins.forEach((b, i) => {
    for (const d of b.dirs) {
      const n = path.basename(d);
      if (seen.has(n)) throw new Error(`partición inválida: ${n} está en el shard ${seen.get(n)} y en el ${i + 1}`);
      seen.set(n, i + 1);
    }
  });
  const expected = new Set(allDirs.map((d) => path.basename(d)));
  const missing = [...expected].filter((n) => !seen.has(n));
  const extra = [...seen.keys()].filter((n) => !expected.has(n));
  if (missing.length || extra.length || seen.size !== expected.size) {
    throw new Error(`partición inválida: sin shard=[${missing.join(", ")}] sobrantes=[${extra.join(", ")}]`);
  }
}

function parseShardSpec(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(spec || "");
  if (!m) throw new Error(`--shard espera "i/N" (p. ej. 2/6), recibí ${JSON.stringify(spec)}`);
  const i = Number.parseInt(m[1], 10);
  const n = Number.parseInt(m[2], 10);
  if (n < 1 || i < 1 || i > n) throw new Error(`--shard fuera de rango: ${spec}`);
  return { i, n };
}

// Agregador: lee los --report de cada shard (aunque estén en subcarpetas por
// artefacto) y exige que lo EJECUTADO cubra exactamente lo descubierto.
function walkJson(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walkJson(p, out);
    else if (e.endsWith(".json")) out.push(p);
  }
  return out;
}

function verifyReports(dir) {
  const reports = walkJson(dir).map((f) => JSON.parse(readFileSync(f, "utf8")));
  if (reports.length === 0) throw new Error(`no hay ningún reporte de shard en ${dir}`);
  const total = reports[0].total;
  const problems = [];
  const shardsSeen = new Set();
  const executed = new Map();
  let scenarios = 0;
  let passed = 0;
  for (const r of reports) {
    if (r.total !== total) problems.push(`reportes con N distinto (${r.total} vs ${total})`);
    if (shardsSeen.has(r.shard)) problems.push(`shard ${r.shard} reportado dos veces`);
    shardsSeen.add(r.shard);
    for (const res of r.results) {
      if (executed.has(res.name)) problems.push(`${res.name} ejecutada en dos shards (${executed.get(res.name)} y ${r.shard})`);
      executed.set(res.name, r.shard);
      scenarios += res.scenarios;
      passed += res.pass;
      if (res.failed) problems.push(`${res.name} (shard ${r.shard}) FALLÓ`);
    }
  }
  for (let i = 1; i <= total; i += 1) if (!shardsSeen.has(i)) problems.push(`falta el reporte del shard ${i}/${total}`);
  const discovered = discoverVerifyDirs().map((d) => path.basename(d));
  const missing = discovered.filter((n) => !executed.has(n));
  const extra = [...executed.keys()].filter((n) => !discovered.includes(n));
  if (missing.length) problems.push(`carpetas descubiertas que NINGÚN shard ejecutó: ${missing.join(", ")}`);
  if (extra.length) problems.push(`carpetas ejecutadas que ya no se descubren: ${extra.join(", ")}`);
  console.log(`cobertura: ${executed.size} carpetas ejecutadas en ${shardsSeen.size}/${total} shards; ${discovered.length} descubiertas; ${passed}/${scenarios} escenarios OK`);
  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    return false;
  }
  console.log("cobertura exacta: cada carpeta descubierta se ejecutó en un único shard y todas pasaron");
  return true;
}

function takeOption(argv, name) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx !== -1) return argv[idx + 1];
  return undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const keepDb = argv.includes("--keep-db");
  const useTemplates = !argv.includes("--no-template");
  const optionValues = new Set(
    ["--shard", "--report", "--list-shards", "--verify-reports"].map((n) => takeOption(argv, n)).filter((v) => v !== undefined),
  );
  const explicitArg = argv.find((a) => !a.startsWith("--") && !optionValues.has(a)) ?? null;

  const verifyReportsDir = takeOption(argv, "--verify-reports");
  if (verifyReportsDir !== undefined) {
    process.exit(verifyReports(verifyReportsDir) ? 0 : 1);
  }

  const listShards = takeOption(argv, "--list-shards");
  if (listShards !== undefined) {
    const n = Number.parseInt(listShards, 10);
    const all = discoverVerifyDirs();
    const bins = partitionShards(all, n);
    assertExactPartition(all, bins);
    bins.forEach((b, i) => console.log(`shard ${i + 1}/${n}: ${b.dirs.length} carpetas, costo ${b.cost}`));
    console.log(`partición exacta: ${all.length} carpetas descubiertas = ${bins.reduce((a, b) => a + b.dirs.length, 0)} asignadas`);
    process.exit(0);
  }

  let verifyDirs = explicitArg
    ? [path.isAbsolute(explicitArg) ? explicitArg : path.join(REPO_ROOT, explicitArg)]
    : discoverVerifyDirs();

  const shardSpec = takeOption(argv, "--shard");
  let shard = null;
  if (shardSpec !== undefined) {
    if (explicitArg) {
      console.error("--shard no se combina con una carpeta explícita");
      process.exit(2);
    }
    shard = parseShardSpec(shardSpec);
    const all = verifyDirs;
    const bins = partitionShards(all, shard.n);
    assertExactPartition(all, bins);
    verifyDirs = bins[shard.i - 1].dirs;
    console.log(
      `shard ${shard.i}/${shard.n}: ${verifyDirs.length} de ${all.length} carpetas (partición exacta verificada): ${verifyDirs.map((d) => path.basename(d)).join(" ")}`,
    );
    if (verifyDirs.length === 0) {
      console.error(`el shard ${shard.i}/${shard.n} quedó vacío — N=${shard.n} es mayor que el número de carpetas`);
      process.exit(2);
    }
  }

  if (verifyDirs.length === 0) {
    console.error(
      "uso: node run-gate.mjs [<scripts/verify-*-dir>] [--shard i/N] [--report archivo.json] [--keep-db] [--no-template]\n" +
        "sin argumento posicional, descubre automáticamente todo scripts/verify-*/ con bootstrap.sql+post-migrations.sql+assertions.sql — no se encontró ninguno.",
    );
    process.exit(2);
  }

  const results = [];
  try {
    for (const verifyDir of verifyDirs) {
      results.push(await runOneGate(verifyDir, keepDb, useTemplates));
    }
  } finally {
    if (!keepDb) dropTemplates();
  }
  const anyFailed = results.some((r) => r.failed);

  const reportPath = takeOption(argv, "--report");
  if (reportPath !== undefined) {
    writeFileSync(
      reportPath,
      JSON.stringify({ shard: shard ? shard.i : 1, total: shard ? shard.n : 1, results }, null, 2),
      "utf8",
    );
  }
  const scen = results.reduce((a, r) => a + r.scenarios, 0);
  const pass = results.reduce((a, r) => a + r.pass, 0);
  console.log(`\nRESUMEN: ${results.length} carpetas, ${pass}/${scen} escenarios OK, ${results.filter((r) => r.failed).length} carpetas con fallo`);
  process.exit(anyFailed ? 1 : 0);
}

main();
