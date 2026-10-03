// `proponer_accion` del Copiloto de superadmin (CHAT-17): el modelo SOLO PROPONE. Cubre la herramienta con dobles (catalogo cerrado, actor, hash de argumentos,
// un solo uso, vida corta, el modelo nunca ejecuta) y las rutas por HTTP con LLM GUIONADO y repositorios en memoria (propuesta -> tarjeta -> confirmacion con
// step-up; reuso, vencimiento, actor ajeno y estado cambiado). El SQL real de los intents lo prueba scripts/verify-superadmin-acciones*/ ya existente.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, totpAt } from "@atiende/core-auth";
import { scriptedCompletion, type DataChatAnswer, type DataChatToolContext, type ScriptStep } from "@atiende/agent-core/data-chat";
import type { PlatformSwitchRow, SuperadminActionIntentRow } from "@atiende/db";
import { InMemoryCfoZoneRepository, type InMemorySuperadminAccionesRepository } from "@atiende/db";
import { SWITCHABLE_AGENT_ROLES } from "../src/platform-switches.ts";
import type { AppDeps } from "../src/deps.ts";
import type { ConversacionesRepository } from "../src/data-chat/conversaciones.ts";
import { buildApp } from "../src/app.ts";
import {
  TIPOS_PROPUESTA,
  VIDA_PROPUESTA_MS,
  crearHerramientaProponerAccion,
  esTokenInterruptor,
  firmarPropuestaInterruptor,
  reiniciarNoncesConsumidos,
  verificarPropuestaInterruptor,
  type DependenciasAcciones,
} from "../src/superadmin-copiloto/acciones.ts";
import type { PlatformScope } from "../src/superadmin-copiloto/alcance.ts";
import { HERRAMIENTAS_ACCION, buildCatalogoPlataforma } from "../src/superadmin-copiloto/catalogo.ts";
import { crearLedgerMensual } from "../src/superadmin-copiloto/deps.ts";
import { fuentesDeProduccion } from "../src/superadmin-copiloto/fuentes.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";
import { fuentesFalsas, ok } from "./superadmin-copiloto-fixtures.ts";

const SECRETO = "subllave-de-prueba";
const ACTOR = "11111111-1111-4111-8111-111111111111";
const OTRO = "22222222-2222-4222-8222-222222222222";
const AGENTE = "restaurantes:whatsapp_agent";
const AHORA = Date.UTC(2026, 9, 3, 12, 0, 0);
const SCOPE: PlatformScope = { userId: ACTOR, rol: "superadmin", stepUp: true, timezone: "America/Mexico_City" };
const CTX = { scope: { organizationId: "plataforma", userId: ACTOR, vertical: "plataforma", verticalRole: "superadmin", allowedPropertyIds: null, timezone: "America/Mexico_City" }, now: new Date(AHORA), signal: new AbortController().signal, maxRows: 50 } satisfies DataChatToolContext;

beforeEach(() => reiniciarNoncesConsumidos());

