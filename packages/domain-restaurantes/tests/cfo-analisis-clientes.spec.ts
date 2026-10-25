// CFO «Análisis de clientes» (Fase A): afinidad con lift y k-anonimato (TypeScript puro), mapeadores de los jsonb de la migración 095 tal como los entrega
// node-postgres, adaptador Postgres contra AbortAwareFakeSession (base sin migrar con SAVEPOINT, 22023/42501 tipados), repositorio en memoria y armado de
// las secciones. Datos 100 % sintéticos.
import { describe, expect, it } from "vitest";
import {
  InMemoryCfoRepository,
  MIN_PEDIDOS_AFINIDAD,
  PENDIENTES_ANALISIS_CLIENTES,
  armarSeccionesAnalisis,
  calcularAfinidad,
  nombresPorRef,
} from "../src/cfo/index.ts";
import type { EntradaAnalisis, FilaCanastaPar, FilaCanastaTotales } from "../src/cfo/index.ts";
import { CfoParametroInvalidoError, CfoSinAccesoError } from "../src/cfo/repositorio.ts";
import { PostgresCfoRepository, mapIntervaloRecompra, mapReactivacion, mapRfm, mapTortilla } from "../src/cfo/repositorio-postgres.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000a2";
const P = { organizationId: ORG, propertyIds: [A] } as const;
const R = { desde: "2026-07-01", hasta: "2026-09-27" } as const;

