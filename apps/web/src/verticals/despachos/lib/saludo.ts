// Saludo del Resumen de despachos según la hora de negocio (America/Mexico_City), no la del navegador:
// los despachos operan sobre el calendario fiscal del SAT. Misma regla de franjas que `saludoPorHora`.
const TZ = "America/Mexico_City";

export function horaMexico(fecha: Date): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(fecha);
  return Number(h) % 24;
}

export function saludoDespacho(fecha: Date = new Date()): "Buenos días" | "Buenas tardes" | "Buenas noches" {
  const hora = horaMexico(fecha);
  if (hora >= 5 && hora < 12) return "Buenos días";
  if (hora >= 12 && hora < 20) return "Buenas tardes";
  return "Buenas noches";
}