describe("token firmado de la propuesta de interruptor", () => {
  it("solo letras minusculas (la redaccion de telefonos del motor no puede mutilarlo) y 44 caracteres", () => {
    for (let i = 0; i < 50; i++) expect(esTokenInterruptor(firmarPropuestaInterruptor(SECRETO, ACTOR, AGENTE, true, false, AHORA))).toBe(true);
  });

  it("verifica con el MISMO actor y agente; recupera efecto y estado observado", () => {
    const t = firmarPropuestaInterruptor(SECRETO, ACTOR, AGENTE, true, false, AHORA);
    const v = verificarPropuestaInterruptor(SECRETO, ACTOR, AGENTE, t, AHORA + 1000);
    expect(v.ok && v.propuesta).toMatchObject({ bloquear: true, antes: false, venceMs: expect.any(Number) });
    const v2 = verificarPropuestaInterruptor(SECRETO, ACTOR, AGENTE, firmarPropuestaInterruptor(SECRETO, ACTOR, AGENTE, false, true, AHORA), AHORA);
    expect(v2.ok && v2.propuesta).toMatchObject({ bloquear: false, antes: true });
  });

  it("otro actor, otro agente, otra subllave o un token alterado NO verifican (hash de los argumentos ligado)", () => {
    const t = firmarPropuestaInterruptor(SECRETO, ACTOR, AGENTE, true, false, AHORA);
    expect(verificarPropuestaInterruptor(SECRETO, OTRO, AGENTE, t, AHORA)).toEqual({ ok: false, motivo: "firma" });
    expect(verificarPropuestaInterruptor(SECRETO, ACTOR, "hoteles:whatsapp_agent", t, AHORA)).toEqual({ ok: false, motivo: "firma" });
    expect(verificarPropuestaInterruptor("otra", ACTOR, AGENTE, t, AHORA)).toEqual({ ok: false, motivo: "firma" });
    // cambiar el efecto (primer caracter) invalida la firma
    const cambiado = `${t[0] === "b" ? "c" : "b"}${t.slice(1)}`;
    expect(verificarPropuestaInterruptor(SECRETO, ACTOR, AGENTE, cambiado, AHORA)).toEqual({ ok: false, motivo: "firma" });
    expect(verificarPropuestaInterruptor(SECRETO, ACTOR, AGENTE, "no-es-un-token", AHORA)).toEqual({ ok: false, motivo: "malformada" });
  });

  it("vence a los 5 minutos", () => {
    const t = firmarPropuestaInterruptor(SECRETO, ACTOR, AGENTE, true, false, AHORA);
    expect(VIDA_PROPUESTA_MS).toBe(5 * 60_000);
    expect(verificarPropuestaInterruptor(SECRETO, ACTOR, AGENTE, t, AHORA + VIDA_PROPUESTA_MS - 2000).ok).toBe(true);
    expect(verificarPropuestaInterruptor(SECRETO, ACTOR, AGENTE, t, AHORA + VIDA_PROPUESTA_MS + 2000)).toEqual({ ok: false, motivo: "vencida" });
  });
});

function dobles(sobre: Partial<DependenciasAcciones> = {}, apagados: readonly string[] = []) {
  const llamadas = { componer: vi.fn(), crear: vi.fn(), avisar: vi.fn(async () => undefined) };
  const dep: DependenciasAcciones = {
    secreto: SECRETO,
    ahora: () => AHORA,
    componerIntent: async (tipo, payload) => {
      llamadas.componer(tipo, payload);
      return { resumen: `Resumen de ${tipo}`, payloadValidado: payload };
    },
    crearIntent: async (tipo, payload, resumen, minutos) => {
      llamadas.crear(tipo, payload, resumen, minutos);
      return { id: "33333333-3333-4333-8333-333333333333", venceEn: new Date(AHORA + minutos * 60_000).toISOString() };
    },
    interruptores: async () => ok(apagados.map((target): PlatformSwitchRow => ({ scope: "agente", target, blocked: true, reason: "x".repeat(20), updatedBy: null, updatedAtMs: 1 }))),
    avisar: llamadas.avisar,
    ...sobre,
  };
  return { dep, llamadas };
}

