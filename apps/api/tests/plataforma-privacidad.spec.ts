// PL-13 -- privacidad de plataforma: vista de superadmin (solo lectura), vista y administracion por
// organizacion (owner/admin), y el endpoint interno de purga por retencion (NO programado). HTTP real via
// app.request con el repositorio en memoria (misma semantica de acceso que el SQL de 0036). Cubre
// autenticacion, roles, cross-tenant, plazos, validacion, bloqueo previo a purga y la base sin migrar
// (disponible:false / 503, nunca un 500).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryPlataformaPrivacidadRepository, PostgresPlataformaPrivacidadRepository } from "@atiende/db";
import type { ArcoRequestRow } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import { createPlatformSwitchGuard } from "../src/platform-switches.ts";
import type { AppDeps } from "../src/deps.ts";
import { plazoDe } from "../src/privacidad/plazos.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";

const DIA = 86_400_000;
const ORG_B = "00000000-0000-0000-0000-0000000000b2";
const SECRET = "test-internal-secret";

function fila(over: Partial<ArcoRequestRow> & { requestId: string }): Omit<ArcoRequestRow, "organizationId" | "organizationName"> {
  const now = Date.now();
  return {
    vertical: "citas",
    rightType: "acceso",
    channel: "whatsapp",
    nativeStatus: "recibida",
    statusBucket: "abierta",
    openedAtMs: now - 3 * DIA,
    responseDueAtMs: now + 17 * DIA,
    executionDueAtMs: null,
    dueAtMs: now + 17 * DIA,
    resolvedAtMs: null,
    isOpen: true,
    isOverdue: false,
    ...over,
  };
}

