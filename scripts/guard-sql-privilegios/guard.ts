// guard-sql-privilegios — guard estático (sin Postgres) de dos reglas de CLAUDE.md sobre el SQL de
// `supabase/migrations/` (espejo byte-idéntico de packages/*/migrations, ver su README):
//
//   1. «toda función security definer con set search_path fijo y revoke de public»: al final de la
//      secuencia de migraciones, ninguna función SECURITY DEFINER puede conservar el EXECUTE de PUBLIC
//      (el que Postgres concede por omisión al crear la función) ni tener EXECUTE para `anon`.
//   2. «nunca GRANT a anon»: ningún objeto puede quedar con un privilegio de `anon` salvo los de la lista
//      de excepciones documentada en `excepciones.json` (cada una con su justificación).
//
// Simula el estado de privilegios archivo por archivo, en el orden en que se aplican (alfabético = orden
// de versión): `create function` nueva nace con EXECUTE de PUBLIC; `create or replace` sobre una existente
// conserva su ACL (semántica de Postgres); `drop function` la olvida; `grant`/`revoke` sobre funciones,
// tablas, secuencias y schemas cambian el estado; `alter default privileges … anon` siempre es violación.
// El gate dinámico equivalente contra Postgres real es scripts/verify-security-definer-revoke/.
//
// Límite conocido: el SQL dinámico (`execute format(…)` dentro de un bloque DO, p. ej. las copias
// *_sistema que genera 076_qa_r2_automatizacion_dia_de_negocio_y_estados) no se ve en el texto. Medido el
// 9-nov-2026: el guard reconoce 946 de las 948 funciones SECURITY DEFINER que existen tras aplicar todas
// las migraciones en Postgres real; las 2 restantes son esas copias dinámicas (que sí llevan revoke). El gate
// de Postgres (escenarios 1-2 de verify-security-definer-revoke) cubre también ese hueco.
//
// Uso: npm run verify:sql-privilegios   (sale con código 1 y un reporte si encuentra violaciones)
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface FuncionEstado {
  clave: string; // schema.nombre(tipos normalizados)
  securityDefiner: boolean;
  executePublic: boolean;
  executeAnon: boolean;
  archivo: string; // última migración que la definió
}

export interface ExcepcionAnon {
  objeto: string; // "tabla:schema.nombre", "funcion:schema.nombre(tipos)", "schema:nombre", "secuencia:schema.nombre"
  privilegios: string[];
  justificacion: string;
}

export interface Excepciones {
  anon: ExcepcionAnon[];
  definerConPublic: { funcion: string; justificacion: string }[];
}

export interface Violacion {
  regla: "definer-sin-revoke-public" | "definer-ejecutable-por-anon" | "grant-a-anon" | "default-privileges-anon";
  objeto: string;
  detalle: string;
}

export interface ResultadoGuard {
  funciones: Map<string, FuncionEstado>;
  anon: Map<string, Set<string>>;
  violaciones: Violacion[];
}

// ---------------------------------------------------------------------------------------------------
// Tokenización: quita comentarios y separa sentencias en `;` de nivel superior, respetando literales
// '…', identificadores "…" y cuerpos $tag$…$tag$. Los cuerpos dollar-quoted se reemplazan por `$$` para
// que nada de su texto (un `security definer` en un comentario del cuerpo, un `grant` dinámico) cuente.
// ---------------------------------------------------------------------------------------------------
export function separarSentencias(sql: string): string[] {
  const out: string[] = [];
  let actual = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const sig = sql[i + 1];
    if (c === "-" && sig === "-") {
      const fin = sql.indexOf("\n", i);
      i = fin === -1 ? n : fin;
      continue;
    }
    if (c === "/" && sig === "*") {
      let prof = 1;
      i += 2;
      while (i < n && prof > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          prof++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          prof--;
          i += 2;
        } else i++;
      }
      actual += " ";
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      actual += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const fin = sql.indexOf('"', i + 1);
      const j = fin === -1 ? n - 1 : fin;
      actual += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const fin = sql.indexOf(tag, i + tag.length);
        i = fin === -1 ? n : fin + tag.length;
        actual += " $$ ";
        continue;
      }
    }
    if (c === ";") {
      if (actual.trim()) out.push(actual.trim());
      actual = "";
      i++;
      continue;
    }
    actual += c;
    i++;
  }
  if (actual.trim()) out.push(actual.trim());
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Normalización de nombres y tipos
// ---------------------------------------------------------------------------------------------------
function normalizarIdent(s: string): string {
  return s
    .trim()
    .split(".")
    .map((p) => p.trim().replace(/^"(.*)"$/, "$1"))
    .join(".")
    .toLowerCase();
}

