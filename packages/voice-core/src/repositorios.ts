// Puertos de persistencia GENERICOS del backend de voz. Cada vertical implementa los suyos sobre SUS tablas (restaurantes:
// `restaurantes.voice_conversation`, migraciones 025/035) y el core solo fija el contrato: el servicio de voz y las rutas internas
// dependen de esta forma, no de un esquema. Una tabla generica compartida (`core.voice_call`) es el siguiente paso, no este PR.
import type { VozAlerta, VozEventoEntrada, VozKpiDia, VozUmbrales, VozUmbralesEntrada } from "./kpi.ts";
import type {
  VozCerrarConversacionInputBase,
  VozConfig,
  VozConfigEntrada,
  VozConversacionesFiltro,
  VozConversacionesPagina,
  VozIniciarConversacionInput,
  VozLectura,
  VozPreviewSesion,
  VozProveedorId,
  VozRegistrarTurnoInput,
  VozTurno,
} from "./types.ts";

/** Repositorio de llamadas de una vertical. `R` = resultados de cierre de esa vertical; `C` = su resumen de conversacion;
 * `Cerrar` = la entrada de cierre (agrega, por ejemplo, el id del pedido o de la reserva que la llamada produjo). */
export interface RepositorioLlamadasVoz<R extends string, C extends { readonly id: string }, Cerrar extends VozCerrarConversacionInputBase<R> = VozCerrarConversacionInputBase<R>> {
  getConfig(propertyId: string): Promise<VozLectura<VozConfig>>;
  upsertConfig(organizationId: string, propertyId: string, config: VozConfigEntrada): Promise<VozConfig>;
  /** Registra la sesion de preview emitida por `createdBy` (staff autenticado). La vigencia la fija la base (maximo 15 minutos). */
  crearPreviewSession(input: { organizationId: string; propertyId: string; createdBy: string; proveedor: VozProveedorId; voiceId: string; ttlSegundos: number }): Promise<VozPreviewSesion>;
  listConversaciones(organizationId: string, propertyId: string, filtro: VozConversacionesFiltro<R>): Promise<VozLectura<VozConversacionesPagina<C>>>;
  getConversacion(organizationId: string, propertyId: string, conversationId: string): Promise<VozLectura<{ conversacion: C; turnos: readonly VozTurno[] } | null>>;

  // ---- solo sistema (sesion sin usuario; las funciones SQL exigen `auth.uid() is null`) ----
  iniciarConversacion(input: VozIniciarConversacionInput): Promise<string>;
  /** `false` si ese `seq` ya estaba registrado (reintento idempotente). */
  registrarTurno(input: VozRegistrarTurnoInput): Promise<boolean>;
  /** `false` si la conversacion ya estaba cerrada. */
  cerrarConversacion(input: Cerrar): Promise<boolean>;
  /** Barrido de plataforma: cierra como abandonadas (con duracion y costo calculados) las llamadas abiertas hace mas de `inactivasMinutos` minutos
   * (el worker murio antes de cerrarlas) y devuelve cuantas cerro. Lanza `VozNoDisponibleError` si la base no tiene la funcion (sin migrar). */
  cerrarHuerfanas(opciones: { inactivasMinutos: number; limite: number }): Promise<number>;
  /** `true` solo la PRIMERA vez que se consume una sesion vigente de esa organizacion/sucursal. */
  consumirPreview(input: { sessionId: string; organizationId: string; propertyId: string }): Promise<boolean>;
}

/** Repositorio de KPI/alertas de voz de una vertical. Degrada igual que el de llamadas: lecturas -> `disponible: false`; escrituras ->
 * `VozNoDisponibleError` (503). */
export interface RepositorioKpiVoz {
  /** KPI por dia LOCAL de la sucursal, de `desde` a `hasta` (YYYY-MM-DD, inclusive, maximo 63 dias). Un dia sin llamadas aparece con ceros. */
  getKpisDiarios(organizationId: string, propertyId: string, desde: string, hasta: string): Promise<VozLectura<readonly VozKpiDia[]>>;
  getUmbrales(propertyId: string): Promise<VozLectura<VozUmbrales>>;
  upsertUmbrales(organizationId: string, propertyId: string, actorUserId: string, entrada: VozUmbralesEntrada): Promise<VozUmbrales>;
  /** Compara HOY (dia local) con los umbrales, registra las alertas nuevas y devuelve las de hoy. */
  evaluarAlertas(organizationId: string, propertyId: string): Promise<VozLectura<readonly VozAlerta[]>>;
  /** Alertas ya disparadas, mas recientes primero. */
  listAlertas(organizationId: string, propertyId: string, limite: number): Promise<VozLectura<readonly VozAlerta[]>>;
  // ---- solo sistema ----
  registrarEvento(input: VozEventoEntrada): Promise<void>;
}