function pgError(code: string, message = "boom"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("calcularAfinidad: soporte, confianza, lift y k-anonimato", () => {
  const pares: FilaCanastaPar[] = [
    { propertyId: A, productoA: "refresco", productoB: "taco", pedidosJuntos: 30 },
    { propertyId: A, productoA: "flan", productoB: "refresco", pedidosJuntos: 8 },
    { propertyId: A, productoA: "flan", productoB: "taco", pedidosJuntos: 4 },
  ];
  const totales: FilaCanastaTotales[] = [{ propertyId: A, pedidosTotales: 100, pedidosConProducto: { taco: 40, refresco: 50, flan: 10 } }];
  const nombres = new Map([["taco", "Tacos"], ["refresco", "Refresco"]]);

  it("lift = juntos·total/(A·B); confianza en ambos sentidos; soporte sobre los pedidos del periodo", () => {
    const r = calcularAfinidad(pares, totales, nombres);
    const taco = r.pares.find((p) => p.productoB === "taco")!;
    expect(taco).toMatchObject({ pedidosJuntos: 30, soportePct: 30, lift: 1.5, confianzaAB: 60, confianzaBA: 75, nombreB: "Tacos" });
    const flan = r.pares.find((p) => p.productoA === "flan")!;
    expect(flan.lift).toBe(1.6);
    // Sin nombre en el catálogo se conserva la referencia.
    expect(flan.nombreA).toBe("flan");
  });

  it("un par con menos de 5 pedidos juntos NO se publica y se cuenta como oculto", () => {
    const r = calcularAfinidad(pares, totales, nombres);
    expect(MIN_PEDIDOS_AFINIDAD).toBe(5);
    expect(r.ocultosPorPrivacidad).toBe(1);
    expect(r.pares.every((p) => p.pedidosJuntos >= 5)).toBe(true);
    expect(r.pares).toHaveLength(2);
  });

  it("exactamente 5 pedidos sí se muestra; 4 no (frontera)", () => {
    const r5 = calcularAfinidad([{ propertyId: A, productoA: "a", productoB: "b", pedidosJuntos: 5 }], [{ propertyId: A, pedidosTotales: 50, pedidosConProducto: { a: 10, b: 10 } }], new Map());
    expect(r5.pares).toHaveLength(1);
    expect(r5.pares[0]!.lift).toBe(2.5);
    const r4 = calcularAfinidad([{ propertyId: A, productoA: "a", productoB: "b", pedidosJuntos: 4 }], [{ propertyId: A, pedidosTotales: 50, pedidosConProducto: { a: 10, b: 10 } }], new Map());
    expect(r4.pares).toEqual([]);
    expect(r4.ocultosPorPrivacidad).toBe(1);
  });

  it("ordena por lift descendente y desempata por pedidos juntos y por referencia (estable)", () => {
    const r = calcularAfinidad(
      [{ propertyId: A, productoA: "a", productoB: "b", pedidosJuntos: 10 }, { propertyId: A, productoA: "c", productoB: "d", pedidosJuntos: 20 }, { propertyId: A, productoA: "e", productoB: "f", pedidosJuntos: 10 }],
      [{ propertyId: A, pedidosTotales: 100, pedidosConProducto: { a: 20, b: 50, c: 40, d: 50, e: 20, f: 50 } }],
      new Map(),
    );
    // lift: a-b = 10·100/(20·50) = 1; c-d = 20·100/(40·50) = 1; e-f = 1. Todos empatan en lift: gana más pedidos, luego la referencia.
    expect(r.pares.map((p) => `${p.productoA}${p.productoB}`)).toEqual(["cd", "ab", "ef"]);
  });

  it("consolida entre sucursales: los pedidos juntos y los totales SUMAN; el par se normaliza a<b sin distinguir mayúsculas", () => {
    const r = calcularAfinidad(
      [{ propertyId: A, productoA: "Taco", productoB: "refresco", pedidosJuntos: 3 }, { propertyId: B, productoA: "refresco", productoB: "taco", pedidosJuntos: 4 }],
      [{ propertyId: A, pedidosTotales: 20, pedidosConProducto: { Taco: 10, refresco: 10 } }, { propertyId: B, pedidosTotales: 30, pedidosConProducto: { taco: 10, refresco: 20 } }],
      new Map(),
    );
    // 3 + 4 = 7 juntos (≥ 5: en cada sucursal por separado serían ocultos); totales 50; taco 20, refresco 30 => lift 7·50/(20·30) = 0.58.
    expect(r.pares).toHaveLength(1);
    expect(r.pares[0]).toMatchObject({ productoA: "refresco", productoB: "taco", pedidosJuntos: 7, lift: 0.58 });
    expect(r.pedidosTotales).toBe(50);
  });

  it("sin pedidos totales o sin base del producto: lift nulo (nunca 0 ni NaN)", () => {
    const sinBase = calcularAfinidad([{ propertyId: A, productoA: "a", productoB: "b", pedidosJuntos: 6 }], [{ propertyId: A, pedidosTotales: 10, pedidosConProducto: {} }], new Map());
    expect(sinBase.pares[0]).toMatchObject({ lift: null, confianzaAB: null, confianzaBA: null });
    const vacio = calcularAfinidad([], [], new Map());
    expect(vacio).toEqual({ pares: [], ocultosPorPrivacidad: 0, pedidosTotales: 0 });
  });

  it("respeta el tope de pares", () => {
    const muchos: FilaCanastaPar[] = Array.from({ length: 30 }, (_, i) => ({ propertyId: A, productoA: `a${String(i).padStart(2, "0")}`, productoB: "z", pedidosJuntos: 10 + i }));
    const tot: FilaCanastaTotales[] = [{ propertyId: A, pedidosTotales: 1000, pedidosConProducto: { z: 500, ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`a${String(i).padStart(2, "0")}`, 100])) } }];
    expect(calcularAfinidad(muchos, tot, new Map()).pares).toHaveLength(20);
    expect(calcularAfinidad(muchos, tot, new Map(), 3).pares).toHaveLength(3);
  });

  it("nombresPorRef usa el nombre actual del catálogo sin distinguir mayúsculas", () => {
    const m = nombresPorRef([{ propertyId: A, productoRef: "TACO", nombreActual: "Tacos al pastor", categoria: "x", diaNegocio: "2026-09-01", dowNegocio: 1, unidades: 1, ingresoCentavos: 1, pedidos: 1 }]);
    expect(m.get("taco")).toBe("Tacos al pastor");
  });
});

