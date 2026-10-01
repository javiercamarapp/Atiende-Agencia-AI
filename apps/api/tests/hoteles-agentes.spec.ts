// H-03 -- catalogo de agentes, guardrails, politicas, plantillas y cola de aprobaciones: integracion HTTP real
// (app.request) sobre el repositorio en memoria. RLS/GRANT/triggers/funciones definer los cubre
// scripts/verify-hoteles-agentes-aprobaciones contra Postgres real; el SAVEPOINT contra base sin migrar lo cubre
// packages/domain-hoteles/tests/agentes/postgres-repository-savepoint.spec.ts (AbortAwareFakeSession).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryAgentesRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { runAprobacionesExpiracion } from "../src/routes/verticals/hoteles/agentes-expiracion-cron.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

interface ApprovalBody {
  id: string;
  agente: string;
  accion: string;
  estado: string;
  autoaprobada: boolean;
  motivoBloqueo: string | null;
  motivoDecision: string | null;
  decididaPor: string | null;
  referenciaEjecucion: string | null;
  bitacora?: { tipo: string; sistema: boolean }[];
  bitacoraVisible?: boolean;
}

async function setup(opts: { migrated?: boolean; now?: () => Date } = {}) {
  const ctx = await buildHotelesTestContext(buildApp);
  const repo = new InMemoryAgentesRepository(opts);
  const deps = { ...ctx.deps, hotelesAgentesRepo: () => repo };
  const app = buildApp(deps);
  const url = (p: string) => `/hoteles/${ctx.propertyId}${p}`;
  const get = (path: string, token: string) => app.request(url(path), authedJson(token));
  const post = (path: string, token: string, body: unknown = {}) => app.request(url(path), authedJson(token, body));
  const put = (path: string, token: string, body: unknown) => app.request(url(path), { ...authedJson(token, body), method: "PUT" });
  const sys = { userId: null, role: null } as const;
  const tk = (k: keyof HotelesTestContext["staff"]) => ctx.staff[k].token;
  /** Propuesta del agente (sesion de sistema), como la haria el agente real. */
  const agentPropose = (over: Record<string, unknown> = {}) =>
    repo.proposeAction(
      { propertyId: ctx.propertyId, agentKey: "revenue", actionType: "descuento_tarifa", summary: "Descuento fin de semana", payload: {}, amountCents: null, percent: 10, recipients: null, contentText: null, idempotencyKey: randomUUID(), ...over } as never,
      sys,
    );
  return { ctx, repo, deps, app, get, post, put, tk, agentPropose };
}

