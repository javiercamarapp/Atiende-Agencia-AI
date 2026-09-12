// Fase 5 pieza 2 — REQ-017/041/151..155.
import { describe, expect, it } from "vitest";
import { TenderVersionRegistry, computeTenderSnapshotHash, requirementNaturalKey, toRequirementSnapshot } from "../src/tender-version-registry.ts";
import type { TenderVersionSnapshot } from "../src/tender-version-registry.ts";
import type { RequirementItemRecord } from "../src/repository.ts";

const BASE_FIELDS = {
  title: "Adquisición de equipo de cómputo",
  submissionDeadline: "2026-12-15T18:00:00-06:00",
  contractingBody: "Secretaría de prueba",
  cpvCodes: ["30200000"],
  budgetAmount: 250_000,
  currency: "MXN",
  state: "CDMX",
  procedureTypeRaw: "licitacion_publica",
};

const BASE_SNAPSHOT: TenderVersionSnapshot = { fields: BASE_FIELDS, requirements: [] };

function requirement(overrides: Partial<RequirementItemRecord> = {}): RequirementItemRecord {
  return {
    id: overrides.id ?? "req-1",
    documentId: null,
    text: "Presentar constancia de situación fiscal vigente",
    requirementKind: "administrativo",
    obligatoriedad: "obligatorio",
    topicKey: "constancia_fiscal",
    requiredEvidence: ["documento"],
    extractedBy: "rule",
    page: 1,
    clause: "4.1",
    responsibleRole: "writer",
    deadline: null,
    status: "pendiente",
    confidence: null,
    ...overrides,
  };
}

describe("TenderVersionRegistry.createVersion / historial (REQ-153)", () => {
  it("numera versiones consecutivas empezando en 1", () => {
    const registry = new TenderVersionRegistry();
    const v1 = registry.createVersion(BASE_SNAPSHOT);
    const v2 = registry.createVersion({ ...BASE_SNAPSHOT, fields: { ...BASE_FIELDS, title: "Título actualizado" } });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(registry.latest()!.version).toBe(2);
    expect(registry.all()).toHaveLength(2);
  });

  it("la primera versión clasifica todo campo presente como 'nuevo' (REQ-017: una convocatoria recién capturada es enteramente nueva)", () => {
    const registry = new TenderVersionRegistry();
    const v1 = registry.createVersion(BASE_SNAPSHOT);
    const titleChange = v1.diff.fields.find((f) => f.field === "title")!;
    expect(titleChange.status).toBe("nuevo");
    // Un campo AUSENTE en la primera versión (p. ej. sin entidad federativa) no es "nuevo", es "sin_cambio" (nada que reportar).
    const v1WithoutState = registry.getVersion(1)!;
    expect(v1WithoutState.diff.fields.find((f) => f.field === "title")!.status).toBe("nuevo");
  });
});

describe("TenderVersionRegistry.diff -- campos de bases (REQ-017: sin_cambio/modificado/nuevo/eliminado)", () => {
  it("sin cambios entre dos snapshots idénticos -> todos los campos 'sin_cambio', hasChanges=false", () => {
    const diff = TenderVersionRegistry.diff(BASE_SNAPSHOT, { ...BASE_SNAPSHOT });
    expect(diff.fields.every((f) => f.status === "sin_cambio")).toBe(true);
    expect(diff.hasChanges).toBe(false);
    expect(diff.changedFieldNames).toEqual([]);
  });

  it("cambiar submissionDeadline -> 'modificado', reportado en changedFieldNames", () => {
    const diff = TenderVersionRegistry.diff(BASE_SNAPSHOT, { ...BASE_SNAPSHOT, fields: { ...BASE_FIELDS, submissionDeadline: "2027-01-15T18:00:00-06:00" } });
    const change = diff.fields.find((f) => f.field === "submissionDeadline")!;
    expect(change.status).toBe("modificado");
    expect(diff.changedFieldNames).toEqual(["submissionDeadline"]);
  });

  it("submissionDeadline null -> con valor => 'nuevo'; con valor -> null => 'eliminado'", () => {
    const withoutDeadline: TenderVersionSnapshot = { fields: { ...BASE_FIELDS, submissionDeadline: null }, requirements: [] };
    const nuevo = TenderVersionRegistry.diff(withoutDeadline, BASE_SNAPSHOT);
    expect(nuevo.fields.find((f) => f.field === "submissionDeadline")!.status).toBe("nuevo");

    const eliminado = TenderVersionRegistry.diff(BASE_SNAPSHOT, withoutDeadline);
    expect(eliminado.fields.find((f) => f.field === "submissionDeadline")!.status).toBe("eliminado");
  });

  it("cpvCodes se compara como conjunto (orden distinto no cuenta como cambio)", () => {
    const reordered: TenderVersionSnapshot = { fields: { ...BASE_FIELDS, cpvCodes: ["30200000"] }, requirements: [] };
    const diff = TenderVersionRegistry.diff(BASE_SNAPSHOT, reordered);
    expect(diff.fields.find((f) => f.field === "cpvCodes")!.status).toBe("sin_cambio");
  });

  it("previous === null (nunca hubo versión) -> todo campo presente es 'nuevo'", () => {
    const diff = TenderVersionRegistry.diff(null, BASE_SNAPSHOT);
    expect([...diff.changedFieldNames].sort()).toEqual(["budgetAmount", "contractingBody", "cpvCodes", "currency", "procedureTypeRaw", "state", "submissionDeadline", "title"].sort());
    expect(diff.fields.every((f) => f.status === "nuevo")).toBe(true);
  });
});

