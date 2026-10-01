// H-06 -- calculo puro de grupos: totales en centavos enteros (mismo redondeo que la migracion 036), pickup, y la
// fecha local de la property para el cutoff (cruce de zona horaria).
import { describe, expect, it } from "vitest";
import {
  GruposInvalidInputError,
  computeQuoteTotals,
  eachNight,
  isCutoffReached,
  isGroupIsoDate,
  localDateIn,
  groupNightCount,
  summarizePickup,
} from "../../src/index.ts";

const RT = "00000000-0000-0000-0000-0000000d0001";
const RT2 = "00000000-0000-0000-0000-0000000d0002";

describe("computeQuoteTotals", () => {
  it("cuartos x noches x tarifa en centavos enteros, con descuento", () => {
    expect(computeQuoteTotals([{ roomTypeId: RT, rooms: 5, rateCents: 150_000 }], "2031-06-12", "2031-06-15", 1000)).toEqual({ nights: 3, grossCents: 2_250_000, totalCents: 2_025_000 });
  });

  it("redondea half-up exacto (33333 con 0.01 % = 33330) y el borde .5 sube", () => {
    expect(computeQuoteTotals([{ roomTypeId: RT, rooms: 1, rateCents: 33_333 }], "2031-06-12", "2031-06-13", 1).totalCents).toBe(33_330);
    // 1 x 5 centavos con 10 % de descuento = 4.5 -> 5 (half-up), con 30 % = 3.5 -> 4
    expect(computeQuoteTotals([{ roomTypeId: RT, rooms: 1, rateCents: 5 }], "2031-06-12", "2031-06-13", 1000).totalCents).toBe(5);
    expect(computeQuoteTotals([{ roomTypeId: RT, rooms: 1, rateCents: 5 }], "2031-06-12", "2031-06-13", 3000).totalCents).toBe(4);
  });

  it("sin descuento y con descuento total (100 %) los extremos son exactos", () => {
    expect(computeQuoteTotals([{ roomTypeId: RT, rooms: 2, rateCents: 100 }], "2031-06-12", "2031-06-14", 0).totalCents).toBe(400);
    expect(computeQuoteTotals([{ roomTypeId: RT, rooms: 2, rateCents: 100 }], "2031-06-12", "2031-06-14", 10_000).totalCents).toBe(0);
  });

  it("suma varios renglones y no pierde precision en el maximo permitido (sin flotantes)", () => {
    const lines = [
      { roomTypeId: RT, rooms: 1000, rateCents: 100_000_000 },
      { roomTypeId: RT2, rooms: 1000, rateCents: 99_999_999 },
    ];
    const r = computeQuoteTotals(lines, "2031-01-01", "2031-03-02", 1);
    expect(r.nights).toBe(60);
    expect(r.grossCents).toBe(1000 * 100_000_000 * 60 + 1000 * 99_999_999 * 60);
    expect(Number.isSafeInteger(r.grossCents)).toBe(true);
  });

  it("rechaza decimales, negativos, fuera de rango, repetidos y estancias invalidas", () => {
    const ok = [{ roomTypeId: RT, rooms: 1, rateCents: 100 }];
    expect(() => computeQuoteTotals([{ roomTypeId: RT, rooms: 1, rateCents: 100.5 }], "2031-06-12", "2031-06-13", 0)).toThrow(GruposInvalidInputError);
    expect(() => computeQuoteTotals([{ roomTypeId: RT, rooms: 1, rateCents: -1 }], "2031-06-12", "2031-06-13", 0)).toThrow(GruposInvalidInputError);
    expect(() => computeQuoteTotals([{ roomTypeId: RT, rooms: 1, rateCents: 100_000_001 }], "2031-06-12", "2031-06-13", 0)).toThrow(GruposInvalidInputError);
    expect(() => computeQuoteTotals([{ roomTypeId: RT, rooms: 0, rateCents: 1 }], "2031-06-12", "2031-06-13", 0)).toThrow(GruposInvalidInputError);
    expect(() => computeQuoteTotals([{ roomTypeId: RT, rooms: 1001, rateCents: 1 }], "2031-06-12", "2031-06-13", 0)).toThrow(GruposInvalidInputError);
    expect(() => computeQuoteTotals([...ok, ...ok], "2031-06-12", "2031-06-13", 0)).toThrow(GruposInvalidInputError);
    expect(() => computeQuoteTotals([], "2031-06-12", "2031-06-13", 0)).toThrow(GruposInvalidInputError);
    expect(() => computeQuoteTotals(ok, "2031-06-13", "2031-06-12", 0)).toThrow(GruposInvalidInputError);
    expect(() => computeQuoteTotals(ok, "2031-06-12", "2031-08-12", 0)).toThrow(GruposInvalidInputError);
    expect(() => computeQuoteTotals(ok, "2031-06-12", "2031-06-13", 10_001)).toThrow(GruposInvalidInputError);
    expect(() => computeQuoteTotals(ok, "2031-06-12", "2031-06-13", 1.5)).toThrow(GruposInvalidInputError);
    expect(() => computeQuoteTotals(ok, "2031-02-30", "2031-03-02", 0)).toThrow(GruposInvalidInputError);
  });
});

