// Transporte NDJSON de "Chatea con tus datos" (paso / fin / error), abort y /estado. HTTP real via app.request con el
// motor real y un modelo guionado (`scriptedCompletion`): ningun test toca la red ni gasta. Cubre una ruta propia
// (licitaciones) y la ruta compartida de las verticales por propiedad (hoteles).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { scriptedCompletion, type DataChatAnswer, type DataChatCompletion, type ScriptStep } from "@atiende/agent-core/data-chat";
import { hashPassword, InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import type { LicitacionesDataChatReader, LicitacionesDataChatWindow } from "@atiende/domain-licitaciones";
import type { HotelesDataChatReader, HotelesDataChatWindow } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import type { DataChatDeps } from "../src/data-chat/deps.ts";
import { NDJSON_ERROR_MENSAJE } from "../src/data-chat/ndjson.ts";
import { authedJson, buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { authedJson as authedJsonHoteles, buildHotelesTestContext } from "./hoteles-fixtures.ts";

const NDJSON = "application/x-ndjson";

class LicReader implements LicitacionesDataChatReader {
  readonly windows: LicitacionesDataChatWindow[] = [];
  async organizationTimezone() { return null; }
  async convocatoriasAbiertas(w: LicitacionesDataChatWindow) {
    this.windows.push(w);
    return [{ titulo: "Uniformes escolares", dependencia: "SEP Yucatán", entidad: null, status: "in_progress", fechaLimite: "2026-10-01 10:00", diasRestantes: 2, montoMxn: 1250000.5, moneda: "MXN" }];
  }
  async plazosSemaforo() { return []; }
  async goNoGo() { return []; }
  async propuestasPorEstado() { return []; }
  async fallos() { return []; }
  async renovaciones() { return []; }
  async preguntasJunta() { return []; }
}

const ABIERTAS: ScriptStep = { toolCalls: [{ name: "convocatorias_abiertas", argumentsJson: '{"vencen_en_dias":7}' }] };
const RESPUESTA: ScriptStep = { text: "Hay una convocatoria abierta que vence pronto." };

interface Opts {
  completion?: DataChatDeps["completion"];
  omitReader?: boolean;
  usage?: DataChatDeps["usageTodayPct"];
}

async function licHarness(steps: ScriptStep[], over: Opts = {}) {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const coreRepo = ctx.deps.coreRepo as InMemoryCoreRepository;
  const engine = ctx.deps.engine as InMemoryTenancyEngine;
  const otraOrg = randomUUID();
  coreRepo.addOrganization({ id: otraOrg, slug: "otra-empresa", name: "Otra Empresa", vertical: "licitaciones" });
  engine.seedProperty({ id: randomUUID(), organizationId: otraOrg });
  const ajeno = randomUUID();
  const password = "correcto-caballo-batería";
  coreRepo.addStaff({ id: ajeno, email: "owner@otra-empresa.mx", fullName: "Owner Ajeno", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addMembership({ userId: ajeno, organizationId: otraOrg, platformRole: "owner", verticalRole: "owner", propertyIds: null });
  engine.seedMembership({ userId: ajeno, organizationId: otraOrg, platformRole: "owner", verticalRole: "owner", propertyIds: null });

  // Cuenta las sesiones RLS abiertas: el flujo NDJSON abre la suya y DEBE cerrarla al terminar o al cancelar.
  const abiertas = { n: 0, total: 0 };
  const original = engine.withAppSession.bind(engine);
  (engine as { withAppSession: unknown }).withAppSession = async (...args: Parameters<typeof original>) => {
    abiertas.n += 1;
    abiertas.total += 1;
    try {
      return await original(...args);
    } finally {
      abiertas.n -= 1;
    }
  };

  const reader = new LicReader();
  const llm = scriptedCompletion(steps);
  const complete: DataChatCompletion = llm.complete;
  const audit: Array<{ outcome: string; tool?: string | null; role?: string }> = [];
  const auditDbs: unknown[] = [];
  const readerDbs: unknown[] = [];
  const dataChat: DataChatDeps = {
    restaurantesReader: () => {
      throw new Error("no debe usarse");
    },
    ...(over.omitReader ? {} : { licitacionesReader: (db) => (readerDbs.push(db), reader) }),
    audit: (db) => ({ record: async (e) => void (auditDbs.push(db), audit.push(e)) }),
    rateLimiter: { allow: async () => true },
    completion: "completion" in over ? over.completion : () => complete,
    ...(over.usage ? { usageTodayPct: over.usage } : {}),
  };
  const app = buildApp({ ...ctx.deps, dataChat });
  const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@otra-empresa.mx", password }) });
  return { ctx, app, llm, reader, audit, auditDbs, readerDbs, abiertas, otraOrgToken: ((await login.json()) as { token: string }).token };
}

type LicH = Awaited<ReturnType<typeof licHarness>>;
const url = (h: LicH, suffix = "") => `/licitaciones/${h.ctx.propertyId}/chat-datos${suffix}`;
const ndjsonReq = (token: string, body: unknown): RequestInit => {
  const base = authedJson(token, body);
  return { ...base, headers: { ...(base.headers as Record<string, string>), accept: NDJSON } };
};
const getReq = (token: string, accept?: string): RequestInit => ({ headers: { authorization: `Bearer ${token}`, ...(accept ? { accept } : {}) } });

async function lines(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("NDJSON: paso / fin", () => {
  it("con Accept application/x-ndjson responde un flujo: paso inicio, paso fin y fin con la respuesta completa", async () => {
    const h = await licHarness([ABIERTAS, RESPUESTA]);
    const res = await h.app.request(url(h), ndjsonReq(h.ctx.staff.owner.token, { question: "¿qué vence esta semana?" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(NDJSON);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const ev = await lines(res);
    expect(ev.map((e) => e["t"])).toEqual(["paso", "paso", "fin"]);
    expect(ev[0]).toEqual({ t: "paso", fase: "inicio", herramienta: "convocatorias_abiertas" });
    expect(ev[1]).toEqual({ t: "paso", fase: "fin", herramienta: "convocatorias_abiertas" });
    const fin = ev[2] as { respuesta: DataChatAnswer };
    expect(fin.respuesta.status).toBe("ok");
    expect(fin.respuesta.toolsUsed).toEqual(["convocatorias_abiertas"]);
    expect(fin.respuesta.blocks[0]!.rows).toHaveLength(1);
  });

  it("el JSON sin el header (o con Accept: application/json) es identico a la respuesta de fin del flujo", async () => {
    const hJson = await licHarness([ABIERTAS, RESPUESTA]);
    const json = await hJson.app.request(url(hJson), { ...authedJson(hJson.ctx.staff.owner.token, { question: "¿qué vence?" }), headers: { ...(authedJson(hJson.ctx.staff.owner.token, {}).headers as Record<string, string>), accept: "application/json" } });
    expect(json.headers.get("content-type")).toContain("application/json");
    const plain = (await json.json()) as DataChatAnswer;

    const hFlow = await licHarness([ABIERTAS, RESPUESTA]);
    const flow = await lines(await hFlow.app.request(url(hFlow), ndjsonReq(hFlow.ctx.staff.owner.token, { question: "¿qué vence?" })));
    expect((flow[flow.length - 1] as { respuesta: unknown }).respuesta).toEqual(plain);

    const hNoHeader = await licHarness([ABIERTAS, RESPUESTA]);
    const sinHeader = await hNoHeader.app.request(url(hNoHeader), authedJson(hNoHeader.ctx.staff.owner.token, { question: "¿qué vence?" }));
    expect(sinHeader.headers.get("content-type")).toContain("application/json");
    expect(await sinHeader.json()).toEqual(plain);
  });

  it("una pregunta sin herramientas (clarify) en flujo: solo el evento fin", async () => {
    const h = await licHarness([{ text: "¿De qué periodo?" }]);
    const ev = await lines(await h.app.request(url(h), ndjsonReq(h.ctx.staff.owner.token, { question: "ventas" })));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ t: "fin", respuesta: { status: "clarify" } });
  });

  it("el turno del flujo corre en su PROPIA sesion (lector y bitacora) y la cierra; en JSON sigue usando la del request", async () => {
    const h = await licHarness([ABIERTAS, RESPUESTA]);
    await lines(await h.app.request(url(h), ndjsonReq(h.ctx.staff.owner.token, { question: "x" })));
    expect(h.abiertas.n).toBe(0);
    // Una fila de la herramienta y (CHAT-07) la fila de resumen del turno, con el rol del gateway.
    expect(h.audit.filter((a) => a.tool).map((a) => a.outcome)).toEqual(["ok"]);
    expect(h.audit.filter((a) => !a.tool).map((a) => a.role)).toEqual(["licitaciones:data_chat"]);
    // readerDbs[0] = comprobacion previa con la sesion del request; readerDbs[1] = catalogo del turno.
    expect(h.readerDbs).toHaveLength(2);
    expect(h.readerDbs[1]).not.toBe(h.readerDbs[0]);
    expect(h.auditDbs[0]).toBe(h.readerDbs[1]);

    const j = await licHarness([ABIERTAS, RESPUESTA]);
    await j.app.request(url(j), authedJson(j.ctx.staff.owner.token, { question: "x" }));
    expect(j.readerDbs[1]).toBe(j.readerDbs[0]);
    expect(j.auditDbs[0]).toBe(j.readerDbs[0]);
  });

  it("el modo sin IA (tool directo) tambien emite los pasos", async () => {
    const h = await licHarness([{ text: "no se usa" }]);
    const ev = await lines(await h.app.request(url(h), ndjsonReq(h.ctx.staff.owner.token, { tool: "convocatorias_abiertas" })));
    expect(ev.map((e) => e["t"])).toEqual(["paso", "paso", "fin"]);
    expect(h.llm.requests).toHaveLength(0);
  });
});

describe("NDJSON: errores", () => {
  it("401, 403 cross-tenant y 400 de validacion siguen siendo JSON HTTP normal (antes de abrir el flujo)", async () => {
    const h = await licHarness([RESPUESTA]);
    const sinToken = await h.app.request(url(h), { method: "POST", headers: { "content-type": "application/json", accept: NDJSON }, body: "{}" });
    expect(sinToken.status).toBe(401);
    const ajeno = await h.app.request(url(h), ndjsonReq(h.otraOrgToken, { question: "x" }));
    expect(ajeno.status).toBe(403);
    expect(ajeno.headers.get("content-type")).toContain("application/json");
    const malo = await h.app.request(url(h), ndjsonReq(h.ctx.staff.owner.token, { question: "x", organizationId: "otra" }));
    expect(malo.status).toBe(400);
    const noJson = await h.app.request(url(h), { ...ndjsonReq(h.ctx.staff.owner.token, {}), body: "esto no es json" });
    expect(noJson.status).toBe(400);
    expect(h.llm.requests).toHaveLength(0);
  });

  it("si el turno revienta ya empezado el flujo: evento error con mensaje fijo, sin el texto de la excepcion, y sesion cerrada", async () => {
    const h = await licHarness([RESPUESTA], {
      completion: () => {
        throw new Error("secreto-interno-de-la-base");
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await h.app.request(url(h), ndjsonReq(h.ctx.staff.owner.token, { question: "x" }));
    expect(res.status).toBe(200);
    const ev = await lines(res);
    spy.mockRestore();
    expect(ev).toEqual([{ t: "error", status: "error", mensaje: NDJSON_ERROR_MENSAJE }]);
    expect(JSON.stringify(ev)).not.toContain("secreto-interno");
    expect(h.abiertas.n).toBe(0);
  });

  it("asistente no activado: el cliente NDJSON recibe un fin con el aviso (no un JSON suelto)", async () => {
    const h = await licHarness([RESPUESTA], { completion: undefined });
    const ev = await lines(await h.app.request(url(h), ndjsonReq(h.ctx.staff.owner.token, { question: "x" })));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ t: "fin", respuesta: { status: "unavailable" } });
    const json = await h.app.request(url(h), authedJson(h.ctx.staff.owner.token, { question: "x" }));
    expect(((await json.json()) as DataChatAnswer).status).toBe("unavailable");
  });
});

describe("NDJSON: abort", () => {
  it("cancelar la lectura (Detener) aborta el turno: no hay mas pasos, no se escribe bitacora y la sesion se cierra", async () => {
    let liberar: (() => void) | undefined;
    const colgado = new Promise<never>((_, rej) => {
      liberar = () => rej(new Error("liberado"));
    });
    const h = await licHarness([RESPUESTA], { completion: () => () => colgado });
    const res = await h.app.request(url(h), ndjsonReq(h.ctx.staff.owner.token, { question: "x" }));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await vi.waitFor(() => expect(h.abiertas.n).toBe(1)); // el turno esta esperando al modelo, dentro de su sesion
    await reader.cancel();
    await vi.waitFor(() => expect(h.abiertas.n).toBe(0));
    expect(h.audit).toHaveLength(0);
    liberar?.();
  });
});

describe("/estado", () => {
  it("activado y sin lector de uso: available/permitido true, motivo null, usoHoyPct null (sin medir)", async () => {
    const h = await licHarness([RESPUESTA]);
    const res = await h.app.request(url(h, "/estado"), getReq(h.ctx.staff.owner.token));
    expect(await res.json()).toEqual({ available: true, permitido: true, motivo: null, usoHoyPct: null });
  });

  it("sin proveedor o sin lector: no_activado", async () => {
    const sinProveedor = await licHarness([RESPUESTA], { completion: undefined });
    expect(await (await sinProveedor.app.request(url(sinProveedor, "/estado"), getReq(sinProveedor.ctx.staff.owner.token))).json()).toEqual({ available: false, permitido: false, motivo: "no_activado", usoHoyPct: null });
    const sinLector = await licHarness([RESPUESTA], { omitReader: true });
    expect(await (await sinLector.app.request(url(sinLector, "/estado"), getReq(sinLector.ctx.staff.owner.token))).json()).toMatchObject({ available: false, permitido: false, motivo: "no_activado" });
  });

  it("con lector de uso: porcentaje redondeado, tope_diario al 100% y nunca mas de 100", async () => {
    const parcial = await licHarness([RESPUESTA], { usage: async () => 41.6 });
    expect(await (await parcial.app.request(url(parcial, "/estado"), getReq(parcial.ctx.staff.owner.token))).json()).toEqual({ available: true, permitido: true, motivo: null, usoHoyPct: 42 });
    const tope = await licHarness([RESPUESTA], { usage: async () => 250 });
    expect(await (await tope.app.request(url(tope, "/estado"), getReq(tope.ctx.staff.owner.token))).json()).toEqual({ available: true, permitido: false, motivo: "tope_diario", usoHoyPct: 100 });
  });

  it("el lector de uso recibe la organizacion y el usuario de la SESION verificada", async () => {
    const visto: string[] = [];
    const h = await licHarness([RESPUESTA], { usage: async (_db, org, user) => (visto.push(org, user), 10) });
    await h.app.request(url(h, "/estado"), getReq(h.ctx.staff.owner.token));
    expect(visto).toEqual([h.ctx.organizationId, h.ctx.staff.owner.id]);
  });

  it("un lector de uso que falla degrada a null sin 500 (la transaccion del request sigue sana)", async () => {
    const h = await licHarness([RESPUESTA], {
      usage: async () => {
        throw Object.assign(new Error('relation "core.uso" does not exist'), { code: "42P01" });
      },
    });
    const res = await h.app.request(url(h, "/estado"), getReq(h.ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, permitido: true, motivo: null, usoHoyPct: null });
  });

  it("401 sin token y 403 de otra organizacion", async () => {
    const h = await licHarness([RESPUESTA]);
    expect((await h.app.request(url(h, "/estado"))).status).toBe(401);
    expect((await h.app.request(url(h, "/estado"), getReq(h.otraOrgToken))).status).toBe(403);
  });
});

// ---- ruta compartida de las verticales por propiedad (hoteles): mismo transporte ----
class HotelReader implements HotelesDataChatReader {
  readonly windows: HotelesDataChatWindow[] = [];
  constructor(private readonly propertyId: string) {}
  async listVisibleHotels() { return [{ propertyId: this.propertyId, name: "Hotel Centro", slug: "centro" }]; }
  async occupancy(w: HotelesDataChatWindow) {
    this.windows.push(w);
    return [{ bucket: "2026-09-29", availableNights: 20, occupiedNights: 7, roomRevenue: 7000 }];
  }
  async revenue() { return []; }
  async arrivalsDepartures() { return []; }
  async cancellations() { return []; }
  async openTickets() { return []; }
  async housekeepingPending() { return []; }
}

describe("ruta compartida de verticales por propiedad (hoteles)", () => {
  async function hotelHarness(steps: ScriptStep[]) {
    const ctx = await buildHotelesTestContext(buildApp);
    const llm = scriptedCompletion(steps);
    const dataChat: DataChatDeps = {
      restaurantesReader: () => {
        throw new Error("no se usa en hoteles");
      },
      hotelesReader: () => new HotelReader(ctx.propertyId),
      audit: () => ({ record: async () => {} }),
      rateLimiter: { allow: async () => true },
      completion: () => llm.complete,
    };
    return { ctx, app: buildApp({ ...ctx.deps, dataChat }), llm };
  }

  it("NDJSON: paso inicio, paso fin y fin; y /estado con el contrato nuevo", async () => {
    const h = await hotelHarness([{ toolCalls: [{ name: "ocupacion_adr_revpar", argumentsJson: '{"periodo":"ultimos_30_dias"}' }] }, { text: "La ocupacion fue de 35%." }]);
    const base = `/hoteles/${h.ctx.propertyId}/chat-datos`;
    const init = authedJsonHoteles(h.ctx.staff.owner.token, { question: "ocupacion" });
    const res = await h.app.request(base, { ...init, headers: { ...(init.headers as Record<string, string>), accept: NDJSON } });
    expect(res.headers.get("content-type")).toContain(NDJSON);
    const ev = await lines(res);
    expect(ev.map((e) => e["t"])).toEqual(["paso", "paso", "fin"]);
    expect(ev[0]).toEqual({ t: "paso", fase: "inicio", herramienta: "ocupacion_adr_revpar" });
    expect(ev[2]).toMatchObject({ respuesta: { status: "ok", toolsUsed: ["ocupacion_adr_revpar"] } });

    const estado = await h.app.request(`${base}/estado`, { headers: { authorization: `Bearer ${h.ctx.staff.owner.token}` } });
    expect(await estado.json()).toEqual({ available: true, permitido: true, motivo: null, usoHoyPct: null });
  });
});
