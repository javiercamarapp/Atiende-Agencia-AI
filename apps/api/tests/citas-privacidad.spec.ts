// C-02 -- seguimiento de solicitudes ARCO desde el panel (HTTP real vía app.request,
// repositorio en memoria). Cubre: autenticación, solo owner/admin, filtros,
// transiciones, cross-tenant y base sin migrar (disponible:false / 503, nunca 500).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildCitasTestContext } from "./citas-fixtures.ts";

const PHONE = "+5219981234567";

async function seedConfirmed(ctx: Awaited<ReturnType<typeof buildCitasTestContext>>, right: "acceso" | "cancelacion" = "acceso", phone = PHONE): Promise<string> {
  const reg = await ctx.citasRepo.registerDataRightsRequestAsSystem({ organizationId: ctx.organizationId, customerPhone: phone, rightType: right, detail: "mensaje" });
  if (!reg.available) throw new Error("fixture");
  await ctx.citasRepo.resolveDataRightsConfirmationAsSystem(ctx.organizationId, phone, true);
  return reg.id;
}

const base = (ctx: { propertyId: string }) => `/v1/citas/properties/${ctx.propertyId}/admin/privacidad/solicitudes`;

describe("GET .../admin/privacidad/solicitudes", () => {
  it("exige token (401)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const res = await buildApp(ctx.deps).request(base(ctx));
    expect(res.status).toBe(401);
  });

  it("rol staff (no owner/admin) -> 403: los teléfonos de titulares no son para todo el staff", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const res = await buildApp(ctx.deps).request(base(ctx), authedGet(ctx.staff.staffMember.token));
    expect(res.status).toBe(403);
  });

  it("owner y admin listan, con folio, estado y estado de vencimiento", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await seedConfirmed(ctx);
    for (const token of [ctx.staff.owner.token, ctx.staff.admin.token]) {
      const res = await app.request(base(ctx), authedGet(token));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { disponible: boolean; total: number; plazos: { respuestaDias: number; ejecucionDias: number }; items: Array<{ id: string; folio: string; estado: string; derecho: string; plazo: string | null; respuestaVenceEn: string | null }> };
      expect(body.disponible).toBe(true);
      expect(body.plazos).toEqual({ respuestaDias: 20, ejecucionDias: 15 });
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ id, estado: "recibida", derecho: "acceso", plazo: "en_plazo" });
      expect(body.items[0]!.folio).toHaveLength(8);
      expect(body.items[0]!.respuestaVenceEn).not.toBeNull();
    }
  });

  it("filtros por estado y derecho; valores inválidos -> 400", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await seedConfirmed(ctx, "acceso", "+5219990000001");
    await seedConfirmed(ctx, "cancelacion", "+5219990000002");
    const only = (await (await app.request(`${base(ctx)}?derecho=cancelacion`, authedGet(ctx.staff.owner.token))).json()) as { items: Array<{ derecho: string }> };
    expect(only.items.map((i) => i.derecho)).toEqual(["cancelacion"]);
    expect((await app.request(`${base(ctx)}?estado=resuelta`, authedGet(ctx.staff.owner.token))).status).toBe(200);
    expect((await app.request(`${base(ctx)}?estado=inventado`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    expect((await app.request(`${base(ctx)}?derecho=inventado`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    expect((await app.request(`${base(ctx)}?limit=12abc`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    expect((await app.request(`${base(ctx)}?offset=-1`, authedGet(ctx.staff.owner.token))).status).toBe(400);
  });

  it("base sin migrar: 200 con disponible:false (nunca un 500 ni una lista vacía que parezca real)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    ctx.citasRepo.dataRightsMigrationPending = true;
    const res = await buildApp(ctx.deps).request(base(ctx), authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, total: 0, items: [] });
  });

  it("cross-tenant: un owner de OTRA organización recibe 403 y nunca ve las solicitudes", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await seedConfirmed(ctx);

    const otherOrganizationId = randomUUID();
    const otherPropertyId = randomUUID();
    ctx.citasRepo.seedOrganization({ id: otherOrganizationId, slug: "otra-clinica-arco", name: "Otra Clínica", defaultTimezone: "America/Mexico_City" });
    ctx.coreRepo.addOrganization({ id: otherOrganizationId, slug: "otra-clinica-arco", name: "Otra Clínica", vertical: "citas" });
    ctx.engine.seedProperty({ id: otherPropertyId, organizationId: otherOrganizationId });
    ctx.citasRepo.seedCitasProperty({ id: otherPropertyId, organizationId: otherOrganizationId, name: "Sucursal única" });
    const otherOwnerId = randomUUID();
    const password = "correcto-caballo-batería";
    ctx.coreRepo.addStaff({ id: otherOwnerId, email: "dueno@otra-arco.mx", fullName: "Dueño Otra", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    ctx.coreRepo.addMembership({ userId: otherOwnerId, organizationId: otherOrganizationId, platformRole: "owner", verticalRole: "owner", propertyIds: null });
    ctx.engine.seedMembership({ userId: otherOwnerId, organizationId: otherOrganizationId, platformRole: "owner", verticalRole: "owner", propertyIds: null });
    const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dueno@otra-arco.mx", password }) });
    const otherToken = ((await login.json()) as { token: string }).token;

    expect((await app.request(base(ctx), authedGet(otherToken))).status).toBe(403);
    // Con SU propia propiedad ve su organización: vacía, sin filas ajenas.
    const own = (await (await app.request(base({ propertyId: otherPropertyId }), authedGet(otherToken))).json()) as { total: number };
    expect(own.total).toBe(0);
  });
});

describe("PATCH .../:id/estado y GET .../:id/eventos", () => {
  it("owner mueve recibida -> en_proceso -> resuelta con nota, y la bitácora lo refleja", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await seedConfirmed(ctx);
    const a = await app.request(`${base(ctx)}/${id}/estado`, authedJson(ctx.staff.owner.token, { estado: "en_proceso" }, "PATCH"));
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ id, estado: "en_proceso" });
    const b = await app.request(`${base(ctx)}/${id}/estado`, authedJson(ctx.staff.admin.token, { estado: "resuelta", nota: "datos entregados al titular" }, "PATCH"));
    expect(b.status).toBe(200);

    const ev = (await (await app.request(`${base(ctx)}/${id}/eventos`, authedGet(ctx.staff.owner.token))).json()) as { disponible: boolean; items: Array<{ actor: string; evento: string; hacia: string | null }> };
    expect(ev.disponible).toBe(true);
    expect(ev.items.map((e) => `${e.actor}:${e.evento}:${e.hacia}`)).toEqual([
      "titular:registrada:pendiente_confirmacion",
      "titular:confirmada:recibida",
      "staff:cambio_estado:en_proceso",
      "staff:cambio_estado:resuelta",
    ]);
  });

  it("transición inválida (estado terminal) -> 409; 'bloqueada' fuera de cancelación -> 409; 'bloqueada' en cancelación -> 200", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const acceso = await seedConfirmed(ctx, "acceso", "+5219990000001");
    const cancel = await seedConfirmed(ctx, "cancelacion", "+5219990000002");
    expect((await app.request(`${base(ctx)}/${acceso}/estado`, authedJson(ctx.staff.owner.token, { estado: "bloqueada" }, "PATCH"))).status).toBe(409);
    expect((await app.request(`${base(ctx)}/${cancel}/estado`, authedJson(ctx.staff.owner.token, { estado: "bloqueada" }, "PATCH"))).status).toBe(200);
    await app.request(`${base(ctx)}/${acceso}/estado`, authedJson(ctx.staff.owner.token, { estado: "resuelta" }, "PATCH"));
    expect((await app.request(`${base(ctx)}/${acceso}/estado`, authedJson(ctx.staff.owner.token, { estado: "en_proceso" }, "PATCH"))).status).toBe(409);
  });

  it("rechazar exige nota (400); estado fuera de la lista (400); id no uuid (400); id inexistente (404)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await seedConfirmed(ctx);
    expect((await app.request(`${base(ctx)}/${id}/estado`, authedJson(ctx.staff.owner.token, { estado: "rechazada" }, "PATCH"))).status).toBe(400);
    expect((await app.request(`${base(ctx)}/${id}/estado`, authedJson(ctx.staff.owner.token, { estado: "recibida" }, "PATCH"))).status).toBe(400);
    expect((await app.request(`${base(ctx)}/no-es-uuid/estado`, authedJson(ctx.staff.owner.token, { estado: "en_proceso" }, "PATCH"))).status).toBe(400);
    expect((await app.request(`${base(ctx)}/${randomUUID()}/estado`, authedJson(ctx.staff.owner.token, { estado: "en_proceso" }, "PATCH"))).status).toBe(404);
    expect((await app.request(`${base(ctx)}/${id}/estado`, authedJson(ctx.staff.owner.token, { estado: "rechazada", nota: "no se verificó la identidad" }, "PATCH"))).status).toBe(200);
  });

  it("rol staff no puede cambiar estados (403)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const id = await seedConfirmed(ctx);
    const res = await buildApp(ctx.deps).request(`${base(ctx)}/${id}/estado`, authedJson(ctx.staff.staffMember.token, { estado: "en_proceso" }, "PATCH"));
    expect(res.status).toBe(403);
  });

  it("base sin migrar: PATCH -> 503 explícito, eventos -> disponible:false (nunca 500)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    ctx.citasRepo.dataRightsMigrationPending = true;
    const app = buildApp(ctx.deps);
    const id = randomUUID();
    expect((await app.request(`${base(ctx)}/${id}/estado`, authedJson(ctx.staff.owner.token, { estado: "en_proceso" }, "PATCH"))).status).toBe(503);
    const ev = await app.request(`${base(ctx)}/${id}/eventos`, authedGet(ctx.staff.owner.token));
    expect(ev.status).toBe(200);
    expect(await ev.json()).toEqual({ disponible: false, items: [] });
  });
});
