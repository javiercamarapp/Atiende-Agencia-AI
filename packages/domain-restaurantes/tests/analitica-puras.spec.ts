// Analítica del dueño (F7) · funciones PURAS: ratios (definiciones exactas), demanda (picos, refuerzo p80, vie–dom, tendencia, promesa), zonas (k-anonimato
// defensivo), productos/combos (lift, en menú vs oportunidad) y el clasificador «¿ya salió?» contra la migración 163. Datos 100 % sintéticos.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFINICIONES_RATIOS,
  ETIQUETA_OTRAS,
  ETIQUETA_SIN_COLONIA,
  REGEX_PREGUNTA_ESTADO_FUENTE,
  calcularRatios,
  construirDemanda,
  construirProductos,
  construirZonas,
  esPreguntaDeEstado,
  pct,
  percentilNearestRank,
  resumirSucursal,
  type CeldaMatriz,
  type DemandaCruda,
  type FilaRatiosCruda,
  type ZonaCruda,
} from "../src/analitica/index.ts";

const P1 = "00000000-0000-0000-0000-0000000000a1";
const P2 = "00000000-0000-0000-0000-0000000000a2";

const celda = (propertyId: string, dow: number, hora: number, pedidos: number, netaCentavos = pedidos * 10_000, canal = "domicilio", source = "whatsapp"): CeldaMatriz => ({
  propertyId, dow, hora, canal, source, pedidos, netaCentavos,
});

describe("pct", () => {
  it("redondea a un decimal y devuelve null sin denominador", () => {
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(2, 3)).toBe(66.7);
    expect(pct(1, 8)).toBe(12.5);
    expect(pct(0, 5)).toBe(0);
    expect(pct(3, 0)).toBeNull();
    expect(pct(1, -1)).toBeNull();
  });
});

describe("calcularRatios: definiciones exactas", () => {
  const fila: FilaRatiosCruda = {
    propertyId: P1, pedidos: 80, netaCentavos: 2_400_000, ticketCentavos: 30_000, clientes: 40, pedidosConCliente: 60, clientesNuevos: 20,
    recompra: { d14: { elegibles: 10, recompraron: 3 }, d30: { elegibles: 8, recompraron: 4 }, d60: { elegibles: 0, recompraron: 0 } },
    cancelados: 20, grandes: 4, convChats: 50, convConPedido: 30, convEscaladas: 10, vozLlamadas: 10, vozConPedido: 4, vozEscaladas: 1,
    respN: 40, respMedianaSeg: 45, respP90Seg: 400, respHasta5min: 34, respAgenteN: 36, respHumanoN: 4, conversacionesAgente: 60,
    costoTotalCentavos: 12_000, costoPorConversacionCentavos: 200,
  };
  const r = calcularRatios(fila);
  it("ticket, frecuencia, cancelación, grandes", () => {
    expect(r.ticketCentavos).toBe(30_000);
    expect(r.frecuencia).toBe(1.5); // 60 pedidos con cliente / 40 clientes
    expect(r.tasaCancelacionPct).toBe(20); // 20 / (80 + 20)
    expect(r.pctGrandes).toBe(5); // 4 / 80
  });
  it("recompra a 14/30/60: elegibles como denominador; sin elegibles es null (no 0)", () => {
    expect(r.recompra14.pct).toBe(30);
    expect(r.recompra30.pct).toBe(50);
    expect(r.recompra60.pct).toBeNull();
  });
  it("chat: conversión, escalado y «resuelto por el agente» = no escaladas / conversaciones", () => {
    expect(r.conversionChatPedidoPct).toBe(60);
    expect(r.escaladoPct).toBe(20);
    expect(r.resueltoPorAgentePct).toBe(80);
    expect(r.conversionVozPedidoPct).toBe(40);
  });
  it("primera respuesta: mediana, p90 y % en 5 min sobre las rachas medidas", () => {
    expect(r.primeraRespuestaMedianaSeg).toBe(45);
    expect(r.respondidoEn5minPct).toBe(85);
    expect(r.respuestasMedidas).toBe(40);
  });
  it("sin datos nada se inventa: ceros y nulos honestos", () => {
    const v = calcularRatios({ ...fila, pedidos: 0, netaCentavos: 0, clientes: 0, pedidosConCliente: 0, convChats: 0, convConPedido: 0, convEscaladas: 0, respN: 0, respMedianaSeg: null, respP90Seg: null, respHasta5min: 0, cancelados: 0, grandes: 0 });
    expect(v.ticketCentavos).toBeNull();
    expect(v.frecuencia).toBeNull();
    expect(v.tasaCancelacionPct).toBeNull();
    expect(v.resueltoPorAgentePct).toBeNull();
    expect(v.primeraRespuestaMedianaSeg).toBeNull();
  });
  it("hay una definición escrita para cada ratio que muestra el panel", () => {
    const ids = DEFINICIONES_RATIOS.map((d) => d.id);
    for (const id of ["ticket", "frecuencia", "recompra14", "recompra30", "recompra60", "cancelacion", "grandes", "conversion", "primeraRespuesta", "resueltoAgente", "escalado", "costoConversacion"]) expect(ids).toContain(id);
    for (const d of DEFINICIONES_RATIOS) expect(d.definicion.length).toBeGreaterThan(20);
  });
});

