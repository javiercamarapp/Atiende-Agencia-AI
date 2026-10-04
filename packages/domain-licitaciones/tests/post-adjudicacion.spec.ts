// L-27 -- dominio puro de la post-adjudicacion: garantias, hitos, convenios y plazos. Reloj FIJO (`hoy` explicito):
// ninguna prueba depende de la fecha real. Los plazos se cuentan en dias habiles contra el calendario efectivo (L-22).
import { describe, expect, it } from "vitest";
import { buildCalendarioPlazos } from "../src/dias-inhabiles.ts";
import { NORMAS_LICITACIONES } from "../src/normas.ts";
import {
  GARANTIA_TRANSICIONES,
  PLAZOS_POST_ADJUDICACION_NORMA_ID,
  PostAdjudicacionStateError,
  PostAdjudicacionValidationError,
  assertGarantiaTransicion,
  calcularPlazos,
  evaluarGarantia,
  evaluarHito,
  parseConvenioInput,
  parseGarantiaInput,
  parseGarantiaPatch,
  parseHitoInput,
  parseHitoPatch,
  parsePlazosInput,
  resumirPostAdjudicacion,
  sumarAjustesDeMonto,
} from "../src/post-adjudicacion.ts";
import type { Convenio, Garantia, Hito } from "../src/post-adjudicacion.ts";

const HOY = "2026-10-05"; // lunes
const RESP = "11111111-1111-4111-8111-111111111111";

const garantiaBase = { tipo: "cumplimiento", monto: "125000.50", vigenciaDesde: "2026-10-01", vigenciaHasta: "2027-10-01" };

describe("parseGarantiaInput", () => {
  it("convierte el monto de cadena decimal a centavos y el porcentaje a puntos base", () => {
    const g = parseGarantiaInput({ ...garantiaBase, porcentaje: 10, afianzadora: "  Afianzadora Demo  ", numeroPoliza: "POL-1", notas: "" });
    expect(g.montoCents).toBe(12_500_050n);
    expect(g.porcentajeBp).toBe(1000);
    expect(g.afianzadora).toBe("Afianzadora Demo");
    expect(g.notas).toBeNull();
    expect(g.fechaLimiteEntrega).toBeUndefined(); // el servidor la calcula
    expect(g.entregadaEn).toBeNull();
  });

  it("rechaza montos como numero, con mas de 2 decimales, cero, negativos o gigantes", () => {
    for (const monto of [125000.5, "12.345", "0", "0.00", "-5", "abc", "", "1000000000000.01", undefined]) {
      expect(() => parseGarantiaInput({ ...garantiaBase, monto }), String(monto)).toThrow(PostAdjudicacionValidationError);
    }
  });

  it("rechaza tipo desconocido, fechas imposibles, vigencia invertida y porcentaje fuera de rango", () => {
    expect(() => parseGarantiaInput({ ...garantiaBase, tipo: "otra" })).toThrow(/tipo/);
    expect(() => parseGarantiaInput({ ...garantiaBase, vigenciaDesde: "2026-02-30" })).toThrow(/vigenciaDesde/);
    expect(() => parseGarantiaInput({ ...garantiaBase, vigenciaHasta: "2026-09-30" })).toThrow(/anterior/);
    for (const porcentaje of [0, 100.01, -1, 10.123, "10"]) expect(() => parseGarantiaInput({ ...garantiaBase, porcentaje }), String(porcentaje)).toThrow(PostAdjudicacionValidationError);
    expect(() => parseGarantiaInput("no es objeto")).toThrow(/objeto/);
    expect(() => parseGarantiaInput({ ...garantiaBase, afianzadora: "x" })).toThrow(/afianzadora/);
  });

  it("respeta una fecha limite de entrega declarada (o su ausencia explicita)", () => {
    expect(parseGarantiaInput({ ...garantiaBase, fechaLimiteEntrega: "2026-10-20" }).fechaLimiteEntrega).toBe("2026-10-20");
    expect(parseGarantiaInput({ ...garantiaBase, fechaLimiteEntrega: null }).fechaLimiteEntrega).toBeNull();
  });
});

