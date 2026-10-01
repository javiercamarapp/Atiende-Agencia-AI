// Rn-01/Rn-02 -- cliente del monitor de sincronización iCal y de conflictos de calendario
// (apps/api/src/routes/verticals/rentas/ical-monitor.ts). Mismo patrón que
// ical-sync-client.ts: separado de pages/MonitorSync.tsx para probarlo en entorno "node".
//   - fetchMonitorSync       -> GET  /rentas/:propertyId/sync-monitor
//   - fetchConflictos        -> GET  /rentas/:propertyId/conflictos?estado=abiertos|resueltos|ignorados|todos
//   - decidirConflicto       -> POST /rentas/:propertyId/conflictos/:id/resolver  { accion: resuelto|ignorado, motivo? }
//   - fetchHistorialConflicto-> GET  /rentas/:propertyId/conflictos/:id/historial
//   - atenderAlertaSync      -> POST /rentas/:propertyId/sync-alertas/:id/atender
import { fetchJson, sendJson } from "./admin-client.ts";

export type EstadoSaludFeed = "ok" | "desactualizado" | "en_backoff" | "en_cuarentena" | "sin_sincronizar" | "inactivo";

export const ETIQUETA_SALUD_FEED: Record<EstadoSaludFeed, string> = {
  ok: "Al día",
  desactualizado: "Desactualizado",
  en_backoff: "En espera (reintento)",
  en_cuarentena: "En cuarentena",
  sin_sincronizar: "Sin sincronizar",
  inactivo: "Desconectado",
};

export interface FeedMonitor {
  readonly id: string;
  readonly unidadId: string;
  readonly unidadNombre: string | null;
  readonly canal: string;
  readonly activo: boolean;
  readonly salud: EstadoSaludFeed;
  readonly ultimaSincronizacionExitosaEn: string | null;
  readonly enCuarentenaDesde: string | null;
  readonly motivoCuarentena: string | null;
  readonly intentosFallidosConsecutivos: number;
  readonly ultimoIntentoEn: string | null;
  readonly proximoIntentoEn: string | null;
}

export type SeveridadAlerta = "info" | "aviso" | "critica";

export interface AlertaSync {
  readonly id: string;
  readonly unidadId: string;
  readonly unidadNombre: string | null;
  readonly canal: string;
  readonly tipo: string;
  readonly severidad: SeveridadAlerta;
  readonly detalle: string;
  readonly eventosAplicados: number;
  readonly conflictos: number;
  readonly creadoEn: string;
}

export interface ResumenCanal {
  readonly canal: string;
  readonly totalFeeds: number;
  readonly peor: EstadoSaludFeed;
  readonly unidadesConProblema: number;
  readonly porSalud: Readonly<Record<EstadoSaludFeed, number>>;
  readonly sincronizacionMasAntiguaEn: string | null;
}

export interface MonitorSync {
  readonly ahora: string;
  /** Zona IANA de la property: las fechas "locales" del monitor se muestran en ella. */
  readonly zonaHoraria: string;
  readonly feeds: readonly FeedMonitor[];
  readonly resumenPorCanal: readonly ResumenCanal[];
  /** `false` = la base todavía no tiene la bitácora de sync (migración pendiente). */
  readonly alertasDisponibles: boolean;
  readonly alertas: readonly AlertaSync[];
  readonly conflictosAbiertos: number;
}

export interface OcupacionConflicto {
  readonly id: string;
  readonly inicio: string;
  readonly fin: string;
  readonly estado: string;
  readonly capa: string;
  readonly canal: string | null;
}

export type EstadoConflicto = "abierto" | "resuelto" | "ignorado";
export type FiltroEstadoConflictos = "abiertos" | "resueltos" | "ignorados" | "todos";
export type VigenciaSolape = "pasado" | "en_curso" | "futuro";

export const ETIQUETA_ESTADO_CONFLICTO: Record<EstadoConflicto, string> = { abierto: "Abierto", resuelto: "Resuelto", ignorado: "Ignorado" };
export const ETIQUETA_VIGENCIA_SOLAPE: Record<VigenciaSolape, string> = { pasado: "ya pasaron", en_curso: "en curso", futuro: "por venir" };

export interface SolapeConflicto {
  readonly inicio: string;
  readonly fin: string;
  readonly vigencia: VigenciaSolape;
}

