// Hallazgo de auditoría (severidad ALTA): `licitaciones.company_document.expires_at`
// y `licitaciones.approved_rate.valid_from`/`valid_until` son columnas `date` en
// Postgres (001_licitaciones_schema.sql). `PostgresLicitacionesRepository` las lee
// con `::text`, que devuelve una cadena pelona "YYYY-MM-DD" -- SIN el offset horario
// explícito que `CompanyDataService` (company-data.ts) exige incondicionalmente vía
// `assertExplicitOffset` en cuanto el valor no es `null`. Antes del fix,
// `resolveDocumentByType`/`resolveApprovedRate` LANZABAN siempre que había una fecha
// de vigencia real, tumbando con 500 tanto `POST .../proposal/economic/generate`
// como la generación de la propuesta técnica en producción.
//
// `InMemoryLicitacionesRepository` NUNCA reproduce este bug: conserva tal cual la
// cadena ISO-con-offset que le pasan los tests/fixtures, en vez de pasar por una
// columna `date` real de Postgres -- por eso toda la suite (que solo usa el
// repositorio en memoria, ver apps/api/tests/licitaciones-fixtures.ts) pasaba en
// verde con este bug vivo en producción. Este archivo alimenta `CompanyDataService`
// con la forma EXACTA que produce `dateColumnToExplicitOffsetIso`
// (postgres-repository.ts) a partir de un valor `date::text` crudo de Postgres --
// la misma función que usan `listCompanyDocuments`/`listApprovedRates`/
// `listAllApprovedRates`/`createCompanyDocument`/`updateCompanyDocument`/
// `createApprovedRate`/`updateApprovedRate` -- para que una regresión futura (p. ej.
// quitar la normalización, o "arreglar" el bug con un formato distinto) se detecte
// aquí sin necesitar una base de datos Postgres real.
//
// Hallazgo de auditoría (rubro 9, MEDIO -- ronda de cobertura de tests): las
// describes de abajo SOLO llaman `dateColumnToExplicitOffsetIso` directo desde
// el propio archivo de test y arman el shape "a mano" -- nunca invocan un
// método real de `PostgresLicitacionesRepository`. Si alguien quita la llamada
// a `dateColumnToExplicitOffsetIso(...)` en el call site real (p. ej.
// `listCompanyDocuments`, `createApprovedRate`) -- exactamente la regresión que
// este archivo dice proteger -- ninguna aserción de aquí arriba se entera: la
// mutación queda en verde. El describe `PostgresLicitacionesRepository -- call
// site real` de más abajo instancia la clase real con un `TenantDbSession`
// falso que devuelve la cadena "date::text" pelona tal como la entrega Postgres,
// para que una regresión en el call site sí truene.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { CompanyDataService, InMemoryCompanyDataResolver, type ApprovedRate, type CompanyDocument } from "../src/company-data.ts";
import { dateColumnToExplicitOffsetIso, PostgresLicitacionesRepository } from "../src/postgres-repository.ts";

const COMPANY_ID = "org-1";
const AS_OF_ISO = "2026-06-01T00:00:00-06:00";

/**
 * `TenantDbSession` falso que devuelve, EN ORDEN, las respuestas encoladas --
 * mismo criterio que el fake de una sola respuesta fija de
 * `packages/core-auth/tests/middleware.spec.ts`, pero aquí cada método de
 * `PostgresLicitacionesRepository` bajo prueba puede emitir más de una query
 * (p. ej. `createApprovedRate` primero revisa duplicados y luego inserta) y
 * cada una necesita su propio shape de fila.
 */
function fakeSessionWithResponses(responses: ReadonlyArray<{ rows: unknown[] }>): TenantDbSession {
  const queue = [...responses];
  return {
    async query<T>() {
      const next = queue.shift();
      if (!next) throw new Error("fakeSessionWithResponses: se agotaron las respuestas encoladas");
      return next as { rows: T[] };
    },
    async exec() {},
  };
}

