// Interruptores de plataforma: rutas (catalogo, validacion, motivo, gateo,
// base sin migrar) y su EFECTO real a traves del guard que consultan el gateway
// LLM y los crons.
import { describe, expect, it } from "vitest";
import type { PlatformSwitchRepository } from "@atiende/db";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

const MOTIVO = "Corte preventivo del agente por incidente verificado en produccion.";
const put = (app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> }, body: unknown, headers: Record<string, string>) =>
  app.request("/superadmin/interruptores", { ...jsonRequestInit(body, headers), method: "PUT" });

describe("GET /superadmin/interruptores", () => {
  it("devuelve el catalogo completo (globales, agentes, crons) y la lista de interruptores", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const res = await s.app.request("/superadmin/interruptores", { headers: bearer(sa.token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; catalogo: { globales: string[]; agentes: string[]; crons: string[] }; interruptores: unknown[] };
    expect(body.disponible).toBe(true);
    expect(body.catalogo.globales).toEqual(["llm", "crons"]);
    expect(body.catalogo.agentes).toContain("restaurantes:whatsapp_agent");
    expect(body.catalogo.crons).toContain("/internal/whatsapp/dispatch");
    expect(body.interruptores).toEqual([]);
  });

  it("un staff normal (no superadmin) recibe 403 en GET y PUT", async () => {
    const s = await seguridadSetup();
    const st = await s.staff();
    expect((await s.app.request("/superadmin/interruptores", { headers: bearer(st.token) })).status).toBe(403);
    expect((await put(s.app, { scope: "global", target: "llm", bloqueado: true, motivo: MOTIVO }, bearer(st.token))).status).toBe(403);
  });
});

describe("PUT /superadmin/interruptores", () => {
  it("bloquear un agente: queda registrado y el guard lo ve DE INMEDIATO (cache invalidado); desbloquear lo libera", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    // calienta el cache con "nada bloqueado"
    expect(await s.deps.platformSwitchGuard!.agentBlockedBy("restaurantes:whatsapp_agent")).toBeNull();

    const res = await put(s.app, { scope: "agente", target: "restaurantes:whatsapp_agent", bloqueado: true, motivo: MOTIVO }, bearer(sa.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ interruptor: { scope: "agente", target: "restaurantes:whatsapp_agent", bloqueado: true, actualizadoPor: sa.id } });
    expect(await s.deps.platformSwitchGuard!.agentBlockedBy("restaurantes:whatsapp_agent")).toBe("agente:restaurantes:whatsapp_agent");
    expect(await s.deps.platformSwitchGuard!.agentBlockedBy("restaurantes:whatsapp_agent_escalated")).toBe("agente:restaurantes:whatsapp_agent");
    expect(await s.deps.platformSwitchGuard!.agentBlockedBy("hoteles:whatsapp_agent")).toBeNull();

    const lista = (await (await s.app.request("/superadmin/interruptores", { headers: bearer(sa.token) })).json()) as { interruptores: Array<{ target: string; bloqueado: boolean }> };
    expect(lista.interruptores).toEqual([expect.objectContaining({ target: "restaurantes:whatsapp_agent", bloqueado: true })]);

    await put(s.app, { scope: "agente", target: "restaurantes:whatsapp_agent", bloqueado: false, motivo: "Incidente resuelto, se reactiva el agente de WhatsApp." }, bearer(sa.token));
    expect(await s.deps.platformSwitchGuard!.agentBlockedBy("restaurantes:whatsapp_agent")).toBeNull();
  });

  it("bloquear un cron lo detiene en el guard; el global crons detiene todos", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    await put(s.app, { scope: "cron", target: "/internal/hoteles/night-audit", bloqueado: true, motivo: MOTIVO }, bearer(sa.token));
    expect(await s.deps.platformSwitchGuard!.cronBlockedBy("/internal/hoteles/night-audit")).toBe("cron:/internal/hoteles/night-audit");
    expect(await s.deps.platformSwitchGuard!.cronBlockedBy("/internal/whatsapp/dispatch")).toBeNull();
    await put(s.app, { scope: "global", target: "crons", bloqueado: true, motivo: MOTIVO }, bearer(sa.token));
    expect(await s.deps.platformSwitchGuard!.cronBlockedBy("/internal/whatsapp/dispatch")).toBe("global:crons");
  });

  it("validacion: scope, bloqueado, target fuera del catalogo, motivo corto -> 400 (y no se guarda nada)", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const casos: Array<Record<string, unknown>> = [
      { scope: "tenant", target: "x", bloqueado: true, motivo: MOTIVO },
      { scope: "agente", target: "restaurantes:whatsapp_agent", bloqueado: "si", motivo: MOTIVO },
      { scope: "agente", target: "inventado:agente", bloqueado: true, motivo: MOTIVO },
      { scope: "cron", target: "/internal/no-existe", bloqueado: true, motivo: MOTIVO },
      { scope: "global", target: "todo", bloqueado: true, motivo: MOTIVO },
      { scope: "global", target: "llm", bloqueado: true, motivo: "corto" },
      { scope: "global", target: "llm", bloqueado: true },
    ];
    for (const caso of casos) expect((await put(s.app, caso, bearer(sa.token))).status, JSON.stringify(caso)).toBe(400);
    expect((await s.switches.list(sa.id)).switches).toEqual([]);
  });

  it("sin repos cableados -> GET disponible:false y PUT 503", async () => {
    const s = await seguridadSetup({ sinRepos: true });
    const sa = await s.superadmin();
    expect(await (await s.app.request("/superadmin/interruptores", { headers: bearer(sa.token) })).json()).toMatchObject({ disponible: false, interruptores: [] });
    expect((await put(s.app, { scope: "global", target: "llm", bloqueado: true, motivo: MOTIVO }, bearer(sa.token))).status).toBe(503);
  });

  it("BASE SIN MIGRAR: el repo reporta not_migrated -> GET disponible:false (lista vacia honesta) y PUT 503, nunca 500", async () => {
    const notMigrated: PlatformSwitchRepository = {
      setSwitch: async () => ({ availability: "not_migrated", row: null }),
      list: async () => ({ availability: "not_migrated", switches: [] }),
      getBlocked: async () => ({ availability: "not_migrated", blocked: [] }),
    };
    const s = await seguridadSetup({ platformSwitchRepo: () => notMigrated });
    const sa = await s.superadmin();
    expect(await (await s.app.request("/superadmin/interruptores", { headers: bearer(sa.token) })).json()).toMatchObject({ disponible: false, interruptores: [] });
    expect((await put(s.app, { scope: "global", target: "llm", bloqueado: true, motivo: MOTIVO }, bearer(sa.token))).status).toBe(503);
  });

  it("cada cambio exige el motivo y el actor se toma del token, nunca del body", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const res = await put(s.app, { scope: "global", target: "llm", bloqueado: true, motivo: MOTIVO, actualizadoPor: "00000000-0000-0000-0000-000000000000" }, bearer(sa.token));
    expect(((await res.json()) as { interruptor: { actualizadoPor: string } }).interruptor.actualizadoPor).toBe(sa.id);
  });
});
