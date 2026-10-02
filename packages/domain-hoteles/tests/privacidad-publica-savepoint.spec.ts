// H-30 -- regresion de la REGLA DURA de compatibilidad con la base sin migrar contra los repositorios Postgres REALES de la privacidad
// publica (PostgresPublicPrivacyRepository / PostgresGuestDataRepository) + AbortAwareFakeSession, que reproduce el estado ABORTADO de una
// transaccion de Postgres: tras un error, toda consulta posterior lanza 25P02 salvo un ROLLBACK TO SAVEPOINT. Una sesion falsa plana NO
// sirve. Cada test FALLA si se quita el SAVEPOINT (la consulta `select 1 as despues` revienta con 25P02).
import { describe, expect, it } from "vitest";
import {
  PostgresGuestDataRepository,
  PostgresPublicPrivacyRepository,
  PrivacyAccessDeniedError,
  PrivacyInvalidInputError,
  PrivacyNotFoundError,
  PrivacyUnavailableError,
} from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const P = "00000000-0000-4000-8000-0000000000a1";
const G = "00000000-0000-4000-8000-0000000000d1";
const R = "00000000-0000-4000-8000-0000000000e1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const missingFn = (name: string) => pgError("42883", `function hoteles.${name}() does not exist`);
const siguiente = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };
const sigueUtil = async (session: AbortAwareFakeSession) => {
  await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
};
const input = {
  requestId: R,
  propertyId: P,
  rightType: "acceso" as const,
  name: "Ana Torres",
  contact: "ana@example.com",
  description: null,
  codeHash: "a".repeat(64),
  ttlSeconds: 900,
  email: { to: "ana@example.com", subject: "s", html: "<p>x</p>", text: "x" },
  today: "2026-10-01",
};

describe("lecturas publicas con base sin migrar: 'no disponible aun', no 'sin avisos'", () => {
  it("el aviso responde available:false con la funcion ausente (42883) y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /public_privacy_notices/i, respond: () => missingFn("public_privacy_notices") }, siguiente]);
    await expect(new PostgresPublicPrivacyRepository(session).listNotices("hotel-a")).resolves.toEqual({ available: false, organizationName: null, properties: [] });
    await sigueUtil(session);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });
  it("tabla ausente (42P01) dentro de la funcion tambien degrada", async () => {
    const session = new AbortAwareFakeSession([{ match: /public_privacy_notices/i, respond: () => pgError("42P01", 'relation "hoteles.privacy_notice" does not exist') }, siguiente]);
    await expect(new PostgresPublicPrivacyRepository(session).listNotices("hotel-a")).resolves.toMatchObject({ available: false });
    await sigueUtil(session);
  });
  it("con la migracion aplicada arma las propiedades con y sin aviso", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /public_privacy_notices/i,
        respond: () => [
          { out_org_name: "Hotel A", out_property_id: P, out_property_name: "Centro", out_notice_id: "n1", out_version: "v1", out_simplified_text: "texto", out_integral_url: null, out_mandatory: ["a"], out_optional: null, out_published_at: "2026-01-01" },
          { out_org_name: "Hotel A", out_property_id: G, out_property_name: "Playa", out_notice_id: null, out_version: null, out_simplified_text: null, out_integral_url: null, out_mandatory: null, out_optional: null, out_published_at: null },
        ],
      },
    ]);
    const r = await new PostgresPublicPrivacyRepository(session).listNotices("hotel-a");
    expect(r.available).toBe(true);
    expect(r.organizationName).toBe("Hotel A");
    expect(r.properties[0]!.notice).toMatchObject({ version: "v1", optionalPurposes: [] });
    expect(r.properties[1]!.notice).toBeNull();
  });
});

