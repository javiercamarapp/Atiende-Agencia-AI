// Hallazgo real de la auditoría adversarial del origen de restaurantes (3-sep-2026,
// igual de aplicable aquí): un cliente puede compartir por accidente datos
// sensibles (número de tarjeta, y en citas — potencialmente datos médicos en
// `notes`) que se guardarían tal cual en texto plano si no se redactan antes de
// persistir cualquier mensaje real.
export function redactSensitiveInfo(text: string): string {
  return text
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[tarjeta oculta]")
    .replace(/\b(?:cvv|cvc|c\.?v\.?v\.?)\s*:?\s*\d{3,4}\b/gi, "[cvv oculto]")
    .replace(/\b\d{1,2}\/\d{2,4}\b/g, "[vencimiento oculto]");
}
