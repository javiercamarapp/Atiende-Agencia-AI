// H-01 -- boveda de identidad, registro migratorio y purga con doble control: integracion
// HTTP real (app.request) sobre el repositorio en memoria. RLS/GRANT/funciones SQL las cubre
// scripts/verify-hoteles-boveda-identidad contra Postgres real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson, type HotelesTestContext } from "./hoteles-fixtures.ts";

const SECRET_NUMBER = "G-1234 5678";

function post(token: string, body: unknown): RequestInit {
  return authedJson(token, body);
}

async function setup() {
  const ctx = await buildHotelesTestContext(buildApp);
  return { ctx, app: buildApp(ctx.deps) };
}

function captureBody(ctx: HotelesTestContext, patch: Record<string, unknown> = {}) {
  return {
    guestId: ctx.guestId,
    reservationId: ctx.reservationId,
    documentType: "pasaporte",
    nationality: "USA",
    fullName: "Ana Torres",
    documentNumber: SECRET_NUMBER,
    birthDate: "1990-05-17",
    ...patch,
  };
}

async function capture(app: ReturnType<typeof buildApp>, ctx: HotelesTestContext, token = ctx.staff.frontdesk.token) {
  const res = await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(token, captureBody(ctx)));
  expect(res.status).toBe(201);
  return ((await res.json()) as { identidad: { id: string } }).identidad;
}

