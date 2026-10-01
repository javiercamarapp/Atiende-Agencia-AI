// Interruptores de plataforma: catalogo, guard con cache (fail-open) y su efecto
// real en withHeartbeat (cron) y en el catalogo de roles del gateway.
import { describe, expect, it, vi } from "vitest";
import { InMemorySaludRepository } from "@atiende/db";
import type { BlockedSwitch } from "@atiende/db";
import type { AppDeps } from "../src/deps.ts";
import { ALL_PRODUCTION_ROLES } from "../src/production/llm-gateway.ts";
import { SWITCHABLE_AGENT_ROLES, SWITCHABLE_CRONS, createPlatformSwitchGuard, isSwitchableTarget } from "../src/platform-switches.ts";
import { withHeartbeat } from "../src/salud/with-heartbeat.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("catalogo de interruptores", () => {
  it("los roles detenibles son EXACTAMENTE los registrados en el gateway de produccion (salvo los *_escalated, que van con su base)", () => {
    const base = ALL_PRODUCTION_ROLES.filter((r) => !r.endsWith("_escalated")).sort();
    expect([...SWITCHABLE_AGENT_ROLES].sort()).toEqual(base);
  });

  it("los crons detenibles son los que envuelve withHeartbeat y estan en vercel.json", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const vercel = JSON.parse(readFileSync(path.resolve(here, "..", "..", "..", "vercel.json"), "utf8")) as { crons?: Array<{ path: string }> };
    const cronPaths = new Set((vercel.crons ?? []).map((c) => c.path));
    for (const cron of SWITCHABLE_CRONS) expect(cronPaths.has(cron), cron).toBe(true);
  });

  it("isSwitchableTarget solo acepta claves reales", () => {
    expect(isSwitchableTarget("global", "llm")).toBe(true);
    expect(isSwitchableTarget("global", "crons")).toBe(true);
    expect(isSwitchableTarget("global", "todo")).toBe(false);
    expect(isSwitchableTarget("agente", "restaurantes:whatsapp_agent")).toBe(true);
    expect(isSwitchableTarget("agente", "inventado:agente")).toBe(false);
    expect(isSwitchableTarget("cron", "/internal/whatsapp/dispatch")).toBe(true);
    expect(isSwitchableTarget("cron", "/internal/no-existe")).toBe(false);
  });
});

