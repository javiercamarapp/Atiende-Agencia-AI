// R-11: pedidos programados -- validacion de la hora (zona del negocio, cruces de medianoche, puentes), estado
// `programado`, auto-promocion idempotente y compatibilidad con la base sin migrar. Corre sobre el
// repositorio en memoria con el reloj de `Date` congelado (nunca setInterval: sin relojes con timers vivos).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderValidationError } from "../src/errors.ts";
import { changeOrderStatus, OrderStatusTransitionError } from "../src/order-lifecycle.ts";
import { createOrder } from "../src/orders.ts";
import {
  ANTICIPACION_PROMOCION_MIN,
  parsearProgramadoPara,
  promoverProgramadosTodasLasOrganizaciones,
  promoverProgramadosVencidos,
  validarVentanaProgramacion,
} from "../src/pedidos-programados.ts";
import { RestaurantesConfigUnavailableError } from "../src/repository.ts";
import type { CreateOrderInput } from "../src/types.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

// Viernes 2026-10-02 12:00 en Merida (UTC-6, sin horario de verano).
const AHORA = new Date("2026-10-02T12:00:00-06:00");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AHORA);
});
afterEach(() => {
  vi.useRealTimers();
});

function pedido(f: ReturnType<typeof buildRestaurantFixture>, extra: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    organizationId: f.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Marcela Pech",
    customerPhone: "9991234567",
    customerAddress: "Calle 7 #210, Vista Alegre",
    items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }],
    source: "web",
    ...extra,
  };
}

/** Viernes y sabado de 12:00 a 01:00 (el turno cruza la medianoche). */
function horarioViernesSabado(f: ReturnType<typeof buildRestaurantFixture>, zona = "America/Merida") {
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, zona);
}

describe("parsearProgramadoPara / validarVentanaProgramacion", () => {
  it("acepta ISO con zona y lo normaliza a UTC", () => {
    expect(parsearProgramadoPara("2026-10-03T14:00:00-06:00")).toBe("2026-10-03T20:00:00.000Z");
    expect(parsearProgramadoPara("2026-10-03T20:00Z")).toBe("2026-10-03T20:00:00.000Z");
  });

  it.each(["2026-10-03T14:00:00", "mañana a las 2", "2026-13-40T14:00:00-06:00", "", 12345, null])("rechaza %j (sin zona o invalida)", (raw) => {
    expect(() => parsearProgramadoPara(raw)).toThrow(OrderValidationError);
  });

  it("ventana: justo en el minimo se acepta, un minuto antes no; el maximo son 7 dias", () => {
    const enMin = (m: number) => new Date(AHORA.getTime() + m * 60_000).toISOString();
    expect(() => validarVentanaProgramacion(enMin(ANTICIPACION_PROMOCION_MIN), AHORA)).not.toThrow();
    expect(() => validarVentanaProgramacion(enMin(ANTICIPACION_PROMOCION_MIN - 1), AHORA)).toThrow(/al menos 30 minutos/);
    expect(() => validarVentanaProgramacion(enMin(7 * 24 * 60), AHORA)).not.toThrow();
    expect(() => validarVentanaProgramacion(enMin(7 * 24 * 60 + 1), AHORA)).toThrow(/7 días/);
    expect(() => validarVentanaProgramacion(enMin(-60), AHORA)).toThrow(OrderValidationError);
  });
});

