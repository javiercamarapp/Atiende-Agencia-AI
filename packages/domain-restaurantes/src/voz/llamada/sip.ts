// Caller ID desde la cabecera SIP `From`: el parser es de @atiende/voice-core; restaurantes le inyecta su regla de telefono mexicano.
import { extraerTelefonoSipFrom as extraerCore } from "@atiende/voice-core";
import { canonicalizeMexicanPhone } from "../../phone.ts";

/** Devuelve el telefono canonico de 10 digitos, o null si el llamante es anonimo / no es un numero mexicano valido. */
export function extraerTelefonoSipFrom(cabecera: string | null | undefined): string | null {
  return extraerCore(cabecera, canonicalizeMexicanPhone);
}