describe("proponer_accion: la herramienta", () => {
  it("el catalogo de tipos es cerrado y solo contiene lo que existe (3 intents del catalogo + apagar/encender agente)", () => {
    expect([...TIPOS_PROPUESTA].sort()).toEqual(["apagar_agente", "cerrar_prospecto", "ejecutar_mantenimiento_ahora", "encender_agente", "reencolar_mensaje_muerto"]);
    const { dep } = dobles();
    const t = crearHerramientaProponerAccion(SCOPE, dep);
    const spec = t.params["tipo"];
    expect(spec?.type === "enum" && [...spec.values].sort()).toEqual([...TIPOS_PROPUESTA].sort());
    const agente = t.params["agente"];
    expect(agente?.type === "enum" && agente.values).toEqual(SWITCHABLE_AGENT_ROLES);
  });

  it("apagar un agente devuelve una propuesta firmada ligada al actor y NO escribe nada (ni intent ni interruptor)", async () => {
    const { dep, llamadas } = dobles();
    const r = await crearHerramientaProponerAccion(SCOPE, dep).run(CTX, { tipo: "apagar_agente", agente: AGENTE });
    expect(r.status).toBe("ok");
    const fila = r.rows[0]!;
    expect(fila).toMatchObject({ clase: "interruptor", tipo: "apagar_agente", agente: AGENTE });
    const token = String(fila["propuesta"]);
    expect(verificarPropuestaInterruptor(SECRETO, ACTOR, AGENTE, token, AHORA)).toMatchObject({ ok: true, propuesta: { bloquear: true, antes: false } });
    expect(verificarPropuestaInterruptor(SECRETO, OTRO, AGENTE, token, AHORA).ok).toBe(false);
    expect(llamadas.crear).not.toHaveBeenCalled();
    expect(llamadas.avisar).toHaveBeenCalledTimes(1);
  });

  it("encender un agente apagado propone el efecto contrario; si ya esta en ese estado, no hay nada que proponer", async () => {
    const { dep } = dobles({}, [AGENTE]);
    const t = crearHerramientaProponerAccion(SCOPE, dep);
    const enc = await t.run(CTX, { tipo: "encender_agente", agente: AGENTE });
    expect(enc.rows[0]).toMatchObject({ tipo: "encender_agente" });
    expect(verificarPropuestaInterruptor(SECRETO, ACTOR, AGENTE, String(enc.rows[0]!["propuesta"]), AHORA)).toMatchObject({ ok: true, propuesta: { bloquear: false, antes: true } });
    const ya = await t.run(CTX, { tipo: "apagar_agente", agente: AGENTE });
    expect(ya.status).toBe("needs_clarification");
    expect(ya.rows).toHaveLength(0);
  });

  it("sin leer el estado de los interruptores no propone (no inventa)", async () => {
    const { dep } = dobles({ interruptores: async () => ({ ok: false, razon: "no_migrado" }) });
    const r = await crearHerramientaProponerAccion(SCOPE, dep).run(CTX, { tipo: "apagar_agente", agente: AGENTE });
    expect(r.status).toBe("unavailable");
    expect(r.rows).toHaveLength(0);
  });

  it("un intent del catalogo se crea REAL (5 minutos, payload validado por las reglas de Acciones) y no se confirma", async () => {
    const { dep, llamadas } = dobles();
    const r = await crearHerramientaProponerAccion(SCOPE, dep).run(CTX, { tipo: "cerrar_prospecto", prospecto_id: "p-1", estado: "perdido" });
    expect(r.status).toBe("ok");
    expect(llamadas.componer).toHaveBeenCalledWith("cerrar_prospecto", { prospectoId: "p-1", estado: "perdido" });
    expect(llamadas.crear).toHaveBeenCalledWith("cerrar_prospecto", { prospectoId: "p-1", estado: "perdido" }, "Resumen de cerrar_prospecto", 5);
    expect(r.rows[0]).toMatchObject({ clase: "intent", propuesta: "33333333-3333-4333-8333-333333333333" });
    expect(llamadas.avisar).toHaveBeenCalledWith("intent-33333333-3333-4333-8333-333333333333");
  });

  it("un payload invalido (la validacion de Acciones lanza 4xx) se dice y no crea nada", async () => {
    const { dep, llamadas } = dobles({
      componerIntent: async () => {
        throw new ApiError(404, "not_found", "No se encontró ese prospecto.");
      },
    });
    const r = await crearHerramientaProponerAccion(SCOPE, dep).run(CTX, { tipo: "cerrar_prospecto", prospecto_id: "no-existe", estado: "perdido" });
    expect(r.status).toBe("needs_clarification");
    expect(r.message).toMatch(/prospecto/);
    expect(llamadas.crear).not.toHaveBeenCalled();
  });

  it("un fallo inesperado al crear el intent (p. ej. base sin la tabla) es 'no disponible', nunca una propuesta", async () => {
    const { dep } = dobles({
      crearIntent: async () => {
        throw new Error("relation core.superadmin_action_intent does not exist");
      },
    });
    const r = await crearHerramientaProponerAccion(SCOPE, dep).run(CTX, { tipo: "ejecutar_mantenimiento_ahora" });
    expect(r.status).toBe("unavailable");
    expect(r.rows).toHaveLength(0);
  });

  it("el rol finanzas (solo lectura) nunca recibe la herramienta y, si la invocara, no propone nada", async () => {
    const { dep, llamadas } = dobles();
    const cat = buildCatalogoPlataforma(fuentesFalsas(), { ...SCOPE, rol: "finanzas" }, { acciones: dep });
    expect(cat.tools.map((t) => t.name)).not.toContain("proponer_accion");
    const r = await crearHerramientaProponerAccion({ ...SCOPE, rol: "finanzas" }, dep).run(CTX, { tipo: "ejecutar_mantenimiento_ahora" });
    expect(r.status).toBe("unavailable");
    expect(llamadas.crear).not.toHaveBeenCalled();
  });

  it("el superadmin completo la recibe SOLO si se inyectan las dependencias; sin ellas el catalogo sigue siendo de solo lectura", () => {
    const { dep } = dobles();
    expect(buildCatalogoPlataforma(fuentesFalsas(), SCOPE).tools.map((t) => t.name)).not.toContain("proponer_accion");
    expect(buildCatalogoPlataforma(fuentesFalsas(), SCOPE, { acciones: dep }).tools.map((t) => t.name)).toEqual(expect.arrayContaining([...HERRAMIENTAS_ACCION]));
  });
});