describe("parseGarantiaPatch", () => {
  it("solo trae lo enviado y exige al menos un campo", () => {
    expect(parseGarantiaPatch({ notas: "ok" })).toEqual({ notas: "ok" });
    expect(() => parseGarantiaPatch({})).toThrow(/ningún campo/);
    expect(() => parseGarantiaPatch({ estado: "inventado" })).toThrow(/estado/);
    expect(() => parseGarantiaPatch({ vigenciaDesde: "2026-12-01", vigenciaHasta: "2026-11-01" })).toThrow(/anterior/);
    expect(parseGarantiaPatch({ monto: "10.00" }).montoCents).toBe(1000n);
  });
});

describe("maquina de estados de la garantia", () => {
  it("espejo de la base: pendiente -> entregada -> liberada/ejecutada/vencida; los finales no avanzan", () => {
    expect(() => assertGarantiaTransicion("pendiente_entrega", "entregada")).not.toThrow();
    expect(() => assertGarantiaTransicion("entregada", "liberada")).not.toThrow();
    expect(() => assertGarantiaTransicion("entregada", "vencida")).not.toThrow();
    expect(() => assertGarantiaTransicion("vencida", "ejecutada")).not.toThrow();
    expect(() => assertGarantiaTransicion("pendiente_entrega", "liberada")).toThrow(PostAdjudicacionStateError);
    expect(() => assertGarantiaTransicion("liberada", "entregada")).toThrow(/ya está liberada/);
    expect(() => assertGarantiaTransicion("ejecutada", "liberada")).toThrow(PostAdjudicacionStateError);
    expect(GARANTIA_TRANSICIONES.liberada).toEqual([]);
  });
});

describe("evaluarGarantia (vigencia a una fecha)", () => {
  const g = (estado: Garantia["estado"], vigenciaHasta: string, fechaLimiteEntrega: string | null = null) => ({ estado, vigenciaHasta, fechaLimiteEntrega });
  it("entregada con la vigencia terminada se muestra vencida aunque nadie la marque", () => {
    expect(evaluarGarantia(g("entregada", "2026-10-04"), HOY)).toMatchObject({ estadoEfectivo: "vencida", vencidaPorFecha: true, porVencer: false, diasParaVencer: -1 });
  });
  it("por vencer: dentro de 30 dias inclusive; fuera de la ventana no", () => {
    expect(evaluarGarantia(g("entregada", "2026-11-04"), HOY)).toMatchObject({ porVencer: true, diasParaVencer: 30 });
    expect(evaluarGarantia(g("entregada", "2026-11-05"), HOY).porVencer).toBe(false);
    expect(evaluarGarantia(g("entregada", HOY), HOY)).toMatchObject({ porVencer: true, vencidaPorFecha: false, diasParaVencer: 0 });
  });
  it("liberada o ejecutada nunca alertan; pendiente con limite pasado marca entrega vencida", () => {
    expect(evaluarGarantia(g("liberada", "2026-10-06"), HOY)).toMatchObject({ porVencer: false, estadoEfectivo: "liberada" });
    expect(evaluarGarantia(g("pendiente_entrega", "2027-01-01", "2026-10-04"), HOY).entregaVencida).toBe(true);
    expect(evaluarGarantia(g("pendiente_entrega", "2027-01-01", HOY), HOY).entregaVencida).toBe(false);
    expect(evaluarGarantia(g("pendiente_entrega", "2027-01-01", null), HOY).entregaVencida).toBe(false);
  });
});

