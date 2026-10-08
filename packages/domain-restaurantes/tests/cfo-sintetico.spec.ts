// CFO-04 · el generador SINTÉTICO de PM: determinista, con los volúmenes del diseño §4.8, sin datos personales, y coherente de punta a punta.
import { describe, expect, it } from "vitest";
import { columnaDe, construirEstadoResultados, lineaDe } from "../src/cfo/estado-resultados.ts";
import { sumarVentas } from "../src/cfo/formulas.ts";
import {
  agregarVentasDiarias, CSV_SR_SINTETICO, ETIQUETA_SINTETICO, filasXlsxSrSintetico, generarDatasetSintetico, generarPedidosSinteticos, mulberry32, PRODUCTOS_SINTETICOS, SUCURSALES_PM_SINTETICAS,
} from "./fixtures/cfo-pm-sintetico.ts";

describe("determinismo", () => {
  it("misma semilla, mismo dataset; otra semilla, otro dataset", () => {
    const a = generarDatasetSintetico();
    const b = generarDatasetSintetico();
    expect(a.ventasDiarias).toEqual(b.ventasDiarias);
    expect(a.srResumen).toEqual(b.srResumen);
    expect(a.clientes).toEqual(b.clientes);
    const c = generarDatasetSintetico({ semilla: 5 });
    expect(c.ventasDiarias).not.toEqual(a.ventasDiarias);
  });
  it("el PRNG es estable (valores fijos)", () => {
    const r = mulberry32(1);
    expect([r(), r(), r()].map((x) => Math.round(x * 1e6))).toEqual([627_074, 2_736, 527_447]);
  });
});

describe("volúmenes de PM", () => {
  const pedidos = generarPedidosSinteticos();
  const ult30 = pedidos.filter((p) => p.diaNegocio > "2026-08-28" && p.diaNegocio <= "2026-09-27");
  it("unos 3,929 pedidos al mes, ≈ 71 % a domicilio (2,806) y ≈ 29 % para recoger (1,123)", () => {
    expect(ult30.length).toBeGreaterThan(3500);
    expect(ult30.length).toBeLessThan(4400);
    const dom = ult30.filter((p) => p.canal === "domicilio").length;
    expect(dom / ult30.length).toBeGreaterThan(0.68);
    expect(dom / ult30.length).toBeLessThan(0.75);
  });
  it("~18 % por WhatsApp y el resto por voz", () => {
    const wa = ult30.filter((p) => p.source === "whatsapp").length / ult30.length;
    expect(wa).toBeGreaterThan(0.15);
    expect(wa).toBeLessThan(0.21);
  });
  it("sábado y domingo pesan más que un lunes, con picos de 13–16 h y 18–22 h", () => {
    const dow = (d: string): number => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
    const porDow = new Array(7).fill(0) as number[];
    for (const p of ult30) porDow[dow(p.diaNegocio)]! += 1;
    expect(porDow[5]!).toBeGreaterThan(porDow[0]!);
    expect(porDow[6]!).toBeGreaterThan(porDow[0]!);
    const finde = ult30.filter((p) => dow(p.diaNegocio) >= 5);
    const pico = finde.filter((p) => (p.horaLocal >= 13 && p.horaLocal <= 16) || (p.horaLocal >= 18 && p.horaLocal <= 22)).length / finde.length;
    expect(pico).toBeGreaterThan(0.8);
  });
  it("ticket alrededor de $312", () => {
    const ventas = ult30.filter((p) => p.estado === "entregado" || p.estado === "completado");
    const ticket = ventas.reduce((s, p) => s + p.brutaCentavos, 0) / ventas.length;
    expect(ticket).toBeGreaterThan(26_000);
    expect(ticket).toBeLessThan(37_000);
  });
  it("~8 % de cancelaciones", () => {
    const c = ult30.filter((p) => p.estado === "cancelado").length / ult30.length;
    expect(c).toBeGreaterThan(0.05);
    expect(c).toBeLessThan(0.11);
  });
  it("promos de lunes y martes SOLO para recoger", () => {
    const dow = (d: string): number => new Date(`${d}T00:00:00Z`).getUTCDay(); // 1 lunes, 2 martes
    const conPromo = ult30.filter((p) => p.descCentavos > 0 && !p.esCompensacion);
    expect(conPromo.length).toBeGreaterThan(0);
    for (const p of conPromo) {
      expect(p.canal).toBe("recoger");
      expect([1, 2]).toContain(dow(p.diaNegocio));
    }
  });
  it("T4 y T5 solo presencial y recoger: jamás domicilio", () => {
    for (const s of SUCURSALES_PM_SINTETICAS.filter((x) => x.codigo === "T4" || x.codigo === "T5")) {
      expect(ult30.some((p) => p.propertyId === s.propertyId && p.canal === "domicilio")).toBe(false);
      expect(ult30.some((p) => p.propertyId === s.propertyId && p.canal === "recoger")).toBe(true);
    }
    expect(SUCURSALES_PM_SINTETICAS).toHaveLength(7);
    expect(SUCURSALES_PM_SINTETICAS.filter((s) => s.reparte).map((s) => s.codigo)).toEqual(["T1", "T2", "T3", "T7", "T8"]);
  });
  it("el caso del cuestionario: 6 tacos al pastor + 1 agua = $312", () => {
    const pastor = PRODUCTOS_SINTETICOS.find((p) => p.ref === "p-taco-pastor")!;
    const agua = PRODUCTOS_SINTETICOS.find((p) => p.ref === "p-agua-fresca")!;
    expect(pastor.precio).toBe(4200);
    expect(6 * pastor.precio + agua.precio).toBe(31200);
  });
});

