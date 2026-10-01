// D-21 -- validación del RFC de un contribuyente cliente del despacho. Estructura del SAT: 3 letras (moral, 12
// caracteres) o 4 letras (física, 13), fecha AAMMDD de constitución/nacimiento REAL, y homoclave de 3 caracteres.
// NO verifica el dígito verificador de la homoclave ni que el RFC exista en la LRFC del SAT (eso requiere una
// consulta al SAT que este sistema no hace); un RFC bien formado pero inexistente pasa.
export type TipoPersona = "fisica" | "moral";

/** RFC genéricos del SAT (público en general / extranjero): no identifican a un cliente del despacho. */
export const RFCS_GENERICOS: ReadonlySet<string> = new Set(["XAXX010101000", "XEXX010101000"]);

const RFC_ESTRUCTURA = /^([A-ZÑ&]{3,4})(\d{2})(\d{2})(\d{2})([A-Z0-9]{3})$/;

export type ResultadoRfc =
  | { readonly ok: true; readonly rfc: string; readonly tipoPersona: TipoPersona }
  | { readonly ok: false; readonly motivo: string };

function diasDelMes(mes: number): number {
  // El año de 2 dígitos es ambiguo (19AA/20AA): se admite el 29 de febrero porque alguno de los dos siglos es bisiesto.
  return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mes - 1]!;
}

export function validarRfcCliente(crudo: unknown): ResultadoRfc {
  if (typeof crudo !== "string") return { ok: false, motivo: "El RFC es obligatorio." };
  const rfc = crudo.trim().toUpperCase();
  if (rfc.length === 0) return { ok: false, motivo: "El RFC es obligatorio." };
  if (RFCS_GENERICOS.has(rfc)) return { ok: false, motivo: "Un RFC genérico (público en general o extranjero) no identifica a un cliente." };
  if (rfc.length !== 12 && rfc.length !== 13) return { ok: false, motivo: "El RFC debe tener 12 (persona moral) o 13 (persona física) caracteres." };
  const m = RFC_ESTRUCTURA.exec(rfc);
  if (!m) return { ok: false, motivo: "El RFC tiene caracteres o una estructura inválidos." };
  const letras = m[1]!;
  const mes = Number(m[3]);
  const dia = Number(m[4]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > diasDelMes(mes)) return { ok: false, motivo: "La fecha dentro del RFC no es válida." };
  return { ok: true, rfc, tipoPersona: letras.length === 3 ? "moral" : "fisica" };
}
