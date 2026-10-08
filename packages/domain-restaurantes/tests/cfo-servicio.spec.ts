// CFO-05 · servicio del CFO: armado de las vistas con el repositorio en memoria y el dataset SINTÉTICO de CFO-04. Cada caso afirma el EFECTO
// (consolidado = Σ, avisos correctos, NULL ≠ 0, alcance acotado sin «No asignado», base sin migrar), no solo que algo se devuelva.
import { describe, expect, it } from "vitest";
import { InMemoryCfoRepository, type DatasetCfoMemoria, type OpcionesCfoMemoria } from "../src/cfo/repositorio-memoria.ts";
import { ServicioCfo, type ConsultaCfo } from "../src/cfo/servicio.ts";
import type { AlcanceSucursales, FilaAgenteDiario, FilaAgotado, FilaEntregaPercentiles, FilaProducto } from "../src/cfo/tipos.ts";
import { SUCURSALES_PM_SINTETICAS, generarDatasetSintetico } from "./fixtures/cfo-pm-sintetico.ts";

const SUC = SUCURSALES_PM_SINTETICAS;
const IDS = SUC.map((s) => s.propertyId);
const [T1, T2, T3] = IDS as [string, string, string];
const NOMBRES = SUC.map((s) => ({ propertyId: s.propertyId, nombre: s.nombre, slug: s.codigo.toLowerCase() }));
const AHORA = new Date("2026-09-28T15:00:00Z");
const D = generarDatasetSintetico({ diasRango: 120 });
const Q: ConsultaCfo = { desde: "2026-08-31", hasta: "2026-09-27", comparar: "periodo_anterior", granularidad: "semana" };

const COBERTURA = IDS.map((id) => ({ propertyId: id, primerDia: "2026-05-01", ultimoDia: "2026-09-27", zona: "America/Merida", corte: "01:00:00" }));

function percentiles(): FilaEntregaPercentiles[] {
  return [
    ...IDS.map((id, i) => ({ propertyId: id, alcance: "sucursal" as const, entregados: 100, p50Min: 35, p90Min: 50 + i * 3 })),
    { propertyId: null, alcance: "conjunto" as const, entregados: 700, p50Min: 37, p90Min: 58 },
  ];
}

function armar(op: { dataset?: Partial<DatasetCfoMemoria>; repo?: Partial<OpcionesCfoMemoria>; alcance?: Partial<AlcanceSucursales>; propertyIdsSql?: readonly string[] | null; sin?: boolean } = {}) {
  const permitidas = op.repo?.permitidas ?? IDS;
  const alcance: AlcanceSucursales = { propertyIds: permitidas, todas: true, organizacionCompleta: op.repo?.organizacionCompleta ?? true, ...op.alcance };
  const repo = new InMemoryCfoRepository({
    sucursales: IDS,
    dataset: {
      ventasDiarias: D.ventasDiarias, cortesias: D.cortesias, ventasHora: D.ventasHora, productos: D.productos, agenteDiario: D.agenteDiario, comandasPos: D.comandasPos,
      clientesResumen: D.clientes, agotados: D.agotados, cobertura: COBERTURA, entregasPercentiles: percentiles(), ...op.dataset,
    },
    ...op.repo,
  });
  const servicio = new ServicioCfo({
    repo, organizationId: "org", alcance, propertyIdsSql: op.propertyIdsSql === undefined ? (alcance.organizacionCompleta ? null : alcance.propertyIds) : op.propertyIdsSql,
    sucursales: NOMBRES.filter((s) => alcance.propertyIds.includes(s.propertyId)), ahora: AHORA,
  });
  return { repo, servicio };
}

