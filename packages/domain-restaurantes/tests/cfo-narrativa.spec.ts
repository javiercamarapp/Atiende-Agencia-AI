// CFO-04 · resumen narrado determinista: 3 a 6 oraciones, cada número con su referencia y sin ningún número que no venga de la entrada.
import { describe, expect, it } from "vitest";
import type { Hallazgo } from "../src/cfo/hallazgos.ts";
import { narrarResumen, numerosNoRespaldados, type KpisResumen, type ValorKpi } from "../src/cfo/narrativa.ts";
import type { AlcanceSucursales, Cifra } from "../src/cfo/tipos.ts";
import { mulberry32 } from "./fixtures/cfo-pm-sintetico.ts";

const TODAS: AlcanceSucursales = { propertyIds: ["a", "b", "c"], todas: true, organizacionCompleta: true };
const UNA: AlcanceSucursales = { propertyIds: ["a"], todas: true, organizacionCompleta: true };
const ACOTADO: AlcanceSucursales = { propertyIds: ["a", "b"], todas: true, organizacionCompleta: false };

const cif = (valor: number | null): Cifra => ({ valor, confianza: valor == null ? "sin_dato" : "medido", fuente: "t" });
const kpi = (valor: number | null, tipo: ValorKpi["tipo"]): ValorKpi => ({ cifra: cif(valor), tipo });

function kpis(p: Partial<KpisResumen> = {}): KpisResumen {
  return {
    titularOrigen: "agente", periodo: "los últimos 7 días", comparadoContra: "su promedio de las 4 semanas previas", alcanceEtiqueta: "todas sus sucursales",
    ventasNetas: kpi(12_840_000, "centavos"), pedidos: kpi(412, "entero"), ticket: kpi(31_165, "centavos"), variacionVentas: kpi(-18, "pct"), descuentoPct: kpi(6.4, "pct"), cancelacionPct: kpi(8.1, "pct"),
    margenContribucion: kpi(9_100_000, "centavos"), margenParcial: true, multiSucursal: 37, mayorAporte: { sucursal: "Altabrisa", aportePct: cif(60) }, ...p,
  };
}

function hallazgo(n: number, impacto: number | null, titulo: string): Hallazgo {
  return {
    id: `caida_ventas:s${n}`, tipo: "caida_ventas", propertyId: `s${n}`, sucursal: `S${n}`, titulo, cifra: cif(-18), cifraTexto: "-18 %", comparacion: "Vendió $8,200.00 contra $10,000.00.", porQueImporta: "p",
    accion: { texto: "a", ruta: "/cfo/ventas" }, impactoCentavos: impacto, urgencia: "media", fuentes: ["x"],
  };
}
const H = [hallazgo(1, 1_800_000, "Altabrisa cayó 18 % vs su promedio de los martes"), hallazgo(2, null, "Pensiones tiene 3 comandas vencidas sin capturar en SoftRestaurant")];

describe("costo del agente por pedido: Meta «no medido»", () => {
  it("con Meta sin medir lo dice y no lo presenta como $0; con Meta medido no agrega la aclaración", () => {
    const sin = narrarResumen(kpis({ costoPorPedidoAgente: kpi(1_250, "centavos"), metaNoMedido: true, margenContribucion: undefined, multiSucursal: null }), [], TODAS);
    expect(sin.texto).toContain("El costo del agente fue de $12.50 [costo_pedido_agente] por pedido, sin incluir el costo de Meta, que no está medido.");
    expect(sin.numerosNoRespaldados).toEqual([]);
    const con = narrarResumen(kpis({ costoPorPedidoAgente: kpi(1_250, "centavos"), metaNoMedido: false, margenContribucion: undefined, multiSucursal: null }), [], TODAS);
    expect(con.texto).toContain("El costo del agente fue de $12.50 [costo_pedido_agente] por pedido.");
    expect(con.texto).not.toContain("Meta");
  });
  it("sin costo por pedido (null) no hay oración de costo", () => {
    expect(narrarResumen(kpis({ costoPorPedidoAgente: kpi(null, "centavos"), metaNoMedido: true }), H, TODAS).texto).not.toContain("costo del agente");
  });
});