describe("POST/GET /hoteles/:propertyId/identidad", () => {
  it("frontdesk captura: responde solo metadatos (ultimos 4, retencion), y el sobre almacenado esta cifrado", async () => {
    const { ctx, app } = await setup();
    const res = await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(ctx.staff.frontdesk.token, captureBody(ctx)));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain("Torres");
    expect(text).not.toContain(SECRET_NUMBER);
    const body = JSON.parse(text) as { identidad: { id: string; ultimos4: string; estado: string; tipoDocumento: string; nacionalidad: string; retencionHasta: string; versionLlave: number } };
    expect(body.identidad).toMatchObject({ ultimos4: "5678", estado: "activo", tipoDocumento: "pasaporte", nacionalidad: "USA", versionLlave: 1 });
    expect(body.identidad.retencionHasta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const stored = ctx.identidadRepo.storedEnvelope(body.identidad.id)!;
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain("Torres");
  });

  describe("plazo de retencion de la imagen (30 dias tras el check-out)", () => {
    function seedStay(ctx: HotelesTestContext) {
      ctx.hotelesRepo.seedReservation({
        id: ctx.reservationId,
        organizationId: ctx.organizationId,
        propertyId: ctx.propertyId,
        roomTypeId: randomUUID(),
        guestId: ctx.guestId,
        checkInDate: "2026-03-10",
        checkOutDate: "2026-03-12",
        status: "confirmada",
        totalAmount: 0,
        cancellationPenaltyAmount: null,
        canceledAt: null,
        createdAt: "2026-03-01T00:00:00Z",
      });
    }

    it("por defecto: check-out + 30 dias; con retentionDays explicito (0) vence el dia del check-out", async () => {
      const { ctx, app } = await setup();
      seedStay(ctx);
      const def = await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(ctx.staff.frontdesk.token, captureBody(ctx)));
      expect(def.status).toBe(201);
      expect(((await def.json()) as { identidad: { retencionHasta: string } }).identidad.retencionHasta).toBe("2026-04-11");
      const zero = await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(ctx.staff.frontdesk.token, captureBody(ctx, { retentionDays: 0 })));
      expect(zero.status).toBe(201);
      expect(((await zero.json()) as { identidad: { retencionHasta: string } }).identidad.retencionHasta).toBe("2026-03-12");
    });

    it("sin reserva ligada: 30 dias desde la captura (hoy de negocio)", async () => {
      const { ctx, app } = await setup();
      const res = await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(ctx.staff.frontdesk.token, captureBody(ctx, { reservationId: undefined })));
      expect(res.status).toBe(201);
      const hasta = ((await res.json()) as { identidad: { retencionHasta: string } }).identidad.retencionHasta;
      const dias = (Date.parse(`${hasta}T00:00:00Z`) - Date.now()) / 86_400_000;
      expect(dias).toBeGreaterThan(28.5);
      expect(dias).toBeLessThan(31.5);
    });

    it("tope editable 0..365: 365 se acepta; 366 se rechaza con mensaje claro", async () => {
      const { ctx, app } = await setup();
      seedStay(ctx);
      const ok = await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(ctx.staff.frontdesk.token, captureBody(ctx, { retentionDays: 365 })));
      expect(ok.status).toBe(201);
      expect(((await ok.json()) as { identidad: { retencionHasta: string } }).identidad.retencionHasta).toBe("2027-03-12");
      const bad = await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(ctx.staff.frontdesk.token, captureBody(ctx, { retentionDays: 366 })));
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { message: string }).message).toMatch(/entre 0 y 365/);
    });
  });

  it("lista metadatos sin documento; filtra por huesped y estado", async () => {
    const { ctx, app } = await setup();
    await capture(app, ctx);
    const res = await app.request(`/hoteles/${ctx.propertyId}/identidad?huespedId=${ctx.guestId}&estado=activo`, authedJson(ctx.staff.reservations.token));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET_NUMBER);
    const body = JSON.parse(text) as { disponible: boolean; llaveConfigurada: boolean; items: unknown[] };
    expect(body).toMatchObject({ disponible: true, llaveConfigurada: true });
    expect(body.items).toHaveLength(1);
    const purged = await app.request(`/hoteles/${ctx.propertyId}/identidad?estado=purgado`, authedJson(ctx.staff.owner.token));
    expect(((await purged.json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it("roles: housekeeping/fnb/accountant no capturan ni listan (403)", async () => {
    const { ctx, app } = await setup();
    for (const role of ["housekeeping", "fnb", "accountant"] as const) {
      expect((await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(ctx.staff[role].token, captureBody(ctx)))).status).toBe(403);
      expect((await app.request(`/hoteles/${ctx.propertyId}/identidad`, authedJson(ctx.staff[role].token))).status).toBe(403);
    }
  });

  it("sin token: 401", async () => {
    const { ctx, app } = await setup();
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad`)).status).toBe(401);
  });

  it.each([
    ["documentType invalido", { documentType: "cedula" }],
    ["nombre vacio", { fullName: "" }],
    ["nacionalidad no ISO3", { nationality: "Mexico" }],
    ["fecha imposible", { birthDate: "1990-02-31" }],
    ["retencion negativa", { retentionDays: -1 }],
    ["retencion sobre el tope de 365", { retentionDays: 366 }],
    ["huesped no UUID", { guestId: "x" }],
  ])("validacion: %s -> 400", async (_n, patch) => {
    const { ctx, app } = await setup();
    const res = await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(ctx.staff.frontdesk.token, captureBody(ctx, patch)));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation_error");
  });

  it("huesped de otra property -> 400 (guarda cross-tenant), nada se guarda", async () => {
    const { ctx, app } = await setup();
    const res = await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(ctx.staff.frontdesk.token, captureBody(ctx, { guestId: randomUUID() })));
    expect(res.status).toBe(400);
    expect((await ctx.identidadRepo.listIdentities(ctx.propertyId, { limit: 10 })).items).toHaveLength(0);
  });

  it("SIN llave de cifrado configurada: captura -> 503 (jamas se guarda en claro) y la lista avisa llaveConfigurada:false", async () => {
    const { ctx } = await setup();
    const app = buildApp({ ...ctx.deps, env: { ...ctx.deps.env, hotelesIdentityKey: null } });
    const res = await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(ctx.staff.frontdesk.token, captureBody(ctx)));
    expect(res.status).toBe(503);
    expect((await ctx.identidadRepo.listIdentities(ctx.propertyId, { limit: 10 })).items).toHaveLength(0);
    const list = await app.request(`/hoteles/${ctx.propertyId}/identidad`, authedJson(ctx.staff.frontdesk.token));
    expect(((await list.json()) as { llaveConfigurada: boolean }).llaveConfigurada).toBe(false);
  });

  it("llave configurada pero INVALIDA -> 503 explicito, no 'sin llave' en silencio", async () => {
    const { ctx } = await setup();
    const app = buildApp({ ...ctx.deps, env: { ...ctx.deps.env, hotelesIdentityKey: "corta" } });
    const res = await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(ctx.staff.frontdesk.token, captureBody(ctx)));
    expect(res.status).toBe(503);
  });

  it("BASE SIN MIGRAR: la lista responde 200 con disponible:false y items vacios; la captura 503; nada rompe", async () => {
    const { ctx, app } = await setup();
    ctx.identidadRepo.unavailable = true;
    const list = await app.request(`/hoteles/${ctx.propertyId}/identidad`, authedJson(ctx.staff.frontdesk.token));
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ disponible: false, items: [] });
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad`, post(ctx.staff.frontdesk.token, captureBody(ctx)))).status).toBe(503);
    const mig = await app.request(`/hoteles/${ctx.propertyId}/registro-migratorio`, authedJson(ctx.staff.frontdesk.token));
    expect(await mig.json()).toMatchObject({ disponible: false, items: [] });
  });
});

