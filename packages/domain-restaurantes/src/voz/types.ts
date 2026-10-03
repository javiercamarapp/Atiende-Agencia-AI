// Tipos del backend propio de voz de restaurantes (migracion 025). Lo generico (escalera de proveedores, turnos, config, errores) vive en
// @atiende/voice-core; aqui queda lo propio de restaurantes: el resultado `pedido_creado` y el pedido que una llamada produce.
// ElevenLabs se retiro del stack de PM (decision 1-oct-2026): la escalera es Gemini 3.8 Live -> gpt-live-1 -> humano/buzon
// con callback. La migracion 025 conserva `elevenlabs-agents` en sus CHECK solo por filas historicas; la API ya no lo acepta
// y `proveedorDeFila` lo normaliza.
import type { VozCanal, VozCerrarConversacionInputBase, VozConversacionesFiltro as CoreFiltro, VozConversacionesPagina as CorePagina, VozProveedorId, VozResultadoBase } from "@atiende/voice-core";

export { VOZ_PROVEEDORES, VOZ_PROVEEDOR_PRINCIPAL, proveedorDeFila, VOZ_ROLES_TURNO, VOZ_COMPORTAMIENTO_MAX, VOZ_MENSAJE_INICIAL_MAX, VOZ_TURNO_TEXTO_MAX, VozNoDisponibleError, VozRechazadaError } from "@atiende/voice-core";
export type {
  VozProveedorId,
  VozRolTurno,
  VozCanal,
  VozConfig,
  VozConfigEntrada,
  VozLectura,
  VozTurno,
  VozPreviewSesion,
  VozIniciarConversacionInput,
  VozRegistrarTurnoInput,
} from "@atiende/voice-core";

export type VozResultado = "pedido_creado" | VozResultadoBase;
export const VOZ_RESULTADOS: readonly VozResultado[] = ["pedido_creado", "escalado", "abandonado"];

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

export type VozConversacionesFiltro = CoreFiltro<VozResultado>;
export type VozConversacionesPagina = CorePagina<VozConversacionResumen>;

export interface VozCerrarConversacionInput extends VozCerrarConversacionInputBase<VozResultado> {
  readonly orderId: string | null;
}
