// Argumentos y salvaguardas de las CLIs del seed demo de citas. Puro (sin red ni fs) para poder probarse. Reusa
// `describirObjetivo`/`assertPuedeAplicar` del seed de PM (misma politica: SEED_DATABASE_URL a proposito distinta de
// DATABASE_URL, base objetivo siempre impresa, `--confirm-host` obligatorio contra una base que no sea local).
import { NEGOCIOS_DEMO } from "../../packages/domain-citas/src/seed/citas-demo-data.ts";
import { SeedTargetError } from "../../packages/domain-restaurantes/src/seed/target-safety.ts";

export { assertPuedeAplicar, describirObjetivo, SeedTargetError } from "../../packages/domain-restaurantes/src/seed/target-safety.ts";

export const SLUGS_DEMO: readonly string[] = NEGOCIOS_DEMO.map((n) => n.slug);

export interface SeedArgs {
  readonly confirmar: boolean;
  readonly ownerEmail: string | null;
  readonly fechaBase: string | null;
  readonly confirmHost: string | null;
  readonly help: boolean;
}

export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  let confirmar = false;
  let ownerEmail: string | null = null;
  let fechaBase: string | null = null;
  let confirmHost: string | null = null;
  let help = false;
  for (const arg of argv) {
    if (arg === "--confirmar") confirmar = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("--owner-email=")) ownerEmail = arg.slice("--owner-email=".length).trim() || null;
    else if (arg.startsWith("--fecha-base=")) fechaBase = arg.slice("--fecha-base=".length);
    else if (arg.startsWith("--confirm-host=")) confirmHost = arg.slice("--confirm-host=".length);
    else throw new SeedTargetError(`Argumento desconocido: ${arg}`);
  }
  if (fechaBase !== null && !/^\d{4}-\d{2}-\d{2}$/.test(fechaBase)) throw new SeedTargetError("--fecha-base debe ser YYYY-MM-DD.");
  if (ownerEmail !== null && !/^[^\s@'$]+@[^\s@'$]+\.[^\s@'$]+$/.test(ownerEmail)) throw new SeedTargetError("--owner-email no es un correo valido.");
  return { confirmar, ownerEmail, fechaBase, confirmHost, help };
}

/** Escribir exige las dos banderas: `--confirmar` y `--owner-email`. Lanza con el motivo exacto si falta alguna. */
export function assertBanderasDeEscritura(args: SeedArgs): void {
  if (!args.confirmar) throw new SeedTargetError("Sin --confirmar el seed es solo de lectura (dry-run).");
  if (!args.ownerEmail) throw new SeedTargetError("Escribir exige --owner-email=<correo de un usuario de staff que ya exista>: el seed no crea credenciales.");
}

export interface LimpiarArgs {
  readonly confirmar: boolean;
  readonly confirmHost: string | null;
  readonly help: boolean;
  readonly slugs: readonly string[];
}

export function parseLimpiarArgs(argv: readonly string[]): LimpiarArgs {
  let confirmar = false;
  let confirmHost: string | null = null;
  let help = false;
  let todas = false;
  const slugs: string[] = [];
  for (const arg of argv) {
    if (arg === "--confirmar") confirmar = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--todas") todas = true;
    else if (arg.startsWith("--confirm-host=")) confirmHost = arg.slice("--confirm-host=".length);
    else if (arg.startsWith("--org-slug=")) slugs.push(arg.slice("--org-slug=".length));
    else throw new SeedTargetError(`Argumento desconocido: ${arg}`);
  }
  for (const s of slugs) if (!/^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/.test(s)) throw new SeedTargetError(`--org-slug invalido: ${s}`);
  if (!help && !todas && slugs.length === 0) throw new SeedTargetError("Indique --org-slug=<slug> (repetible) o --todas (las dos cuentas demo).");
  return { confirmar, confirmHost, help, slugs: todas ? [...new Set([...SLUGS_DEMO, ...slugs])] : slugs };
}
