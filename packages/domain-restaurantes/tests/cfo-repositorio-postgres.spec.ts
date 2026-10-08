// CFO-05 · adaptador Postgres del CFO contra un doble de sesión que reproduce la semántica REAL de la transacción única del request
// (AbortAwareFakeSession: tras un error la sesión queda abortada hasta ROLLBACK TO SAVEPOINT). Cada caso afirma el EFECTO:
//  - node-postgres entrega bigint y numeric como STRING y el adaptador los convierte con numericoSql (nunca queda un string en la fila);
//  - NULL ≠ 0 (costo de Meta con 0 eventos, LLM en demos, centavos sin tipo de cambio, comisión de terminal);
//  - base sin migrar (42883/42P01/42703): lecturas -> disponible=false y la sesión SIGUE viva; escrituras -> CfoNoDisponibleError;
//  - 22023 -> CfoParametroInvalidoError y 42501 -> CfoSinAccesoError (la sesión también sigue viva).
// La prueba contra Postgres real (rol authenticated) está en apps/api/tests/restaurantes-cfo-real-postgres.spec.ts (opt-in).
import { describe, expect, it } from "vitest";
import { CfoNoDisponibleError, CfoParametroInvalidoError, CfoSinAccesoError } from "../src/cfo/repositorio.ts";
import {
  PostgresCfoRepository,
  anulable,
  entero,
  fecha,
  mapAgenteDiario,
  mapAgotado,
  mapCanasta,
  mapClientesResumen,
  mapCohorte,
  mapColonia,
  mapConfig,
  mapPedidoDetalle,
  mapPercentiles,
  mapSrResumen,
  mapVentasDiarias,
} from "../src/cfo/repositorio-postgres.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000a2";
const P = { organizationId: ORG, propertyIds: [A, B] } as const;
const R = { desde: "2026-09-01", hasta: "2026-09-30" } as const;

