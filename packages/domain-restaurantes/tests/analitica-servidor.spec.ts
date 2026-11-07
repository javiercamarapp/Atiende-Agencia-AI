// Analítica del dueño (F7) · adaptador Postgres (SAVEPOINT / base sin migrar / SQLSTATE tipados), barrido de alertas (ETA alto y «¿ya salió?») por el
// productor compartido y gancho de combo. Con AbortAwareFakeSession (semántica real de transacción abortada). Datos sintéticos.
import { describe, expect, it } from "vitest";
import { AnaliticaNoDisponibleError, AnaliticaParametroInvalidoError, AnaliticaSinAccesoError } from "../src/analitica/index.ts";
import { PostgresAnaliticaRepository, mapDemanda, mapRatios, mapZona } from "../src/analitica/repositorio-postgres.ts";
import { barrerAlertasAnalitica, claveDeAlerta, consultarComboSugerido, listarCandidatosAnalitica } from "../src/analitica/servidor.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-00000000b001";
const PROP = "00000000-0000-0000-0000-00000000c001";
const O1 = "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2d01";
const O2 = "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2d02";
const CONV = "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2e01";
const PARAMS = { organizationId: ORG, propertyIds: [PROP], desde: "2026-09-01", hasta: "2026-09-30" } as const;

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("mapeo de filas (node-postgres entrega bigint como string)", () => {
  it("zonas: texto numérico a número y nulos preservados", () => {
    const z = mapZona({ property_id: PROP, colonia: "Centro", pedidos: "12", domicilios: "10", recogidas: "2", neta_centavos: "345000", clientes: "9", entregados: "8", sin_cierre: "2", mediana_min: "34.5", p90_min: null, mas_de_60: "1" });
    expect(z).toMatchObject({ pedidos: 12, netaCentavos: 345000, medianaMin: 34.5, p90Min: null, masDe60: 1 });
  });
  it("demanda y ratios: lo que no viene es vacío / null, nunca inventado", () => {
    expect(mapDemanda({})).toEqual({ matriz: [], semanas: [], ticket: [], pago: [], promesa: [], totales: [], diasConVenta: 0 });
    const r = mapRatios({ parametros: { grande_centavos: 400000 }, filas: [{ property_id: null, pedidos: 3, neta_centavos: 9000, recompra: { d14: { elegibles: 2, recompraron: 1 } }, resp_mediana_seg: null }] });
    expect(r.grandeCentavos).toBe(400000);
    expect(r.filas[0]).toMatchObject({ propertyId: null, pedidos: 3, respMedianaSeg: null, costoTotalCentavos: null });
    expect(r.filas[0]!.recompra.d30).toEqual({ elegibles: 0, recompraron: 0 });
  });
});

describe("PostgresAnaliticaRepository", () => {
  it("lee la demanda con una sola llamada SQL y mapea el jsonb", async () => {
    const session = new AbortAwareFakeSession([{ match: /analitica_demanda/, respond: () => [{ j: { matriz: [{ property_id: PROP, dow: 5, hora: 13, canal: "domicilio", source: "whatsapp", pedidos: "4", neta_centavos: "80000" }], dias_con_venta: 3 } }] }]);
    const l = await new PostgresAnaliticaRepository(session).demanda(PARAMS);
    expect(l.disponible).toBe(true);
    if (l.disponible) {
      expect(l.datos.matriz[0]).toMatchObject({ dow: 5, hora: 13, pedidos: 4 });
      expect(l.datos.diasConVenta).toBe(3);
    }
  });
  it("base sin migrar (42883/42P01/42703): disponible=false y la transacción sigue utilizable", async () => {
    for (const code of ["42883", "42P01", "42703"]) {
      const session = new AbortAwareFakeSession([
        { match: /analitica_zonas/, respond: () => pgError(code, "no existe") },
        { match: /select 1 as despues/, respond: () => [{ despues: 1 }] },
      ]);
      expect(await new PostgresAnaliticaRepository(session).zonas(PARAMS, 5)).toEqual({ disponible: false });
      await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ despues: 1 }] });
    }
  });
  it("22023 => parámetro inválido; 42501 => sin acceso; otro error se propaga", async () => {
    const mk = (code: string) => new PostgresAnaliticaRepository(new AbortAwareFakeSession([{ match: /analitica_ratios/, respond: () => pgError(code, "boom") }]));
    await expect(mk("22023").ratios(PARAMS, 400000)).rejects.toBeInstanceOf(AnaliticaParametroInvalidoError);
    await expect(mk("42501").ratios(PARAMS, 400000)).rejects.toBeInstanceOf(AnaliticaSinAccesoError);
    await expect(mk("XX000").ratios(PARAMS, 400000)).rejects.toMatchObject({ code: "XX000" });
  });
  it("guardar costo: base sin migrar => AnaliticaNoDisponibleError (nunca un 500 crudo)", async () => {
    const session = new AbortAwareFakeSession([{ match: /analitica_costo_producto_guardar/, respond: () => pgError("42883", "no existe") }]);
    await expect(new PostgresAnaliticaRepository(session).guardarCostoProducto(ORG, O1, 12.5)).rejects.toBeInstanceOf(AnaliticaNoDisponibleError);
  });
  it("pasa null (todas) como arreglo nulo y las sucursales como arreglo", async () => {
    const vistos: unknown[][] = [];
    const session = new AbortAwareFakeSession([{ match: /analitica_demanda/, respond: () => [{ j: {} }] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      if (/analitica_demanda/.test(sql)) vistos.push(p ?? []);
      return original(sql, p);
    }) as typeof session.query;
    const repo = new PostgresAnaliticaRepository(session);
    await repo.demanda({ ...PARAMS, propertyIds: null });
    await repo.demanda(PARAMS);
    expect(vistos[0]![1]).toBeNull();
    expect(vistos[1]![1]).toEqual([PROP]);
  });
});

