// CFO-04 · fórmulas de KPIs (diseño §4.2), con los casos a mano de Los Taquitos de PM.
import { describe, expect, it } from "vitest";
import {
  aporteALaVariacion, baseComparacion, cancelacionPct, churnPct, comisionTerminal, compensacion, concentracionPct, cortesiaPct, cortesias, costoAgente,
  costoPorPedidoAgente, crecimiento, cuadreSr, descuentoPct, descuentoPromocion, efectoPromocion, entregaPromedioMin, entregaTardePct, frecuentesPct,
  ivaEstimado, margenContribucion, minutosACapturaSr, mixCanalPedidos, mixCanalVentas, noRecogidoPct, propinaPct, puntoEquilibrio, recompraPct,
  soporteLift, sumarAgente, sumarComandas, sumarVentas, tasaCapturaSr, tasaCierreAgente, tasaCierreVoz, tasaCierreWhatsApp, ticketPromedio, topParesCanasta,
  valorDeVidaSimple, ventaBruta, ventaEnRiesgoAgotado, ventaNeta, ventaNetaSinIva,
} from "../src/cfo/formulas.ts";
import { divEntera, formatoCentavos, formatoPct, formatoPesos, mulDiv, pct1, razon1, redondear, sinDato } from "../src/cfo/util.ts";
import { CFO_CONFIG_POR_DEFECTO, type FilaVentasDiarias } from "../src/cfo/tipos.ts";

const PROP = "prop-1";

function fila(p: Partial<FilaVentasDiarias> = {}): FilaVentasDiarias {
  return {
    propertyId: PROP, diaNegocio: "2026-09-14", canal: "domicilio", source: "whatsapp", paymentMethod: "efectivo", pedidos: 0, brutaCentavos: 0, descPromoCentavos: 0, descCompCentavos: 0,
    netaCentavos: 0, propinaCentavos: 0, cancelados: 0, canceladosCentavos: 0, noRecogidos: 0, noRecogidosCentavos: 0, reposiciones: 0, reposicionUnidades: 0, entregados: 0,
    entregaMinSuma: 0, entregaTarde: 0, ...p,
  };
}

describe("redondeo y aritmética entera de la casa", () => {
  it("half away from zero, en positivo y negativo", () => {
    expect(divEntera(5, 2)).toBe(3);
    expect(divEntera(-5, 2)).toBe(-3);
    expect(divEntera(7, 2)).toBe(4);
    expect(divEntera(4, 3)).toBe(1);
    expect(divEntera(1, 3)).toBe(0);
    expect(divEntera(-1, 3)).toBe(0);
    expect(Object.is(divEntera(-1, 3), -0)).toBe(false);
    expect(redondear(2.5)).toBe(3);
    expect(redondear(-2.5)).toBe(-3);
    expect(redondear(0.49999)).toBe(0);
  });
  it("mulDiv no desborda 2^53", () => {
    expect(mulDiv(9_000_000_000_000, 9_000_000_000_000, 3_000_000_000_000)).toBe(27_000_000_000_000);
    expect(mulDiv(1, 1, 2)).toBe(1);
    expect(mulDiv(-1, 1, 2)).toBe(-1);
    expect(mulDiv(10, 3, -4)).toBe(-8);
  });
  it("pct1 y razon1 con 1 decimal; denominador 0 = null", () => {
    expect(pct1(1, 3)).toBe(33.3);
    expect(pct1(2, 3)).toBe(66.7);
    expect(pct1(0, 5)).toBe(0);
    expect(pct1(1, 0)).toBeNull();
    expect(pct1(5, -1)).toBeNull();
    expect(razon1(10, 4)).toBe(2.5);
    expect(razon1(1, 0)).toBeNull();
  });
  it("formato es-MX a mano (sin toLocale)", () => {
    expect(formatoCentavos(31200)).toBe("$312.00");
    expect(formatoCentavos(123456789)).toBe("$1,234,567.89");
    expect(formatoCentavos(-5)).toBe("-$0.05");
    expect(formatoPesos(31250)).toBe("$313");
    expect(formatoPct(18)).toBe("18 %");
    expect(formatoPct(18.4)).toBe("18.4 %");
  });
});

