// C-16 -- centro de avisos de citas (HTTP real vía app.request, repositorio en memoria). Cubre: autenticación, datos reales (por confirmar, estado
// de entrega de recordatorios, escalaciones), enmascarado del teléfono, rol (solo owner/admin ven y gestionan lo sensible), seguimiento con
// validaciones, cross-tenant y base sin migrar (estado honesto / 503, nunca un 500 ni una lista vacía que parezca real).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { enmascararTelefono } from "../src/routes/verticals/citas/avisos.ts";
import { authedGet, authedJson, buildCitasTestContext, type CitasTestContext } from "./citas-fixtures.ts";

const base = (ctx: { propertyId: string }) => `/v1/citas/properties/${ctx.propertyId}/admin`;

async function seedCita(ctx: CitasTestContext, horasDesdeAhora: number, status: "pending" | "confirmed" = "pending"): Promise<string> {
  const customer = await ctx.citasRepo.upsertCustomer(ctx.organizationId, `99900${Math.floor(Math.random() * 1e6)}`, "Cliente Secreto", null);
  const startsAt = new Date(Date.now() + horasDesdeAhora * 3_600_000).toISOString();
  const id = randomUUID();
  ctx.citasRepo.seedAppointment({
    id, organizationId: ctx.organizationId, propertyId: null, providerId: ctx.providerId, serviceId: ctx.serviceId, customerId: customer.id,
    startsAt, endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(), status, source: "whatsapp", notes: null, dedupeFingerprint: null, idempotencyKey: null,
    reminder24hSentAt: null, createdAt: new Date().toISOString(), googleEventId: null, googleSyncStatus: "skipped", googleSyncAttempts: 0, googleSyncNextRetryAt: null, googleSyncError: null,
  });
  return id;
}

async function seedEscalacion(ctx: CitasTestContext, phone = "+5219981234567"): Promise<string> {
  return (await ctx.citasRepo.insertEmergencyEscalation({ organizationId: ctx.organizationId, customerPhone: phone, channel: "whatsapp", keywordMatched: "crisis", messageExcerpt: "TEXTO DEL MENSAJE" })).id;
}

interface AvisosBody {
  porConfirmar: { horas: number; total: number; items: Array<{ id: string; iniciaEn: string; proveedor: string | null; servicio: string | null }> };
  recordatorios: { visible: boolean; disponible: boolean; filas: Array<{ canal: string; estado: string; total: number }> };
  escalaciones: { visible: boolean; disponible: boolean; seguimientoDisponible: boolean; items: Array<{ id: string; telefono: string; seguimiento: string | null; nota: string | null; palabraClave: string }> };
}

describe("enmascararTelefono", () => {
  it("deja solo los ultimos 4 digitos", () => {
    expect(enmascararTelefono("+52 1 998 123 4567")).toBe("***4567");
    expect(enmascararTelefono("123")).toBe("***");
  });
});

