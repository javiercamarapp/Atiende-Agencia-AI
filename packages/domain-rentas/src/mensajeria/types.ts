// Tipos de persistencia de mensajería — separados de ./tipos.ts (tipos de DOMINIO
// puro, sin id/timestamps) igual que domain-rentas/src/types.ts separa
// UnidadRecord/OcupacionResumen de ./tipos.ts (tipos de calendario). Consumidos por
// ./repository.ts y sus dos adaptadores.
import type { CanalMensajeriaCodigo, DireccionMensaje, EstadoBorrador, EventoPlantilla, IdiomaMensaje, OrigenMensaje } from "./tipos.ts";

export interface ConversacionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canal: CanalMensajeriaCodigo;
  readonly ocupacionId: string | null;
  readonly huespedMinimoId: string | null;
  /** Contexto ya resuelto por el servidor (join a unidad/property/huésped/ocupación
   * al momento de crear la conversación) — se congela en la fila para que
   * `ContextoBorrador` nunca dependa de un segundo join en el momento de generar un
   * borrador; mismo criterio de "nunca construir contexto a partir del texto del
   * huésped" documentado en ./tipos.ts. */
  readonly propiedadNombre: string;
  readonly huespedNombre: string | null;
  readonly fechaCheckIn: string | null;
  readonly fechaCheckOut: string | null;
  readonly reservaConfirmada: boolean;
  readonly creadoEn: string;
}

export interface NewConversacionInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canal: CanalMensajeriaCodigo;
  readonly ocupacionId?: string | null;
  readonly huespedMinimoId?: string | null;
  readonly propiedadNombre: string;
  readonly huespedNombre?: string | null;
  readonly fechaCheckIn?: string | null;
  readonly fechaCheckOut?: string | null;
  readonly reservaConfirmada?: boolean;
}

export interface MensajeRecord {
  readonly id: string;
  readonly conversacionId: string;
  readonly direccion: DireccionMensaje;
  readonly origen: OrigenMensaje;
  readonly texto: string;
  readonly redactado: boolean;
  readonly creadoEn: string;
}

export interface NewMensajeInput {
  readonly conversacionId: string;
  readonly direccion: DireccionMensaje;
  readonly origen: OrigenMensaje;
  readonly texto: string;
  readonly redactado?: boolean;
}

export type GeneradoPorBorrador = "motor_borrador" | "agente_llm";

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

export interface NewBorradorInput {
  readonly conversacionId: string;
  readonly mensajeEntranteId?: string | null;
  readonly canal: CanalMensajeriaCodigo;
  readonly texto: string;
  readonly generadoPor: GeneradoPorBorrador;
}

export interface MarcarBorradorAprobadoYEnviadoInput {
  readonly id: string;
  readonly aprobadoPor: string;
  readonly textoFinal: string;
  readonly redactado: boolean;
  readonly mensajeEnviadoId: string;
}

export interface MarcarBorradorRechazadoInput {
  readonly id: string;
  readonly rechazadoPor: string;
  readonly motivo: string;
}

export interface PlantillaRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly evento: EventoPlantilla;
  readonly idioma: IdiomaMensaje;
  readonly canal: CanalMensajeriaCodigo | null;
  readonly cuerpo: string;
  readonly aprobadaPorTenant: boolean;
  readonly activa: boolean;
  readonly creadoEn: string;
  readonly actualizadoEn: string;
}

export interface NewPlantillaInput {
  readonly organizationId: string;
  readonly evento: EventoPlantilla;
  readonly idioma: IdiomaMensaje;
  readonly canal: CanalMensajeriaCodigo | null;
  readonly cuerpo: string;
  /** Default `false` en ambos adaptadores — crear una plantilla NUNCA la deja lista
   * para programación automática sin un paso explícito de aprobación (H-056, ver
   * ../mensajeria/plantillas.ts::exigirPlantillaAprobadaParaProgramar). */
  readonly aprobadaPorTenant?: boolean;
  readonly activa?: boolean;
}

export interface UpdatePlantillaInput {
  readonly id: string;
  readonly organizationId: string;
  readonly cuerpo?: string;
  readonly aprobadaPorTenant?: boolean;
  readonly activa?: boolean;
}
