// CFO-02b · TypeScript de los cuatro huecos que cierra la migración 084: frecuentes dormidos, p90 del descuento, `es_venta` en el detalle de pedidos
// y `forma_pago` en el resumen de SoftRestaurant. Cada caso afirma el EFECTO (hallazgo que antes recibía null, base sin la 084 sin romper nada,
// tarjeta separada en el estado de resultados), no solo que un campo exista.
import { describe, expect, it } from "vitest";
import { InMemoryCfoRepository, type DatasetCfoMemoria } from "../src/cfo/repositorio-memoria.ts";
import { CfoParametroInvalidoError, CfoSinAccesoError } from "../src/cfo/repositorio.ts";
import { PostgresCfoRepository, mapDescuentoP90, mapFrecuentesDormidos, mapPedidoDetalle, mapSrResumen } from "../src/cfo/repositorio-postgres.ts";
import { ServicioCfo, type ConsultaCfo } from "../src/cfo/servicio.ts";
import { columnaDe, construirEstadoResultados, lineaDe } from "../src/cfo/estado-resultados.ts";
import { CFO_CONFIG_POR_DEFECTO, type FilaDescuentoP90, type FilaFrecuentesDormidos, type FilaPedidoDetalle, type FilaSrResumen, type FilaVentasDiarias } from "../src/cfo/tipos.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import { SUCURSALES_PM_SINTETICAS, generarDatasetSintetico } from "./fixtures/cfo-pm-sintetico.ts";

const SUC = SUCURSALES_PM_SINTETICAS;
const IDS = SUC.map((s) => s.propertyId);
const [T1, T2] = IDS as [string, string];
const ORG = "00000000-0000-4000-8000-0000000000b1";
const P = { organizationId: ORG, propertyIds: [T1, T2] } as const;
const D = generarDatasetSintetico({ diasRango: 120 });
const Q: ConsultaCfo = { desde: "2026-08-31", hasta: "2026-09-27", comparar: "periodo_anterior", granularidad: "semana" };
const COBERTURA = IDS.map((id) => ({ propertyId: id, primerDia: "2026-05-01", ultimoDia: "2026-09-27", zona: "America/Merida", corte: "01:00:00" }));

