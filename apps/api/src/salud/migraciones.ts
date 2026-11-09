// ¿Qué migraciones tiene aplicadas la base? (Ola 4, G4). Lee `core.migraciones_aplicadas()` (0101) en una sesión de
// SISTEMA propia (su propia transacción, así que el fallback no necesita SAVEPOINT). Solo lo usa el DETALLE de /health
// (con el secreto interno): en un repo público, la lista de lo que falta en producción no se publica.
//
// Nunca lanza: base sin la 0101 -> "funcion_no_migrada"; sin registro de la CLI (0 filas) -> "sin_registro"; cualquier
// otro error -> "error". Ninguno se reporta como "al día": la comparación con el repo la hace el smoke post-deploy.
import { isMigrationPendingError } from "@atiende/db";
import type { TenancyEngine } from "@atiende/core-tenancy";

export type EstadoMigraciones =
  | { readonly estado: "medido"; readonly aplicadas: readonly string[]; readonly maxima: string }
  | { readonly estado: "sin_medir"; readonly motivo: "funcion_no_migrada" | "sin_registro" | "error" };

export async function leerMigracionesAplicadas(engine: TenancyEngine): Promise<EstadoMigraciones> {
  try {
    const filas = await engine.withAppSession({ userId: null }, async (db) => {
      const r = await db.query<{ version: string }>("select v as version from core.migraciones_aplicadas() as v;");
      return r.rows;
    });
    const aplicadas = filas.map((f) => String(f.version)).sort();
    const maxima = aplicadas.at(-1);
    if (maxima === undefined) return { estado: "sin_medir", motivo: "sin_registro" };
    return { estado: "medido", aplicadas, maxima };
  } catch (err) {
    if (isMigrationPendingError(err, "core.migraciones_aplicadas")) return { estado: "sin_medir", motivo: "funcion_no_migrada" };
    return { estado: "sin_medir", motivo: "error" };
  }
}
