// Test de integración end-to-end (HTTP real vía app.request, sin mockear el motor de
// dominio) de la máquina de estados de reservas de Fase 3 (H02, ver diseño Fase 3).
// Ejercita el flujo completo crear -> check-in -> en_estancia -> check-out -> cerrada,
// las guardas reales de la tabla de transiciones, el filtrado de roles finos por
// transición, cancelación con liberación de inventario, y el job de no-show con la
// penalización fiscal correcta (IVA sí, ISH no) posteada al folio primario.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
});

// `authedJson` (compartido con el resto de los tests de hoteles) siempre produce
// method: "POST" cuando hay body -- la ruta de transición usa PATCH real (mismo verbo
// que el diseño exige), así que se reusa su forma y solo se sobreescribe el método,
// sin tocar el fixture compartido.
function patchedJson(token: string, body: unknown, extraHeaders?: Record<string, string>): RequestInit {
  return { ...authedJson(token, body, extraHeaders), method: "PATCH" };
}

interface ReservaBody {
  id: string;
  estado: string;
  montoTotal: number;
  penalizacionCancelacion: number | null;
  canceladaEn: string | null;
}

describe("POST /hoteles/:propertyId/reservas -- creación", () => {
  it("exige el header Idempotency-Key", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-03" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "idempotency_required" });
  });

  it("housekeeping NO puede crear una reserva (fuera de MANAGE_RESERVATIONS_ROLES)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.housekeeping.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-03" }, { "idempotency-key": "k-hk-1" }),
    );
    expect(res.status).toBe(403);
  });

  it("crea la reserva directo en 'confirmada' (esta fase salta 'cotizada') y el folio primario nace en la misma operación", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.frontdesk.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-03" }, { "idempotency-key": "k-crear-1" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as ReservaBody;
    expect(body.estado).toBe("confirmada");
    expect(body.montoTotal).toBe(3000); // 2 noches x 1500 neto (SIN impuesto, ver ReservationRecord.totalAmount)

    const folios = await app.request(`/hoteles/${ctx.propertyId}/reservas/${body.id}/folios`, authedJson(ctx.staff.owner.token));
    const foliosBody = (await folios.json()) as Array<{ esPrincipal: boolean }>;
    expect(foliosBody).toHaveLength(1);
    expect(foliosBody[0]!.esPrincipal).toBe(true);
  });

  it("mismo Idempotency-Key + mismo body -> devuelve la MISMA reserva, nunca reserva inventario dos veces", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const body = { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-02" };
    const key = "k-idem-reserva";
    const first = await app.request(`/hoteles/${ctx.propertyId}/reservas`, authedJson(ctx.staff.owner.token, body, { "idempotency-key": key }));
    const second = await app.request(`/hoteles/${ctx.propertyId}/reservas`, authedJson(ctx.staff.owner.token, body, { "idempotency-key": key }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as ReservaBody;
    const secondBody = (await second.json()) as ReservaBody;
    expect(secondBody.id).toBe(firstBody.id);

    // La noche solo se reservó UNA vez -- todavía queda 1 de las 2 habitaciones
    // seedeadas libre para otra reserva real.
    await expect(ctx.hotelesRepo.bookAvailability(ctx.propertyId, ctx.roomTypeId, "2026-12-01", 1)).resolves.toBeUndefined();
  });

  it("rechaza crear sin disponibilidad -- 409 explícito, nunca oversells silenciosamente", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const body = { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-02" };
    // La property de prueba solo tiene 2 habitaciones libres esa noche (fixtures).
    const first = await app.request(`/hoteles/${ctx.propertyId}/reservas`, authedJson(ctx.staff.owner.token, body, { "idempotency-key": "k-ocupa-1" }));
    const second = await app.request(`/hoteles/${ctx.propertyId}/reservas`, authedJson(ctx.staff.owner.token, body, { "idempotency-key": "k-ocupa-2" }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const third = await app.request(`/hoteles/${ctx.propertyId}/reservas`, authedJson(ctx.staff.owner.token, body, { "idempotency-key": "k-ocupa-3" }));
    expect(third.status).toBe(409);
    expect((await third.json()) as { code: string }).toMatchObject({ code: "sin_disponibilidad" });
  });
});

describe("PATCH /hoteles/:propertyId/reservas/:id/transicion", () => {
  async function crearReserva(ctx: Awaited<ReturnType<typeof buildHotelesTestContext>>, app: ReturnType<typeof buildApp>, key: string) {
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-03" }, { "idempotency-key": key }),
    );
    return (await res.json()) as ReservaBody;
  }

  it("flujo completo real: crear -> check_in -> en_estancia -> check_out -> cerrada", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const reserva = await crearReserva(ctx, app, "k-flujo-1");

    const checkIn = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/transicion`, patchedJson(ctx.staff.frontdesk.token, { toStatus: "check_in" }));
    expect(checkIn.status).toBe(200);
    expect(((await checkIn.json()) as ReservaBody).estado).toBe("check_in");

    const enEstancia = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/transicion`, patchedJson(ctx.staff.frontdesk.token, { toStatus: "en_estancia" }));
    expect(enEstancia.status).toBe(200);
    expect(((await enEstancia.json()) as ReservaBody).estado).toBe("en_estancia");

    const checkOut = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/transicion`, patchedJson(ctx.staff.frontdesk.token, { toStatus: "check_out" }));
    expect(checkOut.status).toBe(200);
    expect(((await checkOut.json()) as ReservaBody).estado).toBe("check_out");

    // El cierre lo puede hacer accountant (además de owner/gm/frontdesk) -- único paso
    // de la máquina donde ese rol aparece.
    const cerrada = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/transicion`, patchedJson(ctx.staff.accountant.token, { toStatus: "cerrada" }));
    expect(cerrada.status).toBe(200);
    expect(((await cerrada.json()) as ReservaBody).estado).toBe("cerrada");
  });

  it("rechaza saltarse pasos (confirmada -> en_estancia directo) -- 409 transicion_invalida", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const reserva = await crearReserva(ctx, app, "k-flujo-2");
    const res = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/transicion`, patchedJson(ctx.staff.frontdesk.token, { toStatus: "en_estancia" }));
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "transicion_invalida" });
  });

  it("rechaza 'cancelada'/'no_show' por esta ruta genérica -- 400, tienen su propia ruta con efectos secundarios", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const reserva = await crearReserva(ctx, app, "k-flujo-3");
    const res = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/transicion`, patchedJson(ctx.staff.frontdesk.token, { toStatus: "cancelada" }));
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "transicion_no_permitida_por_ruta" });
  });

  it("'reservations' NO puede hacer confirmada->check_in (rol fino por transición, no un rol fijo por ruta)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const reserva = await crearReserva(ctx, app, "k-flujo-4");
    const res = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/transicion`, patchedJson(ctx.staff.reservations.token, { toStatus: "check_in" }));
    expect(res.status).toBe(403);
  });

  it("una reserva inexistente devuelve 404", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/reservas/00000000-0000-0000-0000-000000000000/transicion`, patchedJson(ctx.staff.owner.token, { toStatus: "check_in" }));
    expect(res.status).toBe(404);
  });
});