describe("catalogo de agentes", () => {
  it("lista los 4 agentes con estado, presupuesto y costo; los roles de lectura ven, housekeeping no (403), sin token 401", async () => {
    const s = await setup();
    await s.repo.recordUsage(s.ctx.propertyId, "recepcion_whatsapp", new Date().toISOString().slice(0, 7), { tokensIn: 100, tokensOut: 20, costMicroUsd: 1_500_000, calls: 3 });
    await s.repo.updateAgentConfig(s.ctx.propertyId, "recepcion_whatsapp", { budgetMicroUsd: 2_000_000 });
    for (const role of ["owner", "gm", "frontdesk", "reservations", "accountant"] as const) expect((await s.get("/agentes", s.tk(role))).status).toBe(200);
    expect((await s.get("/agentes", s.tk("housekeeping"))).status).toBe(403);
    expect((await s.app.request(`/hoteles/${s.ctx.propertyId}/agentes`)).status).toBe(401);
    const body = (await (await s.get("/agentes", s.tk("owner"))).json()) as { disponible: boolean; agentes: { clave: string; estado: string; gastoUsd: number; presupuestoUsd: number | null; porcentajeUso: number | null; gobernado: boolean; llamadas: number }[] };
    expect(body.disponible).toBe(true);
    expect(body.agentes.map((a) => a.clave)).toEqual(["recepcion_whatsapp", "revenue", "reputacion", "mantenimiento"]);
    const rec = body.agentes[0]!;
    expect(rec).toMatchObject({ estado: "activo", gastoUsd: 1.5, presupuestoUsd: 2, porcentajeUso: 75, gobernado: true, llamadas: 3 });
    expect(body.agentes[2]!.gobernado).toBe(false);
  });

  it("presupuesto agotado (gasto >= tope, borde inclusivo) se refleja en el estado", async () => {
    const s = await setup();
    const month = new Date().toISOString().slice(0, 7);
    await s.repo.updateAgentConfig(s.ctx.propertyId, "recepcion_whatsapp", { budgetMicroUsd: 1_000_000 });
    await s.repo.recordUsage(s.ctx.propertyId, "recepcion_whatsapp", month, { tokensIn: 1, tokensOut: 1, costMicroUsd: 1_000_000, calls: 1 });
    const body = (await (await s.get("/agentes", s.tk("gm"))).json()) as { agentes: { clave: string; estado: string }[] };
    expect(body.agentes[0]!.estado).toBe("presupuesto_agotado");
  });

  it("kill switch: owner/gm pausan con motivo (422 sin motivo), frontdesk 403; reanudar limpia", async () => {
    const s = await setup();
    expect((await s.put("/agentes/revenue", s.tk("frontdesk"), { activo: false, motivo: "Revision de costos" })).status).toBe(403);
    expect((await s.put("/agentes/revenue", s.tk("owner"), { activo: false })).status).toBe(400);
    expect((await s.put("/agentes/revenue", s.tk("owner"), { activo: false, motivo: "abc" })).status).toBe(400);
    expect((await s.put("/agentes/revenue", s.tk("owner"), {})).status).toBe(400);
    const paused = (await (await s.put("/agentes/revenue", s.tk("gm"), { activo: false, motivo: "Revision de costos" })).json()) as { agente: { activo: boolean; estado: string; motivoPausa: string } };
    expect(paused.agente).toMatchObject({ activo: false, estado: "pausado", motivoPausa: "Revision de costos" });
    const resumed = (await (await s.put("/agentes/revenue", s.tk("gm"), { activo: true })).json()) as { agente: { activo: boolean; motivoPausa: string | null } };
    expect(resumed.agente).toMatchObject({ activo: true, motivoPausa: null });
  });

  it("presupuesto mensual en USD: valida rango; null quita el tope propio; agente inexistente 400", async () => {
    const s = await setup();
    for (const bad of [0, -5, 2_000_000, "10"]) expect((await s.put("/agentes/recepcion_whatsapp", s.tk("owner"), { presupuestoUsd: bad })).status).toBe(400);
    expect((await s.put("/agentes/hackeo", s.tk("owner"), { activo: true })).status).toBe(400);
    const ok = (await (await s.put("/agentes/recepcion_whatsapp", s.tk("owner"), { presupuestoUsd: 25.5 })).json()) as { agente: { presupuestoUsd: number } };
    expect(ok.agente.presupuestoUsd).toBe(25.5);
    const cleared = (await (await s.put("/agentes/recepcion_whatsapp", s.tk("owner"), { presupuestoUsd: null })).json()) as { agente: { presupuestoUsd: number | null } };
    expect(cleared.agente.presupuestoUsd).toBeNull();
  });

  it("base SIN la migracion 035: lecturas honestas (disponible:false) y escrituras 503, nunca 500", async () => {
    const s = await setup({ migrated: false });
    const cat = (await (await s.get("/agentes", s.tk("owner"))).json()) as { disponible: boolean; agentes: unknown[] };
    expect(cat).toMatchObject({ disponible: false });
    expect(cat.agentes).toHaveLength(4);
    expect(((await (await s.get("/aprobaciones", s.tk("owner"))).json()) as { disponible: boolean }).disponible).toBe(false);
    expect(((await (await s.get("/agentes/plantillas", s.tk("owner"))).json()) as { disponible: boolean }).disponible).toBe(false);
    expect((await s.put("/agentes/revenue", s.tk("owner"), { activo: true })).status).toBe(503);
    expect((await s.post("/aprobaciones", s.tk("frontdesk"), { accion: "descuento_tarifa", resumen: "x", porcentaje: 5, llaveIdempotencia: "llave-12345678" })).status).toBe(503);
  });
});

