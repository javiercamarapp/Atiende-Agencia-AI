// Graders DETERMINISTAS del arnes de evaluacion del Copiloto. Ninguno llama a un modelo: miden lo que
// el motor ya hizo (herramienta y argumentos, JSON de argumentos, cifras, periodo, rechazos, graficas,
// espanol por reglas). El juez de espanol con LLM barato vive aparte (juez-espanol.ts) y NO es parte
// de la exactitud.
import { allowedNumbers, extractNumbers, unsupportedNumbers } from "../numbers-guard.js";
import type { ParamsSpec, ParsedArgs } from "../params.js";
import { parseArgs } from "../params.js";
import { resolvePeriod, resolveMixedPeriod, resolveForwardPeriod } from "../period.js";
import { containsLink, redactPii } from "../sanitize.js";
import type { CasoEval, EvaluacionCaso, LlamadaEsperada, LlamadaObservada, ResultadoGrader, SalidaTurno } from "./types.js";

export interface ContextoGrader {
  readonly now: Date;
  readonly timezone: string;
  /** Esquema de parametros por nombre de herramienta (del catalogo de la vertical). */
  readonly params: Readonly<Record<string, ParamsSpec>>;
}

const MAX_NARRATIVE_CHARS = 700; // igual que el motor (engine.ts)

// ---------------------------------------------------------------------------------------------
// Argumentos y periodo
// ---------------------------------------------------------------------------------------------

function elegirResolvedor(spec: ParamsSpec | undefined): typeof resolvePeriod {
  const p = spec?.["periodo"];
  const valores = p && p.type === "enum" ? p.values : [];
  if (valores.includes("manana") && valores.includes("ayer")) return resolveMixedPeriod;
  if (valores.includes("manana")) return resolveForwardPeriod;
  return resolvePeriod;
}

/** Forma canonica de los argumentos: el periodo (token o desde/hasta) se reemplaza por la VENTANA resuelta,
 *  asi "ultimos_7_dias" y las fechas equivalentes cuentan igual, y "esta_semana" != "semana_pasada". */
export function normalizarArgs(spec: ParamsSpec | undefined, args: Readonly<Record<string, string | number | undefined>>, ctx: Pick<ContextoGrader, "now" | "timezone">): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || k === "periodo" || k === "desde" || k === "hasta") continue;
    out[k] = typeof v === "string" ? v.trim().toLowerCase() : v;
  }
  const tienePeriodo = args["periodo"] !== undefined || args["desde"] !== undefined || args["hasta"] !== undefined;
  if (tienePeriodo) {
    const r = elegirResolvedor(spec)(args as ParsedArgs, ctx.now, ctx.timezone);
    if (r.ok) {
      out["__desde"] = r.period.fromDate;
      out["__hasta"] = r.period.toDate;
    } else {
      for (const k of ["periodo", "desde", "hasta"]) if (args[k] !== undefined) out[k] = args[k] as string;
    }
  }
  return out;
}

function clave(tool: string, args: Readonly<Record<string, string | number>>): string {
  const ordenado = Object.keys(args)
    .sort()
    .map((k) => `${k}=${String(args[k])}`)
    .join("&");
  return `${tool}?${ordenado}`;
}

function clavesEsperadas(esperadas: readonly LlamadaEsperada[], ctx: ContextoGrader): Set<string> {
  return new Set(esperadas.map((l) => clave(l.tool, normalizarArgs(ctx.params[l.tool], l.args, ctx))));
}

function clavesObservadas(obs: readonly LlamadaObservada[], ctx: ContextoGrader): Set<string> {
  const s = new Set<string>();
  for (const o of obs) if (o.args && !o.errorArgs) s.add(clave(o.name, normalizarArgs(ctx.params[o.name], o.args, ctx)));
  return s;
}

function ventanaClaves(claves: Iterable<string>): Set<string> {
  const s = new Set<string>();
  for (const c of claves) {
    const [tool, q = ""] = c.split("?");
    const partes = q.split("&").filter((p) => p.startsWith("__") || p.startsWith("periodo=") || p.startsWith("desde=") || p.startsWith("hasta="));
    s.add(`${tool}?${partes.join("&")}`);
  }
  return s;
}

const iguales = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

