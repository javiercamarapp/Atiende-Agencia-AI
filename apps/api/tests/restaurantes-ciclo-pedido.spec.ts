// F4b -- HTTP de admin-ciclo-pedido.ts: aceptar/rechazar con tiempo prometido y motivo, salida y entrega con hora real, ratios, y la configuracion de
// encuesta y recordatorios. Contra el repositorio en memoria (los SQLSTATE de las funciones 170 a 172 los cubre la verificacion contra Postgres real).
import { describe, expect, it } from "vitest";
import { InMemoryCicloPedidoRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

async function montar(opciones: { sinRepo?: boolean } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  ctx.restaurantesRepo.seedWhatsAppChannel(ctx.organizationId, "PHONE_NUMBER_ID_123");
  const ciclo = new InMemoryCicloPedidoRepository(ctx.restaurantesRepo);
  const deps = opciones.sinRepo ? ctx.deps : { ...ctx.deps, cicloPedidoRepo: () => ciclo };
  const app = buildApp(deps);
  const ruta = (propertyId: string, resto: string) => `/v1/restaurantes/${propertyId}/admin/ciclo/${resto}`;
  const pedido = (status: "pending" | "preparando" | "en_camino" = "pending", over: Record<string, unknown> = {}) => {
    const o = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status, customerPhone: "9990001111", customerName: "Ana", total: 250, ...over });
    ctx.restaurantesRepo.seedOrder(o);
    return o;
  };
  return { ctx, ciclo, app, ruta, pedido };
}

describe("POST admin/ciclo/pedidos/:orderId/aceptar", () => {
  it("el dueno acepta con tiempo prometido editable: pasa a preparando y el cliente recibe el aviso con el tiempo", async () => {
    const { ctx, app, ruta, pedido } = await montar();
    const o = pedido();
    const res = await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/aceptar`), authedJson(ctx.staff.owner.token, { tiempoPrometidoMin: 50 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resultado: "aceptado", tiempoPrometidoMin: 50, aviso: { encolado: true } });
    expect((await ctx.restaurantesRepo.findOrderById(ctx.organizationId, o.id))?.status).toBe("preparando");
    const aviso = ctx.restaurantesRepo.getOutbox().find((x) => x.eventType === "order.status.preparando")!;
    expect((aviso.payload as { body: string }).body).toContain("50 minutos");
  });

  it("el staff (cajero o encargado con alcance) tambien acepta; sin cuerpo usa 45 min de domicilio", async () => {
    const { ctx, app, ruta, pedido } = await montar();
    const o = pedido();
    const res = await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/aceptar`), authedJson(ctx.staff.staffSucursalA.token, {}));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tiempoPrometidoMin: number }).tiempoPrometidoMin).toBe(45);
  });

  it("tiempo fuera de rango -> 400; repartidor -> 403; staff de otra organizacion -> 403; sin sesion -> 401", async () => {
    const { ctx, app, ruta, pedido } = await montar();
    const o = pedido();
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/aceptar`), authedJson(ctx.staff.owner.token, { tiempoPrometidoMin: 3 }))).status).toBe(400);
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/aceptar`), authedJson(ctx.staff.owner.token, { tiempoPrometidoMin: "30" }))).status).toBe(400);
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/aceptar`), authedJson(ctx.staff.repartidor.token, {}))).status).toBe(403);
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/aceptar`), authedJson(ctx.staff.otroOrgOwner.token, {}))).status).toBe(403);
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/aceptar`), { method: "POST" })).status).toBe(401);
    expect((await ctx.restaurantesRepo.findOrderById(ctx.organizationId, o.id))?.status).toBe("pending");
  });

  it("un pedido de otra sucursal o inexistente es 404; ya preparando es 409", async () => {
    const { ctx, app, ruta, pedido } = await montar();
    const deB = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdB, status: "pending" });
    ctx.restaurantesRepo.seedOrder(deB);
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${deB.id}/aceptar`), authedJson(ctx.staff.owner.token, {}))).status).toBe(404);
    expect((await app.request(ruta(ctx.propertyIdA, "pedidos/00000000-0000-4000-8000-000000000001/aceptar"), authedJson(ctx.staff.owner.token, {}))).status).toBe(404);
    expect((await app.request(ruta(ctx.propertyIdA, "pedidos/no-es-uuid/aceptar"), authedJson(ctx.staff.owner.token, {}))).status).toBe(400);
    const ya = pedido("preparando");
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${ya.id}/aceptar`), authedJson(ctx.staff.owner.token, {}))).status).toBe(409);
  });

  it("sin el repositorio del ciclo en el despliegue -> 503 honesto; base sin migrar -> 503", async () => {
    const sin = await montar({ sinRepo: true });
    const o = sin.pedido();
    expect((await sin.app.request(sin.ruta(sin.ctx.propertyIdA, `pedidos/${o.id}/aceptar`), authedJson(sin.ctx.staff.owner.token, {}))).status).toBe(503);
    const m = await montar();
    m.ciclo.migrado = false;
    const p = m.pedido();
    const res = await m.app.request(m.ruta(m.ctx.propertyIdA, `pedidos/${p.id}/aceptar`), authedJson(m.ctx.staff.owner.token, {}));
    expect(res.status).toBe(503);
    expect((await m.ctx.restaurantesRepo.findOrderById(m.ctx.organizationId, p.id))?.status).toBe("pending");
  });
});

describe("POST admin/ciclo/pedidos/:orderId/rechazar", () => {
  it("rechaza con motivo de lista cerrada, cancela y avisa al cliente SIN la nota interna", async () => {
    const { ctx, app, ruta, pedido } = await montar();
    const o = pedido();
    const res = await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/rechazar`), authedJson(ctx.staff.owner.token, { motivo: "saturado", nota: "hay 14 comandas, avisar al encargado" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resultado: "rechazado", motivo: "saturado", aviso: { encolado: true } });
    expect((await ctx.restaurantesRepo.findOrderById(ctx.organizationId, o.id))?.status).toBe("cancelado");
    const aviso = ctx.restaurantesRepo.getOutbox().find((x) => x.eventType === "order.status.cancelado")!;
    expect(JSON.stringify(aviso.payload)).not.toContain("14 comandas");
  });

  it("motivo ausente o fuera de la lista -> 400; nota > 240 -> 400; repartidor -> 403", async () => {
    const { ctx, app, ruta, pedido } = await montar();
    const o = pedido();
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/rechazar`), authedJson(ctx.staff.owner.token, {}))).status).toBe(400);
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/rechazar`), authedJson(ctx.staff.owner.token, { motivo: "porque_si" }))).status).toBe(400);
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/rechazar`), authedJson(ctx.staff.owner.token, { motivo: "otro", nota: "x".repeat(241) }))).status).toBe(400);
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/rechazar`), authedJson(ctx.staff.repartidor.token, { motivo: "otro" }))).status).toBe(403);
    expect((await ctx.restaurantesRepo.findOrderById(ctx.organizationId, o.id))?.status).toBe("pending");
  });
});

