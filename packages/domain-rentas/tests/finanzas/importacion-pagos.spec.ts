// Rn-P3-06 -- importacion del reporte de pagos contra el repositorio en memoria (mismas restricciones que el DDL): emparejamiento por
// codigo, creacion con Finanzas-1, conciliacion, discrepancia >1 %, cola de pendientes, idempotencia y reevaluacion de pendientes.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../../src/calendar-store.ts";
import { InMemoryRentasRepository } from "../../src/in-memory-repository.ts";
import { parsearReportePagos } from "../../src/finanzas/csv/index.ts";
import { importarReportePagos } from "../../src/finanzas/importacion.ts";
import type { ConfiguracionComisionCanal } from "../../src/types.ts";

const FIXTURE = readFileSync(new URL("../fixtures/pagos/airbnb-transacciones.csv", import.meta.url), "utf8");
const AIRBNB_NETO: ConfiguracionComisionCanal = { yaNetoDeComision: true, comisionBasisPoints: 300, fuente: "Airbnb: la comision se descuenta del pago al anfitrion" };

function escenario(regla: ConfiguracionComisionCanal | null = AIRBNB_NETO) {
  const store = new InMemoryRentasCalendarStore();
  const repo = new InMemoryRentasRepository(store);
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const unidadId = randomUUID();
  store.seedUnidad({ id: unidadId, organizationId, propertyId, duracionMinimaNoches: 1 });
  const canal = store.findCanalPorCodigo("airbnb")!;
  if (regla) repo.seedReglaComisionCanal({ propertyId: null, canalId: canal.id, config: regla });
  const reserva = (codigo: string, inicio: string, fin: string) => {
    const { id } = store.insertOcupacionReserva({ organizationId, propertyId, unidadId, inicio, fin, estado: "confirmado", bloqueante: true, canalOrigenId: canal.id, externalId: `uid-${codigo}` });
    store.getOcupacion(id)!.codigoConfirmacion = codigo;
    return id;
  };
  const importar = (texto: string, opciones: { aplicar?: boolean; gestorBp?: number } = {}) =>
    importarReportePagos(repo, {
      organizationId,
      propertyId,
      userId: randomUUID(),
      canal: { id: canal.id, codigo: "airbnb" },
      parseo: parsearReportePagos("airbnb", texto),
      archivoSha256: "a".repeat(64),
      aplicar: opciones.aplicar ?? true,
      comisionGestor: { basisPoints: opciones.gestorBp ?? 1000, base: "neto_de_canal" },
    });
  return { store, repo, organizationId, propertyId, canal, reserva, importar };
}

