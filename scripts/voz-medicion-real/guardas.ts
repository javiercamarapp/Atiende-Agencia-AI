// Guardas de seguridad del arnes de voz con modelo real. Puras (sin red ni estado global) para poder probarlas sin gastar saldo ni llamar a proveedores.
// Objetivo: que el arnes JAMAS toque una API, una base ni un Meta que no sean locales/simulados, y que no gaste mas del tope.
import { execFileSync } from "node:child_process";
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

/** Socket unix: ruta absoluta de UNA barra ("/var/run/postgresql"); "//evil.com" (red-path de URL) NO es un socket. */
const esSocketUnix = (h: string): boolean => h.startsWith("/") && !h.startsWith("//");

/** localhost, 127.0.0.0/8 y ::1 (con o sin corchetes). Un socket unix (ruta absoluta de una barra) tambien es local. */
export function hostEsLoopback(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (esSocketUnix(h)) return true;
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

/** Solo el host de una URL, para mensajes (nunca la URL completa: puede traer usuario, clave o tokens). */
export function soloHost(url: unknown): string {
  if (typeof url !== "string") return "(sin valor)";
  try {
    return new URL(url).hostname || "(sin host)";
  } catch {
    return "(no es una URL)";
  }
}

/**
 * TODOS los hosts a los que puede apuntar un pool de `pg`: `options.host` Y el de la cadena de conexion (en pg la cadena sobrescribe a `host`, asi que
 * hay que validar ambos), incluido `?host=` y PGHOST/localhost si no hay nada mas. Lista vacia = no se pudo determinar.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- el pool de pg viene del directorio de QA sin tipos
export function hostsDePool(pool: any, env: Record<string, string | undefined> = {}): string[] {
  if (!pool) return [];
  const o = pool.options ?? {};
  const hosts: string[] = [];
  const anade = (h: unknown) => { if (Array.isArray(h)) h.forEach(anade); else if (typeof h === "string" && h !== "") hosts.push(h); };
  anade(o.host);
  for (const cs of [o.connectionString, pool.connectionString]) {
    if (typeof cs !== "string" || cs === "") continue;
    // 1) El mismo parser que usa pg (WHATWG): toma la userinfo hasta el ULTIMO "@", asi que "u:p@localhost:5432@evil.com" es evil.com.
    try {
      const u = new URL(cs);
      if (u.hostname !== "") anade(safeDecode(u.hostname));
      anade(u.searchParams.get("host"));
      if (u.hostname === "" && !u.searchParams.get("host")) anade("(cadena de conexion sin host)");
      continue;
    } catch { /* WHATWG rechaza una cadena sin host pero con usuario y ?host=/ruta-de-socket: analisis manual, abajo */ }
    // 2) Manual, FALLANDO CERRADO ante cualquier ambiguedad: varios hosts (",") o mas de un "@" en la autoridad.
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(cs);
    if (!m) { anade("(cadena de conexion invalida)"); continue; }
    const autoridad = m[1] ?? "";
    if (autoridad.includes(",") || autoridad.split("@").length > 2) { anade("(cadena de conexion ambigua: varios hosts o varios @)"); continue; }
    const hostUrl = autoridad.includes("@") ? autoridad.slice(autoridad.indexOf("@") + 1) : autoridad;
    const sinPuerto = /^\[[^\]]*\]/.exec(hostUrl)?.[0] ?? hostUrl.split(":")[0] ?? "";
    const q = /[?&]host=([^&#]*)/i.exec(cs);
    let hostQ = "";
    try { hostQ = q ? decodeURIComponent(q[1] ?? "") : ""; } catch { hostQ = "(host invalido)"; }
    if (sinPuerto !== "") anade(safeDecode(sinPuerto));
    if (hostQ !== "") anade(hostQ);
    if (sinPuerto === "" && hostQ === "") anade("(cadena de conexion sin host)");
  }
  if (hosts.length === 0 && typeof pool.query === "function") anade(env.PGHOST || "localhost"); // pg usa PGHOST o localhost si no hay nada mas
  return hosts;
}

const safeDecode = (x: string): string => { try { return decodeURIComponent(x); } catch { return "(host invalido)"; } };

// Variables de entorno que el API/stack heredaria y que apuntan a servicios externos: todas deben ser loopback si estan definidas.
const RE_VAR_META = /^(META|WHATSAPP|GRAPH|FACEBOOK|FB)[A-Z0-9_]*(URL|URI|BASE|HOST|ENDPOINT|ORIGIN|DOMAIN|SERVER)$/;
const RE_VAR_HEREDADA = /^(DATABASE|DB|POSTGRES|PG|SUPABASE|STRIPE|REDIS|RESEND|TWILIO|SENDGRID|SENTRY)[A-Z0-9_]*(URL|URI|BASE|HOST|ENDPOINT|ORIGIN)$/;

/** Revisa el entorno ANTES de arrancar el stack: ninguna variable de Meta ni de servicios heredados puede apuntar fuera de loopback. */
export function validarEntorno(env: Record<string, string | undefined> = {}): void {
  for (const [k, v] of Object.entries(env)) {
    if (!v || !(RE_VAR_META.test(k) || RE_VAR_HEREDADA.test(k))) continue;
    if (!urlEsLoopback(v) && !hostEsLoopback(v)) throw new AbortoDeSeguridad(`la variable ${k} apunta fuera de loopback (host ${soloHost(v)})`);
  }
}