describe("salida con repartidor y entrega con hora real", () => {
  it("acepta -> sale con el chofer -> entrega con la hora real; los ratios reflejan real vs prometido", async () => {
    const { ctx, app, ruta, pedido, ciclo } = await montar();
    const o = pedido();
    // La aceptacion y la salida ocurrieron hace 40 min; la entrega, hace 5 (35 min reales de 45 prometidos).
    ciclo.ahora = () => new Date(Date.now() - 40 * 60_000);
    await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/aceptar`), authedJson(ctx.staff.owner.token, { tiempoPrometidoMin: 45 }));
    const salida = await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/salida`), authedJson(ctx.staff.owner.token, { repartidorId: ctx.staff.repartidor.id, etaMin: 30 }));
    expect(salida.status).toBe(200);
    expect(await salida.json()).toMatchObject({ resultado: "despachado", repartidorId: ctx.staff.repartidor.id, horaRealRegistrada: true });
    expect((await ctx.restaurantesRepo.findOrderById(ctx.organizationId, o.id))?.status).toBe("en_camino");

    ciclo.ahora = () => new Date();
    const hace5 = new Date(Date.now() - 5 * 60_000).toISOString();
    const entrega = await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/entrega`), authedJson(ctx.staff.owner.token, { ocurrioEn: hace5 }));
    expect(entrega.status).toBe(200);
    expect(await entrega.json()).toMatchObject({ resultado: "entregado", entregadoAt: hace5 });
    expect(ciclo.camposDe(o.id).entregadoAt?.toISOString()).toBe(hace5);

    const ratios = await app.request(ruta(ctx.propertyIdA, "ratios"), authedGet(ctx.staff.owner.token));
    expect(ratios.status).toBe(200);
    const cuerpo = (await ratios.json()) as { disponible: boolean; ratios: { tasaAceptacionPct: number; cumplimientoPromesaPct: number | null } };
    expect(cuerpo.disponible).toBe(true);
    expect(cuerpo.ratios.tasaAceptacionPct).toBe(100);
    expect(cuerpo.ratios.cumplimientoPromesaPct).toBe(100);
  });

  it("un repartidor que no es de la organizacion -> 400; etaMin fuera de rango -> 400; hora futura -> 400; sin permiso -> 403", async () => {
    const { ctx, app, ruta, pedido } = await montar();
    const o = pedido("preparando");
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/salida`), authedJson(ctx.staff.owner.token, { repartidorId: "00000000-0000-4000-8000-0000000000aa" }))).status).toBe(400);
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/salida`), authedJson(ctx.staff.owner.token, { repartidorId: ctx.staff.repartidor.id, etaMin: 2 }))).status).toBe(400);
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${o.id}/salida`), authedJson(ctx.staff.repartidor.token, { repartidorId: ctx.staff.repartidor.id }))).status).toBe(403);
    const enCamino = pedido("en_camino", { assignedRepartidorId: ctx.staff.repartidor.id });
    const futura = new Date(Date.now() + 3_600_000).toISOString();
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${enCamino.id}/entrega`), authedJson(ctx.staff.owner.token, { ocurrioEn: futura }))).status).toBe(400);
    expect((await app.request(ruta(ctx.propertyIdA, `pedidos/${enCamino.id}/entrega`), authedJson(ctx.staff.owner.token, { ocurrioEn: "ayer" }))).status).toBe(400);
  });

  it("ratios: rango invalido o mayor a 63 dias -> 400; base sin migrar -> disponible false", async () => {
    const { ctx, app, ruta, ciclo } = await montar();
    expect((await app.request(ruta(ctx.propertyIdA, "ratios?desde=2026-10-10T00:00:00Z&hasta=2026-10-01T00:00:00Z"), authedGet(ctx.staff.owner.token))).status).toBe(400);
    expect((await app.request(ruta(ctx.propertyIdA, "ratios?desde=2026-01-01T00:00:00Z&hasta=2026-10-01T00:00:00Z"), authedGet(ctx.staff.owner.token))).status).toBe(400);
    ciclo.migrado = false;
    const res = await app.request(ruta(ctx.propertyIdA, "ratios"), authedGet(ctx.staff.owner.token));
    expect(await res.json()).toMatchObject({ disponible: false, ratios: null });
  });
});

describe("configuracion de encuesta y de recordatorios", () => {
  it("la encuesta viene APAGADA por omision; solo el dueno/admin la enciende; no acepta enlace de resena", async () => {
    const { ctx, app, ruta } = await montar();
    const antes = await app.request(ruta(ctx.propertyIdA, "encuesta/config"), authedGet(ctx.staff.owner.token));
    expect(await antes.json()).toEqual({ disponible: true, habilitada: false });
    expect((await app.request(ruta(ctx.propertyIdA, "encuesta/config"), authedJson(ctx.staff.staffSucursalA.token, { habilitada: true }, "PUT"))).status).toBe(403);
    expect((await app.request(ruta(ctx.propertyIdA, "encuesta/config"), authedJson(ctx.staff.owner.token, { habilitada: true, linkResena: "https://g.page/r/ejemplo/review" }, "PUT"))).status).toBe(400); // ya no hay enlace de resena
    expect((await app.request(ruta(ctx.propertyIdA, "encuesta/config"), authedJson(ctx.staff.owner.token, { habilitada: "si" }, "PUT"))).status).toBe(400);
    const ok = await app.request(ruta(ctx.propertyIdA, "encuesta/config"), authedJson(ctx.staff.owner.token, { habilitada: true }, "PUT"));
    expect(ok.status).toBe(200);
    const despues = await app.request(ruta(ctx.propertyIdA, "encuesta/config"), authedGet(ctx.staff.staffSucursalA.token));
    expect(await despues.json()).toEqual({ disponible: true, habilitada: true });
  });

  it("recordatorios: valores por omision 10/10/3; PUT valida rangos y solo owner/admin", async () => {
    const { ctx, app, ruta } = await montar();
    const antes = await app.request(ruta(ctx.propertyIdA, "recordatorios/config"), authedGet(ctx.staff.owner.token));
    expect(await antes.json()).toEqual({ disponible: true, habilitado: true, primeroMin: 10, repetirMin: 10, maximo: 3 });
    const cuerpo = { habilitado: true, primeroMin: 5, repetirMin: 5, maximo: 2 };
    expect((await app.request(ruta(ctx.propertyIdA, "recordatorios/config"), authedJson(ctx.staff.staffSucursalA.token, cuerpo, "PUT"))).status).toBe(403);
    expect((await app.request(ruta(ctx.propertyIdA, "recordatorios/config"), authedJson(ctx.staff.owner.token, { ...cuerpo, primeroMin: 2 }, "PUT"))).status).toBe(400);
    expect((await app.request(ruta(ctx.propertyIdA, "recordatorios/config"), authedJson(ctx.staff.owner.token, { ...cuerpo, maximo: 7 }, "PUT"))).status).toBe(400);
    expect((await app.request(ruta(ctx.propertyIdA, "recordatorios/config"), authedJson(ctx.staff.owner.token, cuerpo, "PUT"))).status).toBe(200);
    expect(await (await app.request(ruta(ctx.propertyIdA, "recordatorios/config"), authedGet(ctx.staff.owner.token))).json()).toEqual({ disponible: true, ...cuerpo });
  });

  it("el staff de otra organizacion no lee ni escribe la configuracion", async () => {
    const { ctx, app, ruta } = await montar();
    expect((await app.request(ruta(ctx.propertyIdA, "encuesta/config"), authedGet(ctx.staff.otroOrgOwner.token))).status).toBe(403);
    expect((await app.request(ruta(ctx.propertyIdA, "recordatorios/config"), authedJson(ctx.staff.otroOrgOwner.token, { habilitado: false, primeroMin: 5, repetirMin: 5, maximo: 2 }, "PUT"))).status).toBe(403);
  });
});