describe("importarReportePagos", () => {
  it("crea el movimiento de una reserva sin movimiento tomando el neto del reporte; el canal neto NO resta la comision otra vez (Finanzas-1)", async () => {
    const e = escenario();
    const o1 = e.reserva("HMAB12CD34", "2026-10-15", "2026-10-20");
    e.reserva("HMZZ99YY88", "2026-11-01", "2026-11-05");
    const r = await e.importar(FIXTURE);
    expect(r.resumen).toMatchObject({ totalLineas: 3, creadas: 2, pendientes: 1, ignoradas: 1, yaImportadas: 0 });
    const mov = await e.repo.findReservaFinanciero(e.propertyId, o1);
    expect(mov).toMatchObject({ ingresoBrutoCentavos: 873000, montoRecibidoCentavos: 873000, comisionCanalCentavos: 0 });
    // comision del gestor 10 % sobre el neto de canal; neto = recibido - gestor.
    expect(mov!.comisionGestorCentavos).toBe(87300);
    expect(mov!.netoCentavos).toBe(785700);
  });

  it("idempotente: subir el mismo archivo dos veces no duplica movimientos ni lineas", async () => {
    const e = escenario();
    e.reserva("HMAB12CD34", "2026-10-15", "2026-10-20");
    e.reserva("HMZZ99YY88", "2026-11-01", "2026-11-05");
    await e.importar(FIXTURE);
    const lineasAntes = e.repo.lineasImportadas.size;
    const segunda = await e.importar(FIXTURE);
    expect(segunda.resumen).toMatchObject({ creadas: 0, conciliadas: 0, discrepancias: 0, yaImportadas: 3 });
    expect(e.repo.lineasImportadas.size).toBe(lineasAntes);
    expect(segunda.lineas.every((l) => l.resultado === "ya_importada")).toBe(true);
  });

  it("la vista previa calcula el mismo resultado sin escribir nada", async () => {
    const e = escenario();
    const o1 = e.reserva("HMAB12CD34", "2026-10-15", "2026-10-20");
    const previa = await e.importar(FIXTURE, { aplicar: false });
    expect(previa).toMatchObject({ aplicado: false, importacionId: null });
    expect(previa.resumen.creadas).toBe(1);
    expect(await e.repo.findReservaFinanciero(e.propertyId, o1)).toBeNull();
    expect(e.repo.lineasImportadas.size).toBe(0);
    expect(e.repo.importacionesPagos).toHaveLength(0);
  });

  it("sin reserva con ese codigo queda pendiente en la cola; al llegar la reserva (iCal) y volver a subir el archivo se reevalua", async () => {
    const e = escenario();
    const r1 = await e.importar(FIXTURE);
    expect(r1.resumen).toMatchObject({ creadas: 0, pendientes: 3 });
    expect((await e.repo.listColaImportacion(e.propertyId, 50)).map((l) => l.codigoConfirmacion).sort()).toEqual(["HMAB12CD34", "HMAB12CD34", "HMZZ99YY88"]);
    const o1 = e.reserva("HMAB12CD34", "2026-10-15", "2026-10-20");
    const r2 = await e.importar(FIXTURE);
    expect(r2.resumen).toMatchObject({ creadas: 1, pendientes: 0, yaImportadas: 2 });
    expect(await e.repo.findReservaFinanciero(e.propertyId, o1)).not.toBeNull();
    // las lineas no se duplicaron: la pendiente se actualizo.
    expect(e.repo.lineasImportadas.size).toBe(3);
  });

  it("una reserva que ya tiene movimiento se concilia (monto igual) o marca discrepancia (monto distinto), sin tocar el movimiento", async () => {
    const e = escenario();
    const o1 = e.reserva("HMAB12CD34", "2026-10-15", "2026-10-20");
    const o2 = e.reserva("HMZZ99YY88", "2026-11-01", "2026-11-05");
    const base = { organizationId: e.organizationId, propertyId: e.propertyId, moneda: "MXN", yaNetoDeComision: true, comisionCanalBasisPoints: 0, comisionCanalFuente: "x", comisionCanalCentavos: 0, comisionGestorBasisPoints: 0, comisionGestorBase: "bruto" as const, comisionGestorCentavos: 0, gastos: [], gastosCentavos: 0, impuestos: [], impuestosCentavos: 0, createdBy: randomUUID() };
    await e.repo.insertReservaFinanciero({ ...base, ocupacionId: o1, montoBrutoCentavos: 873000, montoRecibidoCentavos: 873000, netoCentavos: 873000 });
    await e.repo.insertReservaFinanciero({ ...base, ocupacionId: o2, montoBrutoCentavos: 400000, montoRecibidoCentavos: 400000, netoCentavos: 400000 });
    const r = await e.importar(FIXTURE);
    expect(r.resumen).toMatchObject({ creadas: 0, conciliadas: 1, discrepancias: 1, pendientes: 1 });
    expect((await e.repo.findReservaFinanciero(e.propertyId, o2))!.montoRecibidoCentavos).toBe(400000);
  });

  it("regla del canal que parte del bruto: la comision sale de la regla y se resta del bruto del reporte", async () => {
    const e = escenario({ yaNetoDeComision: false, comisionBasisPoints: 300, fuente: "regla de prueba 3 %" });
    const o1 = e.reserva("HMAB12CD34", "2026-10-15", "2026-10-20"); // reporta comision 270 sobre 9,000 = 3 %: coincide
    const o2 = e.reserva("HMZZ99YY88", "2026-11-01", "2026-11-05"); // 139 sobre 4,639 = 3 %: coincide
    const r = await e.importar(FIXTURE);
    expect(r.resumen).toMatchObject({ creadas: 2, discrepancias: 0 });
    expect(await e.repo.findReservaFinanciero(e.propertyId, o1)).toMatchObject({ ingresoBrutoCentavos: 900000, comisionCanalCentavos: 27000, montoRecibidoCentavos: 873000 });
    expect(await e.repo.findReservaFinanciero(e.propertyId, o2)).toMatchObject({ ingresoBrutoCentavos: 463900, comisionCanalCentavos: 13917, montoRecibidoCentavos: 449983 });
  });

  it("la discrepancia de comision (>1 % del bruto) crea el movimiento y lo deja en revision con motivo discrepancia_importacion", async () => {
    const e = escenario({ yaNetoDeComision: false, comisionBasisPoints: 300, fuente: "regla de prueba 3 %" });
    const o3 = e.reserva("HMQQ11QQ11", "2026-12-01", "2026-12-04");
    const csv = "Type,Confirmation Code,Currency,Paid out,Gross earnings\nReservation,HMQQ11QQ11,MXN,\"8,500.00\",\"9,000.00\"\n";
    const r = await e.importar(csv);
    expect(r.resumen).toMatchObject({ creadas: 0, discrepancias: 1 });
    expect(r.lineas[0]!.nota).toMatch(/mas de 1 %/);
    expect(await e.repo.findReservaFinanciero(e.propertyId, o3)).toMatchObject({ comisionCanalCentavos: 27000, montoRecibidoCentavos: 873000 });
    expect(await e.repo.listMovimientosEnRevision(e.propertyId, 10)).toEqual([expect.objectContaining({ ocupacionId: o3, motivo: "discrepancia_importacion", origen: "importacion_csv" })]);
  });

  it("una diferencia de comision dentro de 1 % del bruto NO es discrepancia", async () => {
    const e = escenario({ yaNetoDeComision: false, comisionBasisPoints: 300, fuente: "regla de prueba 3 %" });
    e.reserva("HMQQ11QQ11", "2026-12-01", "2026-12-04");
    const csv = "Type,Confirmation Code,Currency,Paid out,Gross earnings\nReservation,HMQQ11QQ11,MXN,\"8,720.00\",\"9,000.00\"\n"; // 280 vs 270: 0.11 %
    const r = await e.importar(csv);
    expect(r.resumen).toMatchObject({ creadas: 1, discrepancias: 0 });
  });

  it("canal sin regla de comision: la linea queda pendiente con la accion a seguir, no se inventa una comision", async () => {
    const e = escenario(null);
    const o1 = e.reserva("HMAB12CD34", "2026-10-15", "2026-10-20");
    const r = await e.importar(FIXTURE);
    expect(r.resumen.creadas).toBe(0);
    expect(r.lineas.find((l) => l.codigoConfirmacion === "HMAB12CD34" && l.tipoLinea === "reserva")!.nota).toMatch(/regla de comision/);
    expect(await e.repo.findReservaFinanciero(e.propertyId, o1)).toBeNull();
  });

  it("reserva cancelada, codigo repetido en el archivo y ajustes quedan pendientes; nunca crean movimiento", async () => {
    const e = escenario();
    const oc = e.reserva("HMCANCEL01", "2026-10-01", "2026-10-03");
    e.store.marcarCancelada(oc);
    const repetida = e.reserva("HMREPE00001", "2026-10-10", "2026-10-12");
    const csv = "Type,Confirmation Code,Currency,Paid out\nReservation,HMCANCEL01,MXN,100.00\nReservation,HMREPE00001,MXN,200.00\nReservation,HMREPE00001,MXN,201.00\n";
    const r = await e.importar(csv);
    expect(r.resumen).toMatchObject({ creadas: 1, pendientes: 2 });
    expect(r.lineas[0]!.nota).toMatch(/cancelada/);
    expect(r.lineas[2]!.nota).toMatch(/se repite en el archivo/);
    expect(await e.repo.findReservaFinanciero(e.propertyId, oc)).toBeNull();
    expect(await e.repo.findReservaFinanciero(e.propertyId, repetida)).not.toBeNull();
  });

  it("aislamiento entre properties: el codigo de otra property no se empareja", async () => {
    const e = escenario();
    e.reserva("HMAB12CD34", "2026-10-15", "2026-10-20");
    const otra = escenario();
    const r = await importarReportePagos(otra.repo, {
      organizationId: otra.organizationId,
      propertyId: otra.propertyId,
      userId: randomUUID(),
      canal: { id: otra.canal.id, codigo: "airbnb" },
      parseo: parsearReportePagos("airbnb", FIXTURE),
      archivoSha256: "b".repeat(64),
      aplicar: true,
      comisionGestor: { basisPoints: 0, base: "bruto" },
    });
    expect(r.resumen.creadas).toBe(0);
  });
});