describe("escrituras publicas con base sin migrar: 503 honesto (PrivacyUnavailableError), nunca 500", () => {
  it("alta, verificacion y mis datos lanzan PrivacyUnavailableError y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /public_arco_submit/i, respond: () => missingFn("public_arco_submit") },
      { match: /public_arco_verify/i, respond: () => missingFn("public_arco_verify") },
      { match: /arco_access_snapshot/i, respond: () => missingFn("arco_access_snapshot") },
      siguiente,
    ]);
    const repo = new PostgresPublicPrivacyRepository(session);
    await expect(repo.submitArco(input)).rejects.toBeInstanceOf(PrivacyUnavailableError);
    await sigueUtil(session);
    await expect(repo.verifyArco(R, "a".repeat(64), null)).rejects.toBeInstanceOf(PrivacyUnavailableError);
    await sigueUtil(session);
    await expect(repo.accessSnapshot(R, "hotel-a")).rejects.toBeInstanceOf(PrivacyUnavailableError);
    await sigueUtil(session);
  });
  it("un error REAL de la funcion (22023) no se confunde con 'migracion pendiente': llega como entrada invalida", async () => {
    const session = new AbortAwareFakeSession([{ match: /public_arco_submit/i, respond: () => pgError("22023", "contacto_invalido") }, siguiente]);
    await expect(new PostgresPublicPrivacyRepository(session).submitArco(input)).rejects.toBeInstanceOf(PrivacyInvalidInputError);
    await sigueUtil(session);
  });
  it("alta correcta devuelve la referencia y NULL (tope por contacto) se propaga como null", async () => {
    const session = new AbortAwareFakeSession([{ match: /public_arco_submit/i, respond: () => [{ id: null }] }]);
    await expect(new PostgresPublicPrivacyRepository(session).submitArco(input)).resolves.toBeNull();
  });
  it("verificar devuelve el resultado de la base y 'invalido' si no hay fila", async () => {
    const ok = new AbortAwareFakeSession([{ match: /public_arco_verify/i, respond: () => [{ out_result: "ok", out_organization_id: "o", out_property_id: P, out_folio: "ARCO-1" }] }]);
    await expect(new PostgresPublicPrivacyRepository(ok).verifyArco(R, "a".repeat(64), "2026-10-01")).resolves.toEqual({ result: "ok", organizationId: "o", propertyId: P, folio: "ARCO-1" });
    const vacio = new AbortAwareFakeSession([{ match: /public_arco_verify/i, respond: () => [] }]);
    await expect(new PostgresPublicPrivacyRepository(vacio).verifyArco(R, "a".repeat(64), null)).resolves.toMatchObject({ result: "invalido" });
  });
});

describe("exportacion y enlace del staff con base sin migrar", () => {
  it("exportar sin la funcion (42883) o sin una tabla que lee (42P01) = 503: nunca exporta sin poder registrar", async () => {
    const sin = new AbortAwareFakeSession([{ match: /export_guest_data/i, respond: () => missingFn("export_guest_data") }, siguiente]);
    await expect(new PostgresGuestDataRepository(sin).exportGuestData(P, G, "json")).rejects.toBeInstanceOf(PrivacyUnavailableError);
    await sigueUtil(sin);
    const tabla = new AbortAwareFakeSession([{ match: /export_guest_data/i, respond: () => pgError("42P01", 'relation "hoteles.guest_note" does not exist') }, siguiente]);
    await expect(new PostgresGuestDataRepository(tabla).exportGuestData(P, G, "csv")).rejects.toBeInstanceOf(PrivacyUnavailableError);
    await sigueUtil(tabla);
  });
  it("sin permiso (42501) = acceso denegado; huesped fuera de la property (23503) = no encontrado; formato invalido (22023) = entrada invalida", async () => {
    const denegado = new AbortAwareFakeSession([{ match: /export_guest_data/i, respond: () => pgError("42501", "property no disponible") }, siguiente]);
    await expect(new PostgresGuestDataRepository(denegado).exportGuestData(P, G, "json")).rejects.toBeInstanceOf(PrivacyAccessDeniedError);
    await sigueUtil(denegado);
    const ajeno = new AbortAwareFakeSession([{ match: /export_guest_data/i, respond: () => pgError("23503", "huesped no disponible") }, siguiente]);
    await expect(new PostgresGuestDataRepository(ajeno).exportGuestData(P, G, "json")).rejects.toBeInstanceOf(PrivacyNotFoundError);
    await sigueUtil(ajeno);
    const formato = new AbortAwareFakeSession([{ match: /export_guest_data/i, respond: () => pgError("22023", "formato_invalido") }, siguiente]);
    await expect(new PostgresGuestDataRepository(formato).exportGuestData(P, G, "json")).rejects.toBeInstanceOf(PrivacyInvalidInputError);
  });
  it("exportar correcto devuelve el documento; el enlace sin la funcion = 503 y con estado invalido (P0001) = conflicto", async () => {
    const doc = { perfil: { nombre: "Ana" }, estancias: [], consentimientos: [], identidad: [] };
    const ok = new AbortAwareFakeSession([{ match: /export_guest_data/i, respond: () => [{ doc }] }]);
    await expect(new PostgresGuestDataRepository(ok).exportGuestData(P, G, "json")).resolves.toEqual(doc);
    const sin = new AbortAwareFakeSession([{ match: /arco_access_grant/i, respond: () => missingFn("arco_access_grant") }, siguiente]);
    await expect(new PostgresGuestDataRepository(sin).grantAccess(R, G)).rejects.toBeInstanceOf(PrivacyUnavailableError);
    await sigueUtil(sin);
    const grant = new AbortAwareFakeSession([{ match: /arco_access_grant/i, respond: () => [{ out_organization_id: "o", out_property_id: P, out_folio: "ARCO-1", out_contact: "a@b.co", out_org_slug: "hotel-a", out_org_name: "Hotel A" }] }]);
    await expect(new PostgresGuestDataRepository(grant).grantAccess(R, G)).resolves.toMatchObject({ folio: "ARCO-1", orgSlug: "hotel-a" });
  });
});
