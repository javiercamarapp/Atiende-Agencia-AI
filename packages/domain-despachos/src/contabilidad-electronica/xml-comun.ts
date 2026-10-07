// Utilidades compartidas por los generadores de XML de contabilidad electrónica 1.3 (catálogo, balanza y pólizas del periodo).
// Todo el XML se arma como texto con atributos escapados; la conformidad con el XSD oficial se prueba en
// tests/contabilidad-electronica-xsd.spec.ts (validador XSD real, dependencia de desarrollo).

/** Patrón de RFC de los XSD del SAT (personas morales y físicas, con homoclave). */
export const RFC_SAT_RE = /^[A-ZÑ&]{3,4}[0-9]{2}[0-1][0-9][0-3][0-9][A-Z0-9]?[A-Z0-9]?[0-9A-Z]?$/;

export class ContabilidadElectronicaDatosInvalidosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContabilidadElectronicaDatosInvalidosError";
  }
}

export function exigirRfcSat(rfc: unknown): string {
  const valor = typeof rfc === "string" ? rfc.trim().toUpperCase() : "";
  if (valor.length < 12 || valor.length > 13 || !RFC_SAT_RE.test(valor)) {
    throw new ContabilidadElectronicaDatosInvalidosError("El RFC del cliente no tiene el formato que exige el XSD del SAT: captura el RFC correcto en la ficha del cliente.");
  }
  return valor;
}

export function exigirEjercicioYMes(ejercicio: number, mes: number, maxMes = 12): void {
  if (!Number.isInteger(ejercicio) || ejercicio < 2015 || ejercicio > 2099) {
    throw new ContabilidadElectronicaDatosInvalidosError("Ejercicio fuera del rango del XSD del SAT (2015 a 2099).");
  }
  if (!Number.isInteger(mes) || mes < 1 || mes > maxMes) {
    throw new ContabilidadElectronicaDatosInvalidosError(`Mes fuera del rango del XSD del SAT (1 a ${maxMes}).`);
  }
}

export function mesDosDigitos(mes: number): string {
  return String(mes).padStart(2, "0");
}

/** Escapa un valor de atributo XML. Quita los caracteres de control que XML 1.0 prohíbe y normaliza saltos/tabuladores a espacio. */
export function escaparAtributoXml(valor: string): string {
  return valor
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[\t\n\r]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Recorta un texto libre al máximo que fija el XSD (sin cortar un par sustituto a la mitad). */
export function recortarTexto(valor: string, max: number): string {
  const limpio = valor.trim();
  const unidades = Array.from(limpio);
  return unidades.length <= max ? limpio : unidades.slice(0, max).join("").trimEnd();
}

/** Centavos enteros -> "1234.56" exacto, con signo, sin flotantes (t_Importe del XSD: 2 decimales). */
export function importeDesdeCentavos(centavos: number): string {
  if (!Number.isSafeInteger(centavos)) throw new ContabilidadElectronicaDatosInvalidosError("Importe fuera del rango entero seguro.");
  const abs = Math.abs(centavos);
  return `${centavos < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
