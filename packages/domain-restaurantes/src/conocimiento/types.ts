// Conocimiento del negocio (migracion 053): politicas, preguntas frecuentes y avisos temporales que el dueno le da al agente de
// WhatsApp y de voz SIN tocar el prompt. NUNCA llevan precios ni productos (el precio sale siempre de `cotizar_pedido`).

export const CONOCIMIENTO_TIPOS = ["politica", "faq", "aviso_temporal"] as const;
export type ConocimientoTipo = (typeof CONOCIMIENTO_TIPOS)[number];
export const CONOCIMIENTO_ESTADOS = ["borrador", "publicado"] as const;
export type ConocimientoEstado = (typeof CONOCIMIENTO_ESTADOS)[number];
export type ConocimientoOrigen = "manual" | "importado";

/** Topes que replica la base (CHECK de la migracion 053). */
export const CONOCIMIENTO_TITULO_MAX = 120;
export const CONOCIMIENTO_TEXTO_MAX = 2000;
/** Tope total de caracteres de conocimiento que se inyectan en un prompt. */
export const CONOCIMIENTO_TOPE_PROMPT = 6000;

export interface ConocimientoEntrada {
  readonly id: string;
  readonly organizationId: string;
  /** `null` = toda la organizacion; con valor = solo esa sucursal. */
  readonly propertyId: string | null;
  /** Entrada general que esta (de sucursal) sustituye para esa sucursal. */
  readonly reemplazaId: string | null;
  readonly titulo: string;
  readonly texto: string;
  readonly tipo: ConocimientoTipo;
  /** 0 a 100; mayor = antes. */
  readonly prioridad: number;
  /** Fechas locales de la sucursal YYYY-MM-DD (null = sin limite por ese lado). */
  readonly vigenteDesde: string | null;
  readonly vigenteHasta: string | null;
  readonly activo: boolean;
  readonly estado: ConocimientoEstado;
  readonly origen: ConocimientoOrigen;
  readonly version: number;
  readonly creadoPor: string | null;
  readonly actualizadoPor: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NuevaConocimientoEntrada {
  readonly propertyId?: string | null;
  readonly reemplazaId?: string | null;
  readonly titulo: string;
  readonly texto: string;
  readonly tipo: ConocimientoTipo;
  readonly prioridad?: number;
  readonly vigenteDesde?: string | null;
  readonly vigenteHasta?: string | null;
  readonly activo?: boolean;
  readonly estado?: ConocimientoEstado;
  readonly origen?: ConocimientoOrigen;
}

export interface ConocimientoPatch {
  readonly reemplazaId?: string | null;
  readonly titulo?: string;
  readonly texto?: string;
  readonly tipo?: ConocimientoTipo;
  readonly prioridad?: number;
  readonly vigenteDesde?: string | null;
  readonly vigenteHasta?: string | null;
  readonly activo?: boolean;
  readonly estado?: ConocimientoEstado;
}

/** Lectura con estado honesto: `disponible: false` = la base todavia no tiene la migracion 053 (nunca se confunde con "no hay entradas"). */
export interface ConocimientoLectura {
  readonly disponible: boolean;
  readonly entradas: readonly ConocimientoEntrada[];
}

/** Estado del interruptor del agente de WhatsApp de una sucursal. `disponible: false` = base sin migrar: el agente sigue encendido como hasta hoy. */
export interface WhatsappAgenteControl {
  readonly propertyId: string;
  readonly agenteActivo: boolean;
}
