// CFO-04 · estado de resultados operativo (diseño §4.3): captura pendiente, EBITDA solo completo, food cost, prorrateo, regla SR, alcance.
import { describe, expect, it } from "vitest";
import { columnaDe, construirEstadoResultados, dividirEnPeriodos, lineaDe, type EntradaEstadoResultados } from "../src/cfo/estado-resultados.ts";
import { CFO_CONFIG_POR_DEFECTO, type AlcanceSucursales, type FilaAgenteDiario, type FilaCostoCaptura, type FilaSrResumen, type FilaVentasDiarias } from "../src/cfo/tipos.ts";
import { expandirDias } from "../src/cfo/util.ts";
import { generarDatasetSintetico, SUCURSALES_PM_SINTETICAS } from "./fixtures/cfo-pm-sintetico.ts";

const A = "prop-a";
const B = "prop-b";
const SUC = [{ propertyId: A, nombre: "Sucursal A" }, { propertyId: B, nombre: "Sucursal B" }];
const ORG_COMPLETA: AlcanceSucursales = { propertyIds: [A, B], todas: true, organizacionCompleta: true };
const ACOTADO: AlcanceSucursales = { propertyIds: [A], todas: true, organizacionCompleta: false };

function venta(p: Partial<FilaVentasDiarias> = {}): FilaVentasDiarias {
  return {
    propertyId: A, diaNegocio: "2026-09-01", canal: "domicilio", source: "whatsapp", paymentMethod: "efectivo", pedidos: 4, brutaCentavos: 130000, descPromoCentavos: 14000, descCompCentavos: 0,
    netaCentavos: 116000, propinaCentavos: 0, cancelados: 1, canceladosCentavos: 20000, noRecogidos: 0, noRecogidosCentavos: 0, reposiciones: 0, reposicionUnidades: 0, entregados: 4,
    entregaMinSuma: 180, entregaTarde: 0, ...p,
  };
}
function agente(p: Partial<FilaAgenteDiario> = {}): FilaAgenteDiario {
  return {
    propertyId: A, diaNegocio: "2026-09-01", waConversacionesNuevas: 10, waConPedido: 4, waConHandoff: 0, waHandoffs: 0, vozLlamadas: 0, vozPedidoCreado: 0, vozEscalado: 0, vozAbandonado: 0,
    costoVozMicroUsd: 0, costoTelefoniaMicroUsd: 0, costoMetaMicroUsd: 0, costoLlmMicroUsd: 0, costoVozCentavos: 1000, costoTelefoniaCentavos: 200, costoMetaCentavos: null, costoLlmCentavos: null,
    metaEventos: 0, ...p,
  };
}
function cap(concepto: FilaCostoCaptura["concepto"], monto: number | null, p: Partial<FilaCostoCaptura> = {}): FilaCostoCaptura {
  return { propertyId: A, mes: "2026-09-01", concepto, montoCentavos: monto, pct: null, ...p };
}
function entrada(p: Partial<EntradaEstadoResultados> = {}): EntradaEstadoResultados {
  return {
    ventas: [venta()], cortesias: [], costosAgente: [agente()], costosCapturados: [], config: CFO_CONFIG_POR_DEFECTO, granularidad: "mes", rango: { desde: "2026-09-01", hasta: "2026-09-30" },
    alcance: { propertyIds: [A], todas: true, organizacionCompleta: true }, sucursales: SUC, ...p,
  };
}
const completos = (prop: string): FilaCostoCaptura[] => [
  cap("insumos", 40000, { propertyId: prop }), cap("comision_terminal", 1500, { propertyId: prop }), cap("nomina", 20000, { propertyId: prop }), cap("renta", 10000, { propertyId: prop }),
  cap("servicios", 5000, { propertyId: prop }), cap("otros", 2000, { propertyId: prop }),
];

