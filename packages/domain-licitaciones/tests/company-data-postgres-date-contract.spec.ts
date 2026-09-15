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
import { describe, expect, it } from "vitest";
import { CompanyDataService, InMemoryCompanyDataResolver, type ApprovedRate, type CompanyDocument } from "../src/company-data.ts";
import { dateColumnToExplicitOffsetIso } from "../src/postgres-repository.ts";

const COMPANY_ID = "org-1";
const AS_OF_ISO = "2026-06-01T00:00:00-06:00";

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