function pgError(code: string, message = "boom"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function armar(dataset: Partial<DatasetCfoMemoria> = {}, migraciones?: { m084?: boolean }, permitidas: readonly string[] = IDS, organizacionCompleta = true) {
  const repo = new InMemoryCfoRepository({
    sucursales: IDS,
    permitidas,
    organizacionCompleta,
    migraciones,
    dataset: {
      ventasDiarias: D.ventasDiarias, cortesias: D.cortesias, ventasHora: D.ventasHora, productos: D.productos, agenteDiario: D.agenteDiario, comandasPos: D.comandasPos,
      clientesResumen: D.clientes, agotados: D.agotados, cobertura: COBERTURA, ...dataset,
    },
  });
  const servicio = new ServicioCfo({
    repo, organizationId: "org", alcance: { propertyIds: permitidas, todas: permitidas.length === IDS.length, organizacionCompleta },
    propertyIdsSql: organizacionCompleta ? null : permitidas,
    sucursales: SUC.filter((s) => permitidas.includes(s.propertyId)).map((s) => ({ propertyId: s.propertyId, nombre: s.nombre, slug: s.codigo.toLowerCase() })),
    ahora: new Date("2026-09-28T15:00:00Z"),
  });
  return { repo, servicio };
}

const dormidos = (propertyId: string | null, clientes: number, pedidos: number, extra: Partial<FilaFrecuentesDormidos> = {}): FilaFrecuentesDormidos => ({
  propertyId, alcance: propertyId === null ? "conjunto" : "sucursal", frecuenteN: 3, frecuenteDias: 90, dormidoDias: 30, frecuentes: clientes + 4, frecuentesDormidos: clientes,
  pedidosVentana: pedidos, netaVentanaCentavos: pedidos * 25_000, muestra: [], ...extra,
});
const p90 = (propertyId: string | null, valor: number | null, dias = 90): FilaDescuentoP90 => ({
  propertyId, alcance: propertyId === null ? "conjunto" : "sucursal", dias, desde: "2026-06-02", hasta: "2026-08-30", diasConVenta: valor === null ? 5 : 80, p90Pct: valor,
});

describe("mapeo Postgres de las columnas de la 084", () => {
  it("cfo_clientes_frecuentes_dormidos: bigint como string -> number; la muestra (jsonb objeto o string) trae solo alias hash y números", () => {
    const muestra = [{ alias: "a1b2c3d4", pedidos: 4, dias_sin_pedir: 78, neta_centavos: 40000 }];
    for (const m of [muestra, JSON.stringify(muestra)]) {
      const f = mapFrecuentesDormidos({
        property_id: null, alcance: "conjunto", frecuente_n: 3, frecuente_dias: 90, dormido_dias: 30, frecuentes: "5", frecuentes_dormidos: "4", pedidos_ventana: "13",
        neta_ventana_centavos: "130000", muestra: m,
      });
      expect(f).toEqual({
        propertyId: null, alcance: "conjunto", frecuenteN: 3, frecuenteDias: 90, dormidoDias: 30, frecuentes: 5, frecuentesDormidos: 4, pedidosVentana: 13,
        netaVentanaCentavos: 130000, muestra: [{ alias: "a1b2c3d4", pedidos: 4, diasSinPedir: 78, netaCentavos: 40000 }],
      });
    }
    expect(mapFrecuentesDormidos({ property_id: T1, alcance: "sucursal", frecuente_n: 3, frecuente_dias: 90, dormido_dias: 30, frecuentes: "0", frecuentes_dormidos: "0", pedidos_ventana: "0", neta_ventana_centavos: "0", muestra: "[]" }).muestra).toEqual([]);
    expect(mapFrecuentesDormidos({ property_id: T1, alcance: "sucursal", frecuente_n: 3, frecuente_dias: 90, dormido_dias: 30, frecuentes: "0", frecuentes_dormidos: "0", pedidos_ventana: "0", neta_ventana_centavos: "0", muestra: "{no es json" }).muestra).toEqual([]);
  });

  it("cfo_descuento_p90: numeric como string y NULL ≠ 0 (sin historia suficiente)", () => {
    expect(mapDescuentoP90({ property_id: T1, alcance: "sucursal", dias: 90, desde: "2026-06-02", hasta: "2026-08-30", dias_con_venta: "80", p90_pct: "18.10" }))
      .toEqual({ propertyId: T1, alcance: "sucursal", dias: 90, desde: "2026-06-02", hasta: "2026-08-30", diasConVenta: 80, p90Pct: 18.1 });
    const sin = mapDescuentoP90({ property_id: null, alcance: "conjunto", dias: 90, desde: "2026-06-02", hasta: "2026-08-30", dias_con_venta: "10", p90_pct: null });
    expect(sin.p90Pct).toBeNull();
    expect(sin.diasConVenta).toBe(10);
  });

  it("es_venta del detalle: true/false se conservan y la ausencia (base sin la 084) NO se inventa", () => {
    const base = {
      order_id: "o1", order_number: "1", property_id: T1, dia_negocio: "2026-09-15", hora_local: 13, canal: "domicilio", source: "voice", status: "entregado", payment_method: null, bruta: "100",
      desc_centavos: "0", neta: "100", propina: "0", entregado_min: null, es_compensacion: false, es_reposicion: false, cliente_alias: null, comanda_estado: null,
    };
    expect(mapPedidoDetalle({ ...base, es_venta: true }).esVenta).toBe(true);
    expect(mapPedidoDetalle({ ...base, es_venta: false }).esVenta).toBe(false);
    const sin = mapPedidoDetalle({ ...base, es_venta: null });
    expect("esVenta" in sin).toBe(false);
    expect("esVenta" in mapPedidoDetalle(base)).toBe(false);
  });

  it("forma_pago del resumen de SoftRestaurant: texto en minúsculas o null", () => {
    const fila = { property_id: T1, dia_negocio: "2026-09-15", tipo_servicio: "comedor", tickets: "5", bruta_centavos: "50000", descuento_centavos: "0", cancelado_centavos: "0", propina_centavos: "4000", iva_centavos: "6896", neta_centavos: "50000" };
    expect(mapSrResumen({ ...fila, forma_pago: "tarjeta" }).formaPago).toBe("tarjeta");
    expect(mapSrResumen({ ...fila, forma_pago: null }).formaPago).toBeNull();
    expect(mapSrResumen(fila).formaPago).toBeNull();
  });
});

describe("PostgresCfoRepository: llamadas de la 084", () => {
  it("clientesFrecuentesDormidos y descuentoP90 mandan los parámetros en el orden de la firma SQL; null = umbral de cfo_config", async () => {
    const llamadas: Array<{ sql: string; params: unknown[] }> = [];
    const sesion = {
      query: async (sql: string, params?: unknown[]) => {
        llamadas.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
      exec: async () => undefined,
    };
    const repo = new PostgresCfoRepository(sesion as never);
    await repo.clientesFrecuentesDormidos(P, "2026-09-27", { dormidoDias: 30 });
    await repo.clientesFrecuentesDormidos(P, "2026-09-27", { frecuenteN: 2, frecuenteDias: 60, dormidoDias: 45, muestra: 5 });
    await repo.descuentoP90(P, "2026-08-30", 90);
    const fd = llamadas.filter((l) => /cfo_clientes_frecuentes_dormidos/.test(l.sql));
    expect(fd[0]!.params).toEqual([ORG, [T1, T2], "2026-09-27", null, null, 30, 0]);
    expect(fd[1]!.params).toEqual([ORG, [T1, T2], "2026-09-27", 2, 60, 45, 5]);
    const dp = llamadas.filter((l) => /cfo_descuento_p90/.test(l.sql));
    expect(dp[0]!.params).toEqual([ORG, [T1, T2], "2026-08-30", 90]);
    expect(dp[0]!.sql).toMatch(/to_char\(desde/);
  });

  it("COMPATIBILIDAD: es_venta y forma_pago se leen con to_jsonb(t), no como columnas (una base con solo 081/083 no tiene esas columnas y un select directo daría 42703)", async () => {
    const sqls: string[] = [];
    const sesion = {
      query: async (sql: string) => {
        sqls.push(sql);
        return { rows: [] };
      },
      exec: async () => undefined,
    };
    const repo = new PostgresCfoRepository(sesion as never);
    await repo.pedidosDetalle(P, { desde: "2026-09-01", hasta: "2026-09-30" }, {}, 10, null, 50);
    await repo.srResumenLeer(P, { desde: "2026-09-01", hasta: "2026-09-30" });
    const detalle = sqls.find((s) => /cfo_pedidos_detalle/.test(s))!;
    const sr = sqls.find((s) => /sr_resumen_leer/.test(s))!;
    expect(detalle).toMatch(/to_jsonb\(t\) ->> 'es_venta'/);
    expect(detalle).not.toMatch(/\bt\.es_venta\b/);
    expect(sr).toMatch(/to_jsonb\(t\) ->> 'forma_pago'/);
    expect(sr).not.toMatch(/\bt\.forma_pago\b/);
  });

  it("contra una base SIN la 084 (42883) las dos lecturas nuevas degradan a disponible=false y la sesión sigue viva", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: /cfo_clientes_frecuentes_dormidos|cfo_descuento_p90/, respond: () => pgError("42883", "function does not exist") },
      { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] },
    ]);
    const repo = new PostgresCfoRepository(sesion);
    expect(await repo.clientesFrecuentesDormidos(P, "2026-09-27", { dormidoDias: 30 })).toEqual({ disponible: false, filas: [] });
    expect(await repo.descuentoP90(P, "2026-08-30", 90)).toEqual({ disponible: false, filas: [] });
    expect((await sesion.query("select 1 as vivo")).rows).toEqual([{ vivo: 1 }]);
  });

  it("22023 -> CfoParametroInvalidoError y 42501 -> CfoSinAccesoError también en las funciones nuevas", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: /cfo_clientes_frecuentes_dormidos/, respond: () => pgError("22023", "cfo_clientes_frecuentes_dormidos: parametros invalidos") },
      { match: /cfo_descuento_p90/, respond: () => pgError("42501", "cfo: sin acceso a la sucursal") },
    ]);
    const repo = new PostgresCfoRepository(sesion);
    await expect(repo.clientesFrecuentesDormidos(P, "2026-09-27", { dormidoDias: 3 })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    await expect(repo.descuentoP90(P, "2026-08-30", 90)).rejects.toBeInstanceOf(CfoSinAccesoError);
  });
});

