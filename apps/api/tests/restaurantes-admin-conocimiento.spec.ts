// Conocimiento del negocio e interruptor del agente de WhatsApp por sucursal (migracion 053) — HTTP end-to-end de admin-conocimiento.ts:
// roles (solo owner/admin), alcance por sucursal, aislamiento entre organizaciones, bitacora, validador (sin precios ni productos), borradores
// que no entran al agente sin aprobacion, base sin migrar (estado honesto / 503) y el aviso in-app al apagar el agente.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository, InMemoryTenancyEngine, hashPassword } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import type { RestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const FAQ = { titulo: "Estacionamiento", texto: "Hay estacionamiento gratuito para clientes.", tipo: "faq" };
const urlConocimiento = (ctx: RestaurantesKpiTestContext) => `/v1/restaurantes/${ctx.propertyIdA}/admin/conocimiento`;
const urlInterruptor = (ctx: RestaurantesKpiTestContext, branchId: string) => `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${branchId}/agente-whatsapp`;

/** Admin acotado SOLO a la sucursal A (el fixture trae owner/admin de toda la organizacion y un staff acotado). */
async function adminAcotadoAA(ctx: RestaurantesKpiTestContext): Promise<string> {
  const coreRepo = ctx.deps.coreRepo as InMemoryCoreRepository;
  const engine = ctx.deps.engine as InMemoryTenancyEngine;
  const id = randomUUID();
  const email = `admin-a-${id.slice(0, 8)}@conocimiento.mx`;
  const password = "correcto-caballo-batería";
  coreRepo.addStaff({ id, email, fullName: "Admin A", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addMembership({ userId: id, organizationId: ctx.organizationId, platformRole: "admin", verticalRole: "admin", propertyIds: [ctx.propertyIdA] });
  engine.seedMembership({ userId: id, organizationId: ctx.organizationId, platformRole: "admin", verticalRole: "admin", propertyIds: [ctx.propertyIdA] });
  const res = await buildApp(ctx.deps).request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  return ((await res.json()) as { token: string }).token;
}

describe("conocimiento del negocio — GET/POST/PATCH/DELETE .../admin/conocimiento", () => {
  it("owner crea una FAQ, se lista y queda en la bitacora", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const vacia = await (await app.request(urlConocimiento(ctx), authedGet(ctx.staff.owner.token))).json();
    expect(vacia).toMatchObject({ disponible: true, entradas: [] });

    const crea = await app.request(urlConocimiento(ctx), authedJson(ctx.staff.owner.token, { ...FAQ, prioridad: 80 }));
    expect(crea.status).toBe(201);
    const creada = (await crea.json()) as { id: string; estado: string; origen: string; version: number; sucursalId: string | null };
    expect(creada).toMatchObject({ titulo: "Estacionamiento", tipo: "faq", prioridad: 80, estado: "publicado", origen: "manual", version: 1, sucursalId: null });

    const lista = (await (await app.request(urlConocimiento(ctx), authedGet(ctx.staff.admin.token))).json()) as { entradas: { id: string }[] };
    expect(lista.entradas.map((e) => e.id)).toEqual([creada.id]);
    expect(ctx.restaurantesRepo.auditLog.find((r) => r.action === "configuracion.conocimiento_creado")?.entityId).toBe(creada.id);
    // El agente lo ve (publicado y activo) en la sucursal A y en cualquiera (general).
    expect((await ctx.restaurantesRepo.listarConocimientoPublicado(ctx.organizationId, ctx.propertyIdB)).map((e) => e.id)).toEqual([creada.id]);
  });

  it("400: el validador rechaza precios y nombres del catalogo (el precio sale de cotizar_pedido)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.restaurantesRepo.seedProduct({ id: randomUUID(), organizationId: ctx.organizationId, categoryId: null, name: "Tacos de Pastor", description: null, searchKeywords: [] });
    const conPrecio = await app.request(urlConocimiento(ctx), authedJson(ctx.staff.owner.token, { titulo: "Pastor", texto: "El pastor cuesta $10.", tipo: "faq" }));
    expect(conPrecio.status).toBe(400);
    expect(JSON.stringify(await conPrecio.json())).toMatch(/precio/i);
    const conProducto = await app.request(urlConocimiento(ctx), authedJson(ctx.staff.owner.token, { titulo: "Promo", texto: "Los tacos de pastor son la especialidad.", tipo: "faq" }));
    expect(conProducto.status).toBe(400);
    expect((await ctx.restaurantesRepo.listarConocimiento(ctx.organizationId)).entradas).toHaveLength(0);
  });

  it.each([
    ["sin titulo", { texto: "x", tipo: "faq" }],
    ["tipo fuera del catalogo", { titulo: "t", texto: "x", tipo: "precio" }],
    ["prioridad fuera de rango", { ...FAQ, prioridad: 101 }],
    ["fecha invalida", { ...FAQ, vigenteDesde: "2026-02-31" }],
    ["vigencia invertida", { ...FAQ, tipo: "aviso_temporal", vigenteDesde: "2026-10-05", vigenteHasta: "2026-10-01" }],
    ["texto de 2001 caracteres", { ...FAQ, texto: "x".repeat(2001) }],
    ["reemplazaId en una entrada general", { ...FAQ, reemplazaId: randomUUID() }],
  ])("400: %s", async (_n, body) => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const res = await buildApp(ctx.deps).request(urlConocimiento(ctx), authedJson(ctx.staff.owner.token, body));
    expect(res.status).toBe(400);
  });

  it("solo owner/admin: staff, repartidor -> 403 en lectura y escritura; sin token -> 401", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const token of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token]) {
      expect((await app.request(urlConocimiento(ctx), authedGet(token))).status).toBe(403);
      expect((await app.request(urlConocimiento(ctx), authedJson(token, FAQ))).status).toBe(403);
    }
    expect((await app.request(urlConocimiento(ctx), { method: "GET" })).status).toBe(401);
  });

  it("aislamiento: otra organizacion no ve, edita ni borra las entradas (404) y su URL de otra sucursal no abre la nuestra", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creada = (await (await app.request(urlConocimiento(ctx), authedJson(ctx.staff.owner.token, FAQ))).json()) as { id: string };
    const suya = `/v1/restaurantes/${ctx.otherPropertyId}/admin/conocimiento`;
    expect(await (await app.request(suya, authedGet(ctx.staff.otroOrgOwner.token))).json()).toMatchObject({ entradas: [] });
    expect((await app.request(`${suya}/${creada.id}`, authedJson(ctx.staff.otroOrgOwner.token, { activo: false }, "PATCH"))).status).toBe(404);
    expect((await app.request(`${suya}/${creada.id}`, authedJson(ctx.staff.otroOrgOwner.token, undefined, "DELETE"))).status).toBe(404);
    // La URL de nuestra sucursal con el token de la otra organizacion no entra.
    expect([401, 403, 404]).toContain((await app.request(urlConocimiento(ctx), authedGet(ctx.staff.otroOrgOwner.token))).status);
    expect((await ctx.restaurantesRepo.listarConocimiento(ctx.organizationId)).entradas[0]).toMatchObject({ id: creada.id, activo: true });
  });

  it("admin acotado a la sucursal A: crea para A, pero no lo general ni para B, ni toca lo ajeno", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const token = await adminAcotadoAA(ctx);
    expect((await app.request(urlConocimiento(ctx), authedJson(token, FAQ))).status).toBe(403); // general: solo quien ve toda la organizacion
    expect((await app.request(urlConocimiento(ctx), authedJson(token, { ...FAQ, sucursalId: ctx.propertyIdB }))).status).toBe(403);
    const propia = await app.request(urlConocimiento(ctx), authedJson(token, { ...FAQ, sucursalId: ctx.propertyIdA }));
    expect(propia.status).toBe(201);
    const general = (await (await app.request(urlConocimiento(ctx), authedJson(ctx.staff.owner.token, { ...FAQ, titulo: "General" }))).json()) as { id: string };
    expect((await app.request(`${urlConocimiento(ctx)}/${general.id}`, authedJson(token, { activo: false }, "PATCH"))).status).toBe(403);
    expect((await app.request(`${urlConocimiento(ctx)}/${general.id}`, authedJson(token, undefined, "DELETE"))).status).toBe(403);
    const visibles = (await (await app.request(urlConocimiento(ctx), authedGet(token))).json()) as { entradas: { titulo: string }[] };
    expect(visibles.entradas.map((e) => e.titulo).sort()).toEqual(["Estacionamiento", "General"]);
  });

  it("PATCH: apaga una entrada (version +1, bitacora); DELETE la borra; entrada inexistente 404", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creada = (await (await app.request(urlConocimiento(ctx), authedJson(ctx.staff.owner.token, FAQ))).json()) as { id: string };
    const url = `${urlConocimiento(ctx)}/${creada.id}`;
    const edit = await app.request(url, authedJson(ctx.staff.admin.token, { activo: false, texto: "Estacionamiento para 20 autos." }, "PATCH"));
    expect(edit.status).toBe(200);
    expect(await edit.json()).toMatchObject({ activo: false, version: 2, texto: "Estacionamiento para 20 autos." });
    expect(await ctx.restaurantesRepo.listarConocimientoPublicado(ctx.organizationId, null)).toEqual([]);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, {}, "PATCH"))).status).toBe(400);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { sucursalId: ctx.propertyIdB }, "PATCH"))).status).toBe(400);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { texto: "Ahora cuesta $50." }, "PATCH"))).status).toBe(400);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, undefined, "DELETE"))).status).toBe(200);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, undefined, "DELETE"))).status).toBe(404);
    expect((await app.request(`${urlConocimiento(ctx)}/no-es-uuid`, authedJson(ctx.staff.owner.token, undefined, "DELETE"))).status).toBe(400);
    const acciones = ctx.restaurantesRepo.auditLog.map((r) => r.action);
    expect(acciones).toEqual(expect.arrayContaining(["configuracion.conocimiento_creado", "configuracion.conocimiento_actualizado", "configuracion.conocimiento_eliminado"]));
  });

  it("un borrador importado NO llega al agente hasta que una persona lo aprueba (PATCH estado = publicado); aprobarlo deja bitacora y no se salta el validador", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const limpio = await ctx.restaurantesRepo.crearConocimiento(ctx.organizationId, "u1", { titulo: "Reservas", texto: "No tomamos reservaciones.", tipo: "politica", estado: "borrador", origen: "importado" });
    const sucio = await ctx.restaurantesRepo.crearConocimiento(ctx.organizationId, "u1", { titulo: "Precios", texto: "La orden cuesta $99.", tipo: "politica", estado: "borrador", origen: "importado" });
    expect(await ctx.restaurantesRepo.listarConocimientoPublicado(ctx.organizationId, null)).toEqual([]);
    expect((await app.request(`${urlConocimiento(ctx)}/${sucio.id}`, authedJson(ctx.staff.owner.token, { estado: "publicado" }, "PATCH"))).status).toBe(400);
    const ok = await app.request(`${urlConocimiento(ctx)}/${limpio.id}`, authedJson(ctx.staff.owner.token, { estado: "publicado" }, "PATCH"));
    expect(ok.status).toBe(200);
    expect((await ctx.restaurantesRepo.listarConocimientoPublicado(ctx.organizationId, null)).map((e) => e.id)).toEqual([limpio.id]);
    expect(ctx.restaurantesRepo.auditLog.some((r) => r.action === "configuracion.conocimiento_aprobado")).toBe(true);
  });

  it("base SIN migrar: la lista dice disponible:false (estado honesto) y escribir responde 503, nunca 500", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.restaurantesRepo.conocimiento.noDisponible = true;
    expect(await (await app.request(urlConocimiento(ctx), authedGet(ctx.staff.owner.token))).json()).toMatchObject({ disponible: false, entradas: [] });
    expect((await app.request(urlConocimiento(ctx), authedJson(ctx.staff.owner.token, FAQ))).status).toBe(503);
  });
});

