// D-35 + D-02: reglas puras (el servidor recalcula el motor y solo acepta pares propuestos o manuales), doble en memoria (mismas reglas que la
// migración 021) y adaptador Postgres con SAVEPOINT (REGLA DURA de la base sin migrar, con AbortAwareFakeSession que reproduce el estado abortado).
import { describe, expect, it } from "vitest";
import {
  ConciliacionConflictoError,
  ConciliacionDatosInvalidosError,
  ConciliacionNoDisponibleError,
  ConciliacionNoEncontradaError,
  ConciliacionPeriodoCerradoError,
  ConciliacionSinPermisoError,
  InMemoryConciliacionPersistidaRepository,
  InMemoryDespachosRepository,
  ParNoPropuestoPorMotorError,
  PostgresConciliacionPersistidaRepository,
  calcularPropuestas,
  resolverPares,
} from "../src/index.ts";
import type { MovimientoGuardado, RegistroConciliable } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
const tablaInexistente = () => pgError("42P01", 'relation "despachos.conciliacion_sesion" does not exist');
const funcionInexistente = (nombre: string) => pgError("42883", `function despachos.${nombre}(uuid, text, text) does not exist`);

function mov(id: string, fecha: string, monto: number, descripcion: string): MovimientoGuardado {
  return { id, hash: id, cuenta: null, fecha, descripcion, referencia: null, cargo: null, abono: monto, saldo: null, monto, banco: "bbva", formato: "csv" };
}
const reg = (id: string, fecha: string, total: number, descripcion: string): RegistroConciliable => ({ id, fecha, total, descripcion, referencia: null, folioFiscal: id });

describe("calcularPropuestas / resolverPares", () => {
  const movs = [mov("m1", "2026-01-05", 1160, "SPEI ACME"), mov("m2", "2026-01-10", 500, "NADA QUE VER")];
  const regs = [reg("f1", "2026-01-05", 1160, "ACME SA DE CV"), reg("f2", "2026-01-20", 99999, "OTRO")];

  it("propone exacto con nivel 1 y confianza del motor, y deja lo demás sin conciliar (mismas referencias)", () => {
    const r = calcularPropuestas(movs, regs);
    expect(r.propuestas).toEqual([expect.objectContaining({ movimientoId: "m1", invoiceId: "f1", nivel: 1, confianza: 100 })]);
    expect(r.movimientosSinConciliar).toEqual([movs[1]]);
    expect(r.movimientosSinConciliar[0]).toBe(movs[1]);
    expect(r.registrosSinConciliar[0]).toBe(regs[1]);
  });

  it("un par que el motor no propone lanza ParNoPropuestoPorMotorError; manual entra sin nivel ni confianza; el nivel/confianza salen de la propuesta, no del cliente", () => {
    const { propuestas } = calcularPropuestas(movs, regs);
    expect(() => resolverPares([{ movimientoId: "m2", invoiceId: "f2", manual: false }], propuestas)).toThrow(ParNoPropuestoPorMotorError);
    expect(() => resolverPares([{ movimientoId: "m1", invoiceId: "f2", manual: false }], propuestas)).toThrow(ParNoPropuestoPorMotorError);
    expect(resolverPares([{ movimientoId: "m2", invoiceId: "f2", manual: true }], propuestas)).toEqual([{ movimientoId: "m2", invoiceId: "f2", nivel: null, confianza: null, origen: "manual" }]);
    expect(resolverPares([{ movimientoId: "m1", invoiceId: "f1", manual: false }], propuestas)).toEqual([{ movimientoId: "m1", invoiceId: "f1", nivel: 1, confianza: 100, origen: "motor" }]);
  });

  it("el multi-línea (un pago cubre varios CFDI) se reporta aparte y NO es confirmable como par", () => {
    const r = calcularPropuestas([mov("m9", "2026-01-05", 300, "PAGO VARIAS FACTURAS")], [reg("a", "2026-01-05", 100, "uno"), reg("b", "2026-01-05", 200, "dos")]);
    expect(r.propuestas).toHaveLength(0);
    expect(r.multiLinea).toEqual([expect.objectContaining({ movimientoId: "m9", invoiceIds: expect.arrayContaining(["a", "b"]) })]);
  });
});