describe("repositorio en memoria: espejo de la 084", () => {
  it("límites de cfo_config (22023), alcance (42501), base sin la 084 y conjunto siempre presente", async () => {
    const { repo } = armar({ frecuentesDormidos: [dormidos(T1, 2, 8), dormidos(T2, 1, 4), dormidos(null, 3, 12)], descuentoP90: [p90(T1, 6), p90(null, 7)] });
    const l = await repo.clientesFrecuentesDormidos({ organizationId: "org", propertyIds: [T1] }, "2026-09-27", { dormidoDias: 30 });
    expect(l.filas.map((f) => f.propertyId)).toEqual([T1, null]);
    for (const mala of [{ frecuenteN: 0 }, { frecuenteN: 21 }, { frecuenteDias: 29 }, { frecuenteDias: 366 }, { dormidoDias: 6 }, { dormidoDias: 366 }, { muestra: 51 }, { muestra: -1 }]) {
      await expect(repo.clientesFrecuentesDormidos({ organizationId: "org", propertyIds: null }, "2026-09-27", { dormidoDias: 30, ...mala })).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    }
    await expect(repo.clientesFrecuentesDormidos({ organizationId: "org", propertyIds: ["ajena"] }, "2026-09-27", { dormidoDias: 30 })).rejects.toBeInstanceOf(CfoSinAccesoError);
    for (const dias of [13, 366]) await expect(repo.descuentoP90({ organizationId: "org", propertyIds: null }, "2026-08-30", dias)).rejects.toBeInstanceOf(CfoParametroInvalidoError);
    expect((await repo.descuentoP90({ organizationId: "org", propertyIds: null }, "2026-08-30", 14)).filas).toHaveLength(2);
    const sin = armar({ frecuentesDormidos: [dormidos(null, 3, 12)] }, { m084: false }).repo;
    expect(await sin.clientesFrecuentesDormidos({ organizationId: "org", propertyIds: null }, "2026-09-27", { dormidoDias: 30 })).toEqual({ disponible: false, filas: [] });
    expect(await sin.descuentoP90({ organizationId: "org", propertyIds: null }, "2026-08-30", 90)).toEqual({ disponible: false, filas: [] });
  });

  it("sin sembrar nada las lecturas nuevas son vacías pero disponibles (la base sí tiene la 084, solo que no hay datos)", async () => {
    const { repo } = armar();
    expect(await repo.clientesFrecuentesDormidos({ organizationId: "org", propertyIds: null }, "2026-09-27", { dormidoDias: 30 })).toEqual({ disponible: true, filas: [] });
  });

  it("importar SoftRestaurant parte el resumen por forma de pago (minúsculas) y la suma por día y servicio no cambia", async () => {
    const { repo } = armar();
    const r = await repo.srImportar({
      organizationId: "org", propertyId: T1, huella: "e".repeat(64), tipo: "resumen_servicio", nombreArchivo: "v.csv",
      renglones: [
        { dia_negocio: "2026-09-10", tipo_servicio: "comedor", forma_pago: "Efectivo", tickets: 10, bruta_centavos: 100000, neta_centavos: 95000 },
        { dia_negocio: "2026-09-10", tipo_servicio: "comedor", forma_pago: "TARJETA", tickets: 5, bruta_centavos: 50000, neta_centavos: 50000 },
        { dia_negocio: "2026-09-10", tipo_servicio: "domicilio", tickets: 3, bruta_centavos: 9000, neta_centavos: 9000 },
      ],
    });
    expect(r.aceptados).toBe(3);
    const l = await repo.srResumenLeer({ organizationId: "org", propertyIds: [T1] }, { desde: "2026-09-10", hasta: "2026-09-10" });
    expect(l.filas.map((f) => `${f.tipoServicio}:${f.formaPago}`).sort()).toEqual(["comedor:efectivo", "comedor:tarjeta", "domicilio:null"]);
    expect(l.filas.filter((f) => f.tipoServicio === "comedor").reduce((s, f) => s + f.netaCentavos, 0)).toBe(145000);
  });

  it("el filtro es_venta del detalle respeta esVenta y la fila lo devuelve", async () => {
    const fila = (n: number, esVenta?: boolean): FilaPedidoDetalle & { horaLocal: number; esVenta?: boolean } => ({
      orderId: `o${n}`, orderNumber: String(n), propertyId: T1, diaNegocio: "2026-09-15", horaLocal: 12, canal: "domicilio", source: "voice", status: esVenta === false ? "cancelado" : "entregado", paymentMethod: null,
      brutaCentavos: 100, descCentavos: 0, netaCentavos: 100, propinaCentavos: 0, entregadoMin: null, esCompensacion: false, esReposicion: false, clienteAlias: null, comandaEstado: null,
      ...(esVenta === undefined ? {} : { esVenta }),
    });
    const { repo } = armar({ pedidosDetalle: [fila(3, true), fila(2, false), fila(1, true)] });
    const solo = await repo.pedidosDetalle({ organizationId: "org", propertyIds: null }, { desde: "2026-09-01", hasta: "2026-09-30" }, { es_venta: true }, 10, null, 50);
    expect(solo.filas.map((f) => f.orderId)).toEqual(["o3", "o1"]);
    expect(solo.filas.every((f) => f.esVenta === true)).toBe(true);
    const no = await repo.pedidosDetalle({ organizationId: "org", propertyIds: null }, { desde: "2026-09-01", hasta: "2026-09-30" }, { es_venta: false }, 10, null, 50);
    expect(no.filas.map((f) => [f.orderId, f.esVenta])).toEqual([["o2", false]]);
  });
});