describe("guardrails", () => {
  const valid = { maxDescuentoPct: 20, maxReembolsoCentavos: 100_000, maxCargoFolioCentavos: 100_000, maxDestinatariosMasivo: 50, palabrasBloqueadas: [" Gratis ", "CORTESÍA", "gratis"], ventanaEnvioInicio: "09:00", ventanaEnvioFin: "20:30" };

  it("sin configurar rigen los valores por defecto; PUT guarda y normaliza las palabras (solo owner/gm)", async () => {
    const s = await setup();
    const def = (await (await s.get("/agentes/guardrails", s.tk("frontdesk"))).json()) as { configurados: boolean; maxDescuentoPct: number; ventanaEnvioInicio: string };
    expect(def).toMatchObject({ configurados: false, maxDescuentoPct: 30, ventanaEnvioInicio: "08:00" });
    expect((await s.put("/agentes/guardrails", s.tk("frontdesk"), valid)).status).toBe(403);
    const saved = (await (await s.put("/agentes/guardrails", s.tk("gm"), valid)).json()) as { configurados: boolean; palabrasBloqueadas: string[]; ventanaEnvioFin: string };
    expect(saved).toMatchObject({ configurados: true, palabrasBloqueadas: ["cortesia", "gratis"], ventanaEnvioFin: "20:30" });
  });

  it("valida bordes: descuento 0/100.01, ventana inicio>=fin, formato de hora, palabra de 61 caracteres, lista de 101", async () => {
    const s = await setup();
    const bad = async (patch: Record<string, unknown>) => (await s.put("/agentes/guardrails", s.tk("owner"), { ...valid, ...patch })).status;
    expect(await bad({ maxDescuentoPct: 0 })).toBe(400);
    expect(await bad({ maxDescuentoPct: 100.01 })).toBe(400);
    expect(await bad({ maxDescuentoPct: 100 })).toBe(200);
    expect(await bad({ ventanaEnvioInicio: "10:00", ventanaEnvioFin: "10:00" })).toBe(400);
    expect(await bad({ ventanaEnvioInicio: "21:00", ventanaEnvioFin: "08:00" })).toBe(400);
    expect(await bad({ ventanaEnvioInicio: "8:00" })).toBe(400);
    expect(await bad({ ventanaEnvioFin: "24:00" })).toBe(400);
    expect(await bad({ palabrasBloqueadas: ["x".repeat(61)] })).toBe(400);
    expect(await bad({ palabrasBloqueadas: ["x".repeat(60)] })).toBe(200);
    expect(await bad({ palabrasBloqueadas: Array.from({ length: 101 }, (_, i) => `w${i}`) })).toBe(400);
    expect(await bad({ maxDestinatariosMasivo: 0 })).toBe(400);
    expect(await bad({ maxReembolsoCentavos: 1.5 })).toBe(400);
  });
});

describe("politicas de aprobacion", () => {
  it("lista las 5 acciones (por defecto: siempre humano, 24 h, owner/gm); PUT valida", async () => {
    const s = await setup();
    const list = (await (await s.get("/agentes/politicas", s.tk("owner"))).json()) as { politicas: { accion: string; modo: string; configurada: boolean; vigenciaMinutos: number; aprobadores: string[] }[] };
    expect(list.politicas).toHaveLength(5);
    expect(list.politicas.every((p) => p.modo === "siempre_humano" && !p.configurada && p.vigenciaMinutos === 1440)).toBe(true);
    expect((await s.put("/agentes/politicas/reembolso", s.tk("frontdesk"), { modo: "siempre_humano" })).status).toBe(403);
    expect((await s.put("/agentes/politicas/transferencia", s.tk("owner"), { modo: "siempre_humano" })).status).toBe(400);
    // contenido para el huesped: nunca automatico
    expect((await s.put("/agentes/politicas/respuesta_resena", s.tk("owner"), { modo: "auto_bajo_umbral", umbralMontoCentavos: 100 })).status).toBe(400);
    expect((await s.put("/agentes/politicas/mensaje_masivo", s.tk("owner"), { modo: "auto_bajo_umbral", umbralMontoCentavos: 100 })).status).toBe(400);
    // umbral obligatorio, vigencia 5..10080, aprobadores validos
    expect((await s.put("/agentes/politicas/descuento_tarifa", s.tk("owner"), { modo: "auto_bajo_umbral" })).status).toBe(400);
    expect((await s.put("/agentes/politicas/reembolso", s.tk("owner"), { modo: "auto_bajo_umbral" })).status).toBe(400);
    expect((await s.put("/agentes/politicas/reembolso", s.tk("owner"), { modo: "siempre_humano", vigenciaMinutos: 4 })).status).toBe(400);
    expect((await s.put("/agentes/politicas/reembolso", s.tk("owner"), { modo: "siempre_humano", vigenciaMinutos: 10081 })).status).toBe(400);
    expect((await s.put("/agentes/politicas/reembolso", s.tk("owner"), { modo: "siempre_humano", aprobadores: ["housekeeping"] })).status).toBe(400);
    expect((await s.put("/agentes/politicas/reembolso", s.tk("owner"), { modo: "siempre_humano", aprobadores: [] })).status).toBe(400);
    const ok = (await (await s.put("/agentes/politicas/descuento_tarifa", s.tk("owner"), { modo: "auto_bajo_umbral", umbralPorcentaje: 10, vigenciaMinutos: 60, aprobadores: ["owner", "gm", "gm"] })).json()) as { modo: string; umbralPorcentaje: number; aprobadores: string[] };
    expect(ok).toMatchObject({ modo: "auto_bajo_umbral", umbralPorcentaje: 10, aprobadores: ["owner", "gm"] });
  });
});

