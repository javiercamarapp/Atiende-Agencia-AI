// Test de integración end-to-end (HTTP real vía app.request, sin mockear el motor de
// dominio) del flujo 1 elegido para Fase 1 de rentas: anti-doble-reserva de calendario
// con SAVEPOINT/ROLLBACK TO SAVEPOINT + advisory lock real (ver diseño Fase 1 rentas
// §4, Flujo 1). Ejercita comportamiento real: concurrencia real (dos requests HTTP
// disparadas en paralelo), el guardia "nunca tocar una reserva de canal externo", y el
// filtrado de roles finos -- no un happy-path decorativo.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { crearReservaConfirmada } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

describe("POST /rentas/:propertyId/unidades/:unidadId/reservas", () => {
  it("crea una reserva confirmada real, sin conflicto", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-01", fin: "2026-06-05" } }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; conflictosCapaCruzada: number };
    expect(body.id).toBeTruthy();
    expect(body.conflictosCapaCruzada).toBe(0);
  });

  it("con huespedNombre/huespedContacto, adjunta el huésped mínimo a la ocupación creada", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-10", fin: "2026-06-12" }, huespedNombre: "Ana Pérez", huespedContacto: "+52 55 1234 5678" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const fila = ctx.engine.calendarStore.getOcupacion(body.id)!;
    expect(fila.huespedMinimoId).not.toBeNull();
  });

  // Fase 9 -- correo de confirmación real al huésped (best-effort, encolado vía
  // rentas.messaging_outbox channel='email', ver
  // @atiende/domain-rentas::enqueueReservaEmailCore). Cierra el gap donde este
  // envío estaba documentado como diferido ("no hay motor de correo migrado a
  // atiende-fusion todavía").
  it("huespedContacto con correo real: encola la confirmación en rentas.messaging_outbox", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-07-01", fin: "2026-07-03" }, huespedNombre: "Ana Pérez", huespedContacto: "ana@example.com" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };

    const job = ctx.rentasRepo.getMessagingOutbox().find((o) => o.channel === "email" && o.eventType === "reserva.creada");
    expect(job).toBeDefined();
    expect(job!.dedupeKey).toBe(`creada:${body.id}`);
    const payload = job!.payload as { to: string; subject: string; html: string };
    expect(payload.to).toBe("ana@example.com");
    expect(payload.subject).toContain("Reserva confirmada");
    expect(payload.html).toContain("Ana Pérez");
  });

  // Cierre del hallazgo "rentas no tiene disparo inline de correo, solo el cron
  // diario -- un correo encolado puede tardar hasta ~24h en salir" (ver
  // ../src/routes/verticals/rentas/email-dispatch.ts::triggerRentasEmailDispatchInline).
  // Mismo criterio que hoteles-guest-emails.spec.ts/citas-appointments.spec.ts: se
  // verifica el envío inline SIN llamar aparte a /internal/rentas/email-dispatch.
  it("crear la reserva dispara el envío inline del correo real dentro del mismo request", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-08-01", fin: "2026-08-03" }, huespedNombre: "Ana Pérez", huespedContacto: "ana@example.com" }),
    );
    // La reserva se creó bien aunque el envío del correo falle -- best-effort
    // real, sin RESEND_API_KEY en este fixture (ver TEST_ENV.resend.apiKey === null).
    expect(res.status).toBe(201);

    // Sin ningún POST/GET a /internal/rentas/email-dispatch de por medio: el
    // disparo inline (triggerRentasEmailDispatchInline) ya reclamó el job y marcó
    // el intento fallido DENTRO de este mismo request -- nunca se queda en
    // 'pending' esperando al cron diario.
    const job = ctx.rentasRepo.getMessagingOutbox().find((o) => o.channel === "email" && o.eventType === "reserva.creada");
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(1);
  });

  it("huespedContacto sin correo real (solo teléfono): no encola ningún correo (nunca es un error para la reserva)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-07-05", fin: "2026-07-07" }, huespedNombre: "Luis Ruiz", huespedContacto: "+52 55 1234 5678" }),
    );
    expect(res.status).toBe(201);
    expect(ctx.rentasRepo.getMessagingOutbox().filter((o) => o.channel === "email")).toHaveLength(0);
  });

  it("un rol de SOLO calendario (lectura) no puede crear reservas -- 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`,
      authedJson(ctx.staff.operadorSoloCalendario.token, { rango: { inicio: "2026-06-01", fin: "2026-06-02" } }),
    );
    expect(res.status).toBe(403);
  });

  it("una unidad que no pertenece a esta property -> 404 (defensa en profundidad)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/00000000-0000-4000-8000-000000000000/reservas`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-01", fin: "2026-06-02" } }),
    );
    expect(res.status).toBe(404);
  });

  it("un rango con formato inválido -> 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "01/06/2026", fin: "2026-06-02" } }),
    );
    expect(res.status).toBe(400);
  });

  it("CONCURRENCIA REAL: dos POST disparados en paralelo sobre el MISMO rango -- exactamente uno gana (201), el otro recibe 409 unidad_no_disponible; nunca las dos reservas activas a la vez", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const body = { rango: { inicio: "2026-10-01", fin: "2026-10-05" } };

    const [resA, resB] = await Promise.all([
      app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, body)),
      app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.operadorAccesoTotal.token, body)),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const ganadora = resA.status === 201 ? resA : resB;
    const perdedora = resA.status === 201 ? resB : resA;
    const perdedoraBody = (await perdedora.json()) as { code: string };
    expect(perdedoraBody.code).toBe("unidad_no_disponible");
    void ganadora;

    const activas = [...ctx.engine.calendarStore.ocupaciones.values()].filter((o) => o.unidadId === ctx.unidadId && o.estado !== "cancelado" && o.bloqueante);
    expect(activas).toHaveLength(1);
  });
});