describe("cero datos personales", () => {
  const d = generarDatasetSintetico();
  it("ni teléfonos, ni correos, ni direcciones, ni nombres reales en ninguna fila", () => {
    const todo = JSON.stringify({ ...d, pedidos: undefined, sucursales: undefined }) + CSV_SR_SINTETICO + JSON.stringify(filasXlsxSrSintetico);
    expect(todo).not.toMatch(/\b\d{10}\b/); // teléfonos de 10 dígitos
    expect(todo).not.toMatch(/@[a-z0-9-]+\./i);
    expect(todo).not.toMatch(/\b999\s?\d{3}\s?\d{4}\b/); // teléfonos de Mérida
    expect(Object.keys(d.ventasDiarias[0]!)).not.toEqual(expect.arrayContaining(["customerName"]));
  });
  it("los clientes son identificadores sintéticos", () => {
    const p = generarPedidosSinteticos({ dias: 3 });
    for (const x of p) expect(x.clienteId).toMatch(/^cliente-sintetico-\d+$/);
  });
  it("los exports de SR dicen que NO son reales", () => {
    expect(CSV_SR_SINTETICO).toContain(ETIQUETA_SINTETICO);
    expect(filasXlsxSrSintetico[0]).toEqual([ETIQUETA_SINTETICO]);
    expect(ETIQUETA_SINTETICO).toContain("SINTÉTICO");
  });
});

