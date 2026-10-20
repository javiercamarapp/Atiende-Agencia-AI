// Descripcion de un error APTA PARA LOGS: solo la clase y un codigo corto (SQLSTATE / errno). Nunca `message` (en Postgres trae los valores de la fila: telefonos,
// nombres, direcciones), ni `cause`, ni la pila, ni argumentos. Los logs de Vercel no son un lugar para datos personales.
export function descripcionSeguraDeError(err: unknown): string {
  const nombre = err instanceof Error ? err.name.slice(0, 60) : typeof err;
  const codigo = (err as { code?: unknown } | null)?.code;
  return typeof codigo === "string" && /^[A-Za-z0-9_]{1,24}$/.test(codigo) ? `${nombre} code=${codigo}` : nombre;
}