describe("verificar y revelar", () => {
  it("frontdesk revela con motivo: recibe el documento descifrado con no-store; la huella queda en la bitacora que lee el owner", async () => {
    const { ctx, app } = await setup();
    const { id } = await capture(app, ctx);
    const res = await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/revelar`, post(ctx.staff.frontdesk.token, { motivo: "Verificacion en mostrador al hacer check-in" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ documento: { nombreCompleto: "Ana Torres", numeroDocumento: SECRET_NUMBER, fechaNacimiento: "1990-05-17" } });

    const log = await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/accesos`, authedJson(ctx.staff.owner.token));
    expect(log.status).toBe(200);
    const items = ((await log.json()) as { items: { accion: string; actorId: string; motivo: string | null }[] }).items;
    expect(items.map((i) => i.accion)).toEqual(["revelacion", "captura"]);
    expect(items[0]).toMatchObject({ actorId: ctx.staff.frontdesk.id, motivo: "Verificacion en mostrador al hacer check-in" });
  });

  it("revelar exige motivo valido (400) y no deja huella; reservations no puede revelar (403); frontdesk no lee la bitacora (403)", async () => {
    const { ctx, app } = await setup();
    const { id } = await capture(app, ctx);
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/revelar`, post(ctx.staff.frontdesk.token, { motivo: "corto" }))).status).toBe(400);
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/revelar`, post(ctx.staff.frontdesk.token, {}))).status).toBe(400);
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/revelar`, post(ctx.staff.reservations.token, { motivo: "Intento sin permiso de rol" }))).status).toBe(403);
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/accesos`, authedJson(ctx.staff.frontdesk.token))).status).toBe(403);
    const log = await ctx.identidadRepo.listAccessLog(ctx.propertyId, { limit: 10 });
    expect(log.items.map((l) => l.action)).toEqual(["captura"]);
  });

  it("identidad inexistente o de otra property -> 403 uniforme (sin oraculo de existencia)", async () => {
    const { ctx, app } = await setup();
    const res = await app.request(`/hoteles/${ctx.propertyId}/identidad/${randomUUID()}/revelar`, post(ctx.staff.frontdesk.token, { motivo: "Motivo suficientemente largo" }));
    expect(res.status).toBe(403);
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad/no-es-uuid/revelar`, post(ctx.staff.frontdesk.token, { motivo: "Motivo suficientemente largo" }))).status).toBe(400);
  });

  it("verificar: frontdesk si, housekeeping no; sella verificadaPor", async () => {
    const { ctx, app } = await setup();
    const { id } = await capture(app, ctx);
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/verificar`, post(ctx.staff.housekeeping.token, {}))).status).toBe(403);
    const res = await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/verificar`, post(ctx.staff.frontdesk.token, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ identidad: { id, verificadaPor: ctx.staff.frontdesk.id } });
  });
});

describe("purga con doble control", () => {
  async function solicitar(app: ReturnType<typeof buildApp>, ctx: HotelesTestContext, id: string, token = ctx.staff.owner.token) {
    const res = await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/solicitar-purga`, post(token, { motivo: "Cancelacion ARCO solicitada por el titular" }));
    expect(res.status).toBe(201);
    return ((await res.json()) as { solicitudId: string }).solicitudId;
  }

  it("frontdesk no puede solicitar purga (403); owner si", async () => {
    const { ctx, app } = await setup();
    const { id } = await capture(app, ctx);
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/solicitar-purga`, post(ctx.staff.frontdesk.token, { motivo: "Intento sin permiso de rol" }))).status).toBe(403);
    await solicitar(app, ctx, id);
  });

  it("DOBLE CONTROL: el solicitante no puede decidir (403); otro admin aprueba; la identidad queda BLOQUEADA (no purgada) y ya no se revela (409)", async () => {
    const { ctx, app } = await setup();
    const { id } = await capture(app, ctx);
    const requestId = await solicitar(app, ctx, id, ctx.staff.owner.token);
    const self = await app.request(`/hoteles/${ctx.propertyId}/identidad-purgas/${requestId}/decidir`, post(ctx.staff.owner.token, { aprobar: true }));
    expect(self.status).toBe(403);
    expect(((await self.json()) as { message: string }).message).toMatch(/Doble control/);
    expect((await ctx.identidadRepo.findIdentity(ctx.propertyId, id))?.status).toBe("activo");

    const ok = await app.request(`/hoteles/${ctx.propertyId}/identidad-purgas/${requestId}/decidir`, post(ctx.staff.gm.token, { aprobar: true, nota: "Aprobada tras verificar" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ resultado: "en_bloqueo" });
    // Desde 032 aprobar NO purga: el sobre se conserva durante la ventana de bloqueo.
    expect(ctx.identidadRepo.storedEnvelope(id)).not.toBeNull();
    expect((await ctx.identidadRepo.findIdentity(ctx.propertyId, id))?.status).toBe("bloqueada");

    const reveal = await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/revelar`, post(ctx.staff.frontdesk.token, { motivo: "Intento de revelar bloqueada" }));
    expect(reveal.status).toBe(409);
    expect(((await reveal.json()) as { message: string }).message).toMatch(/bloqueada/);
    const again = await app.request(`/hoteles/${ctx.propertyId}/identidad-purgas/${requestId}/decidir`, post(ctx.staff.gm.token, { aprobar: true }));
    expect(again.status).toBe(409);
  });

  it("rechazar deja la identidad activa; lista de solicitudes solo para owner/gm", async () => {
    const { ctx, app } = await setup();
    const { id } = await capture(app, ctx);
    const requestId = await solicitar(app, ctx, id);
    const rej = await app.request(`/hoteles/${ctx.propertyId}/identidad-purgas/${requestId}/decidir`, post(ctx.staff.gm.token, { aprobar: false, nota: "Retencion vigente" }));
    expect(await rej.json()).toEqual({ resultado: "rechazada" });
    expect((await ctx.identidadRepo.findIdentity(ctx.propertyId, id))?.status).toBe("activo");
    const list = await app.request(`/hoteles/${ctx.propertyId}/identidad-purgas?estado=rechazada`, authedJson(ctx.staff.gm.token));
    expect(((await list.json()) as { items: { estado: string }[] }).items.map((i) => i.estado)).toEqual(["rechazada"]);
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad-purgas`, authedJson(ctx.staff.frontdesk.token))).status).toBe(403);
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad-purgas/${requestId}/decidir`, post(ctx.staff.frontdesk.token, { aprobar: true }))).status).toBe(403);
  });

  it("segunda solicitud pendiente de la misma identidad -> 409; 'aprobar' debe ser booleano (400); solicitud inexistente -> 404", async () => {
    const { ctx, app } = await setup();
    const { id } = await capture(app, ctx);
    const requestId = await solicitar(app, ctx, id);
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad/${id}/solicitar-purga`, post(ctx.staff.gm.token, { motivo: "Segunda solicitud duplicada" }))).status).toBe(409);
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad-purgas/${requestId}/decidir`, post(ctx.staff.gm.token, { aprobar: "si" }))).status).toBe(400);
    expect((await app.request(`/hoteles/${ctx.propertyId}/identidad-purgas/${randomUUID()}/decidir`, post(ctx.staff.gm.token, { aprobar: true }))).status).toBe(404);
  });
});

