// Argumentos de la CLI del seed de la cuenta demo (puro, para poder probarlo sin ejecutar nada).
import { SeedTargetError } from "../target-safety.ts";

export interface DemoCuentaArgs {
  readonly apply: boolean;
  readonly confirmHost: string | null;
  readonly help: boolean;
  /** Ruta del .sql a generar (modo emitir: no abre ninguna conexion). */
  readonly emitSql: string | null;
  /** Correo de un usuario de staff EXISTENTE que se enlaza como owner (opcional). */
  readonly ownerEmail: string | null;
}

export function parseArgs(argv: readonly string[]): DemoCuentaArgs {
  let apply = false;
  let confirmHost: string | null = null;
  let help = false;
  let emitSql: string | null = null;
  let ownerEmail: string | null = null;
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--apply") apply = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("--confirm-host=")) confirmHost = arg.slice("--confirm-host=".length);
    else if (arg.startsWith("--emit-sql=")) emitSql = arg.slice("--emit-sql=".length).trim();
    else if (arg.startsWith("--owner-email=")) ownerEmail = arg.slice("--owner-email=".length).trim();
    else throw new SeedTargetError(`Argumento desconocido: ${arg}`);
  }
  if (emitSql !== null && emitSql === "") throw new SeedTargetError("--emit-sql necesita una ruta: --emit-sql=<archivo.sql>");
  if (ownerEmail !== null && ownerEmail === "") throw new SeedTargetError("--owner-email necesita un correo: --owner-email=<correo>");
  if (emitSql !== null && (apply || confirmHost !== null)) throw new SeedTargetError("--emit-sql solo genera un archivo (sin conexion): no se combina con --apply ni --confirm-host.");
  return { apply, confirmHost, help, emitSql, ownerEmail };
}
