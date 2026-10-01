import { describe, expect, it } from "vitest";
import {
  calcularCalendarioFiscal,
  diaDeLaSemana,
  feriadosDelAnio,
  infoDiaInhabil,
  regimenSoportado,
  siguienteDiaHabil,
  sumarDias,
  tipoPersonaDeRegimen,
} from "../src/vencimientos/calendario-fiscal.ts";

const fechas = (y: number) => feriadosDelAnio(y).map((f) => f.fecha);

describe("feriados (LFT art. 74 por regla, Semana Santa por validar)", () => {
  it("2026", () => {
    expect(fechas(2026)).toEqual(["2026-01-01", "2026-02-02", "2026-03-16", "2026-04-02", "2026-04-03", "2026-05-01", "2026-09-16", "2026-11-16", "2026-12-25"]);
  });
  it("2027", () => {
    expect(fechas(2027)).toEqual(["2027-01-01", "2027-02-01", "2027-03-15", "2027-03-25", "2027-03-26", "2027-05-01", "2027-09-16", "2027-11-15", "2027-12-25"]);
  });
  it("1 de diciembre solo cada 6 años (transmisión del Poder Ejecutivo)", () => {
    expect(fechas(2024)).toContain("2024-12-01");
    expect(fechas(2030)).toContain("2030-12-01");
    expect(fechas(2026)).not.toContain("2026-12-01");
  });
  it("Semana Santa queda marcada por validar; los de la LFT no", () => {
    const f = feriadosDelAnio(2026);
    expect(f.filter((x) => x.porValidar).map((x) => x.nombre)).toEqual(["Jueves Santo", "Viernes Santo"]);
  });
});