function calificar(nombre: string): string {
  const n = normalizarIdent(nombre);
  return n.includes(".") ? n : `public.${n}`;
}

const ALIAS_TIPOS: Record<string, string> = {
  int: "integer",
  int4: "integer",
  int8: "bigint",
  int2: "smallint",
  bool: "boolean",
  float8: "double precision",
  float4: "real",
  decimal: "numeric",
  varchar: "character varying",
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  timetz: "time with time zone",
  time: "time without time zone",
  "character varying": "character varying",
};

const TIPOS_MULTIPALABRA = [
  "double precision",
  "character varying",
  "timestamp with time zone",
  "timestamp without time zone",
  "time with time zone",
  "time without time zone",
  "bit varying",
];

function dividirNivelSuperior(s: string, sep = ","): string[] {
  const partes: string[] = [];
  let prof = 0;
  let actual = "";
  for (const c of s) {
    if (c === "(" || c === "[") prof++;
    else if (c === ")" || c === "]") prof--;
    if (c === sep && prof === 0) {
      partes.push(actual);
      actual = "";
    } else actual += c;
  }
  if (actual.trim()) partes.push(actual);
  return partes;
}

// Recorre desde el final los sufijos de arreglo `[]`/`[N]` (con espacios). Lineal: sin expresiones regulares con
// cuantificadores anidados (CodeQL js/redos; una entrada de 50k caracteres termina en microsegundos).
function separarSufijoArreglo(t: string): { readonly base: string; readonly dimensiones: number } {
  let fin = t.length;
  let dimensiones = 0;
  for (;;) {
    let i = fin - 1;
    while (i >= 0 && t[i] === " ") i--;
    if (i < 0 || t[i] !== "]") break;
    i--;
    while (i >= 0 && (t[i] === " " || (t[i]! >= "0" && t[i]! <= "9"))) i--;
    if (i < 0 || t[i] !== "[") break;
    fin = i;
    dimensiones++;
  }
  return { base: t.slice(0, fin), dimensiones };
}