describe("registro migratorio", () => {
  it("crea (fechas de la reserva, nacionalidad de la identidad), lista, reporta con constancia; no se reporta dos veces (409); duplicado (409)", async () => {
    const { ctx, app } = await setup();
    const { id } = await capture(app, ctx);
    const created = await app.request(`/hoteles/${ctx.propertyId}/registro-migratorio`, post(ctx.staff.frontdesk.token, { reservaId: ctx.reservationId, huespedId: ctx.guestId, identidadId: id }));
    expect(created.status).toBe(201);
    const reg = ((await created.json()) as { registro: { id: string; llegada: string; salida: string; nacionalidad: string; estado: string } }).registro;
    expect(reg).toMatchObject({ llegada: "2026-03-10", salida: "2026-03-12", nacionalidad: "USA", estado: "pendiente", retencionRegistroHasta: "2027-03-12" });
    expect((await app.request(`/hoteles/${ctx.propertyId}/registro-migratorio`, post(ctx.staff.frontdesk.token, { reservaId: ctx.reservationId, huespedId: ctx.guestId }))).status).toBe(409);

    const pend = await app.request(`/hoteles/${ctx.propertyId}/registro-migratorio?estado=pendiente`, authedJson(ctx.staff.reservations.token));
    expect(((await pend.json()) as { items: unknown[] }).items).toHaveLength(1);

    expect((await app.request(`/hoteles/${ctx.propertyId}/registro-migratorio/${reg.id}/reportar`, post(ctx.staff.frontdesk.token, {}))).status).toBe(400);
    const rep = await app.request(`/hoteles/${ctx.propertyId}/registro-migratorio/${reg.id}/reportar`, post(ctx.staff.frontdesk.token, { constancia: "INM-2026-0042" }));
    expect(rep.status).toBe(200);
    expect(await rep.json()).toMatchObject({ registro: { estado: "reportado", constancia: "INM-2026-0042", reportadoPor: ctx.staff.frontdesk.id } });
    expect((await app.request(`/hoteles/${ctx.propertyId}/registro-migratorio/${reg.id}/reportar`, post(ctx.staff.frontdesk.token, { constancia: "INM-otra" }))).status).toBe(409);
    expect((await app.request(`/hoteles/${ctx.propertyId}/registro-migratorio/${randomUUID()}/reportar`, post(ctx.staff.frontdesk.token, { constancia: "INM-1" }))).status).toBe(404);
  });

  it("reserva de otra property -> 400; housekeeping -> 403", async () => {
    const { ctx, app } = await setup();
    expect((await app.request(`/hoteles/${ctx.propertyId}/registro-migratorio`, post(ctx.staff.frontdesk.token, { reservaId: randomUUID(), huespedId: ctx.guestId }))).status).toBe(400);
    expect((await app.request(`/hoteles/${ctx.propertyId}/registro-migratorio`, post(ctx.staff.housekeeping.token, { reservaId: ctx.reservationId, huespedId: ctx.guestId }))).status).toBe(403);
  });
});