describe("plantillas de WhatsApp versionadas", () => {
  const body = { agente: "recepcion_whatsapp", nombre: "bienvenida_huesped", cuerpo: "Hola, bienvenido a nuestro hotel" };

  it("flujo completo por HTTP: redactar, enviar, no se auto-aprueba, gm aprueba, nueva version archiva la anterior", async () => {
    const s = await setup();
    const v1 = (await (await s.post("/agentes/plantillas", s.tk("frontdesk"), body)).json()) as { id: string; version: number; estado: string };
    expect(v1).toMatchObject({ version: 1, estado: "borrador" });
    expect((await s.post(`/agentes/plantillas/${v1.id}/enviar`, s.tk("frontdesk"))).status).toBe(200);
    expect((await s.post(`/agentes/plantillas/${v1.id}/aprobar`, s.tk("frontdesk"), { motivo: "Texto correcto" })).status).toBe(403);
    expect((await s.post(`/agentes/plantillas/${v1.id}/aprobar`, s.tk("gm"), { motivo: "no" })).status).toBe(400);
    const approved = (await (await s.post(`/agentes/plantillas/${v1.id}/aprobar`, s.tk("gm"), { motivo: "Texto correcto y claro" })).json()) as { estado: string; revisadaPor: string };
    expect(approved).toMatchObject({ estado: "aprobada", revisadaPor: s.ctx.staff.gm.id });
    expect((await s.post(`/agentes/plantillas/${v1.id}/aprobar`, s.tk("owner"), { motivo: "Otra vez" })).status).toBe(409);

    const v2 = (await (await s.post("/agentes/plantillas", s.tk("frontdesk"), { ...body, cuerpo: "Hola, su habitacion esta lista" })).json()) as { id: string; version: number };
    expect(v2.version).toBe(2);
    await s.post(`/agentes/plantillas/${v2.id}/enviar`, s.tk("frontdesk"));
    await s.post(`/agentes/plantillas/${v2.id}/aprobar`, s.tk("owner"), { motivo: "Version vigente nueva" });
    const list = (await (await s.get("/agentes/plantillas", s.tk("accountant"))).json()) as { plantillas: { id: string; estado: string }[] };
    expect(list.plantillas.find((t) => t.id === v1.id)?.estado).toBe("archivada");
    expect(list.plantillas.find((t) => t.id === v2.id)?.estado).toBe("aprobada");
  });

  it("separacion de funciones: el gm no aprueba la que el mismo envio (403)", async () => {
    const s = await setup();
    const t = (await (await s.post("/agentes/plantillas", s.tk("gm"), body)).json()) as { id: string };
    await s.post(`/agentes/plantillas/${t.id}/enviar`, s.tk("gm"));
    expect((await s.post(`/agentes/plantillas/${t.id}/aprobar`, s.tk("gm"), { motivo: "Me la apruebo yo" })).status).toBe(403);
  });

  it("validaciones: roles, nombre, idioma, categoria y cuerpo; id mal formado y de otra property", async () => {
    const s = await setup();
    expect((await s.post("/agentes/plantillas", s.tk("housekeeping"), body)).status).toBe(403);
    expect((await s.post("/agentes/plantillas", s.tk("accountant"), body)).status).toBe(403);
    for (const bad of [{ nombre: "Bienvenida" }, { nombre: "ab" }, { idioma: "fr" }, { categoria: "authentication" }, { cuerpo: "" }, { cuerpo: "x".repeat(1025) }, { agente: "hackeo" }]) {
      expect((await s.post("/agentes/plantillas", s.tk("frontdesk"), { ...body, ...bad })).status).toBe(400);
    }
    expect((await s.post("/agentes/plantillas/no-es-uuid/enviar", s.tk("frontdesk"))).status).toBe(400);
    expect((await s.post(`/agentes/plantillas/${randomUUID()}/enviar`, s.tk("frontdesk"))).status).toBe(404);
  });
});

