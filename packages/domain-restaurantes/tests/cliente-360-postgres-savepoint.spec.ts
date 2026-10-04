// Cliente 360 contra la base SIN migrar: la sesion de produccion es UNA transaccion por request; un error de Postgres sin
// SAVEPOINT la deja abortada (25P02) y el COMMIT seria un ROLLBACK silencioso. AbortAwareFakeSession reproduce ese estado.
import { describe, expect, it } from "vitest";
import { ClienteMemoriaNoDisponibleError } from "../src/errors.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message = "error simulado"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const ORG = "00000000-0000-0000-0000-000000000001";

function repoConFunciones(respuestas: Partial<Record<string, () => unknown>>) {
  const session = new AbortAwareFakeSession([
    ...Object.entries(respuestas).map(([fn, respond]) => ({ match: new RegExp(`restaurantes\\.${fn}\\(`), respond: respond! })),
    { match: /^select 1 as viva/i, respond: () => [{ viva: 1 }] },
  ]);
  return { session, repo: new PostgresRestaurantesRepository(session) };
}

async function sesionViva(session: AbortAwareFakeSession): Promise<void> {
  await expect(session.query("select 1 as viva")).resolves.toEqual({ rows: [{ viva: 1 }] });
}

describe("lectura y cierre de sistema contra la base sin la migracion 044", () => {
  it("cliente_memoria inexistente (42883) devuelve undefined y la transaccion sigue utilizable", async () => {
    const { session, repo } = repoConFunciones({ cliente_memoria: () => pgError("42883", "function restaurantes.cliente_memoria does not exist") });
    await expect(repo.getCustomerMemory(ORG, "9991234567")).resolves.toBeUndefined();
    await sesionViva(session);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("cliente_registrar_pedido inexistente (42883) devuelve undefined y la transaccion sigue utilizable", async () => {
    const { session, repo } = repoConFunciones({ cliente_registrar_pedido: () => pgError("42883") });
    await expect(repo.registerOrderClosure({ organizationId: ORG, orderId: "o1", address: null, observations: [] })).resolves.toBeUndefined();
    await sesionViva(session);
  });

  it("tabla o columna inexistente (42P01 / 42703) tambien degrada; cualquier otro error se propaga tal cual", async () => {
    for (const code of ["42P01", "42703"]) {
      const { repo } = repoConFunciones({ cliente_memoria: () => pgError(code) });
      await expect(repo.getCustomerMemory(ORG, "9991234567")).resolves.toBeUndefined();
    }
    const { session, repo } = repoConFunciones({ cliente_memoria: () => pgError("57014", "statement timeout") });
    await expect(repo.getCustomerMemory(ORG, "9991234567")).rejects.toMatchObject({ code: "57014" });
    // Aun asi el SAVEPOINT recupero la transaccion para el resto del turno.
    await sesionViva(session);
  });

  it("mapea la memoria real: cliente, domicilios (ultimo usado primero), pedidos, gustos y confiabilidad", async () => {
    const { repo } = repoConFunciones({
      cliente_memoria: () => [
        {
          r: {
            customer: { id: "c1", organization_id: ORG, phone: "9991234567", name: "Ana", order_count: 3 },
            addresses: [{ id: "a1", label: "casa", address: "Calle 1", is_default: true, access_notes: "porton", maps_url: null, colonia: "Centro", branch_slug: "centro", last_used_at: "2026-03-10T00:00:00Z", times_used: 4 }],
            orders: [{ id: "o1", order_number: 77, created_at: "2026-03-10T00:00:00Z", status: "entregado", total: 150, items: [{ id: "p", name: "Tacos", price: 75, quantity: 2 }], branch: "Centro", property_id: "pr1", payment_method: "tarjeta", canal: "domicilio", propina: 10, source: "whatsapp" }],
            preferences: [{ id: "g1", kind: "tortilla", value: "harina", source: "pedido", times_seen: 3, first_seen_at: "2026-01-01T00:00:00Z", last_seen_at: "2026-03-10T00:00:00Z", status: "activa" }, { id: "g2", kind: "inventada", value: "x", source: "pedido", times_seen: 1, first_seen_at: "", last_seen_at: "", status: "activa" }],
            confiabilidad: { no_recogidos_90d: 1, pedidos_falsos: 0, umbral: 2, ventana_dias: 90 },
            tier: "GOLD",
          },
        },
      ],
    });
    const mem = await repo.getCustomerMemory(ORG, "9991234567");
    expect(mem?.customer).toEqual({ id: "c1", organizationId: ORG, phone: "9991234567", name: "Ana", orderCount: 3 });
    expect(mem?.addresses[0]).toMatchObject({ id: "a1", label: "casa", isDefault: true, accessNotes: "porton", colonia: "Centro", branchSlug: "centro", timesUsed: 4 });
    expect(mem?.orders[0]).toMatchObject({ orderNumber: 77, total: 150, canal: "domicilio", propina: 10, paymentMethod: "tarjeta" });
    // Una categoria que este codigo no conoce se ignora en vez de romper la lectura.
    expect(mem?.preferences.map((p) => p.kind)).toEqual(["tortilla"]);
    expect(mem?.reliability).toEqual({ noRecogidos90d: 1, pedidosFalsos: 0, umbral: 2, ventanaDias: 90 });
    // El nivel llega calculado por la funcion de sistema (calc_customer_tier bajo RLS devolveria null).
    expect(mem?.tier).toBe("GOLD");
  });

  it("un cliente que no existe es null (cliente nuevo), no undefined (base sin migrar)", async () => {
    const { repo } = repoConFunciones({ cliente_memoria: () => [{ r: null }] });
    await expect(repo.getCustomerMemory(ORG, "9990000000")).resolves.toBeNull();
  });

  it("el cierre reporta si se aplico (idempotente: la segunda vez aplicado=false)", async () => {
    let llamadas = 0;
    const { repo } = repoConFunciones({ cliente_registrar_pedido: () => [{ r: { aplicado: ++llamadas === 1 } }] });
    const input = { organizationId: ORG, orderId: "o1", address: { address: "Calle 1" }, observations: [{ kind: "pago" as const, value: "efectivo" }] };
    await expect(repo.registerOrderClosure(input)).resolves.toEqual({ applied: true });
    await expect(repo.registerOrderClosure(input)).resolves.toEqual({ applied: false });
  });
});

describe("operaciones del staff contra la base sin la migracion 044", () => {
  it("la ficha lanza ClienteMemoriaNoDisponibleError (la ruta responde 503) y la transaccion sigue utilizable", async () => {
    const { session, repo } = repoConFunciones({ cliente_ficha: () => pgError("42883") });
    await expect(repo.getCustomerFicha(ORG, "c1")).rejects.toBeInstanceOf(ClienteMemoriaNoDisponibleError);
    await sesionViva(session);
  });

  it("guardar un domicilio sin la migracion tambien es 'no disponible', y un 42501 de la funcion (otro tenant) se propaga", async () => {
    const sin = repoConFunciones({ cliente_direccion_guardar: () => pgError("42883") });
    await expect(sin.repo.saveCustomerAddress(ORG, "c1", null, { address: "Calle 1" })).rejects.toBeInstanceOf(ClienteMemoriaNoDisponibleError);
    const ajeno = repoConFunciones({ cliente_direccion_guardar: () => pgError("42501", "cliente inexistente en la organizacion") });
    await expect(ajeno.repo.saveCustomerAddress(ORG, "c1", null, { address: "Calle 1" })).rejects.toMatchObject({ code: "42501" });
    await sesionViva(ajeno.session);
  });

  it("la politica sin la migracion es la de por omision (2 en 90 dias) y no se puede guardar", async () => {
    const { repo } = repoConFunciones({ cliente_politica_leer: () => pgError("42883"), cliente_politica_guardar: () => pgError("42883") });
    await expect(repo.getCustomerPolicy(ORG)).resolves.toEqual({ umbralNoRecogidos: 2, ventanaDias: 90 });
    await expect(repo.saveCustomerPolicy(ORG, { umbralNoRecogidos: 3, ventanaDias: 60 })).rejects.toBeInstanceOf(ClienteMemoriaNoDisponibleError);
  });
});
