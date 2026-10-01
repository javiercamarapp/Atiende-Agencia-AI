// lib.mjs — lógica pura (sin red, sin Postgres, sin escribir fuera de lo que se le pasa)
// del respaldo lógico + drill de restauración (PL-05). Todo lo que decide algo
// importante (¿este destino es seguro para restaurar?, ¿qué respaldos se podan?,
// ¿el catálogo restaurado coincide con el de origen?, ¿se cumplió RPO/RTO?) vive
// aquí para poder probarse con `node --test` sin levantar nada. Los .sh solo
// orquestan pg_dump / pg_restore / initdb.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

// Esquemas de aplicación que se respaldan. `mcp_cfdi` NO está: es un esquema de
// utilería de un MCP, no datos de negocio de los tenants (si Javier lo quiere,
// BACKUP_SCHEMAS lo reemplaza o BACKUP_EXTRA_SCHEMAS lo agrega).
export const DEFAULT_SCHEMAS = [
  "core",
  "citas",
  "hoteles",
  "rentas",
  "licitaciones",
  "despachos",
  "restaurantes",
];

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/** Valida una lista de esquemas (se interpola en SQL: solo identificadores simples). */
export function parseSchemas(raw) {
  const list = String(raw ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (list.length === 0) throw new Error("lista de esquemas vacía");
  for (const s of list) {
    if (!SCHEMA_RE.test(s)) throw new Error(`nombre de esquema inválido: ${JSON.stringify(s)}`);
  }
  return [...new Set(list)];
}

/** Extrae el host de una URL postgres:// o de un valor PGHOST (ruta de socket => "" y local). */
export function parseHost(urlOrHost) {
  const v = String(urlOrHost ?? "").trim();
  if (v === "") return { host: "", socket: true };
  if (v.startsWith("/")) return { host: v, socket: true };
  if (/^postgres(ql)?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      const q = u.searchParams.get("host");
      if (q?.startsWith("/")) return { host: q, socket: true };
      return { host: u.hostname.toLowerCase(), socket: u.hostname === "" };
    } catch {
      throw new Error("URL de conexión ilegible (no se imprime por si contiene credenciales)");
    }
  }
  return { host: v.toLowerCase(), socket: false };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Guardia de la RESTAURACIÓN: el destino debe ser local/efímero. Un host de
 * Supabase se rechaza SIEMPRE, incluso con allowRemote (restaurar encima de la
 * base real es justo lo que este drill nunca debe poder hacer).
 */
export function checkRestoreTarget(urlOrHost, { allowRemote = false } = {}) {
  const { host, socket } = parseHost(urlOrHost);
  if (/(^|\.)supabase\.(co|com|net)$/.test(host) || host.includes("pooler.supabase")) {
    return { ok: false, reason: "el destino es un host de Supabase: la restauración jamás corre contra ahí" };
  }
  if (socket || LOOPBACK.has(host)) return { ok: true, reason: "destino local" };
  if (allowRemote) return { ok: true, reason: "destino remoto permitido explícitamente (RESTORE_ALLOW_NON_LOCAL=1)" };
  return { ok: false, reason: "el destino no es local; para una base NUEVA remota fija RESTORE_ALLOW_NON_LOCAL=1" };
}

/** Quita credenciales y secretos de un texto antes de imprimirlo/guardarlo. */
export function redact(text) {
  return String(text)
    .replace(/(postgres(?:ql)?:\/\/)([^\s/@:]*)(?::[^\s@]*)?@/gi, "$1***@")
    .replace(/(PGPASSWORD=)\S+/g, "$1***")
    .replace(/(password=)[^\s&]+/gi, "$1***")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "***jwt***")
    .replace(/AGE-SECRET-KEY-[A-Z0-9]+/g, "***age-key***")
    .replace(/(sb_secret_|sbp_)[A-Za-z0-9_]+/g, "$1***");
}

/**
 * Retención. `entries`: [{name, createdAtMs}]. Se conservan los `keepLast` más
 * recientes Y todo lo más joven que `keepDays`. Nunca se borra el más reciente.
 */