describe("POST /hoteles/:propertyId/reservas/:id/cancelar", () => {
  it("cancela antes de check-in, aplica la política de cancelación y libera el inventario", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const crear = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-02" }, { "idempotency-key": "k-cancel-1" }),
    );
    const reserva = (await crear.json()) as ReservaBody;

    const cancelar = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/cancelar`, authedJson(ctx.staff.frontdesk.token, {}));
    expect(cancelar.status).toBe(200);
    const canceladaBody = (await cancelar.json()) as ReservaBody;
    expect(canceladaBody.estado).toBe("cancelada");
    expect(canceladaBody.canceladaEn).not.toBeNull();
    // Política de fixtures: freeUntilHours=48 -- "now" real está muy lejos de
    // 2026-12-01, así que la cancelación es libre (penalización 0).
    expect(canceladaBody.penalizacionCancelacion).toBe(0);

    // Inventario liberado -- las 2 habitaciones vuelven a estar libres esa noche.
    await expect(ctx.hotelesRepo.bookAvailability(ctx.propertyId, ctx.roomTypeId, "2026-12-01", 2)).resolves.toBeUndefined();
  });

  it("después de check-in ya NO se puede cancelar -- 409 explícito (isCancellable)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const crear = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-02" }, { "idempotency-key": "k-cancel-2" }),
    );
    const reserva = (await crear.json()) as ReservaBody;
    await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/transicion`, patchedJson(ctx.staff.frontdesk.token, { toStatus: "check_in" }));

    const cancelar = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/cancelar`, authedJson(ctx.staff.frontdesk.token, {}));
    expect(cancelar.status).toBe(409);
    expect((await cancelar.json()) as { code: string }).toMatchObject({ code: "reserva_no_cancelable" });
  });

  it("cancelar dos veces la misma reserva -- la segunda es 409, nunca libera inventario dos veces", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const crear = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-02" }, { "idempotency-key": "k-cancel-3" }),
    );
    const reserva = (await crear.json()) as ReservaBody;
    const first = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/cancelar`, authedJson(ctx.staff.owner.token, {}));
    expect(first.status).toBe(200);
    const second = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/cancelar`, authedJson(ctx.staff.owner.token, {}));
    expect(second.status).toBe(409);
  });
});

describe("POST /hoteles/:propertyId/reservas/procesar-no-show", () => {
  it("requiere ADMIN_ROLES -- frontdesk no puede dispararlo", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/reservas/procesar-no-show`, authedJson(ctx.staff.frontdesk.token, {}));
    expect(res.status).toBe(403);
  });

  it("reclama las reservas 'confirmada' vencidas, libera inventario y postea la penalización SIN ISH al folio primario", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const crear = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2025-01-10", checkOutDate: "2025-01-11" }, { "idempotency-key": "k-noshow-1" }),
    );
    expect(crear.status).toBe(201);
    const reserva = (await crear.json()) as ReservaBody;
    expect(reserva.montoTotal).toBe(1500); // 1 noche x 1500, neto

    const noShow = await app.request(`/hoteles/${ctx.propertyId}/reservas/procesar-no-show`, authedJson(ctx.staff.owner.token, { asOfDate: "2025-01-10" }));
    expect(noShow.status).toBe(200);
    const noShowBody = (await noShow.json()) as { procesadas: number; detalle: Array<{ reservationId: string; folioId: string; penalizacionNeta: number; penalizacionImpuesto: number }> };
    expect(noShowBody.procesadas).toBe(1);
    expect(noShowBody.detalle[0]!.reservationId).toBe(reserva.id);
    expect(noShowBody.detalle[0]!.penalizacionNeta).toBe(1500);
    expect(noShowBody.detalle[0]!.penalizacionImpuesto).toBe(240); // SOLO 16% IVA -- NUNCA el 3% de ISH (§3.4)

    const consulta = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}`, authedJson(ctx.staff.owner.token));
    expect(((await consulta.json()) as ReservaBody).estado).toBe("no_show");

    // Inventario liberado -- vuelven a caber las 2 habitaciones seedeadas esa noche.
    await expect(ctx.hotelesRepo.bookAvailability(ctx.propertyId, ctx.roomTypeId, "2025-01-10", 2)).resolves.toBeUndefined();

    // La penalización se posteó SIN stayDate -- nunca choca con el índice
    // anti-doble-captura del night-audit, que solo protege cargos de hospedaje CON
    // noche real posteada (diseño §1).
    await expect(
      ctx.hotelesRepo.insertCharge({
        organizationId: ctx.organizationId,
        propertyId: ctx.propertyId,
        folioId: noShowBody.detalle[0]!.folioId,
        description: "Cargo de night-audit (simulado)",
        amount: 1500,
        taxAmount: 285,
        concept: "hospedaje",
        stayDate: "2025-01-10",
      }),
    ).resolves.toBeDefined();
  });

  it("no reclama dos veces la misma reserva si se corre el job otra vez (reclamo atómico)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const crear = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2025-01-10", checkOutDate: "2025-01-11" }, { "idempotency-key": "k-noshow-2" }),
    );
    const reserva = (await crear.json()) as ReservaBody;

    const first = await app.request(`/hoteles/${ctx.propertyId}/reservas/procesar-no-show`, authedJson(ctx.staff.owner.token, { asOfDate: "2025-01-10" }));
    expect(((await first.json()) as { procesadas: number }).procesadas).toBe(1);

    const second = await app.request(`/hoteles/${ctx.propertyId}/reservas/procesar-no-show`, authedJson(ctx.staff.owner.token, { asOfDate: "2025-01-10" }));
    expect(((await second.json()) as { procesadas: number }).procesadas).toBe(0); // ya no está 'confirmada' -- se salta, no se reintenta.
    void reserva;
  });

  it("nunca reclama una reserva cuyo check-in todavía no llega", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-02" }, { "idempotency-key": "k-noshow-3" }),
    );
    const res = await app.request(`/hoteles/${ctx.propertyId}/reservas/procesar-no-show`, authedJson(ctx.staff.owner.token, { asOfDate: "2025-01-01" }));
    expect(((await res.json()) as { procesadas: number }).procesadas).toBe(0);
  });

  // REQ-r6/f2-current-date-fecha-negocio: sin `asOfDate` en el body, el default debe
  // ser el día de NEGOCIO (`hoyFechaNegocio()`), nunca `current_date` de la sesión de
  // Postgres (UTC en Vercel). A las 19:30 CDMX el día UTC YA es mañana -- si el
  // default usara ese día UTC, una reserva cuyo check-in es MAÑANA (día de negocio)
  // se reclamaría como no-show un día antes de tiempo.
  it("sin asOfDate, a las 19:30 CDMX, NO reclama una reserva cuyo check-in es MAÑANA (día de negocio), aunque el día UTC ya sea mañana", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const crear = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2025-01-10", checkOutDate: "2025-01-11" }, { "idempotency-key": "k-noshow-4" }),
    );
    // Hallazgo no-bloqueante de revisión (PR #182): sin afirmar el status aquí, una
    // creación fallida (0 reservas sembradas) pasaría inadvertida -- el `procesadas:
    // 0` de abajo se vería igual tanto si el fix funciona como si la reserva nunca
    // se creó.
    expect(crear.status).toBe(201);

    // 2025-01-10T01:30:00Z = 2025-01-09T19:30:00 en America/Mexico_City (UTC-6 fijo)
    // -- el día UTC ya es "2025-01-10" (el mismo día del check-in), pero en CDMX
    // todavía es "2025-01-09".
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-10T01:30:00.000Z"));

    const res = await app.request(`/hoteles/${ctx.propertyId}/reservas/procesar-no-show`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { procesadas: number };
    expect(body.procesadas).toBe(0);

    // Control positivo (mismo reloj falso, misma reserva): un `asOfDate` explícito
    // que SÍ coincide con el check-in confirma que la ruta puede reclamar cuando
    // corresponde -- sin este control, un `procesadas: 0` que en realidad viniera de
    // una query rota (no de la fecha) también pasaría el test de arriba.
    const control = await app.request(`/hoteles/${ctx.propertyId}/reservas/procesar-no-show`, authedJson(ctx.staff.owner.token, { asOfDate: "2025-01-10" }));
    expect(control.status).toBe(200);
    expect(((await control.json()) as { procesadas: number }).procesadas).toBe(1);
  });
});

