// Prueba de dominio (repositorio en memoria, sin HTTP) de los métodos de
// ESCRITURA de "datos de empresa" agregados en Fase 16 -- hasta esta pieza,
// `LicitacionesRepository` solo exponía lectura
// (`listCompanyDocuments`/`listApprovedRates`/`listCompanyCapabilities`/
// `listCompanyExperience`/`listCompanySigners`), sin ningún camino real para
// CAPTURAR el dato que las propuestas técnica/económica necesitan para dejar
// de estar "PENDIENTE".
import { describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { CompanyDataDuplicateKeyError, CompanyDataNotFoundError } from "../src/errors.ts";

const ORG = "org-1";

describe("InMemoryLicitacionesRepository -- escritura de company_document (Fase 16)", () => {
  it("createCompanyDocument inserta con approvalStatus 'pendiente_aprobacion' por defecto -- nunca se aprueba solo -- y aparece en listCompanyDocuments", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const created = await repo.createCompanyDocument(ORG, { type: "opinion_cumplimiento", label: "Opinión de cumplimiento SAT", expiresAt: null });
    expect(created.approvalStatus).toBe("pendiente_aprobacion");

    const documents = await repo.listCompanyDocuments(ORG, "2026-06-01T00:00:00-06:00");
    expect(documents.map((d) => d.id)).toEqual([created.id]);
  });

  it("updateCompanyDocument corrige la etiqueta de un documento existente por id -- el tipo no cambia", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const created = await repo.createCompanyDocument(ORG, { type: "acta_constitutiva", label: "Acta Constitutiva", expiresAt: null });
    const updated = await repo.updateCompanyDocument(ORG, created.id, { label: "Acta Constitutiva (corregida)" });
    expect(updated.type).toBe("acta_constitutiva");
    expect(updated.label).toBe("Acta Constitutiva (corregida)");
  });

  it("updateCompanyDocument contra un id inexistente lanza CompanyDataNotFoundError, nunca crea uno nuevo en silencio", async () => {
    // Hallazgo de auditoría: `companyData.ts::mapDuplicateOrThrow` depende de
    // este tipo exacto (no un `Error` genérico) para mapear a 404 sin filtrar
    // mensajes internos de otros errores no reconocidos -- ver
    // company-data-postgres-date-contract.spec.ts para el contrato completo.
    const repo = new InMemoryLicitacionesRepository();
    await expect(repo.updateCompanyDocument(ORG, "no-existe", { label: "x" })).rejects.toBeInstanceOf(CompanyDataNotFoundError);
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
    const created = await repo.createApprovedRate(ORG, { concept: "consultoria_hora", unitPrice: "500.00", validFrom: "2026-01-01T00:00:00-06:00", actorId: "autor" });
    expect(created.approvalStatus).toBe("pendiente_aprobacion");
    expect(await repo.decideCompanyItem(ORG, { kind: "rate", itemId: created.id, decision: "aprobado", actorId: "decisor", actorRole: "owner" })).toBe("ok");
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

  it("updateApprovedRate corrige el precio de una tarifa existente por id (sigue pendiente: editar no aprueba)", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const created = await repo.createApprovedRate(ORG, { concept: "consultoria_hora", unitPrice: "500.00" });
    const updated = await repo.updateApprovedRate(ORG, created.id, { unitPrice: "600.00" });
    expect(updated.unitPrice).toBe("600.00");
    expect(updated.approvalStatus).toBe("pendiente_aprobacion");
  });

  it("listAllApprovedRates lista TODAS (pendientes/rechazadas/vencidas incluidas) a diferencia de listApprovedRates", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const vigente = await repo.createApprovedRate(ORG, { concept: "vigente", unitPrice: "1.00", validFrom: "2026-01-01T00:00:00-06:00" });
    await repo.createApprovedRate(ORG, { concept: "pendiente", unitPrice: "1.00", validFrom: "2026-01-01T00:00:00-06:00" });
    const rechazada = await repo.createApprovedRate(ORG, { concept: "rechazada", unitPrice: "1.00", validFrom: "2026-01-01T00:00:00-06:00" });
    await repo.decideCompanyItem(ORG, { kind: "rate", itemId: vigente.id, decision: "aprobado", actorId: "d", actorRole: "owner" });
    await repo.decideCompanyItem(ORG, { kind: "rate", itemId: rechazada.id, decision: "rechazado", actorId: "d", actorRole: "owner" });

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

  it("updateCompanyCapability edita por id", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const created = await repo.createCompanyCapability(ORG, { name: "cap1", description: "x" });
    const updated = await repo.updateCompanyCapability(ORG, created.id, { description: "y" });
    expect(updated.description).toBe("y");
  });

  it("createCompanyExperience exige evidenceDocId (obligatorio a nivel de dominio) y se resuelve por id", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const doc = await repo.createCompanyDocument(ORG, { type: "acta_entrega", label: "Acta entrega-recepción", expiresAt: null });
    const experience = await repo.createCompanyExperience(ORG, { description: "Proyecto X para el municipio Y", evidenceDocId: doc.id });
    expect(experience.evidenceDocId).toBe(doc.id);
    const updated = await repo.updateCompanyExperience(ORG, experience.id, { description: "Proyecto X (corregido)" });
    expect(updated.description).toBe("Proyecto X (corregido)");
  });

  it("createCompanySigner permite varios firmantes por cargo (migración 040) y rechaza solo repetir el mismo nombre en el mismo cargo (doble envío)", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.createCompanySigner(ORG, { name: "Juan Pérez", role: "representante_legal", authorized: true });
    await expect(repo.createCompanySigner(ORG, { name: "Otra Persona", role: "representante_legal" })).resolves.toMatchObject({ role: "representante_legal", name: "Otra Persona" });
    await expect(repo.createCompanySigner(ORG, { name: " juan pérez ", role: "representante_legal" })).rejects.toBeInstanceOf(CompanyDataDuplicateKeyError);
    expect(await repo.listCompanySigners(ORG)).toHaveLength(2);
  });

  it("updateCompanySigner revoca/autoriza por id", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const created = await repo.createCompanySigner(ORG, { name: "Juan Pérez", role: "representante_legal", authorized: true });
    const revoked = await repo.updateCompanySigner(ORG, created.id, { authorized: false });
    expect(revoked.authorized).toBe(false);
  });
});

