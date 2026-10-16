// Maquina de estados del pedido: pruebas de intentos FUERA DE ORDEN. Afirman el efecto (no se creo
// un pedido real), no la implementacion.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { OrderFlowViolationError, QUOTE_TTL_MS, resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function setup(turnStart = 1) {
  const f = buildRestaurantFixture();
  let turn = turnStart;
  let nowMs = Date.now();
  const ctx = () => ({
    organizationId: f.organizationId,
    channel: "whatsapp" as const,
    phone: "9991234567",
    flow: { key: "wa:9991234567", turn: String(turn), now: () => nowMs },
  });
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
  const quote = (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { branch_slug: "fco-montejo", items, canal: "recoger", ...extra });
  const confirm = (args: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "confirmar_resumen", args);
  const create = (extra: Record<string, unknown> = {}) =>
    invokeAgentTool(f.repo, ctx(), "crear_pedido", { branch_slug: "fco-montejo", customer_name: "Ana", payment_method: "efectivo", canal: "recoger", items, ...extra });
  const ordersOf = async () => {
    const customer = await f.repo.findCustomerByPhone(f.organizationId, "9991234567");
    return customer ? (await f.repo.listEligibleOrderHistory(customer.id)).length : 0;
  };
  return { f, quote, confirm, create, ordersOf, nextTurn: () => void (turn += 1), advance: (ms: number) => void (nowMs += ms), items };
}

const rechazo = (code: string) => expect.objectContaining({ code });

describe("maquina de estados del pedido: intentos fuera de orden", () => {
  beforeEach(() => resetOrderFlowWarningForTests());

  it("crear_pedido sin cotizacion previa se rechaza y NO crea pedido", async () => {
    const s = setup();
    await expect(s.create()).rejects.toEqual(rechazo("sin_cotizacion"));
    expect(await s.ordersOf()).toBe(0);
  });

  it("crear_pedido con cotizacion pero SIN confirmacion explicita se rechaza", async () => {
    const s = setup();
    await s.quote();
    s.nextTurn();
    await expect(s.create()).rejects.toEqual(rechazo("sin_confirmacion"));
    expect(await s.ordersOf()).toBe(0);
  });

  it("cotizar y confirmar en el MISMO turno del cliente se rechaza (el cliente no pudo contestar)", async () => {
    const s = setup();
    await s.quote();
    await expect(s.confirm()).rejects.toEqual(rechazo("confirmacion_mismo_turno"));
    await expect(s.create()).rejects.toEqual(rechazo("sin_confirmacion"));
    expect(await s.ordersOf()).toBe(0);
  });

  it("confirmar sin cotizar se rechaza", async () => {
    const s = setup();
    await expect(s.confirm()).rejects.toEqual(rechazo("sin_cotizacion"));
  });

  it("camino feliz: cotizar -> (cliente contesta) -> confirmar -> crear crea UN pedido; repetir crear se rechaza", async () => {
    const s = setup();
    const quoted = await s.quote();
    expect((quoted.result as { quote_hash: string }).quote_hash).toMatch(/^[0-9a-f]{32}$/);
    s.nextTurn();
    await s.confirm({ quote_hash: quoted.quoteHash });
    const created = await s.create();
    expect(created.orderId).not.toBeNull();
    await expect(s.create()).rejects.toEqual(rechazo("pedido_ya_creado"));
    expect(await s.ordersOf()).toBe(1);
  });

  it("cambiar los productos DESPUES de confirmar obliga a re-cotizar (el pedido creado debe ser el confirmado)", async () => {
    const s = setup();
    await s.quote();
    s.nextTurn();
    await s.confirm();
    const otros = [{ product_id: s.f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 9 }];
    await expect(s.create({ items: otros })).rejects.toEqual(rechazo("pedido_distinto_al_cotizado"));
    await expect(s.create({ branch_slug: "otra", canal: "domicilio" })).rejects.toBeInstanceOf(OrderFlowViolationError);
    expect(await s.ordersOf()).toBe(0);
  });

  it("una cotizacion nueva invalida la confirmacion anterior", async () => {
    const s = setup();
    await s.quote();
    s.nextTurn();
    await s.confirm();
    await s.quote({ items: [{ product_id: s.f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 3 }] });
    await expect(s.create()).rejects.toBeInstanceOf(OrderFlowViolationError);
    expect(await s.ordersOf()).toBe(0);
  });

  it("citar un quote_hash que no es el de la ultima cotizacion se rechaza", async () => {
    const s = setup();
    await s.quote();
    s.nextTurn();
    await expect(s.confirm({ quote_hash: "0".repeat(32) })).rejects.toEqual(rechazo("hash_no_coincide"));
  });

  it("un quote_hash de relleno (N/A, vacio, texto) no es un hash: se ignora y la confirmacion procede (el modelo no recuerda el hash entre turnos)", async () => {
    for (const relleno of ["N/A", "", "pendiente", "abc123"]) {
      const s = setup();
      await s.quote();
      s.nextTurn();
      await expect(s.confirm({ quote_hash: relleno })).resolves.toBeDefined();
      const creado = await s.create();
      expect(creado.orderId).not.toBeNull();
    }
  });

  it("una cotizacion vencida (TTL) no permite confirmar ni crear", async () => {
    const s = setup();
    await s.quote();
    s.nextTurn();
    s.advance(QUOTE_TTL_MS + 1000);
    await expect(s.confirm()).rejects.toEqual(rechazo("cotizacion_vencida"));

    const t = setup();
    await t.quote();
    t.nextTurn();
    await t.confirm();
    t.advance(QUOTE_TTL_MS + 1000);
    await expect(t.create()).rejects.toEqual(rechazo("cotizacion_vencida"));
    expect(await t.ordersOf()).toBe(0);
  });

  it("dos crear_pedido concurrentes sobre la misma confirmacion crean UN solo pedido (reclamo atomico)", async () => {
    const s = setup();
    await s.quote();
    s.nextTurn();
    await s.confirm();
    const results = await Promise.allSettled([s.create(), s.create()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await s.ordersOf()).toBe(1);
  });

  it("un rechazo de negocio al crear (ej. producto inexistente) deja el estado en 'confirmado' para corregir", async () => {
    const s = setup();
    await s.quote();
    s.nextTurn();
    await s.confirm();
    await expect(s.create({ customer_name: "" })).rejects.not.toBeInstanceOf(OrderFlowViolationError);
    const created = await s.create();
    expect(created.orderId).not.toBeNull();
  });

  it("las conversaciones de distintos telefonos no comparten estado", async () => {
    const s = setup();
    await s.quote();
    s.nextTurn();
    await s.confirm();
    const otra = { organizationId: s.f.organizationId, channel: "whatsapp" as const, phone: "9990000000", flow: { key: "wa:9990000000", turn: "9" } };
    await expect(
      invokeAgentTool(s.f.repo, otra, "crear_pedido", { branch_slug: "fco-montejo", customer_name: "B", payment_method: "efectivo", canal: "recoger", items: s.items }),
    ).rejects.toEqual(rechazo("sin_cotizacion"));
  });

  it("base SIN migrar: la maquina se desactiva (camino anterior) con un aviso, sin romper el flujo que hoy funciona", async () => {
    const s = setup();
    s.f.repo.orderFlowUnavailable = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const created = await s.create();
    expect(created.orderId).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("order_flow_state"));
    warn.mockRestore();
  });
});

