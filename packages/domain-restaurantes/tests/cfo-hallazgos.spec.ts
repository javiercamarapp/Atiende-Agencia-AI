// CFO-04 · motor de hallazgos «Lo más importante»: los 14 tipos disparan con su caso y NO disparan justo bajo el umbral.
import { describe, expect, it } from "vitest";
import { detectarHallazgos, ordenarHallazgos, promediarSumasAgente, promediarSumasVentas, rutaCfo, TIPOS_HALLAZGO, type EntradaHallazgos, type Hallazgo, type MetricasSucursalHallazgos, type TipoHallazgo } from "../src/cfo/hallazgos.ts";
import { cuadreSr, sumarAgente, sumarComandas, sumarVentas } from "../src/cfo/formulas.ts";
import { CFO_CONFIG_POR_DEFECTO, type FilaAgenteDiario, type FilaAgotado, type FilaComandasPos, type FilaEscalacionHora, type FilaVentasDiarias } from "../src/cfo/tipos.ts";
import { generarDatasetSintetico, SUCURSALES_PM_SINTETICAS } from "./fixtures/cfo-pm-sintetico.ts";

const C = CFO_CONFIG_POR_DEFECTO;
const A = "suc-a";
const B = "suc-b";
const CC = "suc-c";
const AHORA = new Date("2026-09-15T18:00:00Z"); // martes
const PERIODO_DIA = { desde: "2026-09-15", hasta: "2026-09-15" }; // martes
const NOMBRES = [{ propertyId: A, nombre: "Altabrisa" }, { propertyId: B, nombre: "Pensiones" }, { propertyId: CC, nombre: "Victory Platz" }];

function vf(p: Partial<FilaVentasDiarias> = {}): FilaVentasDiarias {
  return {
    propertyId: A, diaNegocio: "2026-09-15", canal: "domicilio", source: "voice", paymentMethod: "efectivo", pedidos: 100, brutaCentavos: 3_200_000, descPromoCentavos: 100_000, descCompCentavos: 0,
    netaCentavos: 3_000_000, propinaCentavos: 0, cancelados: 2, canceladosCentavos: 60_000, noRecogidos: 0, noRecogidosCentavos: 0, reposiciones: 0, reposicionUnidades: 0, entregados: 100,
    entregaMinSuma: 4000, entregaTarde: 5, ...p,
  };
}
function ag(p: Partial<FilaAgenteDiario> = {}): FilaAgenteDiario {
  return {
    propertyId: A, diaNegocio: "2026-09-15", waConversacionesNuevas: 100, waConPedido: 50, waConHandoff: 0, waHandoffs: 0, vozLlamadas: 0, vozPedidoCreado: 0, vozEscalado: 0, vozAbandonado: 0,
    costoVozMicroUsd: 0, costoTelefoniaMicroUsd: 0, costoMetaMicroUsd: null, costoLlmMicroUsd: null, costoVozCentavos: 10000, costoTelefoniaCentavos: 0, costoMetaCentavos: null, costoLlmCentavos: null, metaEventos: 0, mxnPorUsd: null, ...p,
  };
}

/** Métricas «sanas»: nada dispara. Cada prueba cambia solo lo que necesita. */
function sana(id = A, p: Partial<MetricasSucursalHallazgos> = {}): MetricasSucursalHallazgos {
  const v = sumarVentas([vf({ propertyId: id })]);
  const a = sumarAgente([ag({ propertyId: id })]);
  return {
    propertyId: id, actual: v, base4Semanas: v, anterior: v, cortesiasCentavos: 0, cortesiasBase4SemanasCentavos: 0, agente: a, agenteBase4Semanas: a, costoAgenteCentavos: 10000,
    costoAgenteBase4SemanasCentavos: 10000, descuentoPctP90Historico: null, entregaP90Min: 50, frecuentesDormidos: null, agotados: [], comandas: null, escalacionesPorFranja: [], cuadreSr: null, ...p,
  };
}
function entrada(m: MetricasSucursalHallazgos[], p: Partial<EntradaHallazgos> = {}): EntradaHallazgos {
  return { ahora: AHORA, periodo: PERIODO_DIA, sucursales: NOMBRES, metricas: m, ...p };
}
const tipos = (hs: Hallazgo[]): TipoHallazgo[] => hs.map((h) => h.tipo);
const de = (hs: Hallazgo[], t: TipoHallazgo, id = A): Hallazgo | undefined => hs.find((h) => h.tipo === t && h.propertyId === id);

describe("las métricas sanas no disparan nada", () => {
  it("ningún hallazgo", () => {
    expect(detectarHallazgos(entrada([sana(A), sana(B), sana(CC)]), C)).toEqual([]);
  });
  it("hay 14 tipos definidos", () => {
    expect(TIPOS_HALLAZGO).toHaveLength(14);
    expect(new Set(TIPOS_HALLAZGO).size).toBe(14);
  });
});

