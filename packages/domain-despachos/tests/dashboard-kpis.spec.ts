// D-01 — KPIs gerenciales por cliente y consolidado del despacho (motor puro).
import { describe, expect, it } from "vitest";
import { calcularKpisCliente, consolidarKpisDespacho } from "../src/dashboard/kpis.ts";
import type { EntradaKpisCliente } from "../src/dashboard/kpis.ts";
import type { ReceivableRecord } from "../src/types.ts";
import type { CloseTask, ClosePeriod } from "../src/cierre-mensual/types.ts";

const HOY = "2026-09-30";

function cuenta(id: string, invoiceId: string, fechaVencimiento: string, extra: Partial<ReceivableRecord> = {}): ReceivableRecord {
  return { id, organizationId: "org", propertyId: "p1", invoiceId, fechaVencimiento, montoPagado: null, pagadoEn: null, clienteNombre: "Cliente", clienteEmail: "c@x.mx", createdAt: "2026-01-01T00:00:00Z", ...extra };
}

function periodo(year: number, month: number, status: ClosePeriod["status"] = "open"): ClosePeriod {
  return { id: `per-${year}-${month}`, organizationId: "org", propertyId: "p1", year, month, status, openedAt: "2026-09-01T00:00:00Z", closedAt: null, closedBy: null };
}

function tarea(id: string, periodId: string, status: CloseTask["status"], dueDate: string | null, required = true): CloseTask {
  return { id, periodId, title: id, description: "", category: "cfdi", status, dependsOn: [], dueDate, autoCheckQuery: null, required, completedAt: null, completedBy: null };
}

function base(extra: Partial<EntradaKpisCliente> = {}): EntradaKpisCliente {
  return { propertyId: "p1", nombre: "Cliente Uno SA de CV", hoy: HOY, cartera: null, revisionesPendientes: null, vencimientos: null, cierres: null, cfdiMes: null, ...extra };
}

describe("calcularKpisCliente — cartera y cobranza", () => {
  it("agrega pendiente/vencido/90+/cobrado con los totales reales del CFDI", () => {
    const k = calcularKpisCliente(
      base({
        cartera: {
          cuentas: [
            cuenta("a", "i1", "2026-10-15"), // no vencida
            cuenta("b", "i2", "2026-09-20"), // 10 días vencida
            cuenta("c", "i3", "2026-06-01"), // 121 días -> 90+
            cuenta("d", "i4", "2026-08-01", { pagadoEn: "2026-08-10T00:00:00Z", montoPagado: 500 }),
          ],
          totalPorInvoiceId: new Map([
            ["i1", 1000],
            ["i2", 2000],
            ["i3", 4000],
            ["i4", 700],
          ]),
          historialPorCuenta: new Map(),
        },
      }),
    );
    expect(k.cartera).toMatchObject({ cuentasPendientes: 3, montoPendiente: 7000, cuentasVencidas: 2, montoVencido: 6000, cuentas90Mas: 1, monto90Mas: 4000, cuentasCobradas: 1, montoCobrado: 500 });
    // cobrado 500 / (500 + 7000) = 6.7 %
    expect(k.cartera?.tasaCobranzaPct).toBe(6.7);
    expect(k.cartera?.porAntiguedad["0-30"]).toEqual({ count: 2, monto: 3000 });
    expect(k.cartera?.porAntiguedad["90+"]).toEqual({ count: 1, monto: 4000 });
    expect(k.anomalias.map((a) => a.codigo)).toContain("cartera_90_mas");
    expect(k.nivelAtencion).toBe("critico");
  });

  it("una cuenta cuyo CFDI no aparece se cuenta con monto 0 y se declara, no se inventa", () => {
    const k = calcularKpisCliente(base({ cartera: { cuentas: [cuenta("a", "falta", "2026-10-15")], totalPorInvoiceId: new Map(), historialPorCuenta: new Map() } }));
    expect(k.cartera?.cuentasSinMonto).toBe(1);
    expect(k.cartera?.montoPendiente).toBe(0);
  });

  it("cuenta pagada sin montoPagado cobra el total del CFDI; sin cartera la tasa es null", () => {
    const pagada = calcularKpisCliente(base({ cartera: { cuentas: [cuenta("a", "i1", "2026-08-01", { pagadoEn: "2026-08-02T00:00:00Z" })], totalPorInvoiceId: new Map([["i1", 900]]), historialPorCuenta: new Map() } }));
    expect(pagada.cartera?.montoCobrado).toBe(900);
    expect(pagada.cartera?.tasaCobranzaPct).toBe(100);
    const vacia = calcularKpisCliente(base({ cartera: { cuentas: [], totalPorInvoiceId: new Map(), historialPorCuenta: new Map() } }));
    expect(vacia.cartera?.tasaCobranzaPct).toBeNull();
    expect(vacia.cartera?.scorePromedio).toBeNull();
  });

  it("detecta cuentas sin correo de contacto como anomalía baja que no escala el nivel", () => {
    const k = calcularKpisCliente(base({ cartera: { cuentas: [cuenta("a", "i1", "2026-10-15", { clienteEmail: null })], totalPorInvoiceId: new Map([["i1", 100]]), historialPorCuenta: new Map() } }));
    expect(k.cartera?.cuentasSinCorreo).toBe(1);
    expect(k.anomalias).toEqual([expect.objectContaining({ codigo: "cuenta_sin_correo", severidad: "baja" })]);
    expect(k.nivelAtencion).toBe("al_corriente");
  });
});