async function construir(opciones: { migrado?: boolean; sinRepo?: boolean } = {}) {
  const s = await seguridadSetup();
  const repo = new InMemoryPlataformaPrivacidadRepository({ migrado: opciones.migrado ?? true });
  const orgA = s.base.organizationId;
  const deps: AppDeps = opciones.sinRepo ? s.deps : { ...s.deps, privacidadPlataformaRepo: () => repo };
  const app = buildApp(deps);
  const sa = await s.superadmin();
  repo.seedSuperadmin(sa.id);
  const tokenOrg = (userId: string, org = orgA) => signAccessToken({ sub: userId, org_id: org, vertical: "restaurantes", property_ids: null, email: `${userId}@example.com` }, deps.env.jwtSecret, deps.env.accessTokenTtlSeconds);
  const admin = randomUUID();
  const member = randomUUID();
  repo.seedOrgAdmin(orgA, admin);
  const adminB = randomUUID();
  repo.seedOrgAdmin(ORG_B, adminB);
  const adminToken = await tokenOrg(admin);
  const memberToken = await tokenOrg(member);
  repo.seedArco(orgA, fila({ requestId: "11111111-1111-4111-8111-111111111111" }), "Org A");
  repo.seedArco(orgA, fila({ requestId: "22222222-2222-4222-8222-222222222222", vertical: "hoteles", responseDueAtMs: Date.now() - 2 * DIA, dueAtMs: Date.now() - 2 * DIA, isOverdue: true }), "Org A");
  repo.seedArco(orgA, fila({ requestId: "33333333-3333-4333-8333-333333333333", vertical: "restaurantes", nativeStatus: "resuelta", statusBucket: "resuelta", isOpen: false, dueAtMs: null, resolvedAtMs: Date.now() }), "Org A");
  repo.seedArco(ORG_B, fila({ requestId: "44444444-4444-4444-8444-444444444444" }), "Org B");
  const get = (path: string, token: string, userId?: string) => {
    if (userId) repo.as(userId);
    return app.request(path, { headers: bearer(token) });
  };
  const send = (method: string, path: string, token: string, userId: string, body: unknown = {}) => {
    repo.as(userId);
    return app.request(path, { ...jsonRequestInit(body, bearer(token)), method });
  };
  return { s, repo, deps, app, sa, orgA, admin, member, adminB, adminToken, memberToken, get, send, tokenOrg };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe("plazoDe", () => {
  const now = Date.UTC(2026, 8, 1);
  it("clasifica vencida, por vencer, en plazo, sin plazo y cerrada", () => {
    expect(plazoDe({ isOpen: true, dueAtMs: now - DIA / 2 }, now)).toMatchObject({ estado: "vencida", diasRestantes: 0 });
    expect(plazoDe({ isOpen: true, dueAtMs: now - 3 * DIA }, now)).toMatchObject({ estado: "vencida", diasRestantes: -3 });
    expect(plazoDe({ isOpen: true, dueAtMs: now + 5 * DIA }, now)).toMatchObject({ estado: "por_vencer", diasRestantes: 5 });
    expect(plazoDe({ isOpen: true, dueAtMs: now + 5 * DIA + 1 }, now)).toMatchObject({ estado: "en_plazo" });
    expect(plazoDe({ isOpen: true, dueAtMs: now }, now)).toMatchObject({ estado: "por_vencer", diasRestantes: 0 });
    expect(plazoDe({ isOpen: true, dueAtMs: null }, now)).toEqual({ estado: "sin_plazo", diasRestantes: null, venceEnMs: null });
    expect(plazoDe({ isOpen: false, dueAtMs: now + DIA }, now)).toEqual({ estado: "cerrada", diasRestantes: null, venceEnMs: null });
  });
});

describe("GET /superadmin/privacidad/*", () => {
  it("exige token (401) y rechaza a staff que no es superadmin (403)", async () => {
    const t = await construir();
    for (const p of ["resumen", "arco", "purgas"]) {
      expect((await t.app.request(`/superadmin/privacidad/${p}`)).status).toBe(401);
      expect((await t.app.request(`/superadmin/privacidad/${p}`, { headers: bearer(t.adminToken) })).status).toBe(403);
    }
  });

  it("el superadmin ve las solicitudes de TODAS las organizaciones con plazos, sin datos del titular", async () => {
    const t = await construir();
    const res = await t.get("/superadmin/privacidad/arco", (await t.s.superadmin()).token, t.sa.id);
    // el repo valida al superadmin sembrado: se usa su token
    const ok = await t.get("/superadmin/privacidad/arco", t.sa.token, t.sa.id);
    expect(res.status).toBe(200);
    expect(ok.status).toBe(200);
    const body: Json = await ok.json();
    expect(body).toMatchObject({ disponible: true, total: 4, plazos: { respuestaDias: 20, ejecucionDias: 15, porVencerDias: 5 } });
    const vencida = body.solicitudes.find((r: Json) => r.id.startsWith("2222"));
    expect(vencida).toMatchObject({ vertical: "hoteles", organizacion: "Org A", abierta: true, plazo: { estado: "vencida", diasRestantes: -2 }, referencia: "22222222" });
    const cerrada = body.solicitudes.find((r: Json) => r.id.startsWith("3333"));
    expect(cerrada.plazo.estado).toBe("cerrada");
    expect(JSON.stringify(body)).not.toMatch(/phone|telefono|tel[eé]fono|contacto|contact|correo|requester|solicitante/iu);
    expect(new Set(body.solicitudes.map((r: Json) => r.organizacion))).toEqual(new Set(["Org A", "Org B"]));
  });

  it("filtros abiertas=1 y vencidas=1", async () => {
    const t = await construir();
    const abiertas: Json = await (await t.get("/superadmin/privacidad/arco?abiertas=1", t.sa.token, t.sa.id)).json();
    expect(abiertas.total).toBe(3);
    const vencidas: Json = await (await t.get("/superadmin/privacidad/arco?vencidas=1", t.sa.token, t.sa.id)).json();
    expect(vencidas.solicitudes.map((r: Json) => r.referencia)).toEqual(["22222222"]);
  });

  it("validacion de parametros: limite no numerico o 0 -> 400", async () => {
    const t = await construir();
    expect((await t.get("/superadmin/privacidad/arco?limite=abc", t.sa.token, t.sa.id)).status).toBe(400);
    expect((await t.get("/superadmin/privacidad/arco?limite=0", t.sa.token, t.sa.id)).status).toBe(400);
    expect((await t.get("/superadmin/privacidad/purgas?antesDeSeq=-1", t.sa.token, t.sa.id)).status).toBe(400);
    expect((await t.get("/superadmin/privacidad/resumen?desde=x", t.sa.token, t.sa.id)).status).toBe(400);
  });

  it("resumen por organizacion con vencidas, aviso, bloqueos y ultima purga", async () => {
    const t = await construir();
    t.repo.as(t.admin);
    await t.repo.orgPlaceHold(t.orgA, null, "Retencion legal por requerimiento");
    await t.repo.orgPublishNotice(t.orgA, "Aviso de privacidad", "Resumen del aviso de privacidad", "https://ejemplo.mx/aviso");
    await t.repo.runRetentionPurge(t.orgA, "restaurantes_whatsapp_conversaciones", false, 500);
    const body: Json = await (await t.get("/superadmin/privacidad/resumen", t.sa.token, t.sa.id)).json();
    expect(body.disponible).toBe(true);
    const a = body.organizaciones.find((o: Json) => o.organizacionId === t.orgA);
    expect(a).toMatchObject({ arcoAbiertas: 2, arcoVencidas: 1, avisoVersion: 1, avisoAceptaciones: 1, bloqueosActivos: 1, ultimaPurgaEstado: "bloqueada" });
    // las organizaciones se ordenan con las vencidas primero (aqui la A es la unica con vencidas)
    expect(body.organizaciones[0].organizacionId).toBeDefined();
  });

  it("purgas: registro global paginado", async () => {
    const t = await construir();
    for (let i = 0; i < 3; i++) await t.repo.runRetentionPurge(t.orgA, "restaurantes_voz_transcripciones", true, 10);
    const body: Json = await (await t.get("/superadmin/privacidad/purgas?limite=2", t.sa.token, t.sa.id)).json();
    expect(body.purgas.map((p: Json) => p.seq)).toEqual([3, 2]);
    expect(body.siguienteAntesDeSeq).toBe(2);
    expect(body.purgas[0]).toMatchObject({ estado: "simulacion", claseDato: "restaurantes_voz_transcripciones" });
    const sig: Json = await (await t.get("/superadmin/privacidad/purgas?limite=2&antesDeSeq=2", t.sa.token, t.sa.id)).json();
    expect(sig.purgas.map((p: Json) => p.seq)).toEqual([1]);
    expect(sig.siguienteAntesDeSeq).toBeNull();
  });

  it("un superadmin con otra sesion en el repo (caller-binding) recibe listas vacias, no datos", async () => {
    const t = await construir();
    const body: Json = await (await t.get("/superadmin/privacidad/arco", t.sa.token, randomUUID())).json();
    expect(body.total).toBe(0);
    expect(body.solicitudes).toEqual([]);
  });

  it("base sin migrar o repo ausente: disponible:false con mensaje (200), nunca 500", async () => {
    for (const opciones of [{ migrado: false }, { sinRepo: true }]) {
      const t = await construir(opciones);
      for (const p of ["resumen", "arco", "purgas"]) {
        const res = await t.get(`/superadmin/privacidad/${p}`, t.sa.token, t.sa.id);
        expect(res.status).toBe(200);
        const body: Json = await res.json();
        expect(body.disponible).toBe(false);
        expect(body.mensaje).toMatch(/0036_plataforma_arco_retencion_aviso/);
      }
    }
  });
});

describe("GET /v1/privacidad/resumen y /arco (por organizacion)", () => {
  it("exige token (401)", async () => {
    const t = await construir();
    expect((await t.app.request("/v1/privacidad/resumen")).status).toBe(401);
    expect((await t.app.request("/v1/privacidad/arco")).status).toBe(401);
  });

  it("quien no es owner/admin recibe 403 (no una lista vacia que parezca real)", async () => {
    const t = await construir();
    expect((await t.get("/v1/privacidad/resumen", t.memberToken, t.member)).status).toBe(403);
  });

  it("el admin ve SOLO las solicitudes de su organizacion (cross-tenant) con el catalogo de retencion y los plazos", async () => {
    const t = await construir();
    const res = await t.get("/v1/privacidad/resumen", t.adminToken, t.admin);
    expect(res.status).toBe(200);
    const body: Json = await res.json();
    expect(body.disponible).toBe(true);
    expect(body.arco.total).toBe(3);
    expect(body.arco.solicitudes.map((r: Json) => r.referencia).sort()).toEqual(["11111111", "22222222", "33333333"]);
    expect(body.arco.solicitudes.every((r: Json) => r.organizacionId === undefined)).toBe(true);
    expect(body.retencion.map((r: Json) => [r.claseDato, r.defectoDias, r.diasEfectivos, r.origen, r.ejecuta])).toEqual([
      ["restaurantes_whatsapp_conversaciones", 180, 180, "defecto", "plataforma"],
      ["restaurantes_voz_transcripciones", 30, 30, "defecto", "plataforma"],
      ["hoteles_identidad_documento", 30, 30, "defecto", "vertical"],
    ]);
    expect(JSON.stringify(body)).not.toMatch(/phone|telefono|contacto|requester/iu);
  });

  it("un admin de OTRA organizacion con un token de la organizacion A no ve nada (el SQL valida membresia)", async () => {
    const t = await construir();
    const res = await t.get("/v1/privacidad/resumen", await t.tokenOrg(t.adminB), t.adminB);
    expect(res.status).toBe(403);
  });

  it("paginacion y filtro soloAbiertas", async () => {
    const t = await construir();
    const body: Json = await (await t.get("/v1/privacidad/arco?soloAbiertas=1&limite=1", t.adminToken, t.admin)).json();
    expect(body.total).toBe(2);
    expect(body.solicitudes).toHaveLength(1);
    expect((await t.get("/v1/privacidad/arco?limite=0", t.adminToken, t.admin)).status).toBe(400);
  });
});

describe("retencion por organizacion", () => {
  const WA = "restaurantes_whatsapp_conversaciones";

  it("fija, refleja y restablece la politica", async () => {
    const t = await construir();
    const put = await t.send("PUT", `/v1/privacidad/retencion/${WA}`, t.adminToken, t.admin, { dias: 90 });
    expect(put.status).toBe(200);
    const resumen: Json = await (await t.get("/v1/privacidad/resumen", t.adminToken, t.admin)).json();
    expect(resumen.retencion.find((r: Json) => r.claseDato === WA)).toMatchObject({ diasEfectivos: 90, origen: "organizacion" });
    const del = await t.send("DELETE", `/v1/privacidad/retencion/${WA}`, t.adminToken, t.admin);
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ restablecida: true });
    const otra: Json = await (await t.get("/v1/privacidad/resumen", t.adminToken, t.admin)).json();
    expect(otra.retencion.find((r: Json) => r.claseDato === WA)).toMatchObject({ diasEfectivos: 180, origen: "defecto" });
  });

  it("bordes: minimo, maximo, clase del vertical, clase desconocida, tipo y formato", async () => {
    const t = await construir();
    const put = (clase: string, body: unknown) => t.send("PUT", `/v1/privacidad/retencion/${clase}`, t.adminToken, t.admin, body);
    expect((await put(WA, { dias: 29 })).status).toBe(400);
    expect((await put(WA, { dias: 30 })).status).toBe(200);
    expect((await put(WA, { dias: 1095 })).status).toBe(200);
    expect((await put(WA, { dias: 1096 })).status).toBe(400);
    expect((await put("restaurantes_voz_transcripciones", { dias: 0 })).status).toBe(200);
    expect((await put("hoteles_identidad_documento", { dias: 30 })).status).toBe(400);
    expect((await put("no_existe", { dias: 30 })).status).toBe(400);
    expect((await put(WA, { dias: "90" })).status).toBe(400);
    expect((await put(WA, { dias: 1.5 })).status).toBe(400);
    expect((await put(WA, { dias: -1 })).status).toBe(400);
    expect((await put("Clase-Invalida", { dias: 30 })).status).toBe(400);
  });

  it("member recibe 403 al escribir; sin token 401", async () => {
    const t = await construir();
    expect((await t.send("PUT", `/v1/privacidad/retencion/${WA}`, t.memberToken, t.member, { dias: 90 })).status).toBe(403);
    expect((await t.send("DELETE", `/v1/privacidad/retencion/${WA}`, t.memberToken, t.member)).status).toBe(403);
    t.repo.as(t.admin);
    expect((await t.app.request(`/v1/privacidad/retencion/${WA}`, { ...jsonRequestInit({ dias: 90 }), method: "PUT" })).status).toBe(401);
  });

  it("base sin migrar: lectura disponible:false y escritura 503", async () => {
    const t = await construir({ migrado: false });
    const lectura: Json = await (await t.get("/v1/privacidad/resumen", t.adminToken, t.admin)).json();
    expect(lectura.disponible).toBe(false);
    expect((await t.send("PUT", `/v1/privacidad/retencion/${WA}`, t.adminToken, t.admin, { dias: 90 })).status).toBe(503);
    const sin = await construir({ sinRepo: true });
    expect((await sin.send("PUT", `/v1/privacidad/retencion/${WA}`, sin.adminToken, sin.admin, { dias: 90 })).status).toBe(503);
    expect((await sin.get("/v1/privacidad/resumen", sin.adminToken, sin.admin)).status).toBe(200);
  });
});