describe("GET .../admin/avisos", () => {
  it("exige token (401)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    expect((await buildApp(ctx.deps).request(`${base(ctx)}/avisos`)).status).toBe(401);
  });

  it("owner: por confirmar (solo pendientes en 72 h), recordatorios y escalaciones con el telefono ENMASCARADO y sin el extracto del mensaje", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const enVentana = await seedCita(ctx, 20);
    await seedCita(ctx, 30, "confirmed");
    await seedCita(ctx, 200); // fuera de las 72 h
    const escId = await seedEscalacion(ctx);
    const res = await app.request(`${base(ctx)}/avisos`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AvisosBody;
    expect(body.porConfirmar.horas).toBe(72);
    expect(body.porConfirmar.total).toBe(1);
    expect(body.porConfirmar.items[0]).toMatchObject({ id: enVentana, proveedor: expect.any(String), servicio: expect.any(String) });
    expect(body.escalaciones).toMatchObject({ visible: true, disponible: true, seguimientoDisponible: true });
    expect(body.escalaciones.items).toHaveLength(1);
    expect(body.escalaciones.items[0]).toMatchObject({ id: escId, telefono: "***4567", seguimiento: "pending", palabraClave: "crisis" });
    const crudo = JSON.stringify(body);
    expect(crudo).not.toContain("5219981234567");
    expect(crudo).not.toContain("TEXTO DEL MENSAJE");
    expect(crudo).not.toContain("Cliente Secreto");
  });

  it("recordatorios agotados: el estado de entrega sale del outbox real, por canal y estado", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    await ctx.citasRepo.enqueueMessagingOutbox(ctx.organizationId, "whatsapp", "appointment.reminder_24h", "reminder-24h:a", { to: "x" });
    await ctx.citasRepo.enqueueMessagingOutbox(ctx.organizationId, "whatsapp", "appointment.reminder_24h", "reminder-24h:b", { to: "y" });
    const lote = await ctx.citasRepo.claimMessagingOutboxBatch(10, 60);
    await ctx.citasRepo.markMessagingOutboxDead(lote[0]!.id, 5, "http_500");
    await ctx.citasRepo.markMessagingOutboxSent(lote[1]!.id);
    const body = (await (await buildApp(ctx.deps).request(`${base(ctx)}/avisos`, authedGet(ctx.staff.admin.token))).json()) as AvisosBody;
    expect(body.recordatorios).toMatchObject({ visible: true, disponible: true });
    expect(body.recordatorios.filas).toEqual(expect.arrayContaining([{ canal: "whatsapp", estado: "dead", total: 1 }, { canal: "whatsapp", estado: "sent", total: 1 }]));
  });

  it("rol staff: ve las citas por confirmar pero NO recordatorios ni escalaciones (visible:false, sin datos)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    await seedCita(ctx, 10);
    await seedEscalacion(ctx);
    const body = (await (await buildApp(ctx.deps).request(`${base(ctx)}/avisos`, authedGet(ctx.staff.staffMember.token))).json()) as AvisosBody;
    expect(body.porConfirmar.total).toBe(1);
    expect(body.recordatorios).toMatchObject({ visible: false, filas: [] });
    expect(body.escalaciones).toMatchObject({ visible: false, items: [] });
  });

  it("base sin migrar: escalaciones sin estado (seguimientoDisponible:false) y recordatorios disponible:false, nunca un 500", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    await seedEscalacion(ctx);
    ctx.citasRepo.avisosMigrationPending = true;
    const res = await buildApp(ctx.deps).request(`${base(ctx)}/avisos`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AvisosBody;
    expect(body.recordatorios).toMatchObject({ visible: true, disponible: false, filas: [] });
    expect(body.escalaciones).toMatchObject({ disponible: true, seguimientoDisponible: false });
    expect(body.escalaciones.items[0]!.seguimiento).toBeNull();
  });

  it("cross-tenant: un owner de OTRA organizacion recibe 403 y nunca ve las escalaciones", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await seedEscalacion(ctx);
    const otherOrganizationId = randomUUID();
    ctx.citasRepo.seedOrganization({ id: otherOrganizationId, slug: "otra-clinica-avisos", name: "Otra", defaultTimezone: "America/Mexico_City" });
    ctx.coreRepo.addOrganization({ id: otherOrganizationId, slug: "otra-clinica-avisos", name: "Otra", vertical: "citas" });
    const otherOwnerId = randomUUID();
    const password = "correcto-caballo-batería";
    ctx.coreRepo.addStaff({ id: otherOwnerId, email: "dueno@otra-avisos.mx", fullName: "Dueño Otra", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    ctx.coreRepo.addMembership({ userId: otherOwnerId, organizationId: otherOrganizationId, platformRole: "owner", verticalRole: "owner", propertyIds: null });
    ctx.engine.seedMembership({ userId: otherOwnerId, organizationId: otherOrganizationId, platformRole: "owner", verticalRole: "owner", propertyIds: null });
    const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dueno@otra-avisos.mx", password }) });
    const otherToken = ((await login.json()) as { token: string }).token;
    expect((await app.request(`${base(ctx)}/avisos`, authedGet(otherToken))).status).toBe(403);
  });
});

describe("POST .../admin/escalaciones/:id/seguimiento", () => {
  const url = (ctx: { propertyId: string }, id: string) => `${base(ctx)}/escalaciones/${id}/seguimiento`;

  it("owner toma el seguimiento y luego lo resuelve con nota: el estado y la nota salen en la bandeja", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await seedEscalacion(ctx);
    const r1 = await app.request(url(ctx, id), authedJson(ctx.staff.owner.token, { estado: "in_progress" }));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ id, estado: "in_progress" });
    const r2 = await app.request(url(ctx, id), authedJson(ctx.staff.admin.token, { estado: "resolved", nota: "  llamado por telefono  " }));
    expect(r2.status).toBe(200);
    const body = (await (await app.request(`${base(ctx)}/avisos`, authedGet(ctx.staff.owner.token))).json()) as AvisosBody;
    expect(body.escalaciones.items[0]).toMatchObject({ id, seguimiento: "resolved", nota: "llamado por telefono" });
  });

  it("rol staff -> 403; sin token -> 401", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await seedEscalacion(ctx);
    expect((await app.request(url(ctx, id), authedJson(ctx.staff.staffMember.token, { estado: "resolved" }))).status).toBe(403);
    expect((await app.request(url(ctx, id), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });

  it("validaciones: estado fuera de in_progress/resolved, nota no texto o demasiado larga, id inválido -> 400; id inexistente -> 404", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const id = await seedEscalacion(ctx);
    const owner = ctx.staff.owner.token;
    expect((await app.request(url(ctx, id), authedJson(owner, { estado: "pending" }))).status).toBe(400);
    expect((await app.request(url(ctx, id), authedJson(owner, {}))).status).toBe(400);
    expect((await app.request(url(ctx, id), authedJson(owner, { estado: "resolved", nota: 5 }))).status).toBe(400);
    expect((await app.request(url(ctx, id), authedJson(owner, { estado: "resolved", nota: "x".repeat(501) }))).status).toBe(400);
    expect((await app.request(url(ctx, "no-es-uuid"), authedJson(owner, { estado: "resolved" }))).status).toBe(400);
    expect((await app.request(url(ctx, randomUUID()), authedJson(owner, { estado: "resolved" }))).status).toBe(404);
  });

  it("base sin migrar: 503 explicito (nunca un 200 falso ni un 500)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const id = await seedEscalacion(ctx);
    ctx.citasRepo.avisosMigrationPending = true;
    const res = await buildApp(ctx.deps).request(url(ctx, id), authedJson(ctx.staff.owner.token, { estado: "resolved" }));
    expect(res.status).toBe(503);
  });
});
