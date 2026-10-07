// REQ-141/142/145 -- firmante vigente a la fecha del acto (no a la de hoy), varios firmantes por cargo y dato sin procedencia
// bloqueado. Dominio puro: el Postgres real lo cubre scripts/verify-licitaciones-perfil-empresa.
import { describe, expect, it } from "vitest";
import { CompanyDataService, InMemoryCompanyDataResolver } from "../src/company-data.ts";
import type { CompanySigner } from "../src/company-data.ts";
import { ProvenanceIndex, normalizeParticipationPct } from "../src/company-profile.ts";
import type { CompanyRestrictionRecord, CompanyStakeholderRecord, FieldProvenanceRecord } from "../src/company-profile.ts";

const CO = "org-1";
const prov = (entity: FieldProvenanceRecord["entity"], entityId: string): FieldProvenanceRecord => ({ id: `p-${entityId}`, entity, entityId, field: "*", ownerUserId: "u1", source: "manual", capturedAt: "2026-03-01T10:00:00Z" });
const signer = (over: Partial<CompanySigner>): CompanySigner => ({ id: "s1", companyId: CO, name: "Ana", role: "representante_legal", authorized: true, approvalStatus: "aprobado", ...over });
const servicio = (signers: CompanySigner[]) => new CompanyDataService(new InMemoryCompanyDataResolver({ signers }));

// La fecha del acto es 2026-12-15 18:00 hora del centro; "hoy" en la prueba da igual: nunca se consulta.
const ACTO = "2026-12-15T18:00:00-06:00";

describe("resolveAuthorizedSigner: vigencia del poder a la fecha del acto (REQ-145)", () => {
  it("un poder vigente el dia del acto resuelve aunque ya este vencido a la fecha de hoy", () => {
    const s = signer({ validFrom: "2026-01-01T00:00:00-06:00", validUntil: "2026-12-31T23:59:59-06:00" });
    expect(servicio([s]).resolveAuthorizedSigner(CO, "representante_legal", ACTO)).toMatchObject({ status: "ok" });
  });

  it("un poder que vence ANTES del acto bloquea con firmante_poder_vencido, aunque hoy siga vigente", () => {
    const s = signer({ validFrom: "2026-01-01T00:00:00-06:00", validUntil: "2026-12-01T23:59:59-06:00" });
    expect(servicio([s]).resolveAuthorizedSigner(CO, "representante_legal", ACTO)).toMatchObject({ status: "blocked", reason: "firmante_poder_vencido" });
  });

  it("un poder que aun no rige el dia del acto bloquea con firmante_poder_no_vigente", () => {
    const s = signer({ validFrom: "2027-01-01T00:00:00-06:00" });
    expect(servicio([s]).resolveAuthorizedSigner(CO, "representante_legal", ACTO)).toMatchObject({ status: "blocked", reason: "firmante_poder_no_vigente" });
  });

  it("frontera: el ultimo instante de vigencia cumple y un segundo despues no", () => {
    const s = signer({ validUntil: "2026-12-15T18:00:00-06:00" });
    expect(servicio([s]).resolveAuthorizedSigner(CO, "representante_legal", "2026-12-15T18:00:00-06:00").status).toBe("ok");
    expect(servicio([s]).resolveAuthorizedSigner(CO, "representante_legal", "2026-12-15T18:00:01-06:00")).toMatchObject({ reason: "firmante_poder_vencido" });
  });

  it("con varios firmantes del mismo cargo elige el vigente, no el primero de la lista", () => {
    const vencido = signer({ id: "s1", name: "Viejo", validUntil: "2026-01-31T23:59:59-06:00" });
    const vigente = signer({ id: "s2", name: "Nuevo", validFrom: "2026-02-01T00:00:00-06:00" });
    const r = servicio([vencido, vigente]).resolveAuthorizedSigner(CO, "representante_legal", ACTO);
    expect(r.status === "ok" && r.value.name).toBe("Nuevo");
  });

  it("si ninguno esta vigente queda bloqueado con el motivo mas especifico y nunca se rellena", () => {
    const vencido = signer({ id: "s1", validUntil: "2026-01-31T23:59:59-06:00" });
    const pendiente = signer({ id: "s2", approvalStatus: "pendiente_aprobacion" });
    const r = servicio([pendiente, vencido]).resolveAuthorizedSigner(CO, "representante_legal", ACTO);
    expect(r).toMatchObject({ status: "blocked", reason: "firmante_poder_vencido" });
    expect(servicio([]).resolveAuthorizedSigner(CO, "representante_legal", ACTO)).toMatchObject({ status: "missing" });
  });

  it("sin asOf o sin vigencia capturada se conserva el comportamiento anterior (no se evalua la vigencia)", () => {
    const viejo = signer({ validUntil: "2020-01-01T00:00:00-06:00" });
    expect(servicio([viejo]).resolveAuthorizedSigner(CO, "representante_legal").status).toBe("ok");
    expect(servicio([signer({})]).resolveAuthorizedSigner(CO, "representante_legal", ACTO).status).toBe("ok");
    expect(servicio([signer({ authorized: false })]).resolveAuthorizedSigner(CO, "representante_legal", ACTO)).toMatchObject({ reason: "firmante_no_autorizado" });
  });
});