describe("bloqueo previo a purga", () => {
  it("coloca, duplica (409), valida el motivo, libera y no libera dos veces (404)", async () => {
    const t = await construir();
    const post = (body: unknown) => t.send("POST", "/v1/privacidad/bloqueos", t.adminToken, t.admin, body);
    expect((await post({ claseDato: "restaurantes_voz_transcripciones", motivo: "corto" })).status).toBe(400);
    expect((await post({ claseDato: "Mala-Clase", motivo: "Motivo suficientemente largo" })).status).toBe(400);
    expect((await post({ claseDato: "no_existe", motivo: "Motivo suficientemente largo" })).status).toBe(400);
    const ok = await post({ claseDato: "restaurantes_voz_transcripciones", motivo: "Requerimiento de autoridad en curso" });
    expect(ok.status).toBe(201);
    const { id } = (await ok.json()) as { id: string };
    expect((await post({ claseDato: "restaurantes_voz_transcripciones", motivo: "Otro motivo suficientemente largo" })).status).toBe(409);
    const resumen: Json = await (await t.get("/v1/privacidad/resumen", t.adminToken, t.admin)).json();
    expect(resumen.bloqueos).toEqual([expect.objectContaining({ id, claseDato: "restaurantes_voz_transcripciones", activo: true })]);
    const rel = (hid: string) => t.send("POST", `/v1/privacidad/bloqueos/${hid}/liberar`, t.adminToken, t.admin, { nota: "Caso cerrado" });
    expect((await rel("no-es-uuid")).status).toBe(400);
    expect((await rel(randomUUID())).status).toBe(404);
    expect((await rel(id)).status).toBe(200);
    expect((await rel(id)).status).toBe(404);
  });

  it("member no coloca ni libera (403)", async () => {
    const t = await construir();
    expect((await t.send("POST", "/v1/privacidad/bloqueos", t.memberToken, t.member, { claseDato: null, motivo: "Requerimiento de autoridad en curso" })).status).toBe(403);
    expect((await t.send("POST", `/v1/privacidad/bloqueos/${randomUUID()}/liberar`, t.memberToken, t.member, {})).status).toBe(403);
  });

  it("un bloqueo sin clase detiene la purga de TODAS las clases de la organizacion", async () => {
    const t = await construir();
    await t.send("POST", "/v1/privacidad/bloqueos", t.adminToken, t.admin, { claseDato: null, motivo: "Requerimiento de autoridad en curso" });
    for (const clase of ["restaurantes_whatsapp_conversaciones", "restaurantes_voz_transcripciones"]) {
      expect((await t.repo.runRetentionPurge(t.orgA, clase, false, 500)).result?.status).toBe("bloqueada");
    }
  });
});

