// PM PR-3 (e): puentes (excepcion de horario por fecha) y dia de negocio con el cruce de medianoche del
// doble turno. Merida = UTC-6 sin horario de verano.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aperturaConExcepciones, fechaAnterior, fechaLocal, horarioDePuente, horarioParaFecha, validarExcepcionHorario } from "../src/horarios.ts";
import { createOrder, quoteOrder } from "../src/orders.ts";
import { OrderValidationError } from "../src/errors.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const ZONA = "America/Merida";
// Horario semanal de ejemplo de una sucursal que normalmente abre SOLO el turno de la noche, lunes a viernes.
const SOLO_NOCHE = [{ dias: [1, 2, 3, 4, 5], abre: "18:00", cierra: "01:00" }] as const;
const PUENTE = { fechaDesde: "2026-09-30", fechaHasta: "2026-10-02", horario: horarioDePuente([{ abre: "12:00", cierra: "16:00" }, { abre: "18:00", cierra: "01:00" }]) };

const merida = (iso: string) => new Date(`${iso}-06:00`);

describe("horarioDePuente / validarExcepcionHorario", () => {
  it("el puente aplica los turnos indicados a TODOS los dias (parametrizable, no hay horas fijas)", () => {
    const h = horarioDePuente([{ abre: "11:00", cierra: "15:00" }, { abre: "17:00", cierra: "00:30" }]);
    expect(h).toHaveLength(2);
    expect(h[0]!.dias).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(h[1]).toMatchObject({ abre: "17:00", cierra: "00:30" });
  });

  it("valida fechas reales, rango <= 31 dias, al menos un turno y motivo", () => {
    const ok = validarExcepcionHorario({ fechaDesde: "2026-12-24", fechaHasta: "2026-12-26", horario: PUENTE.horario, motivo: "  Navidad " });
    expect(ok.motivo).toBe("Navidad");
    const mal = (patch: object) => () => validarExcepcionHorario({ fechaDesde: "2026-12-24", fechaHasta: "2026-12-26", horario: PUENTE.horario, ...patch });
    expect(mal({ fechaDesde: "2026-02-30" })).toThrow(OrderValidationError);
    expect(mal({ fechaDesde: "24/12/2026" })).toThrow(/AAAA-MM-DD/);
    expect(mal({ fechaHasta: "2026-12-23" })).toThrow(/anterior/);
    expect(mal({ fechaHasta: "2027-02-01" })).toThrow(/31 días/);
    expect(mal({ horario: [] })).toThrow(/al menos un turno/);
    expect(mal({ horario: [{ dias: [1], abre: "12:00", cierra: "12:00" }] })).toThrow(/no pueden ser iguales/);
    expect(mal({ motivo: "x".repeat(201) })).toThrow(/motivo/);
  });
});

describe("fechas locales", () => {
  it("fechaLocal usa la zona del negocio, no la del proceso", () => {
    expect(fechaLocal(new Date("2026-09-29T05:30:00Z"), ZONA)).toBe("2026-09-28");
    expect(fechaLocal(new Date("2026-09-29T06:00:00Z"), ZONA)).toBe("2026-09-29");
  });
  it("fechaAnterior cruza mes y anio", () => {
    expect(fechaAnterior("2026-10-01")).toBe("2026-09-30");
    expect(fechaAnterior("2027-01-01")).toBe("2026-12-31");
    expect(fechaAnterior("2028-03-01")).toBe("2028-02-29");
  });
  it("horarioParaFecha: la excepcion rige solo en su rango; la mas reciente gana", () => {
    const otra = { fechaDesde: "2026-10-01", fechaHasta: "2026-10-01", horario: [{ dias: [4], abre: "08:00", cierra: "09:00" }] };
    expect(horarioParaFecha(SOLO_NOCHE, [PUENTE], "2026-09-29")).toBe(SOLO_NOCHE);
    expect(horarioParaFecha(SOLO_NOCHE, [PUENTE], "2026-09-30")).toBe(PUENTE.horario);
    expect(horarioParaFecha(SOLO_NOCHE, [PUENTE, otra], "2026-10-01")).toBe(otra.horario);
  });
});

