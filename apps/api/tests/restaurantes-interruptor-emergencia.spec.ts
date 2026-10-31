// Interruptor de emergencia unificado (migracion 103), lado VOZ: el contexto de llamada devuelve habilitado=false aunque la voz este habilitada en el panel
// (el worker no abre sesion y dice el saludo pregrabado + deja callback). El lado WhatsApp esta en packages/domain-restaurantes/tests/interruptor-emergencia.spec.ts.
import { describe, expect, it } from "vitest";
import { InMemoryInterruptorEmergencia, InMemoryVozKpiRepository, InMemoryVozLlamadaRepository, InMemoryVozRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const SECRETO = "test-internal-secret";
const RUTA = "/internal/restaurantes/voz/llamada/contexto";
const ACTOR = "00000000-0000-4000-8000-0000000000f1";

async function construir() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const voz = new InMemoryVozRepository();
  voz.seedProperty(ctx.propertyIdA, ctx.organizationId);
  voz.seedProperty(ctx.propertyIdB, ctx.organizationId);
  const interruptor = new InMemoryInterruptorEmergencia();
  const deps: AppDeps = { ...ctx.deps, vozRepo: () => voz, vozLlamadaRepo: () => new InMemoryVozLlamadaRepository(), vozKpiRepo: () => new InMemoryVozKpiRepository(), interruptorEmergencia: () => interruptor };
  const app = buildApp(deps);
  for (const p of [ctx.propertyIdA, ctx.propertyIdB]) await voz.upsertConfig(ctx.organizationId, p, { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "" });
  const contexto = async (propertyId: string) => {
    const raw = JSON.stringify({ organizationId: ctx.organizationId, propertyId });
    const res = await app.request(RUTA, { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength), "x-atiende-internal-secret": SECRETO } });
    expect(res.status).toBe(200);
    return (await res.json()) as { habilitado: boolean };
  };
  return { ctx, interruptor, contexto };
}

describe("interruptor de emergencia: voz", () => {
  it("encendido por omision: la voz habilitada atiende", async () => {
    const t = await construir();
    expect((await t.contexto(t.ctx.propertyIdA)).habilitado).toBe(true);
  });
  it("apagado por sucursal: habilitado=false solo en esa sucursal", async () => {
    const t = await construir();
    t.interruptor.fijar(t.ctx.organizationId, t.ctx.propertyIdA, true, ACTOR);
    expect((await t.contexto(t.ctx.propertyIdA)).habilitado).toBe(false);
    expect((await t.contexto(t.ctx.propertyIdB)).habilitado).toBe(true);
  });
  it("apagado de la organizacion: ninguna sucursal atiende; encenderlo las devuelve", async () => {
    const t = await construir();
    t.interruptor.fijar(t.ctx.organizationId, null, true, ACTOR);
    expect((await t.contexto(t.ctx.propertyIdA)).habilitado).toBe(false);
    expect((await t.contexto(t.ctx.propertyIdB)).habilitado).toBe(false);
    t.interruptor.fijar(t.ctx.organizationId, null, false, ACTOR);
    expect((await t.contexto(t.ctx.propertyIdA)).habilitado).toBe(true);
  });
  it("si la lectura del interruptor falla, la voz habilitada sigue atendiendo (falla abierto)", async () => {
    const t = await construir();
    t.interruptor.fijar(t.ctx.organizationId, t.ctx.propertyIdA, true, ACTOR);
    t.interruptor.fallaLectura = true;
    expect((await t.contexto(t.ctx.propertyIdA)).habilitado).toBe(true);
  });
});
