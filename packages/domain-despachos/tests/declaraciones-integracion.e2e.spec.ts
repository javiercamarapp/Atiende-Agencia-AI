// Test de integración end-to-end (Fase 2, requerido por la tarea) — encadena las TRES
// capas reales, sin mocks: CFDI entrante -> `validarCfdiDespachos` (Fase 1) ->
// `InMemoryDespachosRepository.insertInvoice`/`listInvoices` con el nuevo filtro
// `periodo` (Fase 2, aditivo) -> `agregarDiot` (Fase 2). Ejercita exactamente el flujo
// que el diseño Fase 2 §3.2 anota como uso previsto en apps/api (`GET
// /despachos/:propertyId/diot/:periodo`): "llama repo.listInvoices(propertyId,
// {periodo}), aplana invoice.diot.proveedoresReportables de cada uno, y llama
// agregarDiot(...)" — sin releer los CFDI crudos.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryDespachosRepository } from "../src/in-memory-repository.ts";
import { validarCfdiDespachos } from "../src/cfdi/reglas-fiscales-avanzadas.ts";
import type { DatosCfdiDespachos } from "../src/cfdi/reglas-fiscales-avanzadas.ts";
import { agregarDiot } from "../src/declaraciones/diot-aggregate.ts";
import type { RegistroDiotCandidato } from "../src/declaraciones/types.ts";
import type { InvoiceRecord, NewInvoiceInput } from "../src/types.ts";

function cfdiIngreso(overrides: Partial<DatosCfdiDespachos> = {}): DatosCfdiDespachos {
  return {
    tipo: "I",
    subtotal: 1000,
    total: 1160,
    descuento: 0,
    iva: 160,
    conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000 }],
    usoCfdi: "G03",
    formaPago: "03",
    metodoPago: "PUE",
    regimenFiscalEmisor: "601",
    rfcEmisor: "CON950820K12",
    emisorNombre: "PROVEEDOR DE PRUEBA SA DE CV",
    rfcReceptor: "DESP010101AB1",
    tieneSello: true,
    noCertificado: "00001000000504465028",
    folioFiscal: randomUUID(),
    fecha: "2026-07-01T10:00:00",
    fechaTimbrado: "2026-07-01T10:05:00",
    ...overrides,
  };
}

/** Puerto directo del enganche anotado en el diseño §3.2: aplana un `InvoiceRecord`
 * (ya persistido, ya validado por Fase 1) a los `RegistroDiotCandidato` que
 * `agregarDiot` necesita, SIN releer el CFDI crudo — usa lo que
 * `validarCfdiDespachos` ya calculó y el repositorio ya guardó. */
function aplanarParaDiot(invoice: InvoiceRecord): RegistroDiotCandidato[] {
  return invoice.diot.proveedoresReportables.map((p) => ({
    rfcEmisor: p.rfcProveedor,
    nombreEmisor: p.nombreProveedor,
    subtotal: invoice.subtotal,
    ivaTrasladado: invoice.iva ?? 0,
    ivaAcreditable: Number(p.ivaAcreditable),
    tasaIva: p.tasaIva ?? 0.16,
    tipoOperacion: p.tipoOperacion ?? undefined,
    tipoCambio: p.tipoCambio ?? 1,
    moneda: p.moneda ?? "MXN",
    fecha: p.fecha ?? "",
  }));
}