export function normalizarTipo(tipo: string): string {
  let t = tipo.trim().toLowerCase().replace(/\s+/g, " ");
  const { base, dimensiones } = separarSufijoArreglo(t);
  t = base.trim();
  // numeric(12,2) -> numeric, varchar(20) -> character varying: corta desde el primer «(» si el tipo termina en «)».
  const abre = t.indexOf("(");
  if (abre !== -1 && t.endsWith(")")) t = t.slice(0, abre).trim();
  t = t.replace(/"/g, "");
  t = ALIAS_TIPOS[t] ?? t;
  return t + "[]".repeat(dimensiones);
}

// Quita `default …` / `= …` del final de un argumento (lineal: busca el primer separador a nivel de palabra).
function quitarDefault(a: string): string {
  const igual = a.indexOf("=");
  const def = / default /i.exec(` ${a} `);
  const cortes = [igual === -1 ? -1 : igual, def ? def.index - 1 : -1].filter((x) => x >= 0);
  if (cortes.length === 0) return a;
  return a.slice(0, Math.min(...cortes)).trim();
}

// Un argumento de `create function`: [modo] [nombre] tipo [default …]. Devuelve null si es OUT (no forma
// parte de la identidad de la función).
export function tipoDeArgumento(arg: string): string | null {
  let a = arg.trim().replace(/\s+/g, " ");
  a = quitarDefault(a);
  const modo = /^(in|out|inout|variadic)\s+/i.exec(a);
  if (modo) {
    if (modo[1]!.toLowerCase() === "out") return null;
    a = a.slice(modo[0].length);
  }
  const bajo = a.toLowerCase();
  if (TIPOS_MULTIPALABRA.some((tm) => bajo === tm || bajo.startsWith(`${tm}(`) || bajo.startsWith(`${tm}[`))) {
    return normalizarTipo(a);
  }
  const tokens = a.split(" ");
  if (tokens.length === 1) return normalizarTipo(a);
  const resto = tokens.slice(1).join(" ");
  const restoBajo = resto.toLowerCase();
  // "p_x double precision", "p_x timestamp with time zone", "p_x numeric(12, 2)", "p_x uuid[]"
  if (TIPOS_MULTIPALABRA.some((tm) => restoBajo.startsWith(tm))) return normalizarTipo(resto);
  if (TIPOS_MULTIPALABRA.some((tm) => bajo.startsWith(tm))) return normalizarTipo(a);
  return normalizarTipo(resto);
}

export function claveFuncion(nombre: string, args: string): string {
  const tipos = dividirNivelSuperior(args)
    .map((a) => a.trim())
    .filter((a) => a.length > 0)
    .map(tipoDeArgumento)
    .filter((t): t is string => t !== null);
  return `${calificar(nombre)}(${tipos.join(",")})`;
}

// Extrae `nombre(args)` balanceando paréntesis desde `desde`.
function leerFirma(s: string, desde: number): { nombre: string; args: string | null; fin: number } | null {
  const m = /^\s*((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)\s*/.exec(s.slice(desde));
  if (!m) return null;
  let i = desde + m[0].length;
  if (s[i] !== "(") return { nombre: m[1]!.replace(/\s/g, ""), args: null, fin: i };
  let prof = 0;
  const ini = i;
  for (; i < s.length; i++) {
    if (s[i] === "(") prof++;
    else if (s[i] === ")") {
      prof--;
      if (prof === 0) break;
    }
  }
  return { nombre: m[1]!.replace(/\s/g, ""), args: s.slice(ini + 1, i), fin: i + 1 };
}

function leerListaFirmas(s: string): { nombre: string; args: string | null }[] {
  const out: { nombre: string; args: string | null }[] = [];
  let i = 0;
  while (i < s.length) {
    const f = leerFirma(s, i);
    if (!f) break;
    out.push({ nombre: f.nombre, args: f.args });
    const resto = s.slice(f.fin);
    const coma = /^\s*,/.exec(resto);
    if (!coma) break;
    i = f.fin + coma[0].length;
  }
  return out;
}

function roles(lista: string): string[] {
  return lista
    .replace(/\b(with\s+grant\s+option|granted\s+by\s+\S+|cascade|restrict)\b/gi, "")
    .split(",")
    .map((r) => normalizarIdent(r.replace(/^\s*group\s+/i, "")))
    .filter((r) => r.length > 0);
}

function privilegiosDe(texto: string): string[] {
  const t = texto.trim().toLowerCase().replace(/\(.*?\)/g, "");
  if (/^all(\s+privileges)?$/.test(t)) return ["all"];
  return t
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------
// Simulación
// ---------------------------------------------------------------------------------------------------
export function analizarMigraciones(archivos: { nombre: string; sql: string }[], excepciones: Excepciones): ResultadoGuard {
  const funciones = new Map<string, FuncionEstado>();
  const anon = new Map<string, Set<string>>();
  const defaultAnon: Violacion[] = [];

  const otorgarAnon = (objeto: string, privs: string[]) => {
    const set = anon.get(objeto) ?? new Set<string>();
    for (const p of privs) set.add(p);
    anon.set(objeto, set);
  };
  const quitarAnon = (objeto: string, privs: string[]) => {
    const set = anon.get(objeto);
    if (!set) return;
    if (privs.includes("all")) set.clear();
    else {
      for (const p of privs) set.delete(p);
      set.delete("all");
    }
    if (set.size === 0) anon.delete(objeto);
  };
  const funcionesPorNombre = (nombre: string): FuncionEstado[] => {
    const pref = `${calificar(nombre)}(`;
    return [...funciones.values()].filter((f) => f.clave.startsWith(pref));
  };
  const resolverFunciones = (firma: { nombre: string; args: string | null }): FuncionEstado[] => {
    if (firma.args === null) return funcionesPorNombre(firma.nombre);
    const f = funciones.get(claveFuncion(firma.nombre, firma.args));
    return f ? [f] : [];
  };

  for (const { nombre: archivo, sql } of archivos) {
    for (const sentencia of separarSentencias(sql)) {
      const s = sentencia.replace(/\s+/g, " ").trim();
      const bajo = s.toLowerCase();

      // create [or replace] function
      let m = /^create\s+(or\s+replace\s+)?function\s+/i.exec(s);
      if (m) {
        const firma = leerFirma(s, m[0].length);
        if (!firma || firma.args === null) continue;
        const clave = claveFuncion(firma.nombre, firma.args);
        const cola = bajo.slice(firma.fin);
        const definer = /\bsecurity\s+definer\b/.test(cola);
        const previa = funciones.get(clave);
        if (previa) {
          previa.securityDefiner = definer;
          previa.archivo = archivo;
        } else {
          funciones.set(clave, { clave, securityDefiner: definer, executePublic: true, executeAnon: false, archivo });
        }
        continue;
      }

      // alter function f(args) security definer|invoker
      m = /^alter\s+function\s+/i.exec(s);
      if (m) {
        const firma = leerFirma(s, m[0].length);
        if (!firma) continue;
        const cola = bajo.slice(firma.fin);
        for (const f of resolverFunciones(firma)) {
          if (/\bsecurity\s+definer\b/.test(cola)) f.securityDefiner = true;
          if (/\bsecurity\s+invoker\b/.test(cola)) f.securityDefiner = false;
        }
        continue;
      }

      // drop function [if exists] f(args)[, g(args)]
      m = /^drop\s+function\s+(if\s+exists\s+)?/i.exec(s);
      if (m) {
        const lista = s.slice(m[0].length).replace(/\s+(cascade|restrict)\s*$/i, "");
        for (const firma of leerListaFirmas(lista)) {
          for (const f of resolverFunciones(firma)) funciones.delete(f.clave);
        }
        continue;
      }

      // alter default privileges … grant … to anon
      if (/^alter\s+default\s+privileges\b/i.test(s)) {
        if (/\bgrant\b/i.test(s) && /\bto\b[^;]*\banon\b/i.test(s)) {
          defaultAnon.push({
            regla: "default-privileges-anon",
            objeto: archivo,
            detalle: "`alter default privileges … to anon` concede a anon todo objeto futuro; prohibido sin excepción.",
          });
        }
        continue;
      }

      // grant/revoke
      const g = /^(grant|revoke)\s+(grant\s+option\s+for\s+)?([\s\S]+?)\s+on\s+([\s\S]+?)\s+(to|from)\s+([\s\S]+)$/i.exec(s);
      if (!g) continue;
      const esGrant = g[1]!.toLowerCase() === "grant";
      if (g[2]) continue; // revoke grant option for: no cambia el privilegio en sí
      const privs = privilegiosDe(g[3]!);
      const objetivo = g[4]!.trim();
      const listaRoles = roles(g[6]!);
      const tocaPublic = listaRoles.includes("public");
      const tocaAnon = listaRoles.includes("anon");
      if (!tocaPublic && !tocaAnon) continue;

      // funciones
      const mf = /^(function|procedure|routine)s?\s+([\s\S]+)$/i.exec(objetivo);
      const mAllF = /^all\s+(functions|procedures|routines)\s+in\s+schema\s+([\s\S]+)$/i.exec(objetivo);
      if (mAllF || mf) {
        const afectaExecute = privs.includes("all") || privs.includes("execute");
        if (!afectaExecute) continue;
        let objetivos: FuncionEstado[] = [];
        if (mAllF) {
          const schemas = mAllF[2]!.split(",").map(normalizarIdent);
          objetivos = [...funciones.values()].filter((f) => schemas.includes(f.clave.split(".")[0] ?? ""));
        } else if (mf) {
          for (const firma of leerListaFirmas(mf[2]!)) objetivos.push(...resolverFunciones(firma));
        }
        for (const f of objetivos) {
          if (tocaPublic) f.executePublic = esGrant;
          if (tocaAnon) f.executeAnon = esGrant;
        }
        if (esGrant && tocaAnon && mf) {
          for (const firma of leerListaFirmas(mf[2]!)) {
            const clave = firma.args === null ? `${calificar(firma.nombre)}(*)` : claveFuncion(firma.nombre, firma.args);
            otorgarAnon(`funcion:${clave}`, ["execute"]);
          }
        } else if (!esGrant && tocaAnon && mf) {
          for (const f of objetivos) quitarAnon(`funcion:${f.clave}`, ["execute", "all"]);
        }
        continue;
      }
      if (!tocaAnon) continue;

      // schemas, secuencias, tablas
      const ms = /^schema\s+([\s\S]+)$/i.exec(objetivo);
      const mAllT = /^all\s+(tables|sequences)\s+in\s+schema\s+([\s\S]+)$/i.exec(objetivo);
      const mSeq = /^sequence\s+([\s\S]+)$/i.exec(objetivo);
      if (ms) {
        for (const sc of ms[1]!.split(",").map(normalizarIdent)) {
          if (esGrant) otorgarAnon(`schema:${sc}`, privs);
          else quitarAnon(`schema:${sc}`, privs);
        }
      } else if (mAllT) {
        const tipo = mAllT[1]!.toLowerCase() === "tables" ? "tabla" : "secuencia";
        const schemas = mAllT[2]!.split(",").map(normalizarIdent);
        if (esGrant) {
          for (const sc of schemas) otorgarAnon(`${tipo}:${sc}.*`, privs);
        } else {
          for (const clave of [...anon.keys()]) {
            if (clave.startsWith(`${tipo}:`) && schemas.includes(clave.slice(tipo.length + 1).split(".")[0] ?? "")) quitarAnon(clave, privs);
          }
        }
      } else {
        const tipo = mSeq ? "secuencia" : "tabla";
        const lista = (mSeq ? mSeq[1]! : objetivo.replace(/^table\s+/i, "")).split(",").map(calificar);
        for (const t of lista) {
          if (esGrant) otorgarAnon(`${tipo}:${t}`, privs);
          else quitarAnon(`${tipo}:${t}`, privs);
        }
      }
    }
  }

  const violaciones: Violacion[] = [...defaultAnon];
  const permitidasPublic = new Set(excepciones.definerConPublic.map((e) => e.funcion.toLowerCase()));
  for (const f of [...funciones.values()].sort((a, b) => a.clave.localeCompare(b.clave))) {
    if (!f.securityDefiner) continue;
    if (f.executePublic && !permitidasPublic.has(f.clave)) {
      violaciones.push({
        regla: "definer-sin-revoke-public",
        objeto: f.clave,
        detalle: `SECURITY DEFINER sin \`revoke … from public\` (definida por última vez en ${f.archivo}).`,
      });
    }
    if (f.executeAnon) {
      violaciones.push({
        regla: "definer-ejecutable-por-anon",
        objeto: f.clave,
        detalle: `SECURITY DEFINER con EXECUTE para anon (definida por última vez en ${f.archivo}).`,
      });
    }
  }
  const permitidasAnon = new Map(excepciones.anon.map((e) => [e.objeto.toLowerCase(), new Set(e.privilegios.map((p) => p.toLowerCase()))]));
  for (const [objeto, privs] of [...anon.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (objeto.startsWith("funcion:")) {
      // ya cubierto por definer-ejecutable-por-anon si es definer; una invoker con grant a anon también se reporta
      if (permitidasAnon.get(objeto)?.has("execute")) continue;
    }
    const permitidos = permitidasAnon.get(objeto) ?? new Set<string>();
    const sobrantes = [...privs].filter((p) => !permitidos.has(p));
    if (sobrantes.length > 0) {
      violaciones.push({
        regla: "grant-a-anon",
        objeto,
        detalle: `anon conserva ${sobrantes.join(", ")} y no está en scripts/guard-sql-privilegios/excepciones.json.`,
      });
    }
  }
  return { funciones, anon, violaciones };
}

export function leerMigraciones(dir: string): { nombre: string; sql: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((nombre) => ({ nombre, sql: readFileSync(path.join(dir, nombre), "utf8") }));
}

export function leerExcepciones(archivo: string): Excepciones {
  const crudo = JSON.parse(readFileSync(archivo, "utf8")) as Partial<Excepciones>;
  return { anon: crudo.anon ?? [], definerConPublic: crudo.definerConPublic ?? [] };
}

export function formatearReporte(violaciones: Violacion[]): string {
  return violaciones.map((v) => `  - [${v.regla}] ${v.objeto}: ${v.detalle}`).join("\n");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = path.resolve(HERE, "..", "..");
  const resultado = analizarMigraciones(
    leerMigraciones(path.join(REPO_ROOT, "supabase", "migrations")),
    leerExcepciones(path.join(HERE, "excepciones.json")),
  );
  const definer = [...resultado.funciones.values()].filter((f) => f.securityDefiner).length;
  if (resultado.violaciones.length > 0) {
    console.error("guard-sql-privilegios: FALLÓ\n");
    console.error(formatearReporte(resultado.violaciones));
    console.error(
      `\n${resultado.violaciones.length} violación(es). Toda función SECURITY DEFINER lleva \`revoke all on function … from public, anon\` ` +
        "(y el grant explícito al rol que la necesita); ningún objeto se concede a anon fuera de excepciones.json.",
    );
    process.exit(1);
  }
  console.log(
    `guard-sql-privilegios: OK -- ${definer} funciones SECURITY DEFINER, todas con revoke de public y sin EXECUTE para anon; ` +
      `${resultado.anon.size} objeto(s) con privilegio de anon, todos en excepciones.json.`,
  );
}
