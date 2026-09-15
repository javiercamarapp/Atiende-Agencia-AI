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
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
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

async function runOneGate(verifyDir, keepDb) {
  const name = path.basename(verifyDir);
  const dbName = `atiende_ci_${name.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;

  const bootstrapPath = path.join(verifyDir, "bootstrap.sql");
  const postMigrationsPath = path.join(verifyDir, "post-migrations.sql");
  const assertionsPath = path.join(verifyDir, "assertions.sql");
  for (const p of [bootstrapPath, postMigrationsPath, assertionsPath]) {
    if (!existsSyncSafe(p)) {
      console.error(`falta ${p} — ¿es este un directorio scripts/verify-*/ válido?`);
      return true;
    }
  }

  console.log(`\n=== ${name}: preparando base de datos efímera "${dbName}" en ${PG_ENV.PGHOST}:${PG_ENV.PGPORT} ===`);
  createDatabase(dbName);

  let failed = false;
  try {
    console.log(`==> aplicando bootstrap.sql (mock mínimo de plataforma, antes de las migraciones — mismo orden que run.sh)`);
    runPsqlFile(dbName, bootstrapPath);

    console.log(`==> aplicando migraciones reales de supabase/migrations/`);
    const count = applyMigrations(dbName);
    console.log(`    ${count} migraciones aplicadas sin error`);

    console.log(`==> aplicando post-migrations.sql (GRANT USAGE de schema)`);
    runPsqlFile(dbName, postMigrationsPath);

    console.log(`==> parseando y ejecutando assertions.sql`);
    const assertionsSql = readFileSync(assertionsPath, "utf8");
    const steps = parseAssertions(assertionsSql);
    const scenarios = steps.filter((s) => s.type === "scenario");
    if (scenarios.length === 0) {
      throw new Error("no se encontró ningún escenario begin;/rollback; en assertions.sql — ¿cambió el formato del archivo?");
    }

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

  return failed;
}

async function main() {
  const keepDb = process.argv.includes("--keep-db");
  const explicitArg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;

  const verifyDirs = explicitArg
    ? [path.isAbsolute(explicitArg) ? explicitArg : path.join(REPO_ROOT, explicitArg)]
    : discoverVerifyDirs();

  if (verifyDirs.length === 0) {
    console.error(
      "uso: node run-gate.mjs [<scripts/verify-*-dir>] [--keep-db]\n" +
        "sin argumento posicional, descubre automáticamente todo scripts/verify-*/ con bootstrap.sql+post-migrations.sql+assertions.sql — no se encontró ninguno.",
    );
    process.exit(2);
  }

  let anyFailed = false;
  for (const verifyDir of verifyDirs) {
    const failed = await runOneGate(verifyDir, keepDb);
    if (failed) anyFailed = true;
  }
  process.exit(anyFailed ? 1 : 0);
}

main();
