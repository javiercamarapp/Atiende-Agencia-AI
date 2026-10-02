// CHAT-14 -- reporte PDF del Copiloto por HTTP real (app.request) sobre la ruta compartida de las verticales por propiedad
// (hoteles). El LLM es un guion (`scriptedCompletion`): ningun test toca la red ni gasta. El repositorio de conversaciones
// es un doble en memoria con el mismo alcance que la base (autor + organizacion + vertical); el aislamiento a nivel RLS lo
// prueba scripts/verify-copiloto-conversaciones/ contra Postgres real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scriptedCompletion, type DataChatAuditEntry, type ScriptStep } from "@atiende/agent-core/data-chat";
import { InMemoryCoreRepository, InMemoryTenancyEngine, hashPassword } from "@atiende/db";
import type { HotelesDataChatReader, HotelesDataChatWindow } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import type { DataChatDeps } from "../src/data-chat/deps.ts";
import type { ConversacionDetalleDto, ConversacionScope, ConversacionesRepository, FuenteReporte, ResultadoGuardado, TurnoAGuardar } from "../src/data-chat/conversaciones.ts";
import { buildHotelesTestContext } from "./hoteles-fixtures.ts";
import { textoDelPdf } from "./support/pdf-text.ts";

class Reader implements HotelesDataChatReader {
  windows: HotelesDataChatWindow[] = [];
  async listVisibleHotels(_org: string, ids: readonly string[] | null) {
    return (ids ?? []).map((id) => ({ propertyId: id, name: "Hotel Centro", slug: "centro" }));
  }
  async occupancy(w: HotelesDataChatWindow) {
    this.windows.push(w);
    return [{ bucket: "2026-09-29", availableNights: 40, occupiedNights: 14, roomRevenue: 14000 }];
  }
  async revenue() { return []; }
  async arrivalsDepartures() { return []; }
  async cancellations() { return []; }
  async openTickets() { return []; }
  async housekeepingPending() { return []; }
}

interface Stored {
  id: string;
  scope: ConversacionScope;
  mensajes: { seq: number; role: "user" | "assistant"; text: string; toolCalls: FuenteReporte["toolCalls"] }[];
}

/** Doble en memoria: solo lo que usa el reporte (cargarFuenteReporte) con el mismo alcance que la base. */
class MemoryRepo implements ConversacionesRepository {
  constructor(readonly store: Stored[]) {}
  async list() { return { disponible: true, items: [] }; }
  async get(): Promise<ConversacionDetalleDto | null> { return null; }
  async loadHistory() { return null; }
  async rename() { return false; }
  async remove() { return false; }
  async append(_s: ConversacionScope, _t: TurnoAGuardar): Promise<ResultadoGuardado> { return { guardado: false, motivo: "no_disponible" }; }
  async cargarFuenteReporte(scope: ConversacionScope, id: string, seq: number): Promise<FuenteReporte | null> {
    const c = this.store.find((x) => x.id === id && x.scope.userId === scope.userId && x.scope.organizationId === scope.organizationId && x.scope.vertical === scope.vertical);
    const m = c?.mensajes.find((x) => x.seq === seq && x.role === "assistant");
    return m ? { seq, toolCalls: m.toolCalls } : null;
  }
}

const ANALISIS_OK: ScriptStep = {
  text: JSON.stringify({
    hallazgos: [{ tipo: "kpi", texto: "La ocupación fue de 35.0% con 14 noches ocupadas de 40.", fuentes: [{ herramienta: "ocupacion_adr_revpar", fila: 1 }] }],
  }),
};
const REDACCION_OK: ScriptStep = {
  text: JSON.stringify({
    resumen: "La ocupación del periodo fue de 35.0%.",
    secciones: [{ titulo: "Ocupación", texto: "Se ocuparon 14 de 40 noches disponibles." }],
    graficas: [],
  }),
};
const REDACCION_INVENTADA: ScriptStep = {
  text: JSON.stringify({ resumen: "La ocupación subió 88% contra el año pasado.", secciones: [{ titulo: "Ocupación", texto: "Se vendieron 777 noches." }], graficas: [] }),
};

