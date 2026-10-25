// Herramienta del agente `solicitar_agregado_pedido` (WhatsApp y voz): crea la solicitud que la sucursal acepta o rechaza, NUNCA confirma el agregado ni da minutos, dice la frase
// aprobada, cae a la escalada de siempre sin el hook o con la base sin migrar, y no agrega a un pedido que ya salio. Determinista, sin LLM.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { describe, expect, it } from "vitest";
import { InMemoryAgregadosRepository, crearHookAgregados } from "../src/agregados/index.ts";
import { MENSAJE_AGREGADO_PEDIDO_YA_SALIO, MENSAJE_CAMBIO_PEDIDO_ENVIADO, VOICE_TOOL_HTTP_PATHS, executeAgentToolSafely, toolDefinitionsForChannel } from "../src/agent-tools/registry.ts";
import type { AgentToolContext } from "../src/agent-tools/registry.ts";
import { createOrder } from "../src/orders.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

class SesionFalsa implements TenantDbSession {
  async query<T>(): Promise<{ rows: T[] }> {
    return { rows: [{ emit_notification: 1 } as T] };
  }
  async exec(): Promise<void> {}
}

const TEL = "9990001111";

async function montar(opts: { sinHook?: boolean; status?: "pending" | "preparando" | "en_camino" | "entregado" } = {}) {
  const fixture = buildRestaurantFixture();
  const propertyId = (await fixture.repo.findBranch(fixture.organizationId, { slug: "fco-montejo" }))!.propertyId;
  const agregados = new InMemoryAgregadosRepository();
  const creado = await createOrder(fixture.repo, {
    organizationId: fixture.organizationId, branchSlug: "fco-montejo", customerName: "Ana", customerPhone: TEL, customerAddress: "Calle 80 #30",
    items: [{ productId: fixture.products.cocaCola, requestedQuantity: 2 }], source: "whatsapp", paymentMethod: "efectivo",
  });
  const status = opts.status ?? "preparando";
  const order = status === "pending" ? creado : ((await fixture.repo.updateOrderStatus(creado.organizationId, creado.id, "pending", status)) ?? creado);
  agregados.sembrarPedido({
    id: order.id, organizationId: order.organizationId, propertyId: order.propertyId, sucursal: order.branch, orderNumber: 150, status, items: [...order.items], total: order.total,
    customerName: "Ana", customerPhone: TEL, createdAt: order.createdAt,
  });
  const db = new SesionFalsa();
  const hook = crearHookAgregados({ agregados, repo: fixture.repo, db });
  const ctx = (extra: Partial<AgentToolContext> = {}): AgentToolContext => ({
    organizationId: fixture.organizationId, channel: "whatsapp", phone: TEL, entryPropertyId: propertyId, sourceEventId: "wamid-1", ...(opts.sinHook ? {} : { agregados: hook }), ...extra,
  });
  const coca = (n = 2) => ({ items: [{ product_id: fixture.products.cocaCola, product_name: "Coca-Cola", requested_quantity: n }] });
  return { fixture, agregados, order, ctx, coca, propertyId };
}

describe("solicitar_agregado_pedido: definicion", () => {
  it("existe en WhatsApp y en voz, con ruta HTTP propia", () => {
    for (const canal of ["whatsapp", "voz"] as const) expect(toolDefinitionsForChannel(canal).map((t) => t.name)).toContain("solicitar_agregado_pedido");
    expect(VOICE_TOOL_HTTP_PATHS.solicitar_agregado_pedido).toBe("/orders/amendment");
  });
  it("no recibe id de pedido ni telefono del modelo (el pedido sale del telefono del contexto)", () => {
    const def = toolDefinitionsForChannel("whatsapp").find((t) => t.name === "solicitar_agregado_pedido")!;
    expect(Object.keys(def.parameters.properties)).not.toEqual(expect.arrayContaining(["order_id"]));
    expect(JSON.stringify(def.parameters)).not.toMatch(/phone|telefono|order_id/);
  });
});

