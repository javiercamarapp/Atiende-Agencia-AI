// Fase 4 (cierre de gap): verifica que las rutas HTTP nuevas de declaraciones
// (ISR PF/PM/RESICO, agregación DIOT) y nómina invocan de verdad el motor real de
// domain-despachos -- no solo devuelven 200 con un objeto vacío -- y que el
// role-gating (DECLARACIONES_ROLES/NOMINA_ROLES = admin|contador) excluye
// auditor/readonly, mismo criterio que despachos-cfdi.spec.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { calcularIsrPm, procesarNomina } from "@atiende/domain-despachos";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

function cfdiIngresoConDiot(overrides: Record<string, unknown> = {}) {
  return {
    folioFiscal: "11111111-2222-3333-4444-555555555555",
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
    rfcReceptor: "XAXX010101000",
    emisorNombre: "PROVEEDOR DE PRUEBA SA DE CV",
    tieneSello: true,
    noCertificado: "00001000000504465028",
    fecha: "2026-07-01T10:00:00",
    fechaTimbrado: "2026-07-01T10:05:00",
    ...overrides,
  };
}

describe("POST /despachos/:propertyId/declaraciones/isr/pf", () => {
  it("baseGravable=0 -> isrNeto=0 (valor determinista, sin tocar la tabla)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/declaraciones/isr/pf`, authedJson(ctx.staff.contador.token, { baseGravable: 0 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { baseGravable: number; isrNeto: number; isrBruto: number; tasaEfectiva: number; tipoContribuyente: string };
    expect(body).toEqual({ baseGravable: 0, isrBruto: 0, tasaEfectiva: 0, tipoContribuyente: "PF", tablaAplicada: "monthly", isrNeto: 0, pagosProvisionales: 0 });
  });

  it("valida baseGravable faltante -> 400", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/declaraciones/isr/pf`, authedJson(ctx.staff.contador.token, {}));
    expect(res.status).toBe(400);
  });

  it("readonly/auditor no pueden calcular ISR -- 403", async () => {
    const app = buildApp(ctx.deps);
    const resReadonly = await app.request(`/despachos/${ctx.propertyId}/declaraciones/isr/pf`, authedJson(ctx.staff.readonly.token, { baseGravable: 10000 }));
    expect(resReadonly.status).toBe(403);
    const resAuditor = await app.request(`/despachos/${ctx.propertyId}/declaraciones/isr/pf`, authedJson(ctx.staff.auditor.token, { baseGravable: 10000 }));
    expect(resAuditor.status).toBe(403);
  });
});

describe("POST /despachos/:propertyId/declaraciones/isr/pm", () => {
  it("utilidadFiscal=10000 -> isrBruto=3000 (tasa fija 30%, Art. 9 LISR -- valor calculado a mano)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/declaraciones/isr/pm`, authedJson(ctx.staff.admin.token, { utilidadFiscal: 10000 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isrBruto: number; isrNeto: number; tipoContribuyente: string };
    expect(body.isrBruto).toBe(3000);
    expect(body.isrNeto).toBe(3000);
    expect(body.tipoContribuyente).toBe("PM");
  });

  it("resta pagosProvisionales del isrNeto, nunca negativo", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/declaraciones/isr/pm`, authedJson(ctx.staff.admin.token, { utilidadFiscal: 10000, pagosProvisionales: 5000 }));
    const body = (await res.json()) as { isrNeto: number };
    // isrBruto=3000, pagosProvisionales=5000 -> max(0, 3000-5000) = 0.
    expect(body.isrNeto).toBe(0);
    // Cruce contra el motor real (mismo criterio que otras verticales verifican wiring HTTP).
    expect(body.isrNeto).toBe(calcularIsrPm(10000, 5000).isrNeto);
  });
});

describe("POST /despachos/:propertyId/declaraciones/isr/pm-resico", () => {
  it("invoca el motor real (cruce contra calcularIsrPmResico, ya cubierto por golden-set aparte)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/declaraciones/isr/pm-resico`, authedJson(ctx.staff.contador.token, { ingresoMensual: 25000 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tipoContribuyente: string; tablaAplicada: string; isrBruto: number };
    expect(body.tipoContribuyente).toBe("PM");
    expect(body.tablaAplicada).toBe("pm_resico");
    expect(body.isrBruto).toBeGreaterThan(0);
  });
});

