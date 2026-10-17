// Tablas `estado -> tono` de rentas para <StatusBadge> de @atiende/ui (PR-7 del plan de diseno-ux): reemplazan las variantes
// `default | secondary | destructive | outline` de <Badge> de cada pagina. Un estado que la tabla aun no conoce cae a
// "neutral" (via `statusTone`) en vez de pintarse mal. La carga semantica es la de antes: verde = bien/hecho, ambar =
// atencion, rojo = urgente, azul = informativo, gris = apagado/sin accion.
import type { StatusTone } from "@atiende/ui";
import type { CapaOcupacion, EstadoOcupacion } from "./calendario-client.ts";
import type { ConflictoCalendario, EstadoSaludFeed, SeveridadAlerta } from "./ical-monitor-client.ts";
import type { EstadoCeldaMatriz } from "./conectividad-client.ts";

type Tabla = Readonly<Record<string, StatusTone>>;

/** Salud de un feed iCal en el monitor de sincronizacion. */
export const SALUD_FEED_TONES: Readonly<Record<EstadoSaludFeed, StatusTone>> = {
  ok: "success",
  desactualizado: "warning",
  en_backoff: "warning",
  en_cuarentena: "danger",
  sin_sincronizar: "neutral",
  inactivo: "neutral",
};

/** Estado de una celda de la matriz de conectividad (unidad x canal). */
export const CELDA_CONECTIVIDAD_TONES: Readonly<Record<EstadoCeldaMatriz, StatusTone>> = {
  conectado: "success",
  solo_import: "info",
  solo_export: "info",
  sin_conectar: "neutral",
  pendiente: "warning",
  fallando: "danger",
  en_cuarentena: "danger",
};

/** Severidad de una alerta del sync. */
export const SEVERIDAD_ALERTA_TONES: Readonly<Record<SeveridadAlerta, StatusTone>> = { info: "info", aviso: "warning", critica: "danger" };

/** Estado de un conflicto de calendario. */
export const ESTADO_CONFLICTO_TONES: Readonly<Record<ConflictoCalendario["estado"], StatusTone>> = { abierto: "danger", resuelto: "success", ignorado: "neutral" };

/** Tipo de un conflicto de calendario: el overbooking confirmado es lo urgente; la capa cruzada, atencion. */
export const TIPO_CONFLICTO_TONES: Readonly<Record<ConflictoCalendario["tipo"], StatusTone>> = { capa_cruzada: "warning", overbooking_confirmado: "danger" };

/** Estado de un borrador de mensajeria ya decidido (la bandeja de aprobacion). */
export const BORRADOR_HISTORIAL_TONES: Tabla = { enviado: "success", rechazado: "danger", aprobado: "info" };

/** Senal de escalamiento de un borrador (Rn-P3-21): la emergencia es lo urgente; queja y reembolso, atencion; VIP, informativo. */
export const SENAL_ESCALAMIENTO_TONES: Tabla = { emergencia: "danger", queja: "warning", reembolso: "warning", vip: "info" };

/** Estado de conciliacion de una linea de payout. */
export const CONCILIACION_TONES: Tabla = { conciliado: "success", discrepancia: "danger", pendiente: "warning" };

/** Estado de una tarea operativa de limpieza. */
export const ESTADO_TAREA_TONES: Tabla = { pendiente: "neutral", asignada: "info", en_progreso: "info", completada: "success", bloqueada: "danger", cancelada: "neutral" };

/** Estado del feed iCal de un canal (pagina de sincronizacion). */
export function feedCanalTone(feed: { readonly enCuarentenaDesde: string | null; readonly activo: boolean }): StatusTone {
  return feed.enCuarentenaDesde ? "danger" : feed.activo ? "success" : "neutral";
}

/** Tono de una ocupacion del calendario: lo cancelado y los bloqueos son neutros; el conflicto pendiente es rojo. */
export function ocupacionTone(o: { readonly estado: EstadoOcupacion; readonly capa: CapaOcupacion }): StatusTone {
  if (o.estado === "cancelado") return "neutral";
  if (o.estado === "conflicto_pendiente") return "danger";
  if (o.estado === "provisional") return "warning";
  return o.capa === "reserva" ? "success" : "neutral";
}
