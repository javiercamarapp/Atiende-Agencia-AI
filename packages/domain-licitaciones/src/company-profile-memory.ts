// Doble en memoria del perfil de empresa completo (migracion 040) y de la procedencia por campo (REQ-142): mismas reglas que
// `PostgresCompanyProfileStore` + la migracion (nace pendiente, editar un dato aprobado lo regresa a pendiente, uno por organizacion
// para el perfil). Solo vive en tests y en la API simulada de e2e.
//
// ATOMICIDAD de la procedencia: `provenanceFailure` (solo para pruebas) simula que `record_field_provenance` falla. Cada alta o edicion
// llama primero a `assertProvenanceWritable()`: si falla, NO se muta nada (equivale a que Postgres revierta el dato con su procedencia).
import { randomUUID } from "node:crypto";
import { CompanyDataNotFoundError } from "./errors.ts";
import type {
  CompanyLocationRecord,
  CompanyProductServiceRecord,
  CompanyProfileRecord,
  CompanyRestrictionRecord,
  CompanyStakeholderRecord,
  FieldProvenanceRecord,
  ProvenanceEntity,
  ProvenanceSource,
} from "./company-profile.ts";
import type {
  CompanyLocationCreateInput,
  CompanyLocationUpdateInput,
  CompanyProductServiceCreateInput,
  CompanyProductServiceUpdateInput,
  CompanyProfileCollectionKind,
  CompanyProfileUpsertInput,
  CompanyRestrictionCreateInput,
  CompanyRestrictionUpdateInput,
  CompanyStakeholderCreateInput,
  CompanyStakeholderUpdateInput,
} from "./repository.ts";
import { isoNow } from "./types.ts";

type Authored = { id: string; approvalStatus: "aprobado" | "pendiente_aprobacion" | "rechazado"; proposedBy?: string | null; approvedBy?: string | null; approvedAt?: string | null };

function fresh(actorId: string | undefined): { approvalStatus: "pendiente_aprobacion"; proposedBy: string | null; approvedBy: null; approvedAt: null } {
  return { approvalStatus: "pendiente_aprobacion", proposedBy: actorId ?? null, approvedBy: null, approvedAt: null };
}

/** Aplica el parche (solo claves definidas) y, si cambio un dato, regresa a pendiente con el nuevo autor (DB-03). */
function edit<T extends Authored>(existing: T, patch: object, actorId: string | undefined): T {
  const entries = Object.entries(patch).filter(([key, value]) => key !== "actorId" && value !== undefined);
  const changed = entries.some(([key, value]) => (existing as Record<string, unknown>)[key] !== value);
  const merged = { ...existing } as Record<string, unknown>;
  for (const [key, value] of entries) merged[key] = value;
  if (!changed) return merged as unknown as T;
  return { ...merged, approvalStatus: "pendiente_aprobacion", approvedBy: null, approvedAt: null, proposedBy: actorId ?? existing.proposedBy ?? null } as unknown as T;
}

export class InMemoryCompanyProfileStore {
  private readonly profiles = new Map<string, CompanyProfileRecord>();
  private readonly products = new Map<string, CompanyProductServiceRecord[]>();
  private readonly locations = new Map<string, CompanyLocationRecord[]>();
  private readonly restrictions = new Map<string, CompanyRestrictionRecord[]>();
  private readonly stakeholders = new Map<string, CompanyStakeholderRecord[]>();
  private readonly provenance = new Map<string, FieldProvenanceRecord[]>();

  /** Solo pruebas: si se fija, toda escritura de procedencia falla (y la alta/edicion NO ocurre). */
  provenanceFailure: Error | null = null;

  assertProvenanceWritable(): void {
    if (this.provenanceFailure) throw this.provenanceFailure;
  }