describe("PostgresRestaurantesRepository.readOrderFlow/writeOrderFlow contra la base sin migrar", () => {
  const sinFuncion = (name: string) => Object.assign(new Error(`function restaurantes.${name} does not exist`), { code: "42883" });

  it("lectura: 42883 degrada a null y la MISMA sesion sigue viva (SAVEPOINT, nunca 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /read_order_flow_state/, respond: () => sinFuncion("read_order_flow_state") },
      { match: /select 1 as siguiente/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    await expect(repo.readOrderFlow("org", "wa:1")).resolves.toBeNull();
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("escritura: 42P01 degrada a 'unavailable' y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /write_order_flow_state/, respond: () => Object.assign(new Error("relation does not exist"), { code: "42P01" }) },
      { match: /select 1 as siguiente/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    const res = await repo.writeOrderFlow("org", "wa:1", 0, { state: "cotizado", context: { quoteHash: "h", quotedAtMs: 1, quotedTurn: null } }, 60);
    expect(res).toBe("unavailable");
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("un error que NO es de compatibilidad se repropaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /read_order_flow_state/, respond: () => Object.assign(new Error("boom"), { code: "XX000" }) }]);
    await expect(new PostgresRestaurantesRepository(session).readOrderFlow("org", "wa:1")).rejects.toThrow("boom");
  });

  it("lectura normal: mapea estado, contexto y version", async () => {
    const session = new AbortAwareFakeSession([
      { match: /read_order_flow_state/, respond: () => [{ state: "confirmado", context: { quoteHash: "h", quotedAtMs: 1, quotedTurn: "1" }, version: "3" }] },
    ]);
    await expect(new PostgresRestaurantesRepository(session).readOrderFlow("org", "wa:1")).resolves.toEqual({
      state: "confirmado",
      context: { quoteHash: "h", quotedAtMs: 1, quotedTurn: "1" },
      version: 3,
    });
  });
});