describe("InMemoryConciliacionPersistidaRepository", () => {
  const P = "prop-1";
  async function base() {
    const despachos = new InMemoryDespachosRepository();
    await despachos.insertEstadoCuentaMovimientos({
      organizationId: "org-1",
      propertyId: P,
      loteId: "lote",
      movimientos: [
        { hash: "h1", cuenta: null, banco: "bbva", formato: "csv", fecha: "2026-01-05", descripcion: "uno", referencia: null, cargo: null, abono: 10, monto: 10, saldo: null, renglon: 1 },
        { hash: "h2", cuenta: null, banco: "bbva", formato: "csv", fecha: "2026-02-05", descripcion: "dos", referencia: null, cargo: null, abono: 20, monto: 20, saldo: null, renglon: 2 },
      ],
    });
    const inv = await despachos.insertInvoice({
      organizationId: "org-1", propertyId: P, folioFiscal: "f", tipo: "I", rfcEmisor: "AAA010101AAA", rfcReceptor: "BBB010101BBB", emisorNombre: "X", subtotal: 10, total: 10, iva: 0, descuento: 0,
      categoria: "gasto_operativo", valido: true, issues: [], warnings: [], requiresHumanReview: false, diot: { reportable: false, proveedoresReportables: [] }, fecha: "2026-01-05",
    });
    const repo = new InMemoryConciliacionPersistidaRepository(despachos);
    const { sesion } = await repo.crearSesion(P, "2026-01", null, "u1");
    const movs = await repo.listarMovimientosSesion(sesion);
    return { despachos, repo, sesion, inv, mov: movs[0]! };
  }
  const par = (movimientoId: string, invoiceId: string) => ({ movimientoId, invoiceId, nivel: 1, confianza: 100, origen: "motor" as const });

  it("un movimiento tiene a lo más un match vigente; deshacer lo libera; deshacer es idempotente", async () => {
    const { repo, sesion, inv, mov } = await base();
    const [m] = await repo.confirmarMatches(P, sesion.id, [par(mov.id, inv.id)], "u1");
    await expect(repo.confirmarMatches(P, sesion.id, [par(mov.id, inv.id)], "u1")).rejects.toBeInstanceOf(ConciliacionConflictoError);
    expect(await repo.deshacerMatch(P, m!.id, "motivo valido", "u1")).toEqual({ yaDeshecho: false });
    expect(await repo.deshacerMatch(P, m!.id, "otro motivo", "u2")).toEqual({ yaDeshecho: true });
    expect((await repo.obtenerMatch(P, m!.id))?.motivoDeshacer).toBe("motivo valido");
    await expect(repo.confirmarMatches(P, sesion.id, [par(mov.id, inv.id)], "u1")).resolves.toHaveLength(1);
  });

  it("rechaza movimiento de otro periodo, CFDI ajeno, lote vacío, motivo corto y periodo cerrado", async () => {
    const { despachos, repo, sesion, inv, mov } = await base();
    const fuera = despachos.listEstadoCuentaMovimientosGuardados(P).find((m) => m.fecha.startsWith("2026-02"))!;
    await expect(repo.confirmarMatches(P, sesion.id, [par(fuera.id, inv.id)], "u1")).rejects.toBeInstanceOf(ConciliacionDatosInvalidosError);
    await expect(repo.confirmarMatches(P, sesion.id, [par(mov.id, "no-existe")], "u1")).rejects.toBeInstanceOf(ConciliacionDatosInvalidosError);
    await expect(repo.confirmarMatches(P, sesion.id, [], "u1")).rejects.toBeInstanceOf(ConciliacionDatosInvalidosError);
    await expect(repo.confirmarMatches("otra-property", sesion.id, [par(mov.id, inv.id)], "u1")).rejects.toBeInstanceOf(ConciliacionNoEncontradaError);
    const [m] = await repo.confirmarMatches(P, sesion.id, [par(mov.id, inv.id)], "u1");
    await expect(repo.deshacerMatch(P, m!.id, "x", "u1")).rejects.toBeInstanceOf(ConciliacionDatosInvalidosError);
    const { periodo } = await despachos.insertPeriodoCierre({ organizationId: "org-1", propertyId: P, anio: 2026, mes: 1, template: (await import("../src/index.ts")).getTemplate(undefined) });
    await despachos.updatePeriodoCierre({ ...periodo, status: "closed", closedAt: new Date().toISOString() });
    await expect(repo.deshacerMatch(P, m!.id, "motivo valido", "u1")).rejects.toBeInstanceOf(ConciliacionPeriodoCerradoError);
  });

  it("una sugerencia queda pendiente y NO crea match; aprobar crea llm_aprobado nivel 4; una pendiente por movimiento", async () => {
    const { repo, sesion, inv, mov } = await base();
    const nuevas = await repo.guardarSugerencias(P, sesion.id, [{ movimientoId: mov.id, invoiceId: inv.id, confianza: 64, razon: "r" }], "u1");
    expect(nuevas[0]!.estado).toBe("pendiente");
    expect(await repo.listarMatches(sesion.id)).toHaveLength(0);
    expect(await repo.guardarSugerencias(P, sesion.id, [{ movimientoId: mov.id, invoiceId: inv.id, confianza: 70, razon: "r2" }], "u1")).toHaveLength(0);
    const r = await repo.resolverSugerencia(P, nuevas[0]!.id, true, "u1");
    expect(r.estado).toBe("aprobada");
    expect((await repo.listarMatches(sesion.id))[0]).toMatchObject({ origen: "llm_aprobado", nivel: 4, confianza: 64 });
    await expect(repo.resolverSugerencia(P, nuevas[0]!.id, false, "u1")).rejects.toBeInstanceOf(ConciliacionDatosInvalidosError);
  });

  it("sin la migración: lecturas vacías y escrituras ConciliacionNoDisponibleError", async () => {
    const { repo, sesion } = await base();
    repo.disponible = false;
    expect(await repo.listarSesiones(P, 10)).toEqual({ estado: "no_disponible", datos: [] });
    await expect(repo.crearSesion(P, "2026-01", null, "u1")).rejects.toBeInstanceOf(ConciliacionNoDisponibleError);
    await expect(repo.cerrarSesion(P, sesion.id, "u1")).rejects.toBeInstanceOf(ConciliacionNoDisponibleError);
  });
});

