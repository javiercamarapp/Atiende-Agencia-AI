// Clase de defecto «funcion de SOLO sistema llamada con la sesion del staff» (8-oct: «Probar agente» respondia «Error interno» al primer mensaje).
// `restaurantes.consume_api_rate_limit` lanza 42501 si `auth.uid()` no es nulo; el repositorio en memoria no lo aplica, asi que aqui el repo SI
// lo imita (`conGuardaDeSistema`): si una ruta de panel consume el limitador con la sesion del usuario, la ruta cae (500) y el test falla.
// Se afirma el EFECTO: la ruta responde bien, el tope se consumio en la sesion de SISTEMA y sigue siendo por staff autenticado / organizacion.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LlmGateway } from "@atiende/agent-core";
import { InMemoryCfoRepository } from "@atiende/domain-restaurantes/cfo";
import { DAY_SECONDS, FakeVoiceProvider, InMemoryVozRepository, actorHash } from "@atiende/domain-restaurantes";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { AGENTE_PREVIEW_LIMITES } from "../src/routes/verticals/restaurantes/agente-preview.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import { conGuardaDeSistema } from "./restaurantes-guarda-sistema.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const SECRETO = "test-voice-preview-token-secret";

async function construir() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const voz = new InMemoryVozRepository();
  voz.seedProperty(ctx.propertyIdA, ctx.organizationId);
  const turnos: string[] = [];
  const turnHandler: WhatsAppTurnHandler = {
    async handleInboundMessage(entrada) {
      turnos.push(entrada.messages.at(-1)!.content);
      return { reply: "Hola, soy el asistente (prueba).", orderId: null, propertyId: entrada.propertyId ?? null };
    },
  };
  const base: AppDeps = {
    ...ctx.deps,
    llmGateway: {} as LlmGateway,
    turnHandler,
    vozRepo: () => voz,
    voiceProvider: new FakeVoiceProvider(),
    env: { ...ctx.deps.env, voicePreviewTokenSecret: SECRETO },
    cfoRestaurantesRepo: () => new InMemoryCfoRepository({ sucursales: [ctx.propertyIdA, ctx.propertyIdB] }),
  };
  const guardado = conGuardaDeSistema(base, ctx.restaurantesRepo);
  const app = buildApp(guardado.deps);
  const A = ctx.propertyIdA;
  const mensaje = (token: string, sesionId = randomUUID()) => app.request(`/v1/restaurantes/${A}/admin/agente-whatsapp/preview/mensaje`, authedJson(token, { sesionId, mensajes: [{ rol: "usuario", texto: "Hola" }] }));
  return { ctx, app, A, mensaje, turnos, llamadas: guardado.llamadas, voz };
}