describe("procedencia por campo (REQ-142): un dato sin procedencia no se usa", () => {
  const socio: CompanyStakeholderRecord = { id: "k1", kind: "socio", fullName: "Ana", rfc: null, participationPct: "50.00", approvalStatus: "aprobado" };
  const restr: CompanyRestrictionRecord = { id: "r1", kind: "sancion", description: "x", validFrom: "2026-01-01", validUntil: null, approvalStatus: "aprobado" };

  it("aprobado pero sin procedencia: bloqueado con procedencia_ausente (fila insertada por SQL)", () => {
    const svc = new CompanyDataService(new InMemoryCompanyDataResolver({ stakeholders: [socio], provenance: new ProvenanceIndex([]) }));
    expect(svc.resolveStakeholders(CO)).toMatchObject({ status: "blocked", reason: "procedencia_ausente" });
  });

  it("con procedencia y aprobado resuelve; pendiente bloquea con dato_no_aprobado; rechazado se ignora", () => {
    const conProv = (items: CompanyStakeholderRecord[]) => new CompanyDataService(new InMemoryCompanyDataResolver({ stakeholders: items, provenance: new ProvenanceIndex(items.map((i) => prov("stakeholder", i.id))) })).resolveStakeholders(CO);
    expect(conProv([socio]).status).toBe("ok");
    expect(conProv([{ ...socio, approvalStatus: "pendiente_aprobacion" }])).toMatchObject({ status: "blocked", reason: "dato_no_aprobado" });
    expect(conProv([{ ...socio, approvalStatus: "rechazado" }])).toMatchObject({ status: "missing" });
    // Una lista con un socio bueno y uno sin procedencia queda bloqueada completa: no se oculta un socio.
    const mixta = new CompanyDataService(new InMemoryCompanyDataResolver({ stakeholders: [socio, { ...socio, id: "k2" }], provenance: new ProvenanceIndex([prov("stakeholder", "k1")]) }));
    expect(mixta.resolveStakeholders(CO)).toMatchObject({ status: "blocked", reason: "procedencia_ausente" });
  });

  it("sin datos: missing, nunca un valor inventado (incluido el perfil y las restricciones)", () => {
    const svc = new CompanyDataService(new InMemoryCompanyDataResolver({}));
    expect(svc.resolveProfile(CO).status).toBe("missing");
    expect(svc.resolveRestrictions(CO).status).toBe("missing");
    expect(svc.resolveLocations(CO).status).toBe("missing");
    expect(svc.resolveProductsServices(CO).status).toBe("missing");
    expect(new CompanyDataService(new InMemoryCompanyDataResolver({ restrictions: [restr] })).resolveRestrictions(CO)).toMatchObject({ reason: "procedencia_ausente" });
  });

  it("un resolvedor anterior sin los metodos nuevos responde missing", () => {
    const legacy = new CompanyDataService({ getCapabilities: () => [], getExperience: () => [], getDocuments: () => [], getSigners: () => [], getApprovedRates: () => [] });
    expect(legacy.resolveProfile(CO).status).toBe("missing");
    expect(legacy.resolveStakeholders(CO).status).toBe("missing");
  });

  it("ProvenanceIndex distingue registro completo y campo", () => {
    const idx = new ProvenanceIndex([prov("profile", "p1"), { ...prov("profile", "p1"), id: "x", field: "employeeCount" }]);
    expect(idx.has("profile", "p1")).toBe(true);
    expect(idx.has("profile", "otro")).toBe(false);
    expect(idx.has("location", "p1")).toBe(false);
    expect(idx.get("profile", "p1")?.field).toBe("*");
    expect(idx.get("profile", "p1", "employeeCount")?.id).toBe("x");
  });
});

describe("normalizeParticipationPct (dos decimales)", () => {
  it("normaliza a dos decimales exactos y rechaza lo que no lo es", () => {
    expect(normalizeParticipationPct("5")).toBe("5.00");
    expect(normalizeParticipationPct("33.3")).toBe("33.30");
    expect(normalizeParticipationPct(12.5)).toBe("12.50");
    expect(normalizeParticipationPct("100")).toBe("100.00");
    expect(normalizeParticipationPct("100.00")).toBe("100.00");
    for (const mal of ["100.01", "101", "33.333", "-1", "abc", "", null, undefined, "1e2"]) expect(normalizeParticipationPct(mal), String(mal)).toBeNull();
  });
});
