// QA R1 automatizacion 07 -- la purga por retencion de datos de salud de citas corre como un paso de
// /internal/plataforma/privacidad-retencion (vercel.json esta en el tope de 40 crons): misma regla de ejecucion, interruptor y latido.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryPlataformaPrivacidadRepository } from "@atiende/db";
import type { InMemorySaludRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { createPlatformSwitchGuard } from "../src/platform-switches.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";

const PATH = "/internal/plataforma/privacidad-retencion";
const lote = (c = 0, e = 0, n = 0, p = 0) => ({ disponible: true, conversacionesVaciadas: c, escalacionesBorradas: e, notasBorradas: n, protegidas: p });

async function construir() {
  const ctx = await buildCitasTestContext(buildApp);
  const deps = { ...ctx.deps, privacidadPlataformaRepo: () => new InMemoryPlataformaPrivacidadRepository({ migrado: true }) };
  const cron = { authorization: `Bearer ${ctx.deps.env.internalSecret}` };
  return { ctx, deps, app: buildApp(deps), cron, interno: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } };
}

describe("retencion de datos de salud de citas dentro de /internal/plataforma/privacidad-retencion", () => {
  it("sin secreto responde 401 y no purga", async () => {
    const { ctx, app } = await construir();
    expect((await app.request(PATH, { method: "GET" })).status).toBe(401);
    expect(ctx.citasRepo.retentionPurgeCalls).toHaveLength(0);
  });

  it("GET con Authorization: Bearer (Vercel Cron) EJECUTA la purga de citas y repite lotes mientras alguno llene su tope", async () => {
    const { ctx, app, cron } = await construir();
    ctx.citasRepo.setRetentionPurgeBatches([lote(500, 0, 0, 1), lote(120, 4, 0, 1)]);
    const body = (await (await app.request(PATH, { method: "GET", headers: cron })).json()) as { citas: Record<string, unknown> };
    expect(body.citas).toMatchObject({ disponible: true, lotes: 2, conversacionesVaciadas: 620, escalacionesBorradas: 4, notasBorradas: 0, protegidas: 1 });
    expect(ctx.citasRepo.retentionPurgeCalls).toEqual([{ limit: 500, dry: false }, { limit: 500, dry: false }]);
  });

  it("POST sin ejecutar=1 y GET con el secreto solo en x-atiende-internal-secret SIMULAN (un lote, dry)", async () => {
    const { ctx, app, interno } = await construir();
    ctx.citasRepo.setRetentionPurgeBatches([lote(2, 1, 1, 3)]);
    await app.request(PATH, { method: "POST", headers: interno });
    await app.request(PATH, { method: "GET", headers: interno });
    expect(ctx.citasRepo.retentionPurgeCalls).toEqual([{ limit: 500, dry: true }, { limit: 500, dry: true }]);
  });

  it("?ejecutar=1 por GET sin Bearer responde 400 y no toca nada; POST ?ejecutar=1 ejecuta; Bearer con ?ejecutar=0 simula", async () => {
    const { ctx, app, cron, interno } = await construir();
    expect((await app.request(`${PATH}?ejecutar=1`, { method: "GET", headers: interno })).status).toBe(400);
    expect(ctx.citasRepo.retentionPurgeCalls).toHaveLength(0);
    await app.request(`${PATH}?ejecutar=1`, { method: "POST", headers: interno });
    await app.request(`${PATH}?ejecutar=0`, { method: "GET", headers: cron });
    expect(ctx.citasRepo.retentionPurgeCalls.map((c) => c.dry)).toEqual([false, true]);
  });

  it("con organizationId (barrido de una sola organizacion) no corre la purga de citas", async () => {
    const { ctx, app, cron } = await construir();
    await app.request(`${PATH}?organizationId=${randomUUID()}`, { method: "GET", headers: cron });
    expect(ctx.citasRepo.retentionPurgeCalls).toHaveLength(0);
  });

  it("base sin la migracion 033: 200, citas.disponible=false, un solo lote y la purga de la plataforma sigue", async () => {
    const { ctx, app, cron } = await construir();
    ctx.citasRepo.setRetentionPurgeBatches(null);
    const res = await app.request(PATH, { method: "GET", headers: cron });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, disponible: true, citas: { disponible: false, lotes: 1 } });
  });

  it("un error real del lote de citas no tumba la purga de la plataforma: el latido queda en error y la respuesta (200) trae citas.error", async () => {
    const { ctx, app, cron, deps } = await construir();
    const saludRepo = deps.saludRepo as InMemorySaludRepository;
    const superadminId = randomUUID();
    saludRepo.addPlatformSuperadmin(superadminId);
    ctx.citasRepo.purgeRetentionBatch = () => Promise.reject(new Error("deadlock detected"));
    const res = await app.request(PATH, { method: "GET", headers: cron });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, disponible: true, errores: 1, citas: { error: "fallo_inesperado" } });
    const latido = (await saludRepo.listCronHeartbeatsForSuperadmin(superadminId)).find((l) => l.cronName === PATH);
    expect(latido?.lastStatus).toBe("error");
  });

  it("pausado por interruptor responde skipped:kill_switch y no purga", async () => {
    const { ctx, deps, cron } = await construir();
    const guard = createPlatformSwitchGuard(async () => [{ scope: "cron", target: PATH }]);
    const res = await buildApp({ ...deps, platformSwitchGuard: guard }).request(PATH, { method: "GET", headers: cron });
    expect(await res.json()).toMatchObject({ skipped: "kill_switch" });
    expect(ctx.citasRepo.retentionPurgeCalls).toHaveLength(0);
  });
});
