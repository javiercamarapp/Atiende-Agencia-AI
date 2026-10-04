// Modo preview del registro unico de tools: el dueno prueba al agente en el panel SIN efectos. Se afirma el EFECTO
// (cero escrituras de dominio, mismo total que el servidor), no la implementacion. Leccion X48 del original: el modo
// sale del contexto fijado por el servidor, nunca de los argumentos que escribe el modelo.
import { describe, expect, it } from "vitest";
import { FOLIO_PREVIEW_PREFIJO, esTelefonoPreview, invokeAgentTool, telefonoFicticioPreview, type AgentToolContext } from "../src/agent-tools/registry.ts";
import type { RestaurantesRepository } from "../src/repository.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

/** Envuelve el repositorio y cuenta CADA llamada a un metodo de escritura de dominio. Solo `writeOrderFlow` (la maquina
 * de estados por sesion, con TTL, que la preview comparte con el flujo real) queda fuera de la cuenta. */
function conContadorDeEscrituras(repo: RestaurantesRepository) {
  const escrituras: string[] = [];
  const escritura = /^(upsert|create|add|enqueue|insert|register|mark|set|update|delete|record|claim|acknowledge|complete|increment)/;
  const proxy = new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && typeof value === "function") {
        const bound = value.bind(target);
        if (escritura.test(prop) && prop !== "writeOrderFlow") {
          return (...args: unknown[]) => {
            escrituras.push(prop);
            return bound(...args);
          };
        }
        return bound;
      }
      return value;
    },
  });
  return { repo: proxy as RestaurantesRepository, escrituras };
}

function setup(extraCtx: Partial<AgentToolContext> = {}) {
  const f = buildRestaurantFixture();
  const contado = conContadorDeEscrituras(f.repo);
  const phone = telefonoFicticioPreview("sesion-1");
  let turn = 1;
  const ctx = (): AgentToolContext => ({
    organizationId: f.organizationId,
    channel: "whatsapp",
    phone,
    modo: "preview",
    flow: { key: `preview:sesion-1`, turn: String(turn) },
    ...extraCtx,
  });
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 3 }];
  const run = (name: string, args: Record<string, unknown>) => invokeAgentTool(contado.repo, ctx(), name, args);
  return { f, run, items, escrituras: contado.escrituras, nextTurn: () => void (turn += 1), phone };
}

async function pedidosYClientes(f: ReturnType<typeof buildRestaurantFixture>) {
  const page = await f.repo.listOrders(f.organizationId, { propertyIds: null, limit: 100 });
  const clientes = await f.repo.listCustomers(f.organizationId, { limit: 100 });
  return { pedidos: page.orders.length, clientes: clientes.customers.length, outbox: f.repo.getOutbox().length };
}

