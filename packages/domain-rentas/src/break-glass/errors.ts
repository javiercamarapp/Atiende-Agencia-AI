// Errores tipados del break-glass -- mismo estilo que
// core-authz/impersonation/errors.ts: una clase base con `code`, una subclase por
// causa, para que el llamador (apps/api) distinga sin volver a parsear el mensaje.

export class BreakGlassError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * Razón ausente, vacía (solo espacios), o más corta que
 * `BREAK_GLASS_MIN_REASON_LENGTH` tras `trim()`. EL requisito central del gap
 * ("razón obligatoria capturada en cada acceso") -- se lanza ANTES de tocar la base o
 * de ejecutar la lectura, nunca después (fail-closed: sin razón válida, ni la consulta
 * corre -- ver acceso.ts::leerDatosTenantBreakGlass).
 */
export class BreakGlassReasonRequiredError extends BreakGlassError {
  readonly actualLength: number;
  readonly minLength: number;

  constructor(actualLength: number, minLength: number) {
    super(
      `La razón de "romper cristal" es obligatoria y debe tener al menos ${minLength} caracteres ` +
        `(se recibieron ${actualLength} tras quitar espacios). Un acceso de emergencia sin ` +
        `justificación real no se registra ni se ejecuta -- fail-closed.`,
      "break_glass_reason_required",
    );
    this.actualLength = actualLength;
    this.minLength = minLength;
  }
}

/** `organizationId` vacío -- no tiene sentido "romper cristal" sin declarar a qué
 *  tenant se accede; hacerlo en silencio produciría una fila de auditoría que apunta a
 *  nada. */
export class BreakGlassOrganizationRequiredError extends BreakGlassError {
  constructor() {
    super(
      "organizationId vacío: no se ejecuta un acceso de romper-cristal sin declarar el tenant afectado.",
      "break_glass_organization_required",
    );
  }
}

/**
 * EL FALLO QUE ESTE MECANISMO EXISTE PARA CERRAR: la escritura de la bitácora
 * inmutable falló (constraint de la base, conexión caída, lo que sea). A diferencia de
 * `recordImpersonation` (core-authz, "best-effort", nunca lanza -- ver su cabecera),
 * aquí el fallo de auditoría SÍ bloquea: `leerDatosTenantBreakGlass` nunca devuelve al
 * llamador datos que ya leyó si no logró persistir la fila que los describe. La
 * diferencia de criterio es deliberada -- ver comentario de cabecera de
 * 012_break_glass_audit.sql: "romper cristal" es un incidente de EMERGENCIA, no una
 * navegación rutinaria; que la auditoría falle nunca debe traducirse en un acceso sin
 * rastro.
 */
export class BreakGlassAuditWriteFailedError extends BreakGlassError {
  constructor(cause: unknown) {
    super(
      "No se pudo escribir la bitácora inmutable de romper-cristal -- el acceso se DENIEGA " +
        "(fail-closed): sin una fila de auditoría persistida, los datos ya leídos no se entregan.",
      "break_glass_audit_write_failed",
    );
    // `Error.cause` (ES2022, ya en lib de tsconfig.base.json) -- no se redeclara el
    // campo para no chocar con el tipo opcional heredado, se asigna directo.
    this.cause = cause;
  }
}
