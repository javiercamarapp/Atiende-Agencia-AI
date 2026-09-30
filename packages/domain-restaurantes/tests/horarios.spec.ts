// Horario por sucursal: turnos, doble turno, cierre pasada la medianoche y zona horaria del
// negocio (PM: 12 pm a 1 am). Los instantes se construyen en UTC a partir de la hora local de
// America/Merida (UTC-6 todo el ano, sin horario de verano desde 2022).
import { describe, expect, it } from "vitest";
import { estaAbiertoAhora, leerHorarioPersistido, mensajeSucursalCerrada, validarHorario, type HorarioSucursal } from "../src/horarios.ts";
import { OrderValidationError } from "../src/errors.ts";

const ZONA = "America/Merida";
/** 2026-09-28 es lunes. `dia`: 28 = lunes ... 4 oct = domingo. */
function local(diaDelMes: number, hhmm: string, mes = 9): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, mes - 1, diaDelMes, h! + 6, m!));
}

const PM_TODOS_LOS_DIAS: HorarioSucursal = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }];
const DOBLE_TURNO: HorarioSucursal = [
  { dias: [1, 2, 3, 4, 5], abre: "12:00", cierra: "16:00" },
  { dias: [1, 2, 3, 4, 5], abre: "18:00", cierra: "23:00" },
];

describe("estaAbiertoAhora", () => {
  it("12 pm a 1 am: abierto a las 14:00, cerrado a las 11:59", () => {
    expect(estaAbiertoAhora(PM_TODOS_LOS_DIAS, local(28, "14:00"), ZONA).abierto).toBe(true);
    expect(estaAbiertoAhora(PM_TODOS_LOS_DIAS, local(28, "11:59"), ZONA).abierto).toBe(false);
    expect(estaAbiertoAhora(PM_TODOS_LOS_DIAS, local(28, "12:00"), ZONA).abierto).toBe(true);
  });

  it("cierre pasada la medianoche: a las 00:30 del martes sigue abierto con el turno del lunes; a la 01:00 cierra", () => {
    const abierto = estaAbiertoAhora(PM_TODOS_LOS_DIAS, local(29, "00:30"), ZONA);
    expect(abierto).toEqual({ abierto: true, cierraA: "01:00", proximaApertura: null });
    expect(estaAbiertoAhora(PM_TODOS_LOS_DIAS, local(29, "01:00"), ZONA).abierto).toBe(false);
    expect(estaAbiertoAhora(PM_TODOS_LOS_DIAS, local(29, "05:00"), ZONA).abierto).toBe(false);
  });

  it("la cola de madrugada solo cuenta si el turno del DIA ANTERIOR existe", () => {
    const soloLunes: HorarioSucursal = [{ dias: [1], abre: "12:00", cierra: "01:00" }];
    // martes 00:30: el turno del lunes se extiende -> abierto
    expect(estaAbiertoAhora(soloLunes, local(29, "00:30"), ZONA).abierto).toBe(true);
    // miercoles 00:30: el martes no abrio -> cerrado
    expect(estaAbiertoAhora(soloLunes, local(30, "00:30"), ZONA).abierto).toBe(false);
    // lunes 00:30: el domingo no abrio -> cerrado
    expect(estaAbiertoAhora(soloLunes, local(28, "00:30"), ZONA).abierto).toBe(false);
  });

  it("domingo a lunes: el dia anterior del domingo es el sabado (envuelve la semana)", () => {
    const soloSabado: HorarioSucursal = [{ dias: [6], abre: "18:00", cierra: "02:00" }];
    expect(estaAbiertoAhora(soloSabado, local(4, "01:00", 10), ZONA).abierto).toBe(true); // domingo 4-oct 01:00
    expect(estaAbiertoAhora(soloSabado, local(5, "01:00", 10), ZONA).abierto).toBe(false); // lunes
  });

  it("doble turno: abierto en ambos, cerrado en el descanso, y reporta la proxima apertura", () => {
    expect(estaAbiertoAhora(DOBLE_TURNO, local(28, "13:00"), ZONA).abierto).toBe(true);
    expect(estaAbiertoAhora(DOBLE_TURNO, local(28, "19:00"), ZONA).abierto).toBe(true);
    const descanso = estaAbiertoAhora(DOBLE_TURNO, local(28, "17:00"), ZONA);
    expect(descanso).toEqual({ abierto: false, cierraA: null, proximaApertura: { dia: "lunes", hora: "18:00", hoy: true } });
  });

  it("cerrado el sabado: la proxima apertura es el lunes", () => {
    const estado = estaAbiertoAhora(DOBLE_TURNO, local(3, "13:00", 10), ZONA); // sabado 3-oct
    expect(estado.abierto).toBe(false);
    expect(estado.proximaApertura).toEqual({ dia: "lunes", hora: "12:00", hoy: false });
  });

  it("usa la zona horaria del NEGOCIO, no la del proceso: 19:00 en Merida ya es el dia siguiente en UTC", () => {
    // 2026-09-29 01:00 UTC = lunes 28 a las 19:00 en Merida.
    const instante = new Date(Date.UTC(2026, 8, 29, 1, 0));
    const soloLunes: HorarioSucursal = [{ dias: [1], abre: "18:00", cierra: "23:00" }];
    expect(estaAbiertoAhora(soloLunes, instante, ZONA).abierto).toBe(true);
    // Con otra zona (Tijuana, UTC-7 en septiembre) son las 18:00 del lunes: tambien abierto;
    // con Tokio (UTC+9) ya es martes 10:00 -> cerrado.
    expect(estaAbiertoAhora(soloLunes, instante, "Asia/Tokyo").abierto).toBe(false);
  });

  it("zona invalida o ausente cae a la zona por defecto de plataforma en vez de lanzar", () => {
    expect(estaAbiertoAhora(PM_TODOS_LOS_DIAS, local(28, "14:00"), "No/Existe").abierto).toBe(true);
    expect(estaAbiertoAhora(PM_TODOS_LOS_DIAS, local(28, "14:00"), null).abierto).toBe(true);
  });

  it("horario vacio: siempre cerrado y sin proxima apertura", () => {
    expect(estaAbiertoAhora([], local(28, "14:00"), ZONA)).toEqual({ abierto: false, cierraA: null, proximaApertura: null });
  });
});