// ------------------------------------------------------------------------------------------------------------------------------
// Por HTTP
// ------------------------------------------------------------------------------------------------------------------------------
const sinConversaciones: ConversacionesRepository = {
  list: async () => ({ disponible: false, items: [] }),
  get: async () => null,
  loadHistory: async () => null,
  rename: async () => false,
  remove: async () => false,
  append: async () => ({ guardado: false, motivo: "no_disponible" }),
};

async function setupHttp(steps: ScriptStep[] = [{ text: "" }]) {
  const s = await seguridadSetup();
  const zona = new InMemoryCfoZoneRepository();
  const scripted = scriptedCompletion(steps);
  const deps: AppDeps = {
    ...s.deps,
    cfoZoneRepo: () => zona,
    superadminCopiloto: {
      completion: async (req) => ({ ...(await scripted.complete(req)), costUsd: 0 }),
      rateLimiter: { allow: async () => true },
      ledger: crearLedgerMensual(),
      fuentes: (db, callerId) => fuentesDeProduccion(deps, db, callerId),
      conversaciones: () => sinConversaciones,
      audit: () => ({ record: async () => undefined }),
    },
  };
  const app = buildApp(deps);
  const nuevoSuperadmin = async () => {
    const u = await s.superadmin();
    zona.seedSuperadmin(u.id, u.email);
    (s.base.deps.accionesRepo as InMemorySuperadminAccionesRepository).addPlatformSuperadmin(u.id);
    return u;
  };
  const sa = await nuevoSuperadmin();
  const activarMfa = async (): Promise<string> => {
    const enr = await app.request("/superadmin/mfa/enrolar", jsonRequestInit({}, bearer(sa.token)));
    const { secreto } = (await enr.json()) as { secreto: string };
    const ver = await app.request("/superadmin/mfa/verificar", jsonRequestInit({ codigo: totpAt(secreto, Date.now()) }, bearer(sa.token)));
    return ((await ver.json()) as { stepUpToken: string }).stepUpToken;
  };
  const directa = async (args: Record<string, unknown>, token = sa.token) => {
    const res = await app.request("/superadmin/copiloto", jsonRequestInit({ tool: "proponer_accion", args }, bearer(token)));
    expect(res.status).toBe(200);
    return (await res.json()) as DataChatAnswer;
  };
  const confirmar = (body: unknown, extra: Record<string, string> = {}, token = sa.token) => app.request("/superadmin/copiloto/acciones/confirmar", jsonRequestInit(body, bearer(token, extra)));
  const estado = async (propuesta: string, agente?: string, token = sa.token) => {
    const res = await app.request(`/superadmin/copiloto/acciones/${propuesta}${agente ? `?agente=${encodeURIComponent(agente)}` : ""}`, { headers: bearer(token) });
    expect(res.status).toBe(200);
    return (await res.json()) as { estado: string; clase: string; tipo?: string; resumen?: string; venceEn?: string | null };
  };
  return { s, app, deps, sa, scripted, activarMfa, directa, confirmar, estado, nuevoSuperadmin };
}