describe("servicio: el resumen consume los huecos", () => {
  it("frecuentes dormidos: el hallazgo que antes recibía null aparece con la cifra, la ventana y el umbral reales, y respeta el alcance", async () => {
    const { servicio, repo } = armar({ frecuentesDormidos: [dormidos(T1, 7, 4000, { frecuenteDias: 60, dormidoDias: 45 }), dormidos(T2, 0, 0), dormidos(null, 7, 4000)] });
    const r = await servicio.resumen(Q);
    const h = r.hallazgos.filter((x) => x.tipo === "frecuentes_dormidos");
    expect(h).toHaveLength(1);
    expect(h[0]!.propertyId).toBe(T1);
    expect(h[0]!.titulo).toContain("7 clientes frecuentes de");
    expect(h[0]!.titulo).toContain("45 días o más sin pedir");
    expect(h[0]!.comparacion).toBe("Hicieron 4,000 pedidos en los últimos 60 días.");
    expect(h[0]!.fuentes).toEqual(["cfo_clientes_frecuentes_dormidos"]);
    expect(repo.llamadas.get("clientesFrecuentesDormidos")).toBe(1);
    expect(r.bloques).toEqual({ ventas: true, clientes: true, captura: true });
  });

  it("p90 del descuento: una sucursal con descuento 1.6 % y p90 histórico de 1 % dispara «descuento fuera de rango»; sin p90 (null) no", async () => {
    const con = await armar({ descuentoP90: [p90(T1, 1)] }).servicio.resumen(Q);
    const h = con.hallazgos.find((x) => x.tipo === "descuento_fuera_rango" && x.propertyId === T1);
    expect(h).toBeDefined();
    expect(h!.comparacion).toContain("Su límite es 1");
    const sin = await armar({ descuentoP90: [p90(T1, null)] }).servicio.resumen(Q);
    expect(sin.hallazgos.find((x) => x.tipo === "descuento_fuera_rango" && x.propertyId === T1)).toBeUndefined();
    const sinFilas = await armar().servicio.resumen(Q);
    expect(sinFilas.hallazgos.find((x) => x.tipo === "descuento_fuera_rango")).toBeUndefined();
  });

  it("base SIN la 084: ni hallazgo ni aviso de bloque caído; las cifras de 081-083 salen completas", async () => {
    const { servicio } = armar({ frecuentesDormidos: [dormidos(T1, 7, 4000)], descuentoP90: [p90(T1, 1)] }, { m084: false });
    const r = await servicio.resumen(Q);
    expect(r.hallazgos.find((x) => x.tipo === "frecuentes_dormidos")).toBeUndefined();
    expect(r.hallazgos.find((x) => x.tipo === "descuento_fuera_rango")).toBeUndefined();
    expect(r.bloques).toEqual({ ventas: true, clientes: true, captura: true });
    expect(r.kpis.total.sumas.pedidos).toBeGreaterThan(1000);
  });

  it("un fallo no fatal en una lectura nueva no tumba el resumen ni marca el bloque «clientes» como caído", async () => {
    const { servicio, repo } = armar({ frecuentesDormidos: [dormidos(T1, 7, 4000)] });
    repo.clientesFrecuentesDormidos = async () => {
      throw new Error("timeout");
    };
    const r = await servicio.resumen(Q);
    expect(r.hallazgos.find((x) => x.tipo === "frecuentes_dormidos")).toBeUndefined();
    expect(r.bloques.clientes).toBe(true);
  });

  it("un 42501 en la lectura nueva SÍ corta (autorización nunca se degrada)", async () => {
    const { servicio, repo } = armar();
    repo.descuentoP90 = async () => {
      throw new CfoSinAccesoError();
    };
    await expect(servicio.resumen(Q)).rejects.toBeInstanceOf(CfoSinAccesoError);
  });

  it("periodos largos (> 62 días) no piden el p90 histórico; el de frecuentes dormidos sí se pide", async () => {
    const { servicio, repo } = armar();
    await servicio.resumen({ ...Q, desde: "2026-05-01", hasta: "2026-09-27" });
    expect(repo.llamadas.get("descuentoP90")).toBeUndefined();
    expect(repo.llamadas.get("clientesFrecuentesDormidos")).toBe(1);
  });

  it("admin acotado: solo ve el hallazgo de sus sucursales", async () => {
    const { servicio } = armar({ frecuentesDormidos: [dormidos(T1, 7, 4000), dormidos(T2, 9, 5000), dormidos(null, 16, 9000)] }, undefined, [T1], false);
    const r = await servicio.resumen(Q);
    const h = r.hallazgos.filter((x) => x.tipo === "frecuentes_dormidos");
    expect(h.map((x) => x.propertyId)).toEqual([T1]);
  });
});