describe("aperturaConExcepciones", () => {
  it("fuera del puente: solo abre en la noche; la tarde esta cerrada", () => {
    const r = aperturaConExcepciones(SOLO_NOCHE, [PUENTE], merida("2026-09-29T13:00:00"), ZONA); // martes 13:00, antes del puente
    expect(r.estado.abierto).toBe(false);
  });

  it("dentro del puente: abre ambos turnos (13:00 y 20:00) y cierra entre turnos", () => {
    expect(aperturaConExcepciones(SOLO_NOCHE, [PUENTE], merida("2026-09-30T13:00:00"), ZONA).estado.abierto).toBe(true);
    expect(aperturaConExcepciones(SOLO_NOCHE, [PUENTE], merida("2026-09-30T20:00:00"), ZONA).estado.abierto).toBe(true);
    expect(aperturaConExcepciones(SOLO_NOCHE, [PUENTE], merida("2026-09-30T17:00:00"), ZONA).estado.abierto).toBe(false);
  });

  it("un sabado dentro del puente abre aunque el horario semanal solo sea de lunes a viernes", () => {
    const sabadoPuente = { fechaDesde: "2026-10-03", fechaHasta: "2026-10-04", horario: PUENTE.horario };
    expect(aperturaConExcepciones(SOLO_NOCHE, [], merida("2026-10-03T13:00:00"), ZONA).estado.abierto).toBe(false);
    expect(aperturaConExcepciones(SOLO_NOCHE, [sabadoPuente], merida("2026-10-03T13:00:00"), ZONA).estado.abierto).toBe(true);
  });

  it("la cola del turno de AYER usa el horario de ayer: el ultimo dia del puente cierra a la 01:00 del dia siguiente", () => {
    // 2026-10-02 es el ultimo dia del puente; su turno 18:00-01:00 sigue abierto el 10-03 a las 00:30 (sabado, fuera del puente).
    expect(aperturaConExcepciones(SOLO_NOCHE, [PUENTE], merida("2026-10-03T00:30:00"), ZONA).estado.abierto).toBe(true);
    expect(aperturaConExcepciones(SOLO_NOCHE, [PUENTE], merida("2026-10-03T01:30:00"), ZONA).estado.abierto).toBe(false);
  });

  it("dia de negocio: 00:30 del martes dentro del turno del lunes es LUNES; 18:30 del martes es martes", () => {
    const cola = aperturaConExcepciones(SOLO_NOCHE, [], merida("2026-09-29T00:30:00"), ZONA);
    expect(cola.estado.abierto).toBe(true);
    expect(cola.diaNegocio).toBe(1);
    expect(cola.fechaNegocio).toBe("2026-09-28");
    const noche = aperturaConExcepciones(SOLO_NOCHE, [], merida("2026-09-29T18:30:00"), ZONA);
    expect(noche.diaNegocio).toBe(2);
    expect(noche.fechaNegocio).toBe("2026-09-29");
  });

  it("con doble turno (12-16 y 18-01) la cola de medianoche tambien pertenece al dia anterior", () => {
    const doble = [
      { dias: [1, 2, 3, 4, 5, 6, 0], abre: "12:00", cierra: "16:00" },
      { dias: [1, 2, 3, 4, 5, 6, 0], abre: "18:00", cierra: "01:00" },
    ];
    expect(aperturaConExcepciones(doble, [], merida("2026-09-29T00:59:00"), ZONA)).toMatchObject({ diaNegocio: 1, estado: { abierto: true } });
    expect(aperturaConExcepciones(doble, [], merida("2026-09-29T01:00:00"), ZONA)).toMatchObject({ diaNegocio: 2, estado: { abierto: false } });
    expect(aperturaConExcepciones(doble, [], merida("2026-09-29T13:00:00"), ZONA)).toMatchObject({ diaNegocio: 2, estado: { abierto: true } });
  });
});