describe("sin captura: EBITDA incompleto y margen de contribución visible", () => {
  const er = construirEstadoResultados(entrada());
  const col = columnaDe(er.acumulado, A)!;

  it("la cascada de ventas sale de los datos medidos", () => {
    expect(col.titular.etiqueta).toBe("Ventas por el agente");
    expect(col.titular.cifra.valor).toBe(116000);
    expect(lineaDe(col, "ventas_brutas").cifra.valor).toBe(130000);
    expect(lineaDe(col, "descuentos_promocion").cifra.valor).toBe(14000);
    expect(lineaDe(col, "compensaciones").cifra.valor).toBe(0);
    expect(lineaDe(col, "ventas_netas").cifra.valor).toBe(116000);
    expect(lineaDe(col, "iva_estimado").cifra.valor).toBe(16000); // 116000 × 16/116
    expect(lineaDe(col, "iva_estimado").cifra.confianza).toBe("estimado");
    expect(lineaDe(col, "ventas_netas_sin_iva").cifra.valor).toBe(100000);
    expect(col.memo.descuadreCascadaCentavos).toBe(0);
  });
  it("las líneas sin captura son «captura pendiente» (valor null, no 0)", () => {
    for (const id of ["costo_ventas", "comision_terminal", "nomina", "renta", "servicios", "otros"] as const) {
      const l = lineaDe(col, id);
      expect(l.faltaCaptura).toBe(true);
      expect(l.cifra.valor).toBeNull();
      expect(l.cifra.confianza).toBe("sin_dato");
    }
  });
  it("no hay utilidad bruta ni EBITDA; incompleto lista lo que falta", () => {
    expect(lineaDe(col, "utilidad_bruta").cifra.valor).toBeNull();
    expect(col.ebitda.valor).toBeNull();
    expect(col.incompleto).toEqual(["costo_ventas", "comision_terminal", "nomina", "renta", "servicios", "otros"]);
    expect(col.incompleto).toContain("nomina");
  });
  it("el margen de contribución sí se muestra, marcado parcial", () => {
    expect(col.margenContribucion.cifra.valor).toBe(98800); // 100000 − 1200 del agente
    expect(col.margenContribucion.parcial).toBe(true);
    expect(col.margenContribucion.faltan).toEqual(["food_cost", "comision_terminal"]);
  });
  it("el costo del agente es medido y Meta queda «no medido»", () => {
    expect(lineaDe(col, "costo_agente").cifra.valor).toBe(1200);
    expect(lineaDe(col, "costo_agente").cifra.confianza).toBe("medido");
    expect(col.costoAgente?.metaMedido).toBe(false);
    expect(col.notas.join(" ")).toContain("no medido");
  });
  it("el memo trae cancelaciones y no recogidos", () => {
    expect(col.memo.cancelaciones.valor).toBe(20000);
    expect(col.memo.noRecogidos.valor).toBe(0);
  });
});

describe("food cost", () => {
  it("con insumos capturados hay utilidad bruta", () => {
    const er = construirEstadoResultados(entrada({ costosCapturados: [cap("insumos", 40000)] }));
    const col = columnaDe(er.acumulado, A)!;
    expect(lineaDe(col, "costo_ventas").cifra.valor).toBe(40000);
    expect(lineaDe(col, "costo_ventas").cifra.confianza).toBe("capturado");
    expect(lineaDe(col, "utilidad_bruta").cifra.valor).toBe(60000);
    expect(col.ratios.foodCostPct.valor).toBe(40);
    expect(col.ratios.margenBrutoPct.valor).toBe(60);
    expect(col.margenContribucion.faltan).toEqual(["comision_terminal"]);
  });
  it("con % objetivo: food cost estimado = pct × neta sin IVA", () => {
    const er = construirEstadoResultados(entrada({ costosCapturados: [{ ...cap("food_cost_objetivo_pct", null), pct: 32 }] }));
    const col = columnaDe(er.acumulado, A)!;
    expect(lineaDe(col, "costo_ventas").cifra.valor).toBe(32000);
    expect(lineaDe(col, "costo_ventas").cifra.confianza).toBe("estimado");
    expect(lineaDe(col, "utilidad_bruta").cifra.valor).toBe(68000);
  });
  it("el monto de insumos gana sobre el % objetivo", () => {
    const er = construirEstadoResultados(entrada({ costosCapturados: [cap("insumos", 40000), { ...cap("food_cost_objetivo_pct", null), pct: 32 }] }));
    expect(lineaDe(columnaDe(er.acumulado, A)!, "costo_ventas").cifra.valor).toBe(40000);
  });
  it("un % capturado a nivel organización aplica a cada sucursal", () => {
    const er = construirEstadoResultados(entrada({ costosCapturados: [{ ...cap("food_cost_objetivo_pct", null, { propertyId: null }), pct: 30 }] }));
    expect(lineaDe(columnaDe(er.acumulado, A)!, "costo_ventas").cifra.valor).toBe(30000);
  });
  it("sin ventas no se inventa un food cost por %", () => {
    const er = construirEstadoResultados(entrada({ ventas: [], costosCapturados: [{ ...cap("food_cost_objetivo_pct", null), pct: 32 }] }));
    const l = lineaDe(columnaDe(er.acumulado, A)!, "costo_ventas");
    expect(l.cifra.valor).toBeNull();
    expect(l.faltaCaptura).toBe(true);
  });
});

