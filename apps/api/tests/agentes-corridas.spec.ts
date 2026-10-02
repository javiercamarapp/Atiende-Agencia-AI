// Bitacora de corridas (SA-L-07): withHeartbeat y el punto unico de salida del turno de WhatsApp dejan una fila en
// core.agent_run; el error queda redactado; una bitacora rota o sin migrar NUNCA tumba ni altera la corrida; y un
// fallo de un agente vivo emite el aviso in-app (dedupe por agente y dia, sin PII).
import { describe, expect, it, vi } from "vitest";
import { InMemoryAgentRunRepository, InMemorySaludRepository } from "@atiende/db";
import type { AppDeps } from "../src/deps.ts";
import { conBitacoraDeTurno, redactarErrorCorrida, registrarCorridaBestEffort, verticalDeCron } from "../src/agentes/corridas.ts";
import { CronPartialFailureError, withHeartbeat } from "../src/salud/with-heartbeat.ts";
import { conEmisiones } from "./support/emisiones.ts";

function armar(opciones: { repo?: InMemoryAgentRunRepository; alEmitir?: () => number; platformSwitchGuard?: AppDeps["platformSwitchGuard"] } = {}) {
  const repo = opciones.repo ?? new InMemoryAgentRunRepository();
  const sesion = { query: vi.fn(async () => ({ rows: [] })), exec: vi.fn(async () => undefined) };
  const base = {
    saludRepo: new InMemorySaludRepository(),
    engine: { withAppSession: async (_claims: unknown, fn: (s: typeof sesion) => Promise<unknown>) => fn(sesion) },
    agentRunRepo: () => repo,
    ...(opciones.platformSwitchGuard ? { platformSwitchGuard: opciones.platformSwitchGuard } : {}),
  };
  const { deps, emisiones } = conEmisiones(base as never, { alEmitir: opciones.alEmitir });
  return { deps: deps as unknown as AppDeps, repo, emisiones };
}

describe("redactarErrorCorrida", () => {
  it("quita correos, telefonos, credenciales y secuencias largas de digitos", () => {
    const t = redactarErrorCorrida(new Error("fallo con ana.perez@example.com, tel +5215512345678 y 55 1234 5678, Bearer abcdef1234567890 y sk-live_ABCDEFGH12345678"));
    expect(t).not.toMatch(/ana\.perez|example\.com|5512345678|1234 5678|abcdef1234567890|ABCDEFGH12345678/);
    expect(t).toContain("[correo]");
    expect(t).toContain("[numero]");
    expect(t).toContain("[credencial]");
  });

  it("acota a 500 caracteres, colapsa espacios y nunca devuelve vacio", () => {
    expect(redactarErrorCorrida(new Error("x ".repeat(600))).length).toBeLessThanOrEqual(500);
    expect(redactarErrorCorrida("   ")).toBe("error desconocido");
    expect(redactarErrorCorrida({ cualquier: "cosa" })).toBe("error desconocido");
  });
});

describe("verticalDeCron", () => {
  it("toma la vertical de la ruta y cae a plataforma para lo transversal", () => {
    expect(verticalDeCron("/internal/hoteles/night-audit")).toBe("hoteles");
    expect(verticalDeCron("/internal/whatsapp/dispatch")).toBe("plataforma");
    expect(verticalDeCron("/internal/superadmin/mantenimiento")).toBe("plataforma");
    expect(verticalDeCron("/otra/cosa")).toBe("plataforma");
  });
});

