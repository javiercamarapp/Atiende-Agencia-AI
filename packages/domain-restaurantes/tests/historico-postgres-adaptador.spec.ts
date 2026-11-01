// Adaptador Postgres del importador (revision P-4): solo usa funciones definer, jamas SELECT directo a tablas revocadas para authenticated.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PuertoHistoricoPostgres } from "../src/historico/postgres.ts";
import { planificarImportacion } from "../src/historico/importador.ts";
import { limpiarArchivoHistorico } from "../src/historico/limpieza.ts";

function sesion(filas: unknown[] = []) {
  const llamadas: Array<{ sql: string; params: unknown[] }> = [];
  const db = { query: async (sql: string, params: unknown[] = []) => { llamadas.push({ sql, params }); return { rows: filas, rowCount: filas.length }; } } as unknown as TenantDbSession;
  return { db, llamadas };
}
const TABLAS_REVOCADAS = /\b(?:customer_historial_resumen|import_historico_supresion|import_historico_lote|import_historico_fila|customer_quejas_historicas|historial_config)\b/;

describe("PuertoHistoricoPostgres (P-4)", () => {
  it("existentes usa SOLO la funcion historial_existentes y mapea la respuesta", async () => {
    const { db, llamadas } = sesion([
      { phone: "9990000001", customer_id: "c1", huella: "h".repeat(64), suprimido: false },
      { phone: "9990000002", customer_id: null, huella: null, suprimido: true },
    ]);
    const m = await new PuertoHistoricoPostgres(db).existentes("org", ["9990000001", "9990000002"]);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.sql).toContain("restaurantes.historial_existentes(");
    expect(llamadas[0]!.sql).not.toMatch(TABLAS_REVOCADAS);
    expect(m.get("9990000001")).toEqual({ customerId: "c1", huella: "h".repeat(64), suprimido: false });
    expect(m.get("9990000002")).toEqual({ customerId: null, huella: null, suprimido: true });
  });
  it("aplicar llama a importar_historial y no toca tablas directo; sin acciones no consulta", async () => {
    const { clientes, rechazos } = limpiarArchivoHistorico([{ celular: "9990000001", nombre: "Cliente Ejemplo" }]);
    const plan = planificarImportacion(clientes, rechazos, new Map(), "a".repeat(64));
    const { db, llamadas } = sesion();
    await new PuertoHistoricoPostgres(db).aplicar("org", plan);
    expect(llamadas[0]!.sql).toContain("restaurantes.importar_historial(");
    expect(llamadas[0]!.sql).not.toMatch(TABLAS_REVOCADAS);
    const vacio = sesion();
    await new PuertoHistoricoPostgres(vacio.db).existentes("org", []);
    expect(vacio.llamadas).toHaveLength(0);
  });
});
