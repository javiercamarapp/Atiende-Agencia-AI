// T04: esquema y validador de escenarios de voz + carga del corpus SINTETICO PRIVADO.
// El corpus (82 escenarios) vive FUERA del repo y NO se copia nunca: se lee de la ruta de la variable de entorno PM_CORPUS_SIM (directorio con `escenarios-voz.json`, o el archivo).
// Aqui solo hay el esquema, el validador y 3 escenarios de ejemplo 100 % inventados (`ejemplos/escenarios-ejemplo.json`). Los mensajes de error nunca citan texto de un escenario.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { RELOJES } from "../voz-medicion-real/escenarios.ts";
import type { Escenario } from "../voz-medicion-real/escenarios.ts";
import { AbortoDeSeguridad } from "../voz-medicion-real/guardas.ts";

export interface EscenarioBanco extends Escenario {
  readonly _meta?: Readonly<Record<string, unknown>>;
}

const CHECKS_CON_N = new Set(["pedidos", "maxPedidos"]);
const CHECKS_CON_LISTA = new Set(["total", "totalSiCrea"]);
const CHECKS_CON_RE = new Set(["sinTexto", "texto", "sinItem"]);
const CHECKS_SIMPLES = new Set(["sinPedido", "sinCallback", "sinDomicilio"]);
const EVENTOS = new Set(["ruido", "no_entendido", "silencio", "cuelga", "interrumpe", "cortada"]);
const SUCURSALES = new Set(["T1", "T3", "T7"]);

const esObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Errores de forma de UN escenario (lista vacia = valido). Describe el campo, nunca su contenido. */
export function validarEscenario(x: unknown): string[] {
  const err: string[] = [];
  if (!esObj(x)) return ["no es un objeto"];
  for (const k of ["id", "fuente", "titulo", "debe", "noDebe"] as const) if (typeof x[k] !== "string" || x[k] === "") err.push(`${k}: debe ser un texto no vacio`);
  if (typeof x["id"] === "string" && !/^[A-Za-z0-9_-]{1,40}$/.test(x["id"])) err.push("id: solo letras, digitos, guion y guion bajo (max 40)");
  if (!SUCURSALES.has(String(x["sucursal"]))) err.push("sucursal: debe ser T1, T3 o T7");
  if (!(String(x["reloj"]) in RELOJES)) err.push("reloj: clave desconocida");
  const turnos = x["turnos"];
  if (!Array.isArray(turnos) || turnos.length === 0) err.push("turnos: debe ser una lista no vacia");
  else {
    turnos.forEach((t, i) => {
      if (typeof t === "string") { if (t.trim() === "") err.push(`turnos[${i}]: texto vacio`); return; }
      if (!esObj(t) || !EVENTOS.has(String(t["k"]))) { err.push(`turnos[${i}]: ni texto ni evento conocido`); return; }
      if ((t["k"] === "interrumpe" || t["k"] === "cortada") && (typeof t["dice"] !== "string" || t["dice"] === "")) err.push(`turnos[${i}]: falta dice`);
      if (t["k"] === "silencio" && !(typeof t["ms"] === "number" && Number.isFinite(t["ms"]) && t["ms"] >= 0)) err.push(`turnos[${i}]: silencio requiere ms numerico`);
    });
  }
  const checks = x["checks"];
  if (!Array.isArray(checks) || checks.length === 0) err.push("checks: debe ser una lista no vacia");
  else {
    checks.forEach((c, i) => {
      if (!esObj(c) || typeof c["t"] !== "string") { err.push(`checks[${i}]: sin tipo`); return; }
      const t = c["t"];
      if (CHECKS_SIMPLES.has(t)) return;
      if (CHECKS_CON_N.has(t)) { if (!(Number.isInteger(c["n"]) && (c["n"] as number) >= 0)) err.push(`checks[${i}]: n entero >= 0`); return; }
      if (CHECKS_CON_LISTA.has(t)) { if (!(Array.isArray(c["en"]) && c["en"].length > 0 && c["en"].every((v) => typeof v === "number" && Number.isFinite(v)))) err.push(`checks[${i}]: en = lista de numeros`); return; }
      if (CHECKS_CON_RE.has(t)) {
        if (typeof c["re"] !== "string") err.push(`checks[${i}]: re debe ser texto`);
        else { try { new RegExp(c["re"]); } catch { err.push(`checks[${i}]: re no compila`); } }
        return;
      }
      if (t === "callback") return;
      if (t === "canal") { if (c["v"] !== "domicilio" && c["v"] !== "recoger") err.push(`checks[${i}]: canal invalido`); return; }
      if (t === "piezas") { if (typeof c["re"] !== "string" || !Number.isInteger(c["n"])) err.push(`checks[${i}]: piezas requiere re y n entero`); return; }
      err.push(`checks[${i}]: tipo desconocido`);
    });
  }
  return err;
}

