import type {
  BandejaFiltro,
  BandejaPagina,
  CallbackAccion,
  CallbackEstado,
  CallbackIntentoEntrada,
  CallbackItem,
  ConversacionCanal,
  ConversacionDetalle,
  ConversacionesLectura,
  TurnoEntrada,
  TurnoPersonal,
} from "./types.ts";

/** Puerto de persistencia de la bandeja de conversaciones / handoff / turnos / callbacks (migracion 028),
 * separado de `RestaurantesRepository` a proposito: todo degrada de forma uniforme cuando la base no esta
 * migrada (lecturas -> `disponible: false`; escrituras -> `ConversacionesNoDisponibleError`, que las rutas
 * traducen a 503) y nunca toca el resto del dominio. */
export interface ConversacionesRepository {
  listarBandeja(organizationId: string, propertyId: string, filtro: BandejaFiltro): Promise<ConversacionesLectura<BandejaPagina>>;
  detalle(organizationId: string, propertyId: string, canal: ConversacionCanal, conversationId: string): Promise<ConversacionesLectura<ConversacionDetalle | null>>;
  /** Devuelve el id del handoff. Lanza `HandoffYaTomadoError` si otra persona ya la tiene. */
  tomar(organizationId: string, propertyId: string, canal: ConversacionCanal, conversationId: string): Promise<string>;
  /** `false` si la toma ya estaba devuelta/cerrada. */
  devolver(organizationId: string, propertyId: string, handoffId: string): Promise<boolean>;
  cerrar(organizationId: string, propertyId: string, handoffId: string): Promise<boolean>;
  agregarNota(organizationId: string, propertyId: string, handoffId: string, texto: string): Promise<string>;
  /** Responde por WhatsApp como la persona que tiene la toma; devuelve el id del outbox. */
  responderWhatsapp(organizationId: string, propertyId: string, handoffId: string, texto: string): Promise<string>;

  listarTurnos(organizationId: string, propertyId: string): Promise<ConversacionesLectura<readonly TurnoPersonal[]>>;
  /** Reemplaza TODOS los turnos de la sucursal (atomico dentro de la transaccion del request). */
  reemplazarTurnos(organizationId: string, propertyId: string, turnos: readonly TurnoEntrada[]): Promise<void>;

  listarCallbacks(organizationId: string, propertyId: string, soloAbiertos: boolean): Promise<ConversacionesLectura<readonly CallbackItem[]>>;
  registrarIntentoCallback(organizationId: string, callbackId: string, intento: CallbackIntentoEntrada): Promise<string>;
  /** Cambia el estado de trabajo de un callback (migracion 033) y devuelve el estado resultante. Base sin 033 ->
   * `ConversacionesNoDisponibleError`; ya tomado por otra persona -> `HandoffYaTomadoError`; ya resuelto o no
   * resuelto segun la accion -> `ConversacionesConflictoError`; sin permiso -> `ConversacionesRechazadaError`. */
  actualizarCallback(organizationId: string, callbackId: string, accion: CallbackAccion, opciones: { readonly asignadoA?: string | null; readonly nota?: string | null }): Promise<CallbackEstado>;
}

/** Lo que consulta el agente de WhatsApp (sesion de SISTEMA, sin usuario). */
export interface HandoffAgentGate {
  /** `'pendiente' | 'tomada'` si hay una toma abierta para ese telefono (el agente debe callar), o `null`.
   * Base sin migrar -> `null` (el agente responde como antes). */
  estadoParaAgente(organizationId: string, phone: string): Promise<"pendiente" | "tomada" | null>;
  /** El agente pide un humano. Devuelve el id del handoff o `null` si no hay forma de crearlo (base sin
   * migrar, sin conversacion o sin sucursal determinable). Nunca lanza por falta de migracion. */
  solicitarHumano(input: { organizationId: string; propertyId: string | null; phone: string; motivo: string }): Promise<string | null>;
}