describe("1. caida_ventas", () => {
  const base = sumarVentas([vf({ netaCentavos: 1_000_000, brutaCentavos: 1_000_000, descPromoCentavos: 0 })]);
  const con = (neta: number) => sana(A, { base4Semanas: base, actual: sumarVentas([vf({ netaCentavos: neta, brutaCentavos: neta, descPromoCentavos: 0 })]) });
  it("dispara bajo (1 − 15 %) de la base y cita el día de la semana", () => {
    const h = de(detectarHallazgos(entrada([con(820_000)]), C), "caida_ventas")!;
    expect(h.titulo).toBe("Altabrisa cayó 18 % vs su promedio de los martes");
    expect(h.impactoCentavos).toBe(180_000);
    expect(h.cifraTexto).toBe("-18 %");
    expect(h.comparacion).toContain("$8,200.00");
    expect(h.accion.ruta).toBe(rutaCfo("ventas", { sucursal: A, desde: "2026-09-15", hasta: "2026-09-15" }));
    expect(h.urgencia).toBe("media");
    expect(h.fuentes).toEqual(["cfo_ventas_diarias"]);
  });
  it("justo en el umbral (−15.0 %) NO dispara; un centavo más abajo sí", () => {
    expect(de(detectarHallazgos(entrada([con(850_000)]), C), "caida_ventas")).toBeUndefined();
    expect(de(detectarHallazgos(entrada([con(849_999)]), C), "caida_ventas")).toBeDefined();
  });
  it("con periodo de varios días habla de las 4 semanas previas, y una caída ≥ 30 % es urgencia alta", () => {
    const h = de(detectarHallazgos(entrada([con(600_000)], { periodo: { desde: "2026-09-08", hasta: "2026-09-14" } }), C), "caida_ventas")!;
    expect(h.titulo).toBe("Altabrisa cayó 40 % vs su promedio de las 4 semanas previas");
    expect(h.urgencia).toBe("alta");
  });
  it("sin base o con base 0 no hay hallazgo", () => {
    expect(detectarHallazgos(entrada([sana(A, { base4Semanas: null })]), C)).toEqual([]);
    expect(detectarHallazgos(entrada([sana(A, { base4Semanas: sumarVentas([]) })]), C)).toEqual([]);
  });
  it("respeta el umbral configurado", () => {
    expect(de(detectarHallazgos(entrada([con(920_000)]), { ...C, caidaPct: 5 }), "caida_ventas")).toBeDefined();
  });
});

describe("2. ticket_baja", () => {
  const baseT = sumarVentas([vf({ pedidos: 30, netaCentavos: 900_000 })]); // ticket 30000
  const con = (pedidos: number, neta: number) => sana(A, { base4Semanas: baseT, actual: sumarVentas([vf({ pedidos, netaCentavos: neta, brutaCentavos: neta, descPromoCentavos: 0 })]) });
  it("dispara con ticket < base × 90 % y ≥ 30 pedidos; impacto = Δticket × pedidos", () => {
    const h = de(detectarHallazgos(entrada([con(30, 30 * 26_999)]), C), "ticket_baja")!;
    expect(h.titulo).toBe("El ticket promedio de Altabrisa bajó 10 %");
    expect(h.impactoCentavos).toBe((30_000 - 26_999) * 30);
  });
  it("justo en el umbral (ticket 270.00 vs 300.00) NO dispara", () => {
    expect(de(detectarHallazgos(entrada([con(30, 30 * 27_000)]), C), "ticket_baja")).toBeUndefined();
  });
  it("con 29 pedidos no se evalúa aunque el ticket se desplome", () => {
    expect(de(detectarHallazgos(entrada([con(29, 29 * 10_000)]), C), "ticket_baja")).toBeUndefined();
  });
});

describe("3. cancelacion_alta", () => {
  const suc = (id: string, cancelados: number, pedidos: number) => sana(id, { actual: sumarVentas([vf({ propertyId: id, pedidos, cancelados })]), base4Semanas: null });
  const escenario = (cA: number, pA: number) => [suc(A, cA, pA), suc(B, 2, 98), suc(CC, 4, 96)]; // B 2 %, C 4 % -> mediana de las tres según A
  it("dispara con ≥ 2 × la mediana y ≥ 5 cancelados", () => {
    // A 10 % ; B 2 % ; C 4 % -> mediana 4 % ; 2 × 4 = 8 % ≤ 10 %
    const hs = detectarHallazgos(entrada(escenario(10, 90)), C);
    const h = de(hs, "cancelacion_alta")!;
    expect(h.titulo).toBe("Altabrisa cancela 10 % de sus pedidos");
    expect(h.comparacion).toContain("2.5 veces la mediana");
    expect(h.urgencia).toBe("alta");
    expect(h.impactoCentavos).toBe((10 - 4) * 33_333); // (cancelados − esperados) × ticket ($30,000,00 / 90 pedidos)
    expect(de(hs, "cancelacion_alta", B)).toBeUndefined();
  });
  it("justo en 2 × la mediana (8.0 %) dispara (≥); en 7.0 % no", () => {
    expect(de(detectarHallazgos(entrada(escenario(8, 92)), C), "cancelacion_alta")).toBeDefined();
    expect(de(detectarHallazgos(entrada(escenario(7, 93)), C), "cancelacion_alta")).toBeUndefined();
  });
  it("con menos de 5 cancelados no dispara aunque el % sea alto", () => {
    expect(de(detectarHallazgos(entrada(escenario(4, 46)), C), "cancelacion_alta")).toBeUndefined();
  });
  it("una sola sucursal no se compara contra sí misma", () => {
    expect(detectarHallazgos(entrada([suc(A, 10, 90)]), C)).toEqual([]);
  });
  it("mediana 0: cualquier sucursal con ≥ 5 cancelados destaca", () => {
    const h = de(detectarHallazgos(entrada([suc(A, 6, 94), suc(B, 0, 100), suc(CC, 0, 100)]), C), "cancelacion_alta")!;
    expect(h.comparacion).toContain("mediana de sus sucursales es 0 %");
  });
});