describe("comisión de terminal", () => {
  it("capturada gana; si no, pct de config × ventas con tarjeta; si no, pendiente", () => {
    const conTarjeta = [venta({ paymentMethod: "tarjeta", pedidos: 2, netaCentavos: 60000 }), venta({ paymentMethod: "efectivo", netaCentavos: 56000 })];
    const cfg = { ...CFO_CONFIG_POR_DEFECTO, comisionTerminalPct: 2.5 };
    const porPct = columnaDe(construirEstadoResultados(entrada({ ventas: conTarjeta, config: cfg })).acumulado, A)!;
    expect(lineaDe(porPct, "comision_terminal").cifra.valor).toBe(1500); // 2.5 % de $600
    expect(lineaDe(porPct, "comision_terminal").cifra.confianza).toBe("estimado");
    const capturada = columnaDe(construirEstadoResultados(entrada({ ventas: conTarjeta, config: cfg, costosCapturados: [cap("comision_terminal", 999)] })).acumulado, A)!;
    expect(lineaDe(capturada, "comision_terminal").cifra.valor).toBe(999);
    expect(lineaDe(capturada, "comision_terminal").cifra.confianza).toBe("capturado");
    const pendiente = columnaDe(construirEstadoResultados(entrada({ ventas: conTarjeta })).acumulado, A)!;
    expect(lineaDe(pendiente, "comision_terminal").faltaCaptura).toBe(true);
  });
});

describe("EBITDA completo y ratios", () => {
  const er = construirEstadoResultados(entrada({ costosCapturados: completos(A) }));
  const col = columnaDe(er.acumulado, A)!;
  it("EBITDA = neta sin IVA − todos los costos", () => {
    expect(col.incompleto).toEqual([]);
    expect(col.ebitda.valor).toBe(100000 - 40000 - 1200 - 1500 - 20000 - 10000 - 5000 - 2000); // 20300
    expect(lineaDe(col, "ebitda").faltaCaptura).toBe(false);
    expect(col.margenContribucion.parcial).toBe(false);
    expect(col.margenContribucion.cifra.valor).toBe(57300);
  });
  it("ratios: margen bruto, food cost, prime cost, costo del agente y punto de equilibrio", () => {
    expect(col.ratios.margenBrutoPct.valor).toBe(60);
    expect(col.ratios.foodCostPct.valor).toBe(40);
    expect(col.ratios.primeCostPct.valor).toBe(60); // (40000 + 20000) / 100000
    expect(col.ratios.costoAgentePct.valor).toBe(1.2);
    expect(col.ratios.margenContribucionPct.valor).toBe(57.3);
    expect(col.ratios.puntoEquilibrio.valor).toBe(64572); // 37000 × 100000 / 57300 = 64572.4
  });
  it("EBITDA es estimado (depende del IVA estimado)", () => {
    expect(col.ebitda.confianza).toBe("estimado");
  });
});

