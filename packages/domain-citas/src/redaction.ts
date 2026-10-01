import { redactarDatosDePago } from "@atiende/core-pii";

// Hallazgo real de la auditoría adversarial del origen de restaurantes (3-sep-2026,
// igual de aplicable aquí): un cliente puede compartir por accidente datos
// sensibles (número de tarjeta, y en citas — potencialmente datos médicos en
// `notes`) que se guardarían tal cual en texto plano si no se redactan antes de
// persistir cualquier mensaje real.
export function redactSensitiveInfo(text: string): string {
  return redactarDatosDePago(text);
}
