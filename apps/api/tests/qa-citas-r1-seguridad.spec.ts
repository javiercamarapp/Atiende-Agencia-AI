// QA adversarial citas, ronda 1, lente seguridad y datos (3-oct-2026).
//
// Pruebas NUEVAS sobre la app Hono real (repositorio en memoria) que fijan el comportamiento SEGURO esperado. Las marcadas
// `[DEFECTO QA-citas-R1-seguridad-NN]` fallan HOY en main (documentan un hallazgo del reporte local de QA); las `[CONTROL]` pasan.
// (QA-08, la hora local que ve el agente, queda fuera del alcance de este lote: ver el cuerpo del PR.)
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

/**
 * Modela el guard real de Postgres que el repositorio en memoria no tiene: `citas.set_provider_calendar_refresh_token` (el secreto de Cal.com/CalDAV)
 * es de SOLO sistema (`auth.uid() is null`, migracion 017) y responde 42501 a una sesion de staff. `claimsUserId` lo fija el motor envuelto en cada sesion.
 * `sistemaRechazado` modela ademas la base sin migrar (032): sin la policy de sistema de las cuentas, la escritura de la sesion de sistema tambien da 42501.
 */
function conGuardDeSecretoDeSistema(ctx: CitasTestContext, opciones: { sistemaRechazado?: boolean } = {}) {
  const motorEnvuelto = new Proxy(ctx.engine, {
    get(target, prop) {
      if (prop === "withAppSession") {
        return (claims: { userId: string | null }, fn: (session: object) => Promise<unknown>) =>
          target.withAppSession(claims, (session) => fn(Object.assign(session, { claimsUserId: claims.userId })));
      }
      const valor = Reflect.get(target, prop, target) as unknown;
      return typeof valor === "function" ? (valor as (...args: unknown[]) => unknown).bind(target) : valor;
    },
  });
  const pgError42501 = () => Object.assign(new Error("permission denied"), { code: "42501" });
  const citasRepo = (db: unknown) =>
    new Proxy(ctx.citasRepo, {
      get(target, prop) {
        const valor = Reflect.get(target, prop, target) as unknown;
        if (typeof valor !== "function") return valor;
        if (prop === "connectProviderCalDavAccount" || prop === "connectProviderCalComAccount") {
          return (...args: unknown[]) => {
            const deSistema = (db as { claimsUserId?: string | null }).claimsUserId == null;
            if (!deSistema || opciones.sistemaRechazado) throw pgError42501();
            return (valor as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (valor as (...args: unknown[]) => unknown).bind(target);
      },
    });
  return { ...ctx.deps, engine: motorEnvuelto, citasRepo } as unknown as typeof ctx.deps;
}

describe("QA-citas-R1-seguridad-04 — conectar CalDAV y Cal.com guarda el secreto con la sesion de sistema", () => {
  const cuerpoCaldav = { calendar_collection_url: "https://caldav.fastmail.com/dav/calendars/user/x@y.com/abc/", username: "x@y.com", password: "app-password" };
  const post = (token: string, body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  it("conectar CalDAV desde el panel funciona cuando la funcion del secreto es de solo sistema (antes: 42501 -> 500)", async () => {
    const ctx = await buildCitasTestContext(buildApp, { caldavPort: new FakeCalendarSyncPort("caldav") });
    const app = buildApp(conGuardDeSecretoDeSistema(ctx));
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/connect`, post(ctx.staff.owner.token, cuerpoCaldav));
    expect(res.status).toBe(200);
    expect((await ctx.citasRepo.findProviderCalDavAccount(ctx.providerId))?.syncStatus).toBe("connected");
  });

  it("conectar Cal.com desde el panel funciona cuando la funcion del secreto es de solo sistema", async () => {
    const ctx = await buildCitasTestContext(buildApp, { calcomPort: new FakeCalendarSyncPort("calcom") });
    const app = buildApp(conGuardDeSecretoDeSistema(ctx));
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/connect`, post(ctx.staff.owner.token, { api_key: "cal_live_123", event_type_id: "42" }));
    expect(res.status).toBe(200);
    expect((await ctx.citasRepo.findProviderCalComAccount(ctx.providerId))?.syncStatus).toBe("connected");
  });

  it("base sin migrar (la sesion de sistema tambien recibe 42501): 503 honesto, no un 500, y nada queda conectado", async () => {
    const ctx = await buildCitasTestContext(buildApp, { caldavPort: new FakeCalendarSyncPort("caldav") });
    const app = buildApp(conGuardDeSecretoDeSistema(ctx, { sistemaRechazado: true }));
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/connect`, post(ctx.staff.owner.token, cuerpoCaldav));
    expect(res.status).toBe(503);
    expect(await ctx.citasRepo.findProviderCalDavAccount(ctx.providerId)).toBeNull();
  });

  it("un error que no es 42501 sigue siendo un error del servidor (no se disfraza de 503)", async () => {
    const ctx = await buildCitasTestContext(buildApp, { caldavPort: new FakeCalendarSyncPort("caldav") });
    const base = conGuardDeSecretoDeSistema(ctx);
    const app = buildApp({ ...base, citasRepo: (db: unknown) => new Proxy(base.citasRepo(db as never), { get: (t, p) => (p === "connectProviderCalDavAccount" ? () => Promise.reject(new Error("boom")) : Reflect.get(t, p)) }) } as unknown as typeof ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/connect`, post(ctx.staff.owner.token, cuerpoCaldav));
    expect(res.status).toBe(500);
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
  async function conCitaDeAna() {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creada = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "+5219993334455", starts_at: LUNES_11_MERIDA, source: "web" }),
    );
    const { appointment } = (await creada.json()) as { appointment: { id: string } };
    const estado = async () => (await ctx.citasRepo.findAppointmentForOrganization(ctx.organizationId, appointment.id))!;
    const llamar = (accion: "cancel" | "reschedule" | "reassign", body: Record<string, unknown> | undefined) =>
      app.request(`/v1/citas/clinica-dental-sonrisas/appointments/${appointment.id}/${accion}`, {
        method: "POST",
        headers: { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    return { ctx, estado, llamar };
  }

  it("[DEFECTO] cancelar, reagendar o modificar por id con solo el secreto de plataforma (sin el telefono del cliente) no cambia la cita", async () => {
    const { ctx, estado, llamar } = await conCitaDeAna();
    const inicial = await estado();
    const otroProveedor = randomUUID();
    ctx.citasRepo.seedProvider({ id: otroProveedor, organizationId: ctx.organizationId, propertyId: null, displayName: "Otro", roleLabel: "Dentista", isActive: true });
    ctx.citasRepo.seedProviderService(otroProveedor, ctx.serviceId);

    expect((await llamar("cancel", undefined)).status).toBe(400);
    expect((await llamar("cancel", {})).status).toBe(400);
    expect((await llamar("reschedule", { new_starts_at: LUNES_10_MERIDA })).status).toBe(400);
    expect((await llamar("reassign", { new_provider_id: otroProveedor })).status).toBe(400);
    const despues = await estado();
    expect(despues.status).toBe(inicial.status);
    expect(despues.startsAt).toBe(inicial.startsAt);
    expect(despues.providerId).toBe(inicial.providerId);
  });

  it("[DEFECTO] con el telefono de OTRO cliente responde 404 y la cita no cambia (igual que una cita inexistente)", async () => {
    const { estado, llamar } = await conCitaDeAna();
    const inicial = await estado();
    expect((await llamar("cancel", { customer_phone: "9990009999" })).status).toBe(404);
    expect((await llamar("reschedule", { customer_phone: "9990009999", new_starts_at: LUNES_10_MERIDA })).status).toBe(404);
    expect((await estado()).status).toBe(inicial.status);
  });

  it("[CONTROL] con el telefono del dueno de la cita (en cualquier formato) cancela y reagenda", async () => {
    const { estado, llamar } = await conCitaDeAna();
    expect((await llamar("reschedule", { customer_phone: "+52 1 999 333 4455", new_starts_at: LUNES_10_MERIDA })).status).toBe(200);
    expect((await estado()).startsAt).toBe(LUNES_10_MERIDA);
    expect((await llamar("cancel", { customer_phone: "9993334455" })).status).toBe(200);
    expect((await estado()).status).toBe("cancelled");
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

describe("QA-citas-R1-seguridad-06/09/10 — controles de los arreglos de contacto", () => {
  it("[CONTROL 06] un paciente NUEVO que reserva en la web conserva su correo, y por WhatsApp un expediente existente sin correo si lo recibe", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const web = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Nuevo", customer_phone: "9991110000", customer_email: "nuevo@example.com", starts_at: LUNES_10_MERIDA, source: "web" }),
    );
    expect(web.status).toBe(201);
    expect((await ctx.citasRepo.findCustomerByPhone(ctx.organizationId, "9991110000"))?.email).toBe("nuevo@example.com");

    await ctx.citasRepo.upsertCustomer(ctx.organizationId, "9992220000", "Existente", null);
    const wa = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Existente", customer_phone: "9992220000", customer_email: "titular@example.com", starts_at: LUNES_11_MERIDA, source: "whatsapp" }, { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret }),
    );
    expect(wa.status).toBe(201);
    expect((await ctx.citasRepo.findCustomerByPhone(ctx.organizationId, "9992220000"))?.email).toBe("titular@example.com");
  });

  it("[CONTROL 10] telefono y correo con formato valido se aceptan; el alta del panel rechaza un telefono o correo invalido con 400", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ok = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ok", customer_phone: "+52 1 999 555 6677", customer_email: "ok@example.com", starts_at: LUNES_10_MERIDA, source: "web" }),
    );
    expect(ok.status).toBe(201);
    const panel = (body: Record<string, unknown>): RequestInit => ({
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "P", starts_at: LUNES_11_MERIDA, ...body }),
    });
    expect((await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments`, panel({ customer_phone: "hola" }))).status).toBe(400);
    expect((await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments`, panel({ customer_phone: "9995556677", customer_email: "no es correo" }))).status).toBe(400);
  });

  it("[CONTROL 09] el telefono capturado en el panel queda con la misma llave que usa el agente (un solo expediente)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const alta = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Paciente", customer_phone: "+52 1 999 444 5566", starts_at: LUNES_10_MERIDA }),
    });
    expect(alta.status).toBe(201);
    expect(await ctx.citasRepo.findCustomerByPhone(ctx.organizationId, "9994445566")).not.toBeNull();
  });
});