describe("cron de purga por retencion (/internal/hoteles/identidad-purga)", () => {
  const cronHeaders = (ctx: HotelesTestContext) => ({ "x-atiende-internal-secret": ctx.deps.env.internalSecret });

  it("sin secreto: 401", async () => {
    const { ctx, app } = await setup();
    void ctx;
    expect((await app.request("/internal/hoteles/identidad-purga", { method: "POST" })).status).toBe(401);
  });

  it("BLOQUEA lo vencido (no purga de golpe) segun la fecha de negocio de cada property; la purga llega al vencer la ventana", async () => {
    const { ctx, app } = await setup();
    const vencida = await capture(app, ctx);
    const vigente = await capture(app, ctx);
    ctx.identidadRepo.setRetention(vencida.id, "2020-01-01");
    const res = await app.request("/internal/hoteles/identidad-purga", { method: "POST", headers: cronHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; purgadas_total: number; bloqueadas_total: number; corridas: { omitida: string | null; error: string | null; via_bloqueo: boolean | null }[] };
    expect(body).toMatchObject({ ok: true, purgadas_total: 0, bloqueadas_total: 1 });
    expect(body.corridas.every((r) => r.via_bloqueo === true)).toBe(true);
    expect((await ctx.identidadRepo.findIdentity(ctx.propertyId, vencida.id))?.status).toBe("bloqueada");
    expect(ctx.identidadRepo.storedEnvelope(vencida.id)).not.toBeNull();
    expect((await ctx.identidadRepo.findIdentity(ctx.propertyId, vigente.id))?.status).toBe("activo");
  });

  it("la corrida siguiente, con la ventana vencida (en memoria: fecha de negocio posterior), purga lo bloqueado", async () => {
    const { ctx, app } = await setup();
    const vencida = await capture(app, ctx);
    ctx.identidadRepo.setRetention(vencida.id, "2020-01-01");
    await app.request("/internal/hoteles/identidad-purga", { method: "POST", headers: cronHeaders(ctx) });
    const blockedUntil = (await ctx.identidadRepo.findIdentity(ctx.propertyId, vencida.id))!.blockedUntil!;
    expect(await ctx.identidadRepo.purgeExpired(ctx.propertyId, blockedUntil)).toBe(1);
    expect((await ctx.identidadRepo.findIdentity(ctx.propertyId, vencida.id))?.status).toBe("purgado");
    expect(ctx.identidadRepo.storedEnvelope(vencida.id)).toBeNull();
  });

  it("base sin migrar: la property se OMITE (migracion_pendiente), el cron responde 200 ok, nada se rompe", async () => {
    const { ctx, app } = await setup();
    ctx.identidadRepo.unavailable = true;
    const res = await app.request("/internal/hoteles/identidad-purga", { method: "POST", headers: cronHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; purgadas_total: number; corridas: { omitida: string | null }[] };
    expect(body).toMatchObject({ ok: true, purgadas_total: 0 });
    expect(body.corridas.every((r) => r.omitida === "migracion_pendiente")).toBe(true);
  });
});
