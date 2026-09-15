// Lógica de datos de la bandeja de aprobación de mensajería (hallazgo de auditoría
// ALTA "Mensajería con aprobación humana obligatoria: la cola de aprobación no tiene
// botón de aprobar"). Consume los endpoints ya montados y probados de
// apps/api/src/routes/verticals/rentas/mensajeria-conversaciones.ts y
// mensajeria-borradores.ts — ninguno es nuevo en esta fase, solo faltaba el cliente
// web. Mismo criterio de aislamiento que calendario-client.ts/pricing-client.ts:
// tipos redeclarados aquí (apps/web no depende de @atiende/domain-rentas), separado
// de pages/Aprobaciones.tsx para poder probarlo con vitest en entorno "node".
//
// `CanalMensajeriaCodigo`/`EstadoBorrador`/etc. son un subconjunto DELIBERADAMENTE
// más chico que packages/domain-rentas/src/mensajeria/tipos.ts: esta bandeja solo
// necesita lo que ya viaja en el JSON de ConversacionRecord/BorradorRecord, nunca las
// funciones puras de la máquina de estados (esas viven y se re-validan SIEMPRE en el
// servidor, ver mensajeria-borradores.ts).
import { fetchJson, sendJson } from "./admin-client.ts";
import { fetchUnidades } from "./calendario-client.ts";
import type { UnidadOption } from "./calendario-client.ts";

export { fetchUnidades };
export type { UnidadOption };

export const CANALES_MENSAJERIA = ["airbnb", "vrbo", "booking"] as const;
export type CanalMensajeriaCodigo = (typeof CANALES_MENSAJERIA)[number];

export const CANAL_LABELS: Record<CanalMensajeriaCodigo, string> = {
  airbnb: "Airbnb",
  vrbo: "Vrbo",
  booking: "Booking",
};

export type EstadoBorrador = "pendiente_aprobacion" | "aprobado" | "rechazado" | "enviado";

export const ESTADO_BORRADOR_LABELS: Record<EstadoBorrador, string> = {
  pendiente_aprobacion: "Pendiente de aprobación",
  aprobado: "Aprobado",
  rechazado: "Rechazado",
  enviado: "Enviado",
};

export type GeneradoPorBorrador = "motor_borrador" | "agente_llm";

export interface ConversacionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canal: CanalMensajeriaCodigo;
  readonly ocupacionId: string | null;
  readonly huespedMinimoId: string | null;
  readonly propiedadNombre: string;
  readonly huespedNombre: string | null;
  readonly fechaCheckIn: string | null;
  readonly fechaCheckOut: string | null;
  readonly reservaConfirmada: boolean;
  readonly creadoEn: string;
}

export interface BorradorRecord {
  readonly id: string;
  readonly conversacionId: string;
  readonly mensajeEntranteId: string | null;
  readonly canal: CanalMensajeriaCodigo;
  readonly texto: string;
  readonly estado: EstadoBorrador;
  readonly generadoPor: GeneradoPorBorrador;
  readonly redactado: boolean;
  readonly aprobadoPor: string | null;
  readonly aprobadoEn: string | null;
  readonly rechazadoPor: string | null;
  readonly rechazadoEn: string | null;
  readonly motivoRechazo: string | null;
  readonly mensajeEnviadoId: string | null;
  readonly creadoEn: string;
  readonly actualizadoEn: string;
}

export async function fetchConversaciones(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
): Promise<readonly ConversacionRecord[]> {
  const body = await fetchJson<{ conversaciones: readonly ConversacionRecord[] }>(
    fetchImpl,
    `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/conversaciones`,
    token,
  );
  return body.conversaciones;
}

export async function fetchBorradores(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  conversacionId: string,
): Promise<readonly BorradorRecord[]> {
  const body = await fetchJson<{ borradores: readonly BorradorRecord[] }>(
    fetchImpl,
    `${apiBaseUrl}/rentas/${propertyId}/conversaciones/${conversacionId}/borradores`,
    token,
  );
  return body.borradores;
}

/** POST .../borradores/:id/aprobar -- ÚNICA ruta que puede terminar en un mensaje
 * saliente real (ver cabecera de mensajeria-borradores.ts). El borrador vuelve con
 * `estado: "enviado"` -- no hay un paso intermedio "aprobado" visible para el staff,
 * la transición pendiente_aprobacion -> aprobado -> enviado ocurre completa en esta
 * sola llamada. */
export async function aprobarBorrador(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, borradorId: string): Promise<BorradorRecord> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/borradores/${borradorId}/aprobar`, token, "POST", {});
}

export async function rechazarBorrador(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, borradorId: string, motivo: string): Promise<BorradorRecord> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/borradores/${borradorId}/rechazar`, token, "POST", { motivo });
}

/** Une, para una property completa, cada conversación con sus borradores todavía
 * `pendiente_aprobacion` — la bandeja real: sin este agregador, un operador tendría
 * que revisar unidad por unidad y conversación por conversación para encontrar algo
 * que aprobar (justo el hallazgo que esta fase cierra). El backend NUNCA expuso un
 * GET "borradores pendientes de toda la property" (`listBorradores` exige
 * `conversacionId`, ver packages/domain-rentas/src/mensajeria/repository.ts) -- se
 * arma aquí en el cliente recorriendo unidades -> conversaciones -> borradores con
 * los 3 GET ya existentes, aceptable para el volumen de una property de rentas
 * (unas pocas unidades, cada una con pocas conversaciones activas). */
export interface ItemBandeja {
  readonly unidad: UnidadOption;
  readonly conversacion: ConversacionRecord;
  readonly pendientes: readonly BorradorRecord[];
  /** El resto de los borradores de la misma conversación (aprobados/enviados/
   * rechazados) -- ya vino en la misma llamada a `fetchBorradores`, se conserva para
   * un historial de contexto sin pedirlo dos veces. */
  readonly historial: readonly BorradorRecord[];
}

export async function fetchBandejaAprobacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly ItemBandeja[]> {
  const unidades = await fetchUnidades(fetchImpl, apiBaseUrl, token, propertyId);
  const items: ItemBandeja[] = [];

  for (const unidad of unidades) {
    const conversaciones = await fetchConversaciones(fetchImpl, apiBaseUrl, token, propertyId, unidad.id);
    for (const conversacion of conversaciones) {
      const borradores = await fetchBorradores(fetchImpl, apiBaseUrl, token, propertyId, conversacion.id);
      const pendientes = borradores.filter((b) => b.estado === "pendiente_aprobacion");
      const historial = borradores.filter((b) => b.estado !== "pendiente_aprobacion");
      if (pendientes.length === 0 && historial.length === 0) continue;
      items.push({ unidad, conversacion, pendientes, historial });
    }
  }

  // Conversaciones con al menos un pendiente primero -- es una bandeja de
  // aprobación, no un log: lo que requiere acción va arriba.
  return items.sort((a, b) => {
    if (a.pendientes.length !== b.pendientes.length) return b.pendientes.length - a.pendientes.length;
    return b.conversacion.creadoEn.localeCompare(a.conversacion.creadoEn);
  });
}
