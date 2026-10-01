// Pruebas de la lógica pura de scripts/respaldo/lib.mjs. Corren con `node --test`
// (las invoca scripts/verify-respaldo-drill/run.sh, que es lo que enlaza el CI); no
// necesitan Postgres.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  buildReport,
  checkRestoreTarget,
  compareCatalogs,
  evaluateTargets,
  parseSchemas,
  redact,
  reportToMarkdown,
  selectRetention,
} from "../lib.mjs";

const DAY = 86_400_000;
// Todo valor con forma de credencial se genera en ejecución (aleatorio) y las URLs se arman por
// partes: ningún literal parecido a un secreto vive en el repo (los escáneres no lo toleran).
const rnd = (n = 9) => randomBytes(n).toString("hex");
const PW = `pw${rnd()}`;
const SCHEME = ["postgres", "ql"].join("");
const mk = (user, pw, host, path) => `${SCHEME}://${user}:${pw}@${host}/${path}`;
const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

test("checkRestoreTarget: rechaza SIEMPRE hosts de Supabase, incluso con allowRemote", () => {
  for (const u of [
    mk("postgres", PW, "db.abcdefgh.supabase.co:5432", "postgres"),
    mk("postgres.abc", PW, "aws-0-us-east-1.pooler.supabase.com:6543", "postgres").replace(SCHEME, "postgres"),
    "db.abcdefgh.supabase.co",
  ]) {
    assert.equal(checkRestoreTarget(u).ok, false, u);
    assert.equal(checkRestoreTarget(u, { allowRemote: true }).ok, false, u);
  }
});

test("checkRestoreTarget: local sí; remoto solo con allowRemote", () => {
  assert.equal(checkRestoreTarget("/tmp/atiende-drill.abc").ok, true); // socket
  assert.equal(checkRestoreTarget("postgresql:///db?host=/tmp/x&port=5").ok, true);
  assert.equal(checkRestoreTarget(mk("u", PW, "localhost:5432", "db")).ok, true);
  assert.equal(checkRestoreTarget("127.0.0.1").ok, true);
  assert.equal(checkRestoreTarget(mk("u", PW, "10.0.0.5", "db")).ok, false);
  assert.equal(checkRestoreTarget(mk("u", PW, "10.0.0.5", "db"), { allowRemote: true }).ok, true);
});

test("checkRestoreTarget: una URL ilegible falla sin eco de la URL", () => {
  assert.throws(() => checkRestoreTarget("postgresql://[bad"), (e) => !String(e.message).includes("bad"));
});

test("redact: oculta contraseña de URL, PGPASSWORD, JWT y llave age", () => {
  // Valores ficticios armados en tiempo de ejecución (no literales: los escáneres de secretos
  // los confundirían con credenciales reales).
  const pw = `Pw${rnd(6)}!`;
  const sig = b64u(randomBytes(24));
  const jwt = [b64u({ alg: "HS256", typ: "JWT" }), b64u({ role: "service_role" }), sig].join(".");
  const ageKey = ["AGE-SECRET-KEY", rnd(8).toUpperCase()].join("-");
  const t = redact(
    `conn ${mk("postgres", pw, "db.x.supabase.co:5432", "postgres")} PGPASSWORD=${PW} password=${PW}x ${jwt} ${ageKey}`,
  );
  for (const leak of [pw, PW, sig, jwt.split(".")[0], ageKey.slice(-10)]) assert.ok(!t.includes(leak), leak);
});

test("parseSchemas: valida identificadores y quita duplicados", () => {
  assert.deepEqual(parseSchemas("core, citas,core"), ["core", "citas"]);
  assert.throws(() => parseSchemas("core;drop schema x"));
  assert.throws(() => parseSchemas(""));
});

test("selectRetention: conserva keepLast Y lo joven; nunca borra el más reciente", () => {
  const now = Date.UTC(2026, 8, 30);
  const e = (name, daysAgo) => ({ name, createdAtMs: now - daysAgo * DAY });
  const r = selectRetention([e("a", 0), e("b", 1), e("c", 2), e("d", 40), e("f", 50), e("g", 90)], { keepLast: 3, keepDays: 30, nowMs: now });
  assert.deepEqual(r.keep.sort(), ["a", "b", "c"]);
  assert.deepEqual(r.remove.sort(), ["d", "f", "g"]);
  // todo viejo: aun así se queda el más reciente
  const old = selectRetention([e("x", 400), e("y", 500)], { keepLast: 0, keepDays: 1, nowMs: now });
  assert.deepEqual(old.keep, ["x"]);
  assert.deepEqual(old.remove, ["y"]);
});