describe("casos PM a mano", () => {
  // Pedido de 6 tacos al pastor ($42) + 1 agua fresca ($60) = $312, sin promo, efectivo, domicilio.
  const pedido312 = sumarVentas([fila({ pedidos: 1, brutaCentavos: 31200, netaCentavos: 31200, entregados: 1, entregaMinSuma: 42 })]);

  it("pedido de $312 sin promo: bruta = neta, descuento 0, ticket $312", () => {
    expect(ventaBruta(pedido312).valor).toBe(31200);
    expect(ventaNeta(pedido312).valor).toBe(31200);
    expect(descuentoPromocion(pedido312).valor).toBe(0);
    expect(compensacion(pedido312).valor).toBe(0);
    expect(descuentoPct(pedido312).valor).toBe(0);
    expect(ticketPromedio(pedido312).valor).toBe(31200);
    expect(ticketPromedio(pedido312).confianza).toBe("medido");
  });

  it("IVA 16/116: $312.00 -> $43.03 de IVA y $268.97 sin IVA (estimado)", () => {
    const iva = ivaEstimado(31200, 16);
    expect(iva.valor).toBe(4303); // 31200 × 16/116 = 4303.45
    expect(iva.confianza).toBe("estimado");
    expect(ventaNetaSinIva(31200, iva.valor).valor).toBe(26897);
    expect(ivaEstimado(11600, 16).valor).toBe(1600); // exacto
    expect(ivaEstimado(null, 16).valor).toBeNull();
    expect(ivaEstimado(31200, 0).valor).toBe(0);
    expect(ivaEstimado(31200, 16.5).valor).toBe(mulDiv(31200, 1650, 11650));
  });

  it("lunes, recoger, 2x1 al pastor: bruta − neta = descuento", () => {
    // 6 tacos ($252) + agua ($60) = $312; el 2x1 regala 3 tacos = $126 -> paga $186.
    const s = sumarVentas([fila({ canal: "recoger", pedidos: 1, brutaCentavos: 31200, descPromoCentavos: 12600, netaCentavos: 18600 })]);
    expect(ventaBruta(s).valor! - ventaNeta(s).valor!).toBe(descuentoPromocion(s).valor! + compensacion(s).valor!);
    expect(descuentoPromocion(s).valor).toBe(12600);
    expect(compensacion(s).valor).toBe(0);
    expect(descuentoPct(s).valor).toBe(40.4); // 12600/31200 = 40.38 %
    expect(s.pedidosRecoger).toBe(1);
    expect(s.pedidosDomicilio).toBe(0);
  });

  it("compensación GRACIAS- del 15 %: va a compensaciones, no a promoción", () => {
    const s = sumarVentas([fila({ pedidos: 1, brutaCentavos: 31200, descCompCentavos: 4680, netaCentavos: 26520 })]);
    expect(compensacion(s).valor).toBe(4680);
    expect(descuentoPromocion(s).valor).toBe(0);
    expect(descuentoPct(s).valor).toBe(15);
  });

  it("reposición sin costo valuada a precio de lista: estimado", () => {
    // Reposición de 6 tacos + 1 agua: total $0 pero valor de lista $312.
    const s = sumarVentas([fila({ pedidos: 1, brutaCentavos: 31200, netaCentavos: 31200 }), fila({ reposiciones: 1, reposicionUnidades: 7 })]);
    expect(s.pedidos).toBe(1); // la reposición NO es venta
    expect(s.reposiciones).toBe(1);
    const c = cortesias(31200);
    expect(c.valor).toBe(31200);
    expect(c.confianza).toBe("estimado");
    expect(cortesiaPct(31200, 62400).valor).toBe(50);
    expect(cortesiaPct(0, 0).valor).toBeNull();
  });

  it("propina con tarjeta queda fuera de ingresos y solo se mide la de tarjeta", () => {
    const s = sumarVentas([
      fila({ paymentMethod: "tarjeta", pedidos: 1, brutaCentavos: 31200, netaCentavos: 31200, propinaCentavos: 3120 }),
      fila({ paymentMethod: "efectivo", pedidos: 1, brutaCentavos: 31200, netaCentavos: 31200, propinaCentavos: 0 }),
    ]);
    expect(ventaNeta(s).valor).toBe(62400); // la propina NO suma a la venta
    expect(s.propinaTarjetaCentavos).toBe(3120);
    expect(s.netaTarjetaCentavos).toBe(31200);
    expect(propinaPct(s).valor).toBe(10);
    expect(propinaPct(sumarVentas([fila({ paymentMethod: "efectivo", pedidos: 1, netaCentavos: 100 })])).valor).toBeNull(); // sin ventas con tarjeta
  });

  it("ticket con 0 pedidos = null (no 0)", () => {
    const vacio = sumarVentas([]);
    expect(ticketPromedio(vacio).valor).toBeNull();
    expect(ticketPromedio(vacio).confianza).toBe("sin_dato");
  });
});

