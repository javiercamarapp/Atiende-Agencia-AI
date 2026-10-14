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

/** Proveedores de componente validos: `deepgram` (STT), `deepgram-aura-2` (TTS), `heygen` (TTS) u `openrouter:<modelo>` (LLM). El largo total (1-80) es el CHECK de
 * `core.usage_cost_event.proveedor`: la base rechazaria uno mas largo con 23514 y se perderia el costo de la llamada. */
export const PROVEEDOR_COMPONENTE_RE = /^(?=.{1,80}$)(?:deepgram|deepgram-aura-2|heygen|openrouter:[a-z0-9][a-z0-9._/-]{0,60}(?::[a-z0-9._-]{1,16})?)$/;

export type UnidadComponente = "segundo" | "unidad";

/** Unidad en la que se mide cada proveedor: Deepgram STT en segundos de audio; TTS en caracteres y LLM en llamadas, ambos `unidad`. */
export function unidadDeComponente(proveedor: string): UnidadComponente {
  return proveedor === "deepgram" ? "segundo" : "unidad";
}

/** Solo OpenRouter reporta el costo de cada respuesta (`usage.cost`); Deepgram y HeyGen se estiman con tarifa: su `costoReal` siempre es false. */
export function componenteReportaCosto(proveedor: string): boolean {
  return proveedor.startsWith("openrouter:");
}

/** El componente es coherente: proveedor valido, unidad que le corresponde y `costoReal` solo donde el proveedor reporta el costo. Devuelve el motivo o null. */
export function motivoComponenteInvalido(c: { readonly proveedor: unknown; readonly unidad: unknown; readonly costoReal: unknown }): string | null {
  if (typeof c.proveedor !== "string" || !PROVEEDOR_COMPONENTE_RE.test(c.proveedor)) return "proveedor";
  if (c.unidad !== unidadDeComponente(c.proveedor)) return "unidad";
  if (typeof c.costoReal !== "boolean" || (c.costoReal && !componenteReportaCosto(c.proveedor))) return "costoReal";
  return null;
}

/** El desglose por componente solo existe en la cascada: Gemini Live cobra por tokens de audio/texto y reporta su costo por turno, sin componentes. */
export function escalonAdmiteComponentes(escalon: EscalonVoz): boolean {
  return escalon !== "gemini-3.8-live";
}

/** `ref_id` del evento de un componente: `<llamada>:<escalon>:<proveedor>`. Si pasara de 200 (el CHECK de la base) el proveedor se acorta con un sufijo
 * de hash estable, asi dos componentes distintos nunca chocan por el recorte. */
export function refIdComponente(llamadaId: string, escalon: string, proveedor: string): string {
  const completo = `${llamadaId}:${escalon}:${proveedor}`;
  if (completo.length <= 200) return completo;
  let h = 0x811c9dc5;
  for (let i = 0; i < proveedor.length; i++) h = Math.imul(h ^ proveedor.charCodeAt(i), 0x01000193) >>> 0;
  const prefijo = `${llamadaId}:${escalon}:`;
  return `${prefijo}${proveedor.slice(0, Math.max(0, 200 - prefijo.length - 9))}~${h.toString(16).padStart(8, "0")}`;
}

/** Costo de UN componente dentro de un tramo (lo reporta la sesion con `costo(microUsd, real, componente)`). */
export interface ComponenteCosto {
  readonly proveedor: string;
  readonly unidad: UnidadComponente;
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

/** Un evento por escalon (si Gemini cayo y la cascada siguio, salen dos); con componentes, uno por componente. Los tramos sin duracion ni costo no generan evento.
 * Con componentes, el evento del escalon lleva el REMANENTE: el costo del escalon (el costo reportado o, si es mayor y no es real, el piso por minuto) menos lo
 * ya desglosado. Asi un desglose parcial o vacio no borra el piso por minuto, y la suma de los eventos nunca queda por debajo del costo sin desglose. */
export function eventosCostoLlamada(entrada: EntradaEventosCosto): EventoCostoUso[] {
  if (!VERTICAL_RE.test(entrada.vertical)) throw new Error(`eventosCostoLlamada: vertical invalida (${entrada.vertical}).`);
  interface AcumComponente { unidad: ComponenteCosto["unidad"]; cantidad: number; costo: number; estimado: boolean }
  interface Acum { duracionS: number; reportado: number; real: boolean; componentes: Map<string, AcumComponente> }
  const porEscalon = new Map<EscalonVoz, Acum>();
  for (const t of entrada.tramos) {
    const previo = porEscalon.get(t.escalon) ?? { duracionS: 0, reportado: 0, real: false, componentes: new Map<string, AcumComponente>() };
    if ((t.componentes?.length ?? 0) > 0 && !escalonAdmiteComponentes(t.escalon)) throw new Error(`eventosCostoLlamada: ${t.escalon} no admite componentes.`);
    for (const c of t.componentes ?? []) {
      const motivo = motivoComponenteInvalido(c);
      if (motivo) throw new Error(`eventosCostoLlamada: componente invalido (${motivo}).`);
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
      eventos.push({ ...base, proveedor, unidad: c.unidad, cantidad: Math.round(c.cantidad * 1000) / 1000, costoMicroUsd, costoEstimado: c.estimado, refId: refIdComponente(entrada.llamadaId, escalon, proveedor) });
    }
    const estimado = costoEstimadoMicroUsd(escalon, acum.duracionS, entrada.config);
    // Costo REAL (tokens del proveedor) manda sobre la tarifa por minuto: la facturacion compuesta de Gemini Live puede quedar por encima O por debajo.
    const delEscalon = acum.real ? Math.ceil(acum.reportado) : Math.max(estimado, Math.ceil(acum.reportado));
    const costoMicroUsd = Math.max(0, delEscalon - desglosado);
    if (acum.componentes.size > 0 ? costoMicroUsd <= 0 : acum.duracionS <= 0 && costoMicroUsd <= 0) continue;
    eventos.push({
      ...base,
      proveedor: escalon,
      unidad: "segundo",
      cantidad: Math.round(acum.duracionS * 1000) / 1000,
      costoMicroUsd,
      // Con componentes la bandera del remanente depende SOLO de lo reportado sin componente (la escalera no marca `costoReal` por un aporte con componente).
      costoEstimado: !acum.real,
      refId: `${entrada.llamadaId}:${escalon}`.slice(0, 200),
    });
  }
  return eventos;
}

export function costoTotalMicroUsd(eventos: readonly EventoCostoUso[]): number {
  return eventos.reduce((s, e) => s + e.costoMicroUsd, 0);
}
