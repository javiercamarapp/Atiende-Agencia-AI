import type { BandejaFiltro, BandejaPagina, ConversacionDetalle, ConversacionesLectura } from "./types.ts";

/** Puerto de persistencia de la bandeja de conversaciones / handoff (migracion 031), separado de `CitasRepository` a proposito: todo
 * degrada de forma uniforme cuando la base no esta migrada (lecturas -> `disponible: false`; escrituras ->
 * `ConversacionesNoDisponibleError`, que las rutas traducen a 503) y nunca toca el resto del dominio. Corre en la sesion de STAFF. */
export interface ConversacionesRepository {
  listarBandeja(organizationId: string, propertyId: string, filtro: BandejaFiltro): Promise<ConversacionesLectura<BandejaPagina>>;
  detalle(organizationId: string, propertyId: string, conversationId: string): Promise<ConversacionesLectura<ConversacionDetalle | null>>;
  /** Devuelve el id del handoff. Lanza `HandoffYaTomadoError` si otra persona ya la tiene. */
  tomar(organizationId: string, propertyId: string, conversationId: string): Promise<string>;
  /** `false` si la toma ya estaba devuelta/cerrada. */
  devolver(organizationId: string, propertyId: string, handoffId: string): Promise<boolean>;
  cerrar(organizationId: string, propertyId: string, handoffId: string): Promise<boolean>;
  agregarNota(organizationId: string, propertyId: string, handoffId: string, texto: string): Promise<string>;
  /** Responde por WhatsApp como la persona que tiene la toma; devuelve el id del outbox. Sin envio real: solo encola. */
  responder(organizationId: string, propertyId: string, handoffId: string, texto: string): Promise<string>;
}

/** Lo que consulta el agente de WhatsApp (sesion de SISTEMA, sin usuario). */
export interface HandoffAgentGate {
  /** `'pendiente' | 'tomada'` si hay una toma abierta para ese telefono (el agente debe callar), o `null`. Base sin migrar -> `null`
   * (el agente responde como antes). Registra el ping del cliente. */
  estadoParaAgente(organizationId: string, phone: string): Promise<"pendiente" | "tomada" | null>;
  /** El agente (o el guardrail de crisis) pide un humano. Devuelve el id del handoff o `null` si no hay forma de crearlo (base sin migrar
   * o sin conversacion). Nunca lanza por falta de migracion. Emite la notificacion `citas.conversacion.handoff`. */
  solicitarHumano(input: { readonly organizationId: string; readonly phone: string; readonly motivo: string; readonly crisis: boolean }): Promise<string | null>;
}