describe("nunca se divide entre cero: sin dato, no 0", () => {
  const vacio = sumarVentas([]);
  it("todas las razones devuelven null con denominador 0", () => {
    const cs = [
      descuentoPct(vacio), cancelacionPct(vacio), noRecogidoPct(vacio), propinaPct(vacio), entregaPromedioMin(vacio), entregaTardePct(vacio), ticketPromedio(vacio),
      mixCanalPedidos(0, 0), mixCanalVentas(0, 0), cortesiaPct(0, 0), recompraPct(0, 0), churnPct(0, 0), frecuentesPct(0, 0), concentracionPct(0, 0),
      tasaCierreWhatsApp(sumarAgente([])), tasaCierreVoz(sumarAgente([])), tasaCierreAgente(sumarAgente([])), costoPorPedidoAgente(1000, 0), costoPorPedidoAgente(null, 5),
      valorDeVidaSimple(31200, 0), valorDeVidaSimple(null, 3), efectoPromocion({ unidadesConPromo: 5, diasConPromo: 0, unidadesSinPromo: 5, diasSinPromo: 3 }),
      efectoPromocion({ unidadesConPromo: 5, diasConPromo: 2, unidadesSinPromo: 0, diasSinPromo: 3 }), minutosACapturaSr({ minACapturaSuma: 0, capturadasConTiempo: 0 }),
      puntoEquilibrio(1000, 0, 5000), puntoEquilibrio(null, 100, 5000),
    ];
    for (const c of cs) {
      expect(c.valor).toBeNull();
      expect(c.confianza).toBe("sin_dato");
    }
  });
  it("las sumas vacías sí son 0 (hay un periodo sin ventas) pero las razones no", () => {
    expect(ventaNeta(vacio).valor).toBe(0);
    expect(cancelacionPct({ cancelados: 0, pedidos: 0 }).valor).toBeNull();
    expect(cancelacionPct({ cancelados: 0, pedidos: 10 }).valor).toBe(0);
  });
});

describe("cancelaciones, no recogidos y entregas", () => {
  it("cancelación % = cancelados / (pedidos + cancelados), como el cierre 041", () => {
    expect(cancelacionPct({ cancelados: 10, pedidos: 90 }).valor).toBe(10);
    expect(cancelacionPct({ cancelados: 1, pedidos: 2 }).valor).toBe(33.3);
  });
  it("no recogido % sobre pedidos de recoger + no recogidos", () => {
    expect(noRecogidoPct({ noRecogidos: 2, pedidosRecoger: 98 }).valor).toBe(2);
  });
  it("entrega promedio y % tarde", () => {
    const s = sumarVentas([fila({ entregados: 4, entregaMinSuma: 190, entregaTarde: 1 })]);
    expect(entregaPromedioMin(s).valor).toBe(47.5);
    expect(entregaTardePct(s).valor).toBe(25);
  });
  it("mix de canal por pedidos y por ventas", () => {
    expect(mixCanalPedidos(2806, 3929).valor).toBe(71.4);
    expect(mixCanalVentas(25, 100).valor).toBe(25);
  });
});

