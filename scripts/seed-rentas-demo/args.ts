// Argumentos y salvaguardas de la CLI del seed demo de rentas. Puro (sin red ni fs) para poder probarse. Reusa `describirObjetivo` del seed de PM
// (SEED_DATABASE_URL a proposito distinta de DATABASE_URL; la base objetivo siempre se imprime).
//
// Politica de seguridad:
//   * sin banderas es DRY-RUN: imprime el plan y NO abre ninguna conexion;
//   * escribir exige --confirmar Y --owner-email=<correo de un staff que ya existe> (el seed no crea credenciales);
//   * una base que NO sea local se considera PRODUCCION: exige ademas --confirm-host=<host exacto> y --confirmar-produccion.
//     NUNCA se corre contra la base real sin el OK de Javier.
import { describirObjetivo, SeedTargetError } from "../../packages/domain-restaurantes/src/seed/target-safety.ts";
import type { SeedTarget } from "../../packages/domain-restaurantes/src/seed/target-safety.ts";

export { describirObjetivo, SeedTargetError };

export interface SeedArgs {
  readonly dryRun: boolean;
  readonly confirmar: boolean;
  readonly ownerEmail: string | null;
  readonly confirmHost: string | null;
  readonly confirmarProduccion: boolean;
  readonly help: boolean;
}

export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  let dryRun = false;
  let confirmar = false;
  let ownerEmail: string | null = null;
  let confirmHost: string | null = null;
  let confirmarProduccion = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--confirmar") confirmar = true;
    else if (arg === "--confirmar-produccion") confirmarProduccion = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("--owner-email=")) ownerEmail = arg.slice("--owner-email=".length).trim() || null;
    else if (arg.startsWith("--confirm-host=")) confirmHost = arg.slice("--confirm-host=".length);
    else throw new SeedTargetError(`Argumento desconocido: ${arg}`);
  }
  if (ownerEmail !== null && !/^[^\s@'$]+@[^\s@'$]+\.[^\s@'$]+$/.test(ownerEmail)) throw new SeedTargetError("--owner-email no es un correo valido.");
  if (dryRun && confirmar) throw new SeedTargetError("--dry-run y --confirmar son excluyentes.");
  return { dryRun, confirmar, ownerEmail, confirmHost, confirmarProduccion, help };
}

/** Escribir exige las dos banderas: `--confirmar` y `--owner-email`. Lanza con el motivo exacto si falta alguna. */
export function assertBanderasDeEscritura(args: SeedArgs): void {
  if (!args.confirmar) throw new SeedTargetError("Sin --confirmar el seed es solo de lectura (dry-run).");
  if (!args.ownerEmail) throw new SeedTargetError("Escribir exige --owner-email=<correo de un usuario de staff que ya exista>: el seed no crea credenciales.");
}

/** Una base que no es local se trata como produccion: exige el host exacto y --confirmar-produccion. */
export function assertObjetivoPermitido(target: SeedTarget, args: Pick<SeedArgs, "confirmHost" | "confirmarProduccion">): void {
  if (target.isLocal) return;
  if (!args.confirmarProduccion) {
    throw new SeedTargetError(`La base ${target.label} NO es local: parece produccion. Agregue --confirmar-produccion y --confirm-host=${target.host} SOLO con el OK explicito del dueño de la cuenta.`);
  }
  if (!args.confirmHost) throw new SeedTargetError(`La base ${target.label} NO es local: repita el host exacto con --confirm-host=${target.host}.`);
  if (args.confirmHost.trim().toLowerCase() !== target.host.toLowerCase()) {
    throw new SeedTargetError(`--confirm-host (${args.confirmHost}) no coincide con el host de SEED_DATABASE_URL (${target.host}).`);
  }
}
