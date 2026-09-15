// Fix hallazgo CRÍTICO ("Alta de organización/property/tipos-de-habitación/
// tarifas/huéspedes imposible sin SQL directo -- POST /reservas depende de
// tarifas sembradas manualmente"): test de integración end-to-end (HTTP real vía
// app.request) de las 4 rutas nuevas de admin-catalogo.ts + las 2 rutas nuevas de
// reservas.ts (alta de huésped, asignación de habitación). El caso central
// (`upsertRatePlanRange` sembrando la tarifa que de verdad desbloquea
// POST .../reservas) se prueba de punta a punta: crear tipo de habitación -> crear
// tarifa -> crear reserva contra esa tarifa recién sembrada, sin ningún seed manual
// del repo en memoria.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

function patchedJson(token: string, body: unknown): RequestInit {
  return { ...authedJson(token, body), method: "PATCH" };
}

describe("POST /hoteles/:propertyId/tipos-habitacion", () => {
  it("owner/gm pueden crear un tipo de habitación real", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion`, authedJson(ctx.staff.owner.token, { nombre: "Suite Presidencial", capacidadMaxima: 4 }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; nombre: string; capacidadMaxima: number };
    expect(body).toMatchObject({ nombre: "Suite Presidencial", capacidadMaxima: 4 });

    // Aparece de inmediato en el catálogo de solo lectura ya existente.
    const list = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion`, authedJson(ctx.staff.housekeeping.token));
    const listBody = (await list.json()) as Array<{ id: string }>;
    expect(listBody.map((rt) => rt.id)).toContain(body.id);
  });

  it("frontdesk NO puede crear un tipo de habitación (fuera de ADMIN_ROLES)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion`, authedJson(ctx.staff.frontdesk.token, { nombre: "Suite Junior" }));
    expect(res.status).toBe(403);
  });

  it("nombre vacío -> 400 validation_error", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion`, authedJson(ctx.staff.owner.token, { nombre: "  " }));
    expect(res.status).toBe(400);
  });

  it("nombre duplicado en la misma property -> 409 conflict, nunca un 500 crudo", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    // "Habitación Doble Vista al Mar" ya existe en el fixture (ctx.roomTypeId).
    const res = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion`, authedJson(ctx.staff.owner.token, { nombre: "Habitación Doble Vista al Mar" }));
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "conflict" });
  });

  it("capacidadMaxima default (2) cuando se omite", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion`, authedJson(ctx.staff.gm.token, { nombre: "Habitación Sencilla" }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { capacidadMaxima: number }).capacidadMaxima).toBe(2);
  });
});

describe("POST /hoteles/:propertyId/tipos-habitacion/:roomTypeId/habitaciones + GET .../habitaciones", () => {
  it("owner crea una habitación física real; aparece en el listado filtrado por tipo", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion/${ctx.roomTypeId}/habitaciones`, authedJson(ctx.staff.owner.token, { codigo: "101" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; codigo: string; estado: string; roomTypeId: string };
    expect(body).toMatchObject({ codigo: "101", estado: "disponible", roomTypeId: ctx.roomTypeId });

    const list = await app.request(`/hoteles/${ctx.propertyId}/habitaciones?roomTypeId=${ctx.roomTypeId}`, authedJson(ctx.staff.housekeeping.token));
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as Array<{ id: string; codigo: string }>;
    expect(listBody.map((r) => r.id)).toContain(body.id);
  });

  it("frontdesk NO puede crear una habitación física (fuera de ADMIN_ROLES)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion/${ctx.roomTypeId}/habitaciones`, authedJson(ctx.staff.frontdesk.token, { codigo: "102" }));
    expect(res.status).toBe(403);
  });

  it("tipo de habitación inexistente -> 404", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/tipos-habitacion/00000000-0000-0000-0000-000000000000/habitaciones`,
      authedJson(ctx.staff.owner.token, { codigo: "103" }),
    );
    expect(res.status).toBe(404);
  });

  it("código duplicado en la misma property -> 409 conflict", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const first = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion/${ctx.roomTypeId}/habitaciones`, authedJson(ctx.staff.owner.token, { codigo: "201" }));
    expect(first.status).toBe(201);
    const second = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion/${ctx.roomTypeId}/habitaciones`, authedJson(ctx.staff.owner.token, { codigo: "201" }));
    expect(second.status).toBe(409);
  });

  it("GET .../habitaciones sin filtro trae todas las habitaciones de la property", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion/${ctx.roomTypeId}/habitaciones`, authedJson(ctx.staff.owner.token, { codigo: "301" }));
    const res = await app.request(`/hoteles/${ctx.propertyId}/habitaciones`, authedJson(ctx.staff.housekeeping.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ codigo: string }>;
    expect(body.some((r) => r.codigo === "301")).toBe(true);
  });
});

