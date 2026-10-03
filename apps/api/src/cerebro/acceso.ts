// Acceso al Cerebro de ventas (migracion 0049) desde el API: deteccion de "migracion pendiente" y aviso estructurado.
//
// Contra la base SIN migrar (SQLSTATE 42883 funcion inexistente, 42P01 tabla inexistente, 42703 columna inexistente)
// el Cerebro responde 200 con `disponible: false` y la lista de prospectos sigue funcionando por el camino anterior;
// nunca un 500. TRANSACCIONES: todo acceso corre dentro de `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO
// SAVEPOINT) porque la sesion del request es UNA sola transaccion.
const SQLSTATE_NO_MIGRADO = new Set(["42P01", "42883", "42703"]);

export function codigoPg(err: unknown): string | undefined {
  const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/** `true` si el error es "tabla/funcion/columna inexistente" (migracion 0049 pendiente). */
export function esCerebroNoMigrado(err: unknown): boolean {
  const code = codigoPg(err);
  return code !== undefined && SQLSTATE_NO_MIGRADO.has(code);
}

/** Aviso estructurado SIN datos del prospecto. */
export function avisarCerebroNoMigrado(contexto: string): void {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", evento: "cerebro_no_migrado", contexto }));
}

export const CEREBRO_NO_DISPONIBLE =
  "El Cerebro de ventas todavía no está disponible en este despliegue: requiere aplicar la migración 0049_cerebro_ventas_base.";
