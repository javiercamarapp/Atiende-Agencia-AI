// Vocabulario de errores tipado propio de domain-rentas — mismo patrón que
// domain-hoteles::QuoteError: el paquete de dominio lanza un error CON CÓDIGO, apps/api
// lo traduce a un status HTTP en la ruta (ver diseño Fase 1 §4.1, "traducción de
// errores: mismo mapeo que traducirErrorDominio del origen"). El port original de
// aplicacion/reservas.ts usaba `throw new Error(string)` genérico; aquí se tipa para
// que la ruta HTTP pueda distinguir el código sin parsear el mensaje.
export type RentasErrorCode =
  | "rango_invalido"
  | "duracion_minima_no_alcanzada"
  | "unidad_no_encontrada"
  | "ocupacion_no_encontrada"
  | "reserva_no_directa"
  | "transicion_no_permitida"
  // ---- limpieza/mantenimiento (Fase 8, ver ./limpieza/aplicacion/tareas.ts) ----
  | "tarea_no_encontrada"
  | "checklist_item_no_encontrado"
  | "checklist_incompleto"
  | "item_inventario_no_encontrado"
  | "incidencia_no_encontrada"
  | "bloqueo_mantenimiento_no_aplicable"
  | "bloqueo_mantenimiento_ya_confirmado"
  | "bloqueo_mantenimiento_sin_rango";

export class RentasDomainError extends Error {
  readonly code: RentasErrorCode;

  constructor(code: RentasErrorCode, message: string) {
    super(message);
    this.name = "RentasDomainError";
    this.code = code;
  }
}
