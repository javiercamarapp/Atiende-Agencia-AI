import type { PrioridadTareaOperativa, TipoTareaOperativa } from "./tipos.ts";

/**
 * SLA internos (H-055/BACKLOG E08) — port de
 * rentas/packages/domain/src/limpieza/sla.ts: vencimiento calculado desde el momento
 * de creación de la tarea + horas configuradas por property y tipo. La prioridad
 * ajusta el SLA base (urgente = mitad del tiempo, baja = doble) — puramente
 * informativo para operación interna, nunca ligado a ningún SLA contractual con
 * huésped/canal.
 */
const MULTIPLICADOR_POR_PRIORIDAD: Record<PrioridadTareaOperativa, number> = {
  urgente: 0.5,
  alta: 0.75,
  media: 1,
  baja: 2,
};

export function calcularVencimientoSla(
  creadaEnIso: string,
  tipo: TipoTareaOperativa,
  prioridad: PrioridadTareaOperativa,
  slaHorasPorTipo: { readonly slaLimpiezaHoras: number; readonly slaMantenimientoHoras: number },
): string {
  const horasBase = tipo === "mantenimiento" ? slaHorasPorTipo.slaMantenimientoHoras : slaHorasPorTipo.slaLimpiezaHoras;
  const horasEfectivas = Math.max(1, Math.round(horasBase * MULTIPLICADOR_POR_PRIORIDAD[prioridad]));
  const creada = new Date(creadaEnIso);
  const vence = new Date(creada.getTime() + horasEfectivas * 60 * 60 * 1000);
  return vence.toISOString();
}

/** `true` si la tarea está vencida a `ahoraIso` (por defecto, ahora) y aún no se
 * completó — usado tanto para alertas internas como para el tablero de turnos
 * (nunca dispara ninguna acción automática sobre la reserva). */
export function tareaVencida(slaVenceEnIso: string | null, completadaEnIso: string | null, ahoraIso: string = new Date().toISOString()): boolean {
  if (!slaVenceEnIso || completadaEnIso) return false;
  return new Date(slaVenceEnIso).getTime() < new Date(ahoraIso).getTime();
}
