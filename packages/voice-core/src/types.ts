// Tipos GENERICOS del backend de voz compartido por las verticales (restaurantes, hoteles y, despues, citas/licitaciones).
// La escalera de proveedores es la misma para todas (`config-plataforma.ts`): Gemini 3.8 Live -> cascada OpenRouter -> humano/buzon con callback
// (sin ElevenLabs ni gpt-live). `VozProveedorId` es solo el valor de la COLUMNA `proveedor` de las tablas de voz ya migradas (su CHECK admite
// `gemini-3.8-live`, `gpt-live-1` y `elevenlabs-agents`); `gpt-live-1` ya no lo atiende nadie, queda como valor historico permitido por esa restriccion.
// Lo que depende de la vertical (el resultado de cierre de la llamada, la entidad que la llamada crea) se parametriza aqui o
// se queda en la vertical.
export type VozProveedorId = "gemini-3.8-live" | "gpt-live-1";
export const VOZ_PROVEEDORES: readonly VozProveedorId[] = ["gemini-3.8-live", "gpt-live-1"];
export const VOZ_PROVEEDOR_PRINCIPAL: VozProveedorId = "gemini-3.8-live";

/** Proveedor de una fila de la base: un valor historico fuera de la escalera vigente (p. ej. `elevenlabs-agents`) cae al principal. */
export function proveedorDeFila(valor: string): VozProveedorId {
  return (VOZ_PROVEEDORES as readonly string[]).includes(valor) ? (valor as VozProveedorId) : VOZ_PROVEEDOR_PRINCIPAL;
}

/** Resultados que la maquina de la llamada decide por si sola, sin saber de la vertical. Cada vertical agrega UNO propio: el de
 * "la llamada logro su objetivo" (restaurantes: `pedido_creado`; hoteles: `pre_reserva_creada`). */
export type VozResultadoBase = "escalado" | "abandonado";

export type VozRolTurno = "cliente" | "agente" | "herramienta";
export const VOZ_ROLES_TURNO: readonly VozRolTurno[] = ["cliente", "agente", "herramienta"];

export type VozCanal = "llamada" | "preview";

export const VOZ_COMPORTAMIENTO_MAX = 8000;
export const VOZ_MENSAJE_INICIAL_MAX = 500;
export const VOZ_TURNO_TEXTO_MAX = 4000;

export interface VozConfig {
  readonly habilitado: boolean;
  readonly proveedor: VozProveedorId;
  readonly voiceId: string;
  readonly comportamiento: string;
  readonly mensajeInicial: string;
  /** `false` cuando la sucursal nunca guardo configuracion (o la base no esta migrada): los
   * demas campos son los valores iniciales del formulario. */
  readonly configurada: boolean;
}

export type VozConfigEntrada = Omit<VozConfig, "configurada">;

/** Lectura con estado honesto: `disponible: false` = la base todavia no tiene la migracion de voz
 * (nunca se confunde con "no hay datos"). */
export interface VozLectura<T> {
  readonly disponible: boolean;
  readonly valor: T;
}

export interface VozTurno {
  readonly seq: number;
  readonly rol: VozRolTurno;
  readonly texto: string;
  readonly duracionMs: number | null;
  readonly latenciaMs: number | null;
  readonly costoEstimadoMicroUsd: number;
  readonly createdAt: string;
}

export interface VozConversacionesFiltro<R extends string = string> {
  readonly resultado?: R | null;
  readonly limit?: number;
  readonly offset?: number;
}

export interface VozConversacionesPagina<C> {
  readonly items: readonly C[];
  readonly total: number;
}

export interface VozPreviewSesion {
  readonly id: string;
  readonly expiresAt: string;
}

export interface VozIniciarConversacionInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly externalId: string;
  readonly canal: VozCanal;
  readonly proveedor: VozProveedorId;
  readonly voiceId: string | null;
  readonly callerHash: string | null;
  readonly startedAt: string | null;
}

export interface VozRegistrarTurnoInput {
  readonly organizationId: string;
  readonly conversationId: string;
  readonly seq: number;
  readonly rol: VozRolTurno;
  readonly texto: string;
  readonly duracionMs: number | null;
  readonly latenciaMs: number | null;
  readonly costoMicroUsd: number;
}

export interface VozCerrarConversacionInputBase<R extends string> {
  readonly organizationId: string;
  readonly conversationId: string;
  readonly resultado: R;
  readonly endedAt: string | null;
}

/** La base todavia no tiene la migracion de voz (42P01/42703/42883): las rutas responden 503. */
export class VozNoDisponibleError extends Error {
  constructor() {
    super("La voz todavía no está disponible en esta base de datos (migración pendiente).");
    this.name = "VozNoDisponibleError";
  }
}

/** La base rechazo la operacion por pertenencia (sucursal/conversacion/entidad de otra
 * organizacion, conversacion ya cerrada, sesion de staff donde se exige sistema): 42501. */
export class VozRechazadaError extends Error {
  constructor(message = "Operación de voz rechazada: el recurso no pertenece a la organización o ya no admite cambios.") {
    super(message);
    this.name = "VozRechazadaError";
  }
}