describe("estado de resultados: tarjeta separada por forma de pago (084)", () => {
  const rango = { desde: "2026-09-01", hasta: "2026-09-01" };
  const venta: FilaVentasDiarias = {
    propertyId: T1, diaNegocio: "2026-09-01", canal: "domicilio", source: "whatsapp", paymentMethod: "efectivo", pedidos: 1, brutaCentavos: 40000, descPromoCentavos: 0, descCompCentavos: 0,
    netaCentavos: 40000, propinaCentavos: 0, cancelados: 0, canceladosCentavos: 0, noRecogidos: 0, noRecogidosCentavos: 0, reposiciones: 0, reposicionUnidades: 0, entregados: 1, entregaMinSuma: 40, entregaTarde: 0,
  };
  const sr = (tipo: FilaSrResumen["tipoServicio"], forma: string | null, neta: number): FilaSrResumen => ({
    propertyId: T1, diaNegocio: "2026-09-01", tipoServicio: tipo, formaPago: forma, tickets: 1, brutaCentavos: neta, descuentoCentavos: 0, canceladoCentavos: 0, propinaCentavos: 0, ivaCentavos: null, netaCentavos: neta,
  });
  const pyl = (srResumen: FilaSrResumen[]) =>
    columnaDe(
      construirEstadoResultados({
        ventas: [venta], cortesias: [], costosAgente: [], costosCapturados: [], config: { ...CFO_CONFIG_POR_DEFECTO, comisionTerminalPct: 2.5 }, granularidad: "mes", rango,
        alcance: { propertyIds: [T1], todas: true, organizacionCompleta: true }, sucursales: [{ propertyId: T1, nombre: "T1" }], srResumen,
      }).acumulado,
      T1,
    )!;

  it("con forma de pago en TODOS los renglones la comisión de terminal sale de la tarjeta (2.5 % de $2,000 = $50), como estimado", () => {
    const col = pyl([sr("domicilio", "efectivo", 100_000), sr("comedor", "tarjeta", 150_000), sr("comedor", "tarjeta de crédito", 50_000)]);
    const l = lineaDe(col, "comision_terminal");
    expect(l.cifra.valor).toBe(5000);
    expect(l.cifra.confianza).toBe("estimado");
    expect(l.faltaCaptura).toBe(false);
  });

  it("con una MEZCLA (un renglón sin forma de pago) la tarjeta queda sin dato: la comisión sigue pendiente, no se subestima", () => {
    const col = pyl([sr("domicilio", null, 100_000), sr("comedor", "tarjeta", 150_000)]);
    expect(lineaDe(col, "comision_terminal").faltaCaptura).toBe(true);
    expect(lineaDe(col, "comision_terminal").cifra.valor).toBeNull();
  });

  it("sin forma de pago en ningún renglón (archivo sin esa columna o base sin la 084) sigue pendiente", () => {
    const col = pyl([sr("domicilio", null, 100_000), sr("comedor", null, 150_000)]);
    expect(lineaDe(col, "comision_terminal").faltaCaptura).toBe(true);
  });
});