describe("plazos de firma y de entrega de garantia (dias habiles + calendario)", () => {
  const sinInhabiles = buildCalendarioPlazos({ omitirOficiales: true });

  it("cuenta dias habiles: un viernes + 1 dia habil cae en lunes", () => {
    const c = calcularPlazos({ falloNotificadoEn: "2026-10-02", plazoFirmaDias: 1, firmadoEn: null, plazoGarantiaDias: null }, sinInhabiles, HOY);
    expect(c.fechaLimiteFirma).toBe("2026-10-05");
  });

  it("SALTA los dias inhabiles del calendario efectivo (oficial: 2 de noviembre no, 16 de noviembre si)", () => {
    // Fallo el jueves 12-nov-2026; +3 dias habiles: vie 13, (lun 16-nov es inhabil oficial: Revolucion), mar 17, mie 18.
    const oficial = buildCalendarioPlazos();
    expect(oficial.holidays).toContain("2026-11-16");
    const c = calcularPlazos({ falloNotificadoEn: "2026-11-12", plazoFirmaDias: 3, firmadoEn: null, plazoGarantiaDias: null }, oficial, HOY);
    expect(c.fechaLimiteFirma).toBe("2026-11-18");
    const sin = calcularPlazos({ falloNotificadoEn: "2026-11-12", plazoFirmaDias: 3, firmadoEn: null, plazoGarantiaDias: null }, sinInhabiles, HOY);
    expect(sin.fechaLimiteFirma).toBe("2026-11-17"); // sin el inhabil, un dia antes: el calendario SI cambia el resultado
  });

  it("un dia declarado por la organizacion tambien se salta", () => {
    const cal = buildCalendarioPlazos({ omitirOficiales: true, declarados: [{ fecha: "2026-10-06", nombre: "Dia de la convocante", alcance: "organizacion", tenderId: null, publicadoPor: null, fuente: null, verificacion: "por_validar" }] });
    expect(calcularPlazos({ falloNotificadoEn: "2026-10-05", plazoFirmaDias: 1, firmadoEn: null, plazoGarantiaDias: null }, cal, HOY).fechaLimiteFirma).toBe("2026-10-07");
  });

  it("la entrega de garantia se cuenta desde la firma; sin datos NO se inventa ninguna fecha", () => {
    const c = calcularPlazos({ falloNotificadoEn: "2026-09-01", plazoFirmaDias: 10, firmadoEn: "2026-09-21", plazoGarantiaDias: 5 }, sinInhabiles, HOY);
    expect(c.fechaLimiteFirma).toBe("2026-09-15");
    expect(c.fechaLimiteEntregaGarantia).toBe("2026-09-28");
    expect(c.firmaVencida).toBe(false); // ya se firmo
    const vacio = calcularPlazos(null, sinInhabiles, HOY);
    expect(vacio).toMatchObject({ fechaLimiteFirma: null, fechaLimiteEntregaGarantia: null, firmaVencida: false });
    expect(calcularPlazos({ falloNotificadoEn: "2026-09-01", plazoFirmaDias: null, firmadoEn: null, plazoGarantiaDias: 5 }, sinInhabiles, HOY).fechaLimiteFirma).toBeNull();
  });

  it("firma vencida: limite pasado y sin fecha de firma", () => {
    const c = calcularPlazos({ falloNotificadoEn: "2026-09-01", plazoFirmaDias: 5, firmadoEn: null, plazoGarantiaDias: null }, sinInhabiles, HOY);
    expect(c.fechaLimiteFirma).toBe("2026-09-08");
    expect(c.firmaVencida).toBe(true);
  });

  it("declara honestamente que el plazo legal no esta verificado y la ficha del registro normativo existe", () => {
    const c = calcularPlazos(null, sinInhabiles, HOY);
    expect(c.nota).toMatch(/no verificado contra la fuente primaria/i);
    expect(c.nota).toMatch(/abogado/i);
    const ficha = NORMAS_LICITACIONES.find((f) => f.id === PLAZOS_POST_ADJUDICACION_NORMA_ID);
    expect(ficha).toBeDefined();
    expect(ficha!.estadoVerificacion).toBe("sin_verificar");
    expect(ficha!.validarConAbogado).toBe(true);
    expect(ficha!.articulo).toBeNull(); // no se inventa ningun articulo
    expect(c.normaId).toBe(PLAZOS_POST_ADJUDICACION_NORMA_ID);
  });

  it("parsePlazosInput valida dias (1..90 enteros) y fechas reales", () => {
    expect(parsePlazosInput({ plazoFirmaDias: 15, falloNotificadoEn: "2026-10-01" })).toEqual({ plazoFirmaDias: 15, falloNotificadoEn: "2026-10-01" });
    expect(parsePlazosInput({ firmadoEn: null })).toEqual({ firmadoEn: null });
    for (const plazoFirmaDias of [0, 91, 1.5, "10", -3]) expect(() => parsePlazosInput({ plazoFirmaDias }), String(plazoFirmaDias)).toThrow(PostAdjudicacionValidationError);
    expect(() => parsePlazosInput({ firmadoEn: "2026-13-01" })).toThrow(/firmadoEn/);
    expect(() => parsePlazosInput({})).toThrow(/ningún plazo/);
  });
});

