// Salvaguardas de la CLI del seed (scripts/seed-pm-demo): el seed NUNCA escribe sin bandera explicita y
// SIEMPRE muestra a que base apunta. Contra una base que no sea local exige repetir el host exacto
// (`--confirm-host=<host>`): evita aplicar a produccion por accidente con una URL pegada de memoria.
// Puro (sin red ni fs) para poder probarse.

export interface SeedTarget {
  /** Host (o "socket local"), puerto y base; NUNCA incluye usuario ni contraseña. */
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly isLocal: boolean;
  /** Linea lista para imprimir. */
  readonly label: string;
}

export class SeedTargetError extends Error {}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function describirObjetivo(databaseUrl: string | undefined): SeedTarget {
  if (!databaseUrl || !databaseUrl.trim()) throw new SeedTargetError("Falta SEED_DATABASE_URL (a proposito NO se lee DATABASE_URL, para no apuntar a una base real por accidente).");
  let url: URL;
  try {
    url = new URL(databaseUrl.trim());
  } catch {
    throw new SeedTargetError("SEED_DATABASE_URL no es una URL valida (postgresql://usuario@host:puerto/base).");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new SeedTargetError("SEED_DATABASE_URL debe empezar con postgresql://");
  const socketDir = url.searchParams.get("host");
  const hostname = socketDir && socketDir.startsWith("/") ? "" : url.hostname || socketDir || "";
  const isLocal = hostname === "" || LOCAL_HOSTS.has(hostname.toLowerCase());
  const host = hostname === "" ? "socket local" : hostname;
  const port = url.port || "5432";
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "(sin base)";
  return { host, port, database, isLocal, label: `${host}:${port}/${database}${isLocal ? " (local)" : " (REMOTA)"}` };
}

export interface SeedFlags {
  readonly apply: boolean;
  readonly confirmHost: string | null;
}

/** Decide si se puede escribir. Lanza `SeedTargetError` con el motivo exacto si no. */
export function assertPuedeAplicar(target: SeedTarget, flags: SeedFlags): void {
  if (!flags.apply) throw new SeedTargetError("Sin --apply el seed es solo de lectura (dry-run).");
  if (target.isLocal) return;
  if (!flags.confirmHost) {
    throw new SeedTargetError(`La base ${target.label} NO es local: repita el host exacto con --confirm-host=${target.host} para aplicar. No lo haga contra produccion sin el OK del dueño.`);
  }
  if (flags.confirmHost.trim().toLowerCase() !== target.host.toLowerCase()) {
    throw new SeedTargetError(`--confirm-host (${flags.confirmHost}) no coincide con el host de SEED_DATABASE_URL (${target.host}).`);
  }
}

export function parseSeedArgs(argv: readonly string[]): {
  readonly apply: boolean;
  readonly confirmHost: string | null;
  readonly ownerEmail: string | null;
  readonly help: boolean;
  readonly demo: boolean;
} {
  let apply = false;
  let demo = false;
  let confirmHost: string | null = null;
  let ownerEmail: string | null = null;
  let help = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--demo") demo = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("--confirm-host=")) confirmHost = arg.slice("--confirm-host=".length);
    else if (arg.startsWith("--owner-email=")) ownerEmail = arg.slice("--owner-email=".length);
    else throw new SeedTargetError(`Argumento desconocido: ${arg}`);
  }
  return { apply, confirmHost, ownerEmail, help, demo };
}

export type VolumeScale = "ligero" | "moderado" | "completo";

export interface VolumeArgs {
  readonly apply: boolean;
  readonly confirmHost: string | null;
  readonly help: boolean;
  readonly orgSlug: string;
  readonly escala: VolumeScale;
  readonly dias: number | null;
  readonly pedidosPorDia: number | null;
  readonly semilla: number | null;
}

/** Slug de la cuenta demo por omision (el que carga `seed-pm-demo.ts --demo`). */
export const DEMO_ORG_SLUG_POR_OMISION = "los-taquitos-de-pm-demo";

function entero(valor: string, nombre: string): number {
  if (!/^\d{1,9}$/.test(valor)) throw new SeedTargetError(`${nombre} debe ser un entero positivo.`);
  return Number(valor);
}

export function parseVolumeArgs(argv: readonly string[]): VolumeArgs {
  let apply = false;
  let confirmHost: string | null = null;
  let help = false;
  let orgSlug = DEMO_ORG_SLUG_POR_OMISION;
  let escala: VolumeScale = "moderado";
  let dias: number | null = null;
  let pedidosPorDia: number | null = null;
  let semilla: number | null = null;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("--confirm-host=")) confirmHost = arg.slice("--confirm-host=".length);
    else if (arg.startsWith("--org-slug=")) orgSlug = arg.slice("--org-slug=".length);
    else if (arg.startsWith("--escala=")) {
      const v = arg.slice("--escala=".length);
      if (v !== "ligero" && v !== "moderado" && v !== "completo") throw new SeedTargetError("--escala debe ser ligero, moderado o completo.");
      escala = v;
    } else if (arg.startsWith("--dias=")) dias = entero(arg.slice("--dias=".length), "--dias");
    else if (arg.startsWith("--pedidos-por-dia=")) pedidosPorDia = entero(arg.slice("--pedidos-por-dia=".length), "--pedidos-por-dia");
    else if (arg.startsWith("--semilla=")) semilla = entero(arg.slice("--semilla=".length), "--semilla");
    else throw new SeedTargetError(`Argumento desconocido: ${arg}`);
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/.test(orgSlug)) throw new SeedTargetError("--org-slug invalido.");
  return { apply, confirmHost, help, orgSlug, escala, dias, pedidosPorDia, semilla };
}

export type CleanupMode = "volumen" | "sesiones_widget" | "todo";

export interface CleanupArgs {
  readonly apply: boolean;
  readonly confirmHost: string | null;
  readonly help: boolean;
  readonly orgSlug: string;
  readonly modo: CleanupMode;
  /** Solo borra lo que tenga al menos estas horas (0 = todo). Util para `sesiones_widget` ("sesiones de mas de 24 h"). */
  readonly horas: number;
}

export function parseCleanupArgs(argv: readonly string[]): CleanupArgs {
  let apply = false;
  let confirmHost: string | null = null;
  let help = false;
  let orgSlug = DEMO_ORG_SLUG_POR_OMISION;
  let modo: CleanupMode | null = null;
  let horas = 0;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("--confirm-host=")) confirmHost = arg.slice("--confirm-host=".length);
    else if (arg.startsWith("--org-slug=")) orgSlug = arg.slice("--org-slug=".length);
    else if (arg.startsWith("--modo=")) {
      const v = arg.slice("--modo=".length);
      if (v !== "volumen" && v !== "sesiones_widget" && v !== "todo") throw new SeedTargetError("--modo debe ser volumen, sesiones_widget o todo.");
      modo = v;
    } else if (arg.startsWith("--horas=")) horas = entero(arg.slice("--horas=".length), "--horas");
    else throw new SeedTargetError(`Argumento desconocido: ${arg}`);
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/.test(orgSlug)) throw new SeedTargetError("--org-slug invalido.");
  if (!help && modo === null) throw new SeedTargetError("Falta --modo=volumen|sesiones_widget|todo (la limpieza nunca adivina que borrar).");
  return { apply, confirmHost, help, orgSlug, modo: modo ?? "volumen", horas };
}