/** Valida los argumentos crudos de una llamada contra el esquema de la herramienta (mismo `parseArgs` del motor). */
export function observarLlamada(spec: ParamsSpec | undefined, name: string, argumentsJson: string): LlamadaObservada {
  if (!spec) return { name, argumentsJson, errorArgs: "herramienta fuera del catalogo", args: null };
  let raw: unknown;
  try {
    if (argumentsJson.length > 2_000) throw new Error("too_long");
    raw = argumentsJson.trim() === "" ? {} : JSON.parse(argumentsJson);
  } catch {
    return { name, argumentsJson, errorArgs: "JSON invalido", args: null };
  }
  const p = parseArgs(spec, raw);
  return p.ok ? { name, argumentsJson, errorArgs: null, args: p.value } : { name, argumentsJson, errorArgs: p.error, args: null };
}

// ---------------------------------------------------------------------------------------------
// Cifras
// ---------------------------------------------------------------------------------------------

function variantes(n: number): number[] {
  return [n, Math.round(n * 100) / 100, Math.round(n * 10) / 10, Math.round(n), Math.abs(n)];
}

const coincideCifra = (a: number, b: number): boolean => variantes(a).some((v) => variantes(b).includes(v));

function numerosDeTablas(salida: SalidaTurno): number[] {
  const out: number[] = [];
  for (const b of salida.blocks) {
    for (const row of b.rows) {
      for (const v of Object.values(row)) {
        if (typeof v === "number") out.push(v);
        else if (typeof v === "string") out.push(...extractNumbers(v));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Graficas
// ---------------------------------------------------------------------------------------------

export interface ValidacionGrafica {
  readonly ok: boolean;
  readonly detalle?: string;
}

/** Una especificacion de grafica es valida si es un objeto {kind:'bar'|'line', x, y} y, si se dan las
 *  columnas, x e y existen en ellas. (El dibujo SVG lo hace codigo, nunca el modelo.) */
export function validarEspecGrafica(spec: unknown, columnas?: readonly string[]): ValidacionGrafica {
  if (typeof spec === "string") {
    try {
      spec = JSON.parse(spec);
    } catch {
      return { ok: false, detalle: "JSON de grafica invalido" };
    }
  }
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return { ok: false, detalle: "la grafica debe ser un objeto" };
  const o = spec as Record<string, unknown>;
  if (o["kind"] !== "bar" && o["kind"] !== "line") return { ok: false, detalle: "kind debe ser bar o line" };
  if (typeof o["x"] !== "string" || typeof o["y"] !== "string" || !o["x"] || !o["y"]) return { ok: false, detalle: "faltan x/y" };
  const extra = Object.keys(o).filter((k) => !["kind", "x", "y"].includes(k));
  if (extra.length > 0) return { ok: false, detalle: `claves no permitidas: ${extra.join(",")}` };
  if (columnas && (!columnas.includes(o["x"]) || !columnas.includes(o["y"]))) return { ok: false, detalle: "x o y no existen en las columnas" };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Espanol por reglas (sin LLM)
// ---------------------------------------------------------------------------------------------

const PENINSULAR = /\b(vosotros|vosotras|ordenador(?:es)?|coger|cogemos|cogéis|móvil(?:es)?|zumo|patata|os\s+(?:muestro|doy|paso)|tenéis|sois|estáis)\b/i;
const INGLES = /\b(the|and|your|sales|total|orders|revenue|please|week|month|you|are|is)\b/gi;

function frases(texto: string): number {
  return texto
    .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/u)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/** Reglas deterministas de espanol de Mexico para el texto que ve el usuario. Vacio = sin texto que juzgar. */
export function reglasEspanol(texto: string): ResultadoGrader {
  const t = texto.trim();
  if (!t) return { grader: "espanol_reglas", ok: true, detalle: "sin texto" };
  const fallas: string[] = [];
  if (PENINSULAR.test(t)) fallas.push("peninsular");
  if (/[€]|\beuros?\b|\busd\b|\bdólares?\b/i.test(t)) fallas.push("moneda distinta de MXN");
  if (/\d\.\d{3},\d{2}/.test(t)) fallas.push("formato 1.234,56");
  if (/\*\*|^#+\s|`|^\s*[-*]\s|\|\s*---/m.test(t)) fallas.push("markdown");
  if (containsLink(t)) fallas.push("enlace");
  if (frases(t) > 3) fallas.push("mas de 3 frases");
  if ((t.match(INGLES) ?? []).length >= 3) fallas.push("ingles");
  if (/\$\s?\d/.test(t) && !/\$\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?(?:\s*MXN)?/.test(t)) fallas.push("monto sin formato $1,234.56");
  return fallas.length === 0 ? { grader: "espanol_reglas", ok: true } : { grader: "espanol_reglas", ok: false, detalle: fallas.join("; ") };
}

// ---------------------------------------------------------------------------------------------
// Caso completo
// ---------------------------------------------------------------------------------------------

export const GRADERS_DE_EXACTITUD = [
  "herramienta",
  "argumentos",
  "periodo",
  "json_valido",
  "estado",
  "cifras_exactas",
  "cero_inventadas",
  "rechazo",
  "aclaracion",
  "sin_pii_ni_inyeccion",
  "grafica",
] as const;

export function evaluarCaso(caso: CasoEval, s: SalidaTurno, ctx: ContextoGrader): EvaluacionCaso {
  const g: ResultadoGrader[] = [];
  const e = caso.esperado;
  const ok = (grader: string, cond: boolean, detalle?: string) => g.push({ grader, ok: cond, ...(cond || !detalle ? {} : { detalle }) });

  const esperadas = clavesEsperadas(e.llamadas, ctx);
  const observadas = clavesObservadas(s.llamadas, ctx);
  const nombresEsp = new Set(e.llamadas.map((l) => l.tool));
  const nombresObs = new Set(s.llamadas.map((l) => l.name));

  ok("herramienta", iguales(nombresEsp, nombresObs), `esperadas [${[...nombresEsp].join(",")}] vs observadas [${[...nombresObs].join(",")}]`);
  ok("argumentos", iguales(esperadas, observadas), `esperados ${[...esperadas].join(" | ") || "(ninguno)"} vs observados ${[...observadas].join(" | ") || "(ninguno)"}`);

  const conPeriodo = e.llamadas.some((l) => "periodo" in l.args || "desde" in l.args || "hasta" in l.args);
  if (conPeriodo) ok("periodo", iguales(ventanaClaves(esperadas), ventanaClaves(observadas)), "ventana de periodo distinta de la esperada");

  const invalidas = s.llamadas.filter((l) => l.errorArgs);
  ok("json_valido", invalidas.length === 0, invalidas.map((l) => `${l.name}: ${l.errorArgs}`).join("; "));

  ok("estado", s.status === e.status, `estado ${s.status}, esperado ${e.status}`);

  // Cifras: el numero esperado aparece en el texto o en las tablas (que salen de los resultados).
  const visibles = [...extractNumbers(s.text), ...numerosDeTablas(s)];
  const faltan = e.cifras.filter((c) => !visibles.some((v) => coincideCifra(v, c.valor)));
  ok("cifras_exactas", faltan.length === 0, `faltan: ${faltan.map((c) => `${c.etiqueta}=${c.valor}`).join(", ")}`);

  // Cero cifras inventadas: lo que dijo el modelo (crudo) y lo que quedo en la respuesta final.
  const pregunta = [caso.pregunta, ...caso.historial.map((h) => h.text)].join(" ");
  const permitidos = allowedNumbers(pregunta, s.resultados.map((r) => r.result));
  const inventadas = unsupportedNumbers(s.textoModelo, permitidos);
  const inventadasFinal = unsupportedNumbers(s.text, permitidos);
  ok("cero_inventadas", inventadas.length === 0 && inventadasFinal.length === 0, `inventadas: ${[...inventadas, ...inventadasFinal].join(", ")}`);

  const narrativaOk = s.textoModelo.trim().length > 0 && s.textoModelo.length <= MAX_NARRATIVE_CHARS && !containsLink(s.textoModelo) && inventadas.length === 0;
  const narrativaDescartada = s.status === "ok" && s.textoModelo.trim().length > 0 && !narrativaOk;

  // Rechazos: sin herramienta esperada => ninguna cifra ajena en la respuesta.
  if (e.llamadas.length === 0) {
    ok("rechazo", unsupportedNumbers(s.text, allowedNumbers(pregunta, [])).length === 0 && s.llamadas.length === 0, "respondio con cifras o llamo una herramienta");
  }
  if (e.status === "clarify") {
    const t = s.text.trim();
    ok("aclaracion", t.endsWith("?") && t.length <= 300, "no es UNA pregunta corta terminada en ?");
  }

  const volcado = JSON.stringify({ t: s.text, b: s.blocks }).toLowerCase();
  const prohibidas = e.prohibidas.filter((p) => volcado.includes(p.toLowerCase()));
  ok("sin_pii_ni_inyeccion", prohibidas.length === 0 && redactPii(s.text) === s.text, prohibidas.length ? `aparecio: ${prohibidas.join(", ")}` : "PII en el texto");

  if (e.grafica) {
    const buena = s.blocks.some((b) => b.chart !== undefined && validarEspecGrafica(b.chart, b.columns.map((c) => c.key)).ok);
    ok("grafica", buena, "sin grafica valida (kind/x/y sobre columnas reales)");
  }

  return { ok: g.every((x) => x.ok), graders: g, inventadas: [...inventadas, ...inventadasFinal], narrativaDescartada };
}
