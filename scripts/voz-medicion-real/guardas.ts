// Guardas de seguridad del arnes de voz con modelo real. Puras (sin red ni estado global) para poder probarlas sin gastar saldo ni llamar a proveedores.
// Objetivo: que el arnes JAMAS toque una API, una base ni un Meta que no sean locales/simulados, y que no gaste mas del tope.
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

export class AbortoDeSeguridad extends Error {
  constructor(motivo: string) {
    super(`ABORTADO por seguridad: ${motivo}`);
    this.name = "AbortoDeSeguridad";
  }
}

/** El gasto de la corrida alcanzo el tope: no es una falla del agente ni del arnes, la corrida se corta y se puede continuar con el mismo VOZ_REP. */
export class TopeExcedido extends Error {
  constructor(readonly gastoUsd: number, readonly topeUsd: number) {
    super(`tope de gasto alcanzado: $${gastoUsd.toFixed(4)} >= $${topeUsd}`);
    this.name = "TopeExcedido";
  }
}

/** localhost, 127.0.0.0/8 y ::1 (con o sin corchetes). Un socket unix (ruta absoluta) tambien es local. */
export function hostEsLoopback(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h.startsWith("/")) return true;
  if (h === "localhost" || h === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function urlEsLoopback(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    return hostEsLoopback(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Host al que apunta un pool de `pg` (opciones del pool, cadena de conexion o PGHOST). null si no se puede determinar. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- el pool de pg viene del directorio de QA sin tipos
export function hostDePool(pool: any, env: Record<string, string | undefined> = {}): string | null {
  const o = pool?.options ?? {};
  if (typeof o.host === "string" && o.host !== "") return o.host;
  const cs = o.connectionString ?? pool?.connectionString;
  if (typeof cs === "string" && cs !== "") {
    try {
      const h = new URL(cs).hostname;
      if (h !== "") return decodeURIComponent(h);
      return new URL(cs).searchParams.get("host");
    } catch {
      return null;
    }
  }
  if (pool && typeof pool.query === "function") return env.PGHOST || "localhost"; // pg usa PGHOST o localhost si no hay nada mas
  return null;
}

const RE_VAR_META = /^(META|WHATSAPP|GRAPH)[A-Z0-9_]*(URL|BASE|HOST)$/;

/**
 * Aborta si la API, la base o el Meta del stack no son locales/simulados. `s` es lo que devuelve `startStack()` del directorio de QA:
 * `s.api` (URL), `s.pool` (pg) y `s.metaSimulado === true` (o `s.metaUrl` loopback). Cualquier variable de entorno META/WHATSAPP/GRAPH *_URL|BASE|HOST
 * que este definida debe apuntar a loopback.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- el stack viene del directorio de QA sin tipos
export function validarAislamiento(s: any, env: Record<string, string | undefined> = {}): void {
  if (!urlEsLoopback(s?.api)) throw new AbortoDeSeguridad(`la API del stack (s.api) no es loopback: ${JSON.stringify(String(s?.api ?? "").slice(0, 80))}`);
  const host = hostDePool(s?.pool, env);
  if (!hostEsLoopback(host)) throw new AbortoDeSeguridad(`la base (s.pool) no es local: host ${JSON.stringify(host)}`);
  const metaOk = s?.metaSimulado === true || urlEsLoopback(s?.metaUrl);
  if (!metaOk) throw new AbortoDeSeguridad("el Meta simulado no esta activo (el stack debe exponer metaSimulado:true o metaUrl loopback)");
  for (const [k, v] of Object.entries(env)) {
    if (RE_VAR_META.test(k) && v && !urlEsLoopback(v) && !hostEsLoopback(v)) throw new AbortoDeSeguridad(`la variable ${k} apunta fuera de loopback`);
  }
}

/** VOZ_QA_DIR debe existir y estar DENTRO del repo/worktree (tras resolver enlaces simbolicos). Devuelve la ruta real. */
export function dirQaDentroDelRepo(dir: string | undefined, raizRepo: string): string {
  if (!dir) throw new AbortoDeSeguridad("falta VOZ_QA_DIR (directorio con stack.ts, lib.ts, llm.ts)");
  let real: string;
  let raiz: string;
  try {
    real = realpathSync(dir);
    raiz = realpathSync(raizRepo);
  } catch {
    throw new AbortoDeSeguridad("VOZ_QA_DIR no existe");
  }
  const rel = relative(raiz, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new AbortoDeSeguridad("VOZ_QA_DIR debe estar dentro del repo/worktree (no se carga codigo de fuera)");
  return real;
}

/** Tope de gasto en USD: omision 1.5; si viene definido debe ser un numero finito > 0 (NaN o 0 harian que el corte nunca/siempre dispare). */
export function parseCorte(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1.5;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new AbortoDeSeguridad(`VOZ_CORTE_USD invalido (${JSON.stringify(raw.slice(0, 20))}): debe ser un numero finito mayor que 0`);
  return n;
}

/** Cuenta propia del gasto: lo ya cerrado + la llamada en curso (aun si fallo) + cliente simulado/juez. */
export function gastoPropioUsd(p: { cerradoUsd: number; llamadaEnCursoUsd: number; clienteJuezUsd: number }): number {
  return p.cerradoUsd + p.llamadaEnCursoUsd + p.clienteJuezUsd;
}

export function excedeTope(gastoUsd: number, corteUsd: number): boolean {
  return gastoUsd >= corteUsd;
}

// ---- telefonos ficticios ----
const BASE_FICTICIO = "52199955501"; // 521 999 555 01xx: patron 555-01xx, el rango que se reserva para numeros de ficcion
export const telefonoFicticio = (i: number): string => `${BASE_FICTICIO}${String(((i % 100) + 100) % 100).padStart(2, "0")}`;
export const esTelefonoFicticio = (tel: string): boolean => /^52199955501\d{2}$/.test(tel);

/**
 * Primer telefono ficticio libre (sin pedidos ni escalaciones previas en la base efimera), empezando por `inicio`.
 * `contar(phone10)` devuelve cuantos registros hay para ese numero. Aborta si los 100 estan ocupados.
 */
export async function elegirTelefonoLibre(contar: (phone10: string) => Promise<number>, inicio: number): Promise<string> {
  for (let k = 0; k < 100; k += 1) {
    const tel = telefonoFicticio(inicio + k);
    if ((await contar(tel.slice(-10))) === 0) return tel;
  }
  throw new AbortoDeSeguridad("los 100 telefonos ficticios estan ocupados en la base: usa una base efimera nueva");
}

// ---- redaccion de errores ----
export function redactar(texto: string): string {
  return texto.replace(/(key|token|bearer)[=: ]+[^&\s]+/gi, "$1=***").replace(/sk-[\w-]+/g, "sk-***");
}