describe("demanda: picos, refuerzo y vie–dom", () => {
  // Picos sembrados en 13 h y 19 h todos los días; viernes a domingo con el triple de volumen.
  const celdas: CeldaMatriz[] = [];
  for (let dow = 1; dow <= 7; dow++) {
    const k = dow >= 5 ? 3 : 1;
    celdas.push(celda(P1, dow, 13, 10 * k), celda(P1, dow, 19, 8 * k), celda(P1, dow, 16, 1 * k));
  }
  const s = resumirSucursal(P1, celdas);
  it("los picos se CALCULAN: las dos horas con más pedidos (13 y 19)", () => {
    expect(s.picos.map((p) => p.hora)).toEqual([13, 19]);
  });
  it("vie–dom: pedidos y venta de los días 5 a 7 sobre el total", () => {
    // lun–jue: 4 días × 19 = 76; vie–dom: 3 días × 57 = 171; total 247
    expect(s.pedidos).toBe(247);
    expect(s.vieDom.pedidos).toBe(171);
    expect(s.vieDom.pctPedidos).toBe(69.2);
  });
  it("refuerzo: celdas en o sobre el percentil 80 (nearest-rank) de las celdas con ventas", () => {
    expect(s.umbralRefuerzo).toBe(24);
    expect(s.refuerzo.every((c) => c.pedidos >= 24)).toBe(true);
    expect(s.refuerzo.map((c) => `${c.dow}-${c.hora}`).sort()).toEqual(["5-13", "5-19", "6-13", "6-19", "7-13", "7-19"].sort());
  });
  it("percentil nearest-rank", () => {
    expect(percentilNearestRank([1, 2, 3, 4, 5], 80)).toBe(4);
    expect(percentilNearestRank([], 80)).toBeNull();
  });
});