describe("hitos", () => {
  it("parseHitoInput exige titulo, responsable (UUID) y fecha real", () => {
    expect(parseHitoInput({ titulo: "Entrega de la etapa 1", responsableId: RESP, fechaCompromiso: "2026-11-30", descripcion: " detalle " })).toEqual({ titulo: "Entrega de la etapa 1", descripcion: "detalle", responsableId: RESP, fechaCompromiso: "2026-11-30" });
    expect(() => parseHitoInput({ titulo: "ab", responsableId: RESP, fechaCompromiso: "2026-11-30" })).toThrow(/titulo/);
    expect(() => parseHitoInput({ titulo: "Etapa uno", responsableId: "no-uuid", fechaCompromiso: "2026-11-30" })).toThrow(/responsableId/);
    expect(() => parseHitoInput({ titulo: "Etapa uno", responsableId: RESP, fechaCompromiso: "ayer" })).toThrow(/fechaCompromiso/);
  });

  it("parseHitoPatch: cumplir fija la fecha (hoy si no se da); cancelar la borra; no se puede volver a pendiente", () => {
    expect(parseHitoPatch({ estado: "cumplido" }, HOY)).toEqual({ estado: "cumplido", cumplidoEn: HOY });
    expect(parseHitoPatch({ estado: "cumplido", cumplidoEn: "2026-10-01" }, HOY).cumplidoEn).toBe("2026-10-01");
    expect(parseHitoPatch({ estado: "cancelado" }, HOY)).toEqual({ estado: "cancelado", cumplidoEn: null });
    expect(() => parseHitoPatch({ estado: "pendiente" }, HOY)).toThrow(/cumplido/);
    expect(() => parseHitoPatch({}, HOY)).toThrow(/ningún campo/);
  });

  it("evaluarHito: pendiente con fecha pasada es vencido, con dias de retraso; hoy no es retraso", () => {
    expect(evaluarHito({ estado: "pendiente", fechaCompromiso: "2026-10-01" }, HOY)).toEqual({ estadoEfectivo: "vencido", vencido: true, diasDeRetraso: 4 });
    expect(evaluarHito({ estado: "pendiente", fechaCompromiso: HOY }, HOY)).toMatchObject({ vencido: false, estadoEfectivo: "pendiente" });
    expect(evaluarHito({ estado: "cumplido", fechaCompromiso: "2026-01-01" }, HOY).vencido).toBe(false);
    expect(evaluarHito({ estado: "cancelado", fechaCompromiso: "2026-01-01" }, HOY).vencido).toBe(false);
  });
});