describe("GET /hoteles/:propertyId/reservas", () => {
  it("lista las reservas de la property, accesible a cualquier staff", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-02" }, { "idempotency-key": "k-lista-1" }),
    );
    const res = await app.request(`/hoteles/${ctx.propertyId}/reservas`, authedJson(ctx.staff.housekeeping.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReservaBody[];
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  // Hallazgo de auditoría (rubro 10, "performance y escalabilidad", severidad BAJA):
  // "listados sin paginación en 4 verticales" -- devolvía TODAS las reservas de la
  // property en un solo array, sin límite. Con N=5 reservas y limit=2, la query debe
  // quedar ACOTADA (nunca "todo de una vez"), y X-Total-Count/X-Next-Offset deben
  // permitir recorrer las 5 sin duplicar ni omitir ninguna.
  it("con N=5 reservas y limit=2, la query queda acotada -- X-Total-Count/X-Next-Offset recorren las 5 sin duplicar ni omitir", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    // 2 habitaciones libres por noche (ver hoteles-fixtures.ts) -- reparte las 5
    // reservas entre los 3 pares fecha in/out sembrados para nunca chocar con el
    // inventario real (2+2+1 = 5, cada rango con <= 2 reservas simultáneas).
    const RANGOS: readonly [string, string][] = [
      ["2026-12-01", "2026-12-02"],
      ["2026-12-01", "2026-12-02"],
      ["2026-12-02", "2026-12-03"],
      ["2026-12-02", "2026-12-03"],
      ["2025-01-10", "2025-01-11"],
    ];
    const N = RANGOS.length;
    for (let i = 0; i < N; i += 1) {
      const [checkInDate, checkOutDate] = RANGOS[i]!;
      const res = await app.request(
        `/hoteles/${ctx.propertyId}/reservas`,
        authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate, checkOutDate }, { "idempotency-key": `k-pagina-${i}` }),
      );
      expect(res.status).toBe(201);
    }

    const idsVistos = new Set<string>();
    let offset = 0;
    let paginas = 0;
    for (;;) {
      const res = await app.request(`/hoteles/${ctx.propertyId}/reservas?limit=2&offset=${offset}`, authedJson(ctx.staff.housekeeping.token));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-total-count")).toBe(String(N));
      const pagina = (await res.json()) as ReservaBody[];
      expect(pagina.length).toBeLessThanOrEqual(2);
      for (const r of pagina) idsVistos.add(r.id);
      paginas += 1;
      const nextOffset = res.headers.get("x-next-offset");
      if (nextOffset === null) break;
      offset = Number(nextOffset);
      expect(paginas).toBeLessThan(10);
    }

    expect(idsVistos.size).toBe(N);
    expect(paginas).toBe(3); // ceil(5/2)
  });
});

