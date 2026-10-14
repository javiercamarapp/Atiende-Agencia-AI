// Contrato de costo por llamada hacia `core.usage_cost_event` (SA-02, migracion 0028), el MISMO para todas las verticales.
// Capa pura: arma los argumentos de `core.record_usage_cost_event` (funcion de solo sistema, `auth.uid() is null`); quien escribe en la base es el
// repositorio de cada vertical. Un evento por escalon que atendio la llamada, asi el desglose por proveedor queda en la tabla
// (`proveedor` = 'gemini-3.8-live' | 'cascada-openrouter'). `ref_id` = `<llamada>:<escalon>` hace idempotente el reintento (unique ref_tipo+ref_id).
// COMPONENTES (P4): un tramo puede traer el desglose por componente (`deepgram`, `heygen`, `openrouter:<modelo>`). Entonces el evento sale POR COMPONENTE
// (`proveedor` = el componente, `ref_id` = `<llamada>:<escalon>:<componente>`, igual de idempotente) EN LUGAR del evento del escalon; lo no desglosado del
// tramo sigue saliendo como el evento del escalon de siempre (mismo `ref_id`), asi la suma de los eventos es siempre el costo reportado. Sin componentes
// nada cambia: mismos eventos y mismos `ref_id` que antes. `proveedor` es texto libre (1-80) en la base: no hace falta migracion.
// SUPUESTO DOCUMENTADO: esa unicidad es GLOBAL (sin organizacion), asi que `llamadaId` debe ser unico entre llamadas y organizaciones. El worker usa
// el nombre de sala de LiveKit; con la regla de despacho 'individual' (apps/voice-worker/README.md) LiveKit le anade un sufijo aleatorio por llamada. Si
// una instalacion REUTILIZARA nombres de sala, el costo de la segunda llamada se contaria como 'repetido' y no se registraria. Quien llame a este
// contrato debe garantizar un `llamadaId` irrepetible.
import { costoEstimadoMicroUsd } from "./config-plataforma.ts";
import type { ConfigPlataformaVoz, EscalonVoz } from "./config-plataforma.ts";

/** Proveedores de componente validos: `deepgram`, `deepgram-aura-2`, `heygen` u `openrouter:<modelo>` (el `ref_id` y el CHECK de 80 caracteres de la base lo acotan). */
export const PROVEEDOR_COMPONENTE_RE = /^(?:deepgram|deepgram-aura-2|heygen|openrouter:[a-z0-9][a-z0-9._/-]{0,60}(?::[a-z0-9._-]{1,16})?)$/;

/** Costo de UN componente dentro de un tramo (lo reporta la sesion con `costo(microUsd, real, componente)`). */
export interface ComponenteCosto {
  readonly proveedor: string;
  /** `segundo` (audio de Deepgram) o `unidad` (caracteres de HeyGen, llamadas al LLM). */
  readonly unidad: "segundo" | "unidad";
  readonly cantidad: number;
  readonly costoMicroUsd: number;
  /** El proveedor reporto el costo (`usage.cost` de OpenRouter): el evento sale con `costo_estimado = false`. */
  readonly costoReal: boolean;
}

/** Tramo de una llamada atendido por UN escalon de la escalera. */
export interface TramoLlamada {
  readonly escalon: EscalonVoz;
  readonly duracionS: number;
  /** Costo que el propio escalon reporto durante el tramo (tokens, turnos). Si `costoReal` es false solo puede SUBIR la estimacion por minuto, nunca bajarla. */
  readonly costoReportadoMicroUsd: number;
  /** El costo reportado sale de los tokens que el PROVEEDOR informo (`usageMetadata` de Gemini Live), no de una tarifa por minuto: entonces ES el costo del
   * tramo (no se le aplica el piso estimado) y el evento se registra con `costo_estimado = false`. Ausente = estimado. */
  readonly costoReal?: boolean;
  /** Desglose por componente (opcional: los escalones de hoy no lo mandan). */
  readonly componentes?: readonly ComponenteCosto[];
}

/** Argumentos de `core.record_usage_cost_event(p_organization_id, p_property_id, p_occurred_at, p_categoria, p_proveedor, p_unidad, p_cantidad,
 * p_costo_micro_usd, p_costo_estimado, p_ref_tipo, p_ref_id)`. */