describe("withHeartbeat -> core.agent_run", () => {
  it("un cron envuelto deja UNA fila 'ok' con su estado, vertical, disparo cron y duracion; devuelve la MISMA response", async () => {
    const { deps, repo } = armar();
    const real = new Response("{}", { status: 200 });
    expect(await withHeartbeat(deps, "/internal/hoteles/night-audit", async () => real)()).toBe(real);
    expect(repo.registradas).toHaveLength(1);
    const f = repo.registradas[0]!;
    expect(f).toMatchObject({ agente: "/internal/hoteles/night-audit", vertical: "hoteles", disparo: "cron", estado: "ok", error: null, organizationId: null, tareasHechas: null, tareasTotal: null, costoMicroUsd: null });
    expect(f.terminadoEn.getTime()).toBeGreaterThanOrEqual(f.iniciadoEn.getTime());
  });

  it("un cron que lanza deja 'fallo' con el error REDACTADO y relanza la MISMA excepcion", async () => {
    const { deps, repo } = armar();
    const err = new Error("no se pudo notificar a cliente@correo.com con token Bearer zzzzzzzz12345678");
    await expect(withHeartbeat(deps, "/internal/citas/confirmacion-cita", async () => { throw err; })()).rejects.toBe(err);
    expect(repo.registradas).toHaveLength(1);
    expect(repo.registradas[0]).toMatchObject({ estado: "fallo", vertical: "citas" });
    expect(repo.registradas[0]!.error).not.toMatch(/cliente@correo|zzzzzzzz/);
    expect(repo.registradas[0]!.error!.length).toBeLessThanOrEqual(500);
  });

  it("una falla parcial (CronPartialFailureError) queda 'parcial' y la Response original llega al caller", async () => {
    const { deps, repo } = armar();
    const respuesta = new Response(JSON.stringify({ ok: false }), { status: 200 });
    const r = await withHeartbeat(deps, "/internal/rentas/ical-sync", async () => { throw new CronPartialFailureError("1 propiedad fallo", respuesta); })();
    expect(r).toBe(respuesta);
    expect(repo.registradas[0]).toMatchObject({ estado: "parcial", vertical: "rentas", error: "1 propiedad fallo" });
  });

  it("si la bitacora FALLA al escribir, el cron devuelve su respuesta intacta y su error original sigue siendo el mismo", async () => {
    const repo = new InMemoryAgentRunRepository();
    repo.falloEscritura = Object.assign(new Error("connection terminated"), { code: "57P01" });
    const { deps } = armar({ repo });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const real = new Response("{}");
    expect(await withHeartbeat(deps, "/internal/test/ok", async () => real)()).toBe(real);
    const err = new Error("falla real del cron");
    await expect(withHeartbeat(deps, "/internal/test/roto", async () => { throw err; })()).rejects.toBe(err);
    // solo el SQLSTATE queda en logs, nunca el mensaje del error de la bitacora
    expect(spy.mock.calls.flat().join(" ")).toContain("57P01");
    spy.mockRestore();
  });

  it("contra la base SIN migrar (la 0044 sin aplicar) la escritura se omite y el latido y la respuesta siguen como siempre", async () => {
    const repo = new InMemoryAgentRunRepository();
    repo.sinMigrar = true;
    const { deps } = armar({ repo });
    const real = new Response("{}");
    expect(await withHeartbeat(deps, "/internal/test/ok", async () => real)()).toBe(real);
    expect(repo.registradas).toHaveLength(0);
  });

  it("sin agentRunRepo configurado (tests y despliegues previos) withHeartbeat funciona exactamente como antes", async () => {
    const real = new Response("{}");
    expect(await withHeartbeat({ saludRepo: new InMemorySaludRepository() } as unknown as AppDeps, "/internal/test/ok", async () => real)()).toBe(real);
  });

  it("una pausa por interruptor NO es una corrida: no escribe en agent_run", async () => {
    const { deps, repo } = armar({ platformSwitchGuard: { agentBlockedBy: async () => null, cronBlockedBy: async () => "cron:/internal/test/pausado", invalidate: () => undefined } });
    const handler = vi.fn(async () => new Response("{}"));
    await withHeartbeat(deps, "/internal/test/pausado", handler)();
    expect(handler).not.toHaveBeenCalled();
    expect(repo.registradas).toHaveLength(0);
  });

  it("un cron en fallo NO emite superadmin.agente.fallo (ya emite superadmin.cron.fallo)", async () => {
    const repo = new InMemoryAgentRunRepository();
    repo.vivos.add("/internal/test/roto");
    const { deps, emisiones } = armar({ repo });
    await expect(withHeartbeat(deps, "/internal/test/roto", async () => { throw new Error("x"); })()).rejects.toThrow();
    expect(emisiones.map((e) => e.evento)).not.toContain("superadmin.agente.fallo");
  });
});