describe("mapeadores de la migración 095 (jsonb tal como lo entrega node-postgres)", () => {
  it("rfm: números JSON a number, nulos significativos, segmento desconocido descartado, pareto vacío = null", () => {
    const m = mapRfm({
      segmentos: [
        { segmento: "campeon", orden: 1, clientes: 2, pedidos: 9, venta_centavos: 140000, ticket_centavos: 15556, recencia_mediana_dias: 3.5 },
        { segmento: "leal", orden: 2, clientes: 0, pedidos: 0, venta_centavos: 0, ticket_centavos: null, recencia_mediana_dias: null },
        { segmento: "de_una_version_futura", orden: 9, clientes: 1, pedidos: 1, venta_centavos: 1, ticket_centavos: 1, recencia_mediana_dias: 1 },
      ],
      resumen: { clientes_con_venta: 10, clientes_recompra: 8, activos_30: 6, dormidos: 3, venta_total_centavos: 441000, venta_en_riesgo_centavos: 194000 },
      pareto: { puntos: [{ clientes_pct: 10, clientes: 1, venta_pct: 22.7 }], clientes_para_50_pct: 30.0, clientes_para_80_pct: null },
    });
    expect(m.segmentos.map((s) => s.segmento)).toEqual(["campeon", "leal"]);
    expect(m.segmentos[1]).toMatchObject({ ticketCentavos: null, recenciaMedianaDias: null, ventaCentavos: 0 });
    expect(m.resumen).toEqual({ clientesConVenta: 10, clientesRecompra: 8, activos30: 6, dormidos: 3, ventaTotalCentavos: 441000, ventaEnRiesgoCentavos: 194000 });
    expect(m.pareto).toEqual({ puntos: [{ clientesPct: 10, clientes: 1, ventaPct: 22.7 }], clientesPara50Pct: 30, clientesPara80Pct: null });
    expect(mapRfm(null)).toEqual({ segmentos: [], resumen: null, pareto: null });
    expect(mapRfm(JSON.stringify({ resumen: { clientes_con_venta: "3" } })).resumen?.clientesConVenta).toBe(3);
  });

  it("reactivación: alias, consentimiento acotado a la lista cerrada, intervalo nulo, sin llaves de PII", () => {
    const m = mapReactivacion({
      total_elegibles: 4, mostrados: 1, venta_en_juego_centavos: 214000, dormidos: 3, consentimiento: { otorgado: 2, revocado: 1, sin_registro: 1 },
      filas: [{ alias: "ab12cd34", ventas: 3, ultima_venta: "2026-02-01", dias_sin_pedir: 58, intervalo_mediano_dias: null, umbral_dias: 14.0, venta_centavos: 90000, ticket_centavos: 30000, canal_frecuente: "recoger", dormido: true, consentimiento: "raro", prioridad_centavos: 36078 }],
    });
    expect(m.filas[0]).toMatchObject({ alias: "ab12cd34", intervaloMedianoDias: null, umbralDias: 14, consentimiento: "sin_registro", dormido: true, prioridadCentavos: 36078, ultimaVenta: "2026-02-01" });
    expect(m.consentimiento).toEqual({ otorgado: 2, revocado: 1, sinRegistro: 1 });
    expect(Object.keys(m.filas[0]!).join(",")).not.toMatch(/nombre|phone|telefono|customer|address|direccion/i);
    expect(mapReactivacion(undefined)).toMatchObject({ totalElegibles: 0, filas: [] });
  });

  it("intervalo de recompra: bigint/numeric como string; percentiles NULL se conservan como null (nunca 0)", () => {
    expect(mapIntervaloRecompra({ segmento: "global", clientes: "10", intervalos: "13", p25: "10.0", p50: "10.0", p75: "14.0", p90: "16.6" })).toEqual({ segmento: "global", clientes: 10, intervalos: 13, p25: 10, p50: 10, p75: 14, p90: 16.6 });
    expect(mapIntervaloRecompra({ segmento: "dormido", clientes: "1", intervalos: "1", p25: null, p50: null, p75: null, p90: null })).toMatchObject({ segmento: "dormido", p50: null, p90: null });
  });

  it("tortilla: solo los tipos conocidos", () => {
    const m = mapTortilla({ pedidos_con_items: 40, tortilla: [{ tipo: "maiz", renglones: 20, unidades: 30, pedidos: 18 }, { tipo: "integral", renglones: 1, unidades: 1, pedidos: 1 }] });
    expect(m).toEqual({ pedidosConItems: 40, tortilla: [{ tipo: "maiz", renglones: 20, unidades: 30, pedidos: 18 }] });
  });
});