export interface EventoCostoUso {
  readonly organizationId: string;
  readonly propertyId: string | null;
  readonly ocurridoEn: string;
  readonly categoria: "voz";
  readonly proveedor: string;
  readonly unidad: "segundo" | "unidad";
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

/** Un evento por escalon (si Gemini cayo y la cascada siguio, salen dos); con componentes, uno por componente. Los tramos sin duracion ni costo no generan evento. */
export function eventosCostoLlamada(entrada: EntradaEventosCosto): EventoCostoUso[] {
  if (!VERTICAL_RE.test(entrada.vertical)) throw new Error(`eventosCostoLlamada: vertical invalida (${entrada.vertical}).`);
  interface AcumComponente { unidad: ComponenteCosto["unidad"]; cantidad: number; costo: number; estimado: boolean }
  interface Acum { duracionS: number; reportado: number; real: boolean; componentes: Map<string, AcumComponente> }
  const porEscalon = new Map<EscalonVoz, Acum>();
  for (const t of entrada.tramos) {
    const previo = porEscalon.get(t.escalon) ?? { duracionS: 0, reportado: 0, real: false, componentes: new Map<string, AcumComponente>() };
    for (const c of t.componentes ?? []) {
      if (!PROVEEDOR_COMPONENTE_RE.test(c.proveedor)) throw new Error(`eventosCostoLlamada: proveedor de componente invalido (${c.proveedor}).`);
      const costo = Math.max(0, c.costoMicroUsd);
      const acum = previo.componentes.get(c.proveedor) ?? { unidad: c.unidad, cantidad: 0, costo: 0, estimado: false };
      acum.cantidad += Math.max(0, c.cantidad);
      acum.costo += costo;
      // Un solo aporte estimado con costo vuelve estimado todo el componente: nunca se marca "real" un costo parcialmente supuesto.
      if (!c.costoReal && costo > 0) acum.estimado = true;
      previo.componentes.set(c.proveedor, acum);
    }
    porEscalon.set(t.escalon, { duracionS: previo.duracionS + Math.max(0, t.duracionS), reportado: previo.reportado + Math.max(0, t.costoReportadoMicroUsd), real: previo.real || (t.costoReal === true && t.costoReportadoMicroUsd > 0), componentes: previo.componentes });
  }
  const eventos: EventoCostoUso[] = [];
  const base = { organizationId: entrada.organizationId, propertyId: entrada.propertyId, ocurridoEn: entrada.ocurridoEn, categoria: "voz" as const, refTipo: `voz_${entrada.vertical}` };
  for (const [escalon, acum] of porEscalon) {
    let desglosado = 0;
    for (const [proveedor, c] of acum.componentes) {
      const costoMicroUsd = Math.ceil(c.costo);
      desglosado += costoMicroUsd;
      if (costoMicroUsd <= 0 && c.cantidad <= 0) continue;
      eventos.push({ ...base, proveedor, unidad: c.unidad, cantidad: Math.round(c.cantidad * 1000) / 1000, costoMicroUsd, costoEstimado: c.estimado, refId: `${entrada.llamadaId}:${escalon}:${proveedor}`.slice(0, 200) });
    }
    const estimado = costoEstimadoMicroUsd(escalon, acum.duracionS, entrada.config);
    // Con desglose, el evento del escalon lleva SOLO lo que los componentes no explican (sin piso por minuto: el desglose ya es el costo).
    const reportado = Math.max(0, Math.ceil(acum.reportado) - desglosado);
    // Costo REAL (tokens del proveedor) manda sobre la tarifa por minuto: la facturacion compuesta de Gemini Live puede quedar por encima O por debajo.
    const costoMicroUsd = acum.componentes.size > 0 ? reportado : acum.real ? Math.ceil(acum.reportado) : Math.max(estimado, Math.ceil(acum.reportado));
    if (acum.componentes.size > 0 ? costoMicroUsd <= 0 : acum.duracionS <= 0 && costoMicroUsd <= 0) continue;
    eventos.push({
      ...base,
      proveedor: escalon,
      unidad: "segundo",
      cantidad: Math.round(acum.duracionS * 1000) / 1000,
      costoMicroUsd,
      costoEstimado: !acum.real,
      refId: `${entrada.llamadaId}:${escalon}`.slice(0, 200),
    });
  }
  return eventos;
}

export function costoTotalMicroUsd(eventos: readonly EventoCostoUso[]): number {
  return eventos.reduce((s, e) => s + e.costoMicroUsd, 0);
}