describe("solicitar_agregado_pedido: crea la solicitud, nunca confirma", () => {
  it("WhatsApp: crea UNA solicitud pendiente con precios del catalogo, devuelve la frase aprobada y ninguna cifra de minutos", async () => {
    const t = await montar();
    const r = await executeAgentToolSafely(t.fixture.repo, t.ctx(), "solicitar_agregado_pedido", t.coca(2));
    expect(r.result).toMatchObject({ ok: true, estado: "pendiente_de_validar", mensaje_al_cliente: MENSAJE_CAMBIO_PEDIDO_ENVIADO, total_del_agregado: 90 });
    expect(JSON.stringify(r.result)).not.toMatch(/\b\d+\s*min/i);
    const lista = (await t.agregados.listar(t.fixture.organizationId, { propertyIds: null, limite: 10 })).valor;
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ estado: "pendiente", channel: "whatsapp", totalAdded: 90, totalAfter: t.order.total + 90 });
    // El pedido NO cambia hasta que una persona acepte.
    expect(t.agregados.pedidos.get(t.order.id)?.total).toBe(t.order.total);
    // Y no deja un aviso suelto de escalada: la solicitud ES el aviso.
    expect(t.fixture.repo.listCallbackRequests(t.fixture.organizationId)).toHaveLength(0);
  });

  it("voz: misma solicitud, canal voice, misma frase", async () => {
    const t = await montar();
    const r = await executeAgentToolSafely(t.fixture.repo, t.ctx({ channel: "voz", sourceEventId: "call:abc" }), "solicitar_agregado_pedido", t.coca(1));
    expect(r.result).toMatchObject({ ok: true, mensaje_al_cliente: MENSAJE_CAMBIO_PEDIDO_ENVIADO });
    expect((await t.agregados.listar(t.fixture.organizationId, { propertyIds: null, limite: 10 })).valor[0]).toMatchObject({ channel: "voice" });
  });

  it("pedir mas FUSIONA en la misma solicitud; el mismo evento no suma dos veces", async () => {
    const t = await montar();
    await executeAgentToolSafely(t.fixture.repo, t.ctx({ sourceEventId: "wamid-1" }), "solicitar_agregado_pedido", t.coca(1));
    await executeAgentToolSafely(t.fixture.repo, t.ctx({ sourceEventId: "wamid-1" }), "solicitar_agregado_pedido", t.coca(1)); // reintento del mismo mensaje
    const f = await executeAgentToolSafely(t.fixture.repo, t.ctx({ sourceEventId: "wamid-2" }), "solicitar_agregado_pedido", t.coca(2));
    expect(f.result).toMatchObject({ ok: true, solicitud: "fusionado", total_del_agregado: 135 });
    const lista = (await t.agregados.listar(t.fixture.organizationId, { propertyIds: null, limite: 10 })).valor;
    expect(lista).toHaveLength(1);
    expect(lista[0]!.itemsAdded[0]!.quantity).toBe(3);
  });

  it("el cliente se arrepiente: cancelar_pendiente retira la solicitud abierta", async () => {
    const t = await montar();
    await executeAgentToolSafely(t.fixture.repo, t.ctx(), "solicitar_agregado_pedido", t.coca(1));
    const r = await executeAgentToolSafely(t.fixture.repo, t.ctx({ sourceEventId: "wamid-3" }), "solicitar_agregado_pedido", { cancelar_pendiente: true });
    expect(r.result).toMatchObject({ ok: true, estado: "cancelado_por_cliente" });
    expect((await t.agregados.listar(t.fixture.organizationId, { propertyIds: null, limite: 10 })).valor[0]!.estado).toBe("cancelado_por_cliente");
    const otra = await executeAgentToolSafely(t.fixture.repo, t.ctx({ sourceEventId: "wamid-4" }), "solicitar_agregado_pedido", { cancelar_pendiente: true });
    expect(otra.result).toMatchObject({ ok: false });
  });
});