describe("aviso de privacidad versionado", () => {
  const aviso = { titulo: "Aviso de privacidad", resumen: "Usamos tus datos para atender tu pedido.", url: "https://ejemplo.mx/aviso" };

  it("publica versiones, registra la aceptacion de quien publica y valida", async () => {
    const t = await construir();
    const r1 = await t.send("POST", "/v1/privacidad/avisos", t.adminToken, t.admin, aviso);
    expect(r1.status).toBe(201);
    expect(await r1.json()).toEqual({ version: 1 });
    expect(await (await t.send("POST", "/v1/privacidad/avisos", t.adminToken, t.admin, aviso)).json()).toEqual({ version: 2 });
    const resumen: Json = await (await t.get("/v1/privacidad/resumen", t.adminToken, t.admin)).json();
    expect(resumen.avisos.map((a: Json) => [a.version, a.vigente, a.aceptaciones, a.aceptadoPorMi])).toEqual([
      [2, true, 1, true],
      [1, false, 1, true],
    ]);
    expect((await t.send("POST", "/v1/privacidad/avisos", t.adminToken, t.admin, { ...aviso, url: "http://ejemplo.mx/a" })).status).toBe(400);
    expect((await t.send("POST", "/v1/privacidad/avisos", t.adminToken, t.admin, { ...aviso, titulo: "ab" })).status).toBe(400);
    expect((await t.send("POST", "/v1/privacidad/avisos", t.adminToken, t.admin, { ...aviso, resumen: 5 })).status).toBe(400);
    expect((await t.send("POST", "/v1/privacidad/avisos", t.memberToken, t.member, aviso)).status).toBe(403);
  });

  it("otro admin acepta la version vigente una sola vez; una vieja o inexistente da 400", async () => {
    const t = await construir();
    const admin2 = randomUUID();
    t.repo.seedOrgAdmin(t.orgA, admin2);
    const token2 = await t.tokenOrg(admin2);
    await t.send("POST", "/v1/privacidad/avisos", t.adminToken, t.admin, aviso);
    await t.send("POST", "/v1/privacidad/avisos", t.adminToken, t.admin, aviso);
    expect((await t.send("POST", "/v1/privacidad/avisos/1/aceptar", token2, admin2)).status).toBe(400);
    expect((await t.send("POST", "/v1/privacidad/avisos/9/aceptar", token2, admin2)).status).toBe(400);
    expect((await t.send("POST", "/v1/privacidad/avisos/x/aceptar", token2, admin2)).status).toBe(400);
    expect(await (await t.send("POST", "/v1/privacidad/avisos/2/aceptar", token2, admin2)).json()).toMatchObject({ aceptada: true });
    expect(await (await t.send("POST", "/v1/privacidad/avisos/2/aceptar", token2, admin2)).json()).toMatchObject({ aceptada: false, yaAceptadaPorTi: true });
    expect((await t.send("POST", "/v1/privacidad/avisos/2/aceptar", t.memberToken, t.member)).status).toBe(403);
  });
});

