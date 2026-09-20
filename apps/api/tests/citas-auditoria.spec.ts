// FASE 3 (producto) — bitácora de auditoría del staff. Dos frentes, ambos HTTP
// real (vía app.request, sin mockear el repo -- mismo criterio que
// apps/api/tests/restaurantes-auditoria.spec.ts/rentas-auditoria.spec.ts):
//
//   1. Cada ruta de escritura sensible (tarifa de servicio, cancelación forzada
//      de cita por staff, invitar/revocar/cambiar rol de staff, horarios/
//      disponibilidad, tenant-config, resolución manual de lista de espera)
//      registra la fila esperada en `ctx.citasRepo.auditLog` -- inspección
//      directa del doble en memoria.
//   2. GET /v1/citas/properties/:propertyId/admin/auditoria: paginado, filtro
//      por tipo/fechas, solo owner/admin, cross-tenant siempre rechazado.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildCitasTestContext } from "./citas-fixtures.ts";

describe("FASE 3 — registro de auditoría en las rutas de escritura reales", () => {
  it("PATCH .../services/:serviceId con price_cents registra servicio.tarifa_actualizada", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.citasRepo.auditLog.length;

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/services/${ctx.serviceId}`, authedJson(ctx.staff.owner.token, { price_cents: 60000 }, "PATCH"));
    expect(res.status).toBe(200);

    const nuevas = ctx.citasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "servicio", action: "servicio.tarifa_actualizada", entityId: ctx.serviceId, actorUserId: ctx.staff.owner.id, antes: "50000", despues: "60000" });
  });

  it("PATCH .../services/:serviceId sin tocar price_cents -- nunca registra (fuera de alcance de esta fase)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.citasRepo.auditLog.length;

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/services/${ctx.serviceId}`, authedJson(ctx.staff.owner.token, { name: "Consulta general (nuevo nombre)" }, "PATCH"));
    expect(res.status).toBe(200);
    expect(ctx.citasRepo.auditLog.slice(antes)).toHaveLength(0);
  });

  it("POST .../appointments/:id/cancel (panel de staff) registra cita.cancelada_por_staff", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments`, authedJson(ctx.staff.owner.token, {
      provider_id: ctx.providerId,
      service_id: ctx.serviceId,
      customer_name: "Paciente de Prueba",
      customer_phone: "5215500000000",
      starts_at: "2026-10-05T15:00:00.000Z",
    }));
    expect(created.status).toBe(201);
    const appointmentId = ((await created.json()) as { appointment: { id: string } }).appointment.id;
    const antes = ctx.citasRepo.auditLog.length;

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${appointmentId}/cancel`, authedJson(ctx.staff.owner.token, undefined, "POST"));
    expect(res.status).toBe(200);

    const nuevas = ctx.citasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "cita", action: "cita.cancelada_por_staff", entityId: appointmentId, actorUserId: ctx.staff.owner.id, despues: "cancelled" });
  });

  it("POST .../admin/staff/invitaciones registra staff.invitado (correo enmascarado)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.citasRepo.auditLog.length;

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token, { email: "nuevo@clinica-dental-sonrisas.mx", verticalRole: "staff" }));
    expect(res.status).toBe(201);
    const invite = (await res.json()) as { id: string };

    const nuevas = ctx.citasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "staff", action: "staff.invitado", entityId: invite.id, actorUserId: ctx.staff.owner.id });
    expect(nuevas[0]!.despues).toContain("n***@clinica-dental-sonrisas.mx");
    expect(nuevas[0]!.despues).not.toContain("nuevo@clinica-dental-sonrisas.mx");
  });

  it("DELETE .../admin/staff/invitaciones/:id registra staff.invitacion_revocada", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token, { email: "revocar@clinica-dental-sonrisas.mx", verticalRole: "staff" }));
    const inviteId = ((await created.json()) as { id: string }).id;
    const antes = ctx.citasRepo.auditLog.length;

    const del = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones/${inviteId}`, authedJson(ctx.staff.owner.token, undefined, "DELETE"));
    expect(del.status).toBe(200);

    const nuevas = ctx.citasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "staff", action: "staff.invitacion_revocada", entityId: inviteId });
  });

  it("PATCH .../admin/staff/miembros/:userId registra staff.rol_actualizado", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.citasRepo.auditLog.length;

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/staff/miembros/${ctx.staff.staffMember.id}`, authedJson(ctx.staff.owner.token, { verticalRole: "admin" }, "PATCH"));
    expect(res.status).toBe(200);

    const nuevas = ctx.citasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "staff", action: "staff.rol_actualizado", entityId: ctx.staff.staffMember.id, antes: "staff", despues: "admin", actorUserId: ctx.staff.owner.id });
  });

  it("POST .../availability-rules registra configuracion.horario_creado", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.citasRepo.auditLog.length;

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/availability-rules`, authedJson(ctx.staff.owner.token, { day_of_week: 6, start_time: "10:00", end_time: "14:00" }));
    expect(res.status).toBe(201);

    const nuevas = ctx.citasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "configuracion", action: "configuracion.horario_creado" });
  });

  it("PATCH .../tenant-config con rubro registra configuracion.tenant_actualizada", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.citasRepo.auditLog.length;

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/tenant-config`, authedJson(ctx.staff.owner.token, { rubro: "veterinaria" }, "PATCH"));
    expect(res.status).toBe(200);

    const nuevas = ctx.citasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "configuracion", action: "configuracion.tenant_actualizada", actorUserId: ctx.staff.owner.id });
  });

  it("PATCH .../tenant-config sin body real -- nunca registra", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.citasRepo.auditLog.length;

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/tenant-config`, authedJson(ctx.staff.owner.token, {}, "PATCH"));
    expect(res.status).toBe(200);
    expect(ctx.citasRepo.auditLog.slice(antes)).toHaveLength(0);
  });

  it("POST .../waitlist/broadcast (con la RPC de sistema disponible) registra lista_espera.resuelta_manual en la sesión de STAFF", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = ctx.citasRepo.auditLog.length;

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/waitlist/broadcast`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queued: boolean };
    expect(body.queued).toBe(true);

    const nuevas = ctx.citasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "lista_espera", action: "lista_espera.resuelta_manual", actorUserId: ctx.staff.owner.id });
  });
});