describe("4. descuento_fuera_rango", () => {
  const con = (desc: number, p: Partial<MetricasSucursalHallazgos> = {}) => sana(A, { actual: sumarVentas([vf({ brutaCentavos: 1_000_000, descPromoCentavos: desc, netaCentavos: 1_000_000 - desc })]), base4Semanas: null, ...p });
  it("dispara con descuento % > 8 %; impacto = exceso en pesos", () => {
    const h = de(detectarHallazgos(entrada([con(100_000)]), C), "descuento_fuera_rango")!; // 10 %
    expect(h.titulo).toBe("Altabrisa regaló 10 % en descuentos");
    expect(h.impactoCentavos).toBe(20_000); // 2 puntos de $10,000
  });
  it("8.0 % justo NO dispara; 8.1 % sí", () => {
    expect(de(detectarHallazgos(entrada([con(80_000)]), C), "descuento_fuera_rango")).toBeUndefined();
    expect(de(detectarHallazgos(entrada([con(81_000)]), C), "descuento_fuera_rango")).toBeDefined();
  });
  it("el p90 histórico propio también cuenta (el menor de los dos topes)", () => {
    expect(de(detectarHallazgos(entrada([con(60_000, { descuentoPctP90Historico: 5 })]), C), "descuento_fuera_rango")!.impactoCentavos).toBe(10_000);
    expect(de(detectarHallazgos(entrada([con(60_000, { descuentoPctP90Historico: 6 })]), C), "descuento_fuera_rango")).toBeUndefined();
  });
  it("las compensaciones también son descuento", () => {
    const m = sana(A, { actual: sumarVentas([vf({ brutaCentavos: 1_000_000, descPromoCentavos: 0, descCompCentavos: 90_000, netaCentavos: 910_000 })]), base4Semanas: null });
    expect(de(detectarHallazgos(entrada([m]), C), "descuento_fuera_rango")).toBeDefined();
  });
});

describe("5. compensaciones_inusuales", () => {
  const base = sumarVentas([vf({ descCompCentavos: 10_000 })]);
  const con = (comp: number, cortesias = 0, baseCort: number | null = 0, b = base) => sana(A, { base4Semanas: b, actual: sumarVentas([vf({ descCompCentavos: comp })]), cortesiasCentavos: cortesias, cortesiasBase4SemanasCentavos: baseCort });
  it("dispara con ≥ 2 × su media (compensaciones + cortesías) y al menos $100 por encima", () => {
    const h = de(detectarHallazgos(entrada([con(20_000)]), C), "compensaciones_inusuales")!;
    expect(h.titulo).toBe("Las compensaciones de Altabrisa se duplicaron");
    expect(h.impactoCentavos).toBe(10_000);
    expect(h.cifra.confianza).toBe("estimado");
  });
  it("19,999 contra 10,000 NO dispara; las cortesías suman al total", () => {
    expect(de(detectarHallazgos(entrada([con(19_999)]), C), "compensaciones_inusuales")).toBeUndefined();
    expect(de(detectarHallazgos(entrada([con(10_000, 10_000)]), C), "compensaciones_inusuales")).toBeDefined();
  });
  it("por debajo del piso de $100 no dispara aunque se duplique", () => {
    expect(de(detectarHallazgos(entrada([con(2_000, 0, 0, sumarVentas([vf({ descCompCentavos: 1_000 })]))]), C), "compensaciones_inusuales")).toBeUndefined();
  });
  it("sin base de cortesías no se evalúa", () => {
    expect(de(detectarHallazgos(entrada([con(50_000, 0, null)]), C), "compensaciones_inusuales")).toBeUndefined();
  });
});