describe("prorrateo del mes cuando el rango es parcial", () => {
  const costos = [cap("nomina", 30000), cap("insumos", 30000)];
  it("medio mes: proporcional a los días del mes y rotulado «estimado (prorrateo)»", () => {
    const er = construirEstadoResultados(entrada({ costosCapturados: costos, rango: { desde: "2026-09-01", hasta: "2026-09-15" } }));
    const col = columnaDe(er.acumulado, A)!;
    const nomina = lineaDe(col, "nomina");
    expect(nomina.cifra.valor).toBe(15000);
    expect(nomina.cifra.confianza).toBe("estimado");
    expect(nomina.estimadoPorProrrateo).toBe(true);
    expect(nomina.nota).toBe("estimado (prorrateo)");
    expect(lineaDe(col, "costo_ventas").cifra.valor).toBe(15000);
  });
  it("mes completo: el monto capturado tal cual, sin rótulo de prorrateo", () => {
    const col = columnaDe(construirEstadoResultados(entrada({ costosCapturados: costos })).acumulado, A)!;
    expect(lineaDe(col, "nomina").cifra.valor).toBe(30000);
    expect(lineaDe(col, "nomina").cifra.confianza).toBe("capturado");
    expect(lineaDe(col, "nomina").estimadoPorProrrateo).toBe(false);
  });
  it("redondeo half away from zero del prorrateo (10 días de 30)", () => {
    const er = construirEstadoResultados(entrada({ costosCapturados: [cap("nomina", 10001)], rango: { desde: "2026-09-01", hasta: "2026-09-10" } }));
    expect(lineaDe(columnaDe(er.acumulado, A)!, "nomina").cifra.valor).toBe(3334); // 10001 × 10/30 = 3333.67
  });
  it("un rango que cruza dos meses prorratea cada mes por separado", () => {
    const er = construirEstadoResultados(entrada({
      ventas: [venta({ diaNegocio: "2026-08-31" }), venta({ diaNegocio: "2026-09-01" })],
      costosCapturados: [cap("renta", 31000, { mes: "2026-08-01" }), cap("renta", 30000)],
      rango: { desde: "2026-08-31", hasta: "2026-09-01" },
    }));
    // agosto: 1 de 31 días de 31000 = 1000; septiembre: 1 de 30 días de 30000 = 1000
    expect(lineaDe(columnaDe(er.acumulado, A)!, "renta").cifra.valor).toBe(2000);
  });
  it("si falta un mes del rango, la línea queda con valor parcial y marcada como faltante", () => {
    const er = construirEstadoResultados(entrada({ costosCapturados: [cap("renta", 31000, { mes: "2026-08-01" })], rango: { desde: "2026-08-31", hasta: "2026-09-01" } }));
    const l = lineaDe(columnaDe(er.acumulado, A)!, "renta");
    expect(l.faltaCaptura).toBe(true);
  });
});

