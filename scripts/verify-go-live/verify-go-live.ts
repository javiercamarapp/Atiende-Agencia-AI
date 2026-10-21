// verify-go-live -- "¿esta organizacion esta lista para produccion?" desde la terminal. Corre EL MISMO calculo que la pestana "Listo para
// produccion" de la ficha (apps/api/src/superadmin-preflight/verificaciones.ts): lee con los mismos repositorios y delega en `evaluarPreflight`.
//
// SOLO LECTURA: toda la lectura va dentro de UNA transaccion `begin read only` que SIEMPRE termina en `rollback`; no escribe nada ni toca Vercel.
// Nunca imprime un valor de variable ni un secreto: solo nombres, booleanos y los textos de las verificaciones.
//
// Uso (lo corre Javier; ver docs/GO-LIVE.md):
//   GO_LIVE_DATABASE_URL=postgresql://... npm run verify:go-live -- --org los-taquitos-de-pm --superadmin <uuid-del-superadmin> [--env-file .env.production.local]
//
//   GO_LIVE_DATABASE_URL  conexion de SOLO LECTURA (por variable de entorno; nunca como argumento ni dentro del repo). Debe poder hacer
//                         `set local role authenticated` (como la que usa la API) para que las funciones de superadmin validen al llamador.
//   --superadmin <uuid>   id del superadmin (core.staff_user) bajo cuya identidad se leen las funciones de superadmin (tambien GO_LIVE_SUPERADMIN_ID).
//   --env-file <ruta>     archivo .env (p. ej. el de `vercel env pull`) del que se toma el entorno a verificar; sin el, el entorno del proceso.
//
// Codigo de salida: 0 = ninguna verificacion en "falta"; 1 = hay al menos una en "falta"; 2 = uso incorrecto; 3 = no se pudo leer (conexion, organizacion).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PostgresMfaRepository, PostgresOrgEquipoRepository, PostgresOrgPreflightRepository, PostgresSaludRepository } from "@atiende/db";
import type { OrgEquipo, OrgPreflightHechos } from "@atiende/db";
import { construirEstadoCrons } from "../../apps/api/src/routes/superadmin-salud.ts";
import type { CronConEstado } from "../../apps/api/src/salud/motor.ts";
import { evaluarPreflight } from "../../apps/api/src/superadmin-preflight/verificaciones.ts";
import type { FuentePreflight, PreflightArea, PreflightEntrada, ResultadoPreflight, Verificacion } from "../../apps/api/src/superadmin-preflight/verificaciones.ts";
import { sesionDesdePg } from "../seed-pm-demo/pg-session.ts";
import type { PgLikeClient } from "../seed-pm-demo/pg-session.ts";

export class GoLiveError extends Error {
  constructor(
    readonly codigoSalida: 2 | 3,
    message: string,
  ) {
    super(message);
    this.name = "GoLiveError";
  }
}

const USO = `Uso: GO_LIVE_DATABASE_URL=postgresql://... npm run verify:go-live -- --org <slug> --superadmin <uuid> [--env-file <ruta>]`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/u;

export interface GoLiveArgs {
  readonly org: string;
  readonly superadmin: string;
  readonly envFile: string | null;
}

/** Parsea los argumentos; lanza `GoLiveError(2)` con el uso si algo falta o no tiene la forma esperada. */
export function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): GoLiveArgs {
  const valores = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new GoLiveError(2, `Argumento no reconocido: ${a}\n${USO}`);
    const eq = a.indexOf("=");
    const nombre = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!["org", "superadmin", "env-file"].includes(nombre)) throw new GoLiveError(2, `Opcion no reconocida: --${nombre}\n${USO}`);
    const valor = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (valor === undefined || valor.startsWith("--")) throw new GoLiveError(2, `Falta el valor de --${nombre}\n${USO}`);
    valores.set(nombre, valor);
  }
  const org = valores.get("org") ?? "";
  if (!SLUG_RE.test(org)) throw new GoLiveError(2, `--org debe ser el slug de la organizacion.\n${USO}`);
  const superadmin = valores.get("superadmin") ?? env.GO_LIVE_SUPERADMIN_ID ?? "";
  if (!UUID_RE.test(superadmin)) throw new GoLiveError(2, `--superadmin (o GO_LIVE_SUPERADMIN_ID) debe ser el uuid del superadmin.\n${USO}`);
  return { org, superadmin, envFile: valores.get("env-file") ?? null };
}

