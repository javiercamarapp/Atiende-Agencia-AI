// Compatibilidad con la base SIN MIGRAR: el lector de "Chatea con tus datos" corre dentro de la transaccion
// UNICA de la request (`dbSession`). Un 42P01/42703/42883 sin SAVEPOINT dejaria la transaccion abortada
// (25P02 en la consulta siguiente y COMMIT -> ROLLBACK silencioso). Se prueba con AbortAwareFakeSession,
// que reproduce ese estado abortado (una sesion falsa plana no sirve).
import { describe, expect, it } from "vitest";
import { buildDespachosDataChatTools, DataChatUnavailableError, MAX_EFOS_CLIENTES, PostgresDespachosDataChatReader, type DespachosDataChatWindow } from "../../src/data-chat/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";
import { ADMIN_SCOPE, ALL_CLIENTS, NOW, ORG_A } from "./support.ts";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const SET_TIMEOUT = { match: /^\s*set local statement_timeout = 8000/i, respond: () => [] };
const NEXT = { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] };

const WINDOW: DespachosDataChatWindow = { organizationId: ORG_A, propertyIds: null, fromDate: "2026-09-01", toDate: "2026-09-29", hoy: "2026-09-29", limit: 51 };

describe("PostgresDespachosDataChatReader — base sin migrar", () => {
  it("tabla inexistente (42P01) -> DataChatUnavailableError y la transaccion queda UTILIZABLE (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /from despachos\.receivable/i, respond: () => pgError("42P01", 'relation "despachos.receivable" does not exist') }, NEXT]);
    const reader = new PostgresDespachosDataChatReader(session);
    await expect(reader.carteraPorCliente(WINDOW)).rejects.toBeInstanceOf(DataChatUnavailableError);
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    expect(session.calls.filter((c) => c.startsWith("savepoint"))).toHaveLength(1);
  });

  it("columna inexistente (42703) y funcion inexistente (42883) degradan a 'no disponible' en TODAS las consultas", async () => {
    const calls: Array<[string, (r: PostgresDespachosDataChatReader) => Promise<unknown>, RegExp]> = [
      ["cartera", (r) => r.carteraPorCliente(WINDOW), /from despachos\.receivable/i],
      ["antiguedad", (r) => r.antiguedadCobranza(WINDOW), /from despachos\.receivable/i],
      ["cfdi", (r) => r.cfdiPorPeriodo(WINDOW), /group by i\.tipo/i],
      ["iva", (r) => r.ivaAcreditable(WINDOW), /iva_acreditable/i],
      ["obligaciones", (r) => r.obligacionesFiscales(WINDOW), /from despachos\.fiscal_deadline d\s+join core\.property/i],
      ["cierres", (r) => r.cierresPendientes(WINDOW), /from despachos\.periodo_cierre c/i],
      ["carga", (r) => r.cargaDeTrabajo(WINDOW), /revisiones_pendientes/i],
      ["clientes", (r) => r.listVisibleClients(ORG_A, null), /from core\.property p\s+where/i],
    ];
    for (const err of [pgError("42703", "column does not exist"), pgError("42883", "function despachos.algo(uuid) does not exist")]) {
      for (const [name, run, match] of calls) {
        const session = new AbortAwareFakeSession([SET_TIMEOUT, { match, respond: () => err }]);
        await expect(run(new PostgresDespachosDataChatReader(session)), name).rejects.toBeInstanceOf(DataChatUnavailableError);
      }
    }
  });

  it("un error real (statement timeout 57014) NO se enmascara como 'no disponible', pero la sesion igual se recupera", async () => {
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /from despachos\.receivable/i, respond: () => pgError("57014", "canceling statement due to statement timeout") }, NEXT]);
    const reader = new PostgresDespachosDataChatReader(session);
    await expect(reader.antiguedadCobranza(WINDOW)).rejects.toMatchObject({ code: "57014" });
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("de punta a punta: la herramienta responde 'unavailable' y la transaccion sigue sirviendo a la bitacora", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /from core\.property p\s+where/i, respond: () => [{ property_id: "p1", name: "Abarrotes" }] },
      { match: /from despachos\.receivable/i, respond: () => pgError("42P01", "relation does not exist") },
      { match: /insert into core\.data_chat_query_log|select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] },
    ]);
    const tool = buildDespachosDataChatTools(new PostgresDespachosDataChatReader(session)).find((t) => t.name === "cartera_por_cliente")!;
    const r = await tool.run({ scope: ADMIN_SCOPE, now: NOW, signal: new AbortController().signal, maxRows: 50 }, {});
    expect(r.status).toBe("unavailable");
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("camino feliz: convierte numeric/bigint (texto de pg) a numeros y manda los parametros en el orden del SQL", async () => {
    const seen: unknown[][] = [];
    const base = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /monto_pendiente/i, respond: () => [{ cliente: "Abarrotes", cuentas_pendientes: "4", monto_pendiente: "1200.50", cuentas_vencidas: "2", monto_vencido: "450.25" }] },
      { match: /group by b\.bucket/i, respond: () => [{ bucket: "1 a 30 días vencida", cuentas: "3", monto: "99.90" }] },
      { match: /group by i\.tipo/i, respond: () => [{ tipo: "I", cfdi: "40", total: "250000.10", invalidos: "3", en_revision: "2" }] },
      { match: /fecha_limite/i, respond: () => [{ cliente: "Abarrotes", tipo: "IVA", periodo: "2026-09", fecha_limite: "2026-10-17", estado: "pendiente", prioridad: "alta" }] },
    ]);
    const original = base.query.bind(base);
    base.query = (async (sql: string, params?: unknown[]) => {
      seen.push(params ?? []);
      return original(sql, params);
    }) as typeof base.query;
    const reader = new PostgresDespachosDataChatReader(base);

    expect(await reader.carteraPorCliente(WINDOW)).toEqual([{ cliente: "Abarrotes", cuentasPendientes: 4, montoPendiente: 1200.5, cuentasVencidas: 2, montoVencido: 450.25 }]);
    expect(await reader.antiguedadCobranza(WINDOW)).toEqual([{ bucket: "1 a 30 días vencida", cuentas: 3, monto: 99.9 }]);
    expect(await reader.cfdiPorPeriodo(WINDOW)).toEqual([{ tipo: "I", cfdi: 40, total: 250000.1, invalidos: 3, enRevision: 2 }]);
    expect(await reader.obligacionesFiscales(WINDOW)).toEqual([{ cliente: "Abarrotes", tipo: "IVA", periodo: "2026-09", fechaLimite: "2026-10-17", estado: "pendiente", prioridad: "alta" }]);
    expect(seen[0]).toEqual([ORG_A, null, "2026-09-29", 51]); // cartera: org, props, hoy, tope
    expect(seen[1]).toEqual([ORG_A, null, "2026-09-29"]); // antiguedad: org, props, hoy
    expect(seen[2]).toEqual([ORG_A, null, "2026-09-01", "2026-09-29", 51]); // cfdi: org, props, desde, hasta, tope
    expect(seen[3]).toEqual([ORG_A, null, "2026-09-01", "2026-09-29", "2026-09-29", 51]); // obligaciones: + hoy
  });

  it("clientes permitidos viajan como arreglo (nunca null) cuando la membresia esta acotada", async () => {
    const seen: unknown[][] = [];
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /monto_pendiente/i, respond: () => [] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      seen.push(params ?? []);
      return original(sql, params);
    }) as typeof session.query;
    await new PostgresDespachosDataChatReader(session).carteraPorCliente({ ...WINDOW, propertyIds: ["p1", "p2"] });
    expect(seen[0]![1]).toEqual(["p1", "p2"]);
  });
});

