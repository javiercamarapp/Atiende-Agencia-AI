// Misma clase de defecto que «Probar agente» de restaurantes (funcion de SOLO sistema llamada con la sesion del staff), en «Probar conexion» de Cal.com /
// CalDAV: `citas.consume_api_rate_limit` y `citas.get_provider_calendar_refresh_token` (secreto del Vault) lanzan 42501 si `auth.uid()` no es nulo.
// El repositorio en memoria no lo aplica; aqui SI se imita (como citas-voz-estado-preview.spec.ts): con la sesion de un usuario esas dos llamadas fallan.
import { describe, expect, it } from "vitest";
import { FakeCalendarSyncPort } from "@atiende/domain-citas";
import type { CitasRepository } from "@atiende/domain-citas";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";
import { claveFicticia, llaveFicticia } from "./support/credenciales-ficticias.ts";

const SOLO_SISTEMA = new Set(["consumeRateLimit", "resolveProviderCalComApiKey", "resolveProviderCalDavPassword"]);

function conGuardaDeSistema(base: AppDeps, repo: CitasRepository): { deps: AppDeps; llamadas: { metodo: string; usuario: string | null }[] } {
  const usuarioDe = new WeakMap<TenantDbSession, string | null>();
  const llamadas: { metodo: string; usuario: string | null }[] = [];
  const engine = {
    withAppSession: <T,>(claims: { userId: string | null }, fn: (s: TenantDbSession) => Promise<T>) =>
      base.engine.withAppSession(claims, (session) => {
        usuarioDe.set(session, claims.userId);
        return fn(session);
      }),
  };
  const citasRepo = (db: TenantDbSession): CitasRepository =>
    new Proxy(repo, {
      get(target, prop, receiver) {
        const valor = Reflect.get(target, prop, receiver);
        if (typeof prop !== "string" || !SOLO_SISTEMA.has(prop)) return typeof valor === "function" ? valor.bind(target) : valor;
        return (...args: unknown[]) => {
          const usuario = usuarioDe.get(db) ?? null;
          llamadas.push({ metodo: prop, usuario });
          if (usuario !== null) throw Object.assign(new Error(`${prop}: solo de sistema (auth.uid() debe ser nulo)`), { code: "42501" });
          return (valor as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  return { deps: { ...base, engine: engine as unknown as AppDeps["engine"], citasRepo }, llamadas };
}

describe("«Probar conexion» de calendarios con la restriccion de sistema", () => {
  it("Cal.com: 200 ok, y el tope y la lectura del secreto corrieron en sesion de SISTEMA", async () => {
    const calcomPort = new FakeCalendarSyncPort("calcom");
    const ctx = await buildCitasTestContext(buildApp, { calcomPort });
    await ctx.citasRepo.connectProviderCalComAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calcomEventTypeId: "555", apiKey: llaveFicticia() });
    const g = conGuardaDeSistema(ctx.deps, ctx.citasRepo);
    const res = await buildApp(g.deps).request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/test-connection`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(g.llamadas).toEqual([
      { metodo: "consumeRateLimit", usuario: null },
      { metodo: "resolveProviderCalComApiKey", usuario: null },
    ]);
  });

  it("CalDAV: 200 ok, y el tope y la lectura del secreto corrieron en sesion de SISTEMA", async () => {
    const caldavPort = new FakeCalendarSyncPort("caldav");
    const ctx = await buildCitasTestContext(buildApp, { caldavPort });
    await ctx.citasRepo.connectProviderCalDavAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calendarCollectionUrl: "https://caldav.example.com/x/", username: "x@y.com", password: claveFicticia() });
    const g = conGuardaDeSistema(ctx.deps, ctx.citasRepo);
    const res = await buildApp(g.deps).request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/caldav/test-connection`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(g.llamadas).toEqual([
      { metodo: "consumeRateLimit", usuario: null },
      { metodo: "resolveProviderCalDavPassword", usuario: null },
    ]);
  });

  it("el tope sigue siendo por proveedor: la 21.a prueba en la ventana responde 429", async () => {
    const calcomPort = new FakeCalendarSyncPort("calcom");
    const ctx = await buildCitasTestContext(buildApp, { calcomPort });
    await ctx.citasRepo.connectProviderCalComAccount({ organizationId: ctx.organizationId, providerId: ctx.providerId, calcomEventTypeId: "555", apiKey: llaveFicticia() });
    const app = buildApp(conGuardaDeSistema(ctx.deps, ctx.citasRepo).deps);
    const url = `/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/calcom/test-connection`;
    for (let i = 0; i < 20; i++) expect((await app.request(url, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } })).status).toBe(200);
    expect((await app.request(url, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.owner.token}` } })).status).toBe(429);
  });
});