describe("movimiento en revision al modificar o cancelar la reserva (equivalente en memoria del trigger de la migracion 035)", () => {
  it("cancelar o cambiar fechas marca requiere_revision con el motivo correcto y NO recalcula el monto", async () => {
    const e = escenario();
    const o1 = e.reserva("HMAB12CD34", "2026-10-15", "2026-10-20");
    const o2 = e.reserva("HMZZ99YY88", "2026-11-01", "2026-11-05");
    await e.importar(FIXTURE);
    expect(await e.repo.listMovimientosEnRevision(e.propertyId, 10)).toEqual([]);
    const antes = await e.repo.findReservaFinanciero(e.propertyId, o1);
    e.store.actualizarRango(o1, "2026-10-16", "2026-10-21");
    e.store.marcarCancelada(o2);
    const revision = await e.repo.listMovimientosEnRevision(e.propertyId, 10);
    expect(revision.map((m) => [m.ocupacionId, m.motivo]).sort()).toEqual([[o1, "reserva_modificada"], [o2, "reserva_cancelada"]].sort());
    expect(await e.repo.findReservaFinanciero(e.propertyId, o1)).toEqual(antes);
    expect(await e.repo.marcarMovimientoRevisado(e.propertyId, o1)).toBe(true);
    expect(await e.repo.marcarMovimientoRevisado(e.propertyId, o1)).toBe(false);
  });
});
