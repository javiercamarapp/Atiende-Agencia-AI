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

export function parseSeedArgs(argv: readonly string[]): { readonly apply: boolean; readonly confirmHost: string | null; readonly ownerEmail: string | null; readonly help: boolean } {
  let apply = false;
  let confirmHost: string | null = null;
  let ownerEmail: string | null = null;
  let help = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("--confirm-host=")) confirmHost = arg.slice("--confirm-host=".length);
    else if (arg.startsWith("--owner-email=")) ownerEmail = arg.slice("--owner-email=".length);
    else throw new SeedTargetError(`Argumento desconocido: ${arg}`);
  }
  return { apply, confirmHost, ownerEmail, help };
}
