// Hallazgo de revisión real (PR #149, Fase 3 caller-binding): mergear a `main`
// despliega el código de inmediato, pero la base de datos REAL va DETRÁS (las
// migraciones se aplican después, a mano) -- así que "código nuevo, migración
// vieja" es el caso NORMAL de este monorepo, no una excepción. Si
// `PostgresCoreRepository.findStaffForOrgAdmin`/`isStaffOrgMember` llamaran
// directo a `core.find_staff_for_org_admin`/`core.is_staff_org_member_for_org_
// admin` sin ningún resguardo, invitar/administrar staff en las 5 verticales
// quedaría ROTO ("function does not exist") justo después de mergear, hasta que
// alguien aplicara la migración a mano -- una regresión real sobre un flujo que
// hoy funciona.
//
// Estos tests ejercitan el fallback (ver el comentario de cabecera de ambos
// métodos en `../src/postgres-core-repository.ts`) contra un `TenantDbSession`
// FALSO (nunca Postgres real -- eso ya lo cubre `scripts/verify-caller-binding-
// fase3/` contra Postgres real, que solo puede probar el camino NUEVO porque
// aplica todas las migraciones): SQLSTATE 42883 (`undefined_function`, lo que
// Postgres real lanza cuando la función nueva no existe todavía) degrada al
// camino ANTERIOR a esta fase (`core.find_staff_by_email`/`core.find_
// memberships_by_user_id`) aplicando en TypeScript la MISMA restricción de
// autorización que impondría la función nueva; cualquier otro código de error se
// repropaga tal cual.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresCoreRepository } from "../src/postgres-core-repository.ts";

function undefinedFunctionError(): Error & { code: string } {
  const err = new Error('function core.find_staff_for_org_admin(uuid, text) does not exist') as Error & { code: string };
  err.code = "42883";
  return err;
}

function otherPgError(): Error & { code: string } {
  const err = new Error("connection terminated unexpectedly") as Error & { code: string };
  err.code = "57P01"; // admin_shutdown -- código real de Postgres, deliberadamente NO 42883/42501
  return err;
}

/** Sesión falsa mínima -- despacha por el texto SQL (nunca ejecuta nada real). Cada
 *  test arma su propio `handlers` (una función por sustring reconocible de la
 *  query) para controlar exactamente qué responde cada llamada, en el ORDEN real
 *  que el código de producción las hace. */
function fakeSession(handlers: { match: RegExp; respond: () => unknown }[]): TenantDbSession {
  return {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      for (const h of handlers) {
        if (h.match.test(sql)) {
          const result = h.respond();
          if (result instanceof Error) throw result;
          return { rows: result as T[] };
        }
      }
      throw new Error(`fakeSession: ninguna regla coincide con la query -> ${sql}`);
    },
    async exec(): Promise<void> {
      throw new Error("fakeSession.exec no debería usarse en estos tests");
    },
  };
}

const ORG_ID = "00000000-0000-0000-0000-0000000000aa";
const EMAIL = "candidato@example.com";
const TARGET_ID = "00000000-0000-0000-0000-0000000000bb";

describe("PostgresCoreRepository.findStaffForOrgAdmin -- fallback SQLSTATE 42883", () => {
  it("función existente -> camino NUEVO: llama core.find_staff_for_org_admin directo, sin fallback", async () => {
    const session = fakeSession([
      {
        match: /core\.find_staff_for_org_admin/,
        respond: () => [{ id: TARGET_ID, email: EMAIL, full_name: "Candidato Real" }],
      },
      // Si el repo intentara el fallback (no debería), esta regla lanzaría --
      // demuestra que el camino viejo NUNCA se toca cuando el nuevo funciona.
      { match: /core\.find_staff_by_email/, respond: () => new Error("no debería llamarse -- la función nueva SÍ existe") },
    ]);
    const repo = new PostgresCoreRepository(session);

    const result = await repo.findStaffForOrgAdmin(ORG_ID, EMAIL);

    expect(result).toEqual({ id: TARGET_ID, email: EMAIL, fullName: "Candidato Real" });
  });

  it("función inexistente (42883) + caller owner/admin -> camino VIEJO: degrada a core.find_staff_by_email, misma restricción aplicada en TS", async () => {
    const session = fakeSession([
      { match: /core\.find_staff_for_org_admin/, respond: () => undefinedFunctionError() },
      // El fallback verifica primero que el caller (auth.uid() de esta sesión) sea
      // owner/admin de ORG_ID -- simula que SÍ lo es (una fila).
      { match: /from core\.membership/, respond: () => [{ platform_role: "owner" }] },
      { match: /core\.find_staff_by_email/, respond: () => [{ id: TARGET_ID, email: EMAIL, full_name: "Candidato Real" }] },
    ]);
    const repo = new PostgresCoreRepository(session);

    const result = await repo.findStaffForOrgAdmin(ORG_ID, EMAIL);

    // Mismo resultado que el camino nuevo, y NUNCA más columnas que id/email/
    // fullName (el fallback selecciona explícitamente esas 3, nunca password_hash).
    expect(result).toEqual({ id: TARGET_ID, email: EMAIL, fullName: "Candidato Real" });
  });

  it("función inexistente (42883) + caller SIN rango de admin -> el fallback rechaza (42501), nunca expone el correo", async () => {
    const session = fakeSession([
      { match: /core\.find_staff_for_org_admin/, respond: () => undefinedFunctionError() },
      // Cero filas -- el caller no es owner/admin de ORG_ID (o ni siquiera es
      // miembro).
      { match: /from core\.membership/, respond: () => [] },
      { match: /core\.find_staff_by_email/, respond: () => new Error("no debería llamarse -- la autorización de respaldo debe rechazar ANTES") },
    ]);
    const repo = new PostgresCoreRepository(session);

    await expect(repo.findStaffForOrgAdmin(ORG_ID, EMAIL)).rejects.toMatchObject({ code: "42501" });
  });

  it("cualquier OTRO código de error (no 42883) se repropaga tal cual -- el fallback NUNCA enmascara un fallo real", async () => {
    const session = fakeSession([{ match: /core\.find_staff_for_org_admin/, respond: () => otherPgError() }]);
    const repo = new PostgresCoreRepository(session);

    await expect(repo.findStaffForOrgAdmin(ORG_ID, EMAIL)).rejects.toMatchObject({ code: "57P01" });
  });
});

