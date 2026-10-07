// Perfil de empresa completo (REQ-141) y procedencia por campo (REQ-142): registros de las tablas de la migracion 040 y el
// indice de procedencia que consumen `CompanyDataService` y `MatchingEngine`. Sin I/O.
//
// Regla de REQ-142 que aplica este modulo: un dato SIN procedencia no es utilizable. La procedencia solo la escribe la API
// (funcion `licitaciones.record_field_provenance`, security definer, misma transaccion que el alta o edicion); una fila
// insertada por SQL directo nunca tiene procedencia y por eso no cuenta como valida.
import type { MipymeSector } from "./mipyme.ts";

export type ProfileApprovalStatus = "aprobado" | "pendiente_aprobacion" | "rechazado";

/** Autoria y decision (mismas columnas que el resto de datos de empresa, migracion 036). */
export interface ProfileItemAuthorship {
  readonly approvalStatus: ProfileApprovalStatus;
  readonly proposedBy?: string | null;
  readonly approvedBy?: string | null;
  readonly approvedAt?: string | null;
}

export interface CompanyProfileRecord extends ProfileItemAuthorship {
  readonly id: string;
  readonly legalName: string;
  /** RFC ya normalizado (mayusculas, forma valida). */
  readonly taxId: string;
  readonly tradeName: string | null;
  readonly sector: MipymeSector | null;
  readonly foundedYear: number | null;
  readonly employeeCount: number | null;
  /** Ventas anuales en CENTAVOS de peso. */
  readonly annualSalesCents: number | null;
  readonly website: string | null;
}

export const PRODUCT_SERVICE_KINDS = ["producto", "servicio"] as const;
export type ProductServiceKind = (typeof PRODUCT_SERVICE_KINDS)[number];
export interface CompanyProductServiceRecord extends ProfileItemAuthorship {
  readonly id: string;
  readonly kind: ProductServiceKind;
  readonly name: string;
  readonly description: string | null;
  /** Clasificador (CPV/CUCoP) declarado por la empresa; texto libre acotado, sin interpretar. */
  readonly classifierCode: string | null;
}

export const LOCATION_KINDS = ["matriz", "sucursal", "bodega", "planta"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];
export interface CompanyLocationRecord extends ProfileItemAuthorship {
  readonly id: string;
  readonly kind: LocationKind;
  readonly name: string;
  readonly state: string;
  readonly municipality: string | null;
  readonly address: string | null;
}

export const RESTRICTION_KINDS = ["inhabilitacion", "sancion", "conflicto_interes", "otra"] as const;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];
export interface CompanyRestrictionRecord extends ProfileItemAuthorship {
  readonly id: string;
  readonly kind: RestrictionKind;
  readonly description: string;
  /** Fecha de negocio "YYYY-MM-DD". */
  readonly validFrom: string;
  /** `null` = sin fecha de termino conocida (la restriccion sigue vigente). */
  readonly validUntil: string | null;
}

export const STAKEHOLDER_KINDS = ["socio", "representante"] as const;
export type StakeholderKind = (typeof STAKEHOLDER_KINDS)[number];
export interface CompanyStakeholderRecord extends ProfileItemAuthorship {
  readonly id: string;
  readonly kind: StakeholderKind;
  readonly fullName: string;
  /** RFC normalizado o `null` si no se conoce. */
  readonly rfc: string | null;
  /** Porcentaje con exactamente dos decimales ("33.33") o `null` (los representantes no tienen participacion). */
  readonly participationPct: string | null;
}

/** Entidades que pueden tener procedencia (una por tabla de datos de empresa). */
export const PROVENANCE_ENTITIES = ["profile", "product", "location", "restriction", "stakeholder", "signer", "rate", "document", "capability", "experience"] as const;
export type ProvenanceEntity = (typeof PROVENANCE_ENTITIES)[number];
export const PROVENANCE_SOURCES = ["manual", "importado", "asistente"] as const;
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

/**
 * Entidades cuyo dato SIN procedencia queda bloqueado (REQ-142). Son las tablas que introduce la migracion 040: las cinco
 * tablas anteriores (tarifas, documentos, capacidades, experiencia) ya tenian datos reales antes de que existiera la
 * procedencia y no hay un respaldo honesto que inventarles; su procedencia SI se registra desde ahora en cada alta o
 * edicion, pero aun no bloquea (hueco declarado en el PR). Los firmantes (anteriores) tampoco bloquean por la misma razon.
 */
export const PROVENANCE_REQUIRED_ENTITIES: readonly ProvenanceEntity[] = ["profile", "product", "location", "restriction", "stakeholder"];

export interface FieldProvenanceRecord {
  readonly id: string;
  readonly entity: ProvenanceEntity;
  readonly entityId: string;
  /** Nombre del campo, o `*` = el registro completo. */
  readonly field: string;
  readonly ownerUserId: string;
  readonly source: ProvenanceSource;
  readonly capturedAt: string;
}

/** Indice de procedencia: "este registro tiene quien lo capturo". */
export class ProvenanceIndex {
  private readonly byKey = new Map<string, FieldProvenanceRecord[]>();
  constructor(records: readonly FieldProvenanceRecord[] = []) {
    for (const r of records) {
      const key = `${r.entity}:${r.entityId}`;
      const list = this.byKey.get(key);
      if (list) list.push(r);
      else this.byKey.set(key, [r]);
    }
  }
  /** `true` si el registro tiene al menos una fila de procedencia (el registro completo `*` o algun campo). */
  has(entity: ProvenanceEntity, entityId: string): boolean {
    return (this.byKey.get(`${entity}:${entityId}`)?.length ?? 0) > 0;
  }
  /** Procedencia del registro completo (`*`), o la de un campo si se pide. */
  get(entity: ProvenanceEntity, entityId: string, field = "*"): FieldProvenanceRecord | undefined {
    return this.byKey.get(`${entity}:${entityId}`)?.find((r) => r.field === field);
  }
}

/** Participacion en porcentaje con dos decimales exactos: "5" -> "5.00", "33.333" es invalido, "100.01" es invalido. `null` si no cumple. */
export function normalizeParticipationPct(raw: unknown): string | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const whole = Number(m[1]);
  const cents = Number((m[2] ?? "").padEnd(2, "0") || "0");
  if (whole > 100 || (whole === 100 && cents > 0)) return null;
  return `${whole}.${String(cents).padStart(2, "0")}`;
}
