// Ruteo de voz y sucursal "solo venta local" (migracion 105; Galerias de PM): una llamada nunca se enruta a ella, ni pidiendola por slug con el secreto
// legado ni con un secreto de esa sucursal. CONTROL: la misma sucursal activa sin la bandera si emite token.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { hashVoiceSecret } from "../src/routes/verticals/restaurantes/voice-auth.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const ORG = "los-taquitos-de-pm";
const LEGACY = { "x-atiende-tool-secret": "test-voice-tool-secret" };

async function setup(soloVentaLocal: boolean) {
  const ctx = await buildTestDeps();
  const galerias = randomUUID();
  ctx.restaurantesRepo.seedBranch({ propertyId: galerias, organizationId: ctx.organizationId, name: "Galerías", slug: "galerias", status: "active", phone: null, address: null, lat: null, lng: null });
  ctx.restaurantesRepo.seedBranchPolicy(galerias, { aceptaDomicilio: false, soloVentaLocal });
  const app = buildApp(ctx.deps);
  const mint = (headers: Record<string, string>, extra: Record<string, unknown>) =>
    app.request(`/v1/restaurantes/${ORG}/voice/call-token`, jsonRequestInit({ call_id: `c-${randomUUID()}`, caller_phone: "9991111111", ...extra }, headers));
  return { ...ctx, galerias, mint };
}

describe("voz: una sucursal solo venta local no recibe llamadas del agente", () => {
  it("por slug con el secreto legado: 400 como una sucursal inactiva; CONTROL sin la bandera: 200", async () => {
    const s = await setup(true);
    expect((await s.mint(LEGACY, { branch_slug: "galerias" })).status).toBe(400);
    expect((await s.mint(LEGACY, { branch_slug: "fco-montejo" })).status).toBe(200);
    const control = await setup(false);
    expect((await control.mint(LEGACY, { branch_slug: "galerias" })).status).toBe(200);
  });

  it("con un secreto propio de esa sucursal tampoco emite token", async () => {
    const s = await setup(true);
    await s.restaurantesRepo.rotateVoiceBranchSecret(s.organizationId, s.galerias, hashVoiceSecret("vbs_galerias"), "_g", 0);
    expect((await s.mint({ "x-atiende-tool-secret": "vbs_galerias" }, {})).status).toBe(400);
  });
});