describe("modo preview del registro de tools", () => {
  it("cotizar -> confirmar -> crear deja cero filas en orders, customers, outbox y avisos, y devuelve un folio PRUEBA con el total del servidor", async () => {
    const s = setup();
    const antes = await pedidosYClientes(s.f);
    const base = { branch_slug: "fco-montejo", items: s.items, canal: "recoger" };
    const cot = await s.run("cotizar_pedido", base);
    const totalServidor = (cot.raw as { total: number }).total;
    s.nextTurn();
    await s.run("confirmar_resumen", {});
    s.nextTurn();
    const creado = await s.run("crear_pedido", { ...base, customer_name: "Dueno Prueba", payment_method: "efectivo" });

    expect(creado.simulated).toBe(true);
    expect(creado.orderId).toBeNull();
    const orden = (creado.result as { order: { id: string; total: number; status: string; items: unknown[] } }).order;
    expect(orden.id.startsWith(FOLIO_PREVIEW_PREFIJO)).toBe(true);
    expect(orden.status).toBe("simulado");
    expect(orden.total).toBe(totalServidor);
    expect(orden.items.length).toBeGreaterThan(0);

    expect(await pedidosYClientes(s.f)).toEqual(antes);
    expect(s.escrituras).toEqual([]);
    expect(await s.f.repo.findCustomerByPhone(s.f.organizationId, s.phone)).toBeNull();
  });

  it("la preview exige la misma maquina de estados: crear sin cotizar ni confirmar se rechaza", async () => {
    const s = setup();
    await expect(s.run("crear_pedido", { branch_slug: "fco-montejo", items: s.items, canal: "recoger", customer_name: "X", payment_method: "efectivo" })).rejects.toMatchObject({ code: "sin_cotizacion" });
  });

  it("un `modo` (o `modo_prueba`) que escriba el modelo en los argumentos se ignora: en modo real sigue creando, en preview sigue simulando", async () => {
    const real = setup({ modo: "real", phone: "9991234567" });
    const base = { branch_slug: "fco-montejo", items: real.items, canal: "recoger" };
    await real.run("cotizar_pedido", base);
    real.nextTurn();
    await real.run("confirmar_resumen", {});
    real.nextTurn();
    const creadoReal = await real.run("crear_pedido", { ...base, customer_name: "Ana", payment_method: "efectivo", modo: "preview", modo_prueba: true });
    expect(creadoReal.simulated).toBeUndefined();
    expect(creadoReal.orderId).not.toBeNull();
    expect((await pedidosYClientes(real.f)).pedidos).toBe(1);

    const prev = setup();
    const b2 = { branch_slug: "fco-montejo", items: prev.items, canal: "recoger" };
    await prev.run("cotizar_pedido", { ...b2, modo: "real" });
    prev.nextTurn();
    await prev.run("confirmar_resumen", { modo: "real" });
    prev.nextTurn();
    const creadoPrev = await prev.run("crear_pedido", { ...b2, customer_name: "Ana", payment_method: "efectivo", modo: "real", modo_prueba: false });
    expect(creadoPrev.simulated).toBe(true);
    expect((await pedidosYClientes(prev.f)).pedidos).toBe(0);
  });

  it("buscar_cliente responde cliente nuevo con el telefono ficticio, aunque el modelo mande otro telefono", async () => {
    const s = setup();
    await s.f.repo.upsertCustomer(s.f.organizationId, "9992222222", "Beto");
    const out = await s.run("buscar_cliente", { phone: "9992222222" });
    expect(out.result).toEqual({ isNew: true });
  });

  it("buscar_cliente con `previewCustomerId` resuelve el cliente conocido de la organizacion; uno de otra organizacion da cliente nuevo", async () => {
    const f = buildRestaurantFixture();
    const conocido = await f.repo.upsertCustomer(f.organizationId, "9992222222", "Beto");
    const otra = buildRestaurantFixture();
    const ajeno = await otra.repo.upsertCustomer(otra.organizationId, "9993333333", "Ajeno");
    const ctx = (id: string): AgentToolContext => ({ organizationId: f.organizationId, channel: "whatsapp", phone: telefonoFicticioPreview("s"), modo: "preview", previewCustomerId: id });
    const ok = await invokeAgentTool(f.repo, ctx(conocido.id), "buscar_cliente", {});
    expect((ok.result as { name?: string }).name).toBe("Beto");
    const cruzado = await invokeAgentTool(f.repo, ctx(ajeno.id), "buscar_cliente", {});
    expect(cruzado.result).toEqual({ isNew: true });
  });

  it("escalar_a_humano y registrar_contacto responden exito simulado sin crear aviso", async () => {
    const s = setup();
    const a = await s.run("escalar_a_humano", { customer_name: "Ana", motivo: "queja" });
    const b = await s.run("registrar_contacto", { customer_name: "Ana", reason: "duda" });
    expect(a.result).toMatchObject({ ok: true, simulado: true });
    expect(b.result).toMatchObject({ ok: true, simulado: true });
    expect(s.escrituras).toEqual([]);
  });

  it("el telefono ficticio cae en el rango reservado y es estable por sesion", () => {
    const t = telefonoFicticioPreview("abc");
    expect(esTelefonoPreview(t)).toBe(true);
    expect(telefonoFicticioPreview("abc")).toBe(t);
    expect(esTelefonoPreview("9991234567")).toBe(false);
  });
});