describe("6. costo_agente_alto", () => {
  // base: $100.00 de costo / 100 pedidos del agente = $1.00 por pedido (100 centavos)
  const mk = (costo: number, extra: Partial<MetricasSucursalHallazgos> = {}) => sana(A, { costoAgenteCentavos: costo, costoAgenteBase4SemanasCentavos: 10_000, ...extra });
  it("dispara con CAC ↑ ≥ 30 % vs 4 semanas", () => {
    const h = de(detectarHallazgos(entrada([mk(13_000)]), C), "costo_agente_alto")!;
    expect(h.titulo).toBe("El costo del agente por pedido en Altabrisa subió 30 %");
    expect(h.impactoCentavos).toBe((130 - 100) * 100);
    expect(h.comparacion).toContain("no se mide");
  });
  it("+29 % NO dispara", () => {
    expect(de(detectarHallazgos(entrada([mk(12_900)]), C), "costo_agente_alto")).toBeUndefined();
  });
  it("también dispara por el umbral absoluto, aunque no haya base", () => {
    const m = mk(12_100, { costoAgenteBase4SemanasCentavos: null, base4Semanas: null });
    expect(de(detectarHallazgos(entrada([m], { costoAgentePedidoMaxCentavos: 120 }), C), "costo_agente_alto")!.titulo).toContain("pasó su límite");
    expect(de(detectarHallazgos(entrada([m], { costoAgentePedidoMaxCentavos: 121 }), C), "costo_agente_alto")).toBeUndefined();
  });
  it("sin costo medido (sin tipo de cambio) no hay hallazgo", () => {
    expect(detectarHallazgos(entrada([mk(0, { costoAgenteCentavos: null })]), C)).toEqual([]);
  });
});

describe("7. cierre_agente_bajo", () => {
  const baseAg = sumarAgente([ag({ waConversacionesNuevas: 100, waConPedido: 50 })]); // 50 %
  const con = (conPedido: number) => sana(A, { agente: sumarAgente([ag({ waConversacionesNuevas: 100, waConPedido: conPedido })]), agenteBase4Semanas: baseAg });
  it("dispara cuando la tasa baja ≥ 10 puntos", () => {
    const h = de(detectarHallazgos(entrada([con(40)]), C), "cierre_agente_bajo")!;
    expect(h.titulo).toBe("El agente cierra 10 puntos menos de pedidos en Altabrisa");
    expect(h.cifraTexto).toBe("40 %");
    expect(h.impactoCentavos).toBe(Math.round(100 * 30_000 * 0.1)); // conversaciones × Δtasa × ticket
    expect(h.urgencia).toBe("alta");
  });
  it("−9.0 puntos NO dispara", () => {
    expect(de(detectarHallazgos(entrada([con(41)]), C), "cierre_agente_bajo")).toBeUndefined();
  });
  it("mezcla WhatsApp y voz en la tasa", () => {
    const m = sana(A, {
      agente: sumarAgente([ag({ waConversacionesNuevas: 50, waConPedido: 20, vozPedidoCreado: 10, vozEscalado: 20, vozAbandonado: 20 })]), // 30/100 = 30 %
      agenteBase4Semanas: sumarAgente([ag({ waConversacionesNuevas: 50, waConPedido: 30, vozPedidoCreado: 30, vozEscalado: 10, vozAbandonado: 10 })]), // 60/100 = 60 %
    });
    expect(de(detectarHallazgos(entrada([m]), C), "cierre_agente_bajo")!.titulo).toBe("El agente cierra 30 puntos menos de pedidos en Altabrisa");
  });
});

describe("8. entrega_lenta", () => {
  it("dispara con p90 > 60 min; sin impacto monetizable y urgencia alta", () => {
    const h = de(detectarHallazgos(entrada([sana(A, { entregaP90Min: 61 })]), C), "entrega_lenta")!;
    expect(h.titulo).toBe("Las entregas de Altabrisa tardan 61 min en 9 de cada 10 pedidos");
    expect(h.impactoCentavos).toBeNull();
    expect(h.urgencia).toBe("alta");
  });
  it("p90 de exactamente 60 min NO dispara", () => {
    expect(de(detectarHallazgos(entrada([sana(A, { entregaP90Min: 60 })]), C), "entrega_lenta")).toBeUndefined();
  });
  it("con promesa de 40 min el límite baja a 48 (20 % sobre la promesa)", () => {
    expect(de(detectarHallazgos(entrada([sana(A, { entregaP90Min: 49 })]), { ...C, promesaMin: 40 }), "entrega_lenta")).toBeDefined();
    expect(de(detectarHallazgos(entrada([sana(A, { entregaP90Min: 48 })]), { ...C, promesaMin: 40 }), "entrega_lenta")).toBeUndefined();
  });
  it("con menos de 5 entregas o sin p90 no se evalúa", () => {
    expect(de(detectarHallazgos(entrada([sana(A, { entregaP90Min: 99, actual: sumarVentas([vf({ entregados: 4 })]) })]), C), "entrega_lenta")).toBeUndefined();
    expect(de(detectarHallazgos(entrada([sana(A, { entregaP90Min: null })]), C), "entrega_lenta")).toBeUndefined();
  });
});