describe("calcularKpisCliente — carga de trabajo, vencimientos y cierre", () => {
  it("cuenta revisiones, vencimientos abiertos/vencidos/próximos y tareas de cierre", () => {
    const k = calcularKpisCliente(
      base({
        revisionesPendientes: [
          { id: "r1", createdAt: "2026-09-29T10:00:00Z" },
          { id: "r2", createdAt: "2026-09-10T10:00:00Z" }, // 20 días: antigua
        ],
        vencimientos: [
          { id: "v1", tipo: "IVA", estado: "pendiente", fechaLimite: "2026-09-17" }, // vencido
          { id: "v2", tipo: "ISR", estado: "en_proceso", fechaLimite: "2026-10-03" }, // próximo (3 días)
          { id: "v3", tipo: "DIOT", estado: "completado", fechaLimite: "2026-09-17" },
        ],
        cierres: [{ periodo: periodo(2026, 8), tareas: [tarea("t1", "per-2026-8", "pending", "2026-09-05"), tarea("t2", "per-2026-8", "done", "2026-09-05")] }],
      }),
    );
    expect(k.cargaTrabajo).toMatchObject({ revisionesPendientes: 2, revisionesAntiguas: 1, vencimientosAbiertos: 2, vencimientosVencidos: 1, vencimientosProximos: 1, tareasCierrePendientes: 1, tareasCierreVencidas: 1, totalPendientes: 5 });
    expect(k.cierres?.periodosSinCerrar).toBe(1);
    // Con una tarea requerida vencida el período es "vencido" aunque el estado guardado siga "open".
    expect(k.cierres?.periodosVencidos).toBe(1);
    expect(k.cierres?.mesAnterior).toEqual({ year: 2026, month: 8, estado: "vencido" });
    expect(k.anomalias.map((a) => a.codigo).sort()).toEqual(["cierre_vencido", "revision_cfdi_antigua", "vencimiento_proximo", "vencimiento_vencido"]);
  });

  it("mes anterior sin período registrado es una anomalía baja; enero mira a diciembre del año previo", () => {
    const k = calcularKpisCliente(base({ hoy: "2026-01-15", cierres: [] }));
    expect(k.cierres?.mesAnterior).toEqual({ year: 2025, month: 12, estado: "sin_periodo" });
    expect(k.anomalias).toEqual([expect.objectContaining({ codigo: "cierre_mes_anterior_sin_periodo", severidad: "baja" })]);
  });

  it("período cerrado no suma pendientes ni vencidas", () => {
    const k = calcularKpisCliente(base({ cierres: [{ periodo: periodo(2026, 8, "closed"), tareas: [tarea("t1", "per-2026-8", "pending", "2026-09-05")] }] }));
    expect(k.cierres).toMatchObject({ periodosSinCerrar: 0, periodosVencidos: 0 });
    expect(k.cargaTrabajo?.tareasCierrePendientes).toBe(0);
    expect(k.cierres?.mesAnterior.estado).toBe("cerrado");
  });

  it("CFDI inválidos y con revisión del mes", () => {
    const k = calcularKpisCliente(
      base({
        cfdiMes: [
          { valido: true, requiresHumanReview: false },
          { valido: false, requiresHumanReview: true },
        ],
      }),
    );
    expect(k.cfdiMes).toEqual({ periodo: "2026-09", total: 2, invalidos: 1, requierenRevision: 1 });
    expect(k.anomalias.map((a) => a.codigo)).toEqual(["cfdi_invalido"]);
    expect(k.nivelAtencion).toBe("atencion");
  });
});