describe("dateColumnToExplicitOffsetIso (postgres-repository.ts) -- normalización de columnas `date`", () => {
  it("agrega medianoche UTC explícita a una fecha pelona 'YYYY-MM-DD' (la forma exacta que devuelve `date::text` en Postgres)", () => {
    expect(dateColumnToExplicitOffsetIso("2026-01-01")).toBe("2026-01-01T00:00:00Z");
  });

  it("preserva `null` tal cual (columna sin vigencia definida, p. ej. company_document.expires_at o approved_rate.valid_until)", () => {
    expect(dateColumnToExplicitOffsetIso(null)).toBeNull();
  });

  it("es idempotente: un valor que YA trae offset explícito se devuelve sin tocar", () => {
    expect(dateColumnToExplicitOffsetIso("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00Z");
    expect(dateColumnToExplicitOffsetIso("2026-01-01T00:00:00-06:00")).toBe("2026-01-01T00:00:00-06:00");
  });
});

describe("CompanyDataService alimentado con la forma EXACTA que devuelve el repositorio Postgres (contrato, no el repo en memoria)", () => {
  it("resuelve un documento VIGENTE cuando expires_at llega como columna `date` normalizada por dateColumnToExplicitOffsetIso", () => {
    const documents: CompanyDocument[] = [
      {
        id: "doc-1",
        companyId: COMPANY_ID,
        type: "opinion_cumplimiento",
        label: "Opinión de cumplimiento SAT",
        issuedAt: AS_OF_ISO,
        // Forma real: Postgres devuelve "2099-01-01" (::text sobre `date`);
        // el repositorio la normaliza ANTES de construir el record.
        expiresAt: dateColumnToExplicitOffsetIso("2099-01-01"),
        approvalStatus: "aprobado",
      },
    ];
    const service = new CompanyDataService(new InMemoryCompanyDataResolver({ documents }));
    const result = service.resolveDocumentByType(COMPANY_ID, "opinion_cumplimiento", AS_OF_ISO);
    expect(result.status).toBe("ok");
  });

  it("bloquea (nunca lanza) un documento VENCIDO cuando expires_at llega como columna `date` normalizada", () => {
    const documents: CompanyDocument[] = [
      {
        id: "doc-1",
        companyId: COMPANY_ID,
        type: "opinion_cumplimiento",
        label: "Opinión de cumplimiento SAT",
        issuedAt: AS_OF_ISO,
        expiresAt: dateColumnToExplicitOffsetIso("2020-01-01"),
        approvalStatus: "aprobado",
      },
    ];
    const service = new CompanyDataService(new InMemoryCompanyDataResolver({ documents }));
    const result = service.resolveDocumentByType(COMPANY_ID, "opinion_cumplimiento", AS_OF_ISO);
    expect(result).toMatchObject({ status: "blocked", reason: "documento_vencido" });
  });

  it("resuelve una tarifa aprobada VIGENTE cuando valid_from/valid_until llegan como columnas `date` normalizadas (sin valid_until)", () => {
    const rates: ApprovedRate[] = [
      {
        id: "rate-1",
        companyId: COMPANY_ID,
        concept: "consultoria_hora",
        unit: "hora",
        unitPrice: "500.00",
        currency: "MXN",
        approvalStatus: "aprobado",
        validFrom: dateColumnToExplicitOffsetIso("2020-01-01")!,
        validUntil: dateColumnToExplicitOffsetIso(null),
      },
    ];
    const service = new CompanyDataService(new InMemoryCompanyDataResolver({ rates }));
    const result = service.resolveApprovedRate(COMPANY_ID, "consultoria_hora", AS_OF_ISO);
    expect(result.status).toBe("ok");
  });

  it("bloquea (nunca lanza) una tarifa VENCIDA cuando valid_until llega como columna `date` normalizada", () => {
    const rates: ApprovedRate[] = [
      {
        id: "rate-1",
        companyId: COMPANY_ID,
        concept: "consultoria_hora",
        unit: "hora",
        unitPrice: "500.00",
        currency: "MXN",
        approvalStatus: "aprobado",
        validFrom: dateColumnToExplicitOffsetIso("2020-01-01")!,
        validUntil: dateColumnToExplicitOffsetIso("2021-01-01"),
      },
    ];
    const service = new CompanyDataService(new InMemoryCompanyDataResolver({ rates }));
    const result = service.resolveApprovedRate(COMPANY_ID, "consultoria_hora", AS_OF_ISO);
    expect(result).toMatchObject({ status: "blocked", reason: "tarifa_vencida" });
  });

  it("REGRESIÓN: alimentar CompanyDataService con la fecha `date::text` CRUDA de Postgres (sin normalizar) LANZA -- exactamente el 500 de producción que este fix cierra", () => {
    const documents: CompanyDocument[] = [
      {
        id: "doc-1",
        companyId: COMPANY_ID,
        type: "opinion_cumplimiento",
        label: "Opinión de cumplimiento SAT",
        issuedAt: AS_OF_ISO,
        // Forma cruda pre-fix: "2099-01-01" tal como sale de `expires_at::text`
        // sin pasar por dateColumnToExplicitOffsetIso.
        expiresAt: "2099-01-01",
        approvalStatus: "aprobado",
      },
    ];
    const service = new CompanyDataService(new InMemoryCompanyDataResolver({ documents }));
    expect(() => service.resolveDocumentByType(COMPANY_ID, "opinion_cumplimiento", AS_OF_ISO)).toThrow(/offset horario explícito/);
  });

  it("REGRESIÓN: una tarifa con valid_from crudo (sin normalizar) LANZA en vez de resolver -- misma clase de bug que expires_at", () => {
    const rates: ApprovedRate[] = [
      {
        id: "rate-1",
        companyId: COMPANY_ID,
        concept: "consultoria_hora",
        unit: "hora",
        unitPrice: "500.00",
        currency: "MXN",
        approvalStatus: "aprobado",
        validFrom: "2020-01-01",
        validUntil: null,
      },
    ];
    const service = new CompanyDataService(new InMemoryCompanyDataResolver({ rates }));
    expect(() => service.resolveApprovedRate(COMPANY_ID, "consultoria_hora", AS_OF_ISO)).toThrow(/offset horario explícito/);
  });
});

describe("PostgresLicitacionesRepository -- call site real (protege contra quitar dateColumnToExplicitOffsetIso del método, no solo de la función aislada)", () => {
  const ORG_ID = "org-1";

  it("listCompanyDocuments: normaliza expires_at aunque `db.query` devuelva la cadena `date::text` pelona de Postgres", async () => {
    const repo = new PostgresLicitacionesRepository(
      fakeSessionWithResponses([
        { rows: [{ id: "doc-1", document_type: "opinion_cumplimiento", label: "Opinión de cumplimiento SAT", expires_at: "2099-01-01", approval_status: "aprobado" }] },
      ]),
    );
    const docs = await repo.listCompanyDocuments(ORG_ID, AS_OF_ISO);
    expect(docs[0]!.expiresAt).toBe("2099-01-01T00:00:00Z");
    // Y el resultado real (no re-derivado a mano) debe poder alimentar
    // CompanyDataService sin lanzar -- la regresión de producción exacta.
    const service = new CompanyDataService(new InMemoryCompanyDataResolver({ documents: docs.map((d) => ({ ...d, companyId: ORG_ID, issuedAt: AS_OF_ISO })) }));
    expect(() => service.resolveDocumentByType(ORG_ID, "opinion_cumplimiento", AS_OF_ISO)).not.toThrow();
  });

  it("listAllApprovedRates: normaliza valid_from/valid_until aunque `db.query` devuelva columnas `date::text` pelonas", async () => {
    const repo = new PostgresLicitacionesRepository(
      fakeSessionWithResponses([
        {
          rows: [
            { id: "rate-1", concept: "consultoria_hora", unit_price: "500.00", approval_status: "aprobado", valid_from: "2020-01-01", valid_until: "2021-01-01" },
          ],
        },
      ]),
    );
    const rates = await repo.listAllApprovedRates(ORG_ID);
    expect(rates[0]).toMatchObject({ validFrom: "2020-01-01T00:00:00Z", validUntil: "2021-01-01T00:00:00Z" });
  });

  it("createCompanyDocument: la fila que `insert ... returning` da de vuelta también se normaliza (mismo `::text`)", async () => {
    const repo = new PostgresLicitacionesRepository(
      fakeSessionWithResponses([
        { rows: [{ id: "doc-2", document_type: "constancia_situacion_fiscal", label: "CSF", expires_at: "2030-12-31", approval_status: "pendiente_aprobacion" }] },
      ]),
    );
    const doc = await repo.createCompanyDocument(ORG_ID, { type: "constancia_situacion_fiscal", label: "CSF", expiresAt: "2030-12-31" });
    expect(doc.expiresAt).toBe("2030-12-31T00:00:00Z");
  });

  it("updateCompanyDocument: la fila devuelta por el `update ... returning` se normaliza", async () => {
    const repo = new PostgresLicitacionesRepository(
      fakeSessionWithResponses([
        { rows: [{ id: "doc-3", document_type: "opinion_cumplimiento", label: "Opinión", expires_at: "2027-05-01", approval_status: "aprobado" }] },
      ]),
    );
    const doc = await repo.updateCompanyDocument(ORG_ID, "doc-3", { expiresAt: "2027-05-01" });
    expect(doc.expiresAt).toBe("2027-05-01T00:00:00Z");
  });

  it("createApprovedRate: normaliza valid_from/valid_until del `insert ... returning` (tras la query de duplicados)", async () => {
    const repo = new PostgresLicitacionesRepository(
      fakeSessionWithResponses([
        { rows: [] }, // select de duplicados: no hay
        { rows: [{ id: "rate-2", concept: "supervision_obra", unit_price: "1200.00", approval_status: "pendiente_aprobacion", valid_from: "2026-01-01", valid_until: null }] },
      ]),
    );
    const rate = await repo.createApprovedRate(ORG_ID, { concept: "supervision_obra", unitPrice: "1200.00", validFrom: "2026-01-01" });
    expect(rate).toMatchObject({ validFrom: "2026-01-01T00:00:00Z", validUntil: null });
  });

  it("updateApprovedRate: normaliza valid_from/valid_until del `update ... returning`", async () => {
    const repo = new PostgresLicitacionesRepository(
      fakeSessionWithResponses([
        { rows: [{ id: "rate-3", concept: "supervision_obra", unit_price: "1200.00", approval_status: "aprobado", valid_from: "2026-01-01", valid_until: "2028-01-01" }] },
      ]),
    );
    const rate = await repo.updateApprovedRate(ORG_ID, "rate-3", { validUntil: "2028-01-01" });
    expect(rate).toMatchObject({ validFrom: "2026-01-01T00:00:00Z", validUntil: "2028-01-01T00:00:00Z" });
  });
});