describe("PostgresCfoRepository 095: llamadas, base sin migrar y errores tipados (SAVEPOINT real)", () => {
  const sano: FakeSessionHandler = { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] };
  const jsonRfm = { segmentos: [], resumen: { clientes_con_venta: 1, clientes_recompra: 0, activos_30: 1, dormidos: 0, venta_total_centavos: 100, venta_en_riesgo_centavos: 0 }, pareto: { puntos: [], clientes_para_50_pct: null, clientes_para_80_pct: null } };

  it("con la base migrada: parámetros en orden, jsonb a lectura disponible", async () => {
    const sesion = new AbortAwareFakeSession([{ match: /cfo_clientes_rfm/, respond: () => [{ j: jsonRfm }] }, { match: /cfo_clientes_reactivacion/, respond: () => [{ j: { total_elegibles: 0, filas: [] } }] }, { match: /cfo_intervalo_recompra/, respond: () => [{ segmento: "global", clientes: "0", intervalos: "0", p25: null, p50: null, p75: null, p90: null }] }, { match: /cfo_pedidos_tortilla/, respond: () => [{ j: { pedidos_con_items: 0, tortilla: [] } }] }]);
    const repo = new PostgresCfoRepository(sesion);
    expect((await repo.clientesRfm(P, R)).resumen?.clientesConVenta).toBe(1);
    expect((await repo.clientesReactivacion(P, R, 25)).disponible).toBe(true);
    expect((await repo.clientesIntervaloRecompra(P, R)).filas).toHaveLength(1);
    expect((await repo.pedidosTortilla(P, R)).disponible).toBe(true);
    expect(sesion.calls.some((c) => /cfo_clientes_reactivacion/.test(c))).toBe(true);
  });

  for (const code of ["42883", "42P01", "42703"]) {
    it(`SQLSTATE ${code}: las 4 lecturas dan disponible=false con listas vacías y la sesión SIGUE viva (sin 25P02)`, async () => {
      const sesion = new AbortAwareFakeSession([{ match: /restaurantes\./, respond: () => pgError(code) }, sano]);
      const repo = new PostgresCfoRepository(sesion);
      expect(await repo.clientesRfm(P, R)).toEqual({ disponible: false, segmentos: [], resumen: null, pareto: null });
      expect((await repo.clientesReactivacion(P, R, 50)).disponible).toBe(false);
      expect(await repo.clientesIntervaloRecompra(P, R)).toEqual({ disponible: false, filas: [] });
      expect(await repo.pedidosTortilla(P, R)).toEqual({ disponible: false, pedidosConItems: 0, tortilla: [] });
      expect((await sesion.query("select 1 as vivo")).rows).toEqual([{ vivo: 1 }]);
      expect(sesion.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBeGreaterThanOrEqual(4);
    });
  }

  it("22023 -> CfoParametroInvalidoError y 42501 -> CfoSinAccesoError, y la sesión sigue viva", async () => {
    const s1 = new AbortAwareFakeSession([{ match: /cfo_clientes_reactivacion/, respond: () => pgError("22023", "cfo_clientes_reactivacion: limite invalido") }, sano]);
    await expect(new PostgresCfoRepository(s1).clientesReactivacion(P, R, 50)).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    expect((await s1.query("select 1 as vivo")).rows).toEqual([{ vivo: 1 }]);
    const s2 = new AbortAwareFakeSession([{ match: /cfo_clientes_rfm/, respond: () => pgError("42501") }, sano]);
    await expect(new PostgresCfoRepository(s2).clientesRfm(P, R)).rejects.toBeInstanceOf(CfoSinAccesoError);
    expect((await s2.query("select 1 as vivo")).rows).toEqual([{ vivo: 1 }]);
  });

  it("un error no recuperable (timeout) se propaga: el servicio degrada esa sección", async () => {
    const s = new AbortAwareFakeSession([{ match: /cfo_pedidos_tortilla/, respond: () => pgError("57014", "canceling statement due to statement timeout") }]);
    await expect(new PostgresCfoRepository(s).pedidosTortilla(P, R)).rejects.toThrow(/timeout/);
  });
});