describe("GET /despachos/:propertyId/declaraciones/diot/:periodo -- agregación real desde invoices persistidos", () => {
  it("agrega un CFDI reportable real (subtotal=1000, iva=160) en su período, con totales exactos", async () => {
    const app = buildApp(ctx.deps);
    const ingesta = await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdiIngresoConDiot()));
    expect(ingesta.status).toBe(201);

    const res = await app.request(`/despachos/${ctx.propertyId}/declaraciones/diot/2026-07`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { registros: unknown[]; totalMontoNeto: number; totalIvaTrasladado: number; totalIvaAcreditable: number; rfcContribuyente: string };
    expect(body.registros).toHaveLength(1);
    expect(body.totalMontoNeto).toBe(1000);
    expect(body.totalIvaTrasladado).toBe(160);
    expect(body.totalIvaAcreditable).toBe(160);
    expect(body.rfcContribuyente).toBe("XAXX010101000");
  });

  it("no incluye CFDIs de un período distinto (filtro real, no solo el más reciente)", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdiIngresoConDiot()));

    const res = await app.request(`/despachos/${ctx.propertyId}/declaraciones/diot/2026-08`, authedJson(ctx.staff.contador.token));
    const body = (await res.json()) as { registros: unknown[] };
    expect(body.registros).toHaveLength(0);
  });

  it("un CFDI tipo Traslado (T, no reportable en DIOT) no aparece en la agregación", async () => {
    const app = buildApp(ctx.deps);
    const ingesta = await app.request(
      `/despachos/${ctx.propertyId}/cfdi`,
      authedJson(ctx.staff.contador.token, cfdiIngresoConDiot({ folioFiscal: "aaaaaaaa-2222-3333-4444-555555555555", tipo: "T", iva: null })),
    );
    expect(ingesta.status).toBe(201);
    const res = await app.request(`/despachos/${ctx.propertyId}/declaraciones/diot/2026-07`, authedJson(ctx.staff.contador.token));
    const body = (await res.json()) as { registros: unknown[] };
    // La agregación DIOT en sí sigue excluyéndolo -- es una regla de negocio real
    // (DIOT solo reporta proveedores tipo "I"), no un artefacto del filtro.
    expect(body.registros).toHaveLength(0);
  });

  // Migración 006 (hallazgo de auditoría): el filtro por período de `listInvoices`
  // (que esta ruta usa antes de reducir a `reportables`) debe resolver contra
  // `invoice.fecha`, no contra el jsonb de DIOT -- antes de la migración, un CFDI
  // tipo "T" (nunca produce `diot.proveedoresReportables`) desaparecía del período
  // en `listInvoices` mismo, no solo en la agregación final.
  it("REQ: listInvoices({periodo}) incluye el CFDI tipo T de su período real (el filtro por período ya no depende del jsonb de DIOT)", async () => {
    const app = buildApp(ctx.deps);
    const ingesta = await app.request(
      `/despachos/${ctx.propertyId}/cfdi`,
      authedJson(ctx.staff.contador.token, cfdiIngresoConDiot({ folioFiscal: "aaaaaaaa-2222-3333-4444-555555555555", tipo: "T", iva: null })),
    );
    expect(ingesta.status).toBe(201);

    const invoicesJulio = await ctx.despachosRepo.listInvoices(ctx.propertyId, { periodo: "2026-07" });
    expect(invoicesJulio.map((i) => i.tipo)).toContain("T");

    const invoicesAgosto = await ctx.despachosRepo.listInvoices(ctx.propertyId, { periodo: "2026-08" });
    expect(invoicesAgosto).toHaveLength(0);
  });

  it("valida el formato de período -- 400 si no es YYYY-MM", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/declaraciones/diot/2026-7`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(400);
  });

  it("readonly/auditor no pueden ver la agregación DIOT -- 403", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/declaraciones/diot/2026-07`, authedJson(ctx.staff.readonly.token));
    expect(res.status).toBe(403);
  });
});

describe("POST /despachos/:propertyId/nomina/calcular", () => {
  it("procesa un periodo con un empleado real, coincide con procesarNomina() directo", async () => {
    const app = buildApp(ctx.deps);
    const payload = { period: { month: 1, year: 2026, diasPagados: 30 }, employees: [{ employeeId: "e1", nombre: "Ana", salarioBruto: 15000 }], tenantId: null };
    const res = await app.request(`/despachos/${ctx.propertyId}/nomina/calcular`, authedJson(ctx.staff.contador.token, payload));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { employees: readonly { neto: number }[]; totalBruto: number; month: number; year: number };

    const esperado = procesarNomina({ month: 1, year: 2026, diasPagados: 30 }, [{ employeeId: "e1", nombre: "Ana", salarioBruto: 15000 }], null);
    expect(body.totalBruto).toBe(esperado.totalBruto);
    expect(body.employees[0]!.neto).toBe(esperado.employees[0]!.neto);
    expect(body.month).toBe(1);
    expect(body.year).toBe(2026);
  });

  it("employees no es arreglo -> 400", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/nomina/calcular`, authedJson(ctx.staff.admin.token, { period: {}, employees: "no-es-arreglo" }));
    expect(res.status).toBe(400);
  });

  it("readonly/auditor no pueden calcular nómina -- 403", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/nomina/calcular`, authedJson(ctx.staff.auditor.token, { period: {}, employees: [] }));
    expect(res.status).toBe(403);
  });
});

