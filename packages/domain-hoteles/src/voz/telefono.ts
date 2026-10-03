import { normalizeContactPhone } from "../reservas-agente/validacion.ts";

/** Telefono de la llamada para hoteles: solo digitos y `+`, de 8 a 20 (hoteles recibe llamadas de cualquier pais); null si no es un numero. */
export function canonicalizarTelefonoHoteles(telefono: string): string | null {
  try {
    return normalizeContactPhone(telefono);
  } catch {
    return null;
  }
}
