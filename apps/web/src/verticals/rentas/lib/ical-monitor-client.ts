// Rn-01/Rn-02 -- cliente del monitor de sincronización iCal y de conflictos de calendario
// (apps/api/src/routes/verticals/rentas/ical-monitor.ts). Mismo patrón que
// ical-sync-client.ts: separado de pages/MonitorSync.tsx para probarlo en entorno "node".
//   - fetchMonitorSync       -> GET  /rentas/:propertyId/sync-monitor
//   - fetchConflictos        -> GET  /rentas/:propertyId/conflictos?estado=
//   - resolverConflicto      -> POST /rentas/:propertyId/conflictos/:id/resolver
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

export interface MonitorSync {
  readonly ahora: string;
  readonly feeds: readonly FeedMonitor[];
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

export interface ConflictoCalendario {
  readonly id: string;
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
  const body = await fetchJson<{ ahora: string; feeds: readonly FeedWire[]; alertas: { disponible: boolean; abiertas: readonly AlertaWire[] }; conflictos_abiertos: number }>(
    fetchImpl,
    `${apiBaseUrl}/rentas/${propertyId}/sync-monitor`,
    token,
  );
  return {
    ahora: body.ahora,
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
  estado: "abiertos" | "todos" = "abiertos",
): Promise<{ readonly conflictos: readonly ConflictoCalendario[]; readonly totalAbiertos: number }> {
  const body = await fetchJson<{ conflictos: readonly ConflictoWire[]; total_abiertos: number }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/conflictos?estado=${estado}`, token);
  return { conflictos: body.conflictos.map(mapConflicto), totalAbiertos: body.total_abiertos };
}

export async function resolverConflicto(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, conflictoId: string): Promise<void> {
  await sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/conflictos/${conflictoId}/resolver`, token, "POST", {});
}

export async function atenderAlertaSync(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, alertaId: string): Promise<void> {
  await sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/sync-alertas/${alertaId}/atender`, token, "POST", {});
}