/** Lee un archivo .env (`KEY=VALUE`, con o sin comillas, `#` comentarios). Los valores NUNCA se imprimen. */
export function parseEnvFile(contenido: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const linea of contenido.split(/\r?\n/u)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(linea);
    if (!m) continue;
    let valor = m[2]!.trim();
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) valor = valor.slice(1, -1);
    else valor = valor.replace(/\s+#.*$/u, "");
    out[m[1]!] = valor;
  }
  return out;
}

interface OrgFila {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly vertical: string;
  readonly status: string;
}

/** Lee TODO lo que necesita el calculo, dentro de una transaccion de solo lectura que siempre termina en rollback. */
export async function leerEntrada(client: PgLikeClient, args: { readonly org: string; readonly superadmin: string }, env: Readonly<Record<string, string | undefined>>): Promise<PreflightEntrada> {
  await client.query("begin read only");
  try {
    const org = (await client.query("select id, name, slug, vertical, status from core.organization where slug = $1;", [args.org])).rows[0] as OrgFila | undefined;
    if (!org) throw new GoLiveError(3, `La organizacion "${args.org}" no existe en la base consultada.`);

    // Mismas funciones de superadmin que usa la API: validan auth.uid() = p_caller_id y que sea superadmin real.
    try {
      await client.query("set local role authenticated");
    } catch {
      throw new GoLiveError(3, "La conexion no puede hacer `set local role authenticated` (como la que usa la API): usa una conexion con ese permiso.");
    }
    await client.query("select set_config('request.jwt.claim.sub', $1, true);", [args.superadmin]);
    const esSuperadmin = (await client.query("select core.is_platform_superadmin($1::uuid) as es;", [args.superadmin])).rows[0] as { es?: boolean } | undefined;
    if (esSuperadmin?.es !== true) throw new GoLiveError(3, "El usuario indicado en --superadmin no es superadmin de plataforma.");
    const db = sesionDesdePg(client);

    const equipo = await fuente<OrgEquipo | null>(await new PostgresOrgEquipoRepository(db).leer(args.superadmin, org.id));
    const hechos = await fuente<OrgPreflightHechos | null>(await new PostgresOrgPreflightRepository(db).hechos(args.superadmin, org.id));

    let crons: readonly CronConEstado[] | null = null;
    await client.query("savepoint preflight_crons");
    try {
      crons = construirEstadoCrons(await new PostgresSaludRepository(db).listCronHeartbeatsForSuperadmin(args.superadmin), new Date());
      await client.query("release savepoint preflight_crons");
    } catch {
      await client.query("rollback to savepoint preflight_crons");
    }

    // El factor MFA es de SISTEMA (auth.uid() nulo), como en /superadmin/mfa/estado.
    let mfaDelConsultante: boolean | null = null;
    await client.query("savepoint preflight_mfa");
    try {
      await client.query("select set_config('request.jwt.claim.sub', '', true);");
      const { availability, factor } = await new PostgresMfaRepository(db).getFactor(args.superadmin);
      mfaDelConsultante = availability === "not_migrated" ? null : factor?.status === "active";
      await client.query("release savepoint preflight_mfa");
    } catch {
      await client.query("rollback to savepoint preflight_mfa");
    }

    return { organizacion: { id: org.id, nombre: org.name, slug: org.slug, vertical: org.vertical, estado: org.status }, env, crons, equipo, hechos, mfaDelConsultante };
  } finally {
    await client.query("rollback");
  }
}