const CANDIDATOS = [
  { tipo: "restaurantes.pedido.eta_alta", organization_id: ORG, property_id: PROP, order_id: O1, order_number: "301", conversation_id: null, referencia_at: new Date("2026-10-03T18:00:00Z"), minutos: "75" },
  { tipo: "restaurantes.chat.ya_salio_sin_respuesta", organization_id: ORG, property_id: PROP, order_id: O2, order_number: 302, conversation_id: CONV, referencia_at: "2026-10-03T18:10:30.000Z", minutos: 7 },
  { tipo: "restaurantes.chat.otro_tipo_futuro", organization_id: ORG, property_id: PROP, order_id: O2, order_number: 303, conversation_id: null, referencia_at: "2026-10-03T18:10:30.000Z", minutos: 1 },
];

function sesionConDedupe(candidatos: unknown[]) {
  const vistas = new Set<string>();
  const emisiones: unknown[][] = [];
  const session = new AbortAwareFakeSession([
    { match: /analitica_alertas_candidatos/, respond: () => candidatos },
    { match: /select core\.emit_notification/, respond: () => [{ emit_notification: 1 }] },
  ]);
  const original = session.query.bind(session);
  session.query = (async (sql: string, p?: unknown[]) => {
    if (/select core\.emit_notification/.test(sql)) {
      const clave = String((p ?? [])[10]);
      emisiones.push(p ?? []);
      if (vistas.has(clave)) return { rows: [{ emit_notification: 0 }] };
      vistas.add(clave);
    }
    return original(sql, p);
  }) as typeof session.query;
  return { session, emisiones };
}

