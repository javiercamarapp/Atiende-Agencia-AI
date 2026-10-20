// Descripcion de un error APTA PARA LOGS: solo la clase y un codigo corto (SQLSTATE / errno de Node). Nunca `message` (en Postgres trae los valores de la fila: telefonos,
// nombres, direcciones), ni `cause`, ni la pila, ni argumentos. Los logs de Vercel no son un lugar para datos personales. NUNCA lanza (se usa dentro de catch).
const NOMBRE_VALIDO = /^[A-Za-z0-9_$.]{1,60}$/;
// SQLSTATE (5 caracteres) o errno de Node (ECONNRESET, ERR_*). Un numero largo (un telefono) no cumple ninguno.
const CODIGO_VALIDO = /^(?:[0-9A-Z]{5}|E[A-Z0-9_]+)$/;

export function descripcionSeguraDeError(err: unknown): string {
  try {
    if (!(err instanceof Error)) return typeof err;
    const nombre = typeof err.name === "string" && NOMBRE_VALIDO.test(err.name) ? err.name : "Error";
    const codigo = (err as { code?: unknown }).code;
    return typeof codigo === "string" && CODIGO_VALIDO.test(codigo) ? `${nombre} code=${codigo}` : nombre;
  } catch {
    return "error";
  }
}