describe("regla SR: ventas del agente ≠ ventas del negocio", () => {
  const rango = { desde: "2026-09-01", hasta: "2026-09-03" };
  const dias = expandirDias(rango.desde, rango.hasta);
  const ventas = dias.map((d) => venta({ diaNegocio: d, pedidos: 1, brutaCentavos: 40000, descPromoCentavos: 0, netaCentavos: 40000, cancelados: 0, canceladosCentavos: 0, entregados: 1, entregaMinSuma: 40 }));
  const sr = (prop: string, dia: string): FilaSrResumen[] => [
    { propertyId: prop, diaNegocio: dia, tipoServicio: "domicilio", formaPago: "efectivo", tickets: 3, brutaCentavos: 110000, descuentoCentavos: 10000, canceladoCentavos: 0, propinaCentavos: 0, ivaCentavos: null, netaCentavos: 100000 },
    { propertyId: prop, diaNegocio: dia, tipoServicio: "comedor", formaPago: "tarjeta", tickets: 5, brutaCentavos: 220000, descuentoCentavos: 20000, canceladoCentavos: 5000, propinaCentavos: 15000, ivaCentavos: null, netaCentavos: 200000 },
    { propertyId: prop, diaNegocio: dia, tipoServicio: "para_llevar", formaPago: "efectivo", tickets: 2, brutaCentavos: 60000, descuentoCentavos: 0, canceladoCentavos: 0, propinaCentavos: 0, ivaCentavos: null, netaCentavos: 60000 },
    { propertyId: prop, diaNegocio: dia, tipoServicio: "rapido", formaPago: "efectivo", tickets: 1, brutaCentavos: 20000, descuentoCentavos: 0, canceladoCentavos: 0, propinaCentavos: 0, ivaCentavos: null, netaCentavos: 20000 },
  ];
  const srA = dias.flatMap((d) => sr(A, d));

  it("sin SR el titular es «Ventas por el agente»", () => {
    const col = columnaDe(construirEstadoResultados(entrada({ ventas, rango })).acumulado, A)!;
    expect(col.titular.origen).toBe("agente");
    expect(col.titular.etiqueta).toBe("Ventas por el agente");
    expect(col.titular.cifra.valor).toBe(120000);
    expect(col.titular.desglose).toBeNull();
  });

  it("con SR cubriendo el rango: titular = Σ SR, con desglose domicilio / presencial", () => {
    const er = construirEstadoResultados(entrada({ ventas, rango, srResumen: srA }));
    const col = columnaDe(er.acumulado, A)!;
    expect(er.acumulado.usaSr).toBe(true);
    expect(col.titular.origen).toBe("softrestaurant");
    expect(col.titular.etiqueta).toBe("Ventas del negocio (SoftRestaurant)");
    expect(col.titular.cifra.valor).toBe(3 * 380000);
    expect(col.titular.cifra.confianza).toBe("importado");
    expect(col.titular.desglose).toMatchObject({ domicilioSR: 3 * 100000, presencial: 3 * (200000 + 60000 + 20000), otro: 0, comedor: 600000, paraLlevar: 180000, rapido: 60000 });
    expect(lineaDe(col, "ventas_netas").cifra.valor).toBe(1_140_000);
    expect(lineaDe(col, "ventas_brutas").cifra.valor).toBe(3 * 410000);
    expect(lineaDe(col, "descuentos_promocion").cifra.valor).toBe(90000);
    expect(lineaDe(col, "ventas_netas_sin_iva").cifra.valor).toBe(1_140_000 - Math.round((1_140_000 * 16) / 116));
    expect(col.memo.cancelaciones.valor).toBe(15000);
    expect(col.memo.propinasTarjeta.valor).toBe(45000);
  });

  it("NUNCA se suman SR y agente: domicilio + presencial + otro == titular, y el agente es solo memo", () => {
    const col = columnaDe(construirEstadoResultados(entrada({ ventas, rango, srResumen: srA })).acumulado, A)!;
    const d = col.titular.desglose!;
    expect(d.domicilioSR + d.presencial + d.otro).toBe(col.titular.cifra.valor);
    expect(col.titular.cifra.valor).not.toBe(col.titular.cifra.valor! + 120000);
    expect(col.titular.ventasAgenteMemo?.valor).toBe(120000);
    expect(lineaDe(col, "ventas_netas").cifra.valor).toBe(col.titular.cifra.valor);
    // el domicilio de SR es mayor o igual al del agente: el agente es un subconjunto
    expect(d.domicilioSR).toBeGreaterThanOrEqual(120000);
  });

  it("SR que cubre solo parte de los días NO se usa como titular", () => {
    const er = construirEstadoResultados(entrada({ ventas, rango, srResumen: dias.slice(0, 2).flatMap((d) => sr(A, d)) }));
    expect(er.acumulado.usaSr).toBe(false);
    expect(columnaDe(er.acumulado, A)!.titular.origen).toBe("agente");
  });

  it("con dos sucursales, si SR cubre solo una se queda el titular del agente en todas (nunca se mezclan)", () => {
    const er = construirEstadoResultados(entrada({
      ventas: [...ventas, ...ventas.map((v) => ({ ...v, propertyId: B }))], rango, srResumen: srA, alcance: ORG_COMPLETA,
    }));
    expect(er.acumulado.usaSr).toBe(false);
    expect(columnaDe(er.acumulado, A)!.titular.origen).toBe("agente");
    expect(columnaDe(er.acumulado, "total")!.titular.cifra.valor).toBe(240000);
  });

  it("con dos sucursales cubiertas por SR, el total es la suma de SR y el desglose se suma sin doble conteo", () => {
    const srB = dias.flatMap((d) => sr(B, d));
    const er = construirEstadoResultados(entrada({ ventas: [...ventas, ...ventas.map((v) => ({ ...v, propertyId: B }))], rango, srResumen: [...srA, ...srB], alcance: ORG_COMPLETA }));
    const total = columnaDe(er.acumulado, "total")!;
    expect(total.titular.origen).toBe("softrestaurant");
    expect(total.titular.cifra.valor).toBe(2 * 1_140_000);
    const d = total.titular.desglose!;
    expect(d.domicilioSR + d.presencial + d.otro).toBe(total.titular.cifra.valor);
    expect(total.titular.ventasAgenteMemo?.valor).toBe(240000);
  });

  it("el IVA de SR, cuando viene en el archivo, es importado", () => {
    const conIva = srA.map((f) => ({ ...f, ivaCentavos: Math.round((f.netaCentavos * 16) / 116) }));
    const col = columnaDe(construirEstadoResultados(entrada({ ventas, rango, srResumen: conIva })).acumulado, A)!;
    expect(lineaDe(col, "iva_estimado").cifra.confianza).toBe("importado");
  });
});

