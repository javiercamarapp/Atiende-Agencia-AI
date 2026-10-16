// Marcador `{saludo}` del mensaje inicial de voz. El original (ORIG AdminDashboard.tsx:1470-1490) mandaba `{{saludo}}` calculado con
// la hora de Merida; en main el mensaje inicial era fijo. Se resuelve en el SERVIDOR con la zona horaria de la sucursal y la misma
// regla del agente (`saludoPorHora`: buenos dias 5:00-11:59, buenas tardes 12:00-19:59, buenas noches el resto), nunca con la hora
// del navegador ni la del proceso (UTC en Vercel).
import { saludoPorHora } from "@atiende/voice-core";

export const MARCADOR_SALUDO = "{saludo}";

/** Hora local entera (0-23) del instante en la zona dada. */
function horaLocal(instante: Date, zonaHoraria: string): number {
  const partes = new Intl.DateTimeFormat("en-GB", { timeZone: zonaHoraria, hour: "2-digit", hour12: false }).formatToParts(instante);
  const hora = Number(partes.find((p) => p.type === "hour")?.value ?? Number.NaN);
  // `hour12: false` puede dar "24" a medianoche en algunos motores.
  return hora === 24 ? 0 : hora;
}

/** Reemplaza cada `{saludo}` por «buenos días / buenas tardes / buenas noches» segun la hora local; al inicio de la frase va con
 * mayuscula inicial. Un texto sin marcador se devuelve intacto. */
export function resolverMarcadorSaludo(texto: string, zonaHoraria: string, ahora: Date = new Date()): string {
  if (!texto.includes(MARCADOR_SALUDO)) return texto;
  const saludo = saludoPorHora(horaLocal(ahora, zonaHoraria));
  return texto.replace(/\{saludo\}/g, (_m, offset: number, completo: string) => {
    // Inicio de frase = inicio del texto o tras un cierre de oracion / salto de linea (y espacios).
    const inicioDeFrase = /(^|[.!?\n])\s*$/.test(completo.slice(0, offset));
    return inicioDeFrase ? `${saludo.charAt(0).toUpperCase()}${saludo.slice(1)}` : saludo;
  });
}