const MOTIVO = "Costos fuera de control en este agente esta semana";

describe("proponer_accion por HTTP: el modelo NUNCA ejecuta", () => {
  it("el modelo elige proponer_accion: la respuesta trae la propuesta y el interruptor NO cambia", async () => {
    const ctx = await setupHttp([{ toolCalls: [{ name: "proponer_accion", argumentsJson: JSON.stringify({ tipo: "apagar_agente", agente: AGENTE }) }] }, { text: "Preparé la propuesta; confírmala en la tarjeta." }]);
    const res = await ctx.app.request("/superadmin/copiloto", jsonRequestInit({ question: "apaga el agente de whatsapp de restaurantes" }, bearer(ctx.sa.token)));
    expect(res.status).toBe(200);
    const a = (await res.json()) as DataChatAnswer;
    expect(a.toolsUsed).toEqual(["proponer_accion"]);
    const fila = a.blocks[0]!.rows[0]!;
    expect(fila).toMatchObject({ clase: "interruptor", tipo: "apagar_agente", agente: AGENTE });
    expect((await ctx.s.switches.list(ctx.sa.id)).switches).toHaveLength(0);
    expect(ctx.deps.platformSwitchGuard).toBeDefined();
  });

  it("el modelo pide un intent del catalogo: queda 'pending' y sin ejecutar", async () => {
    const ctx = await setupHttp();
    const a = await ctx.directa({ tipo: "ejecutar_mantenimiento_ahora" });
    expect(a.status).toBe("ok");
    const id = String(a.blocks[0]!.rows[0]!["propuesta"]);
    const intents = await ctx.deps.accionesRepo.listIntentsForSuperadmin(ctx.sa.id, 10);
    const i = intents.find((x: SuperadminActionIntentRow) => x.id === id)!;
    expect(i).toMatchObject({ tipo: "ejecutar_mantenimiento_ahora", estado: "pending", creadoPor: ctx.sa.id });
    expect(new Date(i.venceEn).getTime() - new Date(i.creadoEn).getTime()).toBeLessThanOrEqual(5 * 60_000 + 1000);
    expect(await ctx.estado(id)).toMatchObject({ estado: "pendiente", clase: "intent", tipo: "ejecutar_mantenimiento_ahora" });
  });

  it("un tipo fuera del catalogo (o un agente fuera de SWITCHABLE_AGENT_ROLES) lo rechaza el esquema, no una opinion del modelo", async () => {
    const ctx = await setupHttp();
    for (const args of [{ tipo: "reembolsar_cargo" }, { tipo: "apagar_agente", agente: "x:inventado" }, { tipo: "otorgar_acceso_break_glass" }]) {
      const a = await ctx.directa(args);
      expect(a.status).not.toBe("ok");
      expect(a.blocks).toHaveLength(0);
    }
  });

  it("un staff comun no puede proponer ni consultar propuestas (403)", async () => {
    const ctx = await setupHttp();
    const staff = await ctx.s.staff();
    expect((await ctx.app.request("/superadmin/copiloto", jsonRequestInit({ tool: "proponer_accion", args: { tipo: "ejecutar_mantenimiento_ahora" } }, bearer(staff.token)))).status).toBe(403);
    expect((await ctx.app.request("/superadmin/copiloto/acciones/x", { headers: bearer(staff.token) })).status).toBe(403);
    expect((await ctx.confirmar({ propuesta: "x", agente: AGENTE, motivo: MOTIVO }, {}, staff.token)).status).toBe(403);
  });
});