describe("PostgresCoreRepository.isStaffOrgMember -- fallback SQLSTATE 42883", () => {
  it("función existente -> camino NUEVO: llama core.is_staff_org_member_for_org_admin directo", async () => {
    const session = fakeSession([{ match: /core\.is_staff_org_member_for_org_admin/, respond: () => [{ is_staff_org_member_for_org_admin: true }] }]);
    const repo = new PostgresCoreRepository(session);

    expect(await repo.isStaffOrgMember(ORG_ID, TARGET_ID)).toBe(true);
  });

  it("función inexistente (42883) + caller owner/admin -> camino VIEJO: degrada a core.find_memberships_by_user_id filtrado por organización", async () => {
    const session = fakeSession([
      { match: /core\.is_staff_org_member_for_org_admin/, respond: () => undefinedFunctionError() },
      { match: /from core\.membership/, respond: () => [{ platform_role: "admin" }] },
      // El target pertenece a ORG_ID Y a otra organización -- el fallback debe
      // filtrar por ORG_ID, no devolver "true" solo porque tiene ALGUNA membership.
      { match: /core\.find_memberships_by_user_id/, respond: () => [{ organization_id: "00000000-0000-0000-0000-0000000000zz" }, { organization_id: ORG_ID }] },
    ]);
    const repo = new PostgresCoreRepository(session);

    expect(await repo.isStaffOrgMember(ORG_ID, TARGET_ID)).toBe(true);
  });

  it("función inexistente (42883) + target SIN membership en esa organización -> false (nunca lanza)", async () => {
    const session = fakeSession([
      { match: /core\.is_staff_org_member_for_org_admin/, respond: () => undefinedFunctionError() },
      { match: /from core\.membership/, respond: () => [{ platform_role: "owner" }] },
      { match: /core\.find_memberships_by_user_id/, respond: () => [{ organization_id: "00000000-0000-0000-0000-0000000000zz" }] },
    ]);
    const repo = new PostgresCoreRepository(session);

    expect(await repo.isStaffOrgMember(ORG_ID, TARGET_ID)).toBe(false);
  });

  it("función inexistente (42883) + caller SIN rango de admin -> el fallback rechaza (42501)", async () => {
    const session = fakeSession([
      { match: /core\.is_staff_org_member_for_org_admin/, respond: () => undefinedFunctionError() },
      { match: /from core\.membership/, respond: () => [] },
    ]);
    const repo = new PostgresCoreRepository(session);

    await expect(repo.isStaffOrgMember(ORG_ID, TARGET_ID)).rejects.toMatchObject({ code: "42501" });
  });

  it("cualquier OTRO código de error (no 42883) se repropaga tal cual", async () => {
    const session = fakeSession([{ match: /core\.is_staff_org_member_for_org_admin/, respond: () => otherPgError() }]);
    const repo = new PostgresCoreRepository(session);

    await expect(repo.isStaffOrgMember(ORG_ID, TARGET_ID)).rejects.toMatchObject({ code: "57P01" });
  });
});

describe("advertencia de fallback -- una sola vez por proceso", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("console.warn se dispara UNA sola vez aunque el fallback se use varias veces seguidas", async () => {
    // Módulo fresco (vi.resetModules) -- el flag "ya advertí" vive a nivel de
    // módulo (`warnedAboutMissingOrgAdminFunctions`), así que este test necesita
    // su propia instancia para no depender del orden de los tests de arriba.
    vi.resetModules();
    const { PostgresCoreRepository: FreshPostgresCoreRepository } = await import("../src/postgres-core-repository.ts");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const session = fakeSession([
      { match: /core\.find_staff_for_org_admin/, respond: () => undefinedFunctionError() },
      { match: /core\.is_staff_org_member_for_org_admin/, respond: () => undefinedFunctionError() },
      { match: /from core\.membership/, respond: () => [{ platform_role: "owner" }] },
      { match: /core\.find_staff_by_email/, respond: () => [] },
      { match: /core\.find_memberships_by_user_id/, respond: () => [] },
    ]);
    const repo = new FreshPostgresCoreRepository(session);

    await repo.findStaffForOrgAdmin(ORG_ID, EMAIL);
    await repo.isStaffOrgMember(ORG_ID, TARGET_ID);
    await repo.findStaffForOrgAdmin(ORG_ID, EMAIL);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("42883");
  });
});