describe("narrativa con datos", () => {
  const r = narrarResumen(kpis(), H, TODAS);
  it("3 a 6 oraciones deterministas, en español de México y de usted", () => {
    expect(r.oraciones.length).toBeGreaterThanOrEqual(3);
    expect(r.oraciones.length).toBeLessThanOrEqual(6);
    expect(r.texto).toBe(r.oraciones.map((o) => o.texto).join(" "));
    expect(narrarResumen(kpis(), H, TODAS)).toEqual(r);
    expect(r.texto).not.toMatch(/\b(tu|tus|tienes|puedes)\b/i);
  });
  it("cada número viene de la entrada y lleva su referencia", () => {
    expect(r.oraciones[0]!.texto).toBe("En los últimos 7 días (todas sus sucursales), el agente vendió $128,400.00 [ventas_netas] en 412 [pedidos] pedidos, con un ticket promedio de $311.65 [ticket].");
    expect(r.texto).toContain("18 % [variacion_ventas] menos que su promedio de las 4 semanas previas");
    expect(r.texto).toContain("Altabrisa explica 60 % [mayor_aporte] de la caída.");
    expect(r.texto).toContain("Lo más importante: Altabrisa cayó 18 % vs su promedio de los martes [hallazgo_1], con $18,000.00 [impacto_1] en juego.");
    expect(r.texto).toContain("37 clientes compraron en más de una sucursal [multi_sucursal]");
    expect(r.referencias["ventas_netas"]).toBe("$128,400.00");
    expect(r.referencias["variacion_ventas"]).toBe("18 %");
  });
  it("guard de números: ninguna cifra sin respaldo en la entrada", () => {
    expect(r.numerosNoRespaldados).toEqual([]);
    expect(numerosNoRespaldados(r.texto, kpis(), H)).toEqual([]);
  });
  it("el guard SÍ detecta un número inventado", () => {
    expect(numerosNoRespaldados("Vendió $999,999.00 [ventas_netas].", kpis(), H)).toEqual(["999999"]);
    expect(numerosNoRespaldados("Subió 77 % en el mes.", kpis(), H)).toEqual(["77"]);
    expect(numerosNoRespaldados("Eso es 18 % menos [variacion_ventas].", kpis(), H)).toEqual([]);
    expect(numerosNoRespaldados("Sin números.", kpis(), H)).toEqual([]);
  });
  it("toda oración con dígitos cita al menos una referencia", () => {
    for (const o of r.oraciones) if (/\d/.test(o.texto.replace(/\[[a-z0-9_]+\]/g, "").replace(/los últimos 7 días/, ""))) expect(o.refs.length).toBeGreaterThan(0);
    for (const o of r.oraciones) for (const ref of o.refs) expect(o.texto).toContain(`[${ref}]`);
  });
  it("margen parcial se declara como tal", () => {
    const r = narrarResumen(kpis({ mayorAporte: null, multiSucursal: null }), H, TODAS);
    expect(r.texto).toContain("El margen de contribución es $91,000.00 [margen_contribucion], parcial porque faltan costos por capturar.");
  });
});

describe("variaciones del texto", () => {
  it("aumento, sin cambio y sin comparación", () => {
    expect(narrarResumen(kpis({ variacionVentas: kpi(12.5, "pct") }), [], TODAS).texto).toContain("12.5 % [variacion_ventas] más que");
    expect(narrarResumen(kpis({ variacionVentas: kpi(0, "pct") }), [], TODAS).texto).toContain("Eso es igual que su promedio de las 4 semanas previas [variacion_ventas].");
    const sin = narrarResumen(kpis({ variacionVentas: kpi(null, "pct"), mayorAporte: null }), [], TODAS);
    expect(sin.texto).toContain("No hay un periodo de comparación con datos, así que no se calcula la variación.");
    expect(sin.texto).not.toContain("[variacion_ventas]");
  });
  it("con SoftRestaurant el titular es el negocio", () => {
    expect(narrarResumen(kpis({ titularOrigen: "negocio" }), [], TODAS).oraciones[0]!.texto).toContain("el negocio vendió");
  });
  it("sin hallazgos lo dice sin inventar", () => {
    const r = narrarResumen(kpis(), [], TODAS);
    expect(r.texto).toContain("No se detectaron hallazgos que requieran su atención en este periodo.");
    expect(r.oraciones.length).toBeGreaterThanOrEqual(3);
  });
  it("un hallazgo sin impacto monetizable no cita impacto", () => {
    const r = narrarResumen(kpis(), [H[1]!], TODAS);
    expect(r.texto).toContain("Lo más importante: Pensiones tiene 3 comandas vencidas sin capturar en SoftRestaurant [hallazgo_1].");
    expect(r.texto).not.toContain("impacto_1");
  });
  it("solo toma los dos primeros hallazgos", () => {
    const r = narrarResumen(kpis(), [H[0]!, H[1]!, hallazgo(3, 5, "Otro 5 %")], TODAS);
    expect(r.texto).not.toContain("Otro");
    expect(r.texto).toContain("También: Pensiones");
  });
  it("una sola sucursal no habla de aporte ni de clientes en varias sucursales", () => {
    const r = narrarResumen(kpis(), H, UNA);
    expect(r.texto).not.toContain("[mayor_aporte]");
    expect(r.texto).not.toContain("[multi_sucursal]");
  });
  it("0 clientes en más de una sucursal no se menciona", () => {
    expect(narrarResumen(kpis({ multiSucursal: 0 }), [], TODAS).texto).not.toContain("multi_sucursal");
  });
  it("el admin acotado ve que las cifras son solo de sus sucursales", () => {
    expect(narrarResumen(kpis(), [], ACOTADO).texto).toContain("Las cifras corresponden solo a las sucursales que usted administra.");
  });
  it("máximo 6 oraciones aunque haya de todo; el aviso de alcance y lo más importante no se pierden", () => {
    const r = narrarResumen(kpis({ descuentoPct: kpi(6.4, "pct"), cancelacionPct: kpi(8.1, "pct") }), H, ACOTADO);
    expect(r.oraciones.length).toBe(6);
    expect(r.texto).toContain("Las cifras corresponden solo a las sucursales que usted administra.");
    expect(r.texto).toContain("Lo más importante:");
    expect(r.texto).not.toContain("[descuento_pct]"); // lo de menor prioridad es lo que se recorta
  });
  it("solo descuentos o solo cancelaciones", () => {
    const sobrio = { mayorAporte: null, multiSucursal: null, margenContribucion: undefined } as const;
    expect(narrarResumen(kpis({ ...sobrio, cancelacionPct: undefined }), [], TODAS).texto).toContain("Los descuentos fueron 6.4 % [descuento_pct] de la venta bruta.");
    expect(narrarResumen(kpis({ ...sobrio, descuentoPct: undefined }), [], TODAS).texto).toContain("Las cancelaciones fueron 8.1 % [cancelacion_pct] de los pedidos.");
  });
});

