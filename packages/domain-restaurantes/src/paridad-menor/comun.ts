// Utilidades compartidas de la paridad menor (F4c): lectura tolerante a la base sin migrar y errores tipados.
export function codigoPg(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Tabla, columna o funcion inexistente: la base todavia no tiene la migracion (180-183). */
export const esBaseSinMigrar = (err: unknown): boolean => ["42P01", "42703", "42883"].includes(codigoPg(err) ?? "");
/** Ademas de "sin migrar": 42501 (RLS / permiso denegado) es un rechazo conocido. */
export const esErrorEscrituraConocido = (err: unknown): boolean => esBaseSinMigrar(err) || codigoPg(err) === "42501";

/** La funcion todavia no existe en esta base (503 honesto en la ruta, nunca un 500). */
export class ParidadNoDisponibleError extends Error {
  constructor(message = "Esta funcion todavia no esta disponible en esta base de datos (falta aplicar su migracion).") {
    super(message);
    this.name = "ParidadNoDisponibleError";
  }
}

/** La base (RLS) nego el permiso. */
export class ParidadRechazadaError extends Error {
  constructor(message = "No tienes permiso para hacer este cambio.") {
    super(message);
    this.name = "ParidadRechazadaError";
  }
}

export const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