export function selectRetention(entries, { keepLast = 7, keepDays = 30, nowMs = Date.now() } = {}) {
  const sorted = [...entries].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const cutoff = nowMs - keepDays * 86_400_000;
  const keep = [];
  const remove = [];
  sorted.forEach((e, i) => {
    if (i === 0 || i < keepLast || e.createdAtMs >= cutoff) keep.push(e.name);
    else remove.push(e.name);
  });
  return { keep, remove };
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

const key = (r, ...f) => f.map((k) => r[k]).join(".");
const indexBy = (rows, ...f) => new Map((rows ?? []).map((r) => [key(r, ...f), r]));

/**
 * Compara el catálogo capturado en el respaldo (origen, misma foto que el dump)
 * con el de la base restaurada. Devuelve una lista de checks {name,status,detail}.
 * status: "pass" | "fail" | "warn".
 */
export function compareCatalogs(source, restored, { strictInvariants = false } = {}) {
  const checks = [];
  const add = (name, bad, okDetail, badDetail, level = "fail") =>
    checks.push(
      bad.length === 0
        ? { name, status: "pass", detail: okDetail }
        : { name, status: level, detail: `${badDetail}: ${bad.slice(0, 20).join("; ")}${bad.length > 20 ? ` (+${bad.length - 20} más)` : ""}` },
    );

  // 1. Tablas y conteos exactos
  const sc = indexBy(source.counts, "schema", "table");
  const rc = indexBy(restored.counts, "schema", "table");
  const badCounts = [];
  for (const [k, s] of sc) {
    const r = rc.get(k);
    if (!r) badCounts.push(`${k} falta tras restaurar`);
    else if (Number(r.rows) !== Number(s.rows)) badCounts.push(`${k} origen=${s.rows} restaurado=${r.rows}`);
  }
  for (const k of rc.keys()) if (!sc.has(k)) badCounts.push(`${k} sobra tras restaurar`);
  const totalRows = [...sc.values()].reduce((a, r) => a + Number(r.rows), 0);
  add("conteos_por_tabla", badCounts, `${sc.size} tablas, ${totalRows} filas idénticas al origen`, "conteos distintos");

  // 2. RLS activo / forzado y número de políticas
  const st = indexBy(source.tables, "schema", "table");
  const rt = indexBy(restored.tables, "schema", "table");
  const badRls = [];
  const badPol = [];
  for (const [k, s] of st) {
    const r = rt.get(k);
    if (!r) continue; // ya reportado en conteos
    if (s.rls !== r.rls || s.force_rls !== r.force_rls) badRls.push(`${k} rls ${s.rls}/${s.force_rls} -> ${r.rls}/${r.force_rls}`);
    if (Number(s.policies) !== Number(r.policies)) badPol.push(`${k} políticas ${s.policies} -> ${r.policies}`);
  }
  const rlsOn = [...st.values()].filter((t) => t.rls).length;
  add("rls_activo", badRls, `RLS idéntico al origen (${rlsOn}/${st.size} tablas con RLS)`, "RLS distinto del origen");
  add("politicas_rls", badPol, "número de políticas idéntico al origen", "políticas distintas del origen");

  // 3. GRANTs (tabla, columna y función)
  const grantKey = (g) => `${g.schema}.${g.object}[${g.kind}] ${g.grantee}:${g.privilege}`;
  const sg = new Set((source.grants ?? []).map(grantKey));
  const rg = new Set((restored.grants ?? []).map(grantKey));
  const badGrants = [
    ...[...sg].filter((g) => !rg.has(g)).map((g) => `falta ${g}`),
    ...[...rg].filter((g) => !sg.has(g)).map((g) => `sobra ${g}`),
  ];
  add("grants", badGrants, `${sg.size} GRANTs idénticos al origen`, "GRANTs distintos del origen");

  // 4. Funciones: existencia, security definer y search_path fijo
  const sf = indexBy(source.functions, "schema", "signature");
  const rf = indexBy(restored.functions, "schema", "signature");
  const badFn = [];
  for (const [k, s] of sf) {
    const r = rf.get(k);
    if (!r) badFn.push(`${k} falta`);
    else if (s.secdef !== r.secdef || s.search_path_set !== r.search_path_set || s.public_exec !== r.public_exec) {
      badFn.push(`${k} secdef/search_path/public_exec ${s.secdef}/${s.search_path_set}/${s.public_exec} -> ${r.secdef}/${r.search_path_set}/${r.public_exec}`);
    }
  }
  for (const k of rf.keys()) if (!sf.has(k)) badFn.push(`${k} sobra`);
  const secdef = [...sf.values()].filter((f) => f.secdef).length;
  add("funciones_security_definer", badFn, `${sf.size} funciones (${secdef} security definer) idénticas al origen`, "funciones distintas del origen");

  // 5. Invariantes absolutos de seguridad del repo. Una violación NUEVA tras
  // restaurar siempre falla; una que ya existía en el origen es "warn" (no la
  // causó el respaldo) salvo en modo estricto (el drill sintético sí lo usa).
  const inv = (c) => c?.invariants ?? {};
  for (const name of ["secdef_sin_search_path", "politicas_using_true", "anon_con_escritura_en_tablas"]) {
    const rv = inv(restored)[name] ?? [];
    const sv = new Set(inv(source)[name] ?? []);
    const fresh = rv.filter((x) => !sv.has(x));
    const old = rv.filter((x) => sv.has(x));
    if (fresh.length > 0) add(`invariante_${name}`, fresh, "", "violación nueva tras restaurar");
    else if (old.length > 0) {
      add(`invariante_${name}`, old, "", "ya existía en el origen", strictInvariants ? "fail" : "warn");
    } else checks.push({ name: `invariante_${name}`, status: "pass", detail: "sin violaciones" });
  }
  return checks;
}

/** Evalúa RPO/RTO medidos contra sus objetivos. */
export function evaluateTargets({ backupCreatedAtMs, drillStartMs, drillEndMs, restoreSeconds, rpoTargetSeconds, rtoTargetSeconds, synthetic }) {
  const rpoSeconds = Math.max(0, Math.round((drillStartMs - backupCreatedAtMs) / 1000));
  const rtoSeconds = Math.round((drillEndMs - drillStartMs) / 1000);
  return {
    rpo_seconds: rpoSeconds,
    rpo_target_seconds: rpoTargetSeconds,
    rpo_ok: rpoSeconds <= rpoTargetSeconds,
    rto_seconds: rtoSeconds,
    rto_restore_seconds: restoreSeconds,
    rto_target_seconds: rtoTargetSeconds,
    rto_ok: rtoSeconds <= rtoTargetSeconds,
    // En sintético el RPO es ~0 por construcción y el RTO es de una base casi vacía:
    // no son una medida de producción y el reporte lo dice.
    representative: !synthetic,
  };
}

export function buildReport({ checks, targets, meta }) {
  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  const targetsFail = !targets.rpo_ok || !targets.rto_ok;
  return {
    verdict: failed.length === 0 && !targetsFail ? "PASS" : "FAIL",
    failed_checks: failed.map((c) => c.name),
    warnings: warned.map((c) => c.name),
    targets_missed: [!targets.rpo_ok && "RPO", !targets.rto_ok && "RTO"].filter(Boolean),
    ...meta,
    targets,
    checks,
  };
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return [h && `${h} h`, (h || m) && `${m} min`, `${r} s`].filter(Boolean).join(" ");
}

export function reportToMarkdown(rep) {
  const icon = { pass: "PASS", fail: "FAIL", warn: "WARN" };
  const t = rep.targets;
  const lines = [
    `# Reporte del drill de restauración: ${rep.verdict}`,
    "",
    `- Modo: ${rep.synthetic ? "SINTÉTICO (base semilla, no es un respaldo real)" : "respaldo real"}`,
    `- Respaldo: ${rep.backup_name} (creado ${rep.backup_created_at})`,
    `- Servidor de origen: PostgreSQL ${rep.source_server_version ?? "?"}; destino del drill: PostgreSQL ${rep.target_server_version ?? "?"}`,
    `- Esquemas: ${(rep.schemas ?? []).join(", ")}`,
    `- RPO medido: ${formatDuration(t.rpo_seconds)} (objetivo ${formatDuration(t.rpo_target_seconds)}) ${t.rpo_ok ? "OK" : "INCUMPLIDO"}`,
    `- RTO medido: ${formatDuration(t.rto_seconds)} en total, ${formatDuration(t.rto_restore_seconds)} de pg_restore (objetivo ${formatDuration(t.rto_target_seconds)}) ${t.rto_ok ? "OK" : "INCUMPLIDO"}`,
    t.representative ? "" : "- AVISO: RPO y RTO de un drill sintético NO representan producción.",
    "",
    "| Check | Resultado | Detalle |",
    "|---|---|---|",
    ...rep.checks.map((c) => `| ${c.name} | ${icon[c.status]} | ${String(c.detail).replace(/\|/g, "/")} |`),
    "",
  ];
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}