describe("/internal/plataforma/privacidad-retencion", () => {
  const PATH = "/internal/plataforma/privacidad-retencion";
  const llamar = (app: ReturnType<typeof buildApp>, qs = "", headers: Record<string, string> = { "x-atiende-internal-secret": SECRET }) => app.request(`${PATH}${qs}`, { headers, method: qs.includes("ejecutar=1") ? "POST" : "GET" });

  it("exige el secreto interno (401), acepta tambien Bearer de cron", async () => {
    const t = await construir();
    expect((await t.app.request(PATH)).status).toBe(401);
    expect((await llamar(t.app, "", { "x-atiende-internal-secret": "otro" })).status).toBe(401);
    expect((await llamar(t.app, "", { authorization: `Bearer ${SECRET}` })).status).toBe(200);
  });

  it("SIMULA por defecto y solo purga con ejecutar=1; cada llamada queda registrada", async () => {
    const t = await construir();
    t.repo.seedPurgeOrg(t.orgA);
    const sim: Json = await (await llamar(t.app)).json();
    expect(sim).toMatchObject({ ok: true, disponible: true, modo: "simulacion", unidades: 2, errores: 0, bloqueadas: 0 });
    expect(sim.resultados.map((r: Json) => r.estado)).toEqual(["simulacion", "simulacion"]);
    const real: Json = await (await llamar(t.app, "?ejecutar=1")).json();
    expect(real).toMatchObject({ modo: "ejecucion", unidades: 2 });
    expect(real.resultados.map((r: Json) => r.estado)).toEqual(["ok", "ok"]);
    expect(t.repo.purgeRuns()).toHaveLength(4);
  });

  it("GET con ejecutar=1 se rechaza (400) y no purga nada; la purga real exige POST", async () => {
    const t = await construir();
    t.repo.seedPurgeOrg(t.orgA);
    const res = await t.app.request(`${PATH}?ejecutar=1`, { headers: { "x-atiende-internal-secret": SECRET } });
    expect(res.status).toBe(400);
    expect(t.repo.purgeRuns()).toHaveLength(0);
  });

  it("un bloqueo activo se refleja como bloqueada y no se purga esa clase", async () => {
    const t = await construir();
    t.repo.seedPurgeOrg(t.orgA);
    t.repo.as(t.admin);
    await t.repo.orgPlaceHold(t.orgA, "restaurantes_voz_transcripciones", "Retencion legal por requerimiento");
    const body: Json = await (await llamar(t.app, "?ejecutar=1")).json();
    expect(body.bloqueadas).toBe(1);
    expect(body.resultados.map((r: Json) => [r.claseDato, r.estado])).toEqual([
      ["restaurantes_whatsapp_conversaciones", "ok"],
      ["restaurantes_voz_transcripciones", "bloqueada"],
    ]);
  });

  it("recorre por paginas de organizaciones con cursor y permite acotar a una organizacion", async () => {
    const t = await construir();
    const ids = Array.from({ length: 30 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
    for (const id of ids) t.repo.seedPurgeOrg(id);
    const p1: Json = await (await llamar(t.app)).json();
    expect(p1.unidades).toBe(50);
    expect(p1.siguienteDespuesDe).toBe(ids[24]);
    const p2: Json = await (await llamar(t.app, `?despuesDe=${p1.siguienteDespuesDe}`)).json();
    expect(p2.unidades).toBe(10);
    expect(p2.siguienteDespuesDe).toBeNull();
    const una: Json = await (await llamar(t.app, `?organizationId=${ids[3]}`)).json();
    expect(una.unidades).toBe(2);
    expect(una.resultados.every((r: Json) => r.organizationId === ids[3])).toBe(true);
  });

  it("validacion: UUID invalido y limite invalido -> 400", async () => {
    const t = await construir();
    expect((await llamar(t.app, "?organizationId=xyz")).status).toBe(400);
    expect((await llamar(t.app, "?despuesDe=xyz")).status).toBe(400);
    expect((await llamar(t.app, "?limite=0")).status).toBe(400);
    expect((await llamar(t.app, "?limite=abc")).status).toBe(400);
  });

  it("una unidad que falla no detiene a las demas y corre en SU PROPIA transaccion (sistema)", async () => {
    const t = await construir();
    const [o1, o2] = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    t.repo.seedPurgeOrg(o1);
    t.repo.seedPurgeOrg(o2);
    const original = t.repo.runRetentionPurge.bind(t.repo);
    t.repo.runRetentionPurge = async (org, clase, dry, limit) => {
      if (org === o1 && clase === "restaurantes_voz_transcripciones") throw new Error("fallo simulado de base");
      return original(org, clase, dry, limit);
    };
    const sesiones: Array<string | null> = [];
    const engine = t.deps.engine;
    const deps: AppDeps = {
      ...t.deps,
      engine: { withAppSession: (claims, fn) => (sesiones.push(claims.userId), engine.withAppSession(claims, fn)) },
    };
    const body: Json = await (await llamar(buildApp(deps), "?ejecutar=1")).json();
    expect(body).toMatchObject({ unidades: 4, errores: 1 });
    expect(body.resultados.find((r: Json) => r.estado === "error")).toMatchObject({ organizationId: o1, claseDato: "restaurantes_voz_transcripciones", error: "fallo_inesperado" });
    expect(body.resultados.filter((r: Json) => r.estado === "ok")).toHaveLength(3);
    // 1 lote de la purga de datos de salud de citas (QA R1 citas 07) + 1 lectura de objetivos + 1 transaccion por unidad + 1 de la
    // bitacora de corrida (withHeartbeat, PL-35), todas de sistema.
    expect(sesiones).toEqual([null, null, null, null, null, null, null]);
    expect(JSON.stringify(body)).not.toMatch(/fallo simulado/);
  });

  describe("PL-35: agendado por Vercel Cron (GET con Authorization: Bearer)", () => {
    const CRON = { authorization: `Bearer ${SECRET}` };
    const ejecuciones = (t: Awaited<ReturnType<typeof construir>>) => t.repo.purgeRuns();

    it("GET con Bearer purga de verdad (modo ejecucion) y deja cada corrida registrada", async () => {
      const t = await construir();
      t.repo.seedPurgeOrg(t.orgA);
      const body: Json = await (await t.app.request(PATH, { headers: CRON })).json();
      expect(body).toMatchObject({ ok: true, disponible: true, modo: "ejecucion", unidades: 2, errores: 0 });
      expect(body.resultados.map((r: Json) => r.estado)).toEqual(["ok", "ok"]);
      expect(ejecuciones(t)).toHaveLength(2);
    });

    it("GET SIN Bearer nunca purga: con el secreto en x-atiende-internal-secret solo SIMULA, y por query no autentica", async () => {
      const t = await construir();
      t.repo.seedPurgeOrg(t.orgA);
      const sim: Json = await (await t.app.request(PATH, { headers: { "x-atiende-internal-secret": SECRET } })).json();
      expect(sim).toMatchObject({ modo: "simulacion" });
      expect(sim.resultados.map((r: Json) => r.estado)).toEqual(["simulacion", "simulacion"]);
      expect((await t.app.request(`${PATH}?secret=${SECRET}&token=${SECRET}`)).status).toBe(401);
      expect((await t.app.request(PATH, { headers: { authorization: "Bearer incorrecto" } })).status).toBe(401);
      expect((await t.app.request(PATH, { headers: { authorization: `Basic ${SECRET}` } })).status).toBe(401);
    });

    it("GET con ejecutar=1 sin Bearer sigue rechazandose (400); con ejecutar=0 y Bearer simula", async () => {
      const t = await construir();
      t.repo.seedPurgeOrg(t.orgA);
      expect((await t.app.request(`${PATH}?ejecutar=1`, { headers: { "x-atiende-internal-secret": SECRET } })).status).toBe(400);
      const sim: Json = await (await t.app.request(`${PATH}?ejecutar=0`, { headers: CRON })).json();
      expect(sim.modo).toBe("simulacion");
      expect(sim.resultados.map((r: Json) => r.estado)).toEqual(["simulacion", "simulacion"]);
    });

    it("POST sin ejecutar=1 sigue simulando aunque traiga Bearer (el cron es solo GET)", async () => {
      const t = await construir();
      t.repo.seedPurgeOrg(t.orgA);
      const body: Json = await (await t.app.request(PATH, { method: "POST", headers: CRON })).json();
      expect(body.modo).toBe("simulacion");
    });

    it("respeta el interruptor APAGADO: no purga nada y responde skipped kill_switch", async () => {
      const t = await construir();
      t.repo.seedPurgeOrg(t.orgA);
      const guard = createPlatformSwitchGuard(async () => [{ scope: "cron", target: PATH }]);
      const app = buildApp({ ...t.deps, platformSwitchGuard: guard });
      const body: Json = await (await app.request(PATH, { headers: CRON })).json();
      expect(body).toMatchObject({ ok: true, skipped: "kill_switch" });
      expect(ejecuciones(t)).toHaveLength(0);
    });

    it("lote acotado: una corrida de cron recorre hasta 4 paginas (100 organizaciones) y devuelve el cursor del resto", async () => {
      const t = await construir();
      const ids = Array.from({ length: 110 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
      for (const id of ids) t.repo.seedPurgeOrg(id);
      const corrida1: Json = await (await t.app.request(PATH, { headers: CRON })).json();
      expect(corrida1.unidades).toBe(200);
      expect(new Set(corrida1.resultados.map((r: Json) => r.organizationId)).size).toBe(100);
      expect(corrida1.siguienteDespuesDe).toBe(ids[99]);
      const corrida2: Json = await (await t.app.request(`${PATH}?despuesDe=${corrida1.siguienteDespuesDe}`, { headers: CRON })).json();
      expect(corrida2.unidades).toBe(20);
      expect(corrida2.siguienteDespuesDe).toBeNull();
    });

    it("idempotente: repetir la corrida no falla ni purga dos veces lo mismo (cada unidad vuelve a reportar su estado)", async () => {
      const t = await construir();
      t.repo.seedPurgeOrg(t.orgA);
      const a: Json = await (await t.app.request(PATH, { headers: CRON })).json();
      const b: Json = await (await t.app.request(PATH, { headers: CRON })).json();
      expect(a).toMatchObject({ errores: 0, unidades: 2 });
      expect(b).toMatchObject({ errores: 0, unidades: 2 });
    });

    it("una unidad que falla en cron deja 200 con el detalle (no 500) y las demas se purgan", async () => {
      const t = await construir();
      const [o1, o2] = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
      t.repo.seedPurgeOrg(o1);
      t.repo.seedPurgeOrg(o2);
      const original = t.repo.runRetentionPurge.bind(t.repo);
      t.repo.runRetentionPurge = async (org, clase, dry, limit) => {
        if (org === o1 && clase === "restaurantes_voz_transcripciones") throw new Error("fallo simulado de base");
        return original(org, clase, dry, limit);
      };
      const res = await t.app.request(PATH, { headers: CRON });
      expect(res.status).toBe(200);
      const body: Json = await res.json();
      expect(body).toMatchObject({ modo: "ejecucion", unidades: 4, errores: 1 });
      expect(body.resultados.filter((r: Json) => r.estado === "ok")).toHaveLength(3);
    });
  });

  it("base sin migrar o repo ausente: disponible:false y no toca nada", async () => {
    const sinMigrar = await construir({ migrado: false });
    expect(await (await llamar(sinMigrar.app)).json()).toMatchObject({ ok: true, disponible: false, resultados: [] });
    const sinRepo = await construir({ sinRepo: true });
    expect(await (await llamar(sinRepo.app)).json()).toMatchObject({ ok: true, disponible: false });
  });

  it("MISMA sesion abortada: con la base sin migrar el endpoint responde disponible:false y la sesion sigue viva (SAVEPOINT)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /core\.system_list_purge_targets/, respond: () => Object.assign(new Error("function core.system_list_purge_targets(uuid, integer, uuid) does not exist"), { code: "42883" }) },
      { match: /select 1 as sigue_viva/, respond: () => [{ sigue_viva: 1 }] },
    ]);
    const t = await construir();
    const deps: AppDeps = {
      ...t.deps,
      engine: { withAppSession: (_c, fn) => fn(session) },
      privacidadPlataformaRepo: (db) => new PostgresPlataformaPrivacidadRepository(db),
    };
    const res = await llamar(buildApp(deps));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, disponible: false });
    await expect(session.query("select 1 as sigue_viva")).resolves.toEqual({ rows: [{ sigue_viva: 1 }] });
  });
});