describe("PATCH /rentas/:propertyId/unidades/:unidadId/reservas/:ocupacionId", () => {
  it("amplía las fechas de una reserva directa existente", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creada = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-01", fin: "2026-06-05" } }));
    const { id } = (await creada.json()) as { id: string };

    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${id}`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-05-30", fin: "2026-06-07" } }, {}, "PATCH"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rango: { inicio: string; fin: string } };
    expect(body.rango).toEqual({ inicio: "2026-05-30", fin: "2026-06-07" });
  });

  it("NUNCA modifica una reserva de canal externo -- 409 reserva_no_directa", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const canalAirbnb = ctx.engine.calendarStore.findCanalPorCodigo("airbnb")!;
    const externa = await ctx.engine.withAppSession({ userId: null }, (session: TenantDbSession) =>
      crearReservaConfirmada(session, {
        organizationId: ctx.organizationId,
        propertyId: ctx.propertyId,
        unidadId: ctx.unidadId,
        rango: { inicio: "2026-07-01", fin: "2026-07-05" },
        estado: "confirmado",
        bloqueante: true,
        canalOrigenId: canalAirbnb.id,
        externalId: "airbnb-externa-1",
      }),
    );

    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${externa.ocupacionId}`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-07-02", fin: "2026-07-06" } }, {}, "PATCH"),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("reserva_no_directa");
  });
});

describe("POST /rentas/:propertyId/unidades/:unidadId/reservas/:ocupacionId/cancelar", () => {
  it("cancela una reserva directa", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creada = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-01", fin: "2026-06-05" } }));
    const { id } = (await creada.json()) as { id: string };

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${id}/cancelar`, authedJson(ctx.staff.adminGestora.token, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; estadoAnterior: string };
    expect(body.estado).toBe("cancelado");
    expect(body.estadoAnterior).toBe("confirmado");
  });

  it("cancelar exige el rol más estricto (H-018): operador:solo_calendario NO puede cancelar -- 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creada = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-01", fin: "2026-06-05" } }));
    const { id } = (await creada.json()) as { id: string };

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${id}/cancelar`, authedJson(ctx.staff.operadorSoloCalendario.token, {}));
    expect(res.status).toBe(403);
  });

  it("operador:acceso_total SÍ puede cancelar", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creada = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-01", fin: "2026-06-05" } }));
    const { id } = (await creada.json()) as { id: string };

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${id}/cancelar`, authedJson(ctx.staff.operadorAccesoTotal.token, {}));
    expect(res.status).toBe(200);
  });

  it("cancelar una reserva ya cancelada -> 409", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const creada = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-01", fin: "2026-06-05" } }));
    const { id } = (await creada.json()) as { id: string };
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${id}/cancelar`, authedJson(ctx.staff.adminGestora.token, {}));

    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${id}/cancelar`, authedJson(ctx.staff.adminGestora.token, {}));
    expect(res.status).toBe(409);
  });
});