describe("de punta a punta: horario, puente y promocion del lunes (en memoria)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function seed() {
    const f = buildRestaurantFixture();
    await f.repo.upsertBranchZonaHoraria(f.propertyId, ZONA);
    f.repo.seedBranchPolicy(f.propertyId, { horario: SOLO_NOCHE });
    const pastor = randomUUID();
    f.repo.seedProduct({ id: pastor, organizationId: f.organizationId, categoryId: f.categories.tacos, name: "Tacos al Pastor", description: null, searchKeywords: [] });
    f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: pastor, price: 28, isAvailable: true });
    await f.repo.createPromotion(f.organizationId, { code: "LUNES2X1", name: "Lunes 2x1", type: "bogo", value: 1, daysOfWeek: [1], channels: ["recoger"], productIds: [pastor], autoApply: true });
    const orden = { organizationId: f.organizationId, branchSlug: "fco-montejo" };
    const items = [{ productId: pastor, requestedQuantity: 2, tortilla: "maiz" as const }];
    return { ...f, orden, items };
  }

  it("lunes 00:30 del martes (turno del lunes): la promo del lunes AUN aplica (dia de negocio)", async () => {
    vi.setSystemTime(merida("2026-09-29T00:30:00"));
    const f = await seed();
    const q = await quoteOrder(f.repo, { ...f.orden, canal: "recoger", items: f.items });
    expect(q.abiertoAhora).toBe(true);
    expect(q.promocionAplicada?.code).toBe("LUNES2X1");
    expect(q.total).toBe(28);
  });

  it("martes 19:00: es martes, no hay promo del lunes", async () => {
    vi.setSystemTime(merida("2026-09-29T19:00:00"));
    const f = await seed();
    const q = await quoteOrder(f.repo, { ...f.orden, canal: "recoger", items: f.items });
    expect(q.promocionAplicada).toBeNull();
    expect(q.total).toBe(56);
  });

  it("lunes 1:30 del martes: sucursal cerrada, el pedido se rechaza (la promo no cambia eso)", async () => {
    vi.setSystemTime(merida("2026-09-29T01:30:00"));
    const f = await seed();
    await expect(quoteOrder(f.repo, { ...f.orden, canal: "recoger", items: f.items })).rejects.toThrow(/cerrada/);
  });

  it("puente: miercoles 13:00 la sucursal normalmente cerrada de dia ABRE por la excepcion", async () => {
    vi.setSystemTime(merida("2026-09-30T13:00:00"));
    const f = await seed();
    await expect(quoteOrder(f.repo, { ...f.orden, canal: "recoger", items: f.items })).rejects.toThrow(/cerrada/);
    await f.repo.createBranchHoursException(f.organizationId, { propertyId: f.propertyId, fechaDesde: PUENTE.fechaDesde, fechaHasta: PUENTE.fechaHasta, horario: PUENTE.horario, motivo: "Puente" });
    const q = await quoteOrder(f.repo, { ...f.orden, canal: "recoger", items: f.items });
    expect(q.abiertoAhora).toBe(true);
    const order = await createOrder(f.repo, { ...f.orden, customerName: "Ana", customerPhone: "9991234567", source: "whatsapp", paymentMethod: "efectivo", canal: "recoger", items: f.items });
    expect(order.total).toBe(56);
  });

  it("la excepcion de una sucursal de OTRA organizacion no se puede crear (aislamiento)", async () => {
    const f = await seed();
    await expect(f.repo.createBranchHoursException(randomUUID(), { propertyId: f.propertyId, fechaDesde: "2026-09-30", fechaHasta: "2026-09-30", horario: PUENTE.horario })).rejects.toThrow(/no pertenece/);
  });
});