describe("confirmar la propuesta de interruptor", () => {
  async function propuesta(ctx: Awaited<ReturnType<typeof setupHttp>>, tipo = "apagar_agente") {
    const a = await ctx.directa({ tipo, agente: AGENTE });
    expect(a.status).toBe("ok");
    return String(a.blocks[0]!.rows[0]!["propuesta"]);
  }

  it("sin step-up (con MFA activa) NO ejecuta; con step-up y motivo, apaga el agente con bitacora y motivo", async () => {
    const ctx = await setupHttp();
    const stepUp = await ctx.activarMfa();
    const token = await propuesta(ctx);
    const sin = await ctx.confirmar({ propuesta: token, agente: AGENTE, motivo: MOTIVO });
    expect(sin.status).toBe(403);
    expect(((await sin.json()) as { code: string }).code).toBe("stepup_required");
    expect((await ctx.s.switches.list(ctx.sa.id)).switches).toHaveLength(0);

    const con = await ctx.confirmar({ propuesta: token, agente: AGENTE, motivo: MOTIVO }, { "x-stepup-token": stepUp });
    expect(con.status).toBe(200);
    expect(((await con.json()) as { estado: string }).estado).toBe("ejecutada");
    const filas = (await ctx.s.switches.list(ctx.sa.id)).switches;
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ scope: "agente", target: AGENTE, blocked: true, updatedBy: ctx.sa.id });
    expect(filas[0]!.reason).toContain(MOTIVO);
  });

  it("un solo uso: reintentar la MISMA propuesta es 409 y su estado pasa a 'ejecutada'", async () => {
    const ctx = await setupHttp();
    const token = await propuesta(ctx);
    expect(await ctx.estado(token, AGENTE)).toMatchObject({ estado: "pendiente", clase: "interruptor", tipo: "apagar_agente" });
    expect((await ctx.confirmar({ propuesta: token, agente: AGENTE, motivo: MOTIVO })).status).toBe(200);
    const otra = await ctx.confirmar({ propuesta: token, agente: AGENTE, motivo: MOTIVO });
    expect(otra.status).toBe(409);
    expect((await ctx.estado(token, AGENTE)).estado).toBe("ejecutada");
  });

  it("aunque el aviso en memoria no exista (otra instancia), el estado del interruptor cambiado impide reaplicarla (compare-and-set)", async () => {
    const ctx = await setupHttp();
    const token = await propuesta(ctx);
    expect((await ctx.confirmar({ propuesta: token, agente: AGENTE, motivo: MOTIVO })).status).toBe(200);
    reiniciarNoncesConsumidos();
    const otra = await ctx.confirmar({ propuesta: token, agente: AGENTE, motivo: MOTIVO });
    expect(otra.status).toBe(409);
    expect((await ctx.estado(token, AGENTE)).estado).toBe("archivada");
  });

  it("motivo de menos de 20 caracteres es 400 y no consume la propuesta", async () => {
    const ctx = await setupHttp();
    const token = await propuesta(ctx);
    expect((await ctx.confirmar({ propuesta: token, agente: AGENTE, motivo: "corto" })).status).toBe(400);
    expect((await ctx.confirmar({ propuesta: token, agente: AGENTE, motivo: MOTIVO })).status).toBe(200);
  });

  it("la propuesta es del actor que la pidio: otro superadmin recibe 404 y el estado le sale 'archivada'", async () => {
    const ctx = await setupHttp();
    const token = await propuesta(ctx);
    const otro = await ctx.nuevoSuperadmin();
    expect((await ctx.confirmar({ propuesta: token, agente: AGENTE, motivo: MOTIVO }, {}, otro.token)).status).toBe(404);
    expect((await ctx.estado(token, AGENTE, otro.token)).estado).toBe("archivada");
    expect((await ctx.s.switches.list(ctx.sa.id)).switches).toHaveLength(0);
  });

  it("ligada a los argumentos: confirmar con OTRO agente que el propuesto es 404 y no cambia nada", async () => {
    const ctx = await setupHttp();
    const token = await propuesta(ctx);
    expect((await ctx.confirmar({ propuesta: token, agente: "hoteles:whatsapp_agent", motivo: MOTIVO })).status).toBe(404);
    expect((await ctx.confirmar({ propuesta: token, agente: "x:inventado", motivo: MOTIVO })).status).toBe(400);
    expect((await ctx.s.switches.list(ctx.sa.id)).switches).toHaveLength(0);
  });

  it("vence: pasados 5 minutos es 409 y el estado dice 'vencida'", async () => {
    const ctx = await setupHttp();
    const token = await propuesta(ctx);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + VIDA_PROPUESTA_MS + 5000);
      expect((await ctx.confirmar({ propuesta: token, agente: AGENTE, motivo: MOTIVO })).status).toBe(409);
      expect((await ctx.estado(token, AGENTE)).estado).toBe("vencida");
    } finally {
      vi.useRealTimers();
    }
    expect((await ctx.s.switches.list(ctx.sa.id)).switches).toHaveLength(0);
  });

  it("si alguien cambio el interruptor despues de proponer, la confirmacion se rechaza (409)", async () => {
    const ctx = await setupHttp();
    const token = await propuesta(ctx);
    await ctx.s.switches.setSwitch(ctx.sa.id, "agente", AGENTE, true, "Apagado por otra persona antes de confirmar");
    expect((await ctx.confirmar({ propuesta: token, agente: AGENTE, motivo: MOTIVO })).status).toBe(409);
  });

  it("con impersonacion activa el Copiloto sigue deshabilitado (409 en estado y en el estado de propuestas)", async () => {
    const ctx = await setupHttp();
    const imp = ctx.s.base.deps.impersonationRepo({} as never) as import("@atiende/db").InMemoryImpersonationRepository;
    imp.seedPlatformSuperadmin(ctx.sa.id, ctx.sa.email);
    await imp.startSession(ctx.sa.id, ctx.s.base.organizationId, "Soporte del cliente: revisar el pedido 123 de ayer");
    expect((await ctx.app.request("/superadmin/copiloto/estado", { headers: bearer(ctx.sa.token) })).status).toBe(409);
    expect((await ctx.app.request("/superadmin/copiloto/acciones/x", { headers: bearer(ctx.sa.token) })).status).toBe(409);
  });
});