describe("createPlatformSwitchGuard", () => {
  const blocked = (...rows: BlockedSwitch[]) => async () => rows;

  it("agente: global:llm detiene todo; agente:<rol> solo ese rol; el rol *_escalated cae con su base", async () => {
    const guard = createPlatformSwitchGuard(blocked({ scope: "agente", target: "restaurantes:whatsapp_agent" }));
    expect(await guard.agentBlockedBy("restaurantes:whatsapp_agent")).toBe("agente:restaurantes:whatsapp_agent");
    expect(await guard.agentBlockedBy("restaurantes:whatsapp_agent_escalated")).toBe("agente:restaurantes:whatsapp_agent");
    expect(await guard.agentBlockedBy("hoteles:whatsapp_agent")).toBeNull();
    const global = createPlatformSwitchGuard(blocked({ scope: "global", target: "llm" }));
    expect(await global.agentBlockedBy("hoteles:whatsapp_agent")).toBe("global:llm");
    expect(await global.cronBlockedBy("/internal/whatsapp/dispatch")).toBeNull();
  });

  it("cron: global:crons detiene todos; cron:<path> solo ese", async () => {
    const one = createPlatformSwitchGuard(blocked({ scope: "cron", target: "/internal/whatsapp/dispatch" }));
    expect(await one.cronBlockedBy("/internal/whatsapp/dispatch")).toBe("cron:/internal/whatsapp/dispatch");
    expect(await one.cronBlockedBy("/internal/hoteles/night-audit")).toBeNull();
    const all = createPlatformSwitchGuard(blocked({ scope: "global", target: "crons" }));
    expect(await all.cronBlockedBy("/internal/hoteles/night-audit")).toBe("global:crons");
  });

  it("cachea por ttl, deduplica refrescos concurrentes y invalidate() fuerza la relectura", async () => {
    let now = 0;
    let calls = 0;
    let rows: BlockedSwitch[] = [];
    const guard = createPlatformSwitchGuard(
      async () => {
        calls += 1;
        return rows;
      },
      { ttlMs: 10_000, now: () => now },
    );
    await Promise.all([guard.agentBlockedBy("a:b"), guard.agentBlockedBy("a:b"), guard.cronBlockedBy("/internal/x")]);
    expect(calls).toBe(1);
    rows = [{ scope: "global", target: "llm" }];
    expect(await guard.agentBlockedBy("a:b")).toBeNull(); // cache vigente: aun no se entera
    now += 10_001;
    expect(await guard.agentBlockedBy("a:b")).toBe("global:llm");
    rows = [];
    guard.invalidate();
    expect(await guard.agentBlockedBy("a:b")).toBeNull();
    expect(calls).toBe(3);
  });

  it("FAIL-OPEN: si la lectura falla conserva el ultimo conjunto bueno (o vacio), registra y reintenta pronto", async () => {
    let now = 0;
    let fail = false;
    const onError = vi.fn();
    const guard = createPlatformSwitchGuard(
      async () => {
        if (fail) throw new Error("postgres caido");
        return [{ scope: "agente", target: "citas:whatsapp_agent" }] as BlockedSwitch[];
      },
      { ttlMs: 10_000, retryAfterErrorMs: 2_000, now: () => now, onError },
    );
    expect(await guard.agentBlockedBy("citas:whatsapp_agent")).toBe("agente:citas:whatsapp_agent");
    fail = true;
    now += 10_001;
    expect(await guard.agentBlockedBy("citas:whatsapp_agent")).toBe("agente:citas:whatsapp_agent"); // ultimo bueno
    expect(onError).toHaveBeenCalledTimes(1);
    fail = false;
    now += 2_001;
    expect(await guard.agentBlockedBy("hoteles:whatsapp_agent")).toBeNull();

    const nuncaCargo = createPlatformSwitchGuard(async () => { throw new Error("boom"); }, { onError: () => {}, now: () => 0 });
    expect(await nuncaCargo.agentBlockedBy("a:b")).toBeNull();
  });
});

describe("withHeartbeat + interruptor de cron", () => {
  function depsCon(guard: ReturnType<typeof createPlatformSwitchGuard> | undefined, saludRepo = new InMemorySaludRepository()): AppDeps {
    return { saludRepo, platformSwitchGuard: guard } as unknown as AppDeps;
  }

  it("cron detenido: NO corre el handler, responde 200 skipped y deja latido ok con nota visible", async () => {
    const saludRepo = new InMemorySaludRepository();
    saludRepo.addPlatformSuperadmin("admin-1");
    const guard = createPlatformSwitchGuard(async () => [{ scope: "cron", target: "/internal/whatsapp/dispatch" }]);
    const handler = vi.fn(async () => new Response("real"));
    const res = await withHeartbeat(depsCon(guard, saludRepo), "/internal/whatsapp/dispatch", handler)();
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "kill_switch", switch: "cron:/internal/whatsapp/dispatch" });
    const latidos = await saludRepo.listCronHeartbeatsForSuperadmin("admin-1");
    expect(latidos[0]).toMatchObject({ lastStatus: "ok", lastError: "pausado por interruptor de plataforma (cron:/internal/whatsapp/dispatch)" });
  });

  it("otro cron NO se ve afectado; sin guard el comportamiento es el de siempre", async () => {
    const guard = createPlatformSwitchGuard(async () => [{ scope: "cron", target: "/internal/whatsapp/dispatch" }]);
    const real = new Response("real");
    expect(await withHeartbeat(depsCon(guard), "/internal/hoteles/night-audit", async () => real)()).toBe(real);
    expect(await withHeartbeat(depsCon(undefined), "/internal/whatsapp/dispatch", async () => real)()).toBe(real);
  });

  it("si el propio guard lanza, el cron corre (fail-open)", async () => {
    const guard = { agentBlockedBy: async () => null, cronBlockedBy: async () => { throw new Error("guard roto"); }, invalidate: () => {} };
    const real = new Response("real");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await withHeartbeat(depsCon(guard), "/internal/whatsapp/dispatch", async () => real)()).toBe(real);
    spy.mockRestore();
  });
});