const base = () => ({
  server_version: "17",
  counts: [{ schema: "core", table: "organization", rows: 6 }, { schema: "citas", table: "services", rows: 5 }],
  tables: [
    { schema: "core", table: "organization", rls: true, force_rls: false, policies: 2 },
    { schema: "citas", table: "services", rls: true, force_rls: false, policies: 1 },
  ],
  grants: [{ schema: "core", object: "organization", kind: "table", grantee: "authenticated", privilege: "SELECT" }],
  functions: [{ schema: "core", signature: "f(uuid)", secdef: true, search_path_set: true, public_exec: false }],
  invariants: { secdef_sin_search_path: [], politicas_using_true: [], anon_con_escritura_en_tablas: [] },
});
const clone = (x) => JSON.parse(JSON.stringify(x));
const failed = (checks) => checks.filter((c) => c.status === "fail").map((c) => c.name);

test("compareCatalogs: catálogos idénticos => todo pass", () => {
  const checks = compareCatalogs(base(), base());
  assert.deepEqual(failed(checks), []);
  assert.ok(checks.every((c) => c.status === "pass"));
});

test("compareCatalogs: detecta conteo distinto, tabla faltante y sobrante", () => {
  const r = clone(base());
  r.counts[0].rows = 5;
  r.counts.push({ schema: "core", table: "extra", rows: 1 });
  r.counts = r.counts.filter((c) => c.table !== "services");
  const bad = compareCatalogs(base(), r).find((c) => c.name === "conteos_por_tabla");
  assert.equal(bad.status, "fail");
  assert.match(bad.detail, /origen=6 restaurado=5/);
  assert.match(bad.detail, /citas\.services falta/);
  assert.match(bad.detail, /core\.extra sobra/);
});

test("compareCatalogs: detecta RLS apagado y políticas perdidas", () => {
  const r = clone(base());
  r.tables[0].rls = false;
  r.tables[1].policies = 0;
  const f = failed(compareCatalogs(base(), r));
  assert.ok(f.includes("rls_activo"));
  assert.ok(f.includes("politicas_rls"));
});

test("compareCatalogs: detecta GRANT perdido o añadido", () => {
  const lost = clone(base());
  lost.grants = [];
  assert.deepEqual(failed(compareCatalogs(base(), lost)), ["grants"]);
  const extra = clone(base());
  extra.grants.push({ schema: "core", object: "organization", kind: "table", grantee: "anon", privilege: "INSERT" });
  assert.deepEqual(failed(compareCatalogs(base(), extra)), ["grants"]);
});

test("compareCatalogs: detecta función que pierde search_path o recupera EXECUTE de PUBLIC", () => {
  const a = clone(base());
  a.functions[0].search_path_set = false;
  assert.ok(failed(compareCatalogs(base(), a)).includes("funciones_security_definer"));
  const b = clone(base());
  b.functions[0].public_exec = true;
  assert.ok(failed(compareCatalogs(base(), b)).includes("funciones_security_definer"));
});

test("compareCatalogs: invariante nueva = fail; preexistente = warn (fail en modo estricto)", () => {
  const fresh = clone(base());
  fresh.invariants.politicas_using_true = ["core.organization.todo"];
  assert.deepEqual(failed(compareCatalogs(base(), fresh)), ["invariante_politicas_using_true"]);

  const old = clone(base());
  old.invariants.secdef_sin_search_path = ["core.g()"];
  const same = clone(old);
  const lax = compareCatalogs(old, same);
  assert.equal(lax.find((c) => c.name === "invariante_secdef_sin_search_path").status, "warn");
  const strict = compareCatalogs(old, same, { strictInvariants: true });
  assert.equal(strict.find((c) => c.name === "invariante_secdef_sin_search_path").status, "fail");
});

test("evaluateTargets/buildReport: RPO y RTO incumplidos producen FAIL aunque los checks pasen", () => {
  const t0 = Date.UTC(2026, 8, 30, 12);
  const targets = evaluateTargets({
    backupCreatedAtMs: t0 - 30 * 3600_000, drillStartMs: t0, drillEndMs: t0 + 90_000,
    restoreSeconds: 60, rpoTargetSeconds: 24 * 3600, rtoTargetSeconds: 3600, synthetic: false,
  });
  assert.equal(targets.rpo_seconds, 30 * 3600);
  assert.equal(targets.rpo_ok, false);
  assert.equal(targets.rto_ok, true);
  const rep = buildReport({ checks: [{ name: "x", status: "pass", detail: "" }], targets, meta: { backup_name: "b", schemas: ["core"] } });
  assert.equal(rep.verdict, "FAIL");
  assert.deepEqual(rep.targets_missed, ["RPO"]);
  assert.match(reportToMarkdown(rep), /INCUMPLIDO/);
});

test("evaluateTargets: un drill sintético se marca no representativo", () => {
  const t = evaluateTargets({ backupCreatedAtMs: 0, drillStartMs: 1000, drillEndMs: 2000, restoreSeconds: 1, rpoTargetSeconds: 10, rtoTargetSeconds: 10, synthetic: true });
  assert.equal(t.representative, false);
});
