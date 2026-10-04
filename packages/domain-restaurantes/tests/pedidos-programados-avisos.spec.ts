// Aviso al staff al promover un pedido programado: bandeja (`order.programado_promovido`) + campana in-app del catalogo.
// Contra una base SIN migrar (42883/23514/P0001 en el evento nuevo) el aviso se degrada SIN abortar la transaccion
// compartida: se prueba con AbortAwareFakeSession (reproduce 25P02), no con una sesion falsa plana.
import { describe, expect, it, vi } from "vitest";
import { avisarProgramadosPromovidos } from "../src/pedidos-programados-avisos.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import type { Order } from "../src/types.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const HORA = "2026-10-03T20:00:00.000Z";

function promovidoDe(f: ReturnType<typeof buildRestaurantFixture>, extra: Partial<Order> = {}): Order {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    organizationId: f.organizationId,
    propertyId: f.propertyId,
    customerName: "Marcela Pech",
    customerPhone: "9991234567",
    branch: "Francisco de Montejo",
    total: 85.5,
    status: "pending",
    programadoPara: HORA,
    items: [],
    ...extra,
  } as unknown as Order;
}

describe("avisarProgramadosPromovidos (en memoria)", () => {
  it("deja UN aviso de bandeja por pedido, idempotente, con la hora en la zona de la sucursal y sin duplicar al reintentar", async () => {
    const f = buildRestaurantFixture();
    await f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
    const session = new AbortAwareFakeSession([{ match: /core\.emit_notification/, respond: () => [{ emit_notification: 1 }] }]);
    const order = promovidoDe(f);
    // en memoria `createStaffOrderNotification` exige un pedido real: se usa el repo en memoria tal cual (sin FK).
    const r1 = await avisarProgramadosPromovidos(f.repo, session, [order]);
    const r2 = await avisarProgramadosPromovidos(f.repo, session, [order]);
    expect(r1).toEqual({ intentados: 1, bandeja: 1, errores: 0 });
    expect(r2.bandeja).toBe(1);
    const bandeja = await f.repo.listStaffOrderNotifications(f.organizationId, null);
    expect(bandeja).toHaveLength(1);
    expect(bandeja[0]).toMatchObject({ eventType: "order.programado_promovido", orderId: order.id });
    expect(bandeja[0]!.message).toContain("entró a cocina");
    expect(bandeja[0]!.message).toContain("sábado 03/10 14:00");
    // La campana: una emision por pedido, con la clave de dedupe = id del pedido y SIN PII en lo que viaja a la base.
    const emitidas = session.calls.filter((c) => c.includes("core.emit_notification"));
    expect(emitidas.length).toBe(2); // una por llamada (el dedupe real lo hace core.emit_notification con la clave)
  });

  it("solo avisa de pedidos `pending`: uno cancelado o aun programado nunca avisa", async () => {
    const f = buildRestaurantFixture();
    const session = new AbortAwareFakeSession([{ match: /core\.emit_notification/, respond: () => [{ emit_notification: 1 }] }]);
    const r = await avisarProgramadosPromovidos(f.repo, session, [promovidoDe(f, { status: "cancelado" }), promovidoDe(f, { status: "programado" })]);
    expect(r.intentados).toBe(0);
    expect(await f.repo.listStaffOrderNotifications(f.organizationId, null)).toHaveLength(0);
  });
});

describe("avisarProgramadosPromovidos contra base sin migrar (sesion con semantica 25P02)", () => {
  it("el evento nuevo rechazado por la base NO aborta la sesion: la campana se emite despues y el resto del lote sigue", async () => {
    const f = buildRestaurantFixture();
    const rechazo = Object.assign(new Error("invalid staff order notification event_type"), { code: "P0001" });
    const session = new AbortAwareFakeSession([
      { match: /enqueue_staff_order_notification/, respond: () => rechazo },
      { match: /branch_detail/, respond: () => [{ zona_horaria: "America/Merida" }] },
      { match: /core\.emit_notification/, respond: () => [{ emit_notification: 1 }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await avisarProgramadosPromovidos(repo, session, [promovidoDe(f), promovidoDe(f, { id: "00000000-0000-4000-8000-0000000000a2" })]);
    error.mockRestore();
    expect(r).toEqual({ intentados: 2, bandeja: 0, errores: 2 });
    // Cada fallo se aislo con ROLLBACK TO SAVEPOINT y la campana (que corre DESPUES) sigue funcionando: sin 25P02.
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBeGreaterThanOrEqual(2);
    expect(session.calls.filter((c) => c.includes("core.emit_notification"))).toHaveLength(2);
  });

  it("la campana sin migrar (42883 en core.emit_notification) degrada a 'no_disponible': ni lanza ni cuenta como error", async () => {
    const f = buildRestaurantFixture();
    const session = new AbortAwareFakeSession([
      { match: /enqueue_staff_order_notification/, respond: () => [{ id: "n1", created_at: "2026-10-03", acknowledged_at: null, acknowledged_by: null }] },
      { match: /branch_detail/, respond: () => [{ zona_horaria: null }] },
      { match: /core\.emit_notification/, respond: () => Object.assign(new Error("function core.emit_notification(uuid, uuid, text) does not exist"), { code: "42883" }) },
    ]);
    const r = await avisarProgramadosPromovidos(new PostgresRestaurantesRepository(session), session, [promovidoDe(f)]);
    expect(r).toEqual({ intentados: 1, bandeja: 1, errores: 0 });
  });
});