describe("solicitar_agregado_pedido: casos en que NO se crea", () => {
  it("pedido que ya salio o se entrego: ok:false con la frase de pedido aparte, sin solicitud ni escalada", async () => {
    for (const status of ["en_camino", "entregado"] as const) {
      const t = await montar({ status });
      const r = await executeAgentToolSafely(t.fixture.repo, t.ctx(), "solicitar_agregado_pedido", t.coca());
      expect(r.result).toMatchObject({ ok: false, motivo: "pedido_ya_salio", mensaje_al_cliente: MENSAJE_AGREGADO_PEDIDO_YA_SALIO });
      expect((await t.agregados.listar(t.fixture.organizationId, { propertyIds: null, limite: 10 })).valor).toHaveLength(0);
      expect(t.fixture.repo.listCallbackRequests(t.fixture.organizationId)).toHaveLength(0);
    }
  });

  it("sin pedido reciente de ese telefono: ok:false con la instruccion de tomarlo como pedido nuevo", async () => {
    const t = await montar();
    const r = await executeAgentToolSafely(t.fixture.repo, t.ctx({ phone: "9998887766" }), "solicitar_agregado_pedido", t.coca());
    expect(r.result).toMatchObject({ ok: false, motivo: "sin_pedido_registrado" });
  });

  it("sin productos: error de regla (el agente debe buscar los productos antes)", async () => {
    const t = await montar();
    const r = await executeAgentToolSafely(t.fixture.repo, t.ctx(), "solicitar_agregado_pedido", { items: [] });
    expect(JSON.stringify(r.result)).toMatch(/error/);
  });

  it("telefono dictado sin verificar: no se agrega a un pedido que quiza no es suyo", async () => {
    const t = await montar();
    const r = await executeAgentToolSafely(t.fixture.repo, t.ctx({ phoneDeclared: true }), "solicitar_agregado_pedido", t.coca());
    expect(JSON.stringify(r.result)).toMatch(/error/);
    expect((await t.agregados.listar(t.fixture.organizationId, { propertyIds: null, limite: 10 })).valor).toHaveLength(0);
  });

  it("vista previa del dueno: exito simulado, nada se escribe", async () => {
    const t = await montar();
    const r = await executeAgentToolSafely(t.fixture.repo, t.ctx({ modo: "preview" }), "solicitar_agregado_pedido", t.coca());
    expect(r).toMatchObject({ simulated: true, result: { ok: true, simulado: true } });
    expect((await t.agregados.listar(t.fixture.organizationId, { propertyIds: null, limite: 10 })).valor).toHaveLength(0);
  });
});

describe("solicitar_agregado_pedido: degradacion honesta (el aviso a la sucursal nunca se pierde)", () => {
  for (const [titulo, montarFallo] of [
    ["sin el hook cableado", async () => montar({ sinHook: true })],
    [
      "con la base sin la migracion 099",
      async () => {
        const t = await montar();
        t.agregados.disponible = false;
        return t;
      },
    ],
  ] as const) {
    it(`${titulo}: cae a la escalada de siempre (cancelacion_modificacion) con la frase aprobada`, async () => {
      const t = await montarFallo();
      const r = await executeAgentToolSafely(t.fixture.repo, t.ctx(), "solicitar_agregado_pedido", t.coca(2));
      expect(r.result).toMatchObject({ ok: true });
      expect(JSON.stringify(r.result)).toContain("Lo paso ahorita a la sucursal");
      const cbs = t.fixture.repo.listCallbackRequests(t.fixture.organizationId);
      expect(cbs).toHaveLength(1);
      expect(cbs[0]).toMatchObject({ reason: "escalada:cancelacion_modificacion" });
      expect(cbs[0]!.message).toContain("2 Coca-Cola");
    });
  }
});
