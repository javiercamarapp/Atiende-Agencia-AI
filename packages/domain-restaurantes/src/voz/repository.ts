import type {
  VozCerrarConversacionInput,
  VozConfig,
  VozConfigEntrada,
  VozConversacionesFiltro,
  VozConversacionesPagina,
  VozConversacionResumen,
  VozIniciarConversacionInput,
  VozLectura,
  VozPreviewSesion,
  VozProveedorId,
  VozRegistrarTurnoInput,
  VozTurno,
} from "./types.ts";

/** Puerto de persistencia del backend de voz (migracion 025). Separado de
 * `RestaurantesRepository` a proposito: todo lo de voz degrada de forma uniforme cuando la base
 * no esta migrada (lecturas -> `disponible: false`; escrituras -> `VozNoDisponibleError`, que las
 * rutas traducen a 503), y nunca toca el resto del dominio. */
export interface VozRepository {
  getConfig(propertyId: string): Promise<VozLectura<VozConfig>>;
  upsertConfig(organizationId: string, propertyId: string, config: VozConfigEntrada): Promise<VozConfig>;
  /** Registra la sesion de preview emitida por `createdBy` (staff autenticado). La vigencia la
   * fija la base a partir de `ttlSegundos` (maximo 15 minutos). */
  crearPreviewSession(input: { organizationId: string; propertyId: string; createdBy: string; proveedor: VozProveedorId; voiceId: string; ttlSegundos: number }): Promise<VozPreviewSesion>;
  listConversaciones(organizationId: string, propertyId: string, filtro: VozConversacionesFiltro): Promise<VozLectura<VozConversacionesPagina>>;
  getConversacion(organizationId: string, propertyId: string, conversationId: string): Promise<VozLectura<{ conversacion: VozConversacionResumen; turnos: readonly VozTurno[] } | null>>;

  // ---- solo sistema (sesion sin usuario; las funciones SQL exigen `auth.uid() is null`) ----
  iniciarConversacion(input: VozIniciarConversacionInput): Promise<string>;
  /** `false` si ese `seq` ya estaba registrado (reintento idempotente). */
  registrarTurno(input: VozRegistrarTurnoInput): Promise<boolean>;
  /** `false` si la conversacion ya estaba cerrada. */
  cerrarConversacion(input: VozCerrarConversacionInput): Promise<boolean>;
  /** `true` solo la PRIMERA vez que se consume una sesion vigente de esa organizacion/sucursal. */
  consumirPreview(input: { sessionId: string; organizationId: string; propertyId: string }): Promise<boolean>;
}