describe("POST /hoteles/:propertyId/tarifas -- la pieza que de verdad desbloqueaba POST /reservas", () => {
  it("owner siembra una tarifa real para un rango de fechas, y una reserva contra esas fechas ahora SÍ funciona", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    // Tipo de habitación nuevo, SIN ninguna tarifa sembrada por el fixture --
    // POST /reservas contra él debe fallar ANTES de sembrar la tarifa (con CERO
    // tarifas cargadas, `parseQuoteInput` rechaza el arreglo vacío con 400 --
    // "validation_error" -- antes siquiera de intentar resolver noche por noche;
    // ver quote.ts. El código real que este hallazgo desbloquea, `sin_tarifa`
    // (409), es lo que dispara cuando SÍ hay tarifas pero no cubren TODAS las
    // noches pedidas -- cualquiera de los dos códigos confirma el mismo punto: sin
    // sembrar, la reserva es imposible).
    const crearTipo = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion`, authedJson(ctx.staff.owner.token, { nombre: "Habitación Jardín" }));
    const tipo = (await crearTipo.json()) as { id: string };

    const antesDeSembrar = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: tipo.id, checkInDate: "2027-03-01", checkOutDate: "2027-03-03" }, { "idempotency-key": "k-sin-tarifa" }),
    );
    expect(antesDeSembrar.status).toBe(400);
    expect((await antesDeSembrar.json()) as { code: string }).toMatchObject({ code: "validation_error" });

    const tarifa = await app.request(
      `/hoteles/${ctx.propertyId}/tarifas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: tipo.id, fechaInicio: "2027-03-01", fechaFin: "2027-03-05", precio: 2000 }),
    );
    expect(tarifa.status).toBe(201);
    const tarifaBody = (await tarifa.json()) as { nochesSembradas: number; moneda: string };
    expect(tarifaBody.nochesSembradas).toBe(5); // 01,02,03,04,05 -- inclusive en ambos extremos
    expect(tarifaBody.moneda).toBe("MXN"); // default cuando se omite

    // Necesita también disponibilidad real (hoteles.availability, migrations/003) --
    // eso sigue siendo un gap de seed DISTINTO al de este hallazgo (alta de
    // inventario diario no es "tipos-de-habitación/tarifas/huéspedes", el hallazgo
    // asignado), así que este test la siembra directo por el repo -- sin ella,
    // reservar seguiría fallando honesto (`sin_disponibilidad`), nunca un
    // fake-success.
    ctx.hotelesRepo.seedAvailability(ctx.propertyId, tipo.id, "2027-03-01", 2, 0);
    ctx.hotelesRepo.seedAvailability(ctx.propertyId, tipo.id, "2027-03-02", 2, 0);
    const despuesDeSembrar = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: tipo.id, checkInDate: "2027-03-01", checkOutDate: "2027-03-03" }, { "idempotency-key": "k-con-tarifa" }),
    );
    expect(despuesDeSembrar.status).toBe(201);
    expect(((await despuesDeSembrar.json()) as { montoTotal: number }).montoTotal).toBe(4000); // 2 noches x 2000
  });

  it("frontdesk NO puede crear tarifas (fuera de ADMIN_ROLES)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/tarifas`,
      authedJson(ctx.staff.frontdesk.token, { roomTypeId: ctx.roomTypeId, fechaInicio: "2027-01-01", fechaFin: "2027-01-02", precio: 1000 }),
    );
    expect(res.status).toBe(403);
  });

  it("un segundo submit que traslapa fechas ya sembradas las SOBREESCRIBE (nunca falla por duplicado)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const primero = await app.request(
      `/hoteles/${ctx.propertyId}/tarifas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, fechaInicio: "2026-12-01", fechaFin: "2026-12-03", precio: 1500 }),
    );
    expect(primero.status).toBe(201);
    const segundo = await app.request(
      `/hoteles/${ctx.propertyId}/tarifas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, fechaInicio: "2026-12-02", fechaFin: "2026-12-04", precio: 1800 }),
    );
    expect(segundo.status).toBe(201);
    expect(((await segundo.json()) as { nochesSembradas: number }).nochesSembradas).toBe(3);
  });

  it("fechaFin anterior a fechaInicio -> 400 validation_error", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/tarifas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, fechaInicio: "2027-01-05", fechaFin: "2027-01-01", precio: 1000 }),
    );
    expect(res.status).toBe(400);
  });

  it("precio negativo -> 400 validation_error", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/tarifas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, fechaInicio: "2027-01-01", fechaFin: "2027-01-02", precio: -10 }),
    );
    expect(res.status).toBe(400);
  });

  it("tipo de habitación inexistente -> 404", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/tarifas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: "00000000-0000-0000-0000-000000000000", fechaInicio: "2027-01-01", fechaFin: "2027-01-02", precio: 1000 }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /hoteles/:propertyId/huespedes", () => {
  it("frontdesk registra un huésped real, que aparece de inmediato en la búsqueda", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/huespedes`, authedJson(ctx.staff.frontdesk.token, { nombreCompleto: "Luis Pérez", email: "luis@example.com", telefono: "5599998888" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; nombreCompleto: string };
    expect(body.nombreCompleto).toBe("Luis Pérez");

    const search = await app.request(`/hoteles/${ctx.propertyId}/huespedes?q=Luis`, authedJson(ctx.staff.frontdesk.token));
    expect(((await search.json()) as Array<{ id: string }>).map((g) => g.id)).toContain(body.id);
  });

  it("housekeeping NO puede dar de alta un huésped (fuera de MANAGE_RESERVATIONS_ROLES)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/huespedes`, authedJson(ctx.staff.housekeeping.token, { nombreCompleto: "Nadie" }));
    expect(res.status).toBe(403);
  });

  it("nombreCompleto vacío -> 400 validation_error", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/huespedes`, authedJson(ctx.staff.owner.token, { nombreCompleto: "   " }));
    expect(res.status).toBe(400);
  });

  it("email/telefono son opcionales -> null cuando se omiten", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/huespedes`, authedJson(ctx.staff.owner.token, { nombreCompleto: "Sin Contacto" }));
    expect(res.status).toBe(201);
    expect((await res.json()) as { email: null; telefono: null }).toMatchObject({ email: null, telefono: null });
  });
});

