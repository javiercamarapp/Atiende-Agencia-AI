// r6 -- regresión determinista del bug real + test flaky que tumbó el CI de otros
// PRs dos veces el 19-sep-2026 al re-correr (#163, #158, ver PR de esta fase):
// `apps/api/tests/rentas-auditoria.spec.ts`, caso "admin_gestora lee la bitácora
// paginada, más reciente primero", fallaba de forma NO determinista con
// `expected '100000 MXN desde 2026-09-19' to contain '200000'`.
//
// CAUSA (en memoria): `InMemoryRentasRepository.registrarAuditoria` marcaba cada
// fila con `Date.now()` (resolución de milisegundo) SIN desempate -- dos
// escrituras dentro del MISMO milisegundo empataban en `createdAtMs`, y
// `Array.prototype.sort` (estable desde ES2019) conservaba el orden de INSERCIÓN
// para los empatados -- exactamente lo CONTRARIO de "más reciente primero" (la
// fila más antigua de las dos empatadas quedaba primero).
//
// Este spec reproduce el empate de forma DETERMINISTA (reloj falso CONGELADO en
// vez de esperar a que el wall-clock real produzca dos llamadas dentro del mismo
// milisegundo -- lo que hacía flaky al spec original, nunca reproducible a
// voluntad) -- mismo patrón `vi.useFakeTimers()` que
// packages/core-ratelimit/tests/memory-window.spec.ts. SIN sleeps ni reintentos,
// tal como pide la tarea.
import { describe, expect, it, vi } from "vitest";
import { InMemoryRentasRepository } from "../src/in-memory-repository.ts";
import type { RegistrarAuditoriaInput } from "../src/types.ts";

const ORG_ID = "org-1";

function accion(despues: string, overrides: Partial<RegistrarAuditoriaInput> = {}): RegistrarAuditoriaInput {
  return {
    organizationId: ORG_ID,
    actorUserId: "staff-1",
    action: "pricing.tarifa_base.actualizada",
    entityType: "pricing",
    entityId: "unidad-1",
    campo: "precio_noche_centavos",
    antes: null,
    despues,
    ...overrides,
  };
}

describe("InMemoryRentasRepository.listAuditoria — desempate determinista dentro del mismo milisegundo", () => {
  it("N filas escritas en el MISMO instante (reloj congelado) quedan en orden EXACTO de registro inverso, nunca al azar", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
      const repo = new InMemoryRentasRepository();

      // Las 5 llamadas caen en el MISMO Date.now() -- el reloj está congelado, no
      // avanza entre awaits (a diferencia del wall-clock real, donde esto era
      // improbable pero posible, de ahí el flaky).
      await repo.registrarAuditoria(accion("100000 MXN desde 2026-06-01"));
      await repo.registrarAuditoria(accion("200000 MXN desde 2026-07-01"));
      await repo.registrarAuditoria(accion("300000 MXN desde 2026-08-01"));
      await repo.registrarAuditoria(accion("400000 MXN desde 2026-09-01"));
      await repo.registrarAuditoria(accion("500000 MXN desde 2026-10-01"));

      // Confirma la premisa del bug: las 5 filas SÍ comparten `createdAtMs`
      // (si esto dejara de ser cierto -- p.ej. el reloj falso dejó de estar
      // congelado -- el resto de la aserción de abajo dejaría de probar lo que
      // dice probar).
      const timestamps = new Set(repo.auditLog.map((r) => r.createdAtMs));
      expect(timestamps.size).toBe(1);

      const pagina = await repo.listAuditoria(ORG_ID, {}, { limit: 50, offset: 0 });
      expect(pagina.disponible).toBe(true);
      expect(pagina.total).toBe(5);
      // Más reciente primero -- la ÚLTIMA acción registrada (500000) es la más
      // reciente de verdad (mismo instante de reloj, pero registrada DESPUÉS de
      // las otras 4) y debe encabezar la página, en orden EXACTO inverso de
      // registro -- nunca el orden de inserción sin más (el bug real) ni un
      // orden distinto en cada corrida (no determinismo).
      expect(pagina.items.map((i) => i.despues)).toEqual([
        "500000 MXN desde 2026-10-01",
        "400000 MXN desde 2026-09-01",
        "300000 MXN desde 2026-08-01",
        "200000 MXN desde 2026-07-01",
        "100000 MXN desde 2026-06-01",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("paginación estable con offset dentro del mismo instante: ninguna fila se repite ni se pierde entre páginas", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
      const repo = new InMemoryRentasRepository();
      for (let i = 1; i <= 6; i += 1) {
        await repo.registrarAuditoria(accion(`v${i}`));
      }

      const pagina1 = await repo.listAuditoria(ORG_ID, {}, { limit: 3, offset: 0 });
      const pagina2 = await repo.listAuditoria(ORG_ID, {}, { limit: 3, offset: 3 });
      const todas = [...pagina1.items, ...pagina2.items].map((i) => i.despues);
      // Orden total esperado: v6..v1 (más reciente primero). Sin el desempate por
      // `seq`, un orden no total permitiría que, entre dos consultas, un
      // reordenamiento de los empatados repitiera o saltara una fila -- aquí se
      // afirma la secuencia EXACTA, no solo que las 6 aparezcan sin importar el
      // orden.
      expect(todas).toEqual(["v6", "v5", "v4", "v3", "v2", "v1"]);
      expect(new Set(todas).size).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