describe("9. frecuentes_dormidos", () => {
  it("dispara con ≥ 1 frecuente dormido; impacto mensual = ticket × pedidos de 90 d / 3", () => {
    const h = de(detectarHallazgos(entrada([sana(A, { frecuentesDormidos: { clientes: 5, pedidos90d: 30 } })]), C), "frecuentes_dormidos")!;
    expect(h.titulo).toBe("5 clientes frecuentes de Altabrisa llevan 30 días o más sin pedir");
    expect(h.impactoCentavos).toBe(30_000 * 10);
  });
  it("singular y cero", () => {
    expect(de(detectarHallazgos(entrada([sana(A, { frecuentesDormidos: { clientes: 1, pedidos90d: 3 } })]), C), "frecuentes_dormidos")!.titulo).toBe("1 cliente frecuente de Altabrisa lleva 30 días o más sin pedir");
    expect(detectarHallazgos(entrada([sana(A, { frecuentesDormidos: { clientes: 0, pedidos90d: 0 } })]), C)).toEqual([]);
  });
});

describe("10. agotado_estrella", () => {
  const prod = (id: string, p: Partial<FilaAgotado> = {}): FilaAgotado => ({ propertyId: A, productId: id, nombre: `Producto ${id}`, disponible: true, agotadoHasta: "2026-09-16T00:00:00Z", unidades28d: 56, diasConVenta28d: 28, precioListaCentavos: 4200, rankingUnidades: 1, ...p });
  it("dispara con un producto top 20 agotado hoy; impacto = venta en riesgo por día", () => {
    const h = de(detectarHallazgos(entrada([sana(A, { agotados: [prod("pastor")] })]), C), "agotado_estrella")!;
    expect(h.titulo).toBe("Producto pastor está agotado hoy en Altabrisa");
    expect(h.impactoCentavos).toBe(8400); // 2 unidades al día × $42
    expect(h.cifra.valor).toBe(1);
  });
  it("agotado INDEFINIDO (disponible=false y agotadoHasta=null) SÍ dispara: antes exigía agotadoHasta y nunca alertaba", () => {
    const h = de(detectarHallazgos(entrada([sana(A, { agotados: [prod("pastor", { disponible: false, agotadoHasta: null })] })]), C), "agotado_estrella")!;
    expect(h.titulo).toBe("Producto pastor está agotado hoy en Altabrisa");
    expect(h.impactoCentavos).toBe(8400);
  });
  it("disponible=false con una fecha de regreso ya pasada (sin reactivar) sigue agotado; una fecha YYYY-MM-DD de la SQL es agotado programado vigente", () => {
    expect(de(detectarHallazgos(entrada([sana(A, { agotados: [prod("x", { disponible: false, agotadoHasta: "2026-01-01" })] })]), C), "agotado_estrella")).toBeDefined();
    expect(de(detectarHallazgos(entrada([sana(A, { agotados: [prod("x", { disponible: true, agotadoHasta: "2026-09-16" })] })]), C), "agotado_estrella")).toBeDefined();
  });
  it("el puesto 21, un producto disponible o ya vencido el agotado NO disparan", () => {
    expect(detectarHallazgos(entrada([sana(A, { agotados: [prod("x", { rankingUnidades: 21 })] })]), C)).toEqual([]);
    expect(detectarHallazgos(entrada([sana(A, { agotados: [prod("x", { agotadoHasta: null })] })]), C)).toEqual([]);
    expect(detectarHallazgos(entrada([sana(A, { agotados: [prod("x", { agotadoHasta: AHORA.toISOString() })] })]), C)).toEqual([]);
    expect(detectarHallazgos(entrada([sana(A, { agotados: [prod("x", { rankingUnidades: null })] })]), C)).toEqual([]);
  });
  it("el puesto 20 sí cuenta; varios se agrupan en UN hallazgo por sucursal", () => {
    const hs = detectarHallazgos(entrada([sana(A, { agotados: [prod("a", { rankingUnidades: 20 }), prod("b", { rankingUnidades: 2 })] })]), C);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.titulo).toBe("2 productos estrella agotados hoy en Altabrisa");
    expect(hs[0]!.comparacion).toContain("Producto b, Producto a");
    expect(hs[0]!.impactoCentavos).toBe(16800);
  });
});