describe("fechas", () => {
  it("noches cruzando mes y anio; la noche de salida no cuenta", () => {
    expect(eachNight("2031-12-30", "2032-01-02")).toEqual(["2031-12-30", "2031-12-31", "2032-01-01"]);
    expect(groupNightCount("2032-02-27", "2032-03-01")).toBe(3); // 2032 es bisiesto
    expect(isGroupIsoDate("2032-02-29")).toBe(true);
    expect(isGroupIsoDate("2031-02-29")).toBe(false);
    expect(isGroupIsoDate("2031-6-1")).toBe(false);
  });
});

describe("summarizePickup", () => {
  it("confirmados vs bloqueados, pendientes y retenidos", () => {
    expect(summarizePickup([
      { blockedRooms: 5, pickedUpRooms: 2, releasedRooms: 0 },
      { blockedRooms: 5, pickedUpRooms: 1, releasedRooms: 2 },
    ])).toEqual({ blockedRoomNights: 10, pickedUpRoomNights: 3, releasedRoomNights: 2, pendingRoomNights: 5, heldRoomNights: 8, pickupPct: 30 });
  });
  it("sin bloqueo no divide entre cero", () => {
    expect(summarizePickup([]).pickupPct).toBe(0);
  });
});

describe("cutoff y zona horaria de la property", () => {
  it("el mismo instante es otro dia segun la zona (Mexico_City UTC-6 vs Tijuana UTC-7 en verano)", () => {
    const at = new Date("2031-06-05T06:30:00Z");
    expect(localDateIn(at, "America/Mexico_City")).toBe("2031-06-05");
    expect(localDateIn(at, "America/Tijuana")).toBe("2031-06-04");
    expect(isCutoffReached("2031-06-05", at, "America/Mexico_City")).toBe(true);
    expect(isCutoffReached("2031-06-05", at, "America/Tijuana")).toBe(false);
  });

  it("borde exacto: a las 05:59:59Z aun es el dia anterior en Mexico_City, a las 06:00:00Z ya cambio", () => {
    expect(isCutoffReached("2031-06-05", new Date("2031-06-05T05:59:59Z"), "America/Mexico_City")).toBe(false);
    expect(isCutoffReached("2031-06-05", new Date("2031-06-05T06:00:00Z"), "America/Mexico_City")).toBe(true);
  });

  it("zona nula o invalida cae a America/Mexico_City en vez de lanzar", () => {
    const at = new Date("2031-06-05T06:00:00Z");
    expect(localDateIn(at, null)).toBe("2031-06-05");
    expect(localDateIn(at, "Mundo/Inexistente")).toBe("2031-06-05");
    expect(isCutoffReached("2031-06-05", new Date("2031-06-05T05:59:59Z"), "Mundo/Inexistente")).toBe(false);
  });
});
