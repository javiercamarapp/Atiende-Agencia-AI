import { describe, expect, it } from "vitest";
import {
  calcularCalendarioFiscal,
  diaDeLaSemana,
  diasHabilesHasta,
  feriadosDelAnio,
  infoDiaInhabil,
  metadatosVencimiento,
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
    expect(por(calcularCalendarioFiscal(2026, 1, { regimenFiscal: "601" }))).toEqual(["ISR:2026-02-17", "IVA:2026-02-17", "DIOT:2026-03-02", "Nómina:2026-02-17", "Retenciones:2026-02-17", "IMSS:2026-02-17", "ISN:2026-02-17", "Balanza:2026-03-03"]);
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
    expect(por(r)).toEqual(["ISR:2027-01-18", "IVA:2027-01-18", "DIOT:2027-02-02", "Nómina:2027-01-18", "Retenciones:2027-01-18", "IMSS:2027-01-18", "IMSS-bimestral:2027-01-18", "ISN:2027-01-18", "Balanza:2027-02-03", "Informativa:2027-02-15", "Anual:2027-03-31"]);
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
    expect(calcularCalendarioFiscal(2026, 3, { regimenFiscal: "626" }).map((r) => r.tipo)).toEqual(["ISR", "IVA", "DIOT", "Nómina", "Retenciones", "IMSS", "ISN"]);
    expect(calcularCalendarioFiscal(2026, 12, { regimenFiscal: "626" }).at(-1)).toMatchObject({ tipo: "Anual", fechaLimite: "2027-04-30" });
  });
  it("sueldos (605): solo anual, en el periodo de diciembre", () => {
    expect(calcularCalendarioFiscal(2026, 6, { regimenFiscal: "605" })).toEqual([]);
    expect(por(calcularCalendarioFiscal(2026, 12, { regimenFiscal: "605" }))).toEqual(["Anual:2027-04-30"]);
  });
  it("603 (no lucrativas) no genera pago provisional de ISR ni balanza", () => {
    expect(calcularCalendarioFiscal(2026, 6, { regimenFiscal: "603" }).map((r) => r.tipo)).toEqual(["IVA", "DIOT", "Nómina", "Retenciones", "IMSS", "IMSS-bimestral", "ISN"]);
  });
  // D-P3-33 (brief paridad3-despachos-fiscal-correcciones): retenciones, IMSS mensual y bimestral, ISN e informativa anual.
  it("D-P3-33: retenciones de ISR/IVA el 17 hábil del mes siguiente, sin marca de validar", () => {
    expect(calcularCalendarioFiscal(2026, 7, { regimenFiscal: "612" }).find((r) => r.tipo === "Retenciones")).toMatchObject({ fechaNominal: "2026-08-17", fechaLimite: "2026-08-17", validarConFiscalista: false });
    // 17 de enero de 2027 es domingo -> lunes 18 (art. 12 CFF)
    expect(calcularCalendarioFiscal(2026, 12, { regimenFiscal: "601" }).find((r) => r.tipo === "Retenciones")).toMatchObject({ fechaNominal: "2027-01-17", fechaLimite: "2027-01-18", ajustadaPorDiaInhabil: true });
  });
  it("D-P3-33: IMSS mensual cada mes; IMSS-bimestral solo en los meses que cierran bimestre (feb, abr, jun, ago, oct, dic)", () => {
    for (let m = 1; m <= 12; m += 1) {
      const tipos = calcularCalendarioFiscal(2026, m, { regimenFiscal: "601" }).map((r) => r.tipo);
      expect(tipos.includes("IMSS"), `IMSS mes ${m}`).toBe(true);
      expect(tipos.includes("IMSS-bimestral"), `bimestral mes ${m}`).toBe(m % 2 === 0);
    }
    // bimestre ene-feb (periodo 2026-02) vence el 17 de marzo; bimestre nov-dic (2026-12) el 17 de enero -> 18 por ser domingo
    expect(calcularCalendarioFiscal(2026, 2, { regimenFiscal: "601" }).find((r) => r.tipo === "IMSS-bimestral")).toMatchObject({ periodo: "2026-02", fechaLimite: "2026-03-17" });
    expect(calcularCalendarioFiscal(2026, 12, { regimenFiscal: "601" }).find((r) => r.tipo === "IMSS-bimestral")).toMatchObject({ fechaLimite: "2027-01-18" });
  });
  it("D-P3-33: ISN estatal y la informativa anual quedan marcadas 'validar con fiscalista'", () => {
    const isn = calcularCalendarioFiscal(2026, 5, { regimenFiscal: "601" }).find((r) => r.tipo === "ISN")!;
    expect(isn).toMatchObject({ fechaLimite: "2026-06-17", validarConFiscalista: true });
    expect(isn.nota).toContain("entidad federativa");
    const inf = calcularCalendarioFiscal(2026, 12, { regimenFiscal: "601" }).find((r) => r.tipo === "Informativa")!;
    expect(inf).toMatchObject({ periodo: "2026-12", fechaNominal: "2027-02-15", fechaLimite: "2027-02-15", validarConFiscalista: true });
  });
  it("D-P3-33: la informativa solo sale en diciembre; las PF de solo-anual (605) y 616 no reciben las obligaciones nuevas", () => {
    expect(calcularCalendarioFiscal(2026, 6, { regimenFiscal: "601" }).some((r) => r.tipo === "Informativa")).toBe(false);
    expect(por(calcularCalendarioFiscal(2026, 12, { regimenFiscal: "605" }))).toEqual(["Anual:2027-04-30"]);
    expect(calcularCalendarioFiscal(2026, 12, { regimenFiscal: "616" })).toEqual([]);
  });
  it("D-P3-33: metadatosVencimiento marca ISN e Informativa por validar y da fundamento a los 5 tipos nuevos", () => {
    for (const t of ["Retenciones", "IMSS", "IMSS-bimestral", "ISN", "Informativa"] as const) expect(metadatosVencimiento(t, "2026-08-17").fundamento.length).toBeGreaterThan(10);
    expect(metadatosVencimiento("ISN", "2026-08-17").validarConFiscalista).toBe(true);
    expect(metadatosVencimiento("Informativa", "2027-02-15").validarConFiscalista).toBe(true);
    expect(metadatosVencimiento("IMSS", "2026-08-17").validarConFiscalista).toBe(false);
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

describe("diasHabilesHasta (D-P3-33)", () => {
  it("cuenta dias habiles posteriores a hoy hasta la fecha limite inclusive; 0 = hoy; -1 = vencido", () => {
    expect(diasHabilesHasta("2026-06-10", "2026-06-19")).toBe(7);
    expect(diasHabilesHasta("2026-06-19", "2026-06-19")).toBe(0);
    expect(diasHabilesHasta("2026-06-20", "2026-06-19")).toBe(-1);
  });
  it("los fines de semana no cuentan: del viernes al lunes siguiente es 1 dia habil", () => {
    expect(diasHabilesHasta("2026-06-12", "2026-06-15")).toBe(1);
    expect(diasHabilesHasta("2026-06-13", "2026-06-15")).toBe(1); // desde sabado
  });
  it("los feriados no cuentan: 16 de septiembre y Jueves/Viernes Santo", () => {
    expect(diasHabilesHasta("2026-09-15", "2026-09-17")).toBe(1);
    expect(diasHabilesHasta("2026-04-01", "2026-04-06")).toBe(1); // 2 y 3 de abril (Jueves y Viernes Santo) y fin de semana: solo el lunes 6
  });
});
