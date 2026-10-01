// Tipos del backend propio de voz de restaurantes (migracion 025).
// ElevenLabs se retiro del stack de PM (decision 1-oct-2026): la escalera es Gemini 3.8 Live -> gpt-live-1 -> humano/buzon
// con callback. La migracion 025 conserva `elevenlabs-agents` en sus CHECK solo por filas historicas; la API ya no lo acepta
// y `proveedorDeFila` lo normaliza.
export type VozProveedorId = "gemini-3.8-live" | "gpt-live-1";
export const VOZ_PROVEEDORES: readonly VozProveedorId[] = ["gemini-3.8-live", "gpt-live-1"];
export const VOZ_PROVEEDOR_PRINCIPAL: VozProveedorId = "gemini-3.8-live";

/** Proveedor de una fila de la base: un valor historico fuera de la escalera vigente (p. ej. `elevenlabs-agents`) cae al principal. */
export function proveedorDeFila(valor: string): VozProveedorId {
  return (VOZ_PROVEEDORES as readonly string[]).includes(valor) ? (valor as VozProveedorId) : VOZ_PROVEEDOR_PRINCIPAL;
}

export type VozResultado = "pedido_creado" | "escalado" | "abandonado";
export const VOZ_RESULTADOS: readonly VozResultado[] = ["pedido_creado", "escalado", "abandonado"];

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

/** Lectura con estado honesto: `disponible: false` = la base todavia no tiene la migracion 025
 * (nunca se confunde con "no hay datos"). */
export interface VozLectura<T> {
  readonly disponible: boolean;
  readonly valor: T;
}

export interface VozConversacionResumen {
  readonly id: string;
  readonly propertyId: string;
  readonly externalId: string;
  readonly canal: VozCanal;
  readonly proveedor: VozProveedorId;
  readonly voiceId: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationS: number | null;
  readonly costoEstimadoMicroUsd: number;
  readonly latenciaP95Ms: number | null;
  readonly resultado: VozResultado | null;
  readonly orderId: string | null;
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

export interface VozConversacionesFiltro {
  readonly resultado?: VozResultado | null;
  readonly limit?: number;
  readonly offset?: number;
}

export interface VozConversacionesPagina {
  readonly items: readonly VozConversacionResumen[];
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

export interface VozCerrarConversacionInput {
  readonly organizationId: string;
  readonly conversationId: string;
  readonly resultado: VozResultado;
  readonly endedAt: string | null;
  readonly orderId: string | null;
}

/** La base todavia no tiene la migracion 025 (42P01/42703/42883): las rutas responden 503. */
export class VozNoDisponibleError extends Error {
  constructor() {
    super("La voz todavía no está disponible en esta base de datos (migración pendiente).");
    this.name = "VozNoDisponibleError";
  }
}

/** La base rechazo la operacion por pertenencia (sucursal/conversacion/pedido de otra
 * organizacion, conversacion ya cerrada, sesion de staff donde se exige sistema): 42501. */
export class VozRechazadaError extends Error {
  constructor(message = "Operación de voz rechazada: el recurso no pertenece a la organización o ya no admite cambios.") {
    super(message);
    this.name = "VozRechazadaError";
  }
}
