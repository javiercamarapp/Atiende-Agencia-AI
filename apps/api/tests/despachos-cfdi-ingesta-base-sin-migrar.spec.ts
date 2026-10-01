// D-21/D-22 (migracion 018) -- REGLA DURA de compatibilidad: mergear despliega el codigo y la base real va por detras.
// La ingesta de CFDI corre en UNA transaccion (la del request): consultar la ficha de cartera (tabla inexistente, 42P01) e
// insertar el invoice con las columnas nuevas (42703) NO deben abortarla (25P02) -- el flujo que hoy funciona (insert
// historico + cola de revision) tiene que seguir y terminar en 201. Este doble modela una conexion Postgres real: estado
// abortado tras cualquier error, SAVEPOINT/ROLLBACK TO y 3B001 ante savepoints inexistentes.
import { beforeEach, describe, expect, it } from "vitest";
import { PostgresCarteraRepository, PostgresDespachosRepository } from "@atiende/domain-despachos";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const FILA_INVOICE = {
  id: "00000000-0000-0000-0000-0000000000a1", organization_id: "o", property_id: "p", folio_fiscal: "11111111-2222-3333-4444-555555555555", tipo: "I", rfc_emisor: "CON950820K12", rfc_receptor: "XAXX010101000",
  emisor_nombre: "E", subtotal: "1000.00", total: "1160.00", iva: "160.00", descuento: "0.00", categoria: "sin_clasificar", confianza: null, valido: true, issues: [], warnings: [], requires_human_review: true,
  diot: { proveedoresReportables: [], reportable: true }, fecha: "2026-07-01", created_at: "2026-07-02T00:00:00Z",
};

class SesionBaseSinMigrar implements TenantDbSession {
  private stack: string[] = [];
  private aborted = false;
  readonly queries: string[] = [];
  readonly migrada: boolean;
  constructor(migrada = false) {
    this.migrada = migrada;
  }

  async query<T>(sql: string): Promise<{ rows: T[] }> {
    await new Promise<void>((r) => setImmediate(r));
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    this.queries.push(q);
    if (this.aborted) throw pgError("25P02", "current transaction is aborted, commands ignored until end of transaction block");
    const falla = (code: string, msg: string): never => {
      this.aborted = true;
      throw pgError(code, msg);
    };
    if (/from despachos\.periodo_cierre/.test(q)) return { rows: [] };
    if (/despachos\.efos_consultar/.test(q)) return falla("42883", "function despachos.efos_consultar(text[]) does not exist");
    if (/from despachos\.cliente_ficha/.test(q)) return this.migrada ? { rows: [] } : falla("42P01", 'relation "despachos.cliente_ficha" does not exist');
    if (/insert into despachos\.invoice \(/.test(q) && /direccion/.test(q)) {
      return this.migrada ? { rows: [FILA_INVOICE as unknown as T] } : falla("42703", 'column "direccion" of relation "invoice" does not exist');
    }
    if (/insert into despachos\.invoice_impuesto/.test(q)) return { rows: [] };
    if (/insert into despachos\.invoice \(/.test(q)) return { rows: [FILA_INVOICE as unknown as T] };
    if (/insert into despachos\.invoice_review/.test(q)) {
      return { rows: [{ id: "r1", organization_id: "o", property_id: "p", invoice_id: FILA_INVOICE.id, reason: "x", status: "pendiente", decision_note: null, resolved_by: null, resolved_at: null, created_at: "2026-07-02T00:00:00Z" } as unknown as T] };
    }
    throw new Error(`consulta no prevista por el doble: ${q.slice(0, 120)}`);
  }

  async exec(sql: string): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
    const s = sql.trim().toLowerCase();
    const name = s.split(/\s+/).pop()!;
    if (s.startsWith("rollback to savepoint")) {
      const i = this.stack.indexOf(name);
      if (i < 0) throw pgError("3B001", `savepoint "${name}" does not exist`);
      this.stack = this.stack.slice(0, i + 1);
      this.aborted = false;
      return;
    }
    if (this.aborted) throw pgError("25P02", "current transaction is aborted, commands ignored until end of transaction block");
    if (s.startsWith("savepoint")) this.stack.push(name);
    else if (s.startsWith("release savepoint")) {
      const i = this.stack.indexOf(name);
      if (i < 0) throw pgError("3B001", `savepoint "${name}" does not exist`);
      this.stack = this.stack.slice(0, i);
    }
  }
  get abierta(): boolean {
    return this.aborted;
  }
  get savepointsAbiertos(): number {
    return this.stack.length;
  }
}

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="2026-07-01T10:00:00" Sello="AbCdEf1234==" FormaPago="03" NoCertificado="00001000000504465028" Certificado="MIIF" SubTotal="1000.00" Moneda="MXN" Total="1160.00" TipoDeComprobante="I" Exportacion="01" MetodoPago="PUE" LugarExpedicion="06000">
  <cfdi:Emisor Rfc="CON950820K12" Nombre="PROVEEDOR SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="PUBLICO EN GENERAL" DomicilioFiscalReceptor="06000" RegimenFiscalReceptor="616" UsoCFDI="G03"/>
  <cfdi:Conceptos><cfdi:Concepto ClaveProdServ="80131500" Cantidad="1" ClaveUnidad="E48" Descripcion="Honorarios" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto></cfdi:Conceptos>
  <cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="11111111-2222-3333-4444-555555555555" FechaTimbrado="2026-07-01T10:05:00"/></cfdi:Complemento>
</cfdi:Comprobante>`;

function importar(session: SesionBaseSinMigrar) {
  const deps = {
    ...ctx.deps,
    despachosRepo: (_db: TenantDbSession) => new PostgresDespachosRepository(session),
    carteraRepo: (_db: TenantDbSession) => new PostgresCarteraRepository(session),
  };
  return buildApp(deps).request(`/despachos/${ctx.propertyId}/cfdi/importar-xml`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.staff.contador.token}`, "content-type": "application/xml", "content-length": String(new TextEncoder().encode(XML).byteLength) },
    body: XML,
  });
}

describe("POST /despachos/:propertyId/cfdi/importar-xml contra la base SIN migrar (018 pendiente)", () => {
  it("201: ficha (42P01) e insert con columnas nuevas (42703) degradan por SAVEPOINT; el flujo sigue hasta la cola de revision", async () => {
    const session = new SesionBaseSinMigrar(false);
    const res = await importar(session);
    expect(res.status).toBe(201);
    // El invoice sale por el camino historico: lo nuevo es null y el estado SAT queda pendiente, nunca un valor inventado.
    expect(await res.json()).toMatchObject({ id: FILA_INVOICE.id, direccion: null, moneda: null, montosCentavos: { total: null }, estadoSat: "pendiente", requiereRevisionHumana: true });
    // La cola de revision se creo DESPUES de los errores: la transaccion nunca quedo abortada.
    expect(session.queries.some((q) => q.startsWith("insert into despachos.invoice_review"))).toBe(true);
    expect(session.abierta).toBe(false);
    expect(session.savepointsAbiertos).toBe(0);
  });

  it("base migrada: camino completo (insert con columnas nuevas) y sin savepoints colgados", async () => {
    const session = new SesionBaseSinMigrar(true);
    const res = await importar(session);
    expect(res.status).toBe(201);
    expect(session.queries.some((q) => q.startsWith("insert into despachos.invoice (") && q.includes("direccion"))).toBe(true);
    expect(session.queries.some((q) => q.startsWith("insert into despachos.invoice_impuesto"))).toBe(true);
    expect(session.savepointsAbiertos).toBe(0);
  });
});
