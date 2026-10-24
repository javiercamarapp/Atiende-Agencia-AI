// Historial (busqueda e incidencias): el SQL de `listOrders` nunca concatena el texto del usuario, escapa los comodines, solo busca telefono con
// 4+ digitos, acota por organizacion y por sucursales, y las reglas de normalizacion de la busqueda. Doble de sesion que registra consultas.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { BUSQUEDA_PEDIDOS_MAX, digitosBusquedaTelefono, normalizarBusquedaPedidos } from "../src/types.ts";

function sesion() {
  const llamadas: Array<{ sql: string; params: unknown[] }> = [];
  const db = { query: async (sql: string, params: unknown[] = []) => { llamadas.push({ sql, params }); return { rows: [], rowCount: 0 }; } } as unknown as TenantDbSession;
  return { db, llamadas };
}

describe("listOrders: busqueda e incidencias", () => {
  it("nombre: ilike parametrizado con comodines escapados y organizacion siempre en el filtro", async () => {
    const { db, llamadas } = sesion();
    await new PostgresRestaurantesRepository(db).listOrders("org-1", { propertyIds: ["p-1"], busqueda: "a%_b'; drop table x;--", limit: 20 });
    const { sql, params } = llamadas[0]!;
    expect(sql).toContain("organization_id = $1");
    expect(sql).toContain("customer_name ilike $");
    expect(sql).not.toContain("drop table");
    expect(sql).not.toContain("regexp_replace(customer_phone");
    const patron = params.find((p) => typeof p === "string" && p.startsWith("%a")) as string;
    expect(patron).toBe("%a\\%\\_b'; drop table x;--%");
  });

  it("telefono: solo con 4+ digitos, comparando solo digitos", async () => {
    const { db, llamadas } = sesion();
    await new PostgresRestaurantesRepository(db).listOrders("org-1", { propertyIds: null, busqueda: "+52 999 5550", limit: 20 });
    const { sql, params } = llamadas[0]!;
    expect(sql).toContain("regexp_replace(customer_phone, '[^0-9]', '', 'g') like $");
    expect(params).toContain("%529995550%");
  });

  it("incidencias: status = any(problema, cancelado) parametrizado", async () => {
    const { db, llamadas } = sesion();
    await new PostgresRestaurantesRepository(db).listOrders("org-1", { propertyIds: null, soloIncidencias: true, limit: 20 });
    expect(llamadas[0]!.sql).toContain("status = any($");
    expect(llamadas[0]!.params).toContainEqual(["problema", "cancelado"]);
  });
});

describe("normalizacion de la busqueda", () => {
  it("recorta, colapsa espacios, ignora lo corto y rechaza lo largo", () => {
    expect(normalizarBusquedaPedidos(undefined)).toBeUndefined();
    expect(normalizarBusquedaPedidos("   ")).toBeUndefined();
    expect(normalizarBusquedaPedidos("a")).toBeUndefined();
    expect(normalizarBusquedaPedidos("  Ana   Pool ")).toBe("Ana Pool");
    expect(normalizarBusquedaPedidos("x".repeat(BUSQUEDA_PEDIDOS_MAX + 1))).toBeNull();
    expect(digitosBusquedaTelefono("123")).toBeNull();
    expect(digitosBusquedaTelefono("12 34")).toBe("1234");
  });
});