describe("«Probar agente» (POST .../admin/agente-whatsapp/preview/mensaje) con la restriccion de sistema del limitador", () => {
  it("el PRIMER mensaje responde 200 y los dos topes (staff y organizacion) se consumieron en la sesion de SISTEMA", async () => {
    const t = await construir();
    const res = await t.mensaje(t.ctx.staff.owner.token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).respuesta).toContain("asistente");
    expect(t.turnos).toEqual(["Hola"]);
    expect(t.llamadas).toEqual([
      { scope: "agente-preview-staff", usuario: null },
      { scope: "agente-preview-org", usuario: null },
    ]);
  });

  it("control negativo: la guarda SI tiene dientes (consumir el limitador con la sesion de un usuario lanza 42501 como Postgres)", async () => {
    const t = await construir();
    const guardado = conGuardaDeSistema(t.ctx.deps, t.ctx.restaurantesRepo);
    await expect(
      guardado.deps.engine.withAppSession({ userId: t.ctx.staff.owner.id }, async (db) => guardado.deps.restaurantesRepo(db).consumeRateLimit("x", actorHash("y"), 5, 60)),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(guardado.deps.engine.withAppSession({ userId: null }, async (db) => guardado.deps.restaurantesRepo(db).consumeRateLimit("x", actorHash("y"), 5, 60))).resolves.toBe(true);
  });

  it("tope por staff: el mensaje 41 en la ventana responde 429 sin invocar al agente; otro staff de la misma organizacion no se ve afectado", async () => {
    const t = await construir();
    const sesionId = randomUUID();
    for (let i = 0; i < AGENTE_PREVIEW_LIMITES.porStaffPor10Min; i++) expect((await t.mensaje(t.ctx.staff.owner.token, sesionId)).status).toBe(200);
    const exceso = await t.mensaje(t.ctx.staff.owner.token, sesionId);
    expect(exceso.status).toBe(429);
    expect(((await exceso.json()) as Json).code).toBe("too_many_requests");
    expect(t.turnos).toHaveLength(AGENTE_PREVIEW_LIMITES.porStaffPor10Min);
    expect((await t.mensaje(t.ctx.staff.admin.token, sesionId)).status).toBe(200);
  });

  it("tope por organizacion/dia: el 400 pasa y el 401 responde 429 agente_preview_tope (aunque sea otro staff)", async () => {
    const t = await construir();
    for (let i = 0; i < AGENTE_PREVIEW_LIMITES.porOrganizacionPorDia - 1; i++) await t.ctx.restaurantesRepo.consumeRateLimit("agente-preview-org", actorHash(t.ctx.organizationId), AGENTE_PREVIEW_LIMITES.porOrganizacionPorDia, DAY_SECONDS);
    expect((await t.mensaje(t.ctx.staff.owner.token)).status).toBe(200);
    const tope = await t.mensaje(t.ctx.staff.admin.token);
    expect(tope.status).toBe(429);
    expect(((await tope.json()) as Json).code).toBe("agente_preview_tope");
    expect(t.turnos).toHaveLength(1);
  });

  it("el tope por organizacion NO se consume cuando ya se agoto el del staff (orden de los topes)", async () => {
    const t = await construir();
    for (let i = 0; i < AGENTE_PREVIEW_LIMITES.porStaffPor10Min; i++) await t.mensaje(t.ctx.staff.owner.token);
    t.llamadas.length = 0;
    expect((await t.mensaje(t.ctx.staff.owner.token)).status).toBe(429);
    expect(t.llamadas).toEqual([{ scope: "agente-preview-staff", usuario: null }]);
  });

  it("sin sesion 401 y rol sin permiso 403: el limitador ni se toca", async () => {
    const t = await construir();
    expect((await t.app.request(`/v1/restaurantes/${t.A}/admin/agente-whatsapp/preview/mensaje`, { method: "POST" })).status).toBe(401);
    expect((await t.mensaje(t.ctx.staff.repartidor.token)).status).toBe(403);
    expect(t.llamadas).toEqual([]);
  });
});

describe("preview de VOZ (admin/voz/preview/*) con la restriccion de sistema del limitador", () => {
  it("POST .../preview/sesion: 201 y el tope se consume en sesion de sistema; la sesion 21 responde 429", async () => {
    const t = await construir();
    const url = `/v1/restaurantes/${t.A}/admin/voz/preview/sesion`;
    const primera = await t.app.request(url, authedJson(t.ctx.staff.owner.token, {}));
    expect(primera.status).toBe(201);
    expect(t.llamadas).toEqual([{ scope: "voz-preview-sesion", usuario: null }]);
    for (let i = 1; i < 20; i++) expect((await t.app.request(url, authedJson(t.ctx.staff.owner.token, {}))).status).toBe(201);
    expect((await t.app.request(url, authedJson(t.ctx.staff.owner.token, {}))).status).toBe(429);
  });

  it("POST .../preview/:sesionId/herramienta: 200 y el tope por staff+sesion se consume en sesion de sistema", async () => {
    const t = await construir();
    const sesion = (await (await t.app.request(`/v1/restaurantes/${t.A}/admin/voz/preview/sesion`, authedJson(t.ctx.staff.owner.token, {}))).json()) as Json;
    t.llamadas.length = 0;
    const res = await t.app.request(`/v1/restaurantes/${t.A}/admin/voz/preview/${sesion.sesionId}/herramienta`, authedJson(t.ctx.staff.owner.token, { tokenPreview: sesion.tokenPreview, nombre: "consultar_sucursal", argumentos: {} }));
    expect(res.status).toBe(200);
    expect(t.llamadas).toEqual([{ scope: "voz-preview-herramienta", usuario: null }]);
  });
});

describe("CFO (admin/cfo/*) con la restriccion de sistema del limitador", () => {
  it("una lectura responde 200 y el tope `cfo-lectura` se consume en sesion de sistema", async () => {
    const t = await construir();
    const res = await t.app.request(`/v1/restaurantes/${t.A}/admin/cfo/resumen?desde=2026-08-31&hasta=2026-09-27`, authedGet(t.ctx.staff.owner.token));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(t.llamadas.length).toBeGreaterThan(0);
    expect(t.llamadas.every((l) => l.usuario === null && l.scope.startsWith("cfo-"))).toBe(true);
  });
});
