// Onboarding P0: el pago activa la prueba (`CoreRepository.activateOrganizationOnPayment`, migracion 0072). La regla SQL (solo
// trial -> active, suspendida nunca, solo sesion de sistema) se prueba contra Postgres real en scripts/verify-prueba-fecha-fin; aqui:
// el cableado del repositorio Postgres (llamada, mapeo y fallback 42883 con SAVEPOINT) y el doble en memoria con la misma regla.
import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository } from "../src/in-memory-core-repository.ts";
import { PostgresCoreRepository } from "../src/postgres-core-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000f7a01";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("PostgresCoreRepository.activateOrganizationOnPayment", () => {
  it("llama core.organization_activate_on_payment con el id y devuelve su resultado", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.organization_activate_on_payment/, respond: () => [{ resultado: "activada" }] }]);
    await expect(new PostgresCoreRepository(session).activateOrganizationOnPayment(ORG)).resolves.toBe("activada");
    expect(session.calls.some((c) => c.includes("core.organization_activate_on_payment($1)"))).toBe(true);
  });

  it.each(["ya_activa", "suspendida", "no_existe"] as const)("propaga '%s' tal cual", async (r) => {
    const session = new AbortAwareFakeSession([{ match: /core\.organization_activate_on_payment/, respond: () => [{ resultado: r }] }]);
    await expect(new PostgresCoreRepository(session).activateOrganizationOnPayment(ORG)).resolves.toBe(r);
  });

  it("base sin la 0072 (42883): 'no_disponible' y la sesion sigue utilizable (SAVEPOINT)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /core\.organization_activate_on_payment/, respond: () => pgError("42883", "function core.organization_activate_on_payment(unknown) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(new PostgresCoreRepository(session).activateOrganizationOnPayment(ORG)).resolves.toBe("no_disponible");
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("otro error de Postgres NO se disfraza de 'no disponible': se propaga", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.organization_activate_on_payment/, respond: () => pgError("57P01", "terminating connection") }]);
    await expect(new PostgresCoreRepository(session).activateOrganizationOnPayment(ORG)).rejects.toMatchObject({ code: "57P01" });
  });
});

describe("InMemoryCoreRepository.activateOrganizationOnPayment (misma regla que la 0072)", () => {
  function repoCon(status: "trial" | "active" | "suspended") {
    const repo = new InMemoryCoreRepository();
    repo.addOrganization({ id: ORG, slug: "org-pago", name: "Org", vertical: "citas", status });
    repo.addStaff({ id: "00000000-0000-0000-0000-0000000f7a99", email: "super@example.com", fullName: "Super", passwordHash: null, createdVia: "seed", emailVerifiedAt: null });
    repo.addPlatformSuperadmin("00000000-0000-0000-0000-0000000f7a99");
    return repo;
  }
  const statusDe = async (repo: InMemoryCoreRepository) => (await repo.listAllOrganizationsForSuperadmin("00000000-0000-0000-0000-0000000f7a99")).find((o) => o.id === ORG)?.status;

  it("trial -> active", async () => {
    const repo = repoCon("trial");
    await expect(repo.activateOrganizationOnPayment(ORG)).resolves.toBe("activada");
    expect(await statusDe(repo)).toBe("active");
  });

  it("suspendida no se reactiva; activa no cambia; id desconocido -> no_existe", async () => {
    const suspendida = repoCon("suspended");
    await expect(suspendida.activateOrganizationOnPayment(ORG)).resolves.toBe("suspendida");
    expect(await statusDe(suspendida)).toBe("suspended");
    await expect(repoCon("active").activateOrganizationOnPayment(ORG)).resolves.toBe("ya_activa");
    await expect(repoCon("trial").activateOrganizationOnPayment("00000000-0000-0000-0000-0000000f7aff")).resolves.toBe("no_existe");
  });
});
