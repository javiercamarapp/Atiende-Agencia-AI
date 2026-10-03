// Redaccion de la transcripcion ANTES de persistir (el agente nunca cobra: la tarjeta se paga al
// entregar, pero un cliente puede dictar su numero). Mismo criterio que WhatsApp: PAN y CVV.

function pasaLuhn(digitos: string): boolean {
  let suma = 0;
  let doble = false;
  for (let i = digitos.length - 1; i >= 0; i--) {
    let d = digitos.charCodeAt(i) - 48;
    if (doble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    suma += d;
    doble = !doble;
  }
  return suma % 10 === 0;
}

// 13 a 19 digitos, posiblemente separados por espacios o guiones.
const PAN_RE = /\b\d(?:[ -]?\d){12,18}\b/g;
// "cvv 123", "cvc: 1234", "codigo de seguridad 123".
const CVV_RE = /\b(cvv2?|cvc2?|c[oó]digo de seguridad)\b(\D{0,12})(\d{3,4})\b/gi;

export function redactarTranscripcion(texto: string): string {
  return texto
    .replace(PAN_RE, (m) => (pasaLuhn(m.replace(/[ -]/g, "")) ? "[TARJETA REDACTADA]" : m))
    .replace(CVV_RE, (_m, etiqueta: string, sep: string) => `${etiqueta}${sep}[REDACTADO]`);
}