describe("resumen", () => {
  it("consolidado = Σ sucursales: el total de ventas, pedidos y descuentos sale igual por dos caminos", async () => {
    const { servicio } = armar();
    const r = await servicio.resumen(Q);
    const sum = (k: "netaCentavos" | "pedidos" | "brutaCentavos" | "descPromoCentavos" | "cancelados") => r.kpis.porSucursal.reduce((s, c) => s + c.sumas[k], 0);
    for (const k of ["netaCentavos", "pedidos", "brutaCentavos", "descPromoCentavos", "cancelados"] as const) expect(r.kpis.total.sumas[k], k).toBe(sum(k));
    expect(r.kpis.porSucursal).toHaveLength(IDS.length);
    expect(r.kpis.total.sumas.pedidos).toBeGreaterThan(1000);
  });

  it("KPIs con variación y semáforo contra el comparativo; sin base: «sin dato» (no 0)", async () => {
    const { servicio } = armar();
    const r = await servicio.resumen(Q);
    const ids = r.kpis.total.kpis.map((k) => k.id);
    expect(ids).toEqual([
      "ventas_netas", "pedidos", "ticket", "mix_domicilio", "descuento_pct", "cancelacion_pct", "costo_pedido_agente", "margen_contribucion", "clientes_activos", "frecuentes_pct", "tasa_cierre_agente", "entrega_p90",
    ]);
    const ventas = r.kpis.total.kpis.find((k) => k.id === "ventas_netas")!;
    expect(ventas.base).not.toBeNull();
    expect(ventas.variacion.tipo).toBe("pct");
    expect(["verde", "ambar", "rojo"]).toContain(ventas.semaforo);
    // Sin ningún dato en el periodo anterior: sin base y sin semáforo.
    const desdeQ = IDS.map((id) => ({ propertyId: id, primerDia: Q.desde, ultimoDia: Q.hasta, zona: "America/Merida", corte: "01:00:00" }));
    const sinBase = await armar({ dataset: { ventasDiarias: D.ventasDiarias.filter((f) => f.diaNegocio >= Q.desde), cobertura: desdeQ } }).servicio.resumen(Q);
    const v2 = sinBase.kpis.total.kpis.find((k) => k.id === "ventas_netas")!;
    expect(v2.base).toBeNull();
    expect(v2.variacion.valor).toBeNull();
    expect(v2.semaforo).toBe("sin_dato");
    expect(sinBase.avisos).toContain("No hay un periodo de comparación con datos.");
    const p90 = r.kpis.total.kpis.find((k) => k.id === "entrega_p90")!;
    expect(p90.valor.valor).toBe(58); // percentil del CONJUNTO, no promedio de los de cada sucursal
  });

  it("los tres tipos de comparación usan su propia base", async () => {
    const { servicio } = armar();
    const base = async (c: ConsultaCfo["comparar"]) => (await armar().servicio.resumen({ ...Q, comparar: c })).kpis.total.kpis.find((k) => k.id === "ventas_netas")!.base;
    void servicio;
    const [a, b, c] = [await base("periodo_anterior"), await base("anio_anterior"), await base("mismo_dia_semana_4")];
    expect(a).toBeGreaterThan(0);
    expect(b).toBeNull(); // el dataset no tiene el año pasado
    expect(c).toBeGreaterThan(0);
    expect(c).not.toBe(a);
  });

  it("titular: sin SoftRestaurant es «Ventas por el agente»; con SR cubriendo todo el periodo es el total de SR (nunca se suman)", async () => {
    const sin = await armar().servicio.resumen(Q);
    expect(sin.titular).toMatchObject({ origen: "agente", etiqueta: "Ventas por el agente" });
    expect(sin.avisos).toContain("Sin datos de mostrador de SoftRestaurant: suba el reporte de ventas por tipo de servicio o el listado de cuentas.");
    const con = await armar({ dataset: { srResumen: D.srResumen } }).servicio.resumen(Q);
    expect(con.titular.origen).toBe("softrestaurant");
    expect(con.titular.cifra.confianza).toBe("importado");
    expect(con.avisos).not.toContain("Sin datos de mostrador de SoftRestaurant: suba el reporte de ventas por tipo de servicio o el listado de cuentas.");
    // Las ventas del agente no se tocan: siguen siendo un subconjunto informativo.
    expect(con.kpis.total.sumas.netaCentavos).toBe(sin.kpis.total.sumas.netaCentavos);
  });

  it("avisos: Meta no medido (nunca $0), envío de comandas apagado y costos por capturar", async () => {
    const r = await armar({ dataset: { comandasPos: D.comandasPos.map((c) => ({ ...c, modo: "apagado" })) } }).servicio.resumen(Q);
    expect(r.avisos).toContain("Costo de Meta no medido: el costo del agente no lo incluye (no se muestra como $0).");
    expect(r.avisos).toContain("Envío de comandas a SoftRestaurant apagado.");
    expect(r.narrativa.texto).toContain("sin incluir el costo de Meta, que no está medido");
    expect(r.narrativa.numerosNoRespaldados).toEqual([]);
  });

  it("la narrativa cita solo cifras de la entrada y los hallazgos vienen ordenados por impacto (nulos al final) o por urgencia", async () => {
    const { servicio } = armar({ dataset: { srResumen: D.srResumen } });
    const r = await servicio.resumen(Q, "impacto");
    expect(r.narrativa.numerosNoRespaldados).toEqual([]);
    const impactos = r.hallazgos.map((h) => h.impactoCentavos);
    const conImpacto = impactos.filter((x): x is number => x !== null);
    expect(conImpacto).toEqual([...conImpacto].sort((a, b) => b - a));
    expect(impactos.slice(conImpacto.length).every((x) => x === null)).toBe(true);
    expect(r.hallazgos.length).toBeLessThanOrEqual(10);
    const u = await servicio.resumen(Q, "urgencia");
    expect(u.orden).toBe("urgencia");
    expect(u.hallazgos[0]?.urgencia).toBe(u.hallazgos.reduce((a, h) => (h.urgencia === "alta" ? "alta" : a), u.hallazgos[0]?.urgencia));
  });

  it("agotado INDEFINIDO de un producto estrella produce el hallazgo (bug de CFO-04: antes exigía agotadoHasta)", async () => {
    const top = D.agotados.find((a) => a.propertyId === T1 && a.rankingUnidades === 1)!;
    // La SQL solo lista agotados vigentes: disponible=false con agotado_hasta NULL = agotado indefinido.
    const agotado: FilaAgotado = { ...top, disponible: false, agotadoHasta: null, rankingUnidades: null };
    const productos: FilaProducto[] = D.productos.filter((p) => p.propertyId === T1 && p.diaNegocio < "2026-09-28" && p.diaNegocio >= "2026-08-31");
    const unidadesTop = productos.filter((p) => p.productoRef === top.productId).reduce((s, p) => s + p.unidades, 0);
    expect(unidadesTop).toBeGreaterThan(0);
    const r = await armar({ dataset: { agotados: [agotado] } }).servicio.resumen(Q);
    const h = r.hallazgos.find((x) => x.tipo === "agotado_estrella");
    expect(h, "debe alertar el agotado indefinido").toBeDefined();
    expect(h!.propertyId).toBe(T1);
  });

  it("admin acotado: solo sus sucursales, SIN «No asignado» y sin el LLM de la organización en el costo", async () => {
    const completo = await armar().servicio.resumen(Q);
    expect(completo.kpis.noAsignado).not.toBeNull();
    const acotado = await armar({ repo: { permitidas: [T1, T2], organizacionCompleta: false } }).servicio.resumen(Q);
    expect(acotado.kpis.noAsignado).toBeNull();
    expect(acotado.kpis.porSucursal.map((c) => c.propertyId)).toEqual([T1, T2]);
    expect(acotado.alcance.etiqueta).toBe("Sus 2 sucursales");
    expect(acotado.alcance.organizacionCompleta).toBe(false);
    expect(acotado.avisos.some((a) => a.includes("solo a las sucursales que usted administra"))).toBe(true);
    const total = acotado.kpis.porSucursal.reduce((s, c) => s + c.sumas.netaCentavos, 0);
    expect(acotado.kpis.total.sumas.netaCentavos).toBe(total);
    expect(total).toBeLessThan(completo.kpis.total.sumas.netaCentavos);
    // Con «No asignado» el costo del agente del total incluye el LLM; sin él, no.
    const costo = (v: typeof acotado) => v.kpis.total.kpis.find((k) => k.id === "costo_pedido_agente")!.valor.valor;
    expect(costo(completo)).not.toBeNull();
    expect(costo(acotado)).not.toBeNull();
  });

  it("base sin migrar: 200 con bloques en false, disponible=false, cifras «sin dato» (no 0) y aviso honesto", async () => {
    const sin081 = await armar({ repo: { migraciones: { m081: false } } }).servicio.resumen(Q);
    expect(sin081.bloques.ventas).toBe(false);
    expect(sin081.disponible).toBe(false);
    expect(sin081.kpis.total.kpis.find((k) => k.id === "ventas_netas")!.valor.valor).toBeNull();
    expect(sin081.kpis.total.kpis.find((k) => k.id === "pedidos")!.valor.valor).toBeNull();
    expect(sin081.hallazgos).toEqual([]);
    expect(sin081.avisos.some((a) => a.includes("actualización 081"))).toBe(true);
    const sin082 = await armar({ repo: { migraciones: { m082: false } } }).servicio.resumen(Q);
    expect(sin082.bloques).toEqual({ ventas: true, clientes: false, captura: true });
    expect(sin082.kpis.total.kpis.find((k) => k.id === "clientes_activos")!.valor.valor).toBeNull();
    expect(sin082.kpis.total.kpis.find((k) => k.id === "ventas_netas")!.valor.valor).not.toBeNull();
    const sin083 = await armar({ repo: { migraciones: { m083: false } } }).servicio.resumen(Q);
    expect(sin083.bloques.captura).toBe(false);
    expect(sin083.avisos.some((a) => a.includes("actualización 083"))).toBe(true);
  });

  it("sin pedidos: avisos y listas vacías, sin dividir entre cero", async () => {
    const r = await armar({ dataset: { ventasDiarias: [], cortesias: [], productos: [], agenteDiario: [], comandasPos: [], clientesResumen: [], agotados: [] } }).servicio.resumen(Q);
    expect(r.avisos).toContain("No hay pedidos en el periodo seleccionado.");
    expect(r.hallazgos).toEqual([]);
    expect(r.narrativa.sinDatos).toBe(true);
    expect(r.kpis.total.kpis.find((k) => k.id === "ticket")!.valor.valor).toBeNull();
  });

  it("clientes únicos NO se suman: el texto usa el conteo exacto de clientes en 2+ sucursales", async () => {
    const r = await armar().servicio.resumen(Q);
    expect(r.multiSucursal.clientes).toBeGreaterThan(0);
    expect(r.multiSucursal.texto).toContain("compraron en más de una sucursal");
    const sumaPorSucursal = D.clientes.filter((f) => f.alcance === "sucursal").reduce((s, f) => s + f.clientesConPedido, 0);
    const conjunto = D.clientes.find((f) => f.alcance === "conjunto")!;
    expect(conjunto.clientesConPedido).toBeLessThan(sumaPorSucursal);
    expect(r.kpis.total.kpis.find((k) => k.id === "clientes_activos")!.valor.valor).toBe(conjunto.activos);
  });
});

