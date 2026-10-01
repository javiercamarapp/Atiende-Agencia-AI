// D-11 -- clasificacion y orden de la cola de trabajo de cobranza (puro, sin base de datos). La cola son las
// gestiones PENDIENTES de las cuentas por cobrar vivas; se ordena por urgencia real contra la fecha de negocio.
import type { GestionCobranza } from "./types.ts";

export type UrgenciaGestion = "promesa_vencida" | "seguimiento_vencido" | "vence_hoy" | "programada";

const ORDEN: Readonly<Record<UrgenciaGestion, number>> = { promesa_vencida: 0, seguimiento_vencido: 1, vence_hoy: 2, programada: 3 };

/** Fecha "relevante" de una gestion pendiente: la de la promesa o, si no, la de seguimiento. */
function fechaRelevante(g: GestionCobranza): string | null {
  return g.tipo === "promesa_pago" ? g.fechaPromesa : g.fechaSeguimiento;
}

export function urgenciaGestion(g: GestionCobranza, hoy: string): UrgenciaGestion {
  const f = fechaRelevante(g);
  if (f === null) return "programada";
  if (f < hoy) return g.tipo === "promesa_pago" ? "promesa_vencida" : "seguimiento_vencido";
  if (f === hoy) return "vence_hoy";
  return "programada";
}

export interface ItemCola<T extends { readonly gestion: GestionCobranza }> {
  readonly urgencia: UrgenciaGestion;
  readonly item: T;
}

/** Solo gestiones pendientes, ordenadas por urgencia, luego por fecha relevante y, a igualdad, por antiguedad de creacion. */
export function ordenarCola<T extends { readonly gestion: GestionCobranza }>(items: readonly T[], hoy: string): readonly ItemCola<T>[] {
  return items
    .filter((i) => i.gestion.estado === "pendiente")
    .map((item) => ({ urgencia: urgenciaGestion(item.gestion, hoy), item }))
    .sort((a, b) => {
      if (ORDEN[a.urgencia] !== ORDEN[b.urgencia]) return ORDEN[a.urgencia] - ORDEN[b.urgencia];
      const fa = fechaRelevante(a.item.gestion) ?? "9999-12-31";
      const fb = fechaRelevante(b.item.gestion) ?? "9999-12-31";
      if (fa !== fb) return fa < fb ? -1 : 1;
      if (a.item.gestion.creadoEn !== b.item.gestion.creadoEn) return a.item.gestion.creadoEn < b.item.gestion.creadoEn ? -1 : 1;
      return a.item.gestion.id < b.item.gestion.id ? -1 : 1;
    });
}