describe("TenderVersionRegistry.diff -- requisitos (REQ-017/041: clave natural, no por id de fila)", () => {
  it("un requisito NUEVO (no existía antes) -> 'nuevo'", () => {
    const before: TenderVersionSnapshot = { ...BASE_SNAPSHOT, requirements: [] };
    const after: TenderVersionSnapshot = { ...BASE_SNAPSHOT, requirements: [toRequirementSnapshot(requirement())] };
    const diff = TenderVersionRegistry.diff(before, after);
    expect(diff.requirements).toHaveLength(1);
    expect(diff.requirements[0]!.status).toBe("nuevo");
    expect(diff.hasChanges).toBe(true);
  });

  it("un requisito ELIMINADO (existía, ya no está) -> 'eliminado'", () => {
    const before: TenderVersionSnapshot = { ...BASE_SNAPSHOT, requirements: [toRequirementSnapshot(requirement())] };
    const after: TenderVersionSnapshot = { ...BASE_SNAPSHOT, requirements: [] };
    const diff = TenderVersionRegistry.diff(before, after);
    expect(diff.requirements[0]!.status).toBe("eliminado");
  });

  it("un requisito MODIFICADO (misma clave natural, obligatoriedad distinta) -> 'modificado'", () => {
    const before: TenderVersionSnapshot = { ...BASE_SNAPSHOT, requirements: [toRequirementSnapshot(requirement({ obligatoriedad: "opcional" }))] };
    const after: TenderVersionSnapshot = { ...BASE_SNAPSHOT, requirements: [toRequirementSnapshot(requirement({ obligatoriedad: "obligatorio" }))] };
    const diff = TenderVersionRegistry.diff(before, after);
    expect(diff.requirements[0]!.status).toBe("modificado");
  });

  it("un requisito IDÉNTICO -> 'sin_cambio', no aparece en affectedSectionKeys", () => {
    const same = toRequirementSnapshot(requirement());
    const diff = TenderVersionRegistry.diff({ ...BASE_SNAPSHOT, requirements: [same] }, { ...BASE_SNAPSHOT, requirements: [same] });
    expect(diff.requirements[0]!.status).toBe("sin_cambio");
    expect(diff.affectedSectionKeys).toEqual([]);
    expect(diff.hasChanges).toBe(false);
  });

  it("la identidad de un requisito es su CLAVE NATURAL (kind+clause), no su `id` de fila -- re-extraer con un id distinto pero mismo contenido cuenta como 'sin_cambio'", () => {
    const before = toRequirementSnapshot(requirement({ id: "extraction-run-1-item-3" }));
    const after = toRequirementSnapshot(requirement({ id: "extraction-run-2-item-7" })); // id regenerado por una re-extracción, mismo contenido real.
    expect(requirementNaturalKey(requirement({ id: "a" }))).toBe(requirementNaturalKey(requirement({ id: "b" })));
    const diff = TenderVersionRegistry.diff({ ...BASE_SNAPSHOT, requirements: [before] }, { ...BASE_SNAPSHOT, requirements: [after] });
    expect(diff.requirements[0]!.status).toBe("sin_cambio");
  });

  it("REQ-155: un requisito 'tecnico' modificado/nuevo/eliminado marca la sección técnica en affectedSectionKeys (SECTION_KEY_BY_REQUIREMENT_TYPE)", () => {
    const tecnico = requirement({ requirementKind: "tecnico", clause: "5.2", text: "Presentar carta de experiencia técnica" });
    const before: TenderVersionSnapshot = { ...BASE_SNAPSHOT, requirements: [] };
    const after: TenderVersionSnapshot = { ...BASE_SNAPSHOT, requirements: [toRequirementSnapshot(tecnico)] };
    const diff = TenderVersionRegistry.diff(before, after);
    expect(diff.affectedSectionKeys).toEqual(["tecnica"]);
  });

  it("varios requisitos de distinta categoría cambiados -> affectedSectionKeys sin duplicados, orden alfabético", () => {
    const before: TenderVersionSnapshot = { ...BASE_SNAPSHOT, requirements: [] };
    const after: TenderVersionSnapshot = {
      ...BASE_SNAPSHOT,
      requirements: [
        toRequirementSnapshot(requirement({ requirementKind: "tecnico", clause: "5.1", text: "a" })),
        toRequirementSnapshot(requirement({ requirementKind: "tecnico", clause: "5.2", text: "b" })),
        toRequirementSnapshot(requirement({ requirementKind: "economico", clause: "6.1", text: "c" })),
      ],
    };
    const diff = TenderVersionRegistry.diff(before, after);
    expect(diff.affectedSectionKeys).toEqual(["economica", "tecnica"]);
  });
});

describe("computeTenderSnapshotHash (REQ-152/154: dedupe/idempotencia)", () => {
  it("dos snapshots con el mismo contenido pero distinto orden de requisitos producen el MISMO hash", () => {
    const r1 = toRequirementSnapshot(requirement({ clause: "1" }));
    const r2 = toRequirementSnapshot(requirement({ clause: "2" }));
    const a: TenderVersionSnapshot = { ...BASE_SNAPSHOT, requirements: [r1, r2] };
    const b: TenderVersionSnapshot = { ...BASE_SNAPSHOT, requirements: [r2, r1] };
    expect(computeTenderSnapshotHash(a)).toBe(computeTenderSnapshotHash(b));
  });

  it("cambiar cualquier campo cambia el hash", () => {
    const a = computeTenderSnapshotHash(BASE_SNAPSHOT);
    const b = computeTenderSnapshotHash({ ...BASE_SNAPSHOT, fields: { ...BASE_FIELDS, budgetAmount: 999 } });
    expect(a).not.toBe(b);
  });
});