describe("barrerAlertasAnalitica", () => {
  it("emite ETA alto y «¿ya salió?» con texto sin PII (solo número y minutos); un tipo desconocido se ignora", async () => {
    const { session, emisiones } = sesionConDedupe(CANDIDATOS);
    expect(await barrerAlertasAnalitica(session)).toEqual({ disponible: true, candidatos: 2, emitidas: 2, sinNuevas: 0, errores: 0 });
    const [eta, ya] = emisiones;
    expect(eta![2]).toBe("restaurantes.pedido.eta_alta");
    expect(eta![5]).toBe("Un domicilio se prometió a más de 75 minutos");
    expect(eta![6]).toContain("#301");
    expect(eta![7]).toBe("/restaurantes/{orgSlug}/pedidos");
    expect(eta![10]).toBe(`restaurantes.pedido.eta_alta:${O1}`);
    expect(ya![2]).toBe("restaurantes.chat.ya_salio_sin_respuesta");
    expect(ya![6]).toContain("#302");
    expect(ya![7]).toBe("/restaurantes/{orgSlug}/conversaciones");
    for (const e of emisiones) expect(JSON.stringify(e)).not.toMatch(/\+\d{8,}/);
  });
  it("idempotente: dos barridos dejan una alerta por pedido / por mensaje", async () => {
    const { session } = sesionConDedupe(CANDIDATOS);
    await barrerAlertasAnalitica(session);
    expect(await barrerAlertasAnalitica(session)).toEqual({ disponible: true, candidatos: 2, emitidas: 0, sinNuevas: 2, errores: 0 });
  });
  it("un mensaje nuevo del mismo chat es otra alerta (la clave lleva el minuto del mensaje)", () => {
    const base = { tipo: "restaurantes.chat.ya_salio_sin_respuesta", organizationId: ORG, propertyId: PROP, orderId: O2, orderNumber: 302, conversationId: CONV, minutos: 6 } as const;
    expect(claveDeAlerta({ ...base, referenciaAt: "2026-10-03T18:10:30.000Z" })).not.toBe(claveDeAlerta({ ...base, referenciaAt: "2026-10-03T18:40:30.000Z" }));
    expect(claveDeAlerta({ ...base, referenciaAt: "2026-10-03T18:10:59.000Z" })).toBe(claveDeAlerta({ ...base, referenciaAt: "2026-10-03T18:10:01.000Z" }));
  });
  it("pasa el reloj y los umbrales a la base; sin reloj manda null", async () => {
    let params: unknown[] = [];
    const session = new AbortAwareFakeSession([{ match: /analitica_alertas_candidatos/, respond: () => [] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      params = p ?? [];
      return original(sql, p);
    }) as typeof session.query;
    await listarCandidatosAnalitica(session, { now: new Date("2026-10-03T18:00:00Z") });
    expect(params).toEqual(["2026-10-03T18:00:00.000Z", 60, 5]);
    await listarCandidatosAnalitica(session, { etaMaxMin: 90, yaSalioMin: 10 });
    expect(params).toEqual([null, 90, 10]);
  });
  it("base sin migrar: disponible=false y la sesión sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /analitica_alertas_candidatos/, respond: () => pgError("42883", "function restaurantes.analitica_alertas_candidatos(timestamp with time zone, integer, integer) does not exist") },
      { match: /select 1 as despues/, respond: () => [{ despues: 1 }] },
    ]);
    expect(await barrerAlertasAnalitica(session)).toEqual({ disponible: false, candidatos: 0, emitidas: 0, sinNuevas: 0, errores: 0 });
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ despues: 1 }] });
  });
});

describe("consultarComboSugerido", () => {
  const args = { organizationId: ORG, propertyId: PROP, productIds: [O1], canal: "domicilio" as const };
  it("devuelve la sugerencia solo cuando la base la entrega con motivo ok (sin precios)", async () => {
    const session = new AbortAwareFakeSession([{ match: /analitica_combo_sugerir/, respond: () => [{ j: { sugerencia: { promocion_codigo: "COMBO1", promocion_nombre: "Combo bistec", producto_id: O2, producto_nombre: "Frijoles" }, motivo: "ok" } }] }]);
    const r = await consultarComboSugerido(session, args);
    expect(r).toEqual({ sugerencia: { promocionCodigo: "COMBO1", promocionNombre: "Combo bistec", productoId: O2, productoNombre: "Frijoles" }, motivo: "ok" });
    expect(JSON.stringify(r)).not.toMatch(/precio|price|descuento/i);
  });
  it("sin combo en el menú: null con su motivo (el agente no sugiere nada)", async () => {
    const session = new AbortAwareFakeSession([{ match: /analitica_combo_sugerir/, respond: () => [{ j: { sugerencia: null, motivo: "sin_combo_vigente" } }] }]);
    expect(await consultarComboSugerido(session, args)).toEqual({ sugerencia: null, motivo: "sin_combo_vigente" });
  });
  it("una sugerencia con motivo distinto de ok se descarta aunque venga llena", async () => {
    const session = new AbortAwareFakeSession([{ match: /analitica_combo_sugerir/, respond: () => [{ j: { sugerencia: { promocion_codigo: "X", promocion_nombre: "X", producto_id: O2, producto_nombre: "X" }, motivo: "agotado" } }] }]);
    expect((await consultarComboSugerido(session, args)).sugerencia).toBeNull();
  });
  it("base sin migrar o error: no_disponible, nunca una excepción hacia la conversación", async () => {
    for (const code of ["42883", "XX000"]) {
      const session = new AbortAwareFakeSession([{ match: /analitica_combo_sugerir/, respond: () => pgError(code, "boom") }]);
      expect(await consultarComboSugerido(session, args)).toEqual({ sugerencia: null, motivo: "no_disponible" });
    }
  });
});
