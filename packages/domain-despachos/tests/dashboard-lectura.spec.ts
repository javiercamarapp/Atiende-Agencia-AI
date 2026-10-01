// D-01 — lectura de las fuentes del dashboard: integración con el repositorio en memoria y
// compatibilidad con la base SIN MIGRAR sobre Postgres con transacción abortable
// (AbortAwareFakeSession: reproduce 25P02; una sesión falsa plana NO sirve para esto).
import { describe, expect, it } from "vitest";
import { InMemoryDespachosRepository } from "../src/in-memory-repository.ts";
import { PostgresDespachosRepository } from "../src/postgres-repository.ts";
import { leerKpisCliente } from "../src/dashboard/lectura.ts";
import { DEFAULT_MONTHLY_CLOSE_TEMPLATE } from "../src/cierre-mensual/templates.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const REF = { propertyId: "prop-1", nombre: "Cliente Uno", hoy: "2026-09-30" };

describe("leerKpisCliente — repositorio en memoria", () => {
  it("compone los KPIs desde CFDI, cartera, revisiones, vencimientos y cierre reales", async () => {
    const repo = new InMemoryDespachosRepository();
    const factura = await repo.insertInvoice({
      organizationId: "org-1",
      propertyId: "prop-1",
      folioFiscal: "11111111-1111-1111-1111-111111111111",
      tipo: "I",
      rfcEmisor: "AAA010101AAA",
      rfcReceptor: "CLI010101CL1",
      emisorNombre: "Proveedor",
      subtotal: 1000,
      total: 1160,
      iva: 160,
      descuento: 0,
      categoria: "gasto_operativo",
      valido: false,
      issues: [],
      warnings: [],
      requiresHumanReview: true,
      diot: { proveedoresReportables: [], reportable: false },
      fecha: "2026-09-10",
    });
    await repo.registerReceivable({ organizationId: "org-1", propertyId: "prop-1", invoiceId: factura.id, fechaVencimiento: "2026-05-01", clienteEmail: null });
    await repo.createReview({ organizationId: "org-1", propertyId: "prop-1", invoiceId: factura.id, reason: "revisar" });
    await repo.createDeadline({ organizationId: "org-1", propertyId: "prop-1", tipo: "IVA", periodo: "2026-08", fechaLimite: "2026-09-17", prioridad: "critica" });
    await repo.insertPeriodoCierre({ organizationId: "org-1", propertyId: "prop-1", anio: 2026, mes: 8, template: DEFAULT_MONTHLY_CLOSE_TEMPLATE });

    const k = await leerKpisCliente(repo, REF);

    expect(k.fuentesNoDisponibles).toEqual([]);
    expect(k.cartera).toMatchObject({ cuentasPendientes: 1, montoPendiente: 1160, cuentas90Mas: 1, cuentasSinCorreo: 1 });
    expect(k.cargaTrabajo).toMatchObject({ revisionesPendientes: 1, vencimientosAbiertos: 1, vencimientosVencidos: 1 });
    expect(k.cfdiMes).toEqual({ periodo: "2026-09", total: 1, invalidos: 1, requierenRevision: 1 });
    expect(k.cierres?.periodosSinCerrar).toBe(1);
    expect(k.nivelAtencion).toBe("critico");
  });

  it("aislamiento: no ve datos de otra property", async () => {
    const repo = new InMemoryDespachosRepository();
    await repo.createDeadline({ organizationId: "org-1", propertyId: "otra", tipo: "IVA", periodo: "2026-08", fechaLimite: "2026-09-17", prioridad: "critica" });
    const k = await leerKpisCliente(repo, REF);
    expect(k.cargaTrabajo?.vencimientosAbiertos).toBe(0);
  });
});

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const RE = {
  receivable: /from despachos\.receivable\b/i,
  review: /from despachos\.invoice_review\b/i,
  deadline: /from despachos\.fiscal_deadline\b/i,
  periodo: /from despachos\.periodo_cierre\b/i,
  invoice: /from despachos\.invoice\s/i,
};

describe("leerKpisCliente — compatibilidad con la base sin migrar (REGLA DURA)", () => {
  it("una fuente con tabla inexistente (42P01) queda null y la transacción abortada se recupera para las demás fuentes", async () => {
    const session = new AbortAwareFakeSession([
      { match: RE.receivable, respond: () => pgError("42P01", 'relation "despachos.receivable" does not exist') },
      { match: RE.review, respond: () => [] },
      { match: RE.deadline, respond: () => [] },
      { match: RE.periodo, respond: () => [] },
      { match: RE.invoice, respond: () => [] },
    ]);
    const repo = new PostgresDespachosRepository(session);

    const k = await leerKpisCliente(repo, REF);

    expect(k.fuentesNoDisponibles).toEqual(["cartera"]);
    expect(k.cartera).toBeNull();
    // Las fuentes POSTERIORES al error corrieron sobre la misma sesión sin lanzar 25P02: sin
    // SAVEPOINT este test fallaría con AbortedTransaction. Prueba real del requisito.
    expect(k.cargaTrabajo).toMatchObject({ revisionesPendientes: 0, vencimientosAbiertos: 0 });
    expect(k.cfdiMes?.total).toBe(0);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    // Y la sesión sigue utilizable para lo que haga el request después (p. ej. el COMMIT).
    // (el doble no tiene handler para "select 1": lo que importa es que el error NO sea 25P02, la sesión ya no está abortada)
    await expect(session.query("select 1;")).rejects.not.toMatchObject({ code: "25P02" });
  });

  it("todas las fuentes ausentes (base muy atrás): sin_datos, nunca un error ni ceros", async () => {
    const session = new AbortAwareFakeSession([
      { match: RE.receivable, respond: () => pgError("42P01", 'relation "despachos.receivable" does not exist') },
      { match: RE.review, respond: () => pgError("42P01", 'relation "despachos.invoice_review" does not exist') },
      { match: RE.deadline, respond: () => pgError("42703", 'column "estado" does not exist') },
      { match: RE.periodo, respond: () => pgError("42P01", 'relation "despachos.periodo_cierre" does not exist') },
      { match: RE.invoice, respond: () => pgError("42P01", 'relation "despachos.invoice" does not exist') },
    ]);
    const k = await leerKpisCliente(new PostgresDespachosRepository(session), REF);
    expect(k.nivelAtencion).toBe("sin_datos");
    expect([...k.fuentesNoDisponibles].sort()).toEqual(["cartera", "cfdi", "cierre", "revisiones", "vencimientos"]);
  });

  it("cualquier otro error de Postgres (p. ej. statement_timeout 57014) se repropaga: nunca se enmascara un fallo real", async () => {
    const session = new AbortAwareFakeSession([
      { match: RE.receivable, respond: () => [] },
      { match: RE.review, respond: () => pgError("57014", "canceling statement due to statement timeout") },
    ]);
    await expect(leerKpisCliente(new PostgresDespachosRepository(session), REF)).rejects.toMatchObject({ code: "57014" });
    // El savepoint se revirtió antes de relanzar: la transacción del request quedó utilizable para su manejo de error/ROLLBACK.
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });
});