describe("coherencia del dataset", () => {
  const d = generarDatasetSintetico();
  it("las filas agregadas suman lo mismo que los pedidos individuales", () => {
    const enRango = d.pedidos.filter((p) => p.diaNegocio >= d.desde && p.diaNegocio <= d.hasta);
    const s = sumarVentas(agregarVentasDiarias(enRango));
    expect(s.netaCentavos).toBe(enRango.filter((p) => (p.estado === "entregado" || p.estado === "completado") && !p.esReposicion).reduce((a, p) => a + p.netaCentavos, 0));
    expect(s.pedidos + s.cancelados + s.noRecogidos + s.reposiciones).toBe(enRango.length);
    expect(sumarVentas(d.ventasDiarias)).toEqual(s);
  });
  it("bruta − descuentos = neta en cada fila", () => {
    for (const f of d.ventasDiarias) expect(f.brutaCentavos - f.descPromoCentavos - f.descCompCentavos).toBe(f.netaCentavos);
  });
  it("hay compensaciones GRACIAS- y cortesías (reposiciones)", () => {
    expect(d.ventasDiarias.some((f) => f.descCompCentavos > 0)).toBe(true);
    expect(d.cortesias.length).toBeGreaterThan(0);
  });
  it("las filas del agente traen un renglón «No asignado» con el LLM y Meta sin medir", () => {
    expect(d.agenteDiario.some((f) => f.propertyId === null && (f.costoLlmCentavos ?? 0) > 0)).toBe(true);
    expect(d.agenteDiario.every((f) => f.metaEventos === 0 && f.costoMetaCentavos === null)).toBe(true);
  });
  it("las sucursales con comandas en modo sombra y el ranking de agotados existen", () => {
    expect(d.comandasPos.every((f) => f.modo === "sombra")).toBe(true);
    expect(d.agotados.filter((a) => a.rankingUnidades === 1)).toHaveLength(7);
  });
});

describe("de punta a punta: con SR sintético el negocio vende MÁS que el agente y nunca se suman", () => {
  const d = generarDatasetSintetico({ diasRango: 14 });
  const ids = d.sucursales.map((s) => s.propertyId);
  const er = construirEstadoResultados({
    ventas: d.ventasDiarias, cortesias: d.cortesias, costosAgente: d.agenteDiario, costosCapturados: [], config: d.config, srResumen: d.srResumen, granularidad: "mes", rango: { desde: d.desde, hasta: d.hasta },
    alcance: { propertyIds: ids, todas: true, organizacionCompleta: true }, sucursales: d.sucursales,
  });
  const total = columnaDe(er.acumulado, "total")!;
  it("el titular es el total SR, que supera al del agente", () => {
    expect(er.acumulado.usaSr).toBe(true);
    const totalSr = d.srResumen.reduce((s, f) => s + f.netaCentavos, 0);
    const totalAgente = d.ventasDiarias.reduce((s, f) => s + f.netaCentavos, 0);
    expect(total.titular.cifra.valor).toBe(totalSr);
    expect(totalSr).toBeGreaterThan(totalAgente);
    expect(total.titular.cifra.valor).not.toBe(totalSr + totalAgente);
    expect(total.titular.ventasAgenteMemo?.valor).toBe(totalAgente);
    const g = total.titular.desglose!;
    expect(g.domicilioSR + g.presencial + g.otro).toBe(totalSr);
    // el domicilio del agente es un subconjunto del domicilio de SR
    const domAgente = d.ventasDiarias.filter((f) => f.canal === "domicilio").reduce((s, f) => s + f.netaCentavos, 0);
    expect(g.domicilioSR).toBeGreaterThan(domAgente);
  });
  it("consolidado = Σ sucursales + No asignado también con SR", () => {
    const cols = er.acumulado.columnas.filter((c) => c.clave !== "total");
    for (const id of ["ventas_brutas", "descuentos_promocion", "ventas_netas", "iva_estimado", "ventas_netas_sin_iva", "costo_agente"] as const) {
      expect(lineaDe(total, id).cifra.valor).toBe(cols.reduce((s, c) => s + (lineaDe(c, id).cifra.valor ?? 0), 0));
    }
  });
  it("sin SR la misma data titula «Ventas por el agente»", () => {
    const sinSr = construirEstadoResultados({
      ventas: d.ventasDiarias, cortesias: d.cortesias, costosAgente: d.agenteDiario, costosCapturados: [], config: d.config, granularidad: "mes", rango: { desde: d.desde, hasta: d.hasta },
      alcance: { propertyIds: ids, todas: true, organizacionCompleta: true }, sucursales: d.sucursales,
    });
    expect(columnaDe(sinSr.acumulado, "total")!.titular.etiqueta).toBe("Ventas por el agente");
  });
});