describe("día hábil (art. 12 CFF)", () => {
  it("utilidades de fecha sin zona horaria", () => {
    expect(diaDeLaSemana("2026-10-01")).toBe(4); // jueves
    expect(sumarDias("2026-12-31", 1)).toBe("2027-01-01");
    expect(sumarDias("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("sábado, domingo y feriado son inhábiles; un martes normal no", () => {
    expect(infoDiaInhabil("2026-05-16")).toMatchObject({ inhabil: true, motivo: "sábado" });
    expect(infoDiaInhabil("2026-05-17")).toMatchObject({ inhabil: true, motivo: "domingo" });
    expect(infoDiaInhabil("2026-09-16").inhabil).toBe(true);
    expect(infoDiaInhabil("2026-09-15").inhabil).toBe(false);
  });
  it("un día hábil no se mueve", () => {
    expect(siguienteDiaHabil("2026-08-17")).toMatchObject({ fecha: "2026-08-17", ajustada: false, validarConFiscalista: false });
  });
  it("fin de semana -> lunes", () => {
    expect(siguienteDiaHabil("2027-01-17")).toMatchObject({ fecha: "2027-01-18", ajustada: true });
    expect(siguienteDiaHabil("2026-02-28").fecha).toBe("2026-03-02");
  });
  it("feriado de la LFT -> siguiente hábil, sin pedir validación", () => {
    expect(siguienteDiaHabil("2026-03-16")).toMatchObject({ fecha: "2026-03-17", ajustada: true, validarConFiscalista: false });
  });
  it("Jueves Santo -> siguiente hábil y marca validar con fiscalista", () => {
    expect(siguienteDiaHabil("2026-04-02")).toMatchObject({ fecha: "2026-04-06", validarConFiscalista: true });
    expect(siguienteDiaHabil("2027-03-25").fecha).toBe("2027-03-29");
  });
  it("ventana vacacional del SAT y años fuera de cobertura piden validar sin inventar un día inhábil", () => {
    expect(siguienteDiaHabil("2026-07-15")).toMatchObject({ fecha: "2026-07-15", validarConFiscalista: false });
    expect(siguienteDiaHabil("2026-07-17")).toMatchObject({ fecha: "2026-07-17", validarConFiscalista: true });
    expect(siguienteDiaHabil("2026-07-31")).toMatchObject({ fecha: "2026-07-31", validarConFiscalista: true });
    expect(siguienteDiaHabil("2026-12-25")).toMatchObject({ fecha: "2026-12-28", validarConFiscalista: true });
    expect(siguienteDiaHabil("2028-03-15")).toMatchObject({ validarConFiscalista: true });
  });
});

describe("calcularCalendarioFiscal", () => {
  const por = (rows: ReturnType<typeof calcularCalendarioFiscal>) => rows.map((r) => `${r.tipo}:${r.fechaLimite}`);

  it("PM general, enero 2026", () => {
    expect(por(calcularCalendarioFiscal(2026, 1, { regimenFiscal: "601" }))).toEqual(["ISR:2026-02-17", "IVA:2026-02-17", "DIOT:2026-03-02", "Nómina:2026-02-17", "Balanza:2026-03-03"]);
  });
  it("DIOT: último día del mes siguiente, ajustado a hábil", () => {
    const d = (m: number) => calcularCalendarioFiscal(2026, m, { regimenFiscal: "601" }).find((r) => r.tipo === "DIOT")!;
    expect(d(1)).toMatchObject({ fechaNominal: "2026-02-28", fechaLimite: "2026-03-02", ajustadaPorDiaInhabil: true });
    expect(d(2).fechaLimite).toBe("2026-03-31");
    expect(d(3).fechaLimite).toBe("2026-04-30");
    expect(d(12)).toMatchObject({ fechaNominal: "2027-01-31", fechaLimite: "2027-02-02" });
    expect(d(1).validarConFiscalista).toBe(true); // el plazo (RMF 4.5.1) está por validar
  });
  it("diciembre cruza de año y agrega la anual PM el 31 de marzo", () => {
    const r = calcularCalendarioFiscal(2026, 12, { regimenFiscal: "601" });
    expect(por(r)).toEqual(["ISR:2027-01-18", "IVA:2027-01-18", "DIOT:2027-02-02", "Nómina:2027-01-18", "Balanza:2027-02-03", "Anual:2027-03-31"]);
    expect(r.find((x) => x.tipo === "Anual")!.periodo).toBe("2026-12");
  });
  it("balanza PM día 3 y PF día 5 del segundo mes", () => {
    expect(calcularCalendarioFiscal(2026, 9, { regimenFiscal: "601" }).find((r) => r.tipo === "Balanza")!.fechaLimite).toBe("2026-11-03");
    expect(calcularCalendarioFiscal(2026, 1, { regimenFiscal: "612" }).find((r) => r.tipo === "Balanza")!).toMatchObject({ fechaLimite: "2026-03-05", validarConFiscalista: true });
  });
  it("PF actividad empresarial: anual el 30 de abril", () => {
    expect(calcularCalendarioFiscal(2025, 12, { regimenFiscal: "612" }).find((r) => r.tipo === "Anual")!.fechaLimite).toBe("2026-04-30");
  });
  it("RESICO PF (626): mensuales sin balanza; anual abril", () => {
    expect(calcularCalendarioFiscal(2026, 3, { regimenFiscal: "626" }).map((r) => r.tipo)).toEqual(["ISR", "IVA", "DIOT", "Nómina"]);
    expect(calcularCalendarioFiscal(2026, 12, { regimenFiscal: "626" }).at(-1)).toMatchObject({ tipo: "Anual", fechaLimite: "2027-04-30" });
  });
  it("sueldos (605): solo anual, en el periodo de diciembre", () => {
    expect(calcularCalendarioFiscal(2026, 6, { regimenFiscal: "605" })).toEqual([]);
    expect(por(calcularCalendarioFiscal(2026, 12, { regimenFiscal: "605" }))).toEqual(["Anual:2027-04-30"]);
  });
  it("603 (no lucrativas) no genera pago provisional de ISR ni balanza", () => {
    expect(calcularCalendarioFiscal(2026, 6, { regimenFiscal: "603" }).map((r) => r.tipo)).toEqual(["IVA", "DIOT", "Nómina"]);
  });
  it("616 (sin obligaciones) no genera nada; un régimen desconocido lanza", () => {
    expect(calcularCalendarioFiscal(2026, 12, { regimenFiscal: "616" })).toEqual([]);
    expect(() => calcularCalendarioFiscal(2026, 1, { regimenFiscal: "000" })).toThrow(/000/);
  });
  it("cada obligación cita su fundamento", () => {
    for (const r of calcularCalendarioFiscal(2026, 12, { regimenFiscal: "601" })) expect(r.fundamento.length).toBeGreaterThan(10);
  });
  it("catálogo de regímenes", () => {
    expect(tipoPersonaDeRegimen("601")).toBe("moral");
    expect(tipoPersonaDeRegimen("612")).toBe("fisica");
    expect(tipoPersonaDeRegimen("999")).toBeNull();
    expect(regimenSoportado("616")).toBe(true);
  });
});