async function harness(over: { analisis?: ScriptStep[]; redaccion?: ScriptStep[]; sinIa?: boolean; allow?: boolean; toolCalls?: FuenteReporte["toolCalls"] } = {}) {
  const ctx = await buildHotelesTestContext(buildApp);
  const coreRepo = ctx.deps.coreRepo as InMemoryCoreRepository;
  const engine = ctx.deps.engine as InMemoryTenancyEngine;
  const otherOrg = randomUUID();
  coreRepo.addOrganization({ id: otherOrg, slug: "hotel-ajeno", name: "Hotel Ajeno", vertical: "hoteles" });
  const otherProperty = randomUUID();
  engine.seedProperty({ id: otherProperty, organizationId: otherOrg });
  const password = "correcto-caballo-batería";
  const ownerId = randomUUID();
  coreRepo.addStaff({ id: ownerId, email: "owner-ajeno@hotel-ajeno.mx", fullName: "owner-ajeno", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addMembership({ userId: ownerId, organizationId: otherOrg, platformRole: "owner", verticalRole: "owner", propertyIds: null });
  engine.seedMembership({ userId: ownerId, organizationId: otherOrg, platformRole: "owner", verticalRole: "owner", propertyIds: null });

  const conversationId = randomUUID();
  const store: Stored[] = [
    {
      id: conversationId,
      scope: { organizationId: ctx.organizationId, userId: ctx.staff.owner.id, vertical: "hoteles" },
      mensajes: [
        { seq: 1, role: "user", text: "ocupación", toolCalls: [] },
        // El texto guardado trae una cifra que YA NO es real: el reporte jamas la reutiliza (re-consulta los datos).
        { seq: 2, role: "assistant", text: "La ocupación fue de 99.9%.", toolCalls: over.toolCalls ?? [{ tool: "ocupacion_adr_revpar", args: { periodo: "ultimos_30_dias" } }] },
        { seq: 3, role: "user", text: "gracias", toolCalls: [] },
        { seq: 4, role: "assistant", text: "De nada.", toolCalls: [] },
      ],
    },
  ];
  const reader = new Reader();
  const analisis = scriptedCompletion(over.analisis ?? [ANALISIS_OK]);
  const redaccion = scriptedCompletion(over.redaccion ?? [REDACCION_OK]);
  const roles: string[] = [];
  const audit: DataChatAuditEntry[] = [];
  const dataChat: DataChatDeps = {
    restaurantesReader: () => {
      throw new Error("no se usa en hoteles");
    },
    hotelesReader: () => reader,
    audit: () => ({ record: async (e) => void audit.push(e) }),
    rateLimiter: { allow: async () => over.allow ?? true },
    completion: over.sinIa
      ? undefined
      : (_org, role) => {
          roles.push(role ?? "");
          return (role ?? "").includes("analisis") ? analisis.complete : redaccion.complete;
        },
    conversaciones: () => new MemoryRepo(store),
  };
  const app = buildApp({ ...ctx.deps, dataChat });
  const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner-ajeno@hotel-ajeno.mx", password }) });
  const otraOrgToken = ((await login.json()) as { token: string }).token;
  return { ctx, app, store, conversationId, reader, analisis, redaccion, roles, audit, otraOrgToken, otherProperty, propertyId: ctx.propertyId, ownerToken: ctx.staff.owner.token, gmToken: ctx.staff.gm.token, frontdeskToken: ctx.staff.frontdesk.token };
}

type H = Awaited<ReturnType<typeof harness>>;
const post = (h: H, token: string, id: string = h.conversationId, seq: string | number = 2, property = h.propertyId) =>
  h.app.request(`/hoteles/${property}/chat-datos/conversaciones/${id}/reporte?seq=${seq}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });

describe("POST .../conversaciones/:id/reporte", () => {
  it("devuelve un PDF real con cifras RE-CONSULTADAS (no las del texto del chat), pie con periodo, alcance y cifras reales", async () => {
    const h = await harness();
    const res = await post(h, h.ownerToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="reporte-hoteles-\d{4}-\d{2}-\d{2}\.pdf"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-reporte-narrativa")).toBe("ok");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes.slice(0, 4)).toString("latin1")).toBe("%PDF");
    const texto = textoDelPdf(bytes);
    expect(texto).toContain("Cifras reales de tu sistema");
    expect(texto).toContain("Periodo: ");
    expect(texto).toContain("Alcance: ");
    expect(texto).toContain("Ocupación");
    expect(texto).toContain("35.0%"); // de la tabla, no del texto guardado
    expect(texto).not.toContain("99.9");
    expect(h.reader.windows).toHaveLength(1); // se re-ejecuto el catalogo
    expect(texto).toContain("La ocupación del periodo fue de 35.0%.");
  });

  it("usa los roles reportes:* (financiero si hay MXN) para analista y redactor y deja bitacora sin resultados", async () => {
    const h = await harness();
    await post(h, h.ownerToken);
    expect(h.roles.sort()).toEqual(["reportes:analisis_financiero", "reportes:redaccion_financiero"]);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ tool: "ocupacion_adr_revpar", vertical: "hoteles", outcome: "ok", rowCount: 1, params: { periodo: "ultimos_30_dias" } });
    expect(JSON.stringify(h.audit)).not.toContain("35.0");
  });

  it("la entrada que recibe el modelo no contiene telefonos ni correos", async () => {
    const h = await harness();
    await post(h, h.ownerToken);
    const dump = JSON.stringify([...h.analisis.requests, ...h.redaccion.requests].map((r) => r.messages));
    expect(dump).not.toMatch(/@|\d{3}[ -]\d{3}[ -]\d{4}/);
  });

  it("cifra inventada por el redactor: se rechaza y se reintenta UNA vez", async () => {
    const h = await harness({ redaccion: [REDACCION_INVENTADA, REDACCION_OK] });
    const res = await post(h, h.ownerToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-reporte-narrativa")).toBe("ok");
    expect(h.redaccion.requests).toHaveLength(2);
    const texto = textoDelPdf(new Uint8Array(await res.arrayBuffer()));
    expect(texto).not.toContain("777");
    expect(texto).not.toContain("88%");
  });

  it("doble fallo de la guardia: PDF SIN narrativa (solo tablas y graficas) con la leyenda honesta", async () => {
    const h = await harness({ redaccion: [REDACCION_INVENTADA] });
    const res = await post(h, h.ownerToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-reporte-narrativa")).toBe("no_disponible");
    expect(h.redaccion.requests).toHaveLength(2);
    const texto = textoDelPdf(new Uint8Array(await res.arrayBuffer()));
    expect(texto).toContain("Narrativa no disponible");
    expect(texto).toContain("35.0%");
    expect(texto).not.toContain("777");
  });

  it("sin proveedor de IA (sin OPENROUTER): PDF de datos, sin llamar a ningun modelo", async () => {
    const h = await harness({ sinIa: true });
    const res = await post(h, h.ownerToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-reporte-narrativa")).toBe("no_disponible");
    expect(h.analisis.requests).toHaveLength(0);
    const texto = textoDelPdf(new Uint8Array(await res.arrayBuffer()));
    expect(texto).toContain("la asistencia con IA no está activada");
    expect(texto).toContain("35.0%");
  });

  it("cross-tenant: el owner de OTRA organizacion recibe 404 (sin confirmar que existe) y nada se consulta", async () => {
    const h = await harness();
    const res = await post(h, h.otraOrgToken, h.conversationId, 2, h.otherProperty);
    expect(res.status).toBe(404);
    expect(h.reader.windows).toHaveLength(0);
    expect(h.analisis.requests).toHaveLength(0);
  });

  it("conversacion de OTRO usuario de la misma organizacion: 404", async () => {
    const h = await harness();
    const res = await post(h, h.gmToken);
    expect(res.status).toBe(404);
    expect(h.reader.windows).toHaveLength(0);
  });

  it("rol sin acceso al Copiloto (frontdesk): 403; sin token: 401", async () => {
    const h = await harness();
    expect((await post(h, h.frontdeskToken)).status).toBe(403);
    const sinToken = await h.app.request(`/hoteles/${h.propertyId}/chat-datos/conversaciones/${h.conversationId}/reporte?seq=2`, { method: "POST" });
    expect(sinToken.status).toBe(401);
    expect(h.reader.windows).toHaveLength(0);
  });

  it("validacion: seq invalido 400, mensaje inexistente o del usuario 404, id mal formado 404, mensaje sin cifras 422", async () => {
    const h = await harness();
    for (const seq of ["abc", "0", "101", "", "-1", "1.5"]) expect((await post(h, h.ownerToken, h.conversationId, seq)).status, `seq=${seq}`).toBe(400);
    expect((await post(h, h.ownerToken, h.conversationId, 1)).status).toBe(404); // mensaje del usuario
    expect((await post(h, h.ownerToken, h.conversationId, 9)).status).toBe(404);
    expect((await post(h, h.ownerToken, "no-es-uuid", 2)).status).toBe(404);
    expect((await post(h, h.ownerToken, randomUUID(), 2)).status).toBe(404);
    const sinCifras = await post(h, h.ownerToken, h.conversationId, 4);
    expect(sinCifras.status).toBe(422);
    expect(((await sinCifras.json()) as { code: string }).code).toBe("report_no_data");
  });

  it("limite de uso (fail-closed): 429 y no se consulta ni se llama al modelo", async () => {
    const h = await harness({ allow: false });
    const res = await post(h, h.ownerToken);
    expect(res.status).toBe(429);
    expect(h.reader.windows).toHaveLength(0);
    expect(h.analisis.requests).toHaveLength(0);
  });

  it("una herramienta guardada que ya no existe deja el reporte sin tablas: 422 honesto (nunca un PDF vacio ni ceros)", async () => {
    const h = await harness({ toolCalls: [{ tool: "ya_no_existe", args: {} }] });
    const res = await post(h, h.ownerToken);
    expect(res.status).toBe(422);
    expect(h.analisis.requests).toHaveLength(0);
  });
});

describe("montaje en las 6 verticales", () => {
  it("cada vertical expone POST .../conversaciones/:conversationId/reporte bajo la misma base que su chat de datos", async () => {
    const h = await harness();
    const rutas = new Set(h.app.routes.filter((r) => r.method === "POST").map((r) => r.path));
    for (const base of [
      "/v1/restaurantes/:propertyId/admin/chat-datos",
      "/hoteles/:propertyId/chat-datos",
      "/rentas/:propertyId/chat-datos",
      "/despachos/:propertyId/chat-datos",
      "/licitaciones/:propertyId/chat-datos",
      "/citas/:propertyId/chat-datos",
    ]) {
      expect(rutas.has(base), `chat ${base}`).toBe(true);
      expect(rutas.has(`${base}/conversaciones/:conversationId/reporte`), `reporte ${base}`).toBe(true);
    }
  });
});
