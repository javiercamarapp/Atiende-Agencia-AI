// ═══════════════════════════════════════════════════════════════════════════
// SUPUESTOS DEL CFO DE LA PLATAFORMA: costo unitario y umbrales.
//
// Cada supuesto tiene un valor MEDIDO de referencia (con su fuente) que el superadmin puede
// sobrescribir en `core.cfo_supuesto` (migracion 0085). Si no hay valor medido ni capturado, el
// supuesto es `null` y el costo que dependa de el sale "sin dato", nunca 0.
//
// Valores medidos (pm-cuenta-real/COSTOS-MEDIDOS.md, corridas del 6 y 7 de noviembre de 2026):
//   * Voz con ElevenLabs Agents (worker real + LiveKit Cloud + Krisp): 0.044-0.045 USD/min en tres
//     corridas (0.045 la mas reciente con linea limpia). Se toma 0.045.
//   * LLM del agente de WhatsApp (cerebro_v2, ZDR): 0.0141-0.0192 USD por conversacion; se toma la
//     corrida con mas repeticiones (C3 x3, 7-nov): 0.0192 USD/conversacion.
//   * Voz con gemini-3.8-live o gpt-live-1, telefonia y la tarifa de Meta por conversacion: SIN
//     medicion propia -> sin valor de referencia (el dueño lo captura con su fuente).
// ═══════════════════════════════════════════════════════════════════════════

export type ClaveSupuesto =
  | 'voz_usd_minuto'
  | 'telefonia_usd_minuto'
  | 'llm_usd_conversacion_wa'
  | 'whatsapp_usd_conversacion'
  | 'umbral_margen_pct'
  | 'umbral_pool_pct'
  | 'umbral_pico_costo_pct'
  | 'umbral_fx_pct'
  | 'ltv_meses_tope';

/** Una fila capturada (lo que devuelve `core.list_cfo_supuestos_*`). */
export interface SupuestoCapturado {
  readonly clave: ClaveSupuesto;
  readonly proveedor: string;
  readonly valor: number;
  readonly fuente: string;
}

export type OrigenSupuesto = 'medido' | 'capturado' | 'por_omision';

export interface ValorSupuesto {
  readonly valor: number;
  readonly fuente: string;
  readonly origen: OrigenSupuesto;
}

interface Referencia {
  readonly clave: ClaveSupuesto;
  readonly proveedor: string;
  readonly valor: number;
  readonly fuente: string;
  readonly origen: Exclude<OrigenSupuesto, 'capturado'>;
}

/** Valores de referencia. `medido` = medicion real; `por_omision` = decision de producto (umbrales). */
export const SUPUESTOS_REFERENCIA: readonly Referencia[] = [
  { clave: 'voz_usd_minuto', proveedor: 'elevenlabs-agents', valor: 0.045, fuente: 'Medido 7-nov-2026: worker de voz real con LiveKit, 0.044-0.045 USD/min (COSTOS-MEDIDOS)', origen: 'medido' },
  { clave: 'llm_usd_conversacion_wa', proveedor: '*', valor: 0.0192, fuente: 'Medido 7-nov-2026: agente de WhatsApp C3 x3, 0.0192 USD por conversacion (COSTOS-MEDIDOS)', origen: 'medido' },
  { clave: 'umbral_margen_pct', proveedor: '*', valor: 30, fuente: 'Umbral por omision del CFO (mismo que el dashboard ejecutivo)', origen: 'por_omision' },
  { clave: 'umbral_pool_pct', proveedor: '*', valor: 90, fuente: 'Umbral por omision: aviso al 90 % de lo incluido en el plan', origen: 'por_omision' },
  { clave: 'umbral_pico_costo_pct', proveedor: '*', valor: 50, fuente: 'Umbral por omision: costo diario 50 % arriba del mes anterior', origen: 'por_omision' },
  { clave: 'umbral_fx_pct', proveedor: '*', valor: 3, fuente: 'Umbral por omision: movimiento del tipo de cambio de 3 % en 30 dias', origen: 'por_omision' },
  { clave: 'ltv_meses_tope', proveedor: '*', valor: 36, fuente: 'Tope por omision del LTV: 36 meses de vida cuando aun no hay churn medido', origen: 'por_omision' },
];

export interface Supuestos {
  /** USD por minuto de voz por proveedor de `restaurantes.voice_conversation`; `*` = cualquiera. */
  readonly vozUsdMinuto: Readonly<Record<string, ValorSupuesto>>;
  readonly telefoniaUsdMinuto: Readonly<Record<string, ValorSupuesto>>;
  readonly llmUsdConversacionWa: ValorSupuesto | null;
  readonly whatsappUsdConversacion: ValorSupuesto | null;
  readonly umbralMargenPct: ValorSupuesto;
  readonly umbralPoolPct: ValorSupuesto;
  readonly umbralPicoCostoPct: ValorSupuesto;
  readonly umbralFxPct: ValorSupuesto;
  readonly ltvMesesTope: ValorSupuesto;
}

/** Combina la referencia con lo capturado: lo capturado gana, clave por clave y proveedor por proveedor. */
export function resolverSupuestos(capturados: readonly SupuestoCapturado[]): Supuestos {
  const mapa = new Map<string, ValorSupuesto>();
  for (const r of SUPUESTOS_REFERENCIA) mapa.set(`${r.clave}|${r.proveedor}`, { valor: r.valor, fuente: r.fuente, origen: r.origen });
  for (const c of capturados) {
    if (!Number.isFinite(c.valor) || c.valor < 0) continue;
    mapa.set(`${c.clave}|${c.proveedor}`, { valor: c.valor, fuente: c.fuente, origen: 'capturado' });
  }
  const porProveedor = (clave: ClaveSupuesto): Record<string, ValorSupuesto> => {
    const out: Record<string, ValorSupuesto> = {};
    for (const [k, v] of mapa) {
      const [c, p] = k.split('|') as [string, string];
      if (c === clave) out[p] = v;
    }
    return out;
  };
  const uno = (clave: ClaveSupuesto): ValorSupuesto | null => mapa.get(`${clave}|*`) ?? null;
  const obligatorio = (clave: ClaveSupuesto): ValorSupuesto => {
    const v = uno(clave);
    if (v === null) throw new Error(`supuesto sin referencia: ${clave}`);
    return v;
  };
  return {
    vozUsdMinuto: porProveedor('voz_usd_minuto'),
    telefoniaUsdMinuto: porProveedor('telefonia_usd_minuto'),
    llmUsdConversacionWa: uno('llm_usd_conversacion_wa'),
    whatsappUsdConversacion: uno('whatsapp_usd_conversacion'),
    umbralMargenPct: obligatorio('umbral_margen_pct'),
    umbralPoolPct: obligatorio('umbral_pool_pct'),
    umbralPicoCostoPct: obligatorio('umbral_pico_costo_pct'),
    umbralFxPct: obligatorio('umbral_fx_pct'),
    ltvMesesTope: obligatorio('ltv_meses_tope'),
  };
}

/** Costo unitario de un proveedor: el suyo o el comodin `*`; `null` = sin dato. */
export function unitarioDe(tabla: Readonly<Record<string, ValorSupuesto>>, proveedor: string): ValorSupuesto | null {
  return tabla[proveedor] ?? tabla['*'] ?? null;
}