describe("InMemoryLicitacionesRepository -- aprobación de datos de empresa (migración 036)", () => {
  const decide = (repo: InMemoryLicitacionesRepository, kind: "rate" | "document" | "capability" | "experience" | "signer", itemId: string, actorId: string, actorRole = "owner", decision: "aprobado" | "rechazado" = "aprobado") =>
    repo.decideCompanyItem(ORG, { kind, itemId, decision, actorId, actorRole });

  it("create nunca nace aprobado y registra al autor", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const rate = await repo.createApprovedRate(ORG, { concept: "c", unitPrice: "1.00", actorId: "ana" });
    expect(rate.approvalStatus).toBe("pendiente_aprobacion");
    expect(rate.proposedBy).toBe("ana");
  });

  it("aprobar deja approvedBy/approvedAt y un renglón de bitácora; una segunda decisión da 'conflict'", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const rate = await repo.createApprovedRate(ORG, { concept: "c", unitPrice: "1.00", actorId: "ana" });
    expect(await decide(repo, "rate", rate.id, "beto")).toBe("ok");
    const [stored] = await repo.listAllApprovedRates(ORG);
    expect(stored).toMatchObject({ approvalStatus: "aprobado", approvedBy: "beto" });
    expect(stored!.approvedAt).toEqual(expect.any(String));
    expect(repo.companyDataAudit).toEqual([expect.objectContaining({ kind: "rate", itemId: rate.id, decision: "aprobado", actorId: "beto" })]);
    expect(await decide(repo, "rate", rate.id, "carla")).toBe("conflict");
    expect(repo.companyDataAudit).toHaveLength(1);
  });

  it("el autor no puede decidir su propio registro (autor distinto del aprobador)", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const rate = await repo.createApprovedRate(ORG, { concept: "c", unitPrice: "1.00", actorId: "ana" });
    expect(await decide(repo, "rate", rate.id, "ana")).toBe("autor");
    expect((await repo.listAllApprovedRates(ORG))[0]!.approvalStatus).toBe("pendiente_aprobacion");
  });

  it("tarifas: solo owner/admin deciden; el resto de datos también analyst; writer nunca", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const rate = await repo.createApprovedRate(ORG, { concept: "c", unitPrice: "1.00", actorId: "ana" });
    const doc = await repo.createCompanyDocument(ORG, { type: "t", label: "l", expiresAt: null, actorId: "ana" });
    expect(await decide(repo, "rate", rate.id, "x", "analyst")).toBe("rol");
    expect(await decide(repo, "document", doc.id, "x", "writer")).toBe("rol");
    expect(await decide(repo, "document", doc.id, "x", "analyst")).toBe("ok");
    expect(await decide(repo, "rate", rate.id, "x", "admin")).toBe("ok");
  });

  it("DB-03: editar el precio o la vigencia de una tarifa aprobada la regresa a pendiente y limpia la aprobación", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const rate = await repo.createApprovedRate(ORG, { concept: "c", unitPrice: "1.00", validFrom: "2026-01-01T00:00:00-06:00", actorId: "ana" });
    await decide(repo, "rate", rate.id, "beto");
    const edited = await repo.updateApprovedRate(ORG, rate.id, { unitPrice: "2.00", actorId: "ana" });
    expect(edited).toMatchObject({ approvalStatus: "pendiente_aprobacion", approvedBy: null, approvedAt: null, proposedBy: "ana" });
    await decide(repo, "rate", rate.id, "beto");
    const byDate = await repo.updateApprovedRate(ORG, rate.id, { validUntil: "2026-12-31T00:00:00-06:00", actorId: "ana" });
    expect(byDate.approvalStatus).toBe("pendiente_aprobacion");
  });

  it("un PATCH sin cambios reales no invalida la aprobación", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const cap = await repo.createCompanyCapability(ORG, { name: "n", description: "d", actorId: "ana" });
    await decide(repo, "capability", cap.id, "beto");
    const same = await repo.updateCompanyCapability(ORG, cap.id, { description: "d", actorId: "ana" });
    expect(same.approvalStatus).toBe("aprobado");
  });

  it("rechazar es una decisión: queda 'rechazado' y solo vuelve a pendiente al editarse", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const signer = await repo.createCompanySigner(ORG, { name: "Juan", role: "rep", authorized: true, actorId: "ana" });
    expect(await decide(repo, "signer", signer.id, "beto", "owner", "rechazado")).toBe("ok");
    expect((await repo.listCompanySigners(ORG))[0]!.approvalStatus).toBe("rechazado");
    await repo.updateCompanySigner(ORG, signer.id, { name: "Juan P.", actorId: "ana" });
    expect((await repo.listCompanySigners(ORG))[0]!.approvalStatus).toBe("pendiente_aprobacion");
  });

  it("id inexistente -> 'not_found'", async () => {
    const repo = new InMemoryLicitacionesRepository();
    expect(await decide(repo, "rate", "no-existe", "beto")).toBe("not_found");
  });

  it("dos decisiones simultáneas sobre el mismo registro: exactamente una gana", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const rate = await repo.createApprovedRate(ORG, { concept: "c", unitPrice: "1.00", actorId: "ana" });
    const results = await Promise.all([decide(repo, "rate", rate.id, "beto"), decide(repo, "rate", rate.id, "carla")]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "conflict")).toHaveLength(1);
  });
});