describe("ventas, sucursales y estado de resultados", () => {
  it("ventas: cascada cuadrada (bruta − descuentos = neta), serie sin huecos por granularidad, heatmap y propinas con su nota", async () => {
    const { servicio } = armar();
    const v = await servicio.ventasVista({ ...Q, granularidad: "dia" });
    expect(v.ventas.total.serie).toHaveLength(28);
    const semana = await servicio.ventasVista({ ...Q, granularidad: "semana" });
    expect(semana.ventas.total.serie.length).toBeGreaterThanOrEqual(4);
    expect(semana.ventas.total.serie.reduce((s, p) => s + p.netaCentavos, 0)).toBe(semana.ventas.total.sumas.netaCentavos);
    expect(v.ventas.total.cascada.descuadreCentavos).toBe(0);
    expect(v.ventas.total.cascada.netaSinIvaCentavos.confianza).toBe("estimado");
    expect(v.ventas.noAsignado).toBeNull();
    expect(v.serieComparativo).toHaveLength(28);
    expect(v.heatmap.length).toBeGreaterThan(20);
    expect(v.heatmap.every((c) => c.dow >= 1 && c.dow <= 7 && c.hora >= 0 && c.hora <= 23)).toBe(true);
    expect(v.porCanal.reduce((s, c) => s + c.netaCentavos, 0)).toBe(v.ventas.total.sumas.netaCentavos);
    expect(v.propinas.nota).toContain("efectivo");
    expect(v.formaPago.reduce((s, f) => s + f.netaCentavos, 0)).toBe(v.ventas.total.sumas.netaCentavos);
  });

  it("sucursales: ranking por venta neta, participaciones que suman ~100 %, outliers por z-score o 2× la mediana", async () => {
    const { servicio } = armar();
    const s = await servicio.sucursalesVista(Q);
    expect(s.ranking.map((r) => r.posicion)).toEqual(IDS.map((_, i) => i + 1));
    const netas = s.ranking.map((r) => r.netaCentavos);
    expect(netas).toEqual([...netas].sort((a, b) => b - a));
    const part = s.tabla.reduce((p, t) => p + (t.participacionPct.valor ?? 0), 0);
    expect(Math.abs(part - 100)).toBeLessThan(0.1 * IDS.length);
    expect(s.total.netaCentavos).toBe(s.tabla.reduce((p, t) => p + t.netaCentavos, 0));
    // Una sucursal con cancelaciones desproporcionadas se marca como outlier.
    const mala = D.ventasDiarias.map((f) => (f.propertyId === T3 ? { ...f, cancelados: f.cancelados + f.pedidos * 3 } : f));
    const o = await armar({ dataset: { ventasDiarias: mala } }).servicio.sucursalesVista(Q);
    expect(o.outliers.some((x) => x.propertyId === T3 && x.metrica === "cancelacionPct")).toBe(true);
    expect(o.noAsignado).not.toBeNull();
    const acotado = await armar({ repo: { permitidas: [T1], organizacionCompleta: false } }).servicio.sucursalesVista(Q);
    expect(acotado.noAsignado).toBeNull();
    expect(acotado.avisos).toContain("Solo hay una sucursal en el alcance: la comparación entre sucursales no aplica.");
  });

  it("estado de resultados: columnas por sucursal + No asignado (solo organización completa) + total, y líneas «captura pendiente»", async () => {
    const er = (await armar().servicio.estadoResultados({ ...Q, granularidad: "mes" })).estadoResultados;
    const cols = er.acumulado.columnas.map((c) => c.clave);
    expect(cols.filter((c) => c === "sucursal")).toHaveLength(IDS.length);
    expect(cols).toContain("no_asignado");
    expect(cols[cols.length - 1]).toBe("total");
    const total = er.acumulado.columnas.find((c) => c.clave === "total")!;
    expect(total.lineas.find((l) => l.id === "nomina")!.faltaCaptura).toBe(true);
    expect(total.ebitda.valor).toBeNull();
    const acotado = (await armar({ repo: { permitidas: [T1], organizacionCompleta: false } }).servicio.estadoResultados(Q)).estadoResultados;
    expect(acotado.acumulado.columnas.some((c) => c.clave === "no_asignado")).toBe(false);
  });
});