function fuente<T>(r: { readonly ok: true; readonly data: T } | { readonly ok: false; readonly razon: "no_migrado" | "error" }): FuentePreflight<T> {
  return r.ok ? { estado: "ok", dato: r.data } : { estado: r.razon };
}

const ROTULO: Readonly<Record<Verificacion["estado"], string>> = { ok: "OK      ", falta: "FALTA   ", aviso: "AVISO   ", no_aplica: "NO APLICA" };
const TITULO_AREA: Readonly<Record<PreflightArea, string>> = {
  entorno: "Entorno",
  crons: "Crons",
  equipo: "Equipo",
  canal: "Canal de WhatsApp",
  privacidad: "Privacidad",
  voz: "Voz",
  datos: "Datos del restaurante",
  monitoreo: "Monitoreo",
};

/** Texto del reporte: una linea por verificacion y, si no esta en orden, como resolverla. Sin secretos. */
export function formatearReporte(entrada: PreflightEntrada, r: ResultadoPreflight): string {
  const lineas: string[] = [`verify-go-live -- ${entrada.organizacion.nombre} (${entrada.organizacion.slug}, ${entrada.organizacion.vertical})`, ""];
  for (const area of Object.keys(TITULO_AREA) as PreflightArea[]) {
    const vs = r.verificaciones.filter((v) => v.area === area);
    if (vs.length === 0) continue;
    lineas.push(`## ${TITULO_AREA[area]}`);
    for (const v of vs) {
      lineas.push(`[${ROTULO[v.estado]}] ${v.titulo} (${v.id})`);
      lineas.push(`            ${v.detalle}`);
      if (v.estado === "falta" || v.estado === "aviso") lineas.push(`            -> ${v.como_resolver.texto}${v.como_resolver.enlace ? ` (${v.como_resolver.enlace})` : ""}`);
    }
    lineas.push("");
  }
  const s = r.resumen;
  lineas.push(`${s.ok} en orden, ${s.falta} faltan, ${s.aviso} avisos, ${s.no_aplica} no aplican (de ${s.total}).`);
  lineas.push(
    s.listo
      ? "LISTO: ninguna verificacion bloquea el go-live."
      : s.pendientes > 0
        ? `NO LISTO: ${s.pendientes} pendiente(s) bloquean el go-live.`
        : "NO LISTO: alguna fuente no se pudo leer por completo (ver los avisos); no se puede dar por listo lo que no se midio.",
  );
  return lineas.join("\n");
}

export function codigoDeSalida(r: ResultadoPreflight): 0 | 1 {
  return r.resumen.listo ? 0 : 1;
}

async function main(): Promise<number> {
  let args: GoLiveArgs;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const url = process.env.GO_LIVE_DATABASE_URL;
  if (!url) {
    console.error(`Falta GO_LIVE_DATABASE_URL (conexion de solo lectura, por variable de entorno).\n${USO}`);
    return 2;
  }
  let env: Readonly<Record<string, string | undefined>> = process.env;
  if (args.envFile) {
    try {
      env = parseEnvFile(readFileSync(args.envFile, "utf8"));
    } catch {
      console.error(`No se pudo leer el archivo de entorno ${args.envFile}.`);
      return 2;
    }
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch {
    console.error("No se pudo conectar a la base (revisa GO_LIVE_DATABASE_URL).");
    return 3;
  }
  try {
    const entrada = await leerEntrada(client as unknown as PgLikeClient, args, env);
    const resultado = evaluarPreflight(entrada);
    console.log(formatearReporte(entrada, resultado));
    return codigoDeSalida(resultado);
  } catch (err) {
    console.error(err instanceof GoLiveError ? err.message : "No se pudo leer el estado de la organizacion.");
    return err instanceof GoLiveError ? err.codigoSalida : 3;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function esModuloPrincipal(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (esModuloPrincipal()) {
  process.exit(await main());
}