describe("construirDemanda", () => {
  const cruda: DemandaCruda = {
    matriz: [celda(P1, 5, 13, 10), celda(P1, 5, 19, 6, 60_000, "recoger", "voice"), celda(P2, 6, 13, 4)],
    semanas: [
      { propertyId: P1, semana: "2026-09-07", dias: 7, pedidos: 100, netaCentavos: 1_000_000 },
      { propertyId: P1, semana: "2026-09-14", dias: 7, pedidos: 120, netaCentavos: 1_300_000 },
      { propertyId: P1, semana: "2026-09-21", dias: 3, pedidos: 30, netaCentavos: 300_000 },
    ],
    ticket: [
      { propertyId: P1, canal: "domicilio", pedidos: 10, netaCentavos: 100_000, medianaCentavos: 9_000, p90Centavos: 15_000 },
      { propertyId: P2, canal: "domicilio", pedidos: 4, netaCentavos: 40_000, medianaCentavos: 9_500, p90Centavos: 12_000 },
    ],
    pago: [
      { propertyId: P1, formaPago: "efectivo", pedidos: 6, netaCentavos: 60_000 },
      { propertyId: P1, formaPago: "tarjeta", pedidos: 4, netaCentavos: 40_000 },
      { propertyId: P2, formaPago: "efectivo", pedidos: 4, netaCentavos: 40_000 },
    ],
    promesa: [{ propertyId: P1, domicilios: 12, entregados: 10, conPromesa: 8, aTiempo: 6, sinPromesa: 2, sinCierre: 2, realMedianaMin: 42, prometidoMedianaMin: 45, desvioMedianaMin: -2 }],
    totales: [{ propertyId: P1, pedidos: 16, netaCentavos: 160_000 }, { propertyId: P2, pedidos: 4, netaCentavos: 40_000 }],
    diasConVenta: 10,
  };
  const v = construirDemanda(cruda);
  it("agrega el conjunto cuando hay varias sucursales", () => {
    expect(v.sucursales.map((s) => s.propertyId)).toEqual([P1, P2, null]);
    expect(v.sucursales.find((s) => s.propertyId === null)?.pedidos).toBe(20);
  });
  it("la tendencia compara contra la semana COMPLETA previa y marca la semana incompleta", () => {
    const p1 = v.semanas.filter((s) => s.propertyId === P1);
    expect(p1.map((s) => s.variacionPedidosPct)).toEqual([null, 20, null]);
    expect(p1.map((s) => s.completa)).toEqual([true, true, false]);
  });
  it("mezcla de pago en % de pedidos; el conjunto suma ambas sucursales", () => {
    expect(v.pago.find((p) => p.propertyId === P1 && p.formaPago === "efectivo")?.pctPedidos).toBe(60);
    expect(v.pago.find((p) => p.propertyId === null && p.formaPago === "efectivo")?.pctPedidos).toBe(71.4);
  });
  it("mediana y p90 del ticket solo existen para una sucursal (no se suman medianas)", () => {
    expect(v.ticket.find((t) => t.propertyId === P1)?.medianaCentavos).toBe(9_000);
    expect(v.ticket.find((t) => t.propertyId === null)?.medianaCentavos).toBeNull();
    expect(v.ticket.find((t) => t.propertyId === null)?.ticketPromedioCentavos).toBe(10_000);
  });
  it("promesa: % a tiempo sobre los entregados con promesa; los demás se cuentan aparte", () => {
    const p = v.promesa[0]!;
    expect(p.aTiempoPct).toBe(75);
    expect(p.tardePct).toBe(25);
    expect(p.sinPromesa).toBe(2);
    expect(p.sinCierre).toBe(2);
  });
  it("con menos de 28 días con venta avisa que no hay estacionalidad", () => {
    expect(v.pocoHistorial).toBe(true);
    expect(v.avisos[0]).toContain("estacionalidad");
    expect(construirDemanda({ ...cruda, diasConVenta: 60 }).pocoHistorial).toBe(false);
  });
});

describe("construirZonas: k-anonimato defensivo", () => {
  const z = (colonia: string, pedidos: number, over: Partial<ZonaCruda> = {}): ZonaCruda => ({
    propertyId: P1, colonia, pedidos, domicilios: pedidos, recogidas: 0, netaCentavos: pedidos * 20_000, clientes: Math.max(1, pedidos - 1), entregados: pedidos, sinCierre: 0,
    medianaMin: 35, p90Min: 55, masDe60: 1, ...over,
  });
  it("una colonia con menos de 5 pedidos nunca sale con nombre: se junta en «(otras)» sin percentiles inventados", () => {
    const v = construirZonas([z("Centro", 30), z("Itzimná", 3), z("Caucel", 2), z(ETIQUETA_SIN_COLONIA, 9, { domicilios: 3, recogidas: 6 })]);
    expect(v.map((x) => x.colonia)).not.toContain("Itzimná");
    expect(v.map((x) => x.colonia)).not.toContain("Caucel");
    const otras = v.find((x) => x.esOtras)!;
    expect(otras.pedidos).toBe(5);
    expect(otras.medianaMin).toBeNull();
    expect(otras.p90Min).toBeNull();
  });
  it("«sin colonia / recoge» no se oculta y la intensidad es relativa a la colonia líder", () => {
    const v = construirZonas([z("Centro", 40), z("Norte", 10), z(ETIQUETA_SIN_COLONIA, 20)]);
    expect(v.find((x) => x.sinColonia)?.pedidos).toBe(20);
    expect(v.find((x) => x.colonia === "Centro")?.intensidad).toBe(1);
    expect(v.find((x) => x.colonia === "Norte")?.intensidad).toBe(0.25);
    expect(v.find((x) => x.sinColonia)?.intensidad).toBe(0);
  });
  it("la «(otras)» que ya trae la base se respeta y el % de más de 60 min sale de los entregados", () => {
    const v = construirZonas([z(ETIQUETA_OTRAS, 12, { medianaMin: 40, p90Min: 70, entregados: 10, masDe60: 3 }), z("Centro", 20)]);
    const o = v.find((x) => x.esOtras)!;
    expect(o.medianaMin).toBe(40);
    expect(o.pctMasDe60).toBe(30);
  });
});

