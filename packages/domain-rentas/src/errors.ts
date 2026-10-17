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
  | "bloqueo_mantenimiento_sin_rango"
  // ---- onboarding self-serve (Fase 11, ver ./onboarding/captura.ts) ----
  | "onboarding_datos_invalidos"
  | "onboarding_organizacion_duplicada"
  // ---- finanzas (Rn-18, ver ./finanzas/regla-comision-por-defecto.ts) ----
  | "regla_comision_no_configurada"
  // ---- importacion del reporte de pagos de la OTA (Rn-P3-06, ver ./finanzas/csv/*) ----
  | "formato_reporte_no_soportado"
  | "reporte_invalido";

export class RentasDomainError extends Error {
  readonly code: RentasErrorCode;

  constructor(code: RentasErrorCode, message: string) {
    super(message);
    this.name = "RentasDomainError";
    this.code = code;
  }
}

/**
 * Rn-18 -- el canal de la reserva no tiene ninguna regla de comision (ni de la property ni
 * global del tenant) y no existe un default seguro para ese canal. Es un error de NEGOCIO con
 * accion clara (configurar la regla en Finanzas), no una excepcion generica: la ruta lo traduce
 * a 409 `comision_canal_sin_regla`.
 */
export class ReglaComisionCanalNoConfiguradaError extends RentasDomainError {
  readonly canalCodigo: string | null;

  constructor(canalCodigo: string | null) {
    super(
      "regla_comision_no_configurada",
      `No hay rentas.regla_comision_canal configurada para el canal "${canalCodigo ?? "desconocido"}" (ni específica de la property ni global del tenant). ` +
        "Configura la comisión de ese canal en Finanzas > Comisiones de canal, o carga los valores sugeridos.",
    );
    this.name = "ReglaComisionCanalNoConfiguradaError";
    this.canalCodigo = canalCodigo;
  }
}