describe("cola de aprobaciones humanas", () => {
  const propuesta = { accion: "descuento_tarifa", resumen: "Descuento fin de semana", porcentaje: 10, llaveIdempotencia: "llave-descuento-0001" };

  it("una persona propone (queda como manual y pendiente) y otra decide con motivo: aprobada con decisor y motivo", async () => {
    const s = await setup();
    const res = await s.post("/aprobaciones", s.tk("frontdesk"), propuesta);
    expect(res.status).toBe(201);
    const a = (await res.json()) as ApprovalBody;
    expect(a).toMatchObject({ agente: "manual", estado: "pendiente", autoaprobada: false });
    const done = (await (await s.post(`/aprobaciones/${a.id}/aprobar`, s.tk("gm"), { motivo: "Ocupacion baja el fin de semana" })).json()) as ApprovalBody;
    expect(done).toMatchObject({ estado: "aprobada", decididaPor: s.ctx.staff.gm.id, motivoDecision: "Ocupacion baja el fin de semana" });
  });

  it("validacion de la propuesta: roles, campos obligatorios, llave de idempotencia", async () => {
    const s = await setup();
    expect((await s.post("/aprobaciones", s.tk("housekeeping"), propuesta)).status).toBe(403);
    expect((await s.post("/aprobaciones", s.tk("accountant"), propuesta)).status).toBe(403);
    for (const bad of [{ accion: "transferencia" }, { resumen: "" }, { porcentaje: undefined }, { porcentaje: 0 }, { porcentaje: 100.5 }, { llaveIdempotencia: "corta" }, { detalle: [] }]) {
      expect((await s.post("/aprobaciones", s.tk("frontdesk"), { ...propuesta, ...bad })).status).toBe(400);
    }
    expect((await s.post("/aprobaciones", s.tk("frontdesk"), { accion: "reembolso", resumen: "Reembolso", llaveIdempotencia: "llave-reembolso-01" })).status).toBe(400);
    expect((await s.post("/aprobaciones", s.tk("frontdesk"), { accion: "mensaje_masivo", resumen: "Aviso", destinatarios: 5, llaveIdempotencia: "llave-masivo-00001" })).status).toBe(400);
  });

  it("repetir la propuesta con la misma llave no duplica la cola; con contenido distinto es 409", async () => {
    const s = await setup();
    const first = (await (await s.post("/aprobaciones", s.tk("frontdesk"), propuesta)).json()) as ApprovalBody;
    const again = (await (await s.post("/aprobaciones", s.tk("frontdesk"), propuesta)).json()) as ApprovalBody;
    expect(again.id).toBe(first.id);
    expect((await s.post("/aprobaciones", s.tk("frontdesk"), { ...propuesta, porcentaje: 11 })).status).toBe(409);
    expect(((await (await s.get("/aprobaciones", s.tk("owner"))).json()) as { aprobaciones: unknown[] }).aprobaciones).toHaveLength(1);
  });

  it("una propuesta que excede un tope duro queda BLOQUEADA y no llega a un humano para aprobar", async () => {
    const s = await setup();
    const res = await s.post("/aprobaciones", s.tk("frontdesk"), { ...propuesta, porcentaje: 30.01 });
    expect(res.status).toBe(200);
    const a = (await res.json()) as ApprovalBody;
    expect(a).toMatchObject({ estado: "bloqueada", motivoBloqueo: "tope_descuento" });
    expect((await s.post(`/aprobaciones/${a.id}/aprobar`, s.tk("owner"), { motivo: "Intento aprobar lo bloqueado" })).status).toBe(409);
  });

  it("maker-checker, rol, motivo y anti-replay en HTTP", async () => {
    const s = await setup();
    const a = (await (await s.post("/aprobaciones", s.tk("gm"), propuesta)).json()) as ApprovalBody;
    expect((await s.post(`/aprobaciones/${a.id}/aprobar`, s.tk("gm"), { motivo: "Me la apruebo yo mismo" })).status).toBe(403);
    expect((await s.post(`/aprobaciones/${a.id}/aprobar`, s.tk("frontdesk"), { motivo: "Sin rol de aprobador" })).status).toBe(403);
    expect((await s.post(`/aprobaciones/${a.id}/aprobar`, s.tk("housekeeping"), { motivo: "Sin acceso al modulo" })).status).toBe(403);
    expect((await s.post(`/aprobaciones/${a.id}/rechazar`, s.tk("owner"), {})).status).toBe(400);
    expect((await s.post(`/aprobaciones/${a.id}/rechazar`, s.tk("owner"), { motivo: "no" })).status).toBe(400);
    expect((await s.post(`/aprobaciones/${a.id}/rechazar`, s.tk("owner"), { motivo: "Rompe la paridad con Booking" })).status).toBe(200);
    expect((await s.post(`/aprobaciones/${a.id}/aprobar`, s.tk("owner"), { motivo: "Reabrir lo rechazado" })).status).toBe(409);
    expect((await s.post(`/aprobaciones/${a.id}/rechazar`, s.tk("gm"), { motivo: "Rechazar dos veces" })).status).toBe(409);
  });

  it("la politica de la accion define quien aprueba (owner siempre)", async () => {
    const s = await setup();
    await s.repo.upsertPolicy(s.ctx.propertyId, "reembolso", { mode: "siempre_humano", autoMaxPercent: null, autoMaxAmountCents: null, expiresMinutes: 1440, approverRoles: ["accountant"] });
    const a = await s.agentPropose({ actionType: "reembolso", percent: null, amountCents: 1000, summary: "Reembolso por cargo duplicado" });
    expect((await s.post(`/aprobaciones/${a.id}/aprobar`, s.tk("gm"), { motivo: "Sin rol en la politica" })).status).toBe(403);
    expect((await s.post(`/aprobaciones/${a.id}/aprobar`, s.tk("accountant"), { motivo: "Conciliado contra el cargo" })).status).toBe(200);
    const b = await s.agentPropose({ actionType: "reembolso", percent: null, amountCents: 2000, summary: "Otro reembolso" });
    expect((await s.post(`/aprobaciones/${b.id}/aprobar`, s.tk("owner"), { motivo: "El dueno siempre puede" })).status).toBe(200);
  });

  it("solicitud vencida: aprobar responde 409 y queda expirada (no aprobada); el cron expira las abiertas", async () => {
    let t = new Date("2026-06-01T12:00:00Z").getTime();
    const s = await setup({ now: () => new Date(t) });
    const a = await s.agentPropose();
    const b = await s.agentPropose();
    t += 1440 * 60_000;
    expect((await s.post(`/aprobaciones/${a.id}/aprobar`, s.tk("owner"), { motivo: "Intento tardio valido" })).status).toBe(409);
    expect((await s.repo.findApproval(s.ctx.propertyId, a.id))?.status).toBe("expirada");
    const results = await runAprobacionesExpiracion(s.deps, new Date(t));
    expect(results.find((r) => r.propertyId === s.ctx.propertyId)).toMatchObject({ expiradas: 1, omitida: null, error: null });
    expect((await s.repo.findApproval(s.ctx.propertyId, b.id))?.status).toBe("expirada");
    expect((await runAprobacionesExpiracion(s.deps, new Date(t))).find((r) => r.propertyId === s.ctx.propertyId)?.expiradas).toBe(0);
  });

  it("detalle: la bitacora solo la ven owner/gm; solicitud de otra property o inexistente 404", async () => {
    const s = await setup();
    const a = await s.agentPropose();
    const asOwner = (await (await s.get(`/aprobaciones/${a.id}`, s.tk("owner"))).json()) as ApprovalBody;
    expect(asOwner.bitacoraVisible).toBe(true);
    expect(asOwner.bitacora?.map((e) => [e.tipo, e.sistema])).toEqual([["propuesta", true]]);
    const asFront = (await (await s.get(`/aprobaciones/${a.id}`, s.tk("frontdesk"))).json()) as ApprovalBody;
    expect(asFront).toMatchObject({ bitacoraVisible: false, bitacora: [] });
    expect((await s.get(`/aprobaciones/${randomUUID()}`, s.tk("owner"))).status).toBe(404);
    expect((await s.get("/aprobaciones/no-es-uuid", s.tk("owner"))).status).toBe(400);
    expect((await s.get("/aprobaciones?estado=inventado", s.tk("owner"))).status).toBe(400);
  });

  it("cancelar: quien propuso u owner/gm, con motivo; una cancelada ya no se aprueba", async () => {
    const s = await setup();
    const a = (await (await s.post("/aprobaciones", s.tk("frontdesk"), propuesta)).json()) as ApprovalBody;
    expect((await s.post(`/aprobaciones/${a.id}/cancelar`, s.tk("reservations"), { motivo: "No es mia pero intento" })).status).toBe(403);
    expect((await s.post(`/aprobaciones/${a.id}/cancelar`, s.tk("frontdesk"), { motivo: "ok" })).status).toBe(400);
    expect((await s.post(`/aprobaciones/${a.id}/cancelar`, s.tk("frontdesk"), { motivo: "Me equivoque de monto" })).status).toBe(200);
    expect((await s.post(`/aprobaciones/${a.id}/aprobar`, s.tk("owner"), { motivo: "Aprobar una cancelada" })).status).toBe(409);
  });
});

