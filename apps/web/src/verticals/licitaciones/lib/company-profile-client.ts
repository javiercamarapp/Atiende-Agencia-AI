// Cliente del perfil de empresa completo (L-P3-03/04, REQ-141/142/109): perfil general + estratificacion MIPyME, productos y servicios,
// ubicaciones, restricciones y socios/representantes. Llama a `GET/PUT/POST/PATCH/DELETE .../company/{profile,products-services,locations,
// restrictions,stakeholders}` (companyProfile.ts). Cada listado trae `disponible` (la base ya tiene la migracion 040) y la procedencia
// de cada dato (quien lo capturo y cuando). El servidor decide todo (roles, autor distinto del aprobador, validaciones): esto solo habla HTTP.
import { deleteJson, fetchJson, patchJson, postJson, putJson } from "./admin-client.ts";
import { withNames } from "./company-data-client.ts";
import type { CompanyDataApprovalStatus, CompanyDataAuthorship, WithPeople } from "./company-data-client.ts";

export type MipymeSector = "industria" | "comercio" | "servicios";
export const MIPYME_SECTOR_LABEL: Readonly<Record<MipymeSector, string>> = { industria: "Industria", comercio: "Comercio", servicios: "Servicios" };

export interface CompanyProfile extends CompanyDataAuthorship {
  readonly id: string;
  readonly legalName: string;
  readonly taxId: string;
  readonly tradeName: string | null;
  readonly sector: MipymeSector | null;
  readonly foundedYear: number | null;
  readonly employeeCount: number | null;
  /** Ventas anuales en CENTAVOS. */
  readonly annualSalesCents: number | null;
  readonly website: string | null;
  readonly approvalStatus: CompanyDataApprovalStatus;
}

export type MipymeEstrato = "micro" | "pequena" | "mediana" | "grande";
export type MipymeResult =
  | { readonly status: "calculado"; readonly estrato: MipymeEstrato; readonly puntajeCombinado: string; readonly verificacion: string; readonly validarConAbogado: boolean }
  | { readonly status: "no_evaluable"; readonly motivo: string; readonly faltan: readonly string[]; readonly verificacion: string; readonly validarConAbogado: boolean };

export interface NormaFichaView {
  readonly id: string;
  readonly titulo: string;
  readonly estadoVerificacion: string;
  readonly validarConAbogado: boolean;
  readonly nota: string;
}

export interface CompanyProfileView {
  /** `false` = la base aun no tiene la migracion 040: la pantalla declara "no disponible aun" y no ofrece captura. */
  readonly disponible: boolean;
  readonly profile: CompanyProfile | null;
  readonly mipyme: MipymeResult | null;
  readonly norma: NormaFichaView | null;
}

export interface CompanyProfileInput {
  readonly legalName: string;
  readonly taxId: string;
  readonly tradeName?: string | null;
  readonly sector?: MipymeSector | null;
  readonly foundedYear?: number | null;
  readonly employeeCount?: number | null;
  readonly annualSalesCents?: number | null;
  readonly website?: string | null;
}

const base = (apiBaseUrl: string, propertyId: string, resource: string) => `${apiBaseUrl}/licitaciones/${propertyId}/company/${resource}`;

export async function fetchCompanyProfile(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<CompanyProfileView> {
  const body = await fetchJson<{
    readonly disponible: boolean;
    readonly profile: CompanyProfile | null;
    readonly mipyme: MipymeResult | null;
    readonly norma: NormaFichaView | null;
    readonly people?: Readonly<Record<string, string>>;
    readonly provenance?: Readonly<Record<string, { readonly by: string; readonly source: string; readonly at: string }>>;
  }>(fetchImpl, base(apiBaseUrl, propertyId, "profile"), token);
  const [profile] = body.profile ? withNames([body.profile], body.people, body.provenance) : [];
  return { disponible: body.disponible, profile: profile ?? null, mipyme: body.mipyme, norma: body.norma };
}

export async function saveCompanyProfile(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: CompanyProfileInput): Promise<CompanyProfile> {
  return putJson<CompanyProfile>(fetchImpl, base(apiBaseUrl, propertyId, "profile"), token, input);
}

// ---- Colecciones ----

export const PROFILE_COLLECTIONS = {
  products: { segment: "products-services", listKey: "productsServices", kind: "product" },
  locations: { segment: "locations", listKey: "locations", kind: "location" },
  restrictions: { segment: "restrictions", listKey: "restrictions", kind: "restriction" },
  stakeholders: { segment: "stakeholders", listKey: "stakeholders", kind: "stakeholder" },
} as const;
export type ProfileCollectionName = keyof typeof PROFILE_COLLECTIONS;

export interface CompanyProductService extends CompanyDataAuthorship {
  readonly id: string;
  readonly kind: "producto" | "servicio";
  readonly name: string;
  readonly description: string | null;
  readonly classifierCode: string | null;
  readonly approvalStatus: CompanyDataApprovalStatus;
}
export interface CompanyLocation extends CompanyDataAuthorship {
  readonly id: string;
  readonly kind: "matriz" | "sucursal" | "bodega" | "planta";
  readonly name: string;
  readonly state: string;
  readonly municipality: string | null;
  readonly address: string | null;
  readonly approvalStatus: CompanyDataApprovalStatus;
}
export interface CompanyRestriction extends CompanyDataAuthorship {
  readonly id: string;
  readonly kind: "inhabilitacion" | "sancion" | "conflicto_interes" | "otra";
  readonly description: string;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly approvalStatus: CompanyDataApprovalStatus;
}
export interface CompanyStakeholder extends CompanyDataAuthorship {
  readonly id: string;
  readonly kind: "socio" | "representante";
  readonly fullName: string;
  readonly rfc: string | null;
  readonly participationPct: string | null;
  readonly approvalStatus: CompanyDataApprovalStatus;
}

export interface ProfileCollectionView<T> {
  readonly disponible: boolean;
  readonly items: readonly T[];
}

export async function fetchProfileCollection<T extends CompanyDataAuthorship & { readonly id: string }>(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  name: ProfileCollectionName,
): Promise<ProfileCollectionView<T>> {
  const spec = PROFILE_COLLECTIONS[name];
  const body = await fetchJson<{ readonly disponible: boolean } & Record<string, unknown>>(fetchImpl, base(apiBaseUrl, propertyId, spec.segment), token);
  const raw = (body[spec.listKey] ?? []) as readonly T[];
  return { disponible: body.disponible !== false, items: withNames(raw, body.people as Readonly<Record<string, string>> | undefined, body.provenance as WithPeople<"x", T>["provenance"]) };
}

export async function createProfileItem<T>(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, name: ProfileCollectionName, input: Record<string, unknown>): Promise<T> {
  return postJson<T>(fetchImpl, base(apiBaseUrl, propertyId, PROFILE_COLLECTIONS[name].segment), token, input);
}

export async function updateProfileItem<T>(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, name: ProfileCollectionName, id: string, input: Record<string, unknown>): Promise<T> {
  return patchJson<T>(fetchImpl, `${base(apiBaseUrl, propertyId, PROFILE_COLLECTIONS[name].segment)}/${encodeURIComponent(id)}`, token, input);
}

export async function deleteProfileItem(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, name: ProfileCollectionName, id: string): Promise<void> {
  await deleteJson<unknown>(fetchImpl, `${base(apiBaseUrl, propertyId, PROFILE_COLLECTIONS[name].segment)}/${encodeURIComponent(id)}`, token);
}