describe("0 datos: dice que no hay datos y no inventa", () => {
  it("ventas sin dato (null)", () => {
    const r = narrarResumen(kpis({ ventasNetas: kpi(null, "centavos") }), H, TODAS);
    expect(r.sinDatos).toBe(true);
    expect(r.oraciones).toHaveLength(1);
    expect(r.texto).toBe("No hay datos de ventas en el periodo seleccionado, así que no se puede resumir ni comparar.");
    expect(r.texto).not.toMatch(/\d/);
    expect(r.texto).not.toMatch(/\[/);
    expect(r.referencias).toEqual({});
  });
  it("cero pedidos", () => {
    const r = narrarResumen(kpis({ ventasNetas: kpi(0, "centavos"), pedidos: kpi(0, "entero") }), [], TODAS);
    expect(r.sinDatos).toBe(true);
    expect(r.texto).not.toMatch(/\d/);
  });
});

describe("propiedad: con entradas aleatorias deterministas jamás aparece un número sin respaldo (300 casos)", () => {
  it("el guard queda vacío y el texto cita referencias", () => {
    const rnd = mulberry32(31337);
    const num = (max: number): number => Math.floor(rnd() * max);
    for (let i = 0; i < 300; i++) {
      const k = kpis({
        titularOrigen: rnd() < 0.5 ? "agente" : "negocio",
        ventasNetas: kpi(num(900_000_000), "centavos"),
        pedidos: rnd() < 0.8 ? kpi(1 + num(50_000), "entero") : undefined,
        ticket: rnd() < 0.8 ? kpi(num(200_000), "centavos") : undefined,
        variacionVentas: rnd() < 0.8 ? kpi((num(2001) - 1000) / 10, "pct") : kpi(null, "pct"),
        descuentoPct: rnd() < 0.5 ? kpi(num(300) / 10, "pct") : undefined,
        cancelacionPct: rnd() < 0.5 ? kpi(num(300) / 10, "pct") : undefined,
        margenContribucion: rnd() < 0.5 ? kpi(num(900_000_000) - 100_000_000, "centavos") : undefined,
        margenParcial: rnd() < 0.5,
        multiSucursal: rnd() < 0.5 ? num(5000) : null,
        mayorAporte: rnd() < 0.5 ? { sucursal: "Altabrisa", aportePct: cif((num(2001) - 1000) / 10) } : null,
      });
      const hs = Array.from({ length: num(4) }, (_, j) => hallazgo(j + 1, rnd() < 0.5 ? num(100_000_000) : null, `Hallazgo ${j + 1}: ${num(100)} %`));
      const r = narrarResumen(k, hs, [TODAS, UNA, ACOTADO][num(3)]!);
      expect(r.numerosNoRespaldados).toEqual([]);
      expect(numerosNoRespaldados(r.texto, k, hs)).toEqual([]);
      expect(r.oraciones.length).toBeGreaterThanOrEqual(1);
      expect(r.oraciones.length).toBeLessThanOrEqual(6);
      if (!r.sinDatos) expect(r.oraciones.length).toBeGreaterThanOrEqual(3);
    }
  });
});