describe("crecimiento con los 3 tipos de base", () => {
  it("periodo anterior", () => {
    const base = baseComparacion("periodo_anterior", { periodoAnterior: 10000, mismoPeriodoAnioPasado: 1 });
    expect(crecimiento(8000, base, "periodo_anterior").valor).toBe(-20);
  });
  it("mismo periodo del año pasado", () => {
    const base = baseComparacion("mismo_periodo_anio_pasado", { periodoAnterior: 1, mismoPeriodoAnioPasado: 8000 });
    expect(crecimiento(10000, base, "mismo_periodo_anio_pasado").valor).toBe(25);
  });
  it("promedio del mismo día de las 4 semanas previas, ignorando semanas sin dato", () => {
    const base = baseComparacion("promedio_mismo_dia_4_semanas", { mismoDiaSemanasPrevias: [10000, 12000, null, 11000] });
    expect(base).toBe(11000);
    expect(crecimiento(9350, base, "promedio_mismo_dia_4_semanas").valor).toBe(-15);
    expect(baseComparacion("promedio_mismo_dia_4_semanas", { mismoDiaSemanasPrevias: [null, null] })).toBeNull();
    expect(baseComparacion("promedio_mismo_dia_4_semanas", {})).toBeNull();
  });
  it("sin base (0, null o negativa) no hay crecimiento: nunca +infinito", () => {
    expect(crecimiento(100, 0, "periodo_anterior").valor).toBeNull();
    expect(crecimiento(100, null, "periodo_anterior").valor).toBeNull();
    expect(crecimiento(null, 100, "periodo_anterior").valor).toBeNull();
    expect(crecimiento(0, 100, "periodo_anterior").valor).toBe(-100);
  });
  it("el aporte de cada sucursal a la variación suma 100 %", () => {
    const a = aporteALaVariacion([{ propertyId: "A", actualCentavos: 600, baseCentavos: 1000 }, { propertyId: "B", actualCentavos: 900, baseCentavos: 1000 }]);
    expect(a.map((x) => x.deltaCentavos)).toEqual([-400, -100]);
    expect(a.map((x) => x.aportePct)).toEqual([80, 20]);
    expect(aporteALaVariacion([{ propertyId: "A", actualCentavos: 5, baseCentavos: 5 }])[0]!.aportePct).toBeNull();
  });
});

describe("agente: tasa de cierre y costo", () => {
  const filaAg = (p: Partial<Parameters<typeof sumarAgente>[0][number]> = {}) => ({
    propertyId: PROP as string | null, diaNegocio: "2026-09-14", waConversacionesNuevas: 0, waConPedido: 0, waConHandoff: 0, waHandoffs: 0, vozLlamadas: 0, vozPedidoCreado: 0, vozEscalado: 0,
    vozAbandonado: 0, costoVozMicroUsd: 0, costoTelefoniaMicroUsd: 0, costoMetaMicroUsd: null, costoLlmMicroUsd: null, costoVozCentavos: null, costoTelefoniaCentavos: null,
    costoMetaCentavos: null, costoLlmCentavos: null, metaEventos: 0, mxnPorUsd: null, ...p,
  });

  it("tasa de cierre de WhatsApp y de voz salen de sumas", () => {
    const s = sumarAgente([filaAg({ waConversacionesNuevas: 100, waConPedido: 35, vozPedidoCreado: 55, vozEscalado: 10, vozAbandonado: 35 }), filaAg({ waConversacionesNuevas: 100, waConPedido: 25 })]);
    expect(tasaCierreWhatsApp(s).valor).toBe(30);
    expect(tasaCierreVoz(s).valor).toBe(55);
    expect(tasaCierreAgente(s).valor).toBe(38.3); // (60 + 55) / (200 + 100) = 115/300
  });

  it("costo del agente: Meta sin eventos es «no medido», no $0; el LLM solo en «No asignado»", () => {
    const s = sumarAgente([filaAg({ costoVozCentavos: 1000, costoTelefoniaCentavos: 200, costoMetaCentavos: null, metaEventos: 0 }), filaAg({ propertyId: null, costoLlmCentavos: 5000 })]);
    const sucursal = costoAgente({ ...s, llmCentavos: null }, false);
    expect(sucursal.total.valor).toBe(1200);
    expect(sucursal.metaMedido).toBe(false);
    expect(sucursal.meta.valor).toBeNull();
    expect(sucursal.meta.confianza).toBe("sin_dato");
    expect(sucursal.llmTexto.valor).toBeNull();
    const conLlm = costoAgente(s, true);
    expect(conLlm.total.valor).toBe(6200);
    const conMeta = costoAgente({ ...s, metaCentavos: 150, metaEventos: 3 }, true);
    expect(conMeta.total.valor).toBe(6350);
    expect(conMeta.metaMedido).toBe(true);
  });

  it("sin tipo de cambio (centavos null) el costo es null, no 0", () => {
    const s = sumarAgente([filaAg({ costoVozMicroUsd: 150_000 })]);
    expect(costoAgente(s, false).total.valor).toBeNull();
    expect(costoAgente(s, false).completo).toBe(false);
  });

  it("costo por pedido del agente (CAC)", () => {
    expect(costoPorPedidoAgente(6200, 100).valor).toBe(62);
    expect(costoPorPedidoAgente(6250, 100).valor).toBe(63); // half away from zero
  });
});