describe("crear un pedido programado", () => {
  it("queda en estado programado con su hora, fuera de la lista de pendientes", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, pedido(f, { programadoPara: "2026-10-03T14:00:00-06:00" }));
    expect(order.status).toBe("programado");
    expect(order.programadoPara).toBe("2026-10-03T20:00:00.000Z");
    expect(order.notes).toContain("Pedido programado para: sábado 03/10 14:00.");
    const pendientes = await f.repo.listOrders(f.organizationId, { propertyIds: null, status: "pending", limit: 50 });
    expect(pendientes.orders).toHaveLength(0);
    const programados = await f.repo.listScheduledOrders(f.organizationId, { propertyIds: null, limit: 50 });
    expect(programados).toMatchObject({ disponible: true });
    expect(programados.orders.map((o) => o.id)).toEqual([order.id]);
  });

  it("un pedido sin programadoPara sigue siendo inmediato (pending)", async () => {
    const f = buildRestaurantFixture();
    expect((await createOrder(f.repo, pedido(f))).status).toBe("pending");
  });

  it("zona horaria: las 19:00 de Merida del sabado son domingo 01:00 UTC y SI caen dentro del horario del sabado", async () => {
    const f = buildRestaurantFixture();
    horarioViernesSabado(f);
    const order = await createOrder(f.repo, pedido(f, { programadoPara: "2026-10-03T19:00:00-06:00" }));
    expect(order.programadoPara).toBe("2026-10-04T01:00:00.000Z");
    expect(order.status).toBe("programado");
  });

  it("zona horaria: la hora se interpreta en la zona de la SUCURSAL (CDMX tambien es UTC-6; una zona de otro huso la mueve)", async () => {
    const f = buildRestaurantFixture();
    // Tijuana (UTC-7 en octubre, con horario de verano hasta noviembre): 12:30-06:00 son las 11:30 locales ->
    // cerrado (abre 12:00) aunque en Merida si estaria abierto; 13:30-06:00 son las 12:30 locales -> abierto.
    horarioViernesSabado(f, "America/Tijuana");
    await expect(createOrder(f.repo, pedido(f, { programadoPara: "2026-10-03T12:30:00-06:00" }))).rejects.toThrow(/no atiende a la hora elegida/);
    await expect(createOrder(f.repo, pedido(f, { programadoPara: "2026-10-03T13:30:00-06:00" }))).resolves.toMatchObject({ status: "programado" });
  });

  it("cruce de medianoche: la 01:00 -1 min del sabado cae en el turno del viernes; la 01:00 en punto ya no", async () => {
    const f = buildRestaurantFixture();
    horarioViernesSabado(f);
    await expect(createOrder(f.repo, pedido(f, { programadoPara: "2026-10-03T00:59:00-06:00" }))).resolves.toMatchObject({ status: "programado" });
    await expect(createOrder(f.repo, pedido(f, { programadoPara: "2026-10-03T01:00:00-06:00", items: [{ productId: f.products.cocaCola, requestedQuantity: 3 }] }))).rejects.toThrow(
      /no atiende a la hora elegida \(sábado 03\/10 01:00\)/,
    );
  });

  it("fuera de servicio: domingo (sin turno) se rechaza y el mensaje dice cuando abre", async () => {
    const f = buildRestaurantFixture();
    horarioViernesSabado(f);
    const error = await createOrder(f.repo, pedido(f, { programadoPara: "2026-10-04T14:00:00-06:00" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrderValidationError);
    expect((error as Error).message).toContain("domingo 04/10 14:00");
    expect((error as Error).message).toContain("viernes");
    expect(await f.repo.listScheduledOrders(f.organizationId, { propertyIds: null, limit: 10 })).toMatchObject({ orders: [] });
  });

  it("fuera de servicio tambien se rechaza para la captura manual del staff (source admin)", async () => {
    const f = buildRestaurantFixture();
    horarioViernesSabado(f);
    await expect(createOrder(f.repo, pedido(f, { source: "admin", programadoPara: "2026-10-04T14:00:00-06:00" }))).rejects.toThrow(/no atiende a la hora elegida/);
  });

  it("puente: una excepcion por fecha abre el domingo y el pedido programado se acepta", async () => {
    const f = buildRestaurantFixture();
    horarioViernesSabado(f);
    await f.repo.createBranchHoursException(f.organizationId, {
      propertyId: f.propertyId,
      fechaDesde: "2026-10-04",
      fechaHasta: "2026-10-04",
      horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "16:00" }],
      motivo: "Puente",
    });
    await expect(createOrder(f.repo, pedido(f, { programadoPara: "2026-10-04T14:00:00-06:00" }))).resolves.toMatchObject({ status: "programado" });
  });

  it("sin horario configurado no se restringe (igual que un pedido normal), pero la ventana sigue aplicando", async () => {
    const f = buildRestaurantFixture();
    await expect(createOrder(f.repo, pedido(f, { programadoPara: "2026-10-04T03:00:00-06:00" }))).resolves.toMatchObject({ status: "programado" });
    await expect(createOrder(f.repo, pedido(f, { programadoPara: "2026-10-02T12:10:00-06:00" }))).rejects.toThrow(/al menos 30 minutos/);
    await expect(createOrder(f.repo, pedido(f, { programadoPara: "2026-10-12T12:00:00-06:00" }))).rejects.toThrow(/7 días/);
  });

  it("base SIN migrar: se rechaza con Unavailable (503) y NO se crea un pedido inmediato por error", async () => {
    const f = buildRestaurantFixture();
    f.repo.setScheduledOrdersSupported(false);
    await expect(createOrder(f.repo, pedido(f, { programadoPara: "2026-10-03T14:00:00-06:00" }))).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    expect((await f.repo.listOrders(f.organizationId, { propertyIds: null, limit: 50 })).orders).toHaveLength(0);
    // Un pedido normal sigue funcionando contra la base sin migrar.
    await expect(createOrder(f.repo, pedido(f))).resolves.toMatchObject({ status: "pending" });
  });

  it("idempotencia: el mismo pedido programado dos veces crea UNA sola fila", async () => {
    const f = buildRestaurantFixture();
    const a = await createOrder(f.repo, pedido(f, { programadoPara: "2026-10-03T14:00:00-06:00" }));
    const b = await createOrder(f.repo, pedido(f, { programadoPara: "2026-10-03T14:00:00-06:00" }));
    expect(b.id).toBe(a.id);
    expect((await f.repo.listScheduledOrders(f.organizationId, { propertyIds: null, limit: 10 })).orders).toHaveLength(1);
  });

  it("la misma compra para otra hora es OTRO pedido (la hora entra al fingerprint)", async () => {
    const f = buildRestaurantFixture();
    const a = await createOrder(f.repo, pedido(f, { programadoPara: "2026-10-03T14:00:00-06:00" }));
    const b = await createOrder(f.repo, pedido(f, { programadoPara: "2026-10-03T15:00:00-06:00" }));
    expect(b.id).not.toBe(a.id);
  });
});

