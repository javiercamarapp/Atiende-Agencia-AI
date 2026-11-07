// ═══════════════════════════════════════════════════════════════════════════
// ALERTAS DEL COCKPIT CFO que el dashboard ejecutivo (cfo.ts) no cubre: cliente sobre el pool de su
// plan, pico de costo por organizacion y movimiento del tipo de cambio. Margen bajo y cobranza
// (pago fallido) ya los evalua `evaluarAlertasCfo`; aqui no se duplican.
// Funcion PURA: una alerta por regla con la lista de organizaciones, sin PII (nombre de la
// organizacion y el dato que la dispara).
// ═══════════════════════════════════════════════════════════════════════════
import type { OrganizacionAlertada, SeveridadAlertaCfo } from '../cfo.ts';
import type { FilaEconomia } from './economia.ts';

export type CodigoAlertaCockpit = 'pool_excedido' | 'pico_costo' | 'movimiento_fx';

export interface AlertaCockpit {
  readonly codigo: CodigoAlertaCockpit;
  readonly severidad: SeveridadAlertaCfo;
  readonly titulo: string;
  readonly organizaciones: readonly OrganizacionAlertada[];
}

export interface EntradaAlertasCockpit {
  readonly economia: readonly FilaEconomia[];
  /** Movimiento del tipo de cambio en ~30 dias (%); `null` sin dato. */
  readonly movimientoFxPct: number | null;
  readonly umbralFxPct: number;
  readonly umbralPicoCostoPct: number;
}

export function evaluarAlertasCockpit(e: EntradaAlertasCockpit): readonly AlertaCockpit[] {
  const pool: OrganizacionAlertada[] = [];
  const pico: OrganizacionAlertada[] = [];
  for (const f of e.economia) {
    if (f.orgStatus !== 'active') continue;
    const base = { organizationId: f.organizationId, nombre: f.nombre };
    if (f.banderas.includes('sobre_el_tope')) {
      const partes: string[] = [];
      if (f.poolVoz && (f.poolVoz.pct ?? 0) > 100) partes.push(`voz ${f.poolVoz.pct} % de ${f.poolVoz.incluido} min`);
      if (f.poolWa && (f.poolWa.pct ?? 0) > 100) partes.push(`WhatsApp ${f.poolWa.pct} % de ${f.poolWa.incluido} conversaciones`);
      pool.push({ ...base, dato: partes.join(' y ') });
    }
    if (f.banderas.includes('pico_costo')) pico.push({ ...base, dato: `costo diario más de ${e.umbralPicoCostoPct} % arriba del mes anterior` });
  }
  const orden = (a: OrganizacionAlertada, b: OrganizacionAlertada) => a.nombre.localeCompare(b.nombre) || a.organizationId.localeCompare(b.organizationId);
  const alertas: AlertaCockpit[] = [];
  if (pool.length > 0) alertas.push({ codigo: 'pool_excedido', severidad: 'alta', titulo: 'Clientes arriba de lo incluido en su plan', organizaciones: pool.sort(orden) });
  if (pico.length > 0) alertas.push({ codigo: 'pico_costo', severidad: 'media', titulo: 'Pico de costo por cliente', organizaciones: pico.sort(orden) });
  if (e.movimientoFxPct !== null && Math.abs(e.movimientoFxPct) >= e.umbralFxPct) {
    alertas.push({
      codigo: 'movimiento_fx',
      severidad: e.movimientoFxPct > 0 ? 'alta' : 'media',
      titulo: `El dólar se movió ${e.movimientoFxPct > 0 ? '+' : ''}${e.movimientoFxPct} % en 30 días`,
      organizaciones: [],
    });
  }
  return alertas;
}