describe("margen de contribución y costos", () => {
  const estimado = (v: number | null) => (v == null ? sinDato("x") : { valor: v, confianza: "estimado" as const, fuente: "x" });
  it("completo = neta sin IVA − food cost − agente − comisión", () => {
    const m = margenContribucion({ netaSinIva: estimado(100000), foodCost: { valor: 32000, confianza: "capturado", fuente: "x" }, costoAgente: estimado(6200), comisionTerminal: estimado(2000) });
    expect(m.cifra.valor).toBe(59800);
    expect(m.parcial).toBe(false);
    expect(m.faltan).toEqual([]);
  });
  it("sin captura muestra «parcial: faltan X» y no inventa el food cost", () => {
    const m = margenContribucion({ netaSinIva: estimado(100000), foodCost: sinDato("x"), costoAgente: estimado(6200), comisionTerminal: sinDato("x") });
    expect(m.cifra.valor).toBe(93800);
    expect(m.parcial).toBe(true);
    expect(m.faltan).toEqual(["food_cost", "comision_terminal"]);
  });
  it("sin neta sin IVA no hay margen", () => {
    expect(margenContribucion({ netaSinIva: sinDato("x"), foodCost: estimado(1), costoAgente: estimado(1), comisionTerminal: estimado(1) }).cifra.valor).toBeNull();
  });
  it("comisión de terminal = pct × ventas con tarjeta; sin pct es captura pendiente", () => {
    expect(comisionTerminal(2.5, 100000).valor).toBe(2500);
    expect(comisionTerminal(null, 100000).valor).toBeNull();
  });
  it("punto de equilibrio = fijos / margen %", () => {
    // fijos $40,000; margen de contribución 40 % de las ventas => ventas de equilibrio $100,000
    expect(puntoEquilibrio(4_000_000, 4_000_000, 10_000_000).valor).toBe(10_000_000);
    expect(puntoEquilibrio(4_000_000, -1, 10_000_000).valor).toBeNull();
  });
});

describe("clientes", () => {
  it("recompra, churn, frecuentes %, LTV simple y concentración", () => {
    expect(recompraPct(200, 90).valor).toBe(45);
    expect(churnPct(400, 28).valor).toBe(7);
    expect(frecuentesPct(120, 600).valor).toBe(20);
    expect(valorDeVidaSimple(31200, 4.25).valor).toBe(132600);
    expect(concentracionPct(3_500_000, 10_000_000).valor).toBe(35);
  });
});

describe("canasta, promociones y agotados", () => {
  it("soporte y lift", () => {
    const r = soporteLift(50, 200, 100, 1000);
    expect(r.soportePct).toBe(5);
    expect(r.lift).toBe(2.5);
    expect(soporteLift(1, 0, 5, 100).lift).toBeNull();
    expect(soporteLift(1, 5, 5, 0).soportePct).toBeNull();
  });
  it("top de pares con soporte ≥ 0.5 %, orden estable y tope", () => {
    const pares = [
      { propertyId: "A", productoA: "a", productoB: "b", pedidosJuntos: 50 },
      { propertyId: "A", productoA: "a", productoB: "c", pedidosJuntos: 4 }, // 0.4 % < 0.5 %
      { propertyId: "A", productoA: "b", productoB: "c", pedidosJuntos: 50 },
    ];
    const totales = [{ propertyId: "A", pedidosTotales: 1000, pedidosConProducto: { a: 200, b: 100, c: 100 } }];
    const top = topParesCanasta(pares, totales, 20, 0.5);
    expect(top.map((p) => `${p.productoA}${p.productoB}`)).toEqual(["ab", "bc"]);
    expect(topParesCanasta(pares, totales, 1).length).toBe(1);
  });
  it("efecto de promoción: unidades por día con promo vs sin promo", () => {
    expect(efectoPromocion({ unidadesConPromo: 90, diasConPromo: 3, unidadesSinPromo: 80, diasSinPromo: 4 }).valor).toBe(50);
    expect(efectoPromocion({ unidadesConPromo: 90, diasConPromo: 3, unidadesSinPromo: 80, diasSinPromo: 4 }).confianza).toBe("estimado");
  });
  it("venta en riesgo por agotado = unidades/día (28 d) × precio × días", () => {
    expect(ventaEnRiesgoAgotado({ unidades28d: 56, precioListaCentavos: 4200, diasAgotado: 1 }).valor).toBe(8400);
    expect(ventaEnRiesgoAgotado({ unidades28d: 56, precioListaCentavos: 4200, diasAgotado: 3 }).valor).toBe(25200);
    expect(ventaEnRiesgoAgotado({ unidades28d: 56, precioListaCentavos: null, diasAgotado: 1 }).valor).toBeNull();
  });
});