describe("PostgresConciliacionPersistidaRepository (SAVEPOINT, base sin migrar)", () => {
  const P = "11111111-1111-4111-8111-111111111111";
  const S = "22222222-2222-4222-8222-222222222222";

  it("REGLA DURA (42P01): la lista cae a vacío + no_disponible y la sesión NO queda abortada", async () => {
    const session = new AbortAwareFakeSession([{ match: /from despachos\.conciliacion_sesion/i, respond: tablaInexistente }, { match: /select 1/, respond: () => [{ ok: 1 }] }]);
    const r = await new PostgresConciliacionPersistidaRepository(session).listarSesiones(P, 10);
    expect(r).toEqual({ estado: "no_disponible", datos: [] });
    await expect(session.query("select 1")).resolves.toBeDefined();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("REGLA DURA (42883): confirmar/crear/deshacer/sugerir/resolver -> ConciliacionNoDisponibleError y la sesión sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /despachos\.conciliacion_/i, respond: () => funcionInexistente("conciliacion_x") }, { match: /select 1/, respond: () => [{ ok: 1 }] }]);
    const repo = new PostgresConciliacionPersistidaRepository(session);
    await expect(repo.crearSesion(P, "2026-01", null)).rejects.toBeInstanceOf(ConciliacionNoDisponibleError);
    await expect(repo.confirmarMatches(P, S, [{ movimientoId: "m", invoiceId: "i", nivel: 1, confianza: 100, origen: "motor" }])).rejects.toBeInstanceOf(ConciliacionNoDisponibleError);
    await expect(repo.deshacerMatch(P, S, "motivo valido")).rejects.toBeInstanceOf(ConciliacionNoDisponibleError);
    await expect(repo.guardarSugerencias(P, S, [{ movimientoId: "m", invoiceId: "i", confianza: 1, razon: "" }])).rejects.toBeInstanceOf(ConciliacionNoDisponibleError);
    await expect(repo.resolverSugerencia(P, S, true)).rejects.toBeInstanceOf(ConciliacionNoDisponibleError);
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("la marca derivada y las lecturas de detalle degradan con la base sin migrar (vista inexistente 42P01)", async () => {
    const session = new AbortAwareFakeSession([{ match: /invoice_conciliacion/i, respond: tablaInexistente }, { match: /conciliacion_sesion/i, respond: tablaInexistente }]);
    const repo = new PostgresConciliacionPersistidaRepository(session);
    expect(await repo.invoiceIdsConciliados(P)).toEqual({ estado: "no_disponible", datos: new Set() });
    expect(await repo.obtenerSesion(P, S)).toEqual({ estado: "no_disponible", datos: null });
  });

  it("un 42883 de OTRA función (no despachos.conciliacion_*) no se disfraza de 'no disponible'", async () => {
    const session = new AbortAwareFakeSession([{ match: /conciliacion_matches_confirmar/i, respond: () => pgError("42883", "function core.has_property_access(uuid) does not exist") }]);
    await expect(new PostgresConciliacionPersistidaRepository(session).confirmarMatches(P, S, [{ movimientoId: "m", invoiceId: "i", nivel: null, confianza: null, origen: "manual" }])).rejects.toMatchObject({ code: "42883" });
  });

  it.each([
    ["42501", "conciliacion_match: sin permiso", ConciliacionSinPermisoError],
    ["22023", "conciliacion_match: el movimiento no pertenece a la sesión", ConciliacionDatosInvalidosError],
    ["55000", "conciliacion_match: el periodo 2026-07 está cerrado", ConciliacionPeriodoCerradoError],
    ["23505", "duplicate key value violates unique constraint", ConciliacionConflictoError],
    ["P0002", "conciliacion_match_deshacer: match no encontrado", ConciliacionNoEncontradaError],
  ])("SQLSTATE %s -> error de dominio tipado", async (code, mensaje, clase) => {
    const repo = new PostgresConciliacionPersistidaRepository(new AbortAwareFakeSession([{ match: /conciliacion_matches_confirmar/i, respond: () => pgError(code, mensaje) }]));
    await expect(repo.confirmarMatches(P, S, [{ movimientoId: "m", invoiceId: "i", nivel: null, confianza: null, origen: "manual" }])).rejects.toBeInstanceOf(clase);
  });

  it("el periodo cerrado conserva el YYYY-MM del mensaje de la base y el mensaje no arrastra el prefijo interno", async () => {
    const repo = new PostgresConciliacionPersistidaRepository(new AbortAwareFakeSession([{ match: /conciliacion_matches_confirmar/i, respond: () => pgError("55000", "conciliacion_match: el periodo 2026-07 está cerrado") }]));
    await expect(repo.confirmarMatches(P, S, [{ movimientoId: "m", invoiceId: "i", nivel: null, confianza: null, origen: "manual" }])).rejects.toMatchObject({ periodo: "2026-07" });
  });

  it("serializa los pares en jsonb con el nivel y confianza calculados y deshacer informa ya_deshecho", async () => {
    const llamadas: unknown[][] = [];
    const session = new AbortAwareFakeSession([
      { match: /conciliacion_matches_confirmar/i, respond: () => [{ out_match_id: "33333333-3333-4333-8333-333333333333" }] },
      { match: /from despachos\.conciliacion_match where id = any/i, respond: () => [{ id: "33333333-3333-4333-8333-333333333333", sesion_id: S, movimiento_id: "m", invoice_id: "i", nivel: 1, confianza: "100.00", origen: "motor", confirmado_por: "u", confirmado_en: "2026-01-05T00:00:00Z", deshecho_por: null, deshecho_en: null, motivo_deshacer: null }] },
      { match: /conciliacion_match_deshacer/i, respond: () => [{ out_ya_deshecho: true }] },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      llamadas.push(params ?? []);
      return original(sql, params);
    }) as typeof session.query;
    const repo = new PostgresConciliacionPersistidaRepository(session);
    const [m] = await repo.confirmarMatches(P, S, [{ movimientoId: "m", invoiceId: "i", nivel: 1, confianza: 100, origen: "motor" }]);
    expect(m).toMatchObject({ nivel: 1, confianza: 100, origen: "motor", deshechoEn: null });
    expect(JSON.parse(llamadas[0]![1] as string)).toEqual([{ movimiento_id: "m", invoice_id: "i", nivel: 1, confianza: 100, origen: "motor" }]);
    expect(await repo.deshacerMatch(P, S, "motivo valido")).toEqual({ yaDeshecho: true });
  });
});
