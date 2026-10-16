// Argumentos de la CLI del seed de la cuenta demo (puro, para poder probarlo sin ejecutar nada).
import { SeedTargetError } from "../target-safety.ts";

export function parseArgs(argv: readonly string[]): { readonly apply: boolean; readonly confirmHost: string | null; readonly help: boolean } {
  let apply = false;
  let confirmHost: string | null = null;
  let help = false;
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--apply") apply = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("--confirm-host=")) confirmHost = arg.slice("--confirm-host=".length);
    else throw new SeedTargetError(`Argumento desconocido: ${arg}`);
  }
  return { apply, confirmHost, help };
}
