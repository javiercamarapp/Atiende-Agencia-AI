// Rn-18 -- que pasa cuando una reserva no tiene regla de comision de canal: default seguro solo
// para reservas sin canal externo; error de negocio tipado para un canal externo.
import { randomUUID } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { describe, expect, it } from "vitest";
import { ReglaComisionCanalNoConfiguradaError, RentasDomainError } from "../src/errors.ts";
import { CODIGO_CANAL_DIRECTO, reglaComisionPorDefecto } from "../src/finanzas/regla-comision-por-defecto.ts";
import { InMemoryRentasRepository } from "../src/in-memory-repository.ts";
import { PostgresRentasRepository } from "../src/postgres-repository.ts";

describe("reglaComisionPorDefecto", () => {
  it("una reserva sin canal o de canal manual usa 0 pb sin comision de canal", () => {
    for (const codigo of [null, CODIGO_CANAL_DIRECTO]) {
      const regla = reglaComisionPorDefecto(codigo);
      expect(regla).toMatchObject({ yaNetoDeComision: false, comisionBasisPoints: 0 });
      expect(regla?.fuente).toMatch(/^default:/);
    }
  });

  it("un canal externo NO tiene default: nunca se asume una comision", () => {
    for (const codigo of ["airbnb", "booking", "vrbo", "desconocido"]) expect(reglaComisionPorDefecto(codigo)).toBeNull();
  });
});

describe("InMemoryRentasRepository.findReglaComisionCanal sin regla", () => {
  it("un canal externo lanza ReglaComisionCanalNoConfiguradaError con el codigo del canal y la accion a seguir", async () => {
    const repo = new InMemoryRentasRepository();
    const airbnb = (await repo.findCanalPorCodigo("airbnb"))!;
    const err = await repo.findReglaComisionCanal(randomUUID(), airbnb.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReglaComisionCanalNoConfiguradaError);
    expect(err).toBeInstanceOf(RentasDomainError);
    expect((err as ReglaComisionCanalNoConfiguradaError).code).toBe("regla_comision_no_configurada");
    expect((err as ReglaComisionCanalNoConfiguradaError).canalCodigo).toBe("airbnb");
    expect((err as Error).message).toMatch(/Finanzas/);
  });

  it("una reserva de canal manual cae al default de 0 pb en lugar de lanzar", async () => {
    const repo = new InMemoryRentasRepository();
    const manual = (await repo.findCanalPorCodigo("manual"))!;
    expect(await repo.findReglaComisionCanal(randomUUID(), manual.id)).toMatchObject({ yaNetoDeComision: false, comisionBasisPoints: 0 });
  });

  it("una regla configurada siempre gana al default", async () => {
    const repo = new InMemoryRentasRepository();
    const manual = (await repo.findCanalPorCodigo("manual"))!;
    repo.seedReglaComisionCanal({ propertyId: null, canalId: manual.id, config: { yaNetoDeComision: false, comisionBasisPoints: 300, fuente: "configurada" } });
    expect((await repo.findReglaComisionCanal(randomUUID(), manual.id)).fuente).toBe("configurada");
  });
});

// Sesion minima: las 2 lecturas nuevas son consultas planas (ningun error de Postgres), asi que la
// transaccion del request nunca queda abortada y no hace falta SAVEPOINT en este camino.
function sesion(canalCodigo: string | null): TenantDbSession & { readonly consultas: string[] } {
  const consultas: string[] = [];
  return {
    consultas,
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      consultas.push(sql);
      if (/from rentas\.regla_comision_canal/.test(sql)) return { rows: [] };
      if (/from rentas\.canal where id/.test(sql)) return { rows: (canalCodigo === null ? [] : [{ codigo: canalCodigo }]) as T[] };
      throw new Error(`consulta inesperada: ${sql}`);
    },
    async exec(): Promise<void> {},
  } as TenantDbSession & { readonly consultas: string[] };
}

describe("PostgresRentasRepository.findReglaComisionCanal sin regla", () => {
  it("canal externo sin regla -> ReglaComisionCanalNoConfiguradaError con el codigo del canal", async () => {
    const repo = new PostgresRentasRepository(sesion("booking"));
    await expect(repo.findReglaComisionCanal(randomUUID(), randomUUID())).rejects.toMatchObject({ code: "regla_comision_no_configurada", canalCodigo: "booking" });
  });

  it("canal manual sin regla -> default de 0 pb", async () => {
    const repo = new PostgresRentasRepository(sesion("manual"));
    expect(await repo.findReglaComisionCanal(randomUUID(), randomUUID())).toMatchObject({ yaNetoDeComision: false, comisionBasisPoints: 0 });
  });

  it("canal desconocido (id que ya no existe) no se trata como directo: error de negocio", async () => {
    const repo = new PostgresRentasRepository(sesion(null));
    await expect(repo.findReglaComisionCanal(randomUUID(), randomUUID())).rejects.toBeInstanceOf(ReglaComisionCanalNoConfiguradaError);
  });

  it("sin canal (null) -> default de 0 pb sin consultar el catalogo de canales", async () => {
    const s = sesion("airbnb");
    const repo = new PostgresRentasRepository(s);
    expect(await repo.findReglaComisionCanal(randomUUID(), null)).toMatchObject({ comisionBasisPoints: 0 });
    expect(s.consultas.some((q) => /from rentas\.canal/.test(q))).toBe(false);
  });
});