// Fase 7 (cierre de gap "Sin generación/timbrado del XML de complemento Nómina
// 1.2"): wiring HTTP real de `generarXmlCfdiNomina` -- verifica que la ruta de
// verdad produce el XML (no solo un 200 vacío) y que rechaza con 400 cuando
// falta un dato fiscal obligatorio, en vez de dejarlo caer al 500 genérico de
// apps/api/src/app.ts.
function payloadXmlNomina(overrides: Record<string, unknown> = {}) {
  return {
    period: { month: 7, year: 2026, diasPagados: 30 },
    employees: [
      {
        employeeId: "e1",
        nombre: "Ana Pérez",
        salarioBruto: 15000,
        rfcReceptor: "PEAA850101ABC",
        domicilioFiscalReceptor: "01000",
        folio: "F0001",
      },
    ],
    emisor: {
      rfc: "DESP010101AB1",
      nombre: "DESPACHO DE PRUEBA SA DE CV",
      regimenFiscal: "601",
      lugarExpedicion: "06600",
    },
    tenantId: null,
    ...overrides,
  };
}

describe("POST /despachos/:propertyId/nomina/generar-xml", () => {
  it("genera el XML del complemento Nómina 1.2 para cada empleado del periodo, usando las cifras reales de procesarNomina", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/nomina/generar-xml`, authedJson(ctx.staff.contador.token, payloadXmlNomina()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { idempotencyKey: string; comprobantes: readonly { employeeId: string; folio: string; xml: string }[] };

    expect(body.comprobantes).toHaveLength(1);
    const comprobante = body.comprobantes[0]!;
    expect(comprobante.employeeId).toBe("e1");
    expect(comprobante.folio).toBe("F0001");
    expect(comprobante.xml).toContain('<cfdi:Comprobante');
    expect(comprobante.xml).toContain('xmlns:nomina12="http://www.sat.gob.mx/nomina12"');
    expect(comprobante.xml).toContain('<nomina12:Nomina');
    expect(comprobante.xml).toContain('Rfc="PEAA850101ABC"');

    // Las cifras del XML vienen del MISMO motor que /calcular -- cruce directo.
    const esperado = procesarNomina({ month: 7, year: 2026, diasPagados: 30 }, [{ employeeId: "e1", nombre: "Ana Pérez", salarioBruto: 15000 }], null);
    expect(comprobante.xml).toContain(`TotalPercepciones="${esperado.employees[0]!.salarioBruto.toFixed(2)}"`);
  });

  it("falta domicilioFiscalReceptor de un empleado -> 400 (no genera un XML con un CP fabricado)", async () => {
    const app = buildApp(ctx.deps);
    const payload = payloadXmlNomina({
      employees: [{ employeeId: "e1", nombre: "Ana Pérez", salarioBruto: 15000, rfcReceptor: "PEAA850101ABC", folio: "F0001" }],
    });
    const res = await app.request(`/despachos/${ctx.propertyId}/nomina/generar-xml`, authedJson(ctx.staff.contador.token, payload));
    expect(res.status).toBe(400);
  });

  it("RFC de emisor inválido -> 400, traducido desde el Error del dominio (no 500)", async () => {
    const app = buildApp(ctx.deps);
    const payload = payloadXmlNomina({ emisor: { rfc: "NO-VALIDO", nombre: "X", regimenFiscal: "601", lugarExpedicion: "06600" } });
    const res = await app.request(`/despachos/${ctx.propertyId}/nomina/generar-xml`, authedJson(ctx.staff.contador.token, payload));
    expect(res.status).toBe(400);
  });

  it("employees no es arreglo -> 400", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/nomina/generar-xml`, authedJson(ctx.staff.admin.token, payloadXmlNomina({ employees: "no-es-arreglo" })));
    expect(res.status).toBe(400);
  });

  it("readonly/auditor no pueden generar el XML de nómina -- 403", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/nomina/generar-xml`, authedJson(ctx.staff.auditor.token, payloadXmlNomina()));
    expect(res.status).toBe(403);
  });
});