describe("integración e2e: CFDI -> validarCfdiDespachos -> repositorio (filtro período) -> agregarDiot", () => {
  it("agrega correctamente 2 CFDI del mismo proveedor en el período y EXCLUYE uno de otro período", async () => {
    const repo = new InMemoryDespachosRepository();
    const organizationId = randomUUID();
    const propertyId = randomUUID();

    async function ingerir(datos: DatosCfdiDespachos): Promise<InvoiceRecord> {
      const resultado = validarCfdiDespachos(datos);
      const input: NewInvoiceInput = {
        organizationId,
        propertyId,
        folioFiscal: datos.folioFiscal,
        tipo: datos.tipo as NewInvoiceInput["tipo"],
        rfcEmisor: datos.rfcEmisor,
        rfcReceptor: datos.rfcReceptor,
        emisorNombre: datos.emisorNombre ?? null,
        subtotal: datos.subtotal,
        total: datos.total,
        iva: datos.iva ?? null,
        descuento: datos.descuento ?? 0,
        categoria: "sin_clasificar",
        valido: resultado.ok,
        issues: resultado.issues,
        warnings: resultado.warnings,
        requiresHumanReview: resultado.requiresHumanReview,
        diot: resultado.diot,
        fecha: (datos.fecha ?? new Date().toISOString()).slice(0, 10),
      };
      return repo.insertInvoice(input);
    }

    // 2 CFDI del mismo proveedor en julio 2026 (16% IVA), clasificados explícitamente
    // por el contador como servicios profesionales ("03") -- tipoOperacion NUNCA se
    // deriva de la tasa de IVA (ver corrección hallazgo "DIOT con tasa mal
    // codificada", diot-aggregate.ts).
    await ingerir(cfdiIngreso({ fecha: "2026-07-05T09:00:00", fechaTimbrado: "2026-07-05T09:02:00", subtotal: 5000, total: 5800, iva: 800, tipoOperacion: "03" }));
    await ingerir(cfdiIngreso({ fecha: "2026-07-20T09:00:00", fechaTimbrado: "2026-07-20T09:02:00", subtotal: 3000, total: 3480, iva: 480, tipoOperacion: "03" }));
    // 1 CFDI del mismo proveedor pero de OTRO período (junio 2026) — no debe colarse.
    await ingerir(cfdiIngreso({ fecha: "2026-06-15T09:00:00", fechaTimbrado: "2026-06-15T09:02:00", subtotal: 9999, total: 11598.84, iva: 1599.84, tipoOperacion: "03" }));
    // 1 CFDI de un RFC genérico en julio — debe desaparecer en la agregación DIOT
    // (RMF 3.10.7), aunque sí quede persistido como invoice.
    await ingerir(cfdiIngreso({ rfcEmisor: "XAXX010101000", emisorNombre: "PUBLICO EN GENERAL", fecha: "2026-07-10T09:00:00", fechaTimbrado: "2026-07-10T09:02:00" }));

    const invoicesJulio = await repo.listInvoices(propertyId, { periodo: "2026-07" });
    expect(invoicesJulio.length).toBe(3); // 2 del proveedor + 1 genérico (persistido, no filtrado aquí)

    const candidatos = invoicesJulio.flatMap(aplanarParaDiot);
    const diot = agregarDiot(candidatos, "DESP010101AB1", "2026-07");

    // El genérico desaparece en la agregación; solo queda 1 registro (mismo RFC+tasa).
    expect(diot.registros.length).toBe(1);
    const registro = diot.registros[0]!;
    expect(registro.rfcTercero).toBe("CON950820K12");
    expect(registro.tipoOperacion).toBe("03");
    expect(registro.count).toBe(2);
    expect(registro.montoNeto).toBe(8000); // 5000 + 3000, el de junio NO se incluyó
    expect(registro.ivaTrasladado16).toBe(1280); // 800 + 480

    expect(diot.totalMontoNeto).toBe(8000);
    expect(diot.totalIvaTrasladado).toBe(1280);
    expect(diot.periodo).toBe("2026-07");
  });

  it("la validación de Fase 1 (requiresHumanReview, DIOT reportable) sigue intacta al fluir hacia Fase 2", async () => {
    const repo = new InMemoryDespachosRepository();
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const datos = cfdiIngreso();
    const resultado = validarCfdiDespachos(datos);

    expect(resultado.diot.reportable).toBe(true);
    expect(resultado.requiresHumanReview).toBe(true);

    const invoice = await repo.insertInvoice({
      organizationId,
      propertyId,
      folioFiscal: datos.folioFiscal,
      tipo: "I",
      rfcEmisor: datos.rfcEmisor,
      rfcReceptor: datos.rfcReceptor,
      emisorNombre: datos.emisorNombre ?? null,
      subtotal: datos.subtotal,
      total: datos.total,
      iva: datos.iva ?? null,
      descuento: 0,
      categoria: "sin_clasificar",
      valido: resultado.ok,
      issues: resultado.issues,
      warnings: resultado.warnings,
      requiresHumanReview: resultado.requiresHumanReview,
      diot: resultado.diot,
      fecha: (datos.fecha ?? new Date().toISOString()).slice(0, 10),
    });

    expect(invoice.diot.proveedoresReportables[0]!.tasaIva).toBeCloseTo(0.16, 4);
    expect(invoice.diot.proveedoresReportables[0]!.moneda).toBe("MXN");

    const candidatos = aplanarParaDiot(invoice);
    const diot = agregarDiot(candidatos, "DESP010101AB1", "2026-07");
    // Sin tipoOperacion explícito en el CFDI de entrada -> "85" (Otros), nunca
    // derivado de la tasa de IVA (16%) — ver corrección hallazgo "DIOT con tasa mal
    // codificada".
    expect(diot.registros[0]!.tipoOperacion).toBe("85");
  });
});