describe("conBitacoraDeTurno (punto unico de salida del turno de WhatsApp)", () => {
  const args = { organizationId: "org-1", phone: "+5215500000000", messages: [], customer: {} };
  const turno = (resultado: () => Promise<{ reply: string }>) => ({ handleInboundMessage: vi.fn(async (_a: typeof args) => resultado()) });

  it("un turno que responde deja 'ok' con la organizacion, el disparo whatsapp y devuelve el MISMO resultado", async () => {
    const { deps, repo } = armar();
    const real = { reply: "hola" };
    const h = conBitacoraDeTurno(turno(async () => real), { deps, agente: "restaurantes:whatsapp_agent", vertical: "restaurantes" });
    expect(await h.handleInboundMessage(args)).toBe(real);
    expect(repo.registradas[0]).toMatchObject({ agente: "restaurantes:whatsapp_agent", vertical: "restaurantes", organizationId: "org-1", disparo: "whatsapp", estado: "ok" });
    // el telefono del cliente jamas viaja a la bitacora
    expect(JSON.stringify(repo.registradas)).not.toContain("5500000000");
  });

  it("un turno que lanza deja 'fallo' redactado y relanza la MISMA excepcion", async () => {
    const { deps, repo } = armar();
    const err = new Error("el proveedor rechazo el mensaje de +5215500000000");
    const h = conBitacoraDeTurno(turno(async () => { throw err; }), { deps, agente: "hoteles:whatsapp_agent", vertical: "hoteles" });
    await expect(h.handleInboundMessage(args)).rejects.toBe(err);
    expect(repo.registradas[0]).toMatchObject({ estado: "fallo", agente: "hoteles:whatsapp_agent" });
    expect(repo.registradas[0]!.error).not.toContain("5500000000");
  });

  it("un fallo de un agente VIVO emite UN aviso superadmin.agente.fallo (sin PII, dedupe por agente y dia); uno no vivo no avisa", async () => {
    const repo = new InMemoryAgentRunRepository();
    repo.vivos.add("citas:whatsapp_agent");
    const { deps, emisiones } = armar({ repo });
    const fallar = () => conBitacoraDeTurno(turno(async () => { throw new Error("boom de cliente@correo.com"); }), { deps, agente: "citas:whatsapp_agent", vertical: "citas" });
    await expect(fallar().handleInboundMessage(args)).rejects.toThrow();
    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({
      evento: "superadmin.agente.fallo",
      organizationId: null,
      severidad: "critica",
      enlace: "/superadmin/agentes",
      cuerpo: "Agente: citas:whatsapp_agent.",
      dedupeKey: `superadmin.agente.fallo:citas:whatsapp_agent:${new Date().toISOString().slice(0, 10)}`,
    });
    expect(`${emisiones[0]!.titulo} ${emisiones[0]!.cuerpo}`).not.toMatch(/boom|correo/);

    const noVivo = armar();
    const h = conBitacoraDeTurno(turno(async () => { throw new Error("x"); }), { deps: noVivo.deps, agente: "citas:whatsapp_agent", vertical: "citas" });
    await expect(h.handleInboundMessage(args)).rejects.toThrow();
    expect(noVivo.emisiones).toHaveLength(0);
  });

  it("un turno ok no emite aviso", async () => {
    const repo = new InMemoryAgentRunRepository();
    repo.vivos.add("citas:whatsapp_agent");
    const { deps, emisiones } = armar({ repo });
    await conBitacoraDeTurno(turno(async () => ({ reply: "ok" })), { deps, agente: "citas:whatsapp_agent", vertical: "citas" }).handleInboundMessage(args);
    expect(emisiones).toHaveLength(0);
  });

  it("si la bitacora y el aviso fallan, el turno devuelve su resultado (o su error) sin cambios", async () => {
    const repo = new InMemoryAgentRunRepository();
    repo.falloEscritura = new Error("bitacora caida");
    const { deps } = armar({ repo });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const real = { reply: "hola" };
    expect(await conBitacoraDeTurno(turno(async () => real), { deps, agente: "restaurantes:whatsapp_agent", vertical: "restaurantes" }).handleInboundMessage(args)).toBe(real);
    const err = new Error("falla real del turno");
    await expect(conBitacoraDeTurno(turno(async () => { throw err; }), { deps, agente: "restaurantes:whatsapp_agent", vertical: "restaurantes" }).handleInboundMessage(args)).rejects.toBe(err);
    spy.mockRestore();
  });

  it("registrarCorridaBestEffort sin repositorio no hace nada ni lanza", async () => {
    await expect(registrarCorridaBestEffort({ engine: {} as never }, { agente: "x:y", vertical: "citas", disparo: "manual", estado: "ok", iniciadoEn: new Date(), terminadoEn: new Date() })).resolves.toBeUndefined();
  });
});