export interface ConflictoCalendario {
  readonly id: string;
  readonly estado: EstadoConflicto;
  readonly motivoResolucion: string | null;
  /** Hora de pared de la property (`YYYY-MM-DD HH:mm`), ya calculada por el servidor. */
  readonly detectadoEnLocal: string | null;
  readonly resueltoEnLocal: string | null;
  readonly resueltoPorMi: boolean;
  readonly solape: SolapeConflicto | null;
  readonly unidadId: string;
  readonly unidadNombre: string | null;
  readonly tipo: "capa_cruzada" | "overbooking_confirmado";
  readonly detectadoEn: string;
  readonly resueltoEn: string | null;
  readonly ocupacionA: OcupacionConflicto;
  readonly ocupacionB: OcupacionConflicto | null;
}

export const ETIQUETA_TIPO_CONFLICTO: Record<ConflictoCalendario["tipo"], string> = {
  overbooking_confirmado: "Overbooking entre reservas",
  capa_cruzada: "Reserva sobre un bloqueo",
};

interface FeedWire {
  readonly id: string;
  readonly unidad_id: string;
  readonly unidad_nombre: string | null;
  readonly canal: string;
  readonly activo: boolean;
  readonly salud: EstadoSaludFeed;
  readonly ultima_sincronizacion_exitosa_en: string | null;
  readonly en_cuarentena_desde: string | null;
  readonly motivo_cuarentena: string | null;
  readonly intentos_fallidos_consecutivos: number;
  readonly ultimo_intento_en: string | null;
  readonly proximo_intento_en: string | null;
}

interface ResumenCanalWire {
  readonly canal: string;
  readonly total_feeds: number;
  readonly peor: EstadoSaludFeed;
  readonly unidades_con_problema: number;
  readonly por_salud: Readonly<Record<EstadoSaludFeed, number>>;
  readonly sincronizacion_mas_antigua_en: string | null;
}

interface AlertaWire {
  readonly id: string;
  readonly unidad_id: string;
  readonly unidad_nombre: string | null;
  readonly canal: string;
  readonly tipo: string;
  readonly severidad: SeveridadAlerta;
  readonly detalle: string;
  readonly eventos_aplicados: number;
  readonly conflictos: number;
  readonly creado_en: string;
}

interface OcupacionWire {
  readonly id: string;
  readonly inicio: string;
  readonly fin: string;
  readonly estado: string;
  readonly capa: string;
  readonly canal: string | null;
}

interface ConflictoWire {
  readonly id: string;
  readonly estado: EstadoConflicto;
  readonly motivo_resolucion: string | null;
  readonly detectado_en_local: string | null;
  readonly resuelto_en_local: string | null;
  readonly resuelto_por_mi: boolean;
  readonly solape: SolapeConflicto | null;
  readonly unidad_id: string;
  readonly unidad_nombre: string | null;
  readonly tipo: ConflictoCalendario["tipo"];
  readonly detectado_en: string;
  readonly resuelto_en: string | null;
  readonly ocupacion_a: OcupacionWire;
  readonly ocupacion_b: OcupacionWire | null;
}

function mapConflicto(w: ConflictoWire): ConflictoCalendario {
  return {
    id: w.id,
    estado: w.estado,
    motivoResolucion: w.motivo_resolucion,
    detectadoEnLocal: w.detectado_en_local,
    resueltoEnLocal: w.resuelto_en_local,
    resueltoPorMi: w.resuelto_por_mi,
    solape: w.solape,
    unidadId: w.unidad_id,
    unidadNombre: w.unidad_nombre,
    tipo: w.tipo,
    detectadoEn: w.detectado_en,
    resueltoEn: w.resuelto_en,
    ocupacionA: w.ocupacion_a,
    ocupacionB: w.ocupacion_b,
  };
}

