// Rn-26 -- el Resumen operativo contra una base SIN migrar: cada bloque corre bajo SAVEPOINT. Con AbortAwareFakeSession (que
// reproduce el estado abortado 25P02 de una transacción de Postgres) un 42P01 en un bloque NO debe tumbar los demás.
import { describe, expect, it } from "vitest";
import { PostgresRentasResumenRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const PROP = "11111111-1111-4111-8111-111111111111";
const falta = (code: string) => Object.assign(new Error(`relation does not exist (${code})`), { code });

describe("PostgresRentasResumenRepository", () => {
  it("una tabla inexistente (42P01) deja ese bloque en null y los siguientes siguen funcionando (SAVEPOINT)", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: /from rentas\.borrador_mensaje/, respond: () => falta("42P01") },
      { match: /from rentas\.tarea_operativa/, respond: () => [{ pendientes: "3", vencidas: "1", ultima_checkout: "2026-10-01T10:00:00Z" }] },
    ]);
    const repo = new PostgresRentasResumenRepository(sesion);
    expect(await repo.borradores(PROP)).toBeNull();
    // Sin SAVEPOINT esta segunda consulta fallaría con 25P02 (transacción abortada).
    expect(await repo.tareas(PROP, "2026-10-02T00:00:00Z")).toEqual({ pendientes: 3, vencidas: 1, ultimaTareaPorCheckoutEn: "2026-10-01T10:00:00.000Z" });
    expect(sesion.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("una columna inexistente (42703) y un permiso negado (42501) degradan a null; cualquier otro error se repropaga", async () => {
    const col = new PostgresRentasResumenRepository(new AbortAwareFakeSession([{ match: /from rentas\.ocupacion/, respond: () => falta("42703") }]));
    expect(await col.llegadasSalidas(PROP, "2026-10-02")).toBeNull();
    const perm = new PostgresRentasResumenRepository(new AbortAwareFakeSession([{ match: /acceso_politica/, respond: () => falta("42501") }]));
    expect(await perm.acceso(PROP)).toBeNull();
    const otro = new PostgresRentasResumenRepository(new AbortAwareFakeSession([{ match: /from rentas\.ocupacion/, respond: () => falta("57014") }]));
    await expect(otro.llegadasSalidas(PROP, "2026-10-02")).rejects.toMatchObject({ code: "57014" });
  });

  it("mapea los agregados y devuelve ceros/null honestos cuando no hay filas", async () => {
    const repo = new PostgresRentasResumenRepository(
      new AbortAwareFakeSession([
        { match: /from rentas\.ocupacion/, respond: () => [{ llegadas: "2", salidas: "1" }] },
        { match: /from rentas\.borrador_mensaje/, respond: () => [{ pendientes: "0", ultimo_ia: null }] },
        { match: /from rentas\.acceso_politica/, respond: () => [] },
        { match: /from rentas\.acceso_reserva/, respond: () => [{ ultima: null }] },
      ]),
    );
    expect(await repo.llegadasSalidas(PROP, "2026-10-02")).toEqual({ llegadas: 2, salidas: 1 });
    expect(await repo.borradores(PROP)).toEqual({ pendientes: 0, ultimoBorradorIaEn: null });
    expect(await repo.acceso(PROP)).toEqual({ politicaActiva: false, ultimaLiberacionEn: null });
  });
});