/**
 * Aborta si la API, la base o el Meta del stack no son locales/simulados. `s` es lo que devuelve `startStack()` del directorio de QA:
 * `s.api` (URL), `s.pool` (pg) y `s.metaSimulado === true` (o `s.metaUrl` loopback). API, base y Meta solo existen una vez arrancado el stack
 * (por eso esta parte corre despues de `startStack()` y, si falla, el stack se detiene); el entorno se valida antes con `validarEntorno`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- el stack viene del directorio de QA sin tipos
export function validarAislamiento(s: any, env: Record<string, string | undefined> = {}): void {
  validarEntorno(env);
  if (!urlEsLoopback(s?.api)) throw new AbortoDeSeguridad(`la API del stack (s.api) no es loopback (host ${soloHost(s?.api)})`);
  const hosts = hostsDePool(s?.pool, env);
  if (hosts.length === 0) throw new AbortoDeSeguridad("no se pudo determinar el host de la base (s.pool)");
  const fuera = hosts.find((h) => !hostEsLoopback(h));
  if (fuera !== undefined) throw new AbortoDeSeguridad(`la base (s.pool) no es local: host ${JSON.stringify(fuera.slice(0, 80))}`);
  const metaOk = s?.metaSimulado === true || urlEsLoopback(s?.metaUrl);
  if (!metaOk) throw new AbortoDeSeguridad("el Meta simulado no esta activo (el stack debe exponer metaSimulado:true o metaUrl loopback)");
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
export const CORTE_MAXIMO_USD = 100;
export function parseCorte(raw: string | undefined, maxRaw?: string): number {
  if (raw === undefined || raw === "") return 1.5;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new AbortoDeSeguridad(`VOZ_CORTE_USD invalido (${JSON.stringify(raw.slice(0, 20))}): debe ser un numero finito mayor que 0`);
  // Tope duro contra errores de dedo (1e308 apagaria el corte en la practica); subirlo exige declararlo con VOZ_CORTE_MAX_USD.
  let max = CORTE_MAXIMO_USD;
  if (maxRaw !== undefined && maxRaw !== "") {
    const m = Number(maxRaw);
    if (!Number.isFinite(m) || m <= 0) throw new AbortoDeSeguridad("VOZ_CORTE_MAX_USD invalido: debe ser un numero finito mayor que 0");
    max = m;
  }
  if (n > max) throw new AbortoDeSeguridad(`VOZ_CORTE_USD (${n}) supera el maximo permitido (${max} USD); para subirlo declara VOZ_CORTE_MAX_USD de forma explicita`);
  return n;
}

/** Cuenta propia del gasto: lo ya cerrado + la llamada en curso (aun si fallo) + cliente simulado/juez. */
export function gastoPropioUsd(p: { cerradoUsd: number; llamadaEnCursoUsd: number; clienteJuezUsd: number }): number {
  return p.cerradoUsd + p.llamadaEnCursoUsd + p.clienteJuezUsd;
}

/** Falla CERRADO: un gasto NaN/Infinity/indefinido (p. ej. un costo que llega sin numero) cuenta como tope excedido. */
export function excedeTope(gastoUsd: number, corteUsd: number): boolean {
  return !(Number.isFinite(gastoUsd) && gastoUsd < corteUsd);
}

/** Suma un costo solo si es un numero finito; si no, devuelve NaN para que el tope corte en vez de apagarse. */
export function sumarCosto(acum: number, delta: unknown): number {
  return typeof delta === "number" && Number.isFinite(delta) && delta >= 0 ? acum + delta : Number.NaN; // un delta negativo bajaria el gasto contado: tambien corta
}

// ---- telefonos ficticios ----
// 521 999 555 01xx sigue la convencion 555-01xx de ficcion del plan NANP; en la numeracion de Mexico NO existe un rango reservado equivalente, asi que este
// patron es solo una marca visible de "dato de prueba", NO una garantia. La garantia de que nunca se contacta a nadie son las guardas de aislamiento
// (API y base en loopback, Meta simulado que nunca envia) y que la base es efimera.
const BASE_FICTICIO = "52199955501";
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
  return texto
    .replace(/(key|token|bearer)[=: ]+[^&\s]+/gi, "$1=***")
    .replace(/sk-[\w-]+/g, "sk-***")
    .replace(/(\/\/)[^/\s@:]+:[^/\s@]*@/g, "$1***@") // usuario:clave@ dentro de una URL
    .replace(/(\/(?:Users|home)\/)[^/\s:]+/g, "$1***") // rutas absolutas con el nombre de la persona
    .replace(/([A-Za-z]:\\Users\\)[^\\\s]+/g, "$1***");
}

/** true si git IGNORA la ruta (gitignore, .git/info/exclude o ignore global): los resultados no deben poder subirse por accidente. false si no es un repo o no se ignora. */
export function ignoradoPorGit(ruta: string, cwd: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", ruta], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
