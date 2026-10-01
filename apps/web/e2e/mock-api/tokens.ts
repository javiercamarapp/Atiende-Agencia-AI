import { resolverPersona } from "./personas.ts";
import type { Persona } from "./tipos.ts";

/** Extrae el escenario y la persona del token "mock.<escenario>.<persona>.<n>" (o del refresh "mockr.…"). */
export function leerToken(token: string): { escenario: string; persona: Persona } | null {
  const partes = token.split(".");
  if (partes.length < 3 || (partes[0] !== "mock" && partes[0] !== "mockr")) return null;
  const persona = resolverPersona(partes[2]!);
  return persona ? { escenario: partes[1]!, persona } : null;
}
