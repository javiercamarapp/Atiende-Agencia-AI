// Cierre de gap de auditoría (ver TAREA): "no existe ninguna forma de cargar un
// CFDI real desde el producto" -- `POST /despachos/:propertyId/cfdi/importar-xml`
// recibe el XML crudo del CFDI y delega en EXACTAMENTE el mismo flujo de ingesta
// que `POST /despachos/:propertyId/cfdi` (ver `ingestarCfdiDespachos` en
// apps/api/.../despachos/cfdi.ts) -- estas pruebas confirman que ambas rutas
// terminan en el mismo lugar (mismo `requiresHumanReview`, mismo idempotency por
// folio fiscal, mismos roles) y que un XML inválido nunca se traga en silencio.
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

interface CfdiXmlOptions {
  readonly tipo?: string;
  readonly folioFiscal?: string;
  readonly incluirTimbre?: boolean;
}

/** Mismo CFDI (RFC, montos, catálogos) que `cfdiIngresoConDiot()` de
 * despachos-cfdi.spec.ts, pero como XML crudo -- para que ambas rutas de
 * ingesta se puedan comparar con los mismos datos de fondo. */
function cfdiXml(opts: CfdiXmlOptions = {}): string {
  const { tipo = "I", folioFiscal = "11111111-2222-3333-4444-555555555555", incluirTimbre = true } = opts;
  const complemento = incluirTimbre
    ? `<cfdi:Complemento>
        <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="${folioFiscal}" FechaTimbrado="2026-07-01T10:05:00" SelloCFD="abc" NoCertificadoSAT="def" SelloSAT="ghi"/>
      </cfdi:Complemento>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
  Version="4.0" Fecha="2026-07-01T10:00:00" Sello="AbCdEf1234==" FormaPago="03" NoCertificado="00001000000504465028"
  Certificado="MIIF" SubTotal="1000.00" Moneda="MXN" Total="1160.00" TipoDeComprobante="${tipo}" Exportacion="01" MetodoPago="PUE" LugarExpedicion="06000">
  <cfdi:Emisor Rfc="CON950820K12" Nombre="PROVEEDOR DE PRUEBA SA DE CV" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="PUBLICO EN GENERAL" DomicilioFiscalReceptor="06000" RegimenFiscalReceptor="616" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="80131500" Cantidad="1" ClaveUnidad="E48" Descripcion="Honorarios" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02">
      <cfdi:Impuestos>
        <cfdi:Traslados>
          <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>
        </cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="160.00">
    <cfdi:Traslados>
      <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>
    </cfdi:Traslados>
  </cfdi:Impuestos>
  ${complemento}
</cfdi:Comprobante>`;
}

function xmlRequest(token: string, xml: string): RequestInit {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/xml", "content-length": String(new TextEncoder().encode(xml).byteLength) },
    body: xml,
  };
}

describe("POST /despachos/:propertyId/cfdi/importar-xml — ingesta desde un CFDI XML real", () => {
  it("ingesta un CFDI 4.0 válido y llega al MISMO resultado que POST /cfdi con el JSON equivalente (requiresHumanReview=true, DIOT reportable)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, xmlRequest(ctx.staff.contador.token, cfdiXml()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      folioFiscal: string;
      rfcEmisor: string;
      total: number;
      categoria: string;
      requiereRevisionHumana: boolean;
      diot: { reportable: boolean };
      fecha: string;
    };
    expect(body.folioFiscal).toBe("11111111-2222-3333-4444-555555555555");
    expect(body.rfcEmisor).toBe("CON950820K12");
    expect(body.total).toBe(1160);
    expect(body.fecha).toBe("2026-07-01");
    expect(body.categoria).toBe("sin_clasificar"); // el XML del SAT nunca trae clasificación contable
    expect(body.requiereRevisionHumana).toBe(true);
    expect(body.diot.reportable).toBe(true);

    const pendientes = await ctx.despachosRepo.listPendingReviews(ctx.propertyId);
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0]!.invoiceId).toBe(body.id);
  });

  it("REQ: reingestar el mismo UUID de timbre (folio fiscal) vía XML nunca duplica el CFDI -- 409 conflict, mismo candado que POST /cfdi", async () => {
    const app = buildApp(ctx.deps);
    const primero = await app.request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, xmlRequest(ctx.staff.contador.token, cfdiXml()));
    expect(primero.status).toBe(201);

    const segundo = await app.request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, xmlRequest(ctx.staff.contador.token, cfdiXml()));
    expect(segundo.status).toBe(409);
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(1);
  });

  it("REQ: el mismo folio fiscal ingestado primero por JSON (POST /cfdi) y luego por XML también choca en 409 -- es UNA sola tabla de invoices", async () => {
    const app = buildApp(ctx.deps);
    const viaJson = await app.request(
      `/despachos/${ctx.propertyId}/cfdi`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.staff.contador.token}`, "content-type": "application/json" },
        body: JSON.stringify({
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
        }),
      },
    );
    expect(viaJson.status).toBe(201);

    const viaXml = await app.request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, xmlRequest(ctx.staff.contador.token, cfdiXml()));
    expect(viaXml.status).toBe(409);
  });

  it("un CFDI limpio de tipo Traslado (T) vía XML no exige revisión humana", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/despachos/${ctx.propertyId}/cfdi/importar-xml`,
      xmlRequest(ctx.staff.contador.token, cfdiXml({ tipo: "T", folioFiscal: "22222222-2222-3333-4444-555555555555" })),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { requiereRevisionHumana: boolean };
    expect(body.requiereRevisionHumana).toBe(false);
  });

  it("un rol readonly no puede importar CFDI por XML (403) -- mismos roles que POST /cfdi", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, xmlRequest(ctx.staff.readonly.token, cfdiXml()));
    expect(res.status).toBe(403);
  });

  it("XML mal formado se rechaza con 400, nunca se ingiere a medias", async () => {
    const app = buildApp(ctx.deps);
    const malformado = '<cfdi:Comprobante Version="4.0"><cfdi:Emisor Rfc="ABC"></cfdi:Comprobante>';
    const res = await app.request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, xmlRequest(ctx.staff.contador.token, malformado));
    expect(res.status).toBe(400);
    expect(await ctx.despachosRepo.listInvoices(ctx.propertyId)).toHaveLength(0);
  });

  it("XML sin tfd:TimbreFiscalDigital (sin folio fiscal) se rechaza con 400", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, xmlRequest(ctx.staff.contador.token, cfdiXml({ incluirTimbre: false })));
    expect(res.status).toBe(400);
  });

  it("un body vacío se rechaza con 400 (no revienta con 500)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, xmlRequest(ctx.staff.contador.token, ""));
    expect(res.status).toBe(400);
  });
});