describe("ejecutar una solicitud aprobada (UNA sola vez)", () => {
  async function approved(s: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) {
    const a = await s.agentPropose(over);
    expect((await s.post(`/aprobaciones/${a.id}/aprobar`, s.tk("owner"), { motivo: "Aprobada para ejecutar" })).status).toBe(200);
    return a;
  }

  it("NUNCA ejecuta sin aprobacion: pendiente, rechazada y bloqueada -> 409; roles sin permiso 403", async () => {
    const s = await setup();
    const pend = await s.agentPropose();
    const rech = await s.agentPropose();
    await s.post(`/aprobaciones/${rech.id}/rechazar`, s.tk("owner"), { motivo: "No procede por ahora" });
    const bloq = await s.agentPropose({ percent: 90 });
    for (const id of [pend.id, rech.id, bloq.id]) expect((await s.post(`/aprobaciones/${id}/ejecutar`, s.tk("owner"), { referencia: "tarifa-123" })).status).toBe(409);
    const ok = await approved(s);
    expect((await s.post(`/aprobaciones/${ok.id}/ejecutar`, s.tk("frontdesk"), { referencia: "tarifa-123" })).status).toBe(403);
    expect((await s.repo.findApproval(s.ctx.propertyId, pend.id))?.executedAt).toBeNull();
  });

  it("ejecuta una vez con referencia obligatoria; el segundo intento (replay) es 409", async () => {
    const s = await setup();
    const a = await approved(s);
    expect((await s.post(`/aprobaciones/${a.id}/ejecutar`, s.tk("owner"), {})).status).toBe(400);
    expect((await s.post(`/aprobaciones/${a.id}/ejecutar`, s.tk("owner"), { referencia: "abc" })).status).toBe(400);
    const done = (await (await s.post(`/aprobaciones/${a.id}/ejecutar`, s.tk("owner"), { referencia: "tarifa-123" })).json()) as ApprovalBody;
    expect(done).toMatchObject({ estado: "ejecutada", referenciaEjecucion: "tarifa-123" });
    expect((await s.post(`/aprobaciones/${a.id}/ejecutar`, s.tk("owner"), { referencia: "tarifa-123" })).status).toBe(409);
    expect((await s.post(`/aprobaciones/${a.id}/ejecutar`, s.tk("gm"), { referencia: "otra-ref-99" })).status).toBe(409);
  });

  it("mensaje masivo fuera de horario: no se ejecuta (409) y sigue aprobada para reintentar dentro de la ventana", async () => {
    // 14:00Z = 08:00 en America/Mexico_City (dentro); 13:00Z = 07:00 (fuera). El reloj de la app es el del repo.
    let t = new Date("2026-03-10T13:00:00Z").getTime();
    const s = await setup({ now: () => new Date(t) });
    const a = await approved(s, { actionType: "mensaje_masivo", percent: null, recipients: 10, contentText: "Aviso de corte de agua" });
    expect((await s.post(`/aprobaciones/${a.id}/ejecutar`, s.tk("owner"), { referencia: "envio-masivo-1" })).status).toBe(409);
    expect((await s.repo.findApproval(s.ctx.propertyId, a.id))?.status).toBe("aprobada");
    t = new Date("2026-03-10T14:00:00Z").getTime();
    expect((await s.post(`/aprobaciones/${a.id}/ejecutar`, s.tk("owner"), { referencia: "envio-masivo-1" })).status).toBe(200);
  });

  it("respuesta a una resena: al ejecutar se registra la respuesta real (en la misma transaccion) y no se repite", async () => {
    const s = await setup();
    const review = await s.ctx.hotelesRepo.insertGuestReview({
      organizationId: s.ctx.organizationId, propertyId: s.ctx.propertyId, guestId: null, folioId: null, source: "google", externalId: randomUUID(),
      texto: "El aire acondicionado no funciona", idioma: "es", calificacion: 2, stayState: "post_estancia", isPublic: true,
      topics: [{ topic: "aire_acondicionado", esConocido: true, menciones: 1, palabrasClave: [] }], sentiment: "negativo", sentimentScore: -0.6, createdBy: null,
    });
    const a = await approved(s, { agentKey: "reputacion", actionType: "respuesta_resena", percent: null, contentText: "Lamentamos lo ocurrido, ya lo atendimos.", payload: { resenaId: review.id }, summary: "Respuesta a resena" });
    const done = await s.post(`/aprobaciones/${a.id}/ejecutar`, s.tk("owner"), {});
    expect(done.status).toBe(200);
    const responses = await s.ctx.hotelesRepo.listGuestReviewResponses(s.ctx.propertyId, review.id);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ texto: "Lamentamos lo ocurrido, ya lo atendimos.", createdBy: s.ctx.staff.owner.id });
    expect((await s.post(`/aprobaciones/${a.id}/ejecutar`, s.tk("owner"), {})).status).toBe(409);
    expect(await s.ctx.hotelesRepo.listGuestReviewResponses(s.ctx.propertyId, review.id)).toHaveLength(1);
  });

  it("respuesta a una resena sin resenaId valido o inexistente: no se consume (la aprobacion sigue disponible)", async () => {
    const s = await setup();
    const sinId = await approved(s, { agentKey: "reputacion", actionType: "respuesta_resena", percent: null, contentText: "Gracias por su comentario", payload: {}, summary: "Respuesta" });
    expect((await s.post(`/aprobaciones/${sinId.id}/ejecutar`, s.tk("owner"), {})).status).toBe(400);
    const inexistente = await approved(s, { agentKey: "reputacion", actionType: "respuesta_resena", percent: null, contentText: "Gracias por su comentario", payload: { resenaId: randomUUID() }, summary: "Respuesta" });
    expect((await s.post(`/aprobaciones/${inexistente.id}/ejecutar`, s.tk("owner"), {})).status).toBe(409);
    expect((await s.repo.findApproval(s.ctx.propertyId, inexistente.id))?.status).toBe("aprobada");
  });
});

describe("cron de expiracion (/internal/hoteles/aprobaciones-expiracion)", () => {
  it("exige el secreto interno; con el secreto corre y reporta; sin la migracion 035 omite la property sin fallar", async () => {
    const s = await setup();
    const url = "/internal/hoteles/aprobaciones-expiracion";
    expect((await s.app.request(url, { method: "POST" })).status).toBe(401);
    const ok = await s.app.request(url, { method: "POST", headers: { "x-atiende-internal-secret": s.ctx.deps.env.internalSecret } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true });
    const old = await setup({ migrated: false });
    const res = await old.app.request(url, { method: "POST", headers: { "x-atiende-internal-secret": old.ctx.deps.env.internalSecret } });
    const body = (await res.json()) as { ok: boolean; corridas: { omitida: string | null; error: string | null }[] };
    expect(body.ok).toBe(true);
    expect(body.corridas.every((r) => r.omitida === "migracion_pendiente" && r.error === null)).toBe(true);
  });
});