describe("calcularKpisCliente — fuentes no disponibles (base sin migrar)", () => {
  it("todas las fuentes null -> sin_datos, nada de ceros inventados", () => {
    const k = calcularKpisCliente(base());
    expect(k.nivelAtencion).toBe("sin_datos");
    expect(k.cartera).toBeNull();
    expect(k.cargaTrabajo).toBeNull();
    expect(k.cierres).toBeNull();
    expect(k.cfdiMes).toBeNull();
    expect([...k.fuentesNoDisponibles].sort()).toEqual(["cartera", "cfdi", "cierre", "revisiones", "vencimientos"]);
  });

  it("una fuente caída solo anula su bloque; las demás siguen calculándose", () => {
    const k = calcularKpisCliente(base({ cartera: null, vencimientos: [{ id: "v", tipo: "IVA", estado: "pendiente", fechaLimite: "2026-09-17" }], revisionesPendientes: [], cierres: [], cfdiMes: [] }));
    expect(k.fuentesNoDisponibles).toEqual(["cartera"]);
    expect(k.cartera).toBeNull();
    expect(k.cargaTrabajo?.vencimientosVencidos).toBe(1);
    expect(k.nivelAtencion).toBe("critico");
  });
});

describe("consolidarKpisDespacho", () => {
  const critico = calcularKpisCliente(
    base({ propertyId: "pA", nombre: "B Cliente", cartera: { cuentas: [cuenta("a", "i1", "2026-06-01")], totalPorInvoiceId: new Map([["i1", 4000]]), historialPorCuenta: new Map() }, revisionesPendientes: [], vencimientos: [], cierres: [], cfdiMes: [] }),
  );
  const sano = calcularKpisCliente(
    base({ propertyId: "pB", nombre: "A Cliente", cartera: { cuentas: [cuenta("b", "i2", "2026-10-30", { pagadoEn: "2026-09-01T00:00:00Z", montoPagado: 1000 })], totalPorInvoiceId: new Map([["i2", 1000]]), historialPorCuenta: new Map() }, revisionesPendientes: [], vencimientos: [], cierres: [{ periodo: periodo(2026, 8, "closed"), tareas: [] }], cfdiMes: [] }),
  );
  const sinDatos = calcularKpisCliente(base({ propertyId: "pC", nombre: "C Cliente" }));

  it("suma solo las fuentes disponibles y ordena por urgencia", () => {
    const d = consolidarKpisDespacho([sano, sinDatos, critico]);
    expect(d.totalClientes).toBe(3);
    expect(d.clientesPorNivel).toEqual({ critico: 1, atencion: 0, al_corriente: 1, sin_datos: 1 });
    expect(d.cartera).toMatchObject({ clientesConDato: 2, montoPendiente: 4000, monto90Mas: 4000, montoCobrado: 1000, tasaCobranzaPct: 20 });
    expect(d.ranking.map((c) => c.propertyId)).toEqual(["pA", "pB", "pC"]);
    expect(d.cierres?.clientesMesAnteriorSinCerrar).toBe(1);
    expect(d.fuentesNoDisponibles).toContain("cartera");
  });

  it("despacho sin clientes: bloques null, no ceros", () => {
    const d = consolidarKpisDespacho([]);
    expect(d).toMatchObject({ totalClientes: 0, cartera: null, cargaTrabajo: null, cierres: null, ranking: [] });
  });
});