describe("confirmar un intent del catalogo: un solo uso en la base", () => {
  it("confirma por /superadmin/acciones/intents/:id/confirmar (step-up) y reusarlo no lo ejecuta otra vez", async () => {
    const ctx = await setupHttp();
    const stepUp = await ctx.activarMfa();
    const a = await ctx.directa({ tipo: "ejecutar_mantenimiento_ahora" });
    const id = String(a.blocks[0]!.rows[0]!["propuesta"]);
    const sin = await ctx.app.request(`/superadmin/acciones/intents/${id}/confirmar`, jsonRequestInit({}, bearer(ctx.sa.token)));
    expect(sin.status).toBe(403);
    const con = await ctx.app.request(`/superadmin/acciones/intents/${id}/confirmar`, jsonRequestInit({}, bearer(ctx.sa.token, { "x-stepup-token": stepUp })));
    expect(con.status).toBe(200);
    const primera = ((await con.json()) as { intent: { estado: string; ejecutadoEn: string | null } }).intent;
    expect(primera.estado).toBe("executed");
    // Reusarlo NO lo vuelve a ejecutar: la base devuelve el intent tal cual (misma marca de ejecucion), nunca una segunda corrida.
    const otra = await ctx.app.request(`/superadmin/acciones/intents/${id}/confirmar`, jsonRequestInit({}, bearer(ctx.sa.token, { "x-stepup-token": stepUp })));
    expect(((await otra.json()) as { intent: { ejecutadoEn: string | null } }).intent.ejecutadoEn).toBe(primera.ejecutadoEn);
    expect((await ctx.estado(id)).estado).toBe("ejecutada");
  });

  it("un intent que no existe o es de otro superadmin sale 'archivada'", async () => {
    const ctx = await setupHttp();
    expect((await ctx.estado(randomUUID())).estado).toBe("archivada");
    const a = await ctx.directa({ tipo: "ejecutar_mantenimiento_ahora" });
    const id = String(a.blocks[0]!.rows[0]!["propuesta"]);
    const otro = await ctx.nuevoSuperadmin();
    expect((await ctx.estado(id, undefined, otro.token)).estado).toBe("archivada");
  });
});

describe("el estado del Copiloto declara si propone acciones", () => {
  it("superadmin completo: acciones.propone = true", async () => {
    const ctx = await setupHttp();
    const res = await ctx.app.request("/superadmin/copiloto/estado", { headers: bearer(ctx.sa.token) });
    expect(((await res.json()) as { acciones: { propone: boolean } }).acciones.propone).toBe(true);
  });
});