describe("FASE 3 — GET /v1/citas/properties/:propertyId/admin/auditoria", () => {
  it("exige un token (401)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/auditoria`);
    expect(res.status).toBe(401);
  });

  it("staff (puede ESCRIBIR, pero no owner/admin) -> 403", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/auditoria`, authedGet(ctx.staff.staffMember.token));
    expect(res.status).toBe(403);
  });

  it("owner lee su propia bitácora, paginada, más reciente primero", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    await app.request(`/v1/citas/properties/${ctx.propertyId}/services/${ctx.serviceId}`, authedJson(ctx.staff.owner.token, { price_cents: 55000 }, "PATCH"));
    await app.request(`/v1/citas/properties/${ctx.propertyId}/services/${ctx.serviceId}`, authedJson(ctx.staff.owner.token, { price_cents: 65000 }, "PATCH"));

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/auditoria`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; total: number; items: Array<{ action: string; despues: string | null }> };
    expect(body.disponible).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(2);
    // Más reciente primero: la última tarifa (65000) debe aparecer antes que la
    // penúltima (55000) entre las filas de este servicio.
    const tarifas = body.items.filter((i) => i.action === "servicio.tarifa_actualizada").map((i) => i.despues);
    expect(tarifas[0]).toBe("65000");
    expect(tarifas[1]).toBe("55000");
  });

  it("admin (no solo owner) también puede leer", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/auditoria`, authedGet(ctx.staff.admin.token));
    expect(res.status).toBe(200);
  });

  it("filtro ?tipo= solo trae ese entityType", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/v1/citas/properties/${ctx.propertyId}/services/${ctx.serviceId}`, authedJson(ctx.staff.owner.token, { price_cents: 58000 }, "PATCH"));
    await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.owner.token, { email: "filtro@clinica-dental-sonrisas.mx", verticalRole: "staff" }));

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/auditoria?tipo=servicio`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ entityType: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.every((i) => i.entityType === "servicio")).toBe(true);
  });

  it("tipo inválido -> 400", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/auditoria?tipo=no-existe`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });

  it("desde con fecha de calendario inválida (mes/día fuera de rango) -> 400, nunca 500", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/auditoria?desde=2026-13-45`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });

  it("hasta con 29 de febrero de un año NO bisiesto -> 400", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/auditoria?hasta=2026-02-29`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });

  it("limit con basura al final ('12abc') -> 400, no se trunca en 12", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/auditoria?limit=12abc`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });

  it("offset negativo -> 400", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/auditoria?offset=-1`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });

  it("paginación real: limit=1 dos veces trae 2 filas distintas y nextOffset avanza", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/v1/citas/properties/${ctx.propertyId}/services/${ctx.serviceId}`, authedJson(ctx.staff.owner.token, { price_cents: 51000 }, "PATCH"));
    await app.request(`/v1/citas/properties/${ctx.propertyId}/services/${ctx.serviceId}`, authedJson(ctx.staff.owner.token, { price_cents: 52000 }, "PATCH"));

    const pagina1 = (await (await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/auditoria?limit=1`, authedGet(ctx.staff.owner.token))).json()) as {
      items: Array<{ id: string }>;
      nextOffset: number | null;
    };
    expect(pagina1.items).toHaveLength(1);
    expect(pagina1.nextOffset).toBe(1);

    const pagina2 = (await (await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/auditoria?limit=1&offset=${pagina1.nextOffset}`, authedGet(ctx.staff.owner.token))).json()) as {
      items: Array<{ id: string }>;
    };
    expect(pagina2.items).toHaveLength(1);
    expect(pagina2.items[0]!.id).not.toBe(pagina1.items[0]!.id);
  });

  it("cross-tenant: la bitácora de una organización nunca mezcla filas de otra, y un owner ajeno recibe 403 (requirePropertyMembership)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    // Segunda organización de citas, con su propio owner -- mismo patrón que
    // `buildCitasTestContext`, sembrado directo sobre los mismos `coreRepo`/
    // `engine`/`citasRepo` (ahora expuestos por el fixture).
    const otherOrganizationId = randomUUID();
    const otherPropertyId = randomUUID();
    ctx.citasRepo.seedOrganization({ id: otherOrganizationId, slug: "otra-clinica", name: "Otra Clínica", defaultTimezone: "America/Mexico_City" });
    ctx.coreRepo.addOrganization({ id: otherOrganizationId, slug: "otra-clinica", name: "Otra Clínica", vertical: "citas" });
    ctx.engine.seedProperty({ id: otherPropertyId, organizationId: otherOrganizationId });
    ctx.citasRepo.seedCitasProperty({ id: otherPropertyId, organizationId: otherOrganizationId, name: "Sucursal única" });
    const otherServiceId = randomUUID();
    ctx.citasRepo.seedService({ id: otherServiceId, organizationId: otherOrganizationId, name: "Otro servicio", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: 10000, isActive: true });

    const otherOwnerId = randomUUID();
    const otherOwnerEmail = "dueño@otra-clinica.mx";
    const otherOwnerPassword = "correcto-caballo-batería";
    ctx.coreRepo.addStaff({ id: otherOwnerId, email: otherOwnerEmail, fullName: "Dueño Otra Clínica", passwordHash: await hashPassword(otherOwnerPassword), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    ctx.coreRepo.addMembership({ userId: otherOwnerId, organizationId: otherOrganizationId, platformRole: "owner", verticalRole: "owner", propertyIds: null });
    ctx.engine.seedMembership({ userId: otherOwnerId, organizationId: otherOrganizationId, platformRole: "owner", verticalRole: "owner", propertyIds: null });

    const loginRes = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: otherOwnerEmail, password: otherOwnerPassword }) });
    expect(loginRes.status).toBe(200);
    const otherOwnerToken = ((await loginRes.json()) as { token: string }).token;

    // Genera actividad en AMBAS organizaciones.
    await app.request(`/v1/citas/properties/${ctx.propertyId}/services/${ctx.serviceId}`, authedJson(ctx.staff.owner.token, { price_cents: 70000 }, "PATCH"));
    await app.request(`/v1/citas/properties/${otherPropertyId}/services/${otherServiceId}`, authedJson(otherOwnerToken, { price_cents: 20000 }, "PATCH"));

    // El owner de la organización ajena no tiene membership sobre `propertyId`
    // (de la organización A) -- `requirePropertyMembership` lo rechaza con 403
    // ANTES de que la ruta siquiera resuelva `organizationId`.
    const crossRes = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/auditoria`, authedGet(otherOwnerToken));
    expect(crossRes.status).toBe(403);

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/admin/auditoria`, authedGet(ctx.staff.owner.token));
    const body = (await res.json()) as { items: Array<{ despues: string | null }> };
    expect(body.items.some((i) => i.despues === "20000")).toBe(false);
  });
});
