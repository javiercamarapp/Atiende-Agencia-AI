import { normalizePhone } from "../appointments.ts";

/** Telefono de la llamada para citas: mismo criterio que WhatsApp y el panel (los ultimos 10 digitos, `normalizePhone`), asi la persona que
 * llama y la que escribio por WhatsApp son el MISMO cliente. null si el SIP From no trae un numero (menos de 7 digitos): llamante anonimo. */
export function canonicalizarTelefonoCitas(telefono: string): string | null {
  const digitos = telefono.replace(/\D/g, "");
  if (digitos.length < 7) return null;
  return normalizePhone(telefono);
}
