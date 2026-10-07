// Relevo de herramientas de la llamada de PRUEBA (preview de voz): el navegador manda el toolCall de Gemini Live y el
// servidor corre el MISMO registro de tools en modo preview. Se afirma el EFECTO: token invalido => nada se ejecuta; token
// valido => resultado real de lectura/cotizacion y pedido SIMULADO sin ninguna escritura de dominio.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeVoiceProvider, InMemoryVozRepository, firmarPreviewToken } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const SECRETO = "test-voice-preview-token-secret";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

async function construir() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const voz = new InMemoryVozRepository();
  voz.seedProperty(ctx.propertyIdA, ctx.organizationId);
  voz.seedProperty(ctx.propertyIdB, ctx.organizationId);
  const categoryId = randomUUID();
  const productId = randomUUID();
  ctx.restaurantesRepo.seedCategory({ id: categoryId, organizationId: ctx.organizationId, name: "Bebidas" });
  ctx.restaurantesRepo.seedProduct({ id: productId, organizationId: ctx.organizationId, categoryId, name: "Coca-Cola", description: null, searchKeywords: [] });
  ctx.restaurantesRepo.seedBranchProduct({ propertyId: ctx.propertyIdA, productId, price: 45, isAvailable: true });
  const provider = new FakeVoiceProvider();
  const deps: AppDeps = { ...ctx.deps, vozRepo: () => voz, voiceProvider: provider, env: { ...ctx.deps.env, voicePreviewTokenSecret: SECRETO } };
  const app = envolver(buildApp(deps));
  const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/voz`;
  const sesion = async () => (await (await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.owner.token, {}))).json()) as { sesionId: string; tokenPreview: string };
  return { ctx, app, base, productId, sesion, provider, voz };
}

const llamar = (t: Awaited<ReturnType<typeof construir>>, sesionId: string, token: string, body: unknown, base = t.base) =>
  t.app.request(`${base}/preview/${sesionId}/herramienta`, authedJson(token, body));

describe("POST .../admin/voz/preview/:sesionId/herramienta", () => {
  it("cotizar -> confirmar -> crear: devuelve el total real y un pedido PRUEBA, y NO deja pedidos, clientes ni avisos", async () => {
    const t = await construir();
    const { sesionId, tokenPreview } = await t.sesion();
    const owner = t.ctx.staff.owner.token;
    const args = { branch_slug: "fco-montejo", items: [{ product_id: t.productId, product_name: "Coca-Cola", requested_quantity: 2 }], canal: "recoger" };

    const cot = await llamar(t, sesionId, owner, { tokenPreview, nombre: "cotizar_pedido", argumentos: args });
    expect(cot.status).toBe(200);
    const cotBody = await cot.json();
    expect(cotBody.resultado.quote.total).toBe(90);
    expect(cotBody.resultado.quote_hash).toBeTruthy();
    expect((await llamar(t, sesionId, owner, { tokenPreview, nombre: "confirmar_resumen", argumentos: {} })).status).toBe(200);
    const creado = await (await llamar(t, sesionId, owner, { tokenPreview, nombre: "crear_pedido", argumentos: { ...args, customer_name: "Dueno", payment_method: "efectivo" } })).json();

    expect(creado.simulado).toBe(true);
    expect(creado.resultado.order.id.startsWith("PRUEBA-")).toBe(true);
    expect(creado.resultado.order.total).toBe(90);
    const pedidos = await t.ctx.restaurantesRepo.listOrders(t.ctx.organizationId, { propertyIds: null, limit: 50 });
    expect(pedidos.orders).toHaveLength(0);
    expect((await t.ctx.restaurantesRepo.listCustomers(t.ctx.organizationId, { limit: 50 })).customers).toHaveLength(0);
    expect(t.ctx.restaurantesRepo.getOutbox()).toHaveLength(0);
  });

  it("crear_pedido sin cotizar se rechaza como error de negocio dentro del resultado (la llamada no se cae)", async () => {
    const t = await construir();
    const { sesionId, tokenPreview } = await t.sesion();
    const args = { branch_slug: "fco-montejo", items: [{ product_id: t.productId, product_name: "Coca-Cola", requested_quantity: 1 }], canal: "recoger", customer_name: "X", payment_method: "efectivo" };
    const res = await llamar(t, sesionId, t.ctx.staff.owner.token, { tokenPreview, nombre: "crear_pedido", argumentos: args });
    expect(res.status).toBe(200);
    expect((await res.json()).resultado.error).toBeTruthy();
  });

  it("un `modo` en el cuerpo o en los argumentos no desactiva la preview", async () => {
    const t = await construir();
    const { sesionId, tokenPreview } = await t.sesion();
    const args = { branch_slug: "fco-montejo", items: [{ product_id: t.productId, product_name: "Coca-Cola", requested_quantity: 1 }], canal: "recoger", modo: "real" };
    await llamar(t, sesionId, t.ctx.staff.owner.token, { tokenPreview, modo: "real", nombre: "cotizar_pedido", argumentos: args });
    await llamar(t, sesionId, t.ctx.staff.owner.token, { tokenPreview, nombre: "confirmar_resumen", argumentos: {} });
    const creado = await (await llamar(t, sesionId, t.ctx.staff.owner.token, { tokenPreview, nombre: "crear_pedido", argumentos: { ...args, customer_name: "X", payment_method: "efectivo" } })).json();
    expect(creado.simulado).toBe(true);
    expect((await t.ctx.restaurantesRepo.listOrders(t.ctx.organizationId, { propertyIds: null, limit: 50 })).orders).toHaveLength(0);
  });

  it("token vencido o alterado -> 401; token de OTRA sesion -> 403; token de otra sucursal -> 403; sin token -> 401", async () => {
    const t = await construir();
    const { sesionId, tokenPreview } = await t.sesion();
    const owner = t.ctx.staff.owner.token;
    const body = (token: unknown) => ({ tokenPreview: token, nombre: "buscar_cliente", argumentos: {} });

    const vencido = firmarPreviewToken(SECRETO, { sessionId: sesionId, organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, voiceId: "Kore", proveedor: "gemini-3.8-live" }, new Date(Date.now() - 3_600_000), 60).token;
    expect((await llamar(t, sesionId, owner, body(vencido))).status).toBe(401);
    expect((await llamar(t, sesionId, owner, body(`${tokenPreview}x`))).status).toBe(401);
    expect((await llamar(t, sesionId, owner, body(undefined))).status).toBe(401);

    const otraSesion = firmarPreviewToken(SECRETO, { sessionId: randomUUID(), organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, voiceId: "Kore", proveedor: "gemini-3.8-live" }, new Date(), 60).token;
    expect((await llamar(t, sesionId, owner, body(otraSesion))).status).toBe(403);

    const otraSucursal = firmarPreviewToken(SECRETO, { sessionId: sesionId, organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdB, voiceId: "Kore", proveedor: "gemini-3.8-live" }, new Date(), 60).token;
    expect((await llamar(t, sesionId, owner, body(otraSucursal))).status).toBe(403);
    // Un token firmado con otro secreto nunca valida.
    const otroSecreto = firmarPreviewToken("otro-secreto-de-preview-distinto", { sessionId: sesionId, organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, voiceId: "Kore", proveedor: "gemini-3.8-live" }, new Date(), 60).token;
    expect((await llamar(t, sesionId, owner, body(otroSecreto))).status).toBe(401);
  });

  it("roles y organizacion: staff/repartidor -> 403, owner de otra organizacion -> 403, sin sesion -> 401; herramienta desconocida -> 400", async () => {
    const t = await construir();
    const { sesionId, tokenPreview } = await t.sesion();
    const cuerpo = { tokenPreview, nombre: "buscar_cliente", argumentos: {} };
    for (const token of [t.ctx.staff.staffSucursalA.token, t.ctx.staff.repartidor.token, t.ctx.staff.otroOrgOwner.token]) {
      expect((await llamar(t, sesionId, token, cuerpo)).status).toBe(403);
    }
    expect((await t.app.request(`${t.base}/preview/${sesionId}/herramienta`, { method: "POST", body: JSON.stringify(cuerpo) })).status).toBe(401);
    expect((await llamar(t, sesionId, t.ctx.staff.owner.token, { tokenPreview, nombre: "borrar_todo", argumentos: {} })).status).toBe(400);
    expect((await llamar(t, "no-es-uuid", t.ctx.staff.owner.token, cuerpo)).status).toBe(404);
  });

  it("buscar_cliente en preview responde cliente nuevo aunque exista el telefono real", async () => {
    const t = await construir();
    await t.ctx.restaurantesRepo.upsertCustomer(t.ctx.organizationId, "9992222222", "Beto");
    const { sesionId, tokenPreview } = await t.sesion();
    const r = await (await llamar(t, sesionId, t.ctx.staff.owner.token, { tokenPreview, nombre: "buscar_cliente", argumentos: { phone: "9992222222" } })).json();
    expect(r.resultado).toEqual({ isNew: true });
  });
});

describe("POST .../admin/voz/preview/sesion: herramientas y saludo", () => {
  it("el token del proveedor fija las herramientas del registro de voz (sin telefono) y resuelve {saludo} con la hora local de la sucursal", async () => {
    const t = await construir();
    await t.voz.upsertConfig(t.ctx.organizationId, t.ctx.propertyIdA, { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "{saludo}, le atiende Los Taquitos de PM." });
    await t.sesion();
    const emitida = t.provider.emitidas.at(-1)!;
    expect(emitida.herramientas?.map((h) => h.name)).toEqual(expect.arrayContaining(["buscar_producto", "cotizar_pedido", "confirmar_resumen", "crear_pedido"]));
    // Excepcion documentada: `telefono_alterno` de crear_pedido solo se escribe en la comanda de ese pedido (ver agent-tools-registry.spec.ts).
    for (const h of emitida.herramientas ?? []) expect(Object.keys(h.parameters.properties).filter((k) => !(h.name === "crear_pedido" && k === "telefono_alterno")).join(",")).not.toMatch(/phone|telefono|modo/i);
    expect(emitida.mensajeInicial).toMatch(/^(Buenos días|Buenas tardes|Buenas noches), le atiende Los Taquitos de PM\.$/);
    expect(emitida.mensajeInicial).not.toContain("{saludo}");
  });
});