describe("interruptor del agente de WhatsApp — GET/PUT .../admin/config/sucursales/:branchId/agente-whatsapp", () => {
  it("encendido por omision; owner lo apaga: queda en la bitacora, avisa al equipo (sin PII) y se enciende de nuevo sin avisar", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    const app = buildApp(deps);
    const url = urlInterruptor(ctx, ctx.propertyIdB);
    expect(await (await app.request(url, authedGet(ctx.staff.owner.token))).json()).toEqual({ disponible: true, agenteActivo: true });

    const apaga = await app.request(url, authedJson(ctx.staff.owner.token, { activo: false }, "PUT"));
    expect(apaga.status).toBe(200);
    expect(await apaga.json()).toEqual({ disponible: true, agenteActivo: false });
    expect(await ctx.restaurantesRepo.findAgenteWhatsappActivo(ctx.propertyIdB)).toBe(false);
    // La otra sucursal sigue encendida: el interruptor es POR sucursal.
    expect(await ctx.restaurantesRepo.findAgenteWhatsappActivo(ctx.propertyIdA)).toBe(true);
    const bitacora = ctx.restaurantesRepo.auditLog.find((r) => r.action === "configuracion.agente_whatsapp_sucursal");
    expect(bitacora).toMatchObject({ entityId: ctx.propertyIdB, antes: "true", despues: "false" });

    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({
      evento: "restaurantes.agente.whatsapp_apagado",
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyIdB,
      categoria: "agentes",
      severidad: "atencion",
      enlace: "/restaurantes/{orgSlug}/conversaciones",
    });
    expect(emisiones[0]!.dedupeKey).toMatch(new RegExp(`^restaurantes\\.agente\\.whatsapp_apagado:${ctx.propertyIdB}:\\d{4}-\\d{2}-\\d{2}$`));

    expect((await app.request(url, authedJson(ctx.staff.owner.token, { activo: true }, "PUT"))).status).toBe(200);
    expect(await ctx.restaurantesRepo.findAgenteWhatsappActivo(ctx.propertyIdB)).toBe(true);
    expect(emisiones).toHaveLength(1);
  });

  it("solo owner/admin; el admin acotado a A apaga A pero no B; una sucursal de otra organizacion es 404/403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const token of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token]) {
      expect((await app.request(urlInterruptor(ctx, ctx.propertyIdA), authedJson(token, { activo: false }, "PUT"))).status).toBe(403);
    }
    const acotado = await adminAcotadoAA(ctx);
    expect((await app.request(urlInterruptor(ctx, ctx.propertyIdA), authedJson(acotado, { activo: false }, "PUT"))).status).toBe(200);
    expect((await app.request(urlInterruptor(ctx, ctx.propertyIdB), authedJson(acotado, { activo: false }, "PUT"))).status).toBe(403);
    expect(await ctx.restaurantesRepo.findAgenteWhatsappActivo(ctx.propertyIdB)).toBe(true);
    expect([403, 404]).toContain((await app.request(urlInterruptor(ctx, ctx.otherPropertyId), authedJson(ctx.staff.owner.token, { activo: false }, "PUT"))).status);
    expect(await ctx.restaurantesRepo.findAgenteWhatsappActivo(ctx.otherPropertyId)).toBe(true);
  });

  it("400 si activo no es booleano; base SIN migrar: lectura disponible:false y escritura 503", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await app.request(urlInterruptor(ctx, ctx.propertyIdA), authedJson(ctx.staff.owner.token, { activo: "no" }, "PUT"))).status).toBe(400);
    ctx.restaurantesRepo.conocimiento.noDisponible = true;
    expect(await (await app.request(urlInterruptor(ctx, ctx.propertyIdA), authedGet(ctx.staff.owner.token))).json()).toEqual({ disponible: false, agenteActivo: true });
    expect((await app.request(urlInterruptor(ctx, ctx.propertyIdA), authedJson(ctx.staff.owner.token, { activo: false }, "PUT"))).status).toBe(503);
  });

  it("una emision de aviso que falla (base sin 0039) no cambia el 200 de la escritura", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const { deps } = conEmisiones(ctx.deps, {
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const res = await buildApp(deps).request(urlInterruptor(ctx, ctx.propertyIdA), authedJson(ctx.staff.owner.token, { activo: false }, "PUT"));
    expect(res.status).toBe(200);
    expect(await ctx.restaurantesRepo.findAgenteWhatsappActivo(ctx.propertyIdA)).toBe(false);
  });
});