describe("total, «No asignado» y alcance", () => {
  const costosAgente = [agente(), agente({ propertyId: B }), agente({ propertyId: null, costoVozCentavos: null, costoTelefoniaCentavos: null, costoLlmCentavos: 5000 })];
  const ventas = [venta(), venta({ propertyId: B, netaCentavos: 58000, brutaCentavos: 64000, descPromoCentavos: 6000, pedidos: 2 })];

  it("dos sucursales + No asignado + total; el total suma ventas y el costo del agente incluye el LLM de la organización", () => {
    const er = construirEstadoResultados(entrada({ ventas, costosAgente, alcance: ORG_COMPLETA }));
    expect(er.acumulado.columnas.map((c) => c.clave)).toEqual(["sucursal", "sucursal", "no_asignado", "total"]);
    const a = columnaDe(er.acumulado, A)!, b = columnaDe(er.acumulado, B)!, na = columnaDe(er.acumulado, "no_asignado")!, t = columnaDe(er.acumulado, "total")!;
    expect(lineaDe(t, "ventas_netas").cifra.valor).toBe(116000 + 58000);
    expect(lineaDe(a, "costo_agente").cifra.valor).toBe(1200);
    expect(lineaDe(b, "costo_agente").cifra.valor).toBe(1200);
    expect(lineaDe(na, "costo_agente").cifra.valor).toBe(5000);
    expect(lineaDe(t, "costo_agente").cifra.valor).toBe(1200 + 1200 + 5000);
    expect(lineaDe(na, "ventas_netas").cifra.valor).toBeNull();
    expect(na.ebitda.valor).toBeNull();
    // consolidado == Σ sucursales + No asignado, para cada línea de monto
    for (const id of ["ventas_brutas", "descuentos_promocion", "ventas_netas", "iva_estimado", "ventas_netas_sin_iva", "costo_agente"] as const) {
      const suma = [a, b, na].reduce((s, c) => s + (lineaDe(c, id).cifra.valor ?? 0), 0);
      expect(lineaDe(t, id).cifra.valor).toBe(suma);
    }
  });

  it("el admin acotado NO recibe «No asignado» ni el LLM de la organización, aunque la entrada lo traiga", () => {
    const er = construirEstadoResultados(entrada({ ventas, costosAgente, alcance: ACOTADO }));
    expect(er.acumulado.columnas.map((c) => c.clave)).toEqual(["sucursal", "total"]);
    const t = columnaDe(er.acumulado, "total")!;
    expect(lineaDe(t, "costo_agente").cifra.valor).toBe(1200);
    expect(lineaDe(t, "ventas_netas").cifra.valor).toBe(116000); // la sucursal B está fuera de su alcance
    expect(t.notas.join(" ")).toContain("No incluye el costo de IA de texto");
    expect(JSON.stringify(er)).not.toContain(B);
  });

  it("tampoco ve costos capturados a nivel organización", () => {
    const er = construirEstadoResultados(entrada({ costosCapturados: [cap("nomina", 99999, { propertyId: null })], alcance: ACOTADO }));
    const a = columnaDe(er.acumulado, A)!;
    expect(lineaDe(a, "nomina").cifra.valor).toBeNull();
    expect(lineaDe(a, "nomina").faltaCaptura).toBe(true);
    expect(JSON.stringify(er)).not.toContain("99999");
  });

  it("una selección parcial de sucursales con organización completa no muestra «No asignado»", () => {
    const er = construirEstadoResultados(entrada({ ventas, costosAgente, alcance: { propertyIds: [A], todas: false, organizacionCompleta: true } }));
    expect(er.acumulado.columnas.some((c) => c.clave === "no_asignado")).toBe(false);
  });

  it("al total le falta captura si a UNA sucursal le falta: el EBITDA total no se inventa", () => {
    const er = construirEstadoResultados(entrada({ ventas, costosAgente, alcance: ORG_COMPLETA, costosCapturados: completos(A) }));
    const a = columnaDe(er.acumulado, A)!, b = columnaDe(er.acumulado, B)!, t = columnaDe(er.acumulado, "total")!;
    expect(a.incompleto).toEqual([]);
    expect(b.incompleto.length).toBeGreaterThan(0);
    const nomina = lineaDe(t, "nomina");
    expect(nomina.faltaCaptura).toBe(true);
    expect(nomina.faltantes).toEqual([B]);
    expect(nomina.cifra.valor).toBe(20000); // lo capturado de A, sin inventar lo de B
    expect(t.ebitda.valor).toBeNull();
    expect(t.incompleto).toContain("nomina");
  });

  it("con las dos sucursales completas, el EBITDA total es la suma de los EBITDA", () => {
    const er = construirEstadoResultados(entrada({
      ventas, costosAgente: costosAgente.slice(0, 2).concat(agente({ propertyId: null, costoVozCentavos: null, costoTelefoniaCentavos: null, costoLlmCentavos: 0 })),
      alcance: ORG_COMPLETA, costosCapturados: [...completos(A), ...completos(B)],
    }));
    const a = columnaDe(er.acumulado, A)!, b = columnaDe(er.acumulado, B)!, t = columnaDe(er.acumulado, "total")!;
    expect(a.ebitda.valor).not.toBeNull();
    expect(b.ebitda.valor).not.toBeNull();
    expect(t.ebitda.valor).toBe(a.ebitda.valor! + b.ebitda.valor!);
  });

  it("un costo capturado a nivel organización no es «faltante» en las sucursales; vive en «No asignado» y suma al total", () => {
    const sinNomina = (p: string): FilaCostoCaptura[] => completos(p).filter((c) => c.concepto !== "nomina");
    const er = construirEstadoResultados(entrada({
      ventas, costosAgente, alcance: ORG_COMPLETA, costosCapturados: [...sinNomina(A), ...sinNomina(B), cap("nomina", 50000, { propertyId: null })],
    }));
    const a = columnaDe(er.acumulado, A)!, na = columnaDe(er.acumulado, "no_asignado")!, t = columnaDe(er.acumulado, "total")!;
    expect(lineaDe(a, "nomina").faltaCaptura).toBe(false);
    expect(lineaDe(a, "nomina").cifra.valor).toBeNull();
    expect(lineaDe(na, "nomina").cifra.valor).toBe(50000);
    expect(lineaDe(t, "nomina").cifra.valor).toBe(50000);
    expect(lineaDe(t, "nomina").faltaCaptura).toBe(false);
    expect(a.ebitda.valor).toBeNull(); // hay costos sin asignar: el EBITDA completo está en el Total
    expect(t.incompleto).toEqual([]);
    expect(t.ebitda.valor).not.toBeNull();
  });
});

