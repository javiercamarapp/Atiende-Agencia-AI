// Valida el ESQUEMA del ledger de la simulacion de un mes de hoteles (scripts/simular-mes-hoteles/ledger.ts), su aritmetica de costos
// y el reloj simulado. No levanta Postgres ni la app: lo que corre contra Postgres real es scripts/simular-mes-hoteles/run.sh.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LEDGER_VERSION, validarLedger, type DiaLedger, type Ledger } from "../../../scripts/simular-mes-hoteles/ledger.ts";
import { RelojSimulado, instanteLocalIso, sumarDias } from "../../../scripts/simular-mes-hoteles/reloj.ts";
import { WA_SALIENTE_USD, lineasDeCosto, modeloAgenteHoteles, tarifasCitadas, totalDeLineas } from "../../../scripts/simular-mes-hoteles/costos.ts";

function dia(n: number, fecha: string, costoUsd: number | null): DiaLedger {
  const costos = [
    { concepto: "llm" as const, unidades: 1000, unidad: "tokens", precioUnitarioUsd: costoUsd === null ? null : costoUsd / 1000, costoUsd, estado: costoUsd === null ? ("sin_verificar" as const) : ("calculado" as const), fuente: "prices.ts" },
  ];
  return {
    dia: n,
    fecha,
    eventos: [{ tipo: "reserva.directa", actor: "staff", ok: true, status: 201, detalle: { noches: 2, huesped: "ana@example.test" } }],
    filasCreadas: { "hoteles.reservation": 1 },
    costos,
    costoTotalUsd: costoUsd ?? 0,
    http: { total: 3, porStatus: { "201": 1, "200": 2 }, cincoXX: 0 },
    asserts: [{ id: "cero-5xx", descripcion: "ningun 5xx", ok: true, detalle: "0 de 3" }],
  };
}

function ledgerValido(): Ledger {
  const dias = [dia(1, "2026-10-01", 0.002), dia(2, "2026-10-02", 0.003)];
  return {
    version: LEDGER_VERSION,
    corrida: "2026-10-03-simulacion-mes-hoteles",
    modo: "corto",
    zonaHoraria: "America/Mexico_City",
    propiedad: { habitaciones: 40, tipos: 4 },
    tarifas: { whatsapp_mensaje_saliente: { usd: null, estado: "sin_verificar", fuente: "sin fuente primaria" } },
    dias,
    hallazgos: [{ id: "H1", severidad: "alta", titulo: "x", evidencia: "y", dias: [1, 2], caminoAlterno: "ruta manual" }],
    resumen: { dias: 2, eventos: 2, costoTotalUsd: 0.005, costoSinVerificarUnidades: { whatsapp: 4 }, asserts: { total: 2, fallidos: 0 } },
  };
}

describe("validarLedger", () => {
  it("acepta un ledger bien formado", () => {
    expect(validarLedger(ledgerValido())).toEqual([]);
  });

  it("rechaza lo que no es un objeto", () => {
    expect(validarLedger(null)).toEqual(["el ledger debe ser un objeto"]);
    expect(validarLedger([])).toEqual(["el ledger debe ser un objeto"]);
  });

  it("exige dias consecutivos desde 1", () => {
    const l = ledgerValido();
    const roto = { ...l, dias: [dia(1, "2026-10-01", 0.002), dia(3, "2026-10-02", 0.003)] };
    expect(validarLedger(roto).join("\n")).toContain("consecutivo desde 1");
  });

  it("exige que costoTotalUsd sea la suma de las lineas con costo", () => {
    const l = ledgerValido();
    const malo = { ...dia(1, "2026-10-01", 0.002), costoTotalUsd: 99 };
    const roto = { ...l, dias: [malo, l.dias[1]!] };
    expect(validarLedger(roto).join("\n")).toContain("costoTotalUsd debe ser la suma");
  });

  it("no admite un costo sin tarifa ni una linea sin fuente", () => {
    const l = ledgerValido();
    const d = dia(1, "2026-10-01", 0.002);
    const sinFuente = { ...d, costos: [{ ...d.costos[0]!, fuente: "" }] };
    expect(validarLedger({ ...l, dias: [sinFuente, l.dias[1]!] }).join("\n")).toContain("fuente requerida");
    const costoSinTarifa = { ...d, costos: [{ ...d.costos[0]!, precioUnitarioUsd: null }] };
    expect(validarLedger({ ...l, dias: [costoSinTarifa, l.dias[1]!] }).join("\n")).toContain("costo sin tarifa");
  });

  it("una tarifa sin precio solo puede ser sin_verificar", () => {
    const l = ledgerValido();
    const roto = { ...l, tarifas: { pac: { usd: null, estado: "calculado", fuente: "x" } } };
    expect(validarLedger(roto).join("\n")).toContain("sin precio solo puede ser sin_verificar");
  });

  it("exige la lista de hallazgos y que cada uno traiga evidencia", () => {
    const l = ledgerValido();
    const { hallazgos: _h, ...sin } = l;
    expect(validarLedger(sin).join("\n")).toContain("hallazgos: arreglo requerido");
    expect(validarLedger({ ...l, hallazgos: [{ ...l.hallazgos[0]!, evidencia: "" }] }).join("\n")).toContain("hallazgos[0]");
    expect(validarLedger({ ...l, hallazgos: [] })).toEqual([]);
  });

  it("el resumen debe coincidir con los dias (eventos, costo y asserts)", () => {
    const l = ledgerValido();
    expect(validarLedger({ ...l, resumen: { ...l.resumen, eventos: 7 } }).join("\n")).toContain("resumen.eventos");
    expect(validarLedger({ ...l, resumen: { ...l.resumen, costoTotalUsd: 1 } }).join("\n")).toContain("resumen.costoTotalUsd");
    expect(validarLedger({ ...l, resumen: { ...l.resumen, asserts: { total: 2, fallidos: 1 } } }).join("\n")).toContain("resumen.asserts");
  });

  it("rechaza fechas, actores y estados invalidos", () => {
    const l = ledgerValido();
    const d = dia(1, "01/10/2026", 0.002);
    const e = { ...d, eventos: [{ ...d.eventos[0]!, actor: "robot" as never }] };
    const errs = validarLedger({ ...l, dias: [e, l.dias[1]!] }).join("\n");
    expect(errs).toContain("fecha: YYYY-MM-DD");
    expect(errs).toContain("eventos[0]");
  });
});