describe("11. comandas_sin_capturar", () => {
  const cmd = (p: Partial<FilaComandasPos>): FilaComandasPos => ({
    propertyId: A, diaNegocio: "2026-09-15", modo: "sombra", encoladas: 100, confirmadas: 10, capturadasManual: 85, capturaManualPendientes: 5, fallidas: 0, pendientesEnviadas: 0,
    minACapturaSuma: 400, capturadasConTiempo: 80, vencidasUmbral: 0, conFolioPos: 10, conFolioDeclarado: 40, ...p,
  });
  const con = (p: Partial<FilaComandasPos>) => sana(A, { comandas: sumarComandas([cmd(p)]) });
  it("dispara con tasa de captura < 95 %", () => {
    const h = de(detectarHallazgos(entrada([con({ capturadasManual: 84 })]), C), "comandas_sin_capturar")!; // 94 %
    expect(h.titulo).toBe("Altabrisa captura solo 94 % de sus comandas en SoftRestaurant");
    expect(h.impactoCentavos).toBeNull();
    expect(h.urgencia).toBe("alta");
  });
  it("95 % justo y sin vencidas NO dispara", () => {
    expect(de(detectarHallazgos(entrada([con({})]), C), "comandas_sin_capturar")).toBeUndefined();
  });
  it("dispara por comandas vencidas aunque la tasa sea buena", () => {
    const h = de(detectarHallazgos(entrada([con({ capturadasManual: 90, vencidasUmbral: 2 })]), C), "comandas_sin_capturar")!;
    expect(h.titulo).toBe("Altabrisa tiene 2 comandas vencidas sin capturar en SoftRestaurant");
  });
  it("con el envío apagado o sin comandas no hay hallazgo (no «0 %»)", () => {
    expect(detectarHallazgos(entrada([con({ modo: "apagado", capturadasManual: 0, confirmadas: 0, vencidasUmbral: 3 })]), C)).toEqual([]);
    expect(detectarHallazgos(entrada([con({ encoladas: 0, confirmadas: 0, capturadasManual: 0 })]), C)).toEqual([]);
  });
});

describe("12. escalaciones_pico", () => {
  const fr = (dow: number, hora: number, conversaciones: number, handoffs: number): FilaEscalacionHora => ({ propertyId: A, dowNegocio: dow, horaLocal: hora, conversaciones, handoffs });
  // 9 franjas tranquilas: 200 conversaciones, 8 handoffs (4 %) + la franja a evaluar
  const calma = Array.from({ length: 9 }, (_, i) => fr(1, 10 + i, i < 8 ? 22 : 24, 1));
  it("dispara cuando la tasa de una franja es ≥ 2 × la media y hay masa suficiente", () => {
    const hs = detectarHallazgos(entrada([sana(A, { escalacionesPorFranja: [...calma, fr(6, 14, 20, 6)] })]), C);
    const h = de(hs, "escalaciones_pico")!;
    expect(h.titulo).toBe("Las escalaciones de Altabrisa se disparan los sábados a las 14 h");
    expect(h.cifraTexto).toBe("30 %");
    expect(h.impactoCentavos).toBeNull();
  });
  it("una franja pequeña (< 10 conversaciones) o con < 3 handoffs no cuenta", () => {
    expect(de(detectarHallazgos(entrada([sana(A, { escalacionesPorFranja: [...calma, fr(6, 14, 9, 5)] })]), C), "escalaciones_pico")).toBeUndefined();
    expect(de(detectarHallazgos(entrada([sana(A, { escalacionesPorFranja: [...calma, fr(6, 14, 20, 2)] })]), C), "escalaciones_pico")).toBeUndefined();
  });
  it("justo bajo 2 × la media NO dispara; en 2 × exactos sí", () => {
    const total = 22 * 8 + 24 + 20; // conversaciones
    // media = (9 + h)/total; franja h/20 ≥ 2 × (9+h)/total  <=>  h × total ≥ 40 × (9 + h)
    let hMin = 3;
    while (hMin * total < 40 * (9 + hMin)) hMin++;
    expect(de(detectarHallazgos(entrada([sana(A, { escalacionesPorFranja: [...calma, fr(6, 14, 20, hMin)] })]), C), "escalaciones_pico")).toBeDefined();
    expect(de(detectarHallazgos(entrada([sana(A, { escalacionesPorFranja: [...calma, fr(6, 14, 20, hMin - 1)] })]), C), "escalaciones_pico")).toBeUndefined();
  });
  it("elige la franja más alta y desempata por día y hora", () => {
    const hs = detectarHallazgos(entrada([sana(A, { escalacionesPorFranja: [...calma, fr(6, 14, 20, 8), fr(5, 13, 20, 8)] })]), C);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.titulo).toContain("los viernes a las 13 h");
  });
});