  recordProvenance(organizationId: string, entity: ProvenanceEntity, entityId: string, fields: readonly string[], actorId: string | undefined, source: ProvenanceSource = "manual"): void {
    this.assertProvenanceWritable();
    const list = [...(this.provenance.get(organizationId) ?? [])];
    for (const field of ["*", ...fields.filter((f) => f !== "*")]) {
      const row: FieldProvenanceRecord = { id: randomUUID(), entity, entityId, field, ownerUserId: actorId ?? "", source, capturedAt: isoNow() };
      const index = list.findIndex((p) => p.entity === entity && p.entityId === entityId && p.field === field);
      if (index === -1) list.push(row);
      else list[index] = { ...row, id: list[index]!.id };
    }
    this.provenance.set(organizationId, list);
  }

  listFieldProvenance(organizationId: string): readonly FieldProvenanceRecord[] {
    return this.provenance.get(organizationId) ?? [];
  }

  /** Solo pruebas: borra la procedencia de un registro, como un dato insertado por SQL fuera de la API. */
  forgetProvenance(organizationId: string, entity: ProvenanceEntity, entityId: string): void {
    this.provenance.set(organizationId, (this.provenance.get(organizationId) ?? []).filter((p) => !(p.entity === entity && p.entityId === entityId)));
  }

  /** Solo pruebas: inserta un registro SIN procedencia (como por SQL). */
  seedWithoutProvenance(kind: CompanyProfileCollectionKind, organizationId: string, record: CompanyProductServiceRecord | CompanyLocationRecord | CompanyRestrictionRecord | CompanyStakeholderRecord): void {
    const map = this.mapFor(kind);
    map.set(organizationId, [...(map.get(organizationId) ?? []), record]);
  }

  // ---- perfil ----
  getProfile(organizationId: string): CompanyProfileRecord | null {
    return this.profiles.get(organizationId) ?? null;
  }

  upsertProfile(organizationId: string, input: CompanyProfileUpsertInput): CompanyProfileRecord {
    this.assertProvenanceWritable();
    const before = this.profiles.get(organizationId);
    const data = {
      legalName: input.legalName,
      taxId: input.taxId,
      tradeName: input.tradeName ?? null,
      sector: input.sector ?? null,
      foundedYear: input.foundedYear ?? null,
      employeeCount: input.employeeCount ?? null,
      annualSalesCents: input.annualSalesCents ?? null,
      website: input.website ?? null,
    };
    const record: CompanyProfileRecord = before ? edit(before, data, input.actorId) : { id: randomUUID(), ...data, ...fresh(input.actorId) };
    this.profiles.set(organizationId, record);
    const changed = Object.keys(data).filter((k) => !before || (before as unknown as Record<string, unknown>)[k] !== (data as Record<string, unknown>)[k]);
    this.recordProvenance(organizationId, "profile", record.id, changed, input.actorId);
    return record;
  }

  // ---- colecciones ----
  private mapFor(kind: CompanyProfileCollectionKind): Map<string, Authored[]> {
    return { product: this.products, location: this.locations, restriction: this.restrictions, stakeholder: this.stakeholders }[kind] as unknown as Map<string, Authored[]>;
  }

  list<R>(kind: CompanyProfileCollectionKind, organizationId: string): readonly R[] {
    return (this.mapFor(kind).get(organizationId) ?? []) as unknown as R[];
  }

  private createItem<R extends Authored>(kind: CompanyProfileCollectionKind, entity: ProvenanceEntity, organizationId: string, data: Record<string, unknown>, actorId: string | undefined, provided: object): R {
    this.assertProvenanceWritable();
    const record = { id: randomUUID(), ...data, ...fresh(actorId) } as unknown as R;
    const map = this.mapFor(kind);
    map.set(organizationId, [...(map.get(organizationId) ?? []), record]);
    this.recordProvenance(organizationId, entity, record.id, Object.keys(data).filter((k) => (provided as Record<string, unknown>)[k] !== undefined), actorId);
    return record;
  }