describe("clientes, productos, patrones y operación", () => {
  it("clientes: el total es el CONJUNTO (no la suma), cohortes con tasa honesta (con / observables) y sin PII", async () => {
    const cohortes = [
      { propertyId: null, mesCohorte: "2026-07", clientes: 100, conRecompra30: 30, conRecompra60: 40, conRecompra90: 45, observables30: 100, observables60: 100, observables90: 60 },
      { propertyId: null, mesCohorte: "2026-09", clientes: 80, conRecompra30: 0, conRecompra60: 0, conRecompra90: 0, observables30: 0, observables60: 0, observables90: 0 },
    ];
    const { servicio } = armar({ dataset: { clientesCohortes: cohortes } });
    const c = await servicio.clientesVista(Q);
    const suma = c.porSucursal.reduce((s, x) => s + x.resumen.clientesConPedido, 0);
    expect(c.total!.resumen.clientesConPedido).toBeLessThan(suma);
    expect(c.multiSucursal.sumaPorSucursal).toBe(suma);
    expect(c.multiSucursal.texto).toMatch(/compraron en más de una sucursal/);
    expect(c.cohortes[0]!.recompra90).toMatchObject({ con: 45, observables: 60 });
    expect(c.cohortes[0]!.recompra90.pct.valor).toBe(75); // 45 / 60, NO 45 / 100
    expect(c.cohortes[1]!.recompra30.pct.valor).toBeNull(); // ventana aún no observable: sin dato, no 0 %
    expect(Object.keys(c.definiciones)).toContain("perdido");
    expect(JSON.stringify(c)).not.toMatch(/telefono|phone|nombre_cliente|direccion/i);
  });

  it("productos: ranking, mix por categoría, matriz de cuadrantes, canasta con nombres y agotados con ranking y venta en riesgo", async () => {
    const canasta = {
      canastaPares: [{ propertyId: T1, productoA: "p-taco-pastor", productoB: "p-refresco", pedidosJuntos: 40 }],
      canastaTotales: [{ propertyId: T1, pedidosTotales: 200, pedidosConProducto: { "p-taco-pastor": 100, "p-refresco": 50 } }],
      canastaTickets: [{ propertyId: T1, nProductos: 1, pedidos: 80, netaCentavos: 800_000 }, { propertyId: T2, nProductos: 1, pedidos: 20, netaCentavos: 220_000 }],
    };
    const agot: FilaAgotado = { propertyId: T1, productId: "p-taco-pastor", nombre: "Taco al pastor", disponible: false, agotadoHasta: null, unidades28d: 280, diasConVenta28d: 28, precioListaCentavos: 4200, rankingUnidades: null };
    const p = await armar({ dataset: { ...canasta, agotados: [agot] } }).servicio.productosVista(Q);
    expect(p.ranking.masVendidos.length).toBeLessThanOrEqual(10);
    const u = p.ranking.masVendidos.map((r) => r.unidades);
    expect(u).toEqual([...u].sort((a, b) => b - a));
    expect(p.mixCategoria.reduce((s, c) => s + c.ingresoCentavos, 0)).toBe(D.productos.filter((x) => x.diaNegocio >= Q.desde && x.diaNegocio <= Q.hasta).reduce((s, x) => s + x.ingresoCentavos, 0));
    expect(new Set(p.matriz.map((m) => m.cuadrante)).size).toBeGreaterThan(1);
    expect(p.canasta[0]).toMatchObject({ nombreA: "Taco al pastor", nombreB: "Refresco", pedidosJuntos: 40, soportePct: 20, lift: 1.6 });
    expect(p.ticketPorNumeroProductos).toEqual([{ nProductos: 1, pedidos: 100, netaCentavos: 1_020_000, ticketCentavos: 10_200 }]);
    expect(p.agotados[0]).toMatchObject({ disponible: false, agotadoHasta: null, rankingUnidades: 1 });
    expect(p.agotados[0]!.ventaEnRiesgoPorDia.valor).toBe(42_000); // 280 u / 28 d × $42
    expect(p.agotados[0]!.ventaEnRiesgoPorDia.confianza).toBe("estimado");
  });

  it("patrones: estacionalidad semanal (7 días con promedio por ocurrencia), mensual, colonias (k-anonimato desde la SQL) y días entre pedidos", async () => {
    const colonias = [
      { propertyId: T1, colonia: "Centro", pedidos: 30, netaCentavos: 900_000, entregados: 28, minSuma: 1_120.5, clientes: 12, sucursalCercanaId: T2, distanciaKm: 2.3 },
      { propertyId: T1, colonia: "(otras)", pedidos: 8, netaCentavos: 200_000, entregados: 8, minSuma: 320, clientes: 6, sucursalCercanaId: null, distanciaKm: null },
    ];
    const p = await armar({ dataset: { colonias } }).servicio.patronesVista(Q);
    expect(p.estacionalidadSemanal.map((d) => d.dow)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(p.estacionalidadSemanal.every((d) => d.promedioDiaCentavos !== null)).toBe(true);
    expect(p.estacionalidadMensual.map((m) => m.mes)).toEqual(["2026-08", "2026-09"]);
    expect(p.colonias[0]).toMatchObject({ colonia: "Centro", distanciaKm: 2.3 });
    expect(p.colonias[0]!.entregaPromedioMin.valor).toBe(40); // 1120.5 / 28 = 40.0
    expect(p.colonias[1]!.entregaPromedioMin.valor).toBe(40);
    expect(p.avisos.some((a) => a.includes("(otras)"))).toBe(true);
    expect(p.diasEntrePedidos.valor).not.toBeUndefined();
  });

  it("operación: p50/p90 del conjunto rotulados aparte, embudo por sucursal, costo del agente con Meta «no medido» y comandas con modo", async () => {
    const o = await armar().servicio.operacionVista(Q);
    const conjunto = o.entregas.find((e) => e.conjunto)!;
    expect(conjunto.p90Min.valor).toBe(58);
    expect(conjunto.propertyId).toBeNull();
    expect(o.entregas.filter((e) => !e.conjunto)).toHaveLength(IDS.length);
    expect(o.costoAgente.total.meta.valor).toBeNull();
    expect(o.costoAgente.total.meta.fuente).toBe("Meta: no medido");
    expect(o.costoAgente.total.porPedido.valor).not.toBeNull();
    expect(o.costoAgente.noAsignado).not.toBeNull();
    expect(o.costoAgente.noAsignado!.llmTexto.valor).not.toBeNull();
    expect(o.embudo.noAsignado).toBeNull();
    expect(o.embudo.total.whatsapp.conversaciones).toBe(o.embudo.porSucursal.reduce((s, x) => s + x.whatsapp.conversaciones, 0));
    expect(o.comandas.modo).toBe("sombra");
    const acotado = await armar({ repo: { permitidas: [T1], organizacionCompleta: false } }).servicio.operacionVista(Q);
    expect(acotado.costoAgente.noAsignado).toBeNull();
    expect(acotado.costoAgente.total.llmTexto.valor).toBeNull();
  });

  it("NULL ≠ 0 en el costo del agente: sin tipo de cambio el costo en pesos es «sin dato»", async () => {
    const sinFx: FilaAgenteDiario[] = D.agenteDiario.map((f) => ({ ...f, costoVozCentavos: null, costoTelefoniaCentavos: null, costoLlmCentavos: null, mxnPorUsd: null }));
    const o = await armar({ dataset: { agenteDiario: sinFx } }).servicio.operacionVista(Q);
    expect(o.costoAgente.total.total.valor).toBeNull();
    expect(o.avisos.some((a) => a.includes("tipo de cambio"))).toBe(true);
  });
});

describe("pedidos, SoftRestaurant y alcance", () => {
  it("pedidos: página con cursor, sin PII y filtro de lista cerrada", async () => {
    const detalle = Array.from({ length: 7 }, (_, i) => ({
      orderId: `o${i}`, orderNumber: String(100 + i), propertyId: T1, diaNegocio: "2026-09-20", horaLocal: 13, canal: "domicilio" as const, source: "voice" as const, status: "entregado", paymentMethod: null,
      brutaCentavos: 10_000, descCentavos: 0, netaCentavos: 10_000, propinaCentavos: 0, entregadoMin: 40, esCompensacion: false, esReposicion: false, clienteAlias: "abcd1234", comandaEstado: null,
    }));
    const { servicio } = armar({ dataset: { pedidosDetalle: detalle } });
    const p1 = await servicio.pedidosVista(Q, { canal: "domicilio" }, 3, null);
    expect(p1.pedidos.map((x) => x.orderNumber)).toEqual(["106", "105", "104"]);
    expect(p1.cursor).toBe("2026-09-20|104");
    const p2 = await armar({ dataset: { pedidosDetalle: detalle } }).servicio.pedidosVista(Q, { canal: "domicilio" }, 3, p1.cursor);
    expect(p2.pedidos.map((x) => x.orderNumber)).toEqual(["103", "102", "101"]);
    const ultima = await armar({ dataset: { pedidosDetalle: detalle } }).servicio.pedidosVista(Q, {}, 3, "2026-09-20|101");
    expect(ultima.pedidos.map((x) => x.orderNumber)).toEqual(["100"]);
    expect(ultima.cursor).toBeNull();
    expect(Object.keys(p1.pedidos[0]!).join(",")).not.toMatch(/phone|telefono|nombre|direccion|address/i);
  });

  it("cuadre SR: domicilio nuestro vs SR por día con semáforo de cfo_config; sin SR, aviso y sin filas", async () => {
    const dias = ["2026-09-20", "2026-09-21"];
    const nuestro = (dia: string) => D.ventasDiarias.filter((f) => f.propertyId === T1 && f.diaNegocio === dia && f.canal === "domicilio").reduce((s, f) => s + f.netaCentavos, 0);
    const pedidos = (dia: string) => D.ventasDiarias.filter((f) => f.propertyId === T1 && f.diaNegocio === dia && f.canal === "domicilio").reduce((s, f) => s + f.pedidos, 0);
    const sr = dias.map((dia, i) => ({
      propertyId: T1, diaNegocio: dia, tipoServicio: "domicilio" as const, formaPago: null, tickets: pedidos(dia), brutaCentavos: 0, descuentoCentavos: 0, canceladoCentavos: 0, propinaCentavos: 0, ivaCentavos: null,
      // Día 1: cuadra exacto; día 2: 20 % más que lo nuestro.
      netaCentavos: i === 0 ? nuestro(dia) : Math.round(nuestro(dia) * 1.2),
    }));
    const c = await armar({ dataset: { srResumen: sr } }).servicio.cuadreSr(Q);
    expect(c.filas.map((f) => [f.diaNegocio, f.semaforo])).toEqual([["2026-09-20", "verde"], ["2026-09-21", "rojo"]]);
    expect(c.filas[0]!.diferenciaCentavos).toBe(0);
    expect(c.porSucursal.find((x) => x.propertyId === T1)).toMatchObject({ diasConDato: 2, semaforo: "rojo" });
    expect(c.umbrales).toEqual({ verdePct: 1, ambarPct: 3, verdeCentavos: 5000 });
    const sin = await armar().servicio.cuadreSr(Q);
    expect(sin.filas).toEqual([]);
    expect(sin.avisos.some((a) => a.startsWith("Sin datos de mostrador de SoftRestaurant"))).toBe(true);
  });

  it("alcance: cobertura por fuente, modo SR, zona y corte HH:MM; sin PII", async () => {
    const a = await armar().servicio.alcanceVista();
    expect(a.sucursales[0]).toMatchObject({ zona: "America/Merida", corte: "01:00" });
    expect(a.cobertura.pedidos).toHaveLength(IDS.length);
    expect(a.cobertura.pedidos[0]).toMatchObject({ primerDia: "2026-05-01", ultimoDia: "2026-09-27" });
    expect(a.organizacionCompleta).toBe(true);
    expect(a.configurada).toBe(false);
    expect(a.bloques).toEqual({ ventas: true, clientes: true, captura: true });
    const sinMig = await armar({ repo: { migraciones: { m081: false, m082: false, m083: false } } }).servicio.alcanceVista();
    expect(sinMig.bloques).toEqual({ ventas: false, clientes: false, captura: false });
    expect(sinMig.avisos.length).toBeGreaterThanOrEqual(3);
  });

  it("config y costos: la vista expone defaults, rangos y si este actor puede guardar", async () => {
    const completo = await armar().servicio.configVista();
    expect(completo).toMatchObject({ disponible: true, configurada: false, puedeGuardar: true });
    expect(completo.rangos["activoDias"]).toEqual([7, 365]);
    expect(completo.rangos["perdidoDias"]).toEqual([14, 730]);
    expect(completo.rangos["frecuenteDias"]).toEqual([30, 365]);
    expect((await armar({ repo: { organizacionCompleta: false, permitidas: [T1] } }).servicio.configVista()).puedeGuardar).toBe(false);
    const costos = await armar().servicio.costosVista("2026-08-01", "2026-09-01");
    expect(costos.conceptos).toContain("food_cost_objetivo_pct");
    expect(costos.puedeCapturarOrganizacion).toBe(true);
  });
});

describe("guardas del servicio", () => {
  it("la narrativa jamás incluye números sin respaldo (guard sobre varias combinaciones de alcance)", async () => {
    for (const repo of [{}, { permitidas: [T1, T2], organizacionCompleta: false }] as const) {
      const r = await armar({ repo, dataset: { srResumen: D.srResumen } }).servicio.resumen(Q);
      expect(r.narrativa.numerosNoRespaldados).toEqual([]);
      expect(r.narrativa.oraciones.length).toBeGreaterThanOrEqual(3);
      expect(r.narrativa.oraciones.length).toBeLessThanOrEqual(6);
    }
  });
});