describe("casos borde", () => {
  it("cero ventas: nada de 0 inventados, todo sin dato", () => {
    const er = construirEstadoResultados(entrada({ ventas: [], costosAgente: [] }));
    const col = columnaDe(er.acumulado, A)!;
    expect(col.titular.cifra.valor).toBeNull();
    expect(lineaDe(col, "ventas_netas").cifra.valor).toBeNull();
    expect(lineaDe(col, "ventas_netas_sin_iva").cifra.valor).toBeNull();
    expect(lineaDe(col, "costo_agente").cifra.valor).toBeNull();
    expect(col.ebitda.valor).toBeNull();
    expect(col.ratios.margenBrutoPct.valor).toBeNull();
    expect(col.margenContribucion.cifra.valor).toBeNull();
    expect(col.incompleto).toContain("ventas_netas_sin_iva");
  });
  it("una sola sucursal: el total es igual a la sucursal", () => {
    const er = construirEstadoResultados(entrada({ costosCapturados: completos(A) }));
    const a = columnaDe(er.acumulado, A)!, t = columnaDe(er.acumulado, "total")!;
    expect(t.ebitda.valor).toBe(a.ebitda.valor);
    expect(lineaDe(t, "ventas_netas").cifra.valor).toBe(lineaDe(a, "ventas_netas").cifra.valor);
  });
  it("sucursal en el alcance sin ninguna fila: columna con todo sin dato; el total no se contamina", () => {
    const er = construirEstadoResultados(entrada({ alcance: ORG_COMPLETA }));
    const b = columnaDe(er.acumulado, B)!;
    expect(b.titular.cifra.valor).toBeNull();
    expect(lineaDe(b, "ventas_netas").cifra.valor).toBeNull();
    const t = columnaDe(er.acumulado, "total")!;
    expect(lineaDe(t, "ventas_netas").cifra.valor).toBe(116000);
    expect(lineaDe(t, "ventas_netas").faltantes).toEqual([B]);
  });
  it("devoluciones/negativos: una venta negativa se resta y el descuadre de la cascada lo delata", () => {
    const er = construirEstadoResultados(entrada({ ventas: [venta(), venta({ pedidos: 0, brutaCentavos: 0, descPromoCentavos: 0, netaCentavos: -5000, cancelados: 0, canceladosCentavos: 0, entregados: 0, entregaMinSuma: 0 })] }));
    const col = columnaDe(er.acumulado, A)!;
    expect(lineaDe(col, "ventas_netas").cifra.valor).toBe(111000);
    expect(col.memo.descuadreCascadaCentavos).toBe(5000);
  });
  it("redondeo del IVA sobre cifras que no dividen exacto", () => {
    const col = columnaDe(construirEstadoResultados(entrada({ ventas: [venta({ netaCentavos: 31200, brutaCentavos: 31200, descPromoCentavos: 0 })] })).acumulado, A)!;
    expect(lineaDe(col, "iva_estimado").cifra.valor).toBe(4303);
    expect(lineaDe(col, "ventas_netas_sin_iva").cifra.valor).toBe(26897);
  });
  it("pedidos de web o panel se declaran aparte: no son «del agente»", () => {
    const col = columnaDe(construirEstadoResultados(entrada({ ventas: [venta(), venta({ source: "admin", pedidos: 1, netaCentavos: 10000, brutaCentavos: 10000, descPromoCentavos: 0 })] })).acumulado, A)!;
    expect(col.memo.ventasOtrosOrigenes.valor).toBe(10000);
    expect(col.notas.join(" ")).toContain("panel o la web");
  });
  it("rangos inválidos lanzan", () => {
    expect(() => construirEstadoResultados(entrada({ rango: { desde: "2026-09-31", hasta: "2026-10-02" } }))).toThrow(RangeError);
  });
});

