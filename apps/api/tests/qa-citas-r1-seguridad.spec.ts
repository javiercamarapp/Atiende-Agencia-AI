// QA adversarial citas, ronda 1, lente seguridad y datos (3-oct-2026).
//
// Pruebas NUEVAS sobre la app Hono real (repositorio en memoria) que fijan el comportamiento SEGURO esperado. Las marcadas
// `[DEFECTO QA-citas-R1-seguridad-NN]` fallan HOY en main (documentan un hallazgo del reporte local de QA); las `[CONTROL]` pasan.
// La contraparte contra Postgres real (RLS/GRANT) vive en scripts/verify-citas-qa-seguridad-r1/.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword } from "@atiende/db";
import { FakeCalendarSyncPort, FakeGoogleCalendarPort } from "@atiende/domain-citas";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext, type CitasTestContext } from "./citas-fixtures.ts";
import { jsonRequestInit } from "./fixtures.ts";

const LUNES_10_MERIDA = "2027-09-13T16:00:00.000Z";
const LUNES_11_MERIDA = "2027-09-13T17:00:00.000Z";

/** Segunda sucursal de la MISMA organizacion, con su propio proveedor, y un staff de rol "staff" acotado a la sucursal original. */
async function conSegundaSucursalYStaffAcotado(ctx: CitasTestContext, app: ReturnType<typeof buildApp>) {
  const sucursal2 = randomUUID();
  ctx.engine.seedProperty({ id: sucursal2, organizationId: ctx.organizationId });
  ctx.citasRepo.seedCitasProperty({ id: sucursal2, organizationId: ctx.organizationId, name: "Sucursal 2" });
  const proveedorSucursal2 = randomUUID();
  ctx.citasRepo.seedProvider({ id: proveedorSucursal2, organizationId: ctx.organizationId, propertyId: sucursal2, displayName: "Psiquiatra de la sucursal 2", roleLabel: "Psiquiatra", isActive: true });

  const id = randomUUID();
  const email = "recepcion-sucursal-1@clinica-dental-sonrisas.mx";
  const password = "correcto-caballo-batería";
  ctx.coreRepo.addStaff({ id, email, fullName: "Recepción sucursal 1", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  ctx.coreRepo.addMembership({ userId: id, organizationId: ctx.organizationId, platformRole: "member", verticalRole: "staff", propertyIds: [ctx.propertyId] });
  ctx.engine.seedMembership({ userId: id, organizationId: ctx.organizationId, platformRole: "member", verticalRole: "staff", propertyIds: [ctx.propertyId] });
  const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  expect(login.status).toBe(200);
  const { token } = (await login.json()) as { token: string };
  return { sucursal2, proveedorSucursal2, tokenStaffAcotado: token };
}

function patchJson(token: string, body: unknown): RequestInit {
  return { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("QA-citas-R1-seguridad-01 — configuracion de la organizacion (rubro = guardia de crisis, telefono de avisos)", () => {
  it("[DEFECTO] un usuario de rol 'staff' NO puede apagar la guardia de crisis cambiando el rubro de salud a 'otro'", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const owner = await app.request(`/v1/citas/properties/${ctx.propertyId}/tenant-config`, patchJson(ctx.staff.owner.token, { rubro: "psicologo" }));
    expect(owner.status).toBe(200);

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/tenant-config`, patchJson(ctx.staff.staffMember.token, { rubro: "otro" }));
    expect(res.status).toBe(403);
    expect((await ctx.citasRepo.findTenantConfig(ctx.organizationId))?.rubro).toBe("psicologo");
  });

  it("[DEFECTO] un usuario de rol 'staff' NO puede redirigir el telefono de avisos de crisis/callbacks a otro numero", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/v1/citas/properties/${ctx.propertyId}/tenant-config`, patchJson(ctx.staff.owner.token, { owner_notification_phone: "+5219991112233" }));

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/tenant-config`, patchJson(ctx.staff.staffMember.token, { owner_notification_phone: "+5219990000000" }));
    expect(res.status).toBe(403);
    expect((await ctx.citasRepo.findTenantConfig(ctx.organizationId))?.ownerNotificationPhone).toBe("+5219991112233");
  });

  it("[CONTROL] owner y admin si pueden editarla", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await app.request(`/v1/citas/properties/${ctx.propertyId}/tenant-config`, patchJson(ctx.staff.owner.token, { rubro: "dental" }))).status).toBe(200);
    expect((await app.request(`/v1/citas/properties/${ctx.propertyId}/tenant-config`, patchJson(ctx.staff.admin.token, { rubro: "medico" }))).status).toBe(200);
  });
});

describe("QA-citas-R1-seguridad-02 — conectar el calendario externo de un proveedor de OTRA sucursal", () => {
  it("[DEFECTO] el staff de la sucursal 1 NO puede conectar un CalDAV propio al proveedor de la sucursal 2", async () => {
    const caldav = new FakeCalendarSyncPort("caldav");
    const ctx = await buildCitasTestContext(buildApp, { caldavPort: caldav });
    const app = buildApp(ctx.deps);
    const { proveedorSucursal2, tokenStaffAcotado } = await conSegundaSucursalYStaffAcotado(ctx, app);

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${proveedorSucursal2}/caldav/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenStaffAcotado}` },
      body: JSON.stringify({ calendar_collection_url: "https://caldav.fastmail.com/dav/calendars/user/x@y.com/abc/", username: "x@y.com", password: "app-password" }),
    });
    expect([403, 404]).toContain(res.status);
    expect(await ctx.citasRepo.findProviderCalDavAccount(proveedorSucursal2)).toBeNull();
  });

  it("[DEFECTO] ni iniciar ni completar el OAuth de Google Calendar para el proveedor de la sucursal 2", async () => {
    const ctx = await buildCitasTestContext(buildApp, { googleCalendarPort: new FakeGoogleCalendarPort() });
    const app = buildApp(ctx.deps);
    const { proveedorSucursal2, tokenStaffAcotado } = await conSegundaSucursalYStaffAcotado(ctx, app);

    const inicio = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${proveedorSucursal2}/google-calendar/connect`, { headers: { authorization: `Bearer ${tokenStaffAcotado}` } });
    if (inicio.status === 200) {
      const state = new URL(((await inicio.json()) as { authorize_url: string }).authorize_url).searchParams.get("state")!;
      await app.request(`/v1/citas/google-calendar/oauth-callback?code=codigo&state=${encodeURIComponent(state)}`);
    }
    expect([403, 404]).toContain(inicio.status);
    expect(await ctx.citasRepo.findProviderCalendarAccount(proveedorSucursal2)).toBeNull();
  });

  it("[CONTROL] ese mismo staff no puede operar la ruta de la sucursal 2 (requirePropertyMembership)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { sucursal2, proveedorSucursal2, tokenStaffAcotado } = await conSegundaSucursalYStaffAcotado(ctx, app);
    const res = await app.request(`/v1/citas/properties/${sucursal2}/providers/${proveedorSucursal2}`, { headers: { authorization: `Bearer ${tokenStaffAcotado}` } });
    expect(res.status).toBe(403);
  });
});

describe("QA-citas-R1-seguridad-06 — reserva publica sin verificar el telefono", () => {
  it("[DEFECTO] reservar en la pagina publica con el telefono de OTRO paciente no le asigna el correo de quien reserva", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    // El paciente real ya existe (llego por WhatsApp, sin correo).
    // (`normalizePhone` guarda los ultimos 10 digitos: es la misma llave que usa la reserva publica.)
    const paciente = await ctx.citasRepo.upsertCustomer(ctx.organizationId, "9992223344", "Paciente Real", null);
    expect(paciente.email).toBeNull();

    const res = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Otra persona", customer_phone: "+5219992223344", customer_email: "tercero@example.com", starts_at: LUNES_10_MERIDA, source: "web" }),
    );
    expect(res.status).toBe(201);

    // Despues, el paciente real agenda OTRA cita por su canal (aqui, el agente con el secreto de herramientas, sin correo).
    const suya = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Paciente Real", customer_phone: "+5219992223344", starts_at: LUNES_11_MERIDA, source: "whatsapp" }, { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret }),
    );
    expect(suya.status).toBe(201);
    const { appointment: citaDelPaciente } = (await suya.json()) as { appointment: { id: string } };

    const despues = await ctx.citasRepo.findCustomerByPhone(ctx.organizationId, "9992223344");
    expect(despues?.email ?? null).toBeNull();
    // Ningun correo sobre la cita del paciente real puede ir al correo que escribio un tercero en la pagina publica.
    const correosDeSuCitaAlTercero = ctx.citasRepo
      .getOutbox()
      .filter((o) => o.channel === "email" && (o.payload as { to?: string }).to === "tercero@example.com" && o.dedupeKey.includes(citaDelPaciente.id));
    expect(correosDeSuCitaAlTercero).toHaveLength(0);
  });
});

describe("QA-citas-R1-seguridad-07 — rutas legadas del agente sin vinculo con el telefono del cliente", () => {
  it("[DEFECTO] cancelar por id con solo el secreto de plataforma (sin telefono del cliente) no debe estar disponible", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creada = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "+5219993334455", starts_at: LUNES_11_MERIDA, source: "web" }),
    );
    const { appointment } = (await creada.json()) as { appointment: { id: string } };

    const res = await app.request(`/v1/citas/clinica-dental-sonrisas/appointments/${appointment.id}/cancel`, { method: "POST", headers: { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret } });
    expect(res.status).not.toBe(200);
    expect((await ctx.citasRepo.findAppointmentForOrganization(ctx.organizationId, appointment.id))?.status).not.toBe("cancelled");
  });

  it("[CONTROL] la herramienta de voz cancelar_cita SI exige que la cita sea del telefono de la llamada", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creada = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "+5219993334455", starts_at: LUNES_11_MERIDA, source: "web" }),
    );
    const { appointment } = (await creada.json()) as { appointment: { id: string } };
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/voz/cancelar_cita", {
      method: "POST",
      headers: { "content-type": "application/json", "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret },
      body: JSON.stringify({ telefono: "+5219990009999", appointment_id: appointment.id }),
    });
    expect(res.status).toBe(200);
    expect((await ctx.citasRepo.findAppointmentForOrganization(ctx.organizationId, appointment.id))?.status).not.toBe("cancelled");
  });
});

describe("QA-citas-R1-seguridad-08 — horas que ve el agente (WhatsApp y voz comparten executeToolCall)", () => {
  it("[DEFECTO] consultar_disponibilidad entrega al modelo la hora LOCAL del negocio, no solo un instante UTC", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/voz/consultar_disponibilidad", {
      method: "POST",
      headers: { "content-type": "application/json", "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret },
      body: JSON.stringify({ telefono: "", provider_id: ctx.providerId, service_id: ctx.serviceId, date: "2027-09-13" }),
    });
    expect(res.status).toBe(200);
    const { slots } = (await res.json()) as { slots: Record<string, unknown>[] };
    expect(slots.length).toBeGreaterThan(0);
    // El negocio abre a las 09:00 de Merida (15:00 UTC). El primer horario que lee el modelo debe decir 09:00 en algun campo,
    // no solo "2027-09-13T15:00:00.000Z" (que el modelo lee como "15:00").
    const textoPrimerSlot = JSON.stringify(slots[0]);
    expect(textoPrimerSlot).toContain("09:00");
  });
});

describe("QA-citas-R1-seguridad-09 — telefono del paciente capturado en el panel", () => {
  it("[DEFECTO] una cita creada a mano con el telefono en formato internacional aparece cuando el paciente pregunta por sus citas", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const alta = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Paciente", customer_phone: "+52 1 999 444 5566", starts_at: LUNES_10_MERIDA }),
    });
    expect(alta.status).toBe(201);

    const res = await app.request("/v1/citas/clinica-dental-sonrisas/voz/buscar_mis_citas", {
      method: "POST",
      headers: { "content-type": "application/json", "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret },
      body: JSON.stringify({ telefono: "+5219994445566" }),
    });
    expect(res.status).toBe(200);
    const { appointments } = (await res.json()) as { appointments: unknown[] };
    expect(appointments).toHaveLength(1);
  });
});

describe("QA-citas-R1-seguridad-10 — validacion de contacto en la reserva publica", () => {
  it("[DEFECTO] la reserva publica rechaza un telefono sin digitos suficientes y un correo sin formato", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const telefonoBasura = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "X", customer_phone: "hola", starts_at: LUNES_10_MERIDA, source: "web" }),
    );
    expect(telefonoBasura.status).toBe(400);
    const correoBasura = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Y", customer_phone: "9995556677", customer_email: "esto no es un correo", starts_at: LUNES_11_MERIDA, source: "web" }),
    );
    expect(correoBasura.status).toBe(400);
  });
});