describe("InMemoryCfoRepository 095", () => {
  it("valida rango, alcance y límite como la SQL; con m095=false todo es disponible=false", async () => {
    const repo = new InMemoryCfoRepository({ sucursales: [A, B], permitidas: [A] });
    await expect(repo.clientesRfm({ organizationId: ORG, propertyIds: [A] }, { desde: "2026-09-30", hasta: "2026-09-01" })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(repo.clientesRfm({ organizationId: ORG, propertyIds: [A] }, { desde: "2025-01-01", hasta: "2026-09-01" })).rejects.toThrow(/400/);
    await expect(repo.clientesRfm({ organizationId: ORG, propertyIds: [B] }, R)).rejects.toBeInstanceOf(CfoSinAccesoError);
    await expect(repo.clientesReactivacion(P, R, 0)).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(repo.clientesReactivacion(P, R, 201)).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    const vieja = new InMemoryCfoRepository({ sucursales: [A], migraciones: { m095: false } });
    expect((await vieja.clientesRfm(P, R)).disponible).toBe(false);
    expect((await vieja.clientesReactivacion(P, R, 10)).disponible).toBe(false);
    expect((await vieja.clientesIntervaloRecompra(P, R)).disponible).toBe(false);
    expect((await vieja.pedidosTortilla(P, R)).disponible).toBe(false);
  });
});

describe("armarSeccionesAnalisis", () => {
  const base: EntradaAnalisis = {
    rfm: { disponible: true, segmentos: [], resumen: { clientesConVenta: 3, clientesRecompra: 1, activos30: 2, dormidos: 0, ventaTotalCentavos: 3000, ventaEnRiesgoCentavos: 0 }, pareto: { puntos: [], clientesPara50Pct: 50, clientesPara80Pct: 100 } },
    intervalo: { disponible: true, filas: [{ segmento: "global", clientes: 3, intervalos: 2, p25: null, p50: null, p75: null, p90: null }] },
    reactivacion: { disponible: true, totalElegibles: 0, mostrados: 0, ventaEnJuegoCentavos: 0, dormidos: 0, consentimiento: { otorgado: 0, revocado: 0, sinRegistro: 0 }, filas: [] },
    tortilla: { disponible: true, pedidosConItems: 0, tortilla: [] },
    canasta: { disponible: true, pares: [], totales: [] },
    nombres: new Map(),
    limiteReactivacion: 50,
    multiSucursal: false,
    conError: new Set(),
  };

  it("recompra % = clientes con 2+ ventas / clientes; menos de 5 intervalos => mediana nula (nunca 0); menos de 5 clientes => aviso de puntajes", () => {
    const s = armarSeccionesAnalisis(base);
    expect(s.resumen.datos).toMatchObject({ recompraPct: 33.3, intervaloMedianoDias: null, clientesConVenta: 3 });
    expect(s.segmentos.datos?.pocosClientes).toBe(true);
  });

  it("sin clientes: recompra nula, no 0 %", () => {
    const s = armarSeccionesAnalisis({ ...base, rfm: { ...base.rfm, resumen: { clientesConVenta: 0, clientesRecompra: 0, activos30: 0, dormidos: 0, ventaTotalCentavos: 0, ventaEnRiesgoCentavos: 0 } } });
    expect(s.resumen.datos?.recompraPct).toBeNull();
  });

  it("una sección con error no tumba a las demás y no filtra el mensaje del error", () => {
    const s = armarSeccionesAnalisis({ ...base, conError: new Set(["rfm"]) });
    expect(s.resumen).toMatchObject({ disponible: false, datos: null });
    expect(s.segmentos.disponible).toBe(false);
    expect(s.concentracion.disponible).toBe(false);
    expect(s.reactivacion.disponible).toBe(true);
    expect(s.afinidad.disponible).toBe(true);
  });

  it("lo que no tiene dato honesto se declara «no disponible aún: requiere …» y nunca se simula", () => {
    expect(PENDIENTES_ANALISIS_CLIENTES.length).toBeGreaterThanOrEqual(4);
    for (const p of PENDIENTES_ANALISIS_CLIENTES) expect(p.motivo, p.clave).toMatch(/^No disponible aún: requiere /);
  });
});