describe("PATCH /hoteles/:propertyId/reservas/:id/asignar-habitacion", () => {
  async function crearReserva(ctx: Awaited<ReturnType<typeof buildHotelesTestContext>>, app: ReturnType<typeof buildApp>, key: string) {
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-03" }, { "idempotency-key": key }),
    );
    return (await res.json()) as { id: string; roomTypeId: string; roomId: string | null };
  }

  it("asigna una habitación física real del mismo tipo de habitación -- roomId pasa de null a la habitación elegida", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const reserva = await crearReserva(ctx, app, "k-asignar-1");
    expect(reserva.roomId).toBeNull();

    const crearHabitacion = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion/${ctx.roomTypeId}/habitaciones`, authedJson(ctx.staff.owner.token, { codigo: "401" }));
    const habitacion = (await crearHabitacion.json()) as { id: string };

    const res = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/asignar-habitacion`, patchedJson(ctx.staff.frontdesk.token, { roomId: habitacion.id }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { roomId: string }).roomId).toBe(habitacion.id);
  });

  it("una habitación de un tipo DISTINTO al de la reserva -> 400, nunca se asigna un cuarto equivocado", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const reserva = await crearReserva(ctx, app, "k-asignar-2");

    const otroTipo = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion`, authedJson(ctx.staff.owner.token, { nombre: "Suite Distinta" }));
    const otroTipoBody = (await otroTipo.json()) as { id: string };
    const crearHabitacion = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion/${otroTipoBody.id}/habitaciones`, authedJson(ctx.staff.owner.token, { codigo: "501" }));
    const habitacion = (await crearHabitacion.json()) as { id: string };

    const res = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/asignar-habitacion`, patchedJson(ctx.staff.frontdesk.token, { roomId: habitacion.id }));
    expect(res.status).toBe(400);
  });

  it("habitación inexistente -> 404", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const reserva = await crearReserva(ctx, app, "k-asignar-3");
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reservas/${reserva.id}/asignar-habitacion`,
      patchedJson(ctx.staff.frontdesk.token, { roomId: "00000000-0000-0000-0000-000000000000" }),
    );
    expect(res.status).toBe(404);
  });

  it("reserva inexistente -> 404", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const crearHabitacion = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion/${ctx.roomTypeId}/habitaciones`, authedJson(ctx.staff.owner.token, { codigo: "601" }));
    const habitacion = (await crearHabitacion.json()) as { id: string };
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reservas/00000000-0000-0000-0000-000000000000/asignar-habitacion`,
      patchedJson(ctx.staff.owner.token, { roomId: habitacion.id }),
    );
    expect(res.status).toBe(404);
  });

  it("housekeeping NO puede asignar habitación (fuera de MANAGE_RESERVATIONS_ROLES)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const reserva = await crearReserva(ctx, app, "k-asignar-4");
    const crearHabitacion = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion/${ctx.roomTypeId}/habitaciones`, authedJson(ctx.staff.owner.token, { codigo: "701" }));
    const habitacion = (await crearHabitacion.json()) as { id: string };
    const res = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/asignar-habitacion`, patchedJson(ctx.staff.housekeeping.token, { roomId: habitacion.id }));
    expect(res.status).toBe(403);
  });
});