describe("13. participacion_cae", () => {
  const dosSuc = (netaA: number, netaAnteriorA: number) => [
    sana(A, { actual: sumarVentas([vf({ propertyId: A, netaCentavos: netaA, brutaCentavos: netaA, descPromoCentavos: 0 })]), anterior: sumarVentas([vf({ propertyId: A, netaCentavos: netaAnteriorA, brutaCentavos: netaAnteriorA, descPromoCentavos: 0 })]), base4Semanas: null }),
    sana(B, { actual: sumarVentas([vf({ propertyId: B, netaCentavos: 100 * 100 - netaA, brutaCentavos: 100 * 100 - netaA, descPromoCentavos: 0 })]), anterior: sumarVentas([vf({ propertyId: B, netaCentavos: 100 * 100 - netaAnteriorA, brutaCentavos: 100 * 100 - netaAnteriorA, descPromoCentavos: 0 })]), base4Semanas: null }),
  ];
  it("dispara cuando la participación baja ≥ 5 puntos; impacto = Δ × total", () => {
    const h = de(detectarHallazgos(entrada(dosSuc(3500, 4000)), C), "participacion_cae")!; // 40 % -> 35 %
    expect(h.titulo).toBe("Altabrisa perdió 5 puntos de participación en las ventas");
    expect(h.cifraTexto).toBe("35 %");
    expect(h.impactoCentavos).toBe(500); // 5 puntos de $100.00
  });
  it("−4.9 puntos NO dispara", () => {
    expect(de(detectarHallazgos(entrada(dosSuc(3510, 4000)), C), "participacion_cae")).toBeUndefined();
  });
  it("con una sola sucursal no tiene sentido", () => {
    expect(detectarHallazgos(entrada([dosSuc(3500, 4000)[0]!]), C)).toEqual([]);
  });
});

describe("14. descuadre_sr", () => {
  it("dispara solo con semáforo rojo; impacto = |diferencia|", () => {
    const rojo = cuadreSr({ nuestroCentavos: 100_000, srCentavos: 106_000 }, C);
    const h = de(detectarHallazgos(entrada([sana(A, { cuadreSr: rojo })]), C), "descuadre_sr")!;
    expect(h.titulo).toBe("El domicilio de Altabrisa no cuadra con SoftRestaurant");
    expect(h.impactoCentavos).toBe(6_000);
    expect(h.cifra.confianza).toBe("importado");
    expect(h.comparacion).toContain("-$60.00");
  });
  it("ámbar, verde y sin datos NO disparan", () => {
    for (const sr of [102_000, 100_500, null]) {
      expect(detectarHallazgos(entrada([sana(A, { cuadreSr: cuadreSr({ nuestroCentavos: 100_000, srCentavos: sr }, C) })]), C)).toEqual([]);
    }
  });
  it("justo en el 3 % es ámbar, no rojo", () => {
    expect(cuadreSr({ nuestroCentavos: 100_000, srCentavos: 103_000 }, C).semaforo).toBe("ambar");
  });
});

describe("orden, deduplicación y tope", () => {
  const h = (tipo: TipoHallazgo, id: string, impacto: number | null, urgencia: Hallazgo["urgencia"]): Hallazgo => ({
    id: `${tipo}:${id}`, tipo, propertyId: id, sucursal: id, titulo: `${tipo} ${id}`, cifra: { valor: 1, confianza: "medido", fuente: "x" }, cifraTexto: "1", comparacion: "c", porQueImporta: "p",
    accion: { texto: "a", ruta: "/cfo/ventas" }, impactoCentavos: impacto, urgencia, fuentes: ["x"],
  });
  const lista = [
    h("caida_ventas", "A", 500, "media"), h("entrega_lenta", "A", null, "alta"), h("cancelacion_alta", "B", 900, "alta"), h("ticket_baja", "B", 900, "media"), h("descuento_fuera_rango", "C", 100, "baja"),
    h("comandas_sin_capturar", "C", null, "alta"),
  ];
  it("por impacto: mayor primero, nulos al final, empate por urgencia", () => {
    expect(ordenarHallazgos(lista, "impacto").map((x) => x.id)).toEqual(["cancelacion_alta:B", "ticket_baja:B", "caida_ventas:A", "descuento_fuera_rango:C", "comandas_sin_capturar:C", "entrega_lenta:A"]);
  });
  it("por urgencia: alta primero, dentro de cada nivel por impacto", () => {
    expect(ordenarHallazgos(lista, "urgencia").map((x) => x.id)).toEqual(["cancelacion_alta:B", "comandas_sin_capturar:C", "entrega_lenta:A", "ticket_baja:B", "caida_ventas:A", "descuento_fuera_rango:C"]);
  });
  it("las dos ordenaciones dan resultados distintos (impacto vs urgencia)", () => {
    expect(ordenarHallazgos(lista, "impacto").map((x) => x.id)).not.toEqual(ordenarHallazgos(lista, "urgencia").map((x) => x.id));
  });
  it("tope de 10", () => {
    const muchos = Array.from({ length: 25 }, (_, i) => h("caida_ventas", `S${String(i).padStart(2, "0")}`, 1000 - i, "media"));
    const r = ordenarHallazgos(muchos, "impacto");
    expect(r).toHaveLength(10);
    expect(r[0]!.propertyId).toBe("S00");
    expect(ordenarHallazgos(muchos, "impacto", 3)).toHaveLength(3);
  });
  it("deduplica por tipo × sucursal conservando el de mayor impacto", () => {
    const dup = [h("caida_ventas", "A", 100, "media"), { ...h("caida_ventas", "A", 700, "media"), id: "caida_ventas:A#2" }, h("caida_ventas", "B", 50, "media")];
    const r = ordenarHallazgos(dup, "impacto");
    expect(r).toHaveLength(2);
    expect(r.find((x) => x.propertyId === "A")!.impactoCentavos).toBe(700);
    // el mismo tipo en otra sucursal NO es duplicado
    expect(r.map((x) => x.propertyId).sort()).toEqual(["A", "B"]);
  });
  it("desempate estable por id sin importar el orden de entrada", () => {
    const empate = [h("caida_ventas", "B", 100, "media"), h("caida_ventas", "A", 100, "media"), h("caida_ventas", "C", 100, "media")];
    const esperado = ["caida_ventas:A", "caida_ventas:B", "caida_ventas:C"];
    expect(ordenarHallazgos(empate, "impacto").map((x) => x.id)).toEqual(esperado);
    expect(ordenarHallazgos([...empate].reverse(), "impacto").map((x) => x.id)).toEqual(esperado);
    expect(ordenarHallazgos(empate, "urgencia").map((x) => x.id)).toEqual(esperado);
  });
  it("lista vacía", () => {
    expect(ordenarHallazgos([], "impacto")).toEqual([]);
  });
});

