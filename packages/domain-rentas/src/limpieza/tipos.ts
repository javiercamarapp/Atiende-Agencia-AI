// Tipos de dominio de operación (limpieza/mantenimiento/inspección) — port de
// rentas/packages/domain/src/limpieza/tipos.ts (Lote 5 del origen, BACKLOG E08,
// H-049 a H-055, REQ-111..120). Carpeta exclusiva de este lote (mismo criterio que
// ../mensajeria/tipos.ts, ../pricing/tipos.ts): sin IO, solo formas de datos +
// constantes puras. Reexporta `RangoFechas`/`FechaLocal` de `../tipos.ts` en vez de
// redefinirlos — a diferencia del origen (paquete de dominio standalone), aquí ya
// existen como el vocabulario único de calendario de todo `domain-rentas`.
export type TipoTareaOperativa = "limpieza" | "mantenimiento" | "inspeccion";

export type EstadoTareaOperativa = "pendiente" | "asignada" | "en_progreso" | "completada" | "bloqueada" | "cancelada";

export type PrioridadTareaOperativa = "baja" | "media" | "alta" | "urgente";

export type SeveridadIncidencia = "leve" | "moderada" | "grave";

export type EstadoIncidencia = "abierta" | "en_revision" | "bloqueo_propuesto" | "bloqueo_confirmado" | "resuelta" | "descartada";

export type CategoriaItemInventario = "ropa_blanca" | "consumible" | "otro";

/** Ítem de checklist de una tarea — forma pura usada por `./checklist.ts`. La fila
 * real (`rentas.checklist_item_tarea`) tiene las mismas columnas; este tipo es lo
 * mínimo que la función pura necesita para decidir si una tarea puede completarse
 * (H-051, REQ-113). */
export interface ChecklistItemTarea {
  readonly id: string;
  readonly tareaId: string;
  readonly descripcion: string;
  readonly orden: number;
  readonly completado: boolean;
  readonly completadoEn: string | null;
  readonly completadoPor: string | null;
}

/** Ítem de inventario de una unidad — forma pura usada por `./inventario.ts`
 * (H-052, REQ-115). */
export interface ItemInventarioUnidad {
  readonly id: string;
  readonly unidadId: string;
  readonly nombre: string;
  readonly categoria: CategoriaItemInventario;
  readonly cantidadActual: number;
  readonly umbralMinimo: number;
  readonly unidadMedida: string;
}

export interface ConsumoInventario {
  readonly itemInventarioId: string;
  readonly cantidad: number;
}

/** Configuración operativa por property (H-050, H-054): buffer de limpieza (en
 * noches, unidad mínima del modelo de calendario `[inicio, fin)` de `../tipos.ts`) y
 * SLA internos por tipo de tarea (en horas). Persiste como columnas nuevas de
 * `rentas.property_config` (ver migración 010) — NUNCA una tabla propia, para no
 * duplicar la fila de configuración por property que ya existe desde la Fase 1. */
export interface ConfiguracionOperativaPropiedad {
  readonly propertyId: string;
  readonly bufferLimpiezaNoches: number;
  readonly slaLimpiezaHoras: number;
  readonly slaMantenimientoHoras: number;
}

export const CONFIGURACION_OPERATIVA_DEFECTO: Omit<ConfiguracionOperativaPropiedad, "propertyId"> = {
  bufferLimpiezaNoches: 1,
  slaLimpiezaHoras: 4,
  slaMantenimientoHoras: 24,
};