describe("auto-promocion de programados", () => {
  async function conProgramado(horas: number) {
    const f = buildRestaurantFixture();
    const hora = new Date(AHORA.getTime() + horas * 3_600_000).toISOString();
    const order = await createOrder(f.repo, pedido(f, { programadoPara: hora }));
    return { f, order, hora: new Date(hora) };
  }

  it("antes de la anticipacion no se promueve; dentro de ella pasa a pending con promovidoAt", async () => {
    const { f, order, hora } = await conProgramado(3);
    const temprano = await promoverProgramadosVencidos(f.repo, f.organizationId, { now: new Date(hora.getTime() - (ANTICIPACION_PROMOCION_MIN + 1) * 60_000) });
    expect(temprano.promovidos).toHaveLength(0);
    const ahora = await promoverProgramadosVencidos(f.repo, f.organizationId, { now: new Date(hora.getTime() - ANTICIPACION_PROMOCION_MIN * 60_000) });
    expect(ahora.promovidos.map((o) => o.id)).toEqual([order.id]);
    const guardado = await f.repo.findOrderById(f.organizationId, order.id);
    expect(guardado?.status).toBe("pending");
    expect(guardado?.promovidoAt).not.toBeNull();
    expect((await f.repo.listOrders(f.organizationId, { propertyIds: null, status: "pending", limit: 10 })).orders.map((o) => o.id)).toEqual([order.id]);
  });

  it("idempotente: dos ejecuciones (secuenciales o simultaneas) promueven el pedido UNA sola vez", async () => {
    const { f, hora } = await conProgramado(3);
    const now = new Date(hora.getTime() - 10 * 60_000);
    const [a, b] = await Promise.all([promoverProgramadosVencidos(f.repo, f.organizationId, { now }), promoverProgramadosVencidos(f.repo, f.organizationId, { now })]);
    expect(a.promovidos.length + b.promovidos.length).toBe(1);
    expect((await promoverProgramadosVencidos(f.repo, f.organizationId, { now })).promovidos).toHaveLength(0);
  });

  it("un pedido programado CANCELADO no se promueve", async () => {
    const { f, order, hora } = await conProgramado(3);
    await changeOrderStatus(f.repo, f.organizationId, order, "cancelado");
    const r = await promoverProgramadosVencidos(f.repo, f.organizationId, { now: new Date(hora.getTime() + 60_000) });
    expect(r.promovidos).toHaveLength(0);
    expect((await f.repo.findOrderById(f.organizationId, order.id))?.status).toBe("cancelado");
  });

  it("un pedido cuya hora ya paso (nadie abrio el panel) se promueve en la siguiente consulta", async () => {
    const { f, order, hora } = await conProgramado(3);
    const r = await promoverProgramadosVencidos(f.repo, f.organizationId, { now: new Date(hora.getTime() + 2 * 3_600_000) });
    expect(r.promovidos.map((o) => o.id)).toEqual([order.id]);
  });

  it("alcance: otra organizacion y otra sucursal no se tocan; el barrido global si las toma todas", async () => {
    const a = await conProgramado(3);
    const b = await conProgramado(3);
    const now = new Date(a.hora.getTime());
    const soloA = await promoverProgramadosVencidos(a.f.repo, a.f.organizationId, { now });
    expect(soloA.promovidos).toHaveLength(1);
    expect((await b.f.repo.findOrderById(b.f.organizationId, b.order.id))?.status).toBe("programado");
    const fueraDeAlcance = await promoverProgramadosVencidos(b.f.repo, b.f.organizationId, { now, propertyIds: ["00000000-0000-4000-8000-00000000dead"] });
    expect(fueraDeAlcance.promovidos).toHaveLength(0);
    const global = await promoverProgramadosTodasLasOrganizaciones(b.f.repo, { now });
    expect(global.promovidos).toHaveLength(1);
  });

  it("base SIN migrar: disponible=false y nada que promover (sin lanzar)", async () => {
    const f = buildRestaurantFixture();
    f.repo.setScheduledOrdersSupported(false);
    expect(await promoverProgramadosVencidos(f.repo, f.organizationId, { now: AHORA })).toEqual({ disponible: false, promovidos: [] });
    expect(await f.repo.listScheduledOrders(f.organizationId, { propertyIds: null, limit: 5 })).toEqual({ disponible: false, orders: [] });
  });
});

describe("maquina de estados de un pedido programado", () => {
  it("programado -> pending (adelantarlo) y programado -> cancelado; nunca salta a preparacion ni a entrega", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, pedido(f, { programadoPara: "2026-10-03T14:00:00-06:00" }));
    await expect(changeOrderStatus(f.repo, f.organizationId, order, "preparando")).rejects.toBeInstanceOf(OrderStatusTransitionError);
    await expect(changeOrderStatus(f.repo, f.organizationId, order, "entregado")).rejects.toBeInstanceOf(OrderStatusTransitionError);
    const adelantado = await changeOrderStatus(f.repo, f.organizationId, order, "pending");
    expect(adelantado.status).toBe("pending");
  });

  it("nada puede volver a programado", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, pedido(f));
    await expect(changeOrderStatus(f.repo, f.organizationId, order, "programado")).rejects.toBeInstanceOf(OrderStatusTransitionError);
  });
});