  private updateItem<R extends Authored>(kind: CompanyProfileCollectionKind, entity: ProvenanceEntity, label: string, organizationId: string, id: string, patch: Record<string, unknown>, actorId: string | undefined): R {
    this.assertProvenanceWritable();
    const map = this.mapFor(kind);
    const list = map.get(organizationId) ?? [];
    const index = list.findIndex((r) => r.id === id);
    if (index === -1) throw new CompanyDataNotFoundError(label, id);
    const updated = edit(list[index]!, patch, actorId) as R;
    const next = [...list];
    next[index] = updated;
    map.set(organizationId, next);
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (keys.length > 0) this.recordProvenance(organizationId, entity, id, keys, actorId);
    return updated;
  }

  remove(kind: CompanyProfileCollectionKind, organizationId: string, id: string): boolean {
    const map = this.mapFor(kind);
    const list = map.get(organizationId) ?? [];
    if (!list.some((r) => r.id === id)) return false;
    map.set(organizationId, list.filter((r) => r.id !== id));
    return true;
  }

  /** Para `decideCompanyItem`: el almacen (como lista) y su reescritura. */
  decidable(kind: "profile" | CompanyProfileCollectionKind, organizationId: string): { list: readonly Authored[]; set: (next: Authored[]) => void } {
    if (kind === "profile") {
      const p = this.profiles.get(organizationId);
      return { list: p ? [p] : [], set: (next) => { if (next[0]) this.profiles.set(organizationId, next[0] as unknown as CompanyProfileRecord); } };
    }
    const map = this.mapFor(kind);
    return { list: map.get(organizationId) ?? [], set: (next) => { map.set(organizationId, next); } };
  }

  createProduct(o: string, i: CompanyProductServiceCreateInput) { return this.createItem<CompanyProductServiceRecord>("product", "product", o, { kind: i.kind, name: i.name, description: i.description ?? null, classifierCode: i.classifierCode ?? null }, i.actorId, i); }
  updateProduct(o: string, id: string, i: CompanyProductServiceUpdateInput) { return this.updateItem<CompanyProductServiceRecord>("product", "product", "Producto o servicio", o, id, { name: i.name, description: i.description, classifierCode: i.classifierCode }, i.actorId); }
  createLocation(o: string, i: CompanyLocationCreateInput) { return this.createItem<CompanyLocationRecord>("location", "location", o, { kind: i.kind, name: i.name, state: i.state, municipality: i.municipality ?? null, address: i.address ?? null }, i.actorId, i); }
  updateLocation(o: string, id: string, i: CompanyLocationUpdateInput) { return this.updateItem<CompanyLocationRecord>("location", "location", "Ubicación", o, id, { kind: i.kind, name: i.name, state: i.state, municipality: i.municipality, address: i.address }, i.actorId); }
  createRestriction(o: string, i: CompanyRestrictionCreateInput) { return this.createItem<CompanyRestrictionRecord>("restriction", "restriction", o, { kind: i.kind, description: i.description, validFrom: i.validFrom, validUntil: i.validUntil ?? null }, i.actorId, i); }
  updateRestriction(o: string, id: string, i: CompanyRestrictionUpdateInput) { return this.updateItem<CompanyRestrictionRecord>("restriction", "restriction", "Restricción", o, id, { kind: i.kind, description: i.description, validFrom: i.validFrom, validUntil: i.validUntil }, i.actorId); }
  createStakeholder(o: string, i: CompanyStakeholderCreateInput) { return this.createItem<CompanyStakeholderRecord>("stakeholder", "stakeholder", o, { kind: i.kind, fullName: i.fullName, rfc: i.rfc ?? null, participationPct: i.participationPct ?? null }, i.actorId, i); }
  updateStakeholder(o: string, id: string, i: CompanyStakeholderUpdateInput) { return this.updateItem<CompanyStakeholderRecord>("stakeholder", "stakeholder", "Socio o representante", o, id, { fullName: i.fullName, rfc: i.rfc, participationPct: i.participationPct }, i.actorId); }
}