describe("validarHorario / leerHorarioPersistido", () => {
  it("normaliza dias (sin duplicados, ordenados) y acepta cierre pasada la medianoche", () => {
    expect(validarHorario([{ dias: [5, 1, 1], abre: "12:00", cierra: "01:00" }])).toEqual([{ dias: [1, 5], abre: "12:00", cierra: "01:00" }]);
  });

  it.each([
    ["no es lista", {}],
    ["dias vacio", [{ dias: [], abre: "12:00", cierra: "16:00" }]],
    ["dia fuera de rango", [{ dias: [7], abre: "12:00", cierra: "16:00" }]],
    ["hora mal formada", [{ dias: [1], abre: "12", cierra: "16:00" }]],
    ["hora 24:00", [{ dias: [1], abre: "12:00", cierra: "24:00" }]],
    ["abre igual a cierra", [{ dias: [1], abre: "12:00", cierra: "12:00" }]],
  ])("rechaza %s", (_nombre, raw) => {
    expect(() => validarHorario(raw)).toThrow(OrderValidationError);
  });

  it("un valor persistido corrupto se trata como 'sin horario' en vez de lanzar", () => {
    expect(leerHorarioPersistido("basura")).toBeNull();
    expect(leerHorarioPersistido(null)).toBeNull();
    expect(leerHorarioPersistido([{ dias: [1], abre: "12:00", cierra: "01:00" }])).toEqual([{ dias: [1], abre: "12:00", cierra: "01:00" }]);
  });
});

describe("mensajeSucursalCerrada", () => {
  it("dice cuando abre", () => {
    expect(mensajeSucursalCerrada("Altabrisa", { abierto: false, cierraA: null, proximaApertura: { dia: "lunes", hora: "12:00", hoy: false } })).toBe(
      "La sucursal Altabrisa está cerrada en este momento; abre el lunes a las 12:00.",
    );
    expect(mensajeSucursalCerrada("Altabrisa", { abierto: false, cierraA: null, proximaApertura: { dia: "lunes", hora: "18:00", hoy: true } })).toContain("abre hoy a las 18:00");
  });
});
