// Dia calendario de Merida (America/Merida, UTC-6 sin horario de verano) de un instante. Clave de dedupe "una por dia" de las alertas
// al dueño: se calcula con el reloj inyectado (nunca `new Date()` aqui) para que la prueba con reloj falso sea determinista.
const ZONA_ALERTAS = "America/Merida";

export function diaMerida(now: Date): string {
  // en-CA formatea YYYY-MM-DD; la zona fija evita depender de la zona horaria de la maquina o de Vercel (UTC).
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_ALERTAS, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