export async function fetchMonitorSync(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<MonitorSync> {
  const body = await fetchJson<{
    ahora: string;
    zona_horaria: string;
    feeds: readonly FeedWire[];
    resumen_por_canal: readonly ResumenCanalWire[];
    alertas: { disponible: boolean; abiertas: readonly AlertaWire[] };
    conflictos_abiertos: number;
  }>(
    fetchImpl,
    `${apiBaseUrl}/rentas/${propertyId}/sync-monitor`,
    token,
  );
  return {
    ahora: body.ahora,
    zonaHoraria: body.zona_horaria,
    resumenPorCanal: body.resumen_por_canal.map((r) => ({
      canal: r.canal,
      totalFeeds: r.total_feeds,
      peor: r.peor,
      unidadesConProblema: r.unidades_con_problema,
      porSalud: r.por_salud,
      sincronizacionMasAntiguaEn: r.sincronizacion_mas_antigua_en,
    })),
    feeds: body.feeds.map((f) => ({
      id: f.id,
      unidadId: f.unidad_id,
      unidadNombre: f.unidad_nombre,
      canal: f.canal,
      activo: f.activo,
      salud: f.salud,
      ultimaSincronizacionExitosaEn: f.ultima_sincronizacion_exitosa_en,
      enCuarentenaDesde: f.en_cuarentena_desde,
      motivoCuarentena: f.motivo_cuarentena,
      intentosFallidosConsecutivos: f.intentos_fallidos_consecutivos,
      ultimoIntentoEn: f.ultimo_intento_en,
      proximoIntentoEn: f.proximo_intento_en,
    })),
    alertasDisponibles: body.alertas.disponible,
    alertas: body.alertas.abiertas.map((a) => ({
      id: a.id,
      unidadId: a.unidad_id,
      unidadNombre: a.unidad_nombre,
      canal: a.canal,
      tipo: a.tipo,
      severidad: a.severidad,
      detalle: a.detalle,
      eventosAplicados: a.eventos_aplicados,
      conflictos: a.conflictos,
      creadoEn: a.creado_en,
    })),
    conflictosAbiertos: body.conflictos_abiertos,
  };
}

export async function fetchConflictos(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  estado: FiltroEstadoConflictos = "abiertos",
): Promise<{ readonly conflictos: readonly ConflictoCalendario[]; readonly totalAbiertos: number; readonly zonaHoraria: string }> {
  const body = await fetchJson<{ zona_horaria: string; conflictos: readonly ConflictoWire[]; total_abiertos: number }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/conflictos?estado=${estado}`, token);
  return { conflictos: body.conflictos.map(mapConflicto), totalAbiertos: body.total_abiertos, zonaHoraria: body.zona_horaria };
}

export interface DecisionConflicto {
  readonly accion: "resuelto" | "ignorado";
  /** Obligatorio al ignorar (3 a 500 caracteres); nota opcional al resolver. */
  readonly motivo?: string;
}

/** Espejo web de `normalizarDecisionConflicto` (domain-rentas): valida ANTES de llamar para no gastar
 * un viaje; el servidor y la base re-validan siempre. */
export function validarMotivoDecision(decision: DecisionConflicto): string | null {
  const motivo = (decision.motivo ?? "").trim();
  if (motivo.length > 500) return "El motivo admite máximo 500 caracteres.";
  if (decision.accion === "ignorado" && motivo.length < 3) return "Para ignorar un conflicto escribe el motivo (mínimo 3 caracteres).";
  return null;
}

export async function decidirConflicto(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, conflictoId: string, decision: DecisionConflicto): Promise<void> {
  const error = validarMotivoDecision(decision);
  if (error) throw new Error(error);
  const motivo = (decision.motivo ?? "").trim();
  await sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/conflictos/${conflictoId}/resolver`, token, "POST", motivo === "" ? { accion: decision.accion } : { accion: decision.accion, motivo });
}

export async function resolverConflicto(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, conflictoId: string): Promise<void> {
  await decidirConflicto(fetchImpl, apiBaseUrl, token, propertyId, conflictoId, { accion: "resuelto" });
}

export interface EntradaHistorial {
  readonly id: string;
  readonly accion: "resuelto" | "ignorado";
  readonly motivo: string | null;
  readonly creadoEnLocal: string | null;
  readonly porMi: boolean;
}

export interface HistorialConflicto {
  /** `false` = la base todavía no tiene la bitácora de conflictos (migración pendiente). */
  readonly disponible: boolean;
  readonly zonaHoraria: string;
  readonly entradas: readonly EntradaHistorial[];
}

export async function fetchHistorialConflicto(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, conflictoId: string): Promise<HistorialConflicto> {
  const body = await fetchJson<{ disponible: boolean; zona_horaria: string; entradas: readonly { id: string; accion: "resuelto" | "ignorado"; motivo: string | null; creado_en_local: string | null; por_mi: boolean }[] }>(
    fetchImpl,
    `${apiBaseUrl}/rentas/${propertyId}/conflictos/${conflictoId}/historial`,
    token,
  );
  return {
    disponible: body.disponible,
    zonaHoraria: body.zona_horaria,
    entradas: body.entradas.map((e) => ({ id: e.id, accion: e.accion, motivo: e.motivo, creadoEnLocal: e.creado_en_local, porMi: e.por_mi })),
  };
}

export async function atenderAlertaSync(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, alertaId: string): Promise<void> {
  await sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/sync-alertas/${alertaId}/atender`, token, "POST", {});
}