describe("con datos sintéticos de PM: una caída inyectada en Altabrisa (T8) se detecta y las demás sucursales no", () => {
  const d = generarDatasetSintetico({ diasRango: 60 });
  const dia = (h: string, k: number): string => new Date(Date.parse(`${h}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
  const ventana = (id: string, hasta: string, dias: number, factor = 1) =>
    sumarVentas(d.ventasDiarias.filter((f) => f.propertyId === id && f.diaNegocio <= hasta && f.diaNegocio > dia(hasta, -dias)).map((f) => (factor === 1 ? f : { ...f, netaCentavos: Math.round(f.netaCentavos * factor) })));
  it("detecta caida_ventas solo donde se inyectó", () => {
    const hasta = d.hasta;
    const metricas = SUCURSALES_PM_SINTETICAS.map((s) => {
      const factor = s.codigo === "T8" ? 0.7 : 1;
      const actual = ventana(s.propertyId, hasta, 7, factor);
      const base = promediarSumasVentas([1, 2, 3, 4].map((k) => ventana(s.propertyId, dia(hasta, -7 * k), 7)));
      return sana(s.propertyId, { actual, base4Semanas: base, anterior: ventana(s.propertyId, dia(hasta, -7), 7), agente: null, agenteBase4Semanas: null, costoAgenteCentavos: null, costoAgenteBase4SemanasCentavos: null, entregaP90Min: null });
    });
    const hs = detectarHallazgos({ ahora: AHORA, periodo: { desde: dia(hasta, -6), hasta }, sucursales: d.sucursales, metricas }, C);
    const caidas = hs.filter((x) => x.tipo === "caida_ventas");
    expect(caidas.map((x) => x.propertyId)).toEqual([SUCURSALES_PM_SINTETICAS.find((s) => s.codigo === "T8")!.propertyId]);
    expect(caidas[0]!.titulo).toContain("Altabrisa cayó");
    expect(caidas[0]!.titulo).toContain("vs su promedio de las 4 semanas previas");
  });
});

describe("promedios de bases", () => {
  it("promedia campo a campo con redondeo de la casa; lista vacía = null", () => {
    expect(promediarSumasVentas([])).toBeNull();
    const p = promediarSumasVentas([sumarVentas([vf({ netaCentavos: 100 })]), sumarVentas([vf({ netaCentavos: 101 })])])!;
    expect(p.netaCentavos).toBe(101); // 100.5 -> 101
    expect(p.pedidos).toBe(100);
  });
  it("promediarSumasAgente ignora nulos y devuelve null si todos lo son", () => {
    const p = promediarSumasAgente([sumarAgente([ag({ costoVozCentavos: 100 })]), sumarAgente([ag({ costoVozCentavos: null })])])!;
    expect(p.vozCentavos).toBe(100);
    expect(promediarSumasAgente([sumarAgente([ag({ costoVozCentavos: null })])])!.vozCentavos).toBeNull();
    expect(promediarSumasAgente([])).toBeNull();
  });
  it("rutaCfo codifica los parámetros y omite los vacíos", () => {
    expect(rutaCfo("ventas", { sucursal: "a b", desde: "2026-09-01", x: undefined, y: "" })).toBe("/cfo/ventas?sucursal=a%20b&desde=2026-09-01");
    expect(rutaCfo("clientes")).toBe("/cfo/clientes");
  });
});

describe("determinismo", () => {
  it("la misma entrada produce exactamente la misma salida", () => {
    const e = entrada([sana(A, { entregaP90Min: 70 }), sana(B, { entregaP90Min: 80 })]);
    expect(detectarHallazgos(e, C)).toEqual(detectarHallazgos(e, C));
    expect(tipos(detectarHallazgos(e, C))).toEqual(["entrega_lenta", "entrega_lenta"]);
  });
});
