// f2-citas-lista-de-espera, regla dura de compatibilidad #5 — "toda lista
// paginada con orden TOTAL: now() es constante dentro de una transacción,
// desempata por id". `runOptimizadorCore` (reminders.ts) decide "quién gana
// el hueco liberado" ordenando los candidatos por `createdAt` y tomando el
// primero -- pero SQL nunca garantiza el orden de filas empatadas sin un
// `ORDER BY` explícito, y `Array.prototype.sort` sobre un empate depende de lo
// que el driver haya devuelto. El `.sort` ad-hoc de `runOptimizadorCore` (ANTES
// de este fix) no desempataba por `id` -- a diferencia de `sortWaitlistByPosition`
// (ya usado por `runListaEsperaCore`, el broadcast manual), que sí lo hacía.
// Esta prueba fija dos candidatos con el MISMO `createdAt` (mismo milisegundo,
// plausible bajo carga real) y confirma que el ganador es SIEMPRE el de `id`
// menor, sin importar en qué orden el repositorio los devuelva.
import { describe, expect, it } from "vitest";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";
import { runOptimizadorCore } from "../src/reminders.ts";

const ORG_ID = "00000000-0000-0000-0000-0000000000d1";
const PROVIDER_ID = "00000000-0000-0000-0000-0000000000d2";
const SAME_CREATED_AT = "2026-01-01T10:00:00.000Z";

function seedTiedCandidates(repo: InMemoryCitasRepository, idLower: string, idHigher: string) {
  repo.seedOrganization({ id: ORG_ID, slug: "org-orden-total", name: "Org orden total", defaultTimezone: "America/Mexico_City" });
  repo.seedWhatsAppConfig(ORG_ID, "1234567890");
  // Se insertan en orden "alto primero" a propósito -- si el desempate
  // dependiera del orden de inserción/almacenamiento en vez de `id`, este
  // arreglo lo revelaría.
  repo.seedWaitlistEntry({ id: idHigher, organizationId: ORG_ID, customerPhone: "5215500000002", customerName: "Segundo por id", providerId: PROVIDER_ID, serviceId: null, preferredDateFrom: null, preferredDateTo: null, preferredTimeWindow: "any", createdAt: SAME_CREATED_AT });
  repo.seedWaitlistEntry({ id: idLower, organizationId: ORG_ID, customerPhone: "5215500000001", customerName: "Primero por id", providerId: PROVIDER_ID, serviceId: null, preferredDateFrom: null, preferredDateTo: null, preferredTimeWindow: "any", createdAt: SAME_CREATED_AT });
}

describe("runOptimizadorCore — orden TOTAL con createdAt empatado (regla dura #5)", () => {
  it("dos candidatos con el MISMO createdAt: gana el de id menor, sin importar el orden de almacenamiento", async () => {
    const idLower = "00000000-0000-0000-0000-0000000000a1";
    const idHigher = "00000000-0000-0000-0000-0000000000a2";
    const repo = new InMemoryCitasRepository();
    seedTiedCandidates(repo, idLower, idHigher);

    const result = await runOptimizadorCore(repo, ORG_ID, "America/Mexico_City", { providerId: PROVIDER_ID, startsAt: "2026-01-02T16:00:00.000Z" });

    expect(result.matched).toBe(true);
    expect(result.waitlistId).toBe(idLower);
  });
});
