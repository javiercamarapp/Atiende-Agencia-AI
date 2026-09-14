import type { ChecklistItemTarea, TipoTareaOperativa } from "./tipos.ts";

/**
 * Checklist con ítems/fotos/timestamp (H-051, REQ-113): "incompleto puede bloquear la
 * reapertura automática de disponibilidad" — port de
 * rentas/packages/domain/src/limpieza/checklist.ts. Puramente informativo — la capa
 * de aplicación (`./aplicacion/tareas.ts`) decide qué hacer con el resultado (p. ej.
 * no marcar la tarea `completada`, dejarla `bloqueada`).
 */
export function checklistCompleto(items: readonly Pick<ChecklistItemTarea, "completado">[]): boolean {
  if (items.length === 0) return true;
  return items.every((item) => item.completado);
}

/** Una tarea solo puede pasar a `completada` si TODOS sus ítems de checklist están
 * completos (REQ-113) — una tarea sin ningún ítem (mantenimiento/inspección sin
 * checklist asignado) siempre puede completarse. */
export function puedeCompletarTarea(items: readonly Pick<ChecklistItemTarea, "completado">[]): boolean {
  return checklistCompleto(items);
}

/** Plantilla mínima por defecto para tareas de limpieza (REQ-114: los checklists son
 * parametrizables por property/tipo — esta es la base reutilizable cuando la
 * property no definió una plantilla propia; una plantilla por property queda fuera
 * de fase — ver README de este paquete). */
export const PLANTILLA_CHECKLIST_LIMPIEZA_DEFECTO: readonly string[] = [
  "Ropa de cama y toallas cambiadas",
  "Baños limpios y desinfectados",
  "Cocina limpia, sin loza sucia",
  "Pisos aspirados/trapeados en todas las habitaciones",
  "Basura retirada de todos los botes",
  "Amenidades e insumos reabastecidos",
  "Revisión de daños/objetos olvidados",
  "Fotos finales de cada habitación",
];

export const PLANTILLA_CHECKLIST_MANTENIMIENTO_DEFECTO: readonly string[] = [
  "Diagnóstico inicial documentado con fotos",
  "Reparación/atención realizada",
  "Verificación de funcionamiento post-reparación",
];

export function plantillaChecklistPorTipo(tipo: TipoTareaOperativa): readonly string[] {
  if (tipo === "limpieza") return PLANTILLA_CHECKLIST_LIMPIEZA_DEFECTO;
  if (tipo === "mantenimiento") return PLANTILLA_CHECKLIST_MANTENIMIENTO_DEFECTO;
  return [];
}