function pgError(code: string, message = "boom"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("conversión de tipos: bigint y numeric llegan como string", () => {
  it("entero/anulable convierten strings, respetan NULL y rechazan basura", () => {
    expect(entero("12345678901")).toBe(12345678901);
    expect(entero(7)).toBe(7);
    expect(entero(null)).toBe(0);
    expect(anulable("100.99")).toBe(100.99);
    expect(anulable(null)).toBeNull();
    expect(anulable("")).toBeNull();
    expect(() => entero("abc")).toThrow(TypeError);
  });

  it("fecha tolera string y Date (componentes locales, como interpreta pg un date)", () => {
    expect(fecha("2026-09-15")).toBe("2026-09-15");
    expect(fecha(new Date(2026, 8, 15))).toBe("2026-09-15");
  });

  it("cfo_ventas_diarias: todos los contadores y montos son number; los minutos conservan 2 decimales", () => {
    const f = mapVentasDiarias({
      property_id: A, dia_negocio: "2026-09-15", canal: "domicilio", source: "whatsapp", payment_method: null, pedidos: "40", bruta_centavos: "1200050", desc_promo_centavos: "20000",
      desc_comp_centavos: "0", neta_centavos: "1180050", propina_centavos: "5000", cancelados: "2", cancelados_centavos: "30000", no_recogidos: "0", no_recogidos_centavos: "0",
      reposiciones: "1", reposicion_unidades: "3", entregados: "38", entrega_min_suma: "1234.57", entrega_tarde: "4",
    });
    expect(f).toMatchObject({ pedidos: 40, brutaCentavos: 1200050, netaCentavos: 1180050, entregaMinSuma: 1234.57, paymentMethod: null, diaNegocio: "2026-09-15" });
    for (const [k, v] of Object.entries(f)) if (k !== "propertyId" && k !== "diaNegocio" && k !== "canal" && k !== "source" && k !== "paymentMethod") expect(typeof v, k).toBe("number");
  });

  it("cfo_pedidos_detalle: bruta/desc/neta/propina -> *Centavos, alias nulo sin cliente, sin llaves de PII", () => {
    const f = mapPedidoDetalle({
      order_id: "o1", order_number: "12345678901", property_id: A, dia_negocio: "2026-09-15", hora_local: 13, canal: "domicilio", source: "voice", status: "entregado", payment_method: "tarjeta",
      bruta: "25000", desc_centavos: "2000", neta: "23000", propina: "1500", entregado_min: "41.50", es_compensacion: false, es_reposicion: false, cliente_alias: null, comanda_estado: null, cursor_pagina: "x",
    });
    expect(f).toMatchObject({ brutaCentavos: 25000, descCentavos: 2000, netaCentavos: 23000, propinaCentavos: 1500, entregadoMin: 41.5, orderNumber: "12345678901", clienteAlias: null });
    expect(Object.keys(f).join(",")).not.toMatch(/phone|telefono|nombre|direccion|address|customer(?!Alias)/i);
  });

  it("cfo_clientes_resumen: columnas de 082 (clientes_varias_sucursales, churn, pedidos sin cliente) y NULL del conjunto", () => {
    const f = mapClientesResumen({
      property_id: null, alcance: "conjunto", clientes_con_pedido: "165", nuevos: "40", recurrentes: "125", activos: "100", dormidos: "30", perdidos: "35", frecuentes: "20", multi_sucursal: "15",
      clientes_varias_sucursales: "14", recuperados: "3", recuperados_por_campana: "1", activos_al_inicio: "90", pasan_a_perdidos: "9", dias_entre_pedidos_mediana: "12.5",
      neta_top10pct_centavos: "500000", neta_total_centavos: "1500000", pedidos_por_cliente_12m_promedio: "3.25", pedidos_con_cliente: "400", pedidos_sin_cliente: "12",
    });
    expect(f).toMatchObject({ propertyId: null, alcance: "conjunto", multiSucursal: 15, clientesVariasSucursales: 14, activosAlInicio: 90, pasanAPerdidos: 9, pedidosConCliente: 400, pedidosSinCliente: 12, diasEntrePedidosMediana: 12.5, pedidosPorCliente12mPromedio: 3.25 });
    const sucursal = mapClientesResumen({ property_id: A, alcance: "sucursal", clientes_con_pedido: "1", nuevos: "0", recurrentes: "1", activos: "1", dormidos: "0", perdidos: "0", frecuentes: "0", multi_sucursal: null, clientes_varias_sucursales: null,
      recuperados: "0", recuperados_por_campana: "0", activos_al_inicio: "0", pasan_a_perdidos: "0", dias_entre_pedidos_mediana: null, neta_top10pct_centavos: "0", neta_total_centavos: "0", pedidos_por_cliente_12m_promedio: null, pedidos_con_cliente: "1", pedidos_sin_cliente: "0" });
    expect(sucursal.multiSucursal).toBeNull();
    expect(sucursal.clientesVariasSucursales).toBeNull();
    expect(sucursal.diasEntrePedidosMediana).toBeNull();
  });

  it("cohortes (observables_30/60/90), percentiles (alcance/entregados) y colonias (distancia_km)", () => {
    expect(mapCohorte({ property_id: null, mes_cohorte: "2026-08", clientes: "50", con_recompra_30: "10", con_recompra_60: "15", con_recompra_90: "20", observables_30: "50", observables_60: "40", observables_90: "10" }))
      .toMatchObject({ propertyId: null, observables30: 50, observables60: 40, observables90: 10, conRecompra90: 20 });
    expect(mapPercentiles({ property_id: null, alcance: "conjunto", entregados: "300", p50_min: "38.00", p90_min: "61.50" })).toEqual({ propertyId: null, alcance: "conjunto", entregados: 300, p50Min: 38, p90Min: 61.5 });
    expect(mapColonia({ property_id: A, colonia: "Centro", pedidos: "30", neta_centavos: "300000", entregados: "28", min_suma: "1120.50", clientes: "12", sucursal_cercana_id: B, distancia_km: "2.35" }))
      .toMatchObject({ pedidos: 30, minSuma: 1120.5, distanciaKm: 2.35, sucursalCercanaId: B });
    expect(mapColonia({ property_id: A, colonia: "(otras)", pedidos: "5", neta_centavos: "1", entregados: "0", min_suma: "0", clientes: "5", sucursal_cercana_id: null, distancia_km: null }).distanciaKm).toBeNull();
  });

  it("agente diario: NULL ≠ 0 (Meta sin eventos, LLM en demos, centavos sin tipo de cambio) y mxn_por_usd", () => {
    const sinMedir = mapAgenteDiario({
      property_id: A, dia_negocio: "2026-09-15", wa_conversaciones_nuevas: "10", wa_con_pedido: "4", wa_con_handoff: "1", wa_handoffs: "1", voz_llamadas: "5", voz_pedido_creado: "2", voz_escalado: "1",
      voz_abandonado: "2", costo_voz_micro_usd: "750000", costo_telefonia_micro_usd: "100000", costo_meta_micro_usd: null, costo_llm_micro_usd: null, costo_voz_centavos: null,
      costo_telefonia_centavos: null, costo_meta_centavos: null, costo_llm_centavos: null, meta_eventos: "0", mxn_por_usd: null,
    });
    expect(sinMedir.costoMetaMicroUsd).toBeNull();
    expect(sinMedir.costoLlmMicroUsd).toBeNull();
    expect(sinMedir.costoVozCentavos).toBeNull();
    expect(sinMedir.mxnPorUsd).toBeNull();
    expect(sinMedir.costoVozMicroUsd).toBe(750000);
    const medido = mapAgenteDiario({ ...{ property_id: null, dia_negocio: "2026-09-15" }, wa_conversaciones_nuevas: "0", wa_con_pedido: "0", wa_con_handoff: "0", wa_handoffs: "0", voz_llamadas: "0", voz_pedido_creado: "0",
      voz_escalado: "0", voz_abandonado: "0", costo_voz_micro_usd: "0", costo_telefonia_micro_usd: "0", costo_meta_micro_usd: "0", costo_llm_micro_usd: "250000", costo_voz_centavos: "0",
      costo_telefonia_centavos: "0", costo_meta_centavos: "0", costo_llm_centavos: "45", meta_eventos: "3", mxn_por_usd: "18.0000" });
    expect(medido.costoMetaMicroUsd).toBe(0); // 0 eventos medidos con costo 0 es DISTINTO de «no medido»
    expect(medido.costoLlmCentavos).toBe(45);
    expect(medido.mxnPorUsd).toBe(18);
    expect(medido.propertyId).toBeNull();
  });

  it("agotados: disponible=false con agotado_hasta NULL es agotado indefinido; ranking lo pone el servicio", () => {
    const f = mapAgotado({ property_id: A, product_id: "p1", nombre: "Pastor", agotado_hasta: null, disponible: false, precio_centavos: "4200", unidades_28d: "56", dias_con_venta_28d: "28" });
    expect(f).toEqual({ propertyId: A, productId: "p1", nombre: "Pastor", disponible: false, agotadoHasta: null, unidades28d: 56, diasConVenta28d: 28, precioListaCentavos: 4200, rankingUnidades: null });
    expect(mapAgotado({ property_id: A, product_id: "p2", nombre: "X", agotado_hasta: "2026-10-09", disponible: true, precio_centavos: null, unidades_28d: "0", dias_con_venta_28d: "0" })).toMatchObject({ disponible: true, agotadoHasta: "2026-10-09", precioListaCentavos: null });
  });

  it("cfo_config: numeric(5,2) llega como string; comision_terminal_pct NULL = captura pendiente (no 0)", () => {
    const c = mapConfig({
      frecuente_n: 3, frecuente_dias: 90, activo_dias: 60, perdido_dias: 120, promesa_min: 50, iva_pct: "16.00", caida_pct: "15.00", ticket_baja_pct: "10.00", cancelacion_x_mediana: "2.00",
      descuento_max_pct: "8.00", costo_agente_alza_pct: "30.00", cierre_baja_pp: "10.00", entrega_p90_max_min: 60, sr_cuadre_verde_pct: "1.00", sr_cuadre_ambar_pct: "3.00",
      sr_cuadre_verde_centavos: "5000", comision_terminal_pct: null,
    });
    expect(c.ivaPct).toBe(16);
    expect(c.srCuadreVerdeCentavos).toBe(5000);
    expect(c.comisionTerminalPct).toBeNull();
    expect(mapConfig({ comision_terminal_pct: "2.50" }).comisionTerminalPct).toBe(2.5);
  });

  it("SR resumen: iva NULL (algún renglón sin IVA) se conserva como NULL", () => {
    const f = mapSrResumen({ property_id: A, dia_negocio: "2026-09-15", tipo_servicio: "domicilio", tickets: "20", bruta_centavos: "300000", descuento_centavos: "0", cancelado_centavos: "0", propina_centavos: "100", iva_centavos: null, neta_centavos: "290000" });
    expect(f).toMatchObject({ tickets: 20, ivaCentavos: null, formaPago: null, netaCentavos: 290000 });
  });

  it("canasta: jsonb a pares, totales con pedidosConProducto por sucursal y tickets; tolera string y vacío", () => {
    const j = {
      pares: [{ property_id: A, producto_a: "a", producto_b: "b", pedidos_juntos: 7 }],
      productos: [{ property_id: A, producto_ref: "a", pedidos_con_producto: 20 }, { property_id: A, producto_ref: "b", pedidos_con_producto: 15 }],
      totales: [{ property_id: A, pedidos_totales: 100 }],
      tickets: [{ property_id: A, n_productos: 2, pedidos: 40, neta_centavos: 800000 }],
    };
    for (const entrada of [j, JSON.stringify(j)]) {
      const c = mapCanasta(entrada);
      expect(c.pares).toEqual([{ propertyId: A, productoA: "a", productoB: "b", pedidosJuntos: 7 }]);
      expect(c.totales).toEqual([{ propertyId: A, pedidosTotales: 100, pedidosConProducto: { a: 20, b: 15 } }]);
      expect(c.tickets).toEqual([{ propertyId: A, nProductos: 2, pedidos: 40, netaCentavos: 800000 }]);
    }
    expect(mapCanasta(null)).toEqual({ pares: [], totales: [], tickets: [] });
  });
});

describe("PostgresCfoRepository: llamadas SQL y parámetros", () => {
  it("ventasDiarias manda org, sucursales (arreglo), rango y promesa; null = todas las permitidas", async () => {
    const llamadas: Array<{ sql: string; params: unknown[] }> = [];
    const sesion = {
      query: async (sql: string, params?: unknown[]) => {
        llamadas.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
      exec: async () => undefined,
    };
    const repo = new PostgresCfoRepository(sesion as never);
    await repo.ventasDiarias(P, R, 45);
    await repo.ventasDiarias({ organizationId: ORG, propertyIds: null }, R, 50);
    const consultas = llamadas.filter((l) => /cfo_ventas_diarias/.test(l.sql));
    expect(consultas[0]!.params).toEqual([ORG, [A, B], "2026-09-01", "2026-09-30", 45]);
    expect(consultas[1]!.params[1]).toBeNull();
    expect(consultas[0]!.sql).toMatch(/to_char\(dia_negocio/);
  });

  it("pedidosDetalle pide limite+1 y calcula el cursor de la página siguiente solo si hay más", async () => {
    const fila = (n: number) => ({
      order_id: `o${n}`, order_number: String(n), property_id: A, dia_negocio: "2026-09-15", hora_local: 12, canal: "domicilio", source: "voice", status: "entregado", payment_method: null, bruta: "100",
      desc_centavos: "0", neta: "100", propina: "0", entregado_min: null, es_compensacion: false, es_reposicion: false, cliente_alias: "abcd1234", comanda_estado: null, cursor_pagina: `2026-09-15|${n}`,
    });
    let pedidas: unknown[] = [];
    const sesion = {
      query: async (_sql: string, params?: unknown[]) => {
        pedidas = params ?? [];
        return { rows: [fila(3), fila(2), fila(1)] };
      },
      exec: async () => undefined,
    };
    const repo = new PostgresCfoRepository(sesion as never);
    const mas = await repo.pedidosDetalle(P, R, { canal: "domicilio", es_venta: true }, 2, null, 50);
    expect(pedidas[5]).toBe(3);
    expect(JSON.parse(pedidas[4] as string)).toEqual({ canal: "domicilio", es_venta: true });
    expect(mas.filas.map((f) => f.orderId)).toEqual(["o3", "o2"]);
    expect(mas.cursorSiguiente).toBe("2026-09-15|2");
    const ultima = await repo.pedidosDetalle(P, R, {}, 3, null, 50);
    expect(ultima.filas).toHaveLength(3);
    expect(ultima.cursorSiguiente).toBeNull();
  });
});

describe("PostgresCfoRepository: base sin migrar y errores tipados (SAVEPOINT real)", () => {
  const sinFuncion = (re: RegExp): FakeSessionHandler => ({ match: re, respond: () => pgError("42883", "function does not exist") });
  const sano: FakeSessionHandler = { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] };

  for (const code of ["42883", "42P01", "42703"]) {
    it(`lectura con SQLSTATE ${code}: disponible=false, filas vacías y la sesión SIGUE viva (sin 25P02)`, async () => {
      const sesion = new AbortAwareFakeSession([{ match: /cfo_ventas_diarias/, respond: () => pgError(code) }, sano]);
      const repo = new PostgresCfoRepository(sesion);
      const l = await repo.ventasDiarias(P, R, 50);
      expect(l).toEqual({ disponible: false, filas: [] });
      expect((await sesion.query("select 1 as vivo")).rows).toEqual([{ vivo: 1 }]);
      expect(sesion.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    });
  }

  it("TODAS las lecturas degradan igual contra la base vieja (sin 081/082/083) y nunca lanzan", async () => {
    const sesion = new AbortAwareFakeSession([sinFuncion(/restaurantes\./), sano]);
    const repo = new PostgresCfoRepository(sesion);
    const ok = { disponible: false, filas: [] };
    expect(await repo.cortesias(P, R)).toEqual(ok);
    expect(await repo.ventasHora(P, R)).toEqual(ok);
    expect(await repo.productos(P, R)).toEqual(ok);
    expect(await repo.cobertura(P)).toEqual(ok);
    expect(await repo.clientesResumen(P, R, { frecuenteN: 3, frecuenteDias: 90, activoDias: 60, perdidoDias: 120 })).toEqual(ok);
    expect(await repo.clientesCohortes(P, 6)).toEqual(ok);
    expect(await repo.clientesAltas(P, R)).toEqual(ok);
    expect(await repo.clientesSegmentoHora(P, R, { frecuenteN: 3, frecuenteDias: 90 })).toEqual(ok);
    expect(await repo.agenteDiario(P, R)).toEqual(ok);
    expect(await repo.escalacionesHora(P, R)).toEqual(ok);
    expect(await repo.entregas(P, R, 50)).toEqual(ok);
    expect(await repo.entregasPercentiles(P, R)).toEqual(ok);
    expect(await repo.repartidores(P, R, 50)).toEqual(ok);
    expect(await repo.colonias(P, R, 5)).toEqual(ok);
    expect(await repo.comandasPos(P, R)).toEqual(ok);
    expect(await repo.agotados(P)).toEqual(ok);
    expect(await repo.costosLeer(P, "2026-09-01", "2026-09-01")).toEqual(ok);
    expect(await repo.costoHistorial(ORG, A, "2026-09-01", "nomina")).toEqual(ok);
    expect(await repo.srResumenLeer(P, R)).toEqual(ok);
    expect(await repo.srLotes(P, 50)).toEqual(ok);
    expect(await repo.srCobertura(P)).toEqual(ok);
    expect(await repo.canastaPares(P, R, 50)).toEqual({ disponible: false, pares: [], totales: [], tickets: [] });
    expect(await repo.pedidosDetalle(P, R, {}, 50, null, 50)).toEqual({ disponible: false, filas: [], cursorSiguiente: null });
    const cfg = await repo.configLeer(ORG);
    expect(cfg.disponible).toBe(false);
    expect(cfg.configurada).toBe(false);
    expect((await sesion.query("select 1 as vivo")).rows).toEqual([{ vivo: 1 }]);
  });

  it("escrituras contra la base sin migrar -> CfoNoDisponibleError (503), sin dejar la sesión abortada", async () => {
    const sesion = new AbortAwareFakeSession([sinFuncion(/restaurantes\./), sano]);
    const repo = new PostgresCfoRepository(sesion);
    await expect(repo.configGuardar(ORG, { iva_pct: 16 })).rejects.toBeInstanceOf(CfoNoDisponibleError);
    await expect(repo.costoGuardar({ organizationId: ORG, propertyId: A, mes: "2026-09-01", concepto: "renta", montoCentavos: 1, pct: null, nota: null })).rejects.toBeInstanceOf(CfoNoDisponibleError);
    await expect(repo.srImportar({ organizationId: ORG, propertyId: A, huella: "a".repeat(64), tipo: "cuentas", nombreArchivo: "x.csv", renglones: [{}] })).rejects.toBeInstanceOf(CfoNoDisponibleError);
    await expect(repo.registrarExportacion({ organizationId: ORG, propertyIds: null, vista: "resumen", formato: "xlsx", desde: R.desde, hasta: R.hasta })).rejects.toBeInstanceOf(CfoNoDisponibleError);
    expect((await sesion.query("select 1 as vivo")).rows).toEqual([{ vivo: 1 }]);
  });

  it("22023 -> CfoParametroInvalidoError (con el mensaje de la base) y 42501 -> CfoSinAccesoError; ambos dejan la sesión viva", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: /cfo_ventas_diarias/, respond: () => pgError("22023", "cfo: el rango maximo es de 400 dias") },
      { match: /cfo_ventas_hora/, respond: () => pgError("42501", "cfo: sin acceso a la sucursal") },
      { match: /cfo_config_guardar/, respond: () => pgError("22023", "cfo_config_guardar: iva_pct fuera de rango (0..30)") },
      { match: /sr_importar/, respond: () => pgError("42501", "sr_importar: requiere un usuario autenticado") },
      sano,
    ]);
    const repo = new PostgresCfoRepository(sesion);
    await expect(repo.ventasDiarias(P, R, 50)).rejects.toThrow(new CfoParametroInvalidoError("cfo: el rango maximo es de 400 dias"));
    await expect(repo.ventasHora(P, R)).rejects.toBeInstanceOf(CfoSinAccesoError);
    await expect(repo.configGuardar(ORG, { iva_pct: 99 })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(repo.srImportar({ organizationId: ORG, propertyId: A, huella: "a".repeat(64), tipo: "cuentas", nombreArchivo: "x.csv", renglones: [{}] })).rejects.toBeInstanceOf(CfoSinAccesoError);
    expect((await sesion.query("select 1 as vivo")).rows).toEqual([{ vivo: 1 }]);
  });

  it("un error inesperado (p. ej. 57014 timeout) se repropaga tal cual y NO se disfraza de «sin migrar»", async () => {
    const sesion = new AbortAwareFakeSession([{ match: /cfo_ventas_diarias/, respond: () => pgError("57014", "canceling statement due to statement timeout") }, sano]);
    const repo = new PostgresCfoRepository(sesion);
    await expect(repo.ventasDiarias(P, R, 50)).rejects.toMatchObject({ code: "57014" });
    expect((await sesion.query("select 1 as vivo")).rows).toEqual([{ vivo: 1 }]);
  });
});