describe("costos de la simulacion", () => {
  it("usa el modelo del gateway de produccion y su fila de precios", () => {
    const modelo = modeloAgenteHoteles();
    const t = tarifasCitadas();
    expect(modelo).toMatch(/\//);
    expect(t.llm_entrada_por_millon!.estado).toBe("calculado");
    expect(t.llm_entrada_por_millon!.fuente).toContain(modelo);
  });

  it("deja WhatsApp, PAC, correo y voz como sin_verificar y fuera del total", () => {
    const lineas = lineasDeCosto({ llm: { llamadas: 2, tokensEntrada: 2_000_000, tokensSalida: 1_000_000 }, waSalientes: 10, timbres: 2, correos: 3 });
    for (const c of ["whatsapp", "pac", "correo", "voz"] as const) {
      const l = lineas.find((x) => x.concepto === c)!;
      expect(l.estado).toBe("sin_verificar");
      expect(l.costoUsd).toBeNull();
    }
    const llm = lineas.find((x) => x.concepto === "llm")!;
    expect(llm.estado).toBe("calculado");
    expect(totalDeLineas(lineas)).toBe(llm.costoUsd);
    expect(WA_SALIENTE_USD).toBeGreaterThan(0);
  });

  it("el costo LLM es tokens x precio por millon del gateway", () => {
    const [in1, out1] = [tarifasCitadas().llm_entrada_por_millon!.usd!, tarifasCitadas().llm_salida_por_millon!.usd!];
    const llm = lineasDeCosto({ llm: { llamadas: 1, tokensEntrada: 1_000_000, tokensSalida: 1_000_000 }, waSalientes: 0, timbres: 0, correos: 0 }).find((x) => x.concepto === "llm")!;
    expect(llm.costoUsd).toBeCloseTo(in1 + out1, 8);
  });
});

describe("reloj simulado", () => {
  const reloj = new RelojSimulado("2026-10-01T06:00:00.000Z");
  afterEach(() => reloj.desinstalar());

  it("mueve Date.now y new Date() y se restaura al desinstalar", () => {
    const real = Date.now();
    reloj.instalar();
    expect(new Date().toISOString()).toBe("2026-10-01T06:00:00.000Z");
    reloj.avanzarMinutos(90);
    expect(Date.now()).toBe(Date.parse("2026-10-01T07:30:00.000Z"));
    expect(new Date("2026-01-01T00:00:00Z").toISOString()).toBe("2026-01-01T00:00:00.000Z");
    reloj.desinstalar();
    expect(Math.abs(Date.now() - real)).toBeLessThan(60_000);
  });

  it("no retrocede", () => {
    expect(() => reloj.avanzarMinutos(-1)).toThrow(/no retrocede/);
    expect(() => reloj.irA("2020-01-01T00:00:00Z")).toThrow(/no retrocede/);
  });

  it("convierte hora local de la property a instante UTC (sin horario de verano en Mexico desde 2022)", () => {
    expect(instanteLocalIso("2026-10-03", "09:00", "America/Mexico_City")).toBe("2026-10-03T15:00:00.000Z");
    expect(instanteLocalIso("2026-07-03", "23:30", "America/Mexico_City")).toBe("2026-07-04T05:30:00.000Z");
    expect(instanteLocalIso("2026-07-03", "12:00", "America/Cancun")).toBe("2026-07-03T17:00:00.000Z");
  });

  it("suma dias de calendario", () => {
    expect(sumarDias("2026-10-31", 1)).toBe("2026-11-01");
    expect(sumarDias("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("ledgers guardados en docs/qa", () => {
  it("todo docs/qa/*-simulacion-mes-hoteles/ledger.json cumple el esquema y trae sus asserts en verde", () => {
    const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/qa");
    const carpetas = readdirSync(raiz).filter((d) => d.endsWith("-simulacion-mes-hoteles"));
    expect(carpetas.length).toBeGreaterThan(0);
    for (const carpeta of carpetas) {
      const ledger = JSON.parse(readFileSync(resolve(raiz, carpeta, "ledger.json"), "utf8")) as unknown;
      expect(validarLedger(ledger), carpeta).toEqual([]);
      const l = ledger as Ledger;
      expect(l.resumen.asserts.fallidos, `${carpeta}: asserts fallidos`).toBe(0);
      for (const h of l.hallazgos) expect(h.evidencia.length, `${carpeta}: ${h.id}`).toBeGreaterThan(40);
    }
  });
});