describe("construirProductos: afinidad y combos", () => {
  const prod = (ref: string, unidades: number, costo: number | null) => ({
    propertyId: P1, productoRef: ref, nombre: ref, categoria: "Tacos", unidades, ingresoCentavos: unidades * 5_000, pedidos: unidades, costoUnitarioCentavos: costo,
    margenCentavos: costo === null ? null : unidades * 5_000 - unidades * costo,
  });
  const v = construirProductos({
    productos: [prod("bistec", 100, 2_000), prod("refresco", 50, null)],
    pares: [
      { propertyId: P1, productoA: "bistec", productoB: "refresco", nombreA: "Bistec", nombreB: "Refresco", juntos: 30, pedidosA: 100, pedidosB: 50, pedidosTotal: 200, enMenu: true, promocionCodigo: "COMBO1" },
      { propertyId: P1, productoA: "bistec", productoB: "frijoles", nombreA: "Bistec", nombreB: "Frijoles", juntos: 20, pedidosA: 100, pedidosB: 25, pedidosTotal: 200, enMenu: false, promocionCodigo: null },
      { propertyId: P1, productoA: "flan", productoB: "taco", nombreA: "Flan", nombreB: "Taco", juntos: 4, pedidosA: 10, pedidosB: 10, pedidosTotal: 200, enMenu: false, promocionCodigo: null },
    ],
    costosCargados: 1,
  });
  it("margen solo con costo; sin costo es «sin costo», nunca 0", () => {
    const b = v.productos.find((p) => p.productoRef === "bistec")!;
    expect(b.margenCentavos).toBe(300_000);
    expect(b.margenPct).toBe(60);
    const r = v.productos.find((p) => p.productoRef === "refresco")!;
    expect(r.sinCosto).toBe(true);
    expect(r.margenPct).toBeNull();
    expect(v.margenDisponible).toBe(true);
  });
  it("soporte, confianza y lift con su fórmula; pares con menos de 5 pedidos juntos no se listan", () => {
    expect(v.pares).toHaveLength(2);
    const p = v.pares[0]!;
    expect(p.soportePct).toBe(15); // 30 / 200
    expect(p.confianzaAB).toBe(30); // 30 / 100
    expect(p.lift).toBe(1.2); // 30 × 200 / (100 × 50)
  });
  it("un par sin promoción vigente es oportunidad («no existe como combo»), no un combo", () => {
    expect(v.pares.find((p) => p.productoB === "refresco")?.estado).toBe("en_menu");
    expect(v.oportunidades.map((p) => p.productoB)).toEqual(["frijoles"]);
  });
});

describe("clasificador «¿ya salió?»", () => {
  it("positivos y falsos positivos", () => {
    for (const t of ["¿Ya salió mi pedido?", "ya salio?", "cuánto falta para que llegue", "¿cómo va mi pedido?", "no ha llegado nada", "sigue sin llegar", "donde esta mi pedido", "ya viene en camino?"]) expect(esPreguntaDeEstado(t), t).toBe(true);
    for (const t of ["Quiero 2 de pastor", "¿ya salieron los precios nuevos?", "gracias", "", "¿a qué hora abren?"]) expect(esPreguntaDeEstado(t), t).toBe(false);
  });
  it("el regex de TypeScript es EL MISMO que el de la función SQL de la migración 163", () => {
    const sql = readFileSync(path.join(__dirname, "..", "migrations", "163_analitica_alertas_eta_y_ya_salio.sql"), "utf8");
    const fuenteSql = REGEX_PREGUNTA_ESTADO_FUENTE.replaceAll("\\\\", "\\");
    expect(sql).toContain(`'${fuenteSql}'`);
  });
});