export function validarLista(xs: unknown): { validos: EscenarioBanco[]; errores: { indice: number; id: string; problemas: string[] }[] } {
  const errores: { indice: number; id: string; problemas: string[] }[] = [];
  const validos: EscenarioBanco[] = [];
  const vistos = new Set<string>();
  if (!Array.isArray(xs)) return { validos, errores: [{ indice: -1, id: "(raiz)", problemas: ["la lista de escenarios no es un arreglo"] }] };
  xs.forEach((x, indice) => {
    const problemas = validarEscenario(x);
    const id = esObj(x) && typeof x["id"] === "string" ? x["id"] : "(sin id)";
    if (problemas.length === 0 && vistos.has(id)) problemas.push("id repetido");
    vistos.add(id);
    if (problemas.length > 0) errores.push({ indice, id, problemas });
    else validos.push(x as unknown as EscenarioBanco);
  });
  return { validos, errores };
}

/** Los escenarios de ejemplo del repo (inventados). */
export function cargarEjemplos(): EscenarioBanco[] {
  const ruta = new URL("./ejemplos/escenarios-ejemplo.json", import.meta.url);
  const { validos, errores } = validarLista((JSON.parse(readFileSync(ruta, "utf8")) as { escenarios?: unknown }).escenarios);
  if (errores.length > 0) throw new Error("los escenarios de ejemplo del repo no son validos");
  return validos;
}

/** Resuelve PM_CORPUS_SIM (directorio o archivo) y exige que quede FUERA del repo/worktree: el corpus privado no debe poder terminar commiteado. */
export function rutaCorpusPrivado(env: Record<string, string | undefined>, raizRepo: string): string {
  const crudo = env["PM_CORPUS_SIM"];
  if (!crudo) throw new AbortoDeSeguridad("falta PM_CORPUS_SIM (ruta del corpus sintetico privado, fuera del repo)");
  if (!isAbsolute(crudo)) throw new AbortoDeSeguridad("PM_CORPUS_SIM debe ser una ruta absoluta");
  let real: string;
  let raiz: string;
  try {
    real = realpathSync(crudo);
    raiz = realpathSync(raizRepo);
  } catch {
    throw new AbortoDeSeguridad("PM_CORPUS_SIM no existe");
  }
  const rel = relative(raiz, real);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new AbortoDeSeguridad("PM_CORPUS_SIM esta DENTRO del repo: el corpus privado debe vivir fuera");
  const archivo = statSync(real).isDirectory() ? join(real, "escenarios-voz.json") : real;
  if (!existsSync(archivo)) throw new AbortoDeSeguridad("PM_CORPUS_SIM no contiene escenarios-voz.json");
  return archivo;
}

/** Carga y valida el corpus privado. Devuelve solo cuentas de errores si algo falla (nunca texto del corpus). */
export function cargarCorpusPrivado(env: Record<string, string | undefined>, raizRepo: string): { validos: EscenarioBanco[]; errores: { indice: number; id: string; problemas: string[] }[] } {
  const archivo = rutaCorpusPrivado(env, raizRepo);
  const crudo = JSON.parse(readFileSync(archivo, "utf8")) as unknown;
  const lista = Array.isArray(crudo) ? crudo : esObj(crudo) ? crudo["escenarios"] : undefined;
  return validarLista(lista);
}
