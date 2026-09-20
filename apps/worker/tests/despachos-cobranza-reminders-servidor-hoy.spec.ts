// REQ-r6 (seguimiento de PR #164, punto 1 -- LADO SERVIDOR): cuando el scheduler
// externo NO inyecta `todayIsoDate` (el camino real de producción -- el cron nunca manda
// ese parámetro), el default usaba `new Date().toISOString().slice(0, 10)` (día UTC del
// proceso) -- corrido un día adelante del real en CDMX entre las 18:00 y las 23:59 hora
// local (Vercel corre con TZ=UTC). El corte de "¿hoy toca recordatorio?" caía un día
// antes de tiempo en esa ventana. Fix: ahora usa
// `@atiende/core-tenancy::hoyFechaNegocio()`.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import type { NewInvoiceInput } from "@atiende/domain-despachos";
import { runCobranzaReminderSweep } from "../src/jobs/despachos/cobranza-reminders.ts";

let repo: InMemoryDespachosRepository;
let organizationId: string;
let propertyId: string;

function invoiceInput(overrides: Partial<NewInvoiceInput> = {}): NewInvoiceInput {
  return {
    organizationId,
    propertyId,
    folioFiscal: randomUUID(),
    tipo: "I",
    rfcEmisor: "CON950820K12",
    rfcReceptor: "XAXX010101000",
    emisorNombre: "PROVEEDOR",
    subtotal: 1000,
    total: 1160,
    iva: 160,
    descuento: 0,
    categoria: "sin_clasificar",
    valido: true,
    issues: [],
    warnings: [],
    requiresHumanReview: false,
    diot: { proveedoresReportables: [], reportable: false },
    fecha: "2026-08-01",
    ...overrides,
  };
}

beforeEach(() => {
  repo = new InMemoryDespachosRepository();
  organizationId = randomUUID();
  propertyId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "despacho-test", name: "Despacho de Prueba SC" });
  repo.seedDespachosProperty({ id: propertyId, organizationId, name: "Sede principal" });
});

afterEach(() => {
  vi.useRealTimers();
});

// 2026-01-02T04:00:00Z = 2026-01-01T22:00:00 en America/Mexico_City (UTC-6 fijo).
const INSTANTE_22H_CDMX_DIA_1 = "2026-01-02T04:00:00.000Z";

describe("runCobranzaReminderSweep -- default de 'hoy' (sin todayIsoDate inyectado) usa el día de NEGOCIO", () => {
  it("a las 22:00 CDMX, una cuenta cuya etapa 'vencimiento' cae en el día real (2026-01-01) SÍ se detecta", async () => {
    const invoice = await repo.insertInvoice(invoiceInput());
    // fechaVencimiento = "hoy real" (2026-01-01) -> offset 0 -> etapa "vencimiento" (ver
    // COBRANZA_STAGE_OFFSET_DAYS en packages/domain-despachos/src/cobranza/engine.ts).
    await repo.registerReceivable({ organizationId, propertyId, invoiceId: invoice.id, fechaVencimiento: "2026-01-01", clienteNombre: "Cliente A", clienteEmail: "cliente-a@example.com" });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_22H_CDMX_DIA_1));

    // Sin todayIsoDate -- exactamente el camino real del scheduler externo.
    const sweep = await runCobranzaReminderSweep((fn) => fn(repo));

    expect(sweep).toHaveLength(1);
    const orgResult = sweep[0]!;
    expect(orgResult.error).toBeUndefined();
    // Control del bug: con el día UTC roto (mañana, 2026-01-02), el offset real sería -1
    // (ya "vencido" 1 día), que no coincide con NINGUNA etapa exacta de
    // COBRANZA_STAGE_OFFSET_DAYS -> remindersDue: 0. Con el fix, offset 0 -> "vencimiento".
    expect(orgResult.properties).toEqual([{ propertyId, receivablesScanned: 1, remindersDue: 1, emailsEnqueued: 1 }]);
  });
});
