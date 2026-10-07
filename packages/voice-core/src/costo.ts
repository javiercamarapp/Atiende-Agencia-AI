// Contrato de costo por llamada hacia `core.usage_cost_event` (SA-02, migracion 0028), el MISMO para todas las verticales.
// Capa pura: arma los argumentos de `core.record_usage_cost_event` (funcion de solo sistema, `auth.uid() is null`); quien escribe en la base es el
// repositorio de cada vertical. Un evento por escalon que atendio la llamada, asi el desglose por proveedor queda en la tabla
// (`proveedor` = 'gemini-3.8-live' | 'cascada-openrouter'). `ref_id` = `<llamada>:<escalon>` hace idempotente el reintento (unique ref_tipo+ref_id).
// SUPUESTO DOCUMENTADO: esa unicidad es GLOBAL (sin organizacion), asi que `llamadaId` debe ser unico entre llamadas y organizaciones. El worker usa
// el nombre de sala de LiveKit; con la regla de despacho 'individual' (apps/voice-worker/README.md) LiveKit le anade un sufijo aleatorio por llamada. Si
// una instalacion REUTILIZARA nombres de sala, el costo de la segunda llamada se contaria como 'repetido' y no se registraria. Quien llame a este
// contrato debe garantizar un `llamadaId` irrepetible.
import { costoEstimadoMicroUsd } from "./config-plataforma.ts";
import type { ConfigPlataformaVoz, EscalonVoz } from "./config-plataforma.ts";

/** Tramo de una llamada atendido por UN escalon de la escalera. */
export interface TramoLlamada {
  readonly escalon: EscalonVoz;
  readonly duracionS: number;
  /** Costo que el propio escalon reporto durante el tramo (tokens, turnos). Si `costoReal` es false solo puede SUBIR la estimacion por minuto, nunca bajarla. */
  readonly costoReportadoMicroUsd: number;
  /** El costo reportado sale de los tokens que el PROVEEDOR informo (`usageMetadata` de Gemini Live), no de una tarifa por minuto: entonces ES el costo del
   * tramo (no se le aplica el piso estimado) y el evento se registra con `costo_estimado = false`. Ausente = estimado. */
  readonly costoReal?: boolean;
}

/** Argumentos de `core.record_usage_cost_event(p_organization_id, p_property_id, p_occurred_at, p_categoria, p_proveedor, p_unidad, p_cantidad,
 * p_costo_micro_usd, p_costo_estimado, p_ref_tipo, p_ref_id)`. */
export interface EventoCostoUso {
  readonly organizationId: string;
  readonly propertyId: string | null;
  readonly ocurridoEn: string;
  readonly categoria: "voz";
  readonly proveedor: EscalonVoz;
  readonly unidad: "segundo";
  readonly cantidad: number;
  readonly costoMicroUsd: number;
  /** false solo cuando el costo sale de los tokens que reporto el proveedor; conciliar contra su factura. */
  readonly costoEstimado: boolean;
  readonly refTipo: string;
  readonly refId: string;
}

export interface EntradaEventosCosto {
  /** Vertical dueña de la llamada: 'hoteles', 'restaurantes', 'citas', 'licitaciones'. */
  readonly vertical: string;
  readonly llamadaId: string;
  readonly organizationId: string;
  readonly propertyId: string | null;
  readonly ocurridoEn: string;
  readonly tramos: readonly TramoLlamada[];
  readonly config?: ConfigPlataformaVoz;
}

const VERTICAL_RE = /^[a-z][a-z0-9_]{0,30}$/;

/** Un evento por escalon (si Gemini cayo y la cascada siguio, salen dos). Los tramos sin duracion ni costo no generan evento. */
export function eventosCostoLlamada(entrada: EntradaEventosCosto): EventoCostoUso[] {
  if (!VERTICAL_RE.test(entrada.vertical)) throw new Error(`eventosCostoLlamada: vertical invalida (${entrada.vertical}).`);
  const porEscalon = new Map<EscalonVoz, { duracionS: number; reportado: number; real: boolean }>();
  for (const t of entrada.tramos) {
    const previo = porEscalon.get(t.escalon) ?? { duracionS: 0, reportado: 0, real: false };
    porEscalon.set(t.escalon, { duracionS: previo.duracionS + Math.max(0, t.duracionS), reportado: previo.reportado + Math.max(0, t.costoReportadoMicroUsd), real: previo.real || (t.costoReal === true && t.costoReportadoMicroUsd > 0) });
  }
  const eventos: EventoCostoUso[] = [];
  for (const [escalon, acum] of porEscalon) {
    const estimado = costoEstimadoMicroUsd(escalon, acum.duracionS, entrada.config);
    // Costo REAL (tokens del proveedor) manda sobre la tarifa por minuto: la facturacion compuesta de Gemini Live puede quedar por encima O por debajo.
    const costoMicroUsd = acum.real ? Math.ceil(acum.reportado) : Math.max(estimado, Math.ceil(acum.reportado));
    if (acum.duracionS <= 0 && costoMicroUsd <= 0) continue;
    eventos.push({
      organizationId: entrada.organizationId,
      propertyId: entrada.propertyId,
      ocurridoEn: entrada.ocurridoEn,
      categoria: "voz",
      proveedor: escalon,
      unidad: "segundo",
      cantidad: Math.round(acum.duracionS * 1000) / 1000,
      costoMicroUsd,
      costoEstimado: !acum.real,
      refTipo: `voz_${entrada.vertical}`,
      refId: `${entrada.llamadaId}:${escalon}`.slice(0, 200),
    });
  }
  return eventos;
}

export function costoTotalMicroUsd(eventos: readonly EventoCostoUso[]): number {
  return eventos.reduce((s, e) => s + e.costoMicroUsd, 0);
}