describe("PostgresDespachosDataChatReader — lista 69-B (funciones security definer, migración 014)", () => {
  const AFECTADO = { out_rfc_emisor: "AAA010101AAA", out_emisor_nombre: "Proveedor SA", out_fecha: "2026-09-10", out_total: "1000.50", out_situacion: "definitivo", out_periodo_lista: "2026-09" };

  it("funcion efos_estado inexistente (42883) -> 'no_disponible', NUNCA 'sin riesgo', y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /efos_estado/i, respond: () => pgError("42883", "function despachos.efos_estado() does not exist") }, NEXT]);
    const r = await new PostgresDespachosDataChatReader(session).efosAlertas(ALL_CLIENTS);
    expect(r).toMatchObject({ estado: "no_disponible", alertas: [], periodoLista: null });
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("lista sin ingerir (efos_estado sin filas) -> 'no_disponible' y ni siquiera consulta los CFDI de los clientes", async () => {
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /efos_estado/i, respond: () => [] }, { match: /efos_invoices_afectados/i, respond: () => pgError("XX000", "no debio llamarse") }]);
    const r = await new PostgresDespachosDataChatReader(session).efosAlertas(ALL_CLIENTS);
    expect(r.estado).toBe("no_disponible");
    expect(session.calls.some((c) => /^select out_rfc_emisor/i.test(c))).toBe(false);
  });

  it("agrupa por cliente + RFC + situacion, suma CFDI y total, definitivos primero", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /efos_estado/i, respond: () => [{ out_periodo: "2026-09" }] },
      { match: /efos_invoices_afectados/i, respond: () => [AFECTADO, AFECTADO, { ...AFECTADO, out_rfc_emisor: "BBB020202BBB", out_situacion: "presunto", out_total: "10.00" }] },
    ]);
    const r = await new PostgresDespachosDataChatReader(session).efosAlertas([ALL_CLIENTS[0]!]);
    expect(r.estado).toBe("disponible");
    expect(r.periodoLista).toBe("2026-09");
    expect(r.alertas).toEqual([
      { cliente: ALL_CLIENTS[0]!.name, rfcEmisor: "AAA010101AAA", emisorNombre: "Proveedor SA", situacion: "definitivo", cfdi: 2, total: 2001 },
      { cliente: ALL_CLIENTS[0]!.name, rfcEmisor: "BBB020202BBB", emisorNombre: "Proveedor SA", situacion: "presunto", cfdi: 1, total: 10 },
    ]);
  });

  it("revisa a lo mucho MAX_EFOS_CLIENTES clientes por pregunta y lo declara (truncado)", async () => {
    const muchos = Array.from({ length: MAX_EFOS_CLIENTES + 5 }, (_, i) => ({ propertyId: `p${i}`, name: `Cliente ${i}` }));
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /efos_estado/i, respond: () => [{ out_periodo: "2026-09" }] }, { match: /efos_invoices_afectados/i, respond: () => [] }]);
    const r = await new PostgresDespachosDataChatReader(session).efosAlertas(muchos);
    expect(r.truncado).toBe(true);
    expect(session.calls.filter((c) => /^select out_rfc_emisor/i.test(c))).toHaveLength(MAX_EFOS_CLIENTES);
  });

  it("sin acceso a la property (42501 de la funcion) NO se enmascara como 'no disponible'", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /efos_estado/i, respond: () => [{ out_periodo: "2026-09" }] },
      { match: /efos_invoices_afectados/i, respond: () => pgError("42501", "efos_invoices_afectados: sin acceso a la property") },
    ]);
    await expect(new PostgresDespachosDataChatReader(session).efosAlertas([ALL_CLIENTS[0]!])).rejects.toMatchObject({ code: "42501" });
  });
});