describe("granularidad", () => {
  it("dividirEnPeriodos: día, semana (lunes) y mes recortados al rango", () => {
    expect(dividirEnPeriodos("2026-09-01", "2026-09-03", "dia").map((p) => p.clave)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(dividirEnPeriodos("2026-09-01", "2026-09-20", "semana")).toEqual([
      { clave: "2026-08-31", desde: "2026-09-01", hasta: "2026-09-06" },
      { clave: "2026-09-07", desde: "2026-09-07", hasta: "2026-09-13" },
      { clave: "2026-09-14", desde: "2026-09-14", hasta: "2026-09-20" },
    ]);
    expect(dividirEnPeriodos("2026-08-20", "2026-09-10", "mes")).toEqual([
      { clave: "2026-08", desde: "2026-08-20", hasta: "2026-08-31" },
      { clave: "2026-09", desde: "2026-09-01", hasta: "2026-09-10" },
    ]);
    expect(dividirEnPeriodos("2026-09-05", "2026-09-05", "mes")).toHaveLength(1);
  });
  it("las ventas de los periodos suman el acumulado (semana y mes)", () => {
    const d = generarDatasetSintetico();
    for (const g of ["dia", "semana", "mes"] as const) {
      const er = construirEstadoResultados({
        ventas: d.ventasDiarias, cortesias: d.cortesias, costosAgente: d.agenteDiario, costosCapturados: [], config: d.config, granularidad: g, rango: { desde: d.desde, hasta: d.hasta },
        alcance: { propertyIds: d.sucursales.map((s) => s.propertyId), todas: true, organizacionCompleta: true }, sucursales: d.sucursales,
      });
      const sumaPeriodos = er.periodos.reduce((s, p) => s + (lineaDe(columnaDe(p, "total")!, "ventas_netas").cifra.valor ?? 0), 0);
      expect(sumaPeriodos).toBe(lineaDe(columnaDe(er.acumulado, "total")!, "ventas_netas").cifra.valor);
    }
  });
});

describe("dataset sintético de PM (7 sucursales)", () => {
  const d = generarDatasetSintetico();
  const er = construirEstadoResultados({
    ventas: d.ventasDiarias, cortesias: d.cortesias, costosAgente: d.agenteDiario, costosCapturados: [], config: d.config, granularidad: "mes", rango: { desde: d.desde, hasta: d.hasta },
    alcance: { propertyIds: d.sucursales.map((s) => s.propertyId), todas: true, organizacionCompleta: true }, sucursales: d.sucursales,
  });
  it("7 sucursales + No asignado + total; consolidado == Σ + No asignado", () => {
    const cols = er.acumulado.columnas;
    expect(cols.filter((c) => c.clave === "sucursal")).toHaveLength(SUCURSALES_PM_SINTETICAS.length);
    const t = cols.find((c) => c.clave === "total")!;
    for (const id of ["ventas_brutas", "ventas_netas", "descuentos_promocion", "compensaciones", "costo_agente"] as const) {
      const suma = cols.filter((c) => c.clave !== "total").reduce((s, c) => s + (lineaDe(c, id).cifra.valor ?? 0), 0);
      expect(lineaDe(t, id).cifra.valor).toBe(suma);
    }
  });
  it("la neta total coincide con la suma directa de las filas y la cascada cuadra", () => {
    const t = columnaDe(er.acumulado, "total")!;
    expect(lineaDe(t, "ventas_netas").cifra.valor).toBe(d.ventasDiarias.reduce((s, f) => s + f.netaCentavos, 0));
    expect(t.memo.descuadreCascadaCentavos).toBe(0);
    expect(t.ebitda.valor).toBeNull(); // sin captura
  });
});
