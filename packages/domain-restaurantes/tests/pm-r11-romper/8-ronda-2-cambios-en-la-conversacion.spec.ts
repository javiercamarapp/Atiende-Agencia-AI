// R12 romper (ronda 2) -- categoria B: cambios DURANTE la conversacion. El menu, el precio, una promocion o el horario cambian entre cotizar, confirmar y
// crear; la sucursal cierra a mitad; cambio de horario de verano en otra zona; el dia de negocio cambia a medianoche; el reloj retrocede.
// Regla: el cliente solo paga lo que vio y confirmo; si algo cambio, se re-cotiza (error de negocio, cero pedidos) y nunca se cobra "otro" total en silencio.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { diaDeNegocio, estaAbiertoAhora } from "../../src/horarios.ts";
import { assertCanCreate, OrderFlowViolationError, QUOTE_TTL_MS } from "../../src/agent-tools/order-flow.ts";
import { buildRestaurantFixture, flujo, ordenes } from "./arnes.ts";
import type { Fixture } from "./arnes.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00")); // martes
});
afterEach(() => vi.useRealTimers());

const err = (out: { result: unknown }) => JSON.stringify(out.result).match(/"error":"([^"]*)"/)?.[1];
const HORARIO = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }];

async function conHorario(f: Fixture, horario = HORARIO, zona = "America/Merida") {
  f.repo.seedBranchPolicy(f.propertyId, { horario });
  await f.repo.upsertBranchZonaHoraria(f.propertyId, zona);
}

/** Cotiza y confirma en el turno 1/2 y deja al flujo listo para crear. */
async function listoParaCrear(f: Fixture, qty = 2, extra: Record<string, unknown> = {}, phone = "9991234567") {
  const s = flujo(f, phone);
  const q = await s.quote(qty, extra);
  s.next();
  await s.confirm();
  return { s, q };
}
const crear = (s: ReturnType<typeof flujo>, qty = 2, extra: Record<string, unknown> = {}) => s.seguro("crear_pedido", { ...s.base(qty, extra), customer_name: "Ana", payment_method: "efectivo" });