// Fix hallazgo ALTA — catálogos que le faltaban al formulario de "crear reserva":
// sin esto, roomTypeId/guestId solo se podían obtener copiando un UUID a mano desde
// otro lado (ver reservas.ts, comentario de cabecera de las nuevas rutas).
describe("GET /hoteles/:propertyId/tipos-habitacion", () => {
  it("lista el catálogo de tipos de habitación de la property, accesible a cualquier staff", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/tipos-habitacion`, authedJson(ctx.staff.housekeeping.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; nombre: string; capacidadMaxima: number }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: ctx.roomTypeId, nombre: "Habitación Doble Vista al Mar", capacidadMaxima: 2 });
  });

  it("una property sin tipos de habitación configurados devuelve una lista vacía, nunca un error", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const otraPropertyId = "00000000-0000-0000-0000-000000000000";
    // Sin membership a esta property -- 403, no llega ni a preguntarle al repo (mismo
    // criterio de autorización que el resto de rutas de este archivo).
    const res = await app.request(`/hoteles/${otraPropertyId}/tipos-habitacion`, authedJson(ctx.staff.owner.token));
    expect(res.status).toBe(403);
  });
});

describe("GET /hoteles/:propertyId/huespedes", () => {
  it("sin `q` devuelve el catálogo completo de huéspedes de la property", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/huespedes`, authedJson(ctx.staff.frontdesk.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; nombreCompleto: string; email: string | null; telefono: string | null }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: ctx.guestId, nombreCompleto: "Ana Torres", email: "ana.torres@example.com", telefono: "5511112222" });
  });

  it("con `q` filtra por nombre/email/teléfono, insensible a mayúsculas", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const porNombre = await app.request(`/hoteles/${ctx.propertyId}/huespedes?q=torres`, authedJson(ctx.staff.frontdesk.token));
    expect(porNombre.status).toBe(200);
    expect(((await porNombre.json()) as Array<{ id: string }>).map((g) => g.id)).toEqual([ctx.guestId]);

    const sinMatch = await app.request(`/hoteles/${ctx.propertyId}/huespedes?q=nadie-existe-xyz`, authedJson(ctx.staff.frontdesk.token));
    expect(sinMatch.status).toBe(200);
    expect(await sinMatch.json()).toEqual([]);
  });

  it("cualquier staff de la property puede leer (mismo criterio que GET /reservas), sin rol fino", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/huespedes`, authedJson(ctx.staff.housekeeping.token));
    expect(res.status).toBe(200);
  });
});
