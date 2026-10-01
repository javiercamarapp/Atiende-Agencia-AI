// Arma las filas del dashboard CFO a partir de lo que devuelve `core.get_cfo_dashboard_for_superadmin`
// (o su gemela de solo-sistema para el cron). Una sola construccion para el dashboard y para las
// alertas: asi la pantalla y el aviso saliente nunca muestran cifras distintas.
import { calcularFilaCostoMargen, UMBRAL_MARGEN_PCT_DEFAULT } from "@atiende/billing";
import type { EntradaCostoMargen, FilaCfo } from "@atiende/billing";
import type { CfoOrgRow } from "@atiende/db";

export { UMBRAL_MARGEN_PCT_DEFAULT };

export interface TipoCambioCfo {
  readonly mxnPorUsd: number;
  readonly fecha: string | null;
  readonly fuente: string | null;
}

/** El tipo de cambio es el mismo en todas las filas (lo elige la base por mes); sin filas o sin tipo, null. */
export function tipoCambioDeFilas(rows: readonly CfoOrgRow[]): TipoCambioCfo | null {
  const r = rows.find((x) => x.mxnPorUsd !== null);
  return r && r.mxnPorUsd !== null ? { mxnPorUsd: r.mxnPorUsd, fecha: r.fxFecha, fuente: r.fxFuente } : null;
}

export function construirFilasCfo(rows: readonly CfoOrgRow[], opciones: { readonly umbralMargenPct: number; readonly mxnPorUsd: number | null }): FilaCfo[] {
  return rows.map((r) => {
    const entrada: EntradaCostoMargen = {
      organizationId: r.organizationId,
      nombre: r.organizationName,
      slug: r.organizationSlug,
      vertical: r.vertical,
      orgStatus: r.orgStatus,
      plan: r.planId
        ? { id: r.planId, nombre: r.planNombre ?? r.planId, precioBaseCentavos: r.precioBaseCentavos, precioAsientoCentavos: r.precioAsientoCentavos, asientosIncluidos: r.asientosIncluidos ?? 0 }
        : null,
      limites: r.limites.map((l) => ({ metrica: l.metrica, limite: l.limite, accion: l.accion })),
      billingStatus: r.billingStatus,
      billingSeats: r.billingSeats,
      sucursalesActivas: r.sucursalesActivas,
      costo: { llm: r.llmMicroUsd, voz: r.vozMicroUsd, whatsapp: r.whatsappMicroUsd, telefonia: r.telefoniaMicroUsd, otros: r.otrosMicroUsd },
      eventosTotal: r.eventosTotal,
      eventosEstimados: r.eventosEstimados,
      minutosVoz: r.minutosVoz,
      mensajes: r.mensajes,
      llmCapMicroUsd: r.llmCapMicroUsd,
      llmAlertPct: r.llmAlertPct,
    };
    return {
      fila: calcularFilaCostoMargen(entrada, { mxnPorUsd: opciones.mxnPorUsd, umbralMargenPct: opciones.umbralMargenPct }),
      billingStatus: r.billingStatus,
      billingPeriodEndMs: r.billingPeriodEndMs,
    };
  });
}