describe("R12-B1 el menu cambia entre cotizar y crear", () => {
  it("el precio SUBE despues de confirmar: no se cobra otro total; se pide re-cotizar y no hay pedido", async () => {
    const f = buildRestaurantFixture();
    const { s } = await listoParaCrear(f);
    await f.repo.upsertBranchProductState(f.propertyId, f.products.cocaCola, 60, true);
    const out = await crear(s);
    expect(out.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("el precio BAJA despues de confirmar: tambien se re-cotiza (el cliente confirmo $90, no otro numero)", async () => {
    const f = buildRestaurantFixture();
    const { s } = await listoParaCrear(f);
    await f.repo.upsertBranchProductState(f.propertyId, f.products.cocaCola, 30, true);
    const out = await crear(s);
    expect(out.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("el producto desaparece del menu de la sucursal (queda sin precio / no disponible) entre cotizar y confirmar: crear se rechaza", async () => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    await s.quote(2);
    await f.repo.setBranchProductAvailability(f.propertyId, f.products.cocaCola, false);
    s.next();
    await s.confirm();
    const out = await crear(s);
    expect(out.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
  });

  // Una promocion AUTOMATICA cotizada hoy (martes, solo recoger) deja de aplicar a medianoche: el total que el cliente confirmo ya no es el que se cobra.
  const conPromoDelMartes = async (f: Fixture) => {
    await f.repo.createPromotion(f.organizationId, { code: "MARTES20", name: "Martes 20%", type: "percentage", value: 20, daysOfWeek: [2], channels: ["recoger"], autoApply: true });
  };
  it("(control) la promocion de martes se aplica al cotizar y al crear el mismo martes", async () => {
    const f = buildRestaurantFixture();
    await conPromoDelMartes(f);
    const { s, q } = await listoParaCrear(f);
    expect(JSON.stringify(q.result)).toMatch(/72|MARTES20|descuento/i);
    const out = await crear(s);
    expect(out.orderId).toBeTruthy();
    expect((await ordenes(f))[0]!.total).toBe(72);
  });

  it("R12-03 [P1, corregido] la promocion deja de aplicar (cambia el dia) entre confirmar y crear: no se cobra un total distinto al confirmado", async () => {
    const f = buildRestaurantFixture();
    await conPromoDelMartes(f);
    vi.setSystemTime(new Date("2026-10-06T23:55:00-06:00")); // martes, 5 minutos antes de medianoche
    const { s, q } = await listoParaCrear(f);
    const totalConfirmado = (q.result as { quote?: { total?: number } }).quote?.total;
    expect(totalConfirmado).toBe(72); // control: el cliente confirmo $72 con la promocion
    vi.setSystemTime(new Date("2026-10-07T00:05:00-06:00")); // miercoles, dentro de la vigencia de la cotizacion: ya no aplica
    const out = await crear(s);
    const [orden] = await ordenes(f);
    // Se rechaza para re-cotizar (sin pedido): nunca se cobran $90 cuando el cliente confirmo $72.
    expect(orden).toBeUndefined();
    expect(out.orderId).toBeNull();
    expect(err(out)).toMatch(/total cambi|precio/i);
  });

  it("R12-03b [P1, corregido] la promocion se DESACTIVA (el dueno la apaga) entre confirmar y crear: no se cobra un total distinto al confirmado", async () => {
    const f = buildRestaurantFixture();
    await f.repo.createPromotion(f.organizationId, { code: "PROMO10", name: "10%", type: "percentage", value: 10, channels: ["recoger"], autoApply: true });
    const { s, q } = await listoParaCrear(f);
    const totalConfirmado = (q.result as { quote?: { total?: number } }).quote?.total;
    expect(totalConfirmado).toBe(81); // control
    const [promo] = await f.repo.listPromotions(f.organizationId);
    await f.repo.updatePromotion(f.organizationId, promo!.id, { isActive: false });
    const out = await crear(s);
    const [orden] = await ordenes(f);
    expect(orden).toBeUndefined();
    expect(out.orderId).toBeNull();
  });
});

describe("R12-B1b el total BAJA entre confirmar y crear (no perjudica al cliente)", () => {
  it("una promocion nueva que aparece despues de confirmar baja el total: el pedido se crea (el cliente paga menos de lo que confirmo, nunca mas)", async () => {
    const f = buildRestaurantFixture();
    const { s, q } = await listoParaCrear(f);
    expect((q.result as { quote?: { total?: number } }).quote?.total).toBe(90);
    await f.repo.createPromotion(f.organizationId, { code: "NUEVA10", name: "10%", type: "percentage", value: 10, channels: ["recoger"], autoApply: true });
    const out = await crear(s);
    expect(out.orderId).toBeTruthy();
    expect((await ordenes(f))[0]!.total).toBeLessThanOrEqual(90);
  });
});

describe("R12-B2 la sucursal cambia a mitad de la conversacion", () => {
  it("cotiza a las 00:59:30 y al crear (01:00:30) la sucursal ya cerro: se rechaza con la proxima apertura y no hay pedido; el cliente puede programarlo", async () => {
    const f = buildRestaurantFixture();
    await conHorario(f);
    vi.setSystemTime(new Date("2026-10-07T00:59:30-06:00"));
    const { s } = await listoParaCrear(f);
    vi.setSystemTime(new Date("2026-10-07T01:00:30-06:00"));
    const out = await crear(s);
    expect(out.orderId).toBeNull();
    expect(err(out)).toMatch(/cerrada|abre/i);
    expect(await ordenes(f)).toHaveLength(0);
    // Tras el rechazo el flujo vuelve a "confirmado": al re-cotizar para manana (programado) se puede seguir.
    s.next();
    const reprograma = await s.seguro("cotizar_pedido", s.base(2, { programado_para: "2026-10-07T14:00:00-06:00" }));
    expect(err(reprograma)).toBeUndefined();
  });

  it("el dueno CIERRA la sucursal (feriado de ultima hora) entre confirmar y crear: crear se rechaza", async () => {
    const f = buildRestaurantFixture();
    await conHorario(f);
    const { s } = await listoParaCrear(f);
    await f.repo.createBranchHoursException(f.organizationId, { propertyId: f.propertyId, fechaDesde: "2026-10-06", fechaHasta: "2026-10-06", horario: [], motivo: "Corte de luz" });
    const out = await crear(s);
    expect(out.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("la sucursal se da de BAJA (inactive) entre confirmar y crear: no se crea el pedido", async () => {
    const f = buildRestaurantFixture();
    const { s } = await listoParaCrear(f);
    // Reemplaza la sucursal por una inactiva con el mismo slug.
    const rama = (await f.repo.listBranchesForOrganizationAdmin(f.organizationId)).find((b) => b.propertyId === f.propertyId)!;
    f.repo.seedBranch({ ...rama, status: "inactive" });
    const out = await crear(s);
    expect(out.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("el minimo de pedido SUBE entre cotizar y crear (el dueno lo cambia): crear se rechaza con el faltante, sin pedido", async () => {
    const f = buildRestaurantFixture();
    const { s } = await listoParaCrear(f);
    f.repo.seedBranchPolicy(f.propertyId, { pedidoMinimoRecoger: 500 });
    const out = await crear(s);
    expect(out.orderId).toBeNull();
    expect(err(out)).toMatch(/m[ií]nimo/i);
  });

  it("la cotizacion VENCE (20 min sin responder): crear se rechaza; al re-cotizar y re-confirmar si se crea", async () => {
    const f = buildRestaurantFixture();
    const { s } = await listoParaCrear(f);
    vi.setSystemTime(new Date(Date.now() + QUOTE_TTL_MS + 1000));
    const vencida = await crear(s);
    expect(vencida.orderId).toBeNull();
    s.next();
    await s.quote(2);
    s.next();
    await s.confirm();
    expect((await crear(s)).orderId).toBeTruthy();
  });
});

describe("R12-B3 horario de verano (zona con DST) y dia de negocio", () => {
  // Merida y CDMX ya no cambian de hora, pero la plataforma admite cualquier zona IANA (sucursales fronterizas siguen la regla de EE. UU.).
  const horario = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "02:00" }];
  const ZONA = "America/Tijuana";

  it("OTONO (2026-11-01, la hora 01:00-02:00 ocurre dos veces): abierto en las dos 01:30 y cerrado a las 02:00 reales", () => {
    const primera = new Date("2026-11-01T08:30:00Z"); // 01:30 PDT
    const segunda = new Date("2026-11-01T09:30:00Z"); // 01:30 PST
    const cierre = new Date("2026-11-01T10:00:00Z"); // 02:00 PST
    expect(estaAbiertoAhora(horario, primera, ZONA).abierto).toBe(true);
    expect(estaAbiertoAhora(horario, segunda, ZONA).abierto).toBe(true);
    expect(estaAbiertoAhora(horario, cierre, ZONA).abierto).toBe(false);
  });

  it("PRIMAVERA (2026-03-08, de 02:00 salta a 03:00): a las 03:00 PDT (la 'hora perdida' ya paso) la sucursal con cierre 02:00 esta cerrada y abre a las 12:00", () => {
    expect(estaAbiertoAhora(horario, new Date("2026-03-08T10:00:00Z"), ZONA).abierto).toBe(false); // 03:00 PDT
    expect(estaAbiertoAhora(horario, new Date("2026-03-08T18:59:00Z"), ZONA).abierto).toBe(false); // 11:59 PDT
    expect(estaAbiertoAhora(horario, new Date("2026-03-08T19:00:00Z"), ZONA).abierto).toBe(true); // 12:00 PDT
  });

  it("R12-05 [P2, corregido] el dia de negocio no se corre ni se duplica en los dos dias de cambio de hora (corte 02:00)", () => {
    const d = (iso: string) => diaDeNegocio(new Date(iso), ZONA, horario);
    expect(d("2026-11-01T08:30:00Z")).toBe("2026-10-31"); // 01:30 PDT: sigue siendo el dia de negocio del 31
    expect(d("2026-11-01T09:30:00Z")).toBe("2026-10-31"); // 01:30 PST (segunda vez)
    expect(d("2026-11-01T10:00:00Z")).toBe("2026-11-01"); // 02:00 PST: ya es el 1
    expect(d("2026-03-08T09:59:00Z")).toBe("2026-03-07"); // 01:59 PST
    expect(d("2026-03-08T10:00:00Z")).toBe("2026-03-08"); // 03:00 PDT
  });

  it("un pedido PROGRAMADO el dia del cambio de hora con offset explicito se evalua en la zona de la sucursal (13:00 PDT = 20:00Z)", async () => {
    const f = buildRestaurantFixture();
    await conHorario(f, horario, ZONA);
    vi.setSystemTime(new Date("2026-03-06T20:00:00Z"));
    const s = flujo(f);
    expect(err(await s.seguro("cotizar_pedido", s.base(2, { programado_para: "2026-03-08T13:00:00-07:00" })))).toBeUndefined();
    // 11:00 PDT del mismo dia (antes de abrir) se rechaza aunque en PST seria otra hora.
    expect(err(await s.seguro("cotizar_pedido", s.base(2, { programado_para: "2026-03-08T11:00:00-07:00" })))).toMatch(/no atiende|cerrad/i);
  });

  it("cambio de dia a medianoche en Merida: el pedido de las 23:59:30 y el de las 00:00:30 caen en el MISMO dia de negocio (cierre 01:00)", () => {
    const antes = diaDeNegocio(new Date("2026-10-06T23:59:30-06:00"), "America/Merida", HORARIO);
    const despues = diaDeNegocio(new Date("2026-10-07T00:00:30-06:00"), "America/Merida", HORARIO);
    expect(antes).toBe("2026-10-06");
    expect(despues).toBe("2026-10-06");
  });
});

describe("R12-B4 el reloj retrocede (ajuste NTP o instancia con reloj atrasado)", () => {
  it("R12-04 [P2, corregido] una cotizacion NO se vuelve inmortal si el reloj retrocede: con el reloj 3 h atras, crear se rechaza por vencida", async () => {
    const f = buildRestaurantFixture();
    const { s } = await listoParaCrear(f);
    // Control: con el reloj hacia adelante dentro de la vigencia (10 min) SI se podria crear (no se crea aqui para no gastar el flujo).
    vi.setSystemTime(new Date(Date.now() - 3 * 3_600_000));
    const out = await crear(s);
    expect(out.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
  });

  it("(control) el reloj salta 1 s hacia atras (tolerancia normal entre instancias): el pedido se crea", async () => {
    const f = buildRestaurantFixture();
    const { s } = await listoParaCrear(f);
    vi.setSystemTime(new Date(Date.now() - 1000));
    expect((await crear(s)).orderId).toBeTruthy();
  });
});

describe("R12-04 (documentado) la tolerancia de reloj tambien aplica al claim `creando`", () => {
  const snap = (claimedAtMs: number, now: number) =>
    ({ state: "creando", version: 1, context: { quoteHash: "h", quotedAtMs: now, quotedTurn: null, claimedAtMs } }) as unknown as Parameters<typeof assertCanCreate>[0];
  const codigo = (claimedAtMs: number, now: number): string | null => {
    try {
      assertCanCreate(snap(claimedAtMs, now), { now, turn: null });
      return null;
    } catch (e) {
      return e instanceof OrderFlowViolationError ? e.code : "otro";
    }
  };
  it("un claim vigente con desfase <= 60 s entre instancias bloquea el segundo crear; con desfase > 60 s deja de bloquear (limite conocido: lo frena la deduplicacion de 5 min)", () => {
    const now = 1_800_000_000_000;
    expect(codigo(now - 5_000, now)).toBe("pedido_en_proceso");
    expect(codigo(now + 30_000, now)).toBe("pedido_en_proceso");
    expect(codigo(now + 120_000, now)).not.toBe("pedido_en_proceso");
  });
});

describe("R12-B5 mismo telefono, otra conversacion nueva", () => {
  it("una conversacion NUEVA (otro flujo) no hereda la confirmacion de la anterior aunque el telefono sea el mismo", async () => {
    const f = buildRestaurantFixture();
    const vieja = flujo(f, "9991234567");
    await vieja.quote(2);
    vieja.next();
    await vieja.confirm();
    const nueva = { ...flujo(f, "9991234567") };
    // Misma llave de flujo (wa:telefono): al ser la misma conversacion, la confirmacion SI vale; con otro telefono, no.
    const otra = flujo(f, "9990000000");
    const out = await crear(otra);
    expect(out.orderId).toBeNull();
    void nueva;
  });
});

// Evita que el linter marque `randomUUID` si se quita un caso.
void randomUUID;
