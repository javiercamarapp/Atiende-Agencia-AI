// Barril de src/limpieza (Fase 8 -- módulo operativo de limpieza/mantenimiento:
// tareas, checklist, inventario, incidencias). Mismo patrón que ../mensajeria/index.ts,
// ../ical/*, ../sync/*: solo reexporta lo público de esta subcarpeta.
export type {
  CategoriaItemInventario,
  ChecklistItemTarea,
  ConfiguracionOperativaPropiedad,
  ConsumoInventario,
  EstadoIncidencia,
  EstadoTareaOperativa,
  ItemInventarioUnidad,
  PrioridadTareaOperativa,
  SeveridadIncidencia,
  TipoTareaOperativa,
} from "./tipos.ts";
export { CONFIGURACION_OPERATIVA_DEFECTO } from "./tipos.ts";

export { calcularRangoBuffer } from "./buffer.ts";
export { calcularVencimientoSla, tareaVencida } from "./sla.ts";
export { checklistCompleto, plantillaChecklistPorTipo, puedeCompletarTarea, PLANTILLA_CHECKLIST_LIMPIEZA_DEFECTO, PLANTILLA_CHECKLIST_MANTENIMIENTO_DEFECTO } from "./checklist.ts";
export { aplicarConsumo, stockBajo } from "./inventario.ts";
export type { ResultadoConsumoInventario } from "./inventario.ts";
export { requiereConfirmacionHumanaParaBloqueo } from "./incidencias.ts";

export {
  asignarTarea,
  cancelarTareaPorCancelacionReserva,
  completarChecklistItem,
  completarTarea,
  confirmarBloqueoMantenimiento,
  crearTareaLimpiezaPorCheckout,
  procesarCheckoutsPendientes,
  registrarIncidencia,
  reprogramarTareaPorCambioReserva,
} from "./aplicacion/tareas.ts";
export type { ResultadoConfirmarBloqueoMantenimiento, ResultadoCrearTareaCheckout, ResultadoProcesarCheckouts } from "./aplicacion/tareas.ts";
