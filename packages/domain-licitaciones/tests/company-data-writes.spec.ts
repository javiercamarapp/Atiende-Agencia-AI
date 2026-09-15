// Prueba de dominio (repositorio en memoria, sin HTTP) de los métodos de
// ESCRITURA de "datos de empresa" agregados en Fase 16 -- hasta esta pieza,
// `LicitacionesRepository` solo exponía lectura
// (`listCompanyDocuments`/`listApprovedRates`/`listCompanyCapabilities`/
// `listCompanyExperience`/`listCompanySigners`), sin ningún camino real para
// CAPTURAR el dato que las propuestas técnica/económica necesitan para dejar
// de estar "PENDIENTE".
import { describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { CompanyDataDuplicateKeyError } from "../src/errors.ts";

const ORG = "org-1";

describe("InMemoryLicitacionesRepository -- escritura de company_document (Fase 16)", () => {
  it("createCompanyDocument inserta con approvalStatus 'pendiente_aprobacion' por defecto -- nunca se aprueba solo -- y aparece en listCompanyDocuments", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const created = await repo.createCompanyDocument(ORG, { type: "opinion_cumplimiento", label: "Opinión de cumplimiento SAT", expiresAt: null });
    expect(created.approvalStatus).toBe("pendiente_aprobacion");

    const documents = await repo.listCompanyDocuments(ORG, "2026-06-01T00:00:00-06:00");
    expect(documents.map((d) => d.id)).toEqual([created.id]);
  });

  it("updateCompanyDocument aprueba un documento existente por id -- solo ese campo cambia", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const created = await repo.createCompanyDocument(ORG, { type: "acta_constitutiva", label: "Acta Constitutiva", expiresAt: null });
    const updated = await repo.updateCompanyDocument(ORG, created.id, { approvalStatus: "aprobado" });
    expect(updated.approvalStatus).toBe("aprobado");
    expect(updated.type).toBe("acta_constitutiva");
    expect(updated.label).toBe("Acta Constitutiva");
  });

  it("updateCompanyDocument contra un id inexistente lanza, nunca crea uno nuevo en silencio", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await expect(repo.updateCompanyDocument(ORG, "no-existe", { approvalStatus: "aprobado" })).rejects.toThrow();
  });

  it("dos organizaciones no comparten documentos", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.createCompanyDocument(ORG, { type: "x", label: "x", expiresAt: null });
    expect(await repo.listCompanyDocuments("otra-org", "2026-06-01T00:00:00-06:00")).toEqual([]);
  });
});

describe("InMemoryLicitacionesRepository -- escritura de approved_rate (Fase 16)", () => {
  it("createApprovedRate inserta una tarifa nueva, resolvible por listApprovedRates una vez aprobada", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const created = await repo.createApprovedRate(ORG, { concept: "consultoria_hora", unitPrice: "500.00", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00" });
    expect(created.concept).toBe("consultoria_hora");
    expect(created.currency).toBe("MXN");

    const usable = await repo.listApprovedRates(ORG, "2026-06-01T00:00:00-06:00");
    expect(usable.map((r) => r.concept)).toEqual(["consultoria_hora"]);
  });

  it("crear una tarifa con un 'concept' ya existente lanza CompanyDataDuplicateKeyError -- nunca actualiza en silencio", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.createApprovedRate(ORG, { concept: "consultoria_hora", unitPrice: "500.00" });
    await expect(repo.createApprovedRate(ORG, { concept: "consultoria_hora", unitPrice: "999.00" })).rejects.toBeInstanceOf(CompanyDataDuplicateKeyError);
  });

  it("updateApprovedRate corrige el precio/aprueba una tarifa existente por id", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const created = await repo.createApprovedRate(ORG, { concept: "consultoria_hora", unitPrice: "500.00" });
    const updated = await repo.updateApprovedRate(ORG, created.id, { unitPrice: "600.00", approvalStatus: "aprobado" });
    expect(updated.unitPrice).toBe("600.00");
    expect(updated.approvalStatus).toBe("aprobado");
  });

  it("listAllApprovedRates lista TODAS (pendientes/rechazadas/vencidas incluidas) a diferencia de listApprovedRates", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.createApprovedRate(ORG, { concept: "vigente", unitPrice: "1.00", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00" });
    await repo.createApprovedRate(ORG, { concept: "pendiente", unitPrice: "1.00", validFrom: "2026-01-01T00:00:00-06:00" });
    await repo.createApprovedRate(ORG, { concept: "rechazada", unitPrice: "1.00", approvalStatus: "rechazado", validFrom: "2026-01-01T00:00:00-06:00" });

    const all = await repo.listAllApprovedRates(ORG);
    expect(all.map((r) => r.concept).sort()).toEqual(["pendiente", "rechazada", "vigente"]);

    const usable = await repo.listApprovedRates(ORG, "2026-06-01T00:00:00-06:00");
    expect(usable.map((r) => r.concept)).toEqual(["vigente"]);
  });
});

describe("InMemoryLicitacionesRepository -- escritura de company_capability/company_experience/company_signer (Fase 16)", () => {
  it("createCompanyCapability con 'name' duplicado lanza CompanyDataDuplicateKeyError", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.createCompanyCapability(ORG, { name: "mantenimiento_flotilla", description: "x" });
    await expect(repo.createCompanyCapability(ORG, { name: "mantenimiento_flotilla", description: "y" })).rejects.toBeInstanceOf(CompanyDataDuplicateKeyError);
  });

  it("updateCompanyCapability aprueba/edita por id", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const created = await repo.createCompanyCapability(ORG, { name: "cap1", description: "x" });
    const updated = await repo.updateCompanyCapability(ORG, created.id, { approvalStatus: "aprobado" });
    expect(updated.approvalStatus).toBe("aprobado");
  });

  it("createCompanyExperience exige evidenceDocId (obligatorio a nivel de dominio) y se resuelve por id", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const doc = await repo.createCompanyDocument(ORG, { type: "acta_entrega", label: "Acta entrega-recepción", expiresAt: null });
    const experience = await repo.createCompanyExperience(ORG, { description: "Proyecto X para el municipio Y", evidenceDocId: doc.id });
    expect(experience.evidenceDocId).toBe(doc.id);
    const updated = await repo.updateCompanyExperience(ORG, experience.id, { approvalStatus: "aprobado" });
    expect(updated.approvalStatus).toBe("aprobado");
  });

  it("createCompanySigner con 'role' duplicado lanza CompanyDataDuplicateKeyError -- un solo firmante autorizado vigente por rol", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.createCompanySigner(ORG, { name: "Juan Pérez", role: "representante_legal", authorized: true });
    await expect(repo.createCompanySigner(ORG, { name: "Otra Persona", role: "representante_legal" })).rejects.toBeInstanceOf(CompanyDataDuplicateKeyError);
  });

  it("updateCompanySigner revoca/autoriza por id", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const created = await repo.createCompanySigner(ORG, { name: "Juan Pérez", role: "representante_legal", authorized: true });
    const revoked = await repo.updateCompanySigner(ORG, created.id, { authorized: false });
    expect(revoked.authorized).toBe(false);
  });
});
