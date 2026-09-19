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
// Hallazgo ALTO de auditoría (a1, r3): el `catch` original (sin SAVEPOINT) SÍ
// capturaba el 42883, pero las consultas del propio fallback corrían sobre la
// MISMA transacción ya abortada -- fallaban con 25P02 (un 500 genérico) en vez de
// degradar de verdad. Este archivo usaba antes un `fakeSession` plano (despacha
// por regex, nunca queda "abortado") que NUNCA habría detectado ese bug -- ver el
// historial de este archivo. Ahora usa `AbortAwareFakeSession`
// (`./support/aborting-fake-session.ts`), que sí reproduce 25P02/estado abortado,
// y agrega una prueba de control explícita (“prueba de que el bug era real”) que
// reproduce el fallo con la MISMA secuencia de consultas pero sin SAVEPOINT.
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
import { PostgresCoreRepository } from "../src/postgres-core-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

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

const ORG_ID = "00000000-0000-0000-0000-0000000000aa";
const EMAIL = "candidato@example.com";
const TARGET_ID = "00000000-0000-0000-0000-0000000000bb";

describe("PostgresCoreRepository.findStaffForOrgAdmin -- fallback SQLSTATE 42883", () => {
  it("función existente -> camino NUEVO: llama core.find_staff_for_org_admin directo, sin fallback", async () => {
    const session = new AbortAwareFakeSession([
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

  it("función inexistente (42883) + caller owner/admin -> camino VIEJO: SAVEPOINT recupera la sesión y degrada a core.find_staff_by_email, misma restricción aplicada en TS", async () => {
    const session = new AbortAwareFakeSession([
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
    // El SAVEPOINT sí corrió -- sin esto, `from core.membership`/`core.find_staff_
    // by_email` de arriba habrían fallado con 25P02 (ver la prueba de control más
    // abajo).
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
  });

  it("función inexistente (42883) + caller SIN rango de admin -> el fallback rechaza (42501), nunca expone el correo", async () => {
    const session = new AbortAwareFakeSession([
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
    const session = new AbortAwareFakeSession([{ match: /core\.find_staff_for_org_admin/, respond: () => otherPgError() }]);
    const repo = new PostgresCoreRepository(session);

    await expect(repo.findStaffForOrgAdmin(ORG_ID, EMAIL)).rejects.toMatchObject({ code: "57P01" });
  });

  it("prueba de que el bug era real: la MISMA secuencia SIN SAVEPOINT (catch simple) deriva en 25P02 en vez de degradar", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.find_staff_for_org_admin/, respond: () => undefinedFunctionError() }]);

    await expect(
      (async () => {
        try {
          await session.query(`select id, email, full_name from core.find_staff_for_org_admin($1, $2);`, [ORG_ID, EMAIL]);
        } catch {
          // catch simple -- exactamente el patrón roto que auditó el hallazgo ALTO
          // (el `catch` original SÍ existía, pero sin SAVEPOINT).
        }
        // La primera consulta del propio fallback -- fallaba con 25P02, nunca con
        // la lista vacía/404 honesta que el diseño del fallback promete.
        return session.query(`select platform_role from core.membership where organization_id = $1 and user_id = auth.uid();`, [ORG_ID]);
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});

describe("PostgresCoreRepository.isStaffOrgMember -- fallback SQLSTATE 42883", () => {
  it("función existente -> camino NUEVO: llama core.is_staff_org_member_for_org_admin directo", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.is_staff_org_member_for_org_admin/, respond: () => [{ is_staff_org_member_for_org_admin: true }] }]);
    const repo = new PostgresCoreRepository(session);

    expect(await repo.isStaffOrgMember(ORG_ID, TARGET_ID)).toBe(true);
  });

  it("función inexistente (42883) + caller owner/admin -> camino VIEJO: degrada a core.find_memberships_by_user_id filtrado por organización", async () => {
    const session = new AbortAwareFakeSession([
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
    const session = new AbortAwareFakeSession([
      { match: /core\.is_staff_org_member_for_org_admin/, respond: () => undefinedFunctionError() },
      { match: /from core\.membership/, respond: () => [{ platform_role: "owner" }] },
      { match: /core\.find_memberships_by_user_id/, respond: () => [{ organization_id: "00000000-0000-0000-0000-0000000000zz" }] },
    ]);
    const repo = new PostgresCoreRepository(session);

    expect(await repo.isStaffOrgMember(ORG_ID, TARGET_ID)).toBe(false);
  });

  it("función inexistente (42883) + caller SIN rango de admin -> el fallback rechaza (42501)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /core\.is_staff_org_member_for_org_admin/, respond: () => undefinedFunctionError() },
      { match: /from core\.membership/, respond: () => [] },
    ]);
    const repo = new PostgresCoreRepository(session);

    await expect(repo.isStaffOrgMember(ORG_ID, TARGET_ID)).rejects.toMatchObject({ code: "42501" });
  });

  it("cualquier OTRO código de error (no 42883) se repropaga tal cual", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.is_staff_org_member_for_org_admin/, respond: () => otherPgError() }]);
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

    const session = new AbortAwareFakeSession([
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