describe("SoftRestaurant: captura de comandas y cuadre", () => {
  const cmd = (p: Partial<Parameters<typeof sumarComandas>[0][number]> = {}) => ({
    propertyId: PROP, diaNegocio: "2026-09-14", modo: "sombra", encoladas: 100, confirmadas: 10, capturadasManual: 80, capturaManualPendientes: 10, fallidas: 0, pendientesEnviadas: 0,
    minACapturaSuma: 400, capturadasConTiempo: 80, vencidasUmbral: 0, conFolioPos: 10, conFolioDeclarado: 40, ...p,
  });
  it("tasa de captura = (confirmadas + capturadas) / encoladas", () => {
    expect(tasaCapturaSr(sumarComandas([cmd()])).valor).toBe(90);
    expect(minutosACapturaSr(sumarComandas([cmd()])).valor).toBe(5);
  });
  it("con el envío apagado no hay tasa (no «0 %»)", () => {
    expect(tasaCapturaSr(sumarComandas([cmd({ modo: "apagado", encoladas: 0, confirmadas: 0, capturadasManual: 0 })])).valor).toBeNull();
    expect(tasaCapturaSr(sumarComandas([cmd({ encoladas: 0, confirmadas: 0, capturadasManual: 0 })])).valor).toBeNull();
  });
  it("semáforo del cuadre: verde ≤ 1 % y ≤ $50; ámbar ≤ 3 %; rojo > 3 % o ≥ 2 pedidos de diferencia", () => {
    const c = CFO_CONFIG_POR_DEFECTO;
    expect(cuadreSr({ nuestroCentavos: 100000, srCentavos: 100500 }, c).semaforo).toBe("verde"); // 0.5 %, $5
    expect(cuadreSr({ nuestroCentavos: 100000, srCentavos: 102000 }, c).semaforo).toBe("ambar"); // 2 %
    expect(cuadreSr({ nuestroCentavos: 100000, srCentavos: 105000 }, c).semaforo).toBe("rojo"); // 5 %
    expect(cuadreSr({ nuestroCentavos: 1_000_000, srCentavos: 1_009_000 }, c).semaforo).toBe("ambar"); // 0.9 % pero $90 > $50
    expect(cuadreSr({ nuestroCentavos: 100000, srCentavos: 100000, pedidosNuestros: 20, ticketsSr: 18 }, c).semaforo).toBe("rojo");
    expect(cuadreSr({ nuestroCentavos: 100000, srCentavos: 100000, pedidosNuestros: 20, ticketsSr: 19 }, c).semaforo).toBe("verde");
    expect(cuadreSr({ nuestroCentavos: 100000, srCentavos: null }, c).semaforo).toBe("sin_datos");
    expect(cuadreSr({ nuestroCentavos: 0, srCentavos: 0 }, c).semaforo).toBe("sin_datos");
    expect(cuadreSr({ nuestroCentavos: 5000, srCentavos: 0 }, c).semaforo).toBe("rojo");
    const r = cuadreSr({ nuestroCentavos: 100000, srCentavos: 102000 }, c);
    expect(r.diferenciaCentavos).toBe(-2000);
    expect(r.diferenciaPct).toBe(2);
  });
});