describe("convenios modificatorios", () => {
  it("cada tipo exige solo lo suyo", () => {
    expect(parseConvenioInput({ tipo: "monto", montoDelta: "-5000.00", fechaFirma: "2026-10-01", motivo: "Reduccion acordada" })).toMatchObject({ tipo: "monto", montoDeltaCents: -500_000n, nuevaFechaFin: null });
    expect(parseConvenioInput({ tipo: "plazo", nuevaFechaFin: "2027-03-31", fechaFirma: "2026-10-01", motivo: "Ampliacion" })).toMatchObject({ tipo: "plazo", montoDeltaCents: null, nuevaFechaFin: "2027-03-31" });
    expect(parseConvenioInput({ tipo: "monto_plazo", montoDelta: "12000", nuevaFechaFin: "2027-03-31", fechaFirma: "2026-10-01", motivo: "Ambos" }).montoDeltaCents).toBe(1_200_000n);
    expect(() => parseConvenioInput({ tipo: "monto", fechaFirma: "2026-10-01", motivo: "Sin monto" })).toThrow(/montoDelta/);
    expect(() => parseConvenioInput({ tipo: "plazo", fechaFirma: "2026-10-01", motivo: "Sin fecha" })).toThrow(/nuevaFechaFin/);
    expect(() => parseConvenioInput({ tipo: "plazo", montoDelta: "1.00", nuevaFechaFin: "2027-03-31", fechaFirma: "2026-10-01", motivo: "Mezclado" })).toThrow(/monto_plazo/);
    expect(() => parseConvenioInput({ tipo: "monto", montoDelta: "0", fechaFirma: "2026-10-01", motivo: "Cero" })).toThrow(/cero/);
    expect(() => parseConvenioInput({ tipo: "monto", montoDelta: 100, fechaFirma: "2026-10-01", motivo: "Numero" })).toThrow(/cadena decimal/);
    expect(() => parseConvenioInput({ tipo: "x", fechaFirma: "2026-10-01", motivo: "Tipo" })).toThrow(/tipo/);
  });

  it("suma los ajustes en centavos exactos (sin deriva de punto flotante)", () => {
    const c = (montoDelta: string | null) => ({ montoDelta });
    expect(sumarAjustesDeMonto([c("0.10"), c("0.20"), c("-0.05"), c(null)])).toBe("0.25");
    expect(sumarAjustesDeMonto([c("-100.00"), c("40.00")])).toBe("-60.00");
    expect(sumarAjustesDeMonto([])).toBe("0.00");
  });
});

describe("resumirPostAdjudicacion", () => {
  const mk = (over: Partial<Garantia>): Garantia => ({ id: "g", contractId: "c", tipo: "cumplimiento", monto: "1.00", porcentaje: null, afianzadora: null, numeroPoliza: null, vigenciaDesde: "2026-01-01", vigenciaHasta: "2027-01-01", fechaLimiteEntrega: null, entregadaEn: null, estado: "pendiente_entrega", notas: null, createdAt: "", updatedAt: "", ...over });
  const hito = (over: Partial<Hito>): Hito => ({ id: "h", contractId: "c", titulo: "t", descripcion: null, responsableId: RESP, fechaCompromiso: "2027-01-01", estado: "pendiente", cumplidoEn: null, createdAt: "", updatedAt: "", ...over });
  it("cuenta cada situacion una sola vez", () => {
    const resumen = resumirPostAdjudicacion(
      {
        garantias: [
          mk({ id: "1", estado: "entregada", entregadaEn: "2026-01-02", vigenciaHasta: "2026-10-20" }), // por vencer
          mk({ id: "2", estado: "entregada", entregadaEn: "2026-01-02", vigenciaHasta: "2026-10-01" }), // vencida por fecha
          mk({ id: "3", estado: "entregada", entregadaEn: "2026-01-02", vigenciaHasta: "2027-06-01" }), // sana
          mk({ id: "4", estado: "pendiente_entrega", fechaLimiteEntrega: "2026-10-01" }), // entrega vencida
          mk({ id: "5", estado: "liberada", entregadaEn: "2026-01-02" }),
        ],
        hitos: [hito({ id: "a", fechaCompromiso: "2026-10-01" }), hito({ id: "b" }), hito({ id: "c", estado: "cumplido", cumplidoEn: "2026-09-01", fechaCompromiso: "2026-09-01" })],
        convenios: [{ montoDelta: "100.00" }, { montoDelta: null }, { montoDelta: "-30.50" }] as unknown as Convenio[],
      },
      HOY,
    );
    expect(resumen).toEqual({ garantiasEntregadas: 2, garantiasPendientes: 1, garantiasPorVencer: 1, garantiasVencidas: 1, garantiasEntregaVencida: 1, hitosPendientes: 2, hitosVencidos: 1, ajusteDeMontoAcumulado: "69.50" });
  });
});
