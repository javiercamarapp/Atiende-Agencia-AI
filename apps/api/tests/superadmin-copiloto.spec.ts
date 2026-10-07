// Copiloto de superadmin (CHAT-16), de punta a punta por HTTP (app.request) con LLM GUIONADO (`scriptedCompletion`: ningun test toca la red ni gasta) y
// repositorios EN MEMORIA. Cubre cada regla de seguridad del turno: 403 a quien no es superadmin ni finanzas, finanzas solo ve herramientas financieras,
// step-up para las financieras (con huella en core.cfo_access_log), 409 con impersonacion, interruptor apagado sin llamar al modelo, tope mensual propio,
// 20 preguntas por minuto, guardia de cifras, fuera de catalogo, bitacora y conversacion persistida con scope plataforma. La autorizacion REAL en SQL
// (RLS, caller-binding, CHECK) la prueba scripts/verify-superadmin-copiloto/ contra Postgres real; las herramientas, superadmin-copiloto-herramientas.spec.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { totpAt } from "@atiende/core-auth";
import { scriptedCompletion, type DataChatAnswer, type DataChatAuditEntry, type DataChatHistoryTurn, type ScriptStep } from "@atiende/agent-core/data-chat";
import { InMemoryCfoRepository, InMemoryCfoZoneRepository, InMemoryImpersonationRepository, InMemoryPylRepository, type InMemoryTenancyEngine } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import type { ConversacionDetalleDto, ConversacionResumenDto, FuenteReporte, ConversacionScope, ConversacionesRepository, MensajeGuardadoDto, ResultadoGuardado, TurnoAGuardar } from "../src/data-chat/conversaciones.ts";
import { COPILOTO_NO_ACTIVADO } from "../src/routes/superadmin-copiloto.ts";
import { crearLedgerMensual, type SuperadminCopilotoDeps } from "../src/superadmin-copiloto/deps.ts";
import type { PinDto, PinOrigen, PinsPlataformaRepository, ResultadoAltaPin, ResultadoEdicionPin } from "../src/superadmin-copiloto/pins.ts";
import { cleanPinTitle, plainArgs } from "../src/data-chat/pins.ts";
import { fuentesDeProduccion, type FuentesPlataforma } from "../src/superadmin-copiloto/fuentes.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";
import { HERRAMIENTAS_FINANCIERAS, HERRAMIENTAS_OPERATIVAS } from "../src/superadmin-copiloto/catalogo.ts";
import { FILA_CFO, FILA_CFO_HOTEL, fuentesFalsas } from "./superadmin-copiloto-fixtures.ts";

interface Guardada {
  id: string;
  scope: ConversacionScope;
  titulo: string;
  mensajes: MensajeGuardadoDto[];
  herramientas?: Set<string>;
  llamadas?: { tool: string; args: Record<string, string | number> }[];
}

/** Doble en memoria del repositorio de conversaciones: mismo alcance que la base (autor + organizacion + vertical). */
class RepoEnMemoria implements ConversacionesRepository {
  readonly appended: { scope: ConversacionScope; turno: TurnoAGuardar }[] = [];
  readonly store: Guardada[] = [];
  private mia(scope: ConversacionScope, id: string): Guardada | undefined {
    return this.store.find((c) => c.id === id && c.scope.userId === scope.userId && c.scope.organizationId === scope.organizationId && c.scope.vertical === scope.vertical);
  }
  async list(scope: ConversacionScope): Promise<{ disponible: boolean; items: ConversacionResumenDto[] }> {
    const items = this.store
      .filter((c) => c.scope.userId === scope.userId && c.scope.organizationId === scope.organizationId && c.scope.vertical === scope.vertical)
      .map((c) => ({ id: c.id, titulo: c.titulo, actualizadaEn: "2026-10-02T12:00:00.000Z", mensajes: c.mensajes.length }));
    return { disponible: true, items };
  }
  async get(scope: ConversacionScope, id: string): Promise<ConversacionDetalleDto | null> {
    const c = this.mia(scope, id);
    return c ? { id: c.id, titulo: c.titulo, actualizadaEn: "2026-10-02T12:00:00.000Z", mensajes: c.mensajes } : null;
  }
  async cargarFuenteReporte(scope: ConversacionScope, id: string, seq: number): Promise<FuenteReporte | null> {
    const c = this.mia(scope, id);
    const m = c?.mensajes.find((x) => x.seq === seq && x.role === "assistant");
    return c && m ? { seq, toolCalls: c.llamadas ?? [] } : null;
  }
  async herramientasUsadas(scope: ConversacionScope, id: string): Promise<string[] | null> {
    const c = this.mia(scope, id);
    return c ? [...(c.herramientas ?? [])] : null;
  }
  async loadHistory(scope: ConversacionScope, id: string, limit: number): Promise<DataChatHistoryTurn[] | null> {
    const c = this.mia(scope, id);
    return c ? c.mensajes.slice(-limit).map((m) => ({ role: m.role, text: m.text })) : null;
  }
  async rename(scope: ConversacionScope, id: string, titulo: string): Promise<boolean> {
    const c = this.mia(scope, id);
    if (!c) return false;
    c.titulo = titulo;
    return true;
  }
  async remove(scope: ConversacionScope, id: string): Promise<boolean> {
    const c = this.mia(scope, id);
    if (!c) return false;
    this.store.splice(this.store.indexOf(c), 1);
    return true;
  }
  async append(scope: ConversacionScope, turno: TurnoAGuardar): Promise<ResultadoGuardado> {
    this.appended.push({ scope, turno });
    let c = turno.conversationId ? this.mia(scope, turno.conversationId) : undefined;
    if (turno.conversationId && !c) return { guardado: false, motivo: "conversacion_no_encontrada" };
    if (!c) {
      c = { id: randomUUID(), scope, titulo: turno.userText.slice(0, 60), mensajes: [] };
      this.store.push(c);
    }
    c.herramientas = new Set([...(c.herramientas ?? []), ...turno.toolCalls.map((t) => t.tool)]);
    c.llamadas = [...(c.llamadas ?? []), ...turno.toolCalls.map((t) => ({ tool: t.tool, args: { ...t.args } }))];
    const base = c.mensajes.length;
    c.mensajes.push({ id: `${c.id}:${base + 1}`, role: "user", text: turno.userText, seq: base + 1 });
    c.mensajes.push({ id: `${c.id}:${base + 2}`, role: "assistant", text: turno.assistantText, seq: base + 2, status: turno.status, blocks: [...turno.blocks], sources: [...turno.sources] });
    return { guardado: true, conversationId: c.id, seq: base + 2 };
  }
}

/** Doble en memoria de los fijados de plataforma: mismo alcance que la base (solo el autor, nunca compartidos, dedupe por herramienta + argumentos, tope de 50). */
class PinsEnMemoria implements PinsPlataformaRepository {
  readonly store: (PinDto & { userId: string })[] = [];
  constructor(private readonly conv: RepoEnMemoria) {}
  async list(userId: string) {
    return { disponible: true, items: this.store.filter((p) => p.userId === userId) };
  }
  async get(userId: string, id: string) {
    return this.store.find((p) => p.userId === userId && p.id === id) ?? null;
  }
  async origin(userId: string, conversationId: string, seq: number, bloque: number): Promise<PinOrigen | null> {
    const c = this.conv.store.find((x) => x.id === conversationId && x.scope.userId === userId && x.scope.vertical === "plataforma");
    const m = c?.mensajes.find((x) => x.seq === seq && x.role === "assistant");
    const b = m?.blocks?.[bloque] as { tool?: string; title?: string } | undefined;
    const call = c?.llamadas?.find((l) => l.tool === b?.tool);
    if (!c || !b?.tool || !call) return null;
    return { tool: b.tool, args: plainArgs(call.args), title: cleanPinTitle(b.title ?? b.tool) };
  }
  async create(input: { conversationId: string; seq: number; bloque: number; origin: PinOrigen }): Promise<ResultadoAltaPin> {
    const userId = this.conv.store.find((c) => c.id === input.conversationId)?.scope.userId;
    if (!userId) return { ok: false, motivo: "conversacion_no_encontrada" };
    const igual = this.store.find((p) => p.userId === userId && p.herramienta === input.origin.tool && JSON.stringify(p.args) === JSON.stringify(input.origin.args));
    if (igual) return { ok: true, id: igual.id };
    if (this.store.filter((p) => p.userId === userId).length >= 50) return { ok: false, motivo: "limite" };
    const id = randomUUID();
    this.store.push({ id, userId, titulo: input.origin.title, herramienta: input.origin.tool, args: input.origin.args, compartido: false, propio: true, creadoEn: "2026-10-02T12:00:00.000Z" });
    return { ok: true, id };
  }
  async rename(userId: string, id: string, titulo: string): Promise<ResultadoEdicionPin> {
    const p = this.store.find((x) => x.userId === userId && x.id === id);
    if (!p) return "no_encontrado";
    (p as { titulo: string }).titulo = titulo;
    return "ok";
  }
  async remove(userId: string, id: string): Promise<boolean> {
    const i = this.store.findIndex((x) => x.userId === userId && x.id === id);
    if (i < 0) return false;
    this.store.splice(i, 1);
    return true;
  }
}

interface Opciones {
  readonly steps?: ScriptStep[];
  readonly sinProveedor?: boolean;
  readonly sinZona?: boolean;
  readonly fuentes?: Partial<FuentesPlataforma>;
  /** `produccion` (por defecto) = fuentes de produccion sobre repos en memoria (la huella CFO va a core.cfo_access_log); `falsas` = datos de ejemplo. */
  readonly modo?: "produccion" | "falsas";
  readonly topeMensualMicroUsd?: number;
  readonly costoUsdPorLlamada?: number;
  readonly permitirTurnos?: () => boolean;
}

async function setup(o: Opciones = {}) {
  const s = await seguridadSetup();
  const zona = new InMemoryCfoZoneRepository();
  const cfo = new InMemoryCfoRepository();
  cfo.seedRows([FILA_CFO, FILA_CFO_HOTEL]);
  const pyl = new InMemoryPylRepository();
  const scripted = scriptedCompletion(o.steps ?? [{ text: "" }]);
  const conv = new RepoEnMemoria();
  const bitacora: DataChatAuditEntry[] = [];
  const limiter: { key: string; limit: number; windowMs: number }[] = [];
  const ledger = crearLedgerMensual();
  const falsas = fuentesFalsas(o.fuentes);
  const pins = new PinsEnMemoria(conv);
  const deps: AppDeps = {
    ...s.deps,
    cfoRepo: () => cfo,
    pylRepo: () => pyl,
    ...(o.sinZona ? {} : { cfoZoneRepo: () => zona }),
    superadminCopiloto: {
      completion: o.sinProveedor
        ? undefined
        : async (req) => {
            const r = await scripted.complete(req);
            return { ...r, costUsd: o.costoUsdPorLlamada ?? 0 };
          },
      rateLimiter: {
        allow: async (key, limit, windowMs) => {
          limiter.push({ key, limit, windowMs });
          return o.permitirTurnos ? o.permitirTurnos() : true;
        },
      },
      ledger,
      ...(o.topeMensualMicroUsd !== undefined ? { topeMensualMicroUsd: o.topeMensualMicroUsd } : {}),
      fuentes: (db, callerId) => (o.modo === "falsas" ? falsas : { ...fuentesDeProduccion(deps, db, callerId), ...(o.fuentes ?? {}) }),
      conversaciones: () => conv,
      pins: () => pins,
      audit: () => ({
        record: async (e) => {
          bitacora.push(e);
        },
      }),
    } satisfies SuperadminCopilotoDeps,
  };
  const app = buildApp(deps);

  const alta = async (opts: { finanzas?: boolean } = {}) => {
    const sa = await s.superadmin();
    cfo.seedSuperadmin(sa.id);
    pyl.seedSuperadmin(sa.id);
    zona.seedSuperadmin(sa.id, sa.email);
    if (opts.finanzas) zona.seedRole(sa.id);
    return sa;
  };
  const activarMfa = async (sa: { token: string }): Promise<string> => {
    const enr = await app.request("/superadmin/mfa/enrolar", jsonRequestInit({}, bearer(sa.token)));
    expect(enr.status).toBe(201);
    const { secreto } = (await enr.json()) as { secreto: string };
    const ver = await app.request("/superadmin/mfa/verificar", jsonRequestInit({ codigo: totpAt(secreto, Date.now()) }, bearer(sa.token)));
    expect(ver.status).toBe(200);
    return ((await ver.json()) as { stepUpToken: string }).stepUpToken;
  };
  const post = (token: string, body: unknown, extra: Record<string, string> = {}) => app.request("/superadmin/copiloto", jsonRequestInit(body, bearer(token, extra)));
  const turno = async (token: string, body: unknown, extra: Record<string, string> = {}) => {
    const res = await post(token, body, extra);
    expect(res.status).toBe(200);
    return (await res.json()) as DataChatAnswer & { conversacionId?: string; conversationId?: string; seq?: number; guardado?: boolean };
  };
  const estado = (token: string, extra: Record<string, string> = {}) => app.request("/superadmin/copiloto/estado", { headers: bearer(token, extra) });
  return { s, app, deps, zona, cfo, scripted, conv, pins, bitacora, limiter, ledger, falsas, alta, activarMfa, post, turno, estado };
}

const LLM_ORGANIZACIONES: ScriptStep[] = [{ toolCalls: [{ name: "organizaciones", argumentsJson: "{}" }] }, { text: "Hay 3 organizaciones y 1 activas." }];

describe("acceso: solo superadmin y finanzas", () => {
  it("403 a un staff comun y 401 sin token, en el chat, el estado y las conversaciones", async () => {
    const ctx = await setup();
    const staff = await ctx.s.staff();
    for (const res of [await ctx.post(staff.token, { question: "hola" }), await ctx.estado(staff.token), await ctx.app.request("/superadmin/copiloto/conversaciones", { headers: bearer(staff.token) })]) {
      expect(res.status).toBe(403);
    }
    expect((await ctx.app.request("/superadmin/copiloto/estado")).status).toBe(401);
    expect((await ctx.app.request("/superadmin/copiloto", jsonRequestInit({ question: "hola" }))).status).toBe(401);
    expect(ctx.scripted.requests).toHaveLength(0);
  });

  it("el superadmin completo ve las 22 herramientas en el estado; las financieras vienen marcadas", async () => {
    const ctx = await setup();
    const sa = await ctx.alta();
    const res = await ctx.estado(sa.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { permitido: boolean; motivo: string | null; rol: string; herramientas: { nombre: string; financiera: boolean }[]; interruptor: { apagado: boolean }; gastoMes: { topeMicroUsd: number }; financierasDisponibles: boolean };
    expect(body).toMatchObject({ permitido: true, motivo: null, rol: "superadmin", financierasDisponibles: true, interruptor: { apagado: false } });
    expect(body.herramientas).toHaveLength(22);
    expect((body as unknown as { fijados: boolean }).fijados).toBe(true);
    expect(body.herramientas.filter((h) => h.financiera).map((h) => h.nombre).sort()).toEqual(["contratos_por_vencer", "facturacion_cobranza", "margen_costos_unitarios", "mrr", "pyl"]);
    expect(body.gastoMes.topeMicroUsd).toBe(25_000_000);
  });

  it("sin proveedor de IA el estado dice 'no_activado' y el chat responde honesto sin consultar; la consulta directa (sin modelo) sigue funcionando", async () => {
    const ctx = await setup({ sinProveedor: true, modo: "falsas" });
    const sa = await ctx.alta();
    const e = (await (await ctx.estado(sa.token)).json()) as { disponible: boolean; permitido: boolean; motivo: string };
    expect(e).toMatchObject({ disponible: false, permitido: false, motivo: "no_activado" });
    expect(await ctx.turno(sa.token, { question: "cuantas organizaciones hay" })).toEqual(COPILOTO_NO_ACTIVADO);
    const directa = await ctx.turno(sa.token, { tool: "organizaciones" });
    expect(directa.status).toBe("ok");
    expect(directa.blocks[0]?.tool).toBe("organizaciones");
  });

  it("sin AppDeps.superadminCopiloto las rutas responden 'no activado' (nunca 500)", async () => {
    const s = await seguridadSetup();
    const app = buildApp({ ...s.deps, cfoZoneRepo: undefined });
    const sa = await s.superadmin();
    const res = await app.request("/superadmin/copiloto", jsonRequestInit({ question: "hola" }, bearer(sa.token)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(COPILOTO_NO_ACTIVADO);
  });

  it("el cuerpo solo aporta pregunta, historial y conversacion: cualquier otro campo (organizacion, rol, SQL) es 400", async () => {
    const ctx = await setup();
    const sa = await ctx.alta();
    for (const extra of [{ organizationId: randomUUID() }, { rol: "finanzas" }, { sql: "select 1" }, { stepUp: true }]) {
      expect((await ctx.post(sa.token, { question: "hola", ...extra })).status).toBe(400);
    }
    expect(ctx.scripted.requests).toHaveLength(0);
  });
});

describe("impersonacion: 409", () => {
  async function impersonando() {
    const ctx = await setup({ modo: "falsas", steps: LLM_ORGANIZACIONES });
    const sa = await ctx.alta();
    const imp = ctx.s.base.deps.impersonationRepo({} as never) as InMemoryImpersonationRepository;
    imp.seedPlatformSuperadmin(sa.id, sa.email);
    const sesion = await imp.startSession(sa.id, ctx.s.base.organizationId, "Soporte del cliente: revisar el pedido 123 de ayer");
    return { ctx, sa, imp, sesion: sesion.session };
  }

  it("con una sesion de impersonacion activa el chat y el estado responden 409 y NO se llama al modelo", async () => {
    const { ctx, sa } = await impersonando();
    const chat = await ctx.post(sa.token, { question: "cuantas organizaciones hay" });
    expect(chat.status).toBe(409);
    expect(JSON.stringify(await chat.json())).toMatch(/conflict/);
    expect((await ctx.estado(sa.token)).status).toBe(409);
    expect((await ctx.post(sa.token, { tool: "organizaciones" })).status).toBe(409);
    expect(ctx.scripted.requests).toHaveLength(0);
    expect(ctx.bitacora).toHaveLength(0);
  });

  it("al terminar la impersonacion el Copiloto vuelve a funcionar", async () => {
    const { ctx, sa, imp, sesion } = await impersonando();
    expect((await ctx.post(sa.token, { tool: "organizaciones" })).status).toBe(409);
    await imp.endSession(sa.id, sesion.id);
    expect((await ctx.post(sa.token, { tool: "organizaciones" })).status).toBe(200);
  });

  it("las demas escrituras bajo impersonacion siguen bloqueadas (el chat es la unica excepcion): renombrar una conversacion es 403", async () => {
    const { ctx, sa } = await impersonando();
    const res = await ctx.app.request(`/superadmin/copiloto/conversaciones/${randomUUID()}`, { ...jsonRequestInit({ titulo: "x" }, bearer(sa.token)), method: "PATCH" });
    expect(res.status).toBe(403);
  });
});

describe("turno con LLM guionado", () => {
  it("el modelo elige una herramienta del catalogo y la respuesta lleva tabla, fuente que cita la consulta y narrativa respaldada", async () => {
    const ctx = await setup({ modo: "falsas", steps: LLM_ORGANIZACIONES });
    const sa = await ctx.alta();
    const a = await ctx.turno(sa.token, { question: "cuantas organizaciones tenemos" });
    expect(a.status).toBe("ok");
    expect(a.text).toBe("Hay 3 organizaciones y 1 activas.");
    expect(a.toolsUsed).toEqual(["organizaciones"]);
    expect(a.blocks[0]).toMatchObject({ tool: "organizaciones" });
    expect(a.sources[0]?.source).toMatch(/^Consulta «organizaciones»/);
    expect(a.sources[0]?.scopeLabel).toBe("Toda la plataforma");
    // El modelo vio SOLO las herramientas del catalogo de plataforma (16) y el alcance en el prompt.
    const primera = ctx.scripted.requests[0]!;
    expect(primera.tools?.map((t) => t.name).sort()).toHaveLength(23); // 19 de lectura + proponer_accion (CHAT-17: solo propone)
    expect(primera.system).toMatch(/Plataforma completa \(superadmin\)/);
  });

  it("guardia de cifras: una cifra que no esta en los resultados se RECHAZA y se muestra el texto determinista", async () => {
    const ctx = await setup({ modo: "falsas", steps: [{ toolCalls: [{ name: "organizaciones", argumentsJson: "{}" }] }, { text: "Hay 777 organizaciones activas." }] });
    const sa = await ctx.alta();
    const a = await ctx.turno(sa.token, { question: "cuantas organizaciones activas hay" });
    expect(a.status).toBe("ok");
    expect(a.text).not.toContain("777");
    expect(a.text).toBe("3 organizaciones, 1 activas.");
  });

  it("pregunta fuera del catalogo: 'no tengo el dato', sin cifras y con la lista de lo que si puede responder", async () => {
    const ctx = await setup({ modo: "falsas", steps: [{ text: "Tienes 99 clientes felices." }] });
    const sa = await ctx.alta();
    const a = await ctx.turno(sa.token, { question: "como va el clima hoy" });
    expect(a.status).toBe("out_of_catalog");
    expect(a.text).toMatch(/^No tengo el dato/);
    expect(a.text).not.toContain("99");
    expect(a.text).toContain("Organizaciones y personal");
    expect(a.blocks).toEqual([]);
  });

  it("una herramienta que el modelo inventa o con argumentos fuera del esquema NO se ejecuta (catalogo cerrado, sin SQL libre)", async () => {
    const ctx = await setup({
      modo: "falsas",
      steps: [{ toolCalls: [{ name: "ejecutar_sql", argumentsJson: JSON.stringify({ sql: "select * from core.organization" }) }] }, { toolCalls: [{ name: "organizaciones", argumentsJson: JSON.stringify({ vertical: "todas; drop table x" }) }] }, { text: "No pude consultar eso." }],
    });
    const sa = await ctx.alta();
    const a = await ctx.turno(sa.token, { question: "dame todo" });
    expect(a.toolsUsed).toEqual([]);
    expect(a.blocks).toEqual([]);
    expect(a.status).not.toBe("ok");
    expect(ctx.bitacora.map((e) => e.outcome)).toEqual(expect.arrayContaining(["denied", "error"]));
  });

  it("20 preguntas por minuto por usuario: el limite se pide al limitador con esa clave y, agotado, el turno no consulta ni llama al modelo", async () => {
    let permitido = true;
    const ctx = await setup({ modo: "falsas", steps: LLM_ORGANIZACIONES, permitirTurnos: () => permitido });
    const sa = await ctx.alta();
    await ctx.turno(sa.token, { question: "cuantas organizaciones tenemos" });
    const usuario = ctx.limiter.find((l) => l.key.startsWith("datachat:u:"));
    expect(usuario).toEqual({ key: `datachat:u:plataforma:${sa.id}`, limit: 20, windowMs: 60_000 });
    const llamadasAntes = ctx.scripted.requests.length;
    permitido = false;
    const a = await ctx.turno(sa.token, { question: "otra vez" });
    expect(a.status).toBe("rate_limited");
    expect(ctx.scripted.requests).toHaveLength(llamadasAntes);
  });

  it("modo NDJSON: pasos en vivo y un evento final; la respuesta es la misma", async () => {
    const ctx = await setup({ modo: "falsas" });
    const sa = await ctx.alta();
    const res = await ctx.post(sa.token, { tool: "salud_colas" }, { accept: "application/x-ndjson" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/x-ndjson/);
    const lineas = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { t: string; fase?: string; herramienta?: string; respuesta?: DataChatAnswer });
    expect(lineas[0]).toEqual({ t: "paso", fase: "inicio", herramienta: "salud_colas" });
    expect(lineas[lineas.length - 1]?.t).toBe("fin");
    expect(lineas[lineas.length - 1]?.respuesta?.blocks[0]?.tool).toBe("salud_colas");
  });

  it("si el cliente corta la conexion (abort) el turno se cancela antes de consultar o llamar al modelo", async () => {
    const ctx = await setup({ modo: "falsas", steps: LLM_ORGANIZACIONES });
    const sa = await ctx.alta();
    const abort = new AbortController();
    abort.abort();
    const res = await ctx.app.request("/superadmin/copiloto", { ...jsonRequestInit({ question: "cuantas organizaciones tenemos" }, bearer(sa.token)), signal: abort.signal });
    expect(res.status).toBe(200);
    expect(((await res.json()) as DataChatAnswer).text).toBe("La consulta se canceló.");
    expect(ctx.scripted.requests).toHaveLength(0);
  });
});

describe("cada herramienta del catalogo, elegida por un LLM guionado", () => {
  const ARGS: Record<string, Record<string, string>> = { costos_ia: { periodo: "este_mes" }, uso_por_vertical: { periodo: "ultimos_7_dias" }, uso_copiloto: { periodo: "este_mes" }, ranking_organizaciones: { periodo: "este_mes" }, ranking_actividad: { periodo: "este_mes" }, operaciones_organizacion: { periodo: "este_mes", organizacion: "Taquería Don Beto" }, agentes_organizacion: { periodo: "este_mes", organizacion: "Taquería Don Beto" } };

  it.each([...HERRAMIENTAS_OPERATIVAS, ...HERRAMIENTAS_FINANCIERAS])("%s: el modelo la pide, el motor la ejecuta con alcance de plataforma y la respuesta lleva su tabla y su fuente", async (nombre) => {
    const ctx = await setup({ modo: "falsas", steps: [{ toolCalls: [{ name: nombre, argumentsJson: JSON.stringify(ARGS[nombre] ?? {}) }] }, { text: "Aquí está la consulta que pediste." }] });
    const sa = await ctx.alta();
    const a = await ctx.turno(sa.token, { question: `consulta ${nombre}` });
    expect(a.status).toBe("ok");
    expect(a.toolsUsed).toEqual([nombre]);
    expect(a.blocks).toHaveLength(1);
    expect(a.blocks[0]).toMatchObject({ kind: "table", tool: nombre });
    expect(a.blocks[0]!.rows.length).toBeGreaterThan(0);
    expect(a.sources[0]?.source).toContain(`«${nombre}»`);
    // Las lecturas de UNA organizacion citan esa organizacion y su vertical; el resto, toda la plataforma.
    expect(a.sources[0]?.scopeLabel).toBe(["operaciones_organizacion", "agentes_organizacion"].includes(nombre) ? "Taquería Don Beto · restaurantes" : "Toda la plataforma");
    const cfo = HERRAMIENTAS_FINANCIERAS.includes(nombre);
    expect(ctx.falsas.accesosCfo.map((x) => x.recurso)).toEqual(cfo ? [`copiloto/${nombre}`] : []);
    // Las lecturas por organizacion dejan SIEMPRE su fila de bitacora por organizacion; el resto, ninguna.
    expect(ctx.falsas.accesosOrg.map((x) => x.herramienta)).toEqual(["operaciones_organizacion", "agentes_organizacion", "ranking_actividad"].includes(nombre) ? [nombre] : []);
  });
});

describe("interruptor 'agente superadmin:copiloto' y tope mensual propio", () => {
  async function apagar(ctx: Awaited<ReturnType<typeof setup>>, sa: { id: string }) {
    await ctx.s.switches.setSwitch(sa.id, "agente", "superadmin:copiloto", true, "Pausa del Copiloto por revision de costos del trimestre");
    ctx.deps.platformSwitchGuard!.invalidate();
  }

  it("con el interruptor apagado el turno responde honesto SIN llamar al modelo y las consultas directas (sin IA) siguen disponibles", async () => {
    const ctx = await setup({ modo: "falsas", steps: LLM_ORGANIZACIONES });
    const sa = await ctx.alta();
    await apagar(ctx, sa);
    const a = await ctx.turno(sa.token, { question: "cuantas organizaciones tenemos" });
    expect(a.status).toBe("unavailable");
    expect(a.noAi?.reason).toBe("kill_switch");
    expect(a.noAi?.options.map((o) => o.tool)).toContain("organizaciones");
    expect(a.text).toMatch(/pausada/);
    expect(ctx.scripted.requests).toHaveLength(0);
    const directa = await ctx.turno(sa.token, { tool: "organizaciones" });
    expect(directa.status).toBe("ok");
    expect(ctx.scripted.requests).toHaveLength(0);
    const e = (await (await ctx.estado(sa.token)).json()) as { permitido: boolean; motivo: string; interruptor: { apagado: boolean; clave: string } };
    expect(e).toMatchObject({ permitido: false, motivo: "interruptor_apagado", interruptor: { apagado: true, clave: "agente:superadmin:copiloto" } });
  });

  it("el interruptor global de IA tambien lo detiene", async () => {
    const ctx = await setup({ modo: "falsas", steps: LLM_ORGANIZACIONES });
    const sa = await ctx.alta();
    await ctx.s.switches.setSwitch(sa.id, "global", "llm", true, "Pausa global por incidente del proveedor de modelos");
    ctx.deps.platformSwitchGuard!.invalidate();
    const a = await ctx.turno(sa.token, { question: "cuantas organizaciones tenemos" });
    expect(a.noAi?.reason).toBe("kill_switch");
    expect(ctx.scripted.requests).toHaveLength(0);
  });

  it("tope mensual propio agotado (medido en la bitacora): modo sin IA, sin llamar al modelo; el estado lo anuncia", async () => {
    const ctx = await setup({ modo: "falsas", steps: LLM_ORGANIZACIONES, fuentes: { copilotoGastoMes: async () => ({ ok: true, data: 30_000_000 }) } });
    const sa = await ctx.alta();
    const a = await ctx.turno(sa.token, { question: "cuantas organizaciones tenemos" });
    expect(a.status).toBe("budget_exceeded");
    expect(a.noAi?.reason).toBe("budget");
    expect(ctx.scripted.requests).toHaveLength(0);
    const e = (await (await ctx.estado(sa.token)).json()) as { permitido: boolean; motivo: string; gastoMes: { usadoMicroUsd: number; usoPct: number; medidoEnBitacora: boolean } };
    expect(e).toMatchObject({ permitido: false, motivo: "tope_mensual", gastoMes: { usadoMicroUsd: 30_000_000, usoPct: 100, medidoEnBitacora: true } });
  });

  it("el gasto real de cada turno se acumula en la instancia: tras gastar el tope el siguiente turno ya no llama al modelo (base sin migrar incluida)", async () => {
    const ctx = await setup({
      modo: "falsas",
      steps: LLM_ORGANIZACIONES,
      topeMensualMicroUsd: 20_000,
      costoUsdPorLlamada: 0.03,
      fuentes: { copilotoGastoMes: async () => ({ ok: false, razon: "no_migrado" }) },
    });
    const sa = await ctx.alta();
    const primero = await ctx.turno(sa.token, { question: "cuantas organizaciones tenemos" });
    expect(primero.status).toBe("ok");
    const llamadas = ctx.scripted.requests.length;
    expect(llamadas).toBe(2);
    expect(ctx.ledger.mes()).toBe(60_000);
    const segundo = await ctx.turno(sa.token, { question: "y ahora cuantas" });
    expect(segundo.status).toBe("budget_exceeded");
    expect(ctx.scripted.requests).toHaveLength(llamadas);
  });
});

describe("notificacion in-app del tope mensual propio (superadmin.copiloto.tope_mensual)", () => {
  /** Registra las llamadas a core.emit_notification (el motor en memoria no la modela) y las da por emitidas. */
  function grabarNotificaciones(engine: InMemoryTenancyEngine): { userId: string | null; params: unknown[] }[] {
    const emitidas: { userId: string | null; params: unknown[] }[] = [];
    const original = engine.withAppSession.bind(engine);
    engine.withAppSession = (async (claims: { userId: string | null }, fn: (s: TenantDbSession) => Promise<unknown>) =>
      original(claims, async (session) =>
        fn({
          ...session,
          query: async (sql: string, params: unknown[] = []) => {
            if (sql.includes("core.emit_notification")) {
              emitidas.push({ userId: claims.userId, params });
              return { rows: [{ emit_notification: 1 }] };
            }
            return session.query(sql, params);
          },
        } as TenantDbSession),
      )) as typeof engine.withAppSession;
    return emitidas;
  }

  it("al 80 % del tope avisa UNA vez (sesion de sistema, sin organizacion, solo el porcentaje) y el turno sigue; al 100 % avisa y responde sin IA", async () => {
    const ctx = await setup({ modo: "falsas", steps: LLM_ORGANIZACIONES, fuentes: { copilotoGastoMes: async () => ({ ok: true, data: 20_000_000 }) } });
    const emitidas = grabarNotificaciones(ctx.s.base.deps.engine as InMemoryTenancyEngine);
    const sa = await ctx.alta();
    const a = await ctx.turno(sa.token, { question: "cuantas organizaciones tenemos" });
    expect(a.status).toBe("ok");
    await ctx.turno(sa.token, { question: "y de nuevo" });
    expect(emitidas).toHaveLength(1);
    expect(emitidas[0]!.userId).toBeNull();
    expect(emitidas[0]!.params[0]).toBeNull();
    expect(emitidas[0]!.params[2]).toBe("superadmin.copiloto.tope_mensual");
    expect(emitidas[0]!.params[5]).toBe("El Copiloto de superadmin usó 80 por ciento de su tope mensual");
    expect(String(emitidas[0]!.params[10])).toMatch(/^superadmin\.copiloto\.tope_mensual:80:\d{4}-\d{2}$/);
    expect(emitidas[0]!.params[7]).toBe("/superadmin/consumo-ia");
    // Cruza el 100 %: segundo umbral, y el modelo ya no se llama.
    (ctx.deps.superadminCopiloto as { fuentes: unknown }).fuentes = (db: TenantDbSession, id: string) => ({ ...fuentesDeProduccion(ctx.deps, db, id), ...fuentesFalsas({ copilotoGastoMes: async () => ({ ok: true, data: 26_000_000 }) }) });
    const llamadas = ctx.scripted.requests.length;
    const b = await ctx.turno(sa.token, { question: "otra mas" });
    expect(b.status).toBe("budget_exceeded");
    expect(ctx.scripted.requests).toHaveLength(llamadas);
    expect(emitidas).toHaveLength(2);
    expect(String(emitidas[1]!.params[10])).toMatch(/:100:/);
    expect(JSON.stringify(emitidas)).not.toContain(sa.email);
  });

  it("por debajo del 80 % no avisa", async () => {
    const ctx = await setup({ modo: "falsas", steps: LLM_ORGANIZACIONES, fuentes: { copilotoGastoMes: async () => ({ ok: true, data: 5_000_000 }) } });
    const emitidas = grabarNotificaciones(ctx.s.base.deps.engine as InMemoryTenancyEngine);
    const sa = await ctx.alta();
    await ctx.turno(sa.token, { question: "cuantas organizaciones tenemos" });
    expect(emitidas).toHaveLength(0);
  });
});

describe("herramientas financieras: step-up, rol finanzas y huella en core.cfo_access_log", () => {
  it("consulta directa a una herramienta CFO SIN step-up (con MFA activa): 403 stepup_required ANTES de abrir el flujo, huella 'denegado' y cero lecturas", async () => {
    const ctx = await setup();
    const sa = await ctx.alta();
    await ctx.activarMfa(sa);
    const res = await ctx.post(sa.token, { tool: "mrr" });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/stepup_required/);
    expect(ctx.zona.entries().map((e) => [e.accion, e.recurso])).toEqual([["denegado", "copiloto/mrr (sin step-up)"]]);
    expect(ctx.bitacora).toHaveLength(0);
  });

  it("con step-up valido la herramienta CFO responde con cifras, cita la consulta y deja UNA fila de 'consulta' con herramienta y parametros", async () => {
    const ctx = await setup();
    const sa = await ctx.alta();
    const stepUp = await ctx.activarMfa(sa);
    const a = await ctx.turno(sa.token, { tool: "mrr", args: { mes: "2026-10" } }, { "x-stepup-token": stepUp });
    expect(a.status).toBe("ok");
    expect(a.blocks[0]?.tool).toBe("mrr");
    expect(a.sources[0]?.source).toMatch(/^Consulta «mrr» \(mes=2026-10\)/);
    const filas = ctx.zona.entries().filter((e) => e.accion === "consulta");
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ actorUserId: sa.id, actorRol: "superadmin", recurso: "copiloto/mrr" });
    expect(filas[0]!.filtros).toMatchObject({ herramienta: "mrr", mes: "2026-10", _ruta: "/superadmin/copiloto" });
  });

  it("una herramienta CFO que pide el MODELO sin step-up se niega: 'no tengo el dato', huella 'denegado', ninguna fila de 'consulta' y sin cifras", async () => {
    const ctx = await setup({ steps: [{ toolCalls: [{ name: "pyl", argumentsJson: "{}" }] }, { text: "El P&L es de 1,500 pesos." }] });
    const sa = await ctx.alta();
    await ctx.activarMfa(sa);
    const a = await ctx.turno(sa.token, { question: "dame el pyl del mes" });
    expect(a.status).toBe("unavailable");
    expect(a.text).toMatch(/^No tengo el dato: las consultas financieras exigen verificar tu código MFA/);
    expect(a.blocks).toEqual([]);
    expect(ctx.zona.entries().map((e) => e.accion)).toEqual(["denegado"]);
  });

  it("superadmin sin factor MFA activo (politica vigente, sin MFA obligatoria): las financieras funcionan y dejan huella", async () => {
    const ctx = await setup({ steps: [{ toolCalls: [{ name: "mrr", argumentsJson: "{}" }] }, { text: "El MRR es de 1,598 pesos." }] });
    const sa = await ctx.alta();
    const a = await ctx.turno(sa.token, { question: "cual es el mrr" });
    expect(a.status).toBe("ok");
    expect(a.blocks[0]?.tool).toBe("mrr");
    expect(ctx.zona.entries().map((e) => [e.accion, e.recurso])).toEqual([["consulta", "copiloto/mrr"]]);
  });

  it("con SUPERADMIN_MFA_REQUIRED las financieras exigen step-up aunque no haya factor (403) y nada se lee", async () => {
    const s = await seguridadSetup({ env: { superadminMfaRequired: true } });
    const zona = new InMemoryCfoZoneRepository();
    const cfo = new InMemoryCfoRepository();
    cfo.seedRows([FILA_CFO]);
    const deps: AppDeps = { ...s.deps, cfoRepo: () => cfo, cfoZoneRepo: () => zona, superadminCopiloto: { completion: undefined, rateLimiter: { allow: async () => true }, ledger: crearLedgerMensual() } };
    const app = buildApp(deps);
    const sa = await s.superadmin();
    cfo.seedSuperadmin(sa.id);
    zona.seedSuperadmin(sa.id, sa.email);
    const res = await app.request("/superadmin/copiloto", jsonRequestInit({ tool: "mrr" }, bearer(sa.token)));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/mfa_enrollment_required/);
    expect(zona.entries().map((e) => e.accion)).toEqual(["denegado"]);
  });

  it("finanzas SIN MFA enrolada: 403 mfa_enrollment_required en el chat (no admite degradarse) y huella 'denegado'", async () => {
    const ctx = await setup({ modo: "falsas" });
    const fin = await ctx.alta({ finanzas: true });
    const res = await ctx.post(fin.token, { question: "cual es el mrr" });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/mfa_enrollment_required/);
    expect(ctx.zona.entries().map((e) => [e.accion, e.recurso])).toEqual([["denegado", "POST copiloto (sin step-up)"]]);
    expect(ctx.scripted.requests).toHaveLength(0);
  });

  it("finanzas CON step-up: el estado y el catalogo traen SOLO las 4 herramientas financieras y las consultas dejan huella con rol finanzas", async () => {
    const ctx = await setup({ steps: [{ toolCalls: [{ name: "mrr", argumentsJson: "{}" }] }, { text: "El MRR es de 1,598 pesos." }] });
    const fin = await ctx.alta({ finanzas: true });
    const stepUp = await ctx.activarMfa(fin);
    const cab = { "x-stepup-token": stepUp };
    const e = (await (await ctx.estado(fin.token, cab)).json()) as { rol: string; fijados: boolean; herramientas: { nombre: string; financiera: boolean }[]; financierasDisponibles: boolean };
    expect(e.rol).toBe("finanzas");
    expect(e.fijados).toBe(false); // el tablero de fijados es del superadmin completo
    expect(e.financierasDisponibles).toBe(true);
    expect(e.herramientas.map((h) => h.nombre).sort()).toEqual(["contratos_por_vencer", "facturacion_cobranza", "margen_costos_unitarios", "mrr", "pyl"]);
    expect(e.herramientas.every((h) => h.financiera)).toBe(true);
    const a = await ctx.turno(fin.token, { question: "cual es el mrr" }, cab);
    expect(a.status).toBe("ok");
    // El modelo solo vio las financieras.
    expect(ctx.scripted.requests[0]!.tools?.map((t) => t.name).sort()).toEqual(["contratos_por_vencer", "facturacion_cobranza", "margen_costos_unitarios", "mrr", "pyl"]);
    expect(ctx.zona.entries().filter((x) => x.accion === "consulta").map((x) => [x.actorRol, x.recurso])).toEqual([["finanzas", "copiloto/mrr"]]);
  });

  it("finanzas NO ejecuta una herramienta operativa ni por consulta directa: 'no existe en tu catalogo' y ninguna lectura", async () => {
    const ctx = await setup({ modo: "falsas" });
    const fin = await ctx.alta({ finanzas: true });
    const stepUp = await ctx.activarMfa(fin);
    for (const tool of ["organizaciones", "costos_ia", "prospectos", "errores", "eventos_seguridad", "uso_copiloto"]) {
      const a = await ctx.turno(fin.token, { tool }, { "x-stepup-token": stepUp });
      expect(a.status, tool).toBe("invalid_input");
      expect(a.blocks, tool).toEqual([]);
      expect(a.toolsUsed, tool).toEqual([]);
    }
    expect(ctx.bitacora.filter((e) => e.outcome === "ok")).toHaveLength(0);
  });

  it("finanzas no renombra ni borra conversaciones (solo lectura): 403 rol_finanzas_solo_lectura, y si puede leer las suyas", async () => {
    const ctx = await setup({ modo: "falsas" });
    const fin = await ctx.alta({ finanzas: true });
    const lista = await ctx.app.request("/superadmin/copiloto/conversaciones", { headers: bearer(fin.token) });
    expect(lista.status).toBe(200);
    const patch = await ctx.app.request(`/superadmin/copiloto/conversaciones/${randomUUID()}`, { ...jsonRequestInit({ titulo: "x" }, bearer(fin.token)), method: "PATCH" });
    expect(patch.status).toBe(403);
    expect(JSON.stringify(await patch.json())).toMatch(/rol_finanzas_solo_lectura/);
    const borrar = await ctx.app.request(`/superadmin/copiloto/conversaciones/${randomUUID()}`, { method: "DELETE", headers: bearer(fin.token) });
    expect(borrar.status).toBe(403);
  });

  it("el rol finanzas sigue sin acceder a las demas rutas de /superadmin (la lista blanca de la zona CFO no se ensancho de mas)", async () => {
    const ctx = await setup({ modo: "falsas" });
    const fin = await ctx.alta({ finanzas: true });
    for (const ruta of ["/superadmin/organizations", "/superadmin/prospectos", "/superadmin/copiloto/otra"]) {
      const res = await ctx.app.request(ruta, { headers: bearer(fin.token) });
      expect(res.status, ruta).toBe(403);
    }
  });
});

describe("bitacora y conversacion con alcance de plataforma", () => {
  it("la bitacora registra quien, que herramienta y con que parametros tipados, y el resumen del turno con el costo real y el rol; nunca resultados ni texto", async () => {
    const ctx = await setup({ modo: "falsas", steps: [{ toolCalls: [{ name: "costos_ia", argumentsJson: JSON.stringify({ periodo: "este_mes", agrupar: "vertical" }) }] }, { text: "Gasto de IA por vertical: 5 USD." }], costoUsdPorLlamada: 0.0125 });
    const sa = await ctx.alta();
    const a = await ctx.turno(sa.token, { question: "cuanto gastamos en IA por vertical este mes" });
    expect(a.status).toBe("ok");
    const herramienta = ctx.bitacora.find((e) => e.tool === "costos_ia")!;
    expect(herramienta).toMatchObject({ userId: sa.id, vertical: "plataforma", outcome: "ok", route: "llm", params: { periodo: "este_mes", agrupar: "vertical" } });
    const resumen = ctx.bitacora.find((e) => e.tool === null && e.costMicroUsd !== undefined)!;
    expect(resumen).toMatchObject({ role: "superadmin:copiloto", route: "llm", costMicroUsd: 25_000 });
    const todo = JSON.stringify(ctx.bitacora);
    expect(todo).not.toMatch(/Taquería|Hotel Bahía|restaurantes:data_chat|cuanto gastamos/);
  });

  it("el turno se guarda en una conversacion de PLATAFORMA (sin organizacion, vertical plataforma), con la pregunta redactada, y se puede continuar", async () => {
    const ctx = await setup({ modo: "falsas", steps: LLM_ORGANIZACIONES });
    const sa = await ctx.alta();
    const primero = await ctx.turno(sa.token, { question: "cuantas organizaciones tenemos, mi correo es yo@ejemplo.com", conversationId: "new" });
    expect(primero.guardado).toBe(true);
    expect(primero.conversationId).toBeDefined();
    expect(primero.seq).toBe(2);
    expect(ctx.conv.appended).toHaveLength(1);
    expect(ctx.conv.appended[0]!.scope).toEqual({ organizationId: null, userId: sa.id, vertical: "plataforma" });
    expect(ctx.conv.appended[0]!.turno).toMatchObject({ propertyId: null, conversationId: null, status: "ok" });
    expect(ctx.conv.appended[0]!.turno.userText).not.toContain("yo@ejemplo.com");
    expect(ctx.conv.appended[0]!.turno.toolCalls).toEqual([{ tool: "organizaciones", args: {} }]);
    // Continuar: el historial sale de la base, no del cliente.
    const segundo = await ctx.turno(sa.token, { question: "y cuantas activas", conversationId: primero.conversationId });
    expect(segundo.conversationId).toBe(primero.conversationId);
    expect(ctx.conv.store[0]!.mensajes).toHaveLength(4);
    expect((await ctx.post(sa.token, { question: "x", conversationId: primero.conversationId, history: [{ role: "user", text: "hola" }] })).status).toBe(400);
  });

  it("conversaciones: solo el autor las ve; otro superadmin recibe 404 (nunca 403) al abrir, renombrar o borrar la ajena; el autor lista, abre, renombra y borra", async () => {
    const ctx = await setup({ modo: "falsas" });
    const a = await ctx.alta();
    const b = await ctx.alta();
    const t = await ctx.turno(a.token, { tool: "organizaciones", conversationId: "new" });
    const id = t.conversationId!;
    const lista = (await (await ctx.app.request("/superadmin/copiloto/conversaciones", { headers: bearer(a.token) })).json()) as { disponible: boolean; conversaciones: { id: string }[] };
    expect(lista.conversaciones.map((c) => c.id)).toEqual([id]);
    const listaB = (await (await ctx.app.request("/superadmin/copiloto/conversaciones", { headers: bearer(b.token) })).json()) as { conversaciones: unknown[] };
    expect(listaB.conversaciones).toEqual([]);
    expect((await ctx.app.request(`/superadmin/copiloto/conversaciones/${id}`, { headers: bearer(b.token) })).status).toBe(404);
    expect((await ctx.app.request(`/superadmin/copiloto/conversaciones/${id}`, { ...jsonRequestInit({ titulo: "robada" }, bearer(b.token)), method: "PATCH" })).status).toBe(404);
    expect((await ctx.app.request(`/superadmin/copiloto/conversaciones/${id}`, { method: "DELETE", headers: bearer(b.token) })).status).toBe(404);
    expect((await ctx.post(b.token, { tool: "organizaciones", conversationId: id })).status).toBe(404);
    const abierta = await ctx.app.request(`/superadmin/copiloto/conversaciones/${id}`, { headers: bearer(a.token) });
    expect(abierta.status).toBe(200);
    expect(((await abierta.json()) as ConversacionDetalleDto).mensajes).toHaveLength(2);
    const renombrada = await ctx.app.request(`/superadmin/copiloto/conversaciones/${id}`, { ...jsonRequestInit({ titulo: "Mis organizaciones" }, bearer(a.token)), method: "PATCH" });
    expect(renombrada.status).toBe(200);
    expect(ctx.conv.store[0]!.titulo).toBe("Mis organizaciones");
    expect((await ctx.app.request(`/superadmin/copiloto/conversaciones/${id}`, { method: "DELETE", headers: bearer(a.token) })).status).toBe(204);
    expect((await ctx.app.request("/superadmin/copiloto/conversaciones/no-es-un-uuid", { headers: bearer(a.token) })).status).toBe(404);
  });

  it("releer una conversacion con herramientas financieras exige step-up y deja fila 'consulta' en cfo_access_log; sin step-up: 403 y huella 'denegado', sin cifras", async () => {
    const ctx = await setup();
    const sa = await ctx.alta();
    const stepUp = await ctx.activarMfa(sa);
    const cab = { "x-stepup-token": stepUp };
    const t = await ctx.turno(sa.token, { tool: "mrr", args: { mes: "2026-10" }, conversationId: "new" }, cab);
    const id = t.conversationId!;
    const antes = ctx.zona.entries().filter((e) => e.recurso === "copiloto/conversaciones/:id").length;
    expect(antes).toBe(0);
    // Sin step-up: ni cifras ni lectura; queda una fila 'denegado'.
    const sin = await ctx.app.request(`/superadmin/copiloto/conversaciones/${id}`, { headers: bearer(sa.token) });
    expect(sin.status).toBe(403);
    expect(JSON.stringify(await sin.json())).not.toMatch(/mensajes|blocks|text/);
    expect(ctx.zona.entries().filter((e) => e.accion === "denegado" && /conversaciones/.test(e.recurso))).toHaveLength(1);
    expect(ctx.zona.entries().filter((e) => e.accion === "consulta" && e.recurso === "copiloto/conversaciones/:id")).toHaveLength(0);
    // Con step-up: responde y deja UNA fila de 'consulta'.
    const con = await ctx.app.request(`/superadmin/copiloto/conversaciones/${id}`, { headers: bearer(sa.token, cab) });
    expect(con.status).toBe(200);
    expect(((await con.json()) as ConversacionDetalleDto).mensajes).toHaveLength(2);
    const filas = ctx.zona.entries().filter((e) => e.accion === "consulta" && e.recurso === "copiloto/conversaciones/:id");
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ actorUserId: sa.id, actorRol: "superadmin" });
    expect(filas[0]!.filtros).toMatchObject({ herramientas: ["mrr"] });
  });

  it("finanzas relee su conversacion financiera SOLO con step-up (y deja huella); una conversacion operativa no pide step-up ni deja fila", async () => {
    const ctx = await setup();
    const fin = await ctx.alta({ finanzas: true });
    const stepUp = await ctx.activarMfa(fin);
    const cab = { "x-stepup-token": stepUp };
    const t = await ctx.turno(fin.token, { tool: "mrr", args: { mes: "2026-10" }, conversationId: "new" }, cab);
    const url = `/superadmin/copiloto/conversaciones/${t.conversationId}`;
    expect((await ctx.app.request(url, { headers: bearer(fin.token) })).status).toBe(403);
    expect((await ctx.app.request(url, { headers: bearer(fin.token, cab) })).status).toBe(200);
    expect(ctx.zona.entries().filter((e) => e.accion === "consulta" && e.recurso === "copiloto/conversaciones/:id")).toHaveLength(1);

    const ctx2 = await setup({ modo: "falsas" });
    const sa = await ctx2.alta();
    await ctx2.activarMfa(sa);
    const op = await ctx2.turno(sa.token, { tool: "organizaciones", conversationId: "new" });
    const abierta = await ctx2.app.request(`/superadmin/copiloto/conversaciones/${op.conversationId}`, { headers: bearer(sa.token) });
    expect(abierta.status).toBe(200);
    expect(ctx2.zona.entries().filter((e) => e.recurso === "copiloto/conversaciones/:id")).toHaveLength(0);
  });

  it("un turno que no es parte de la conversacion (tope, rate limit, no activado) no se guarda", async () => {
    const ctx = await setup({ modo: "falsas", permitirTurnos: () => false });
    const sa = await ctx.alta();
    const a = await ctx.turno(sa.token, { question: "hola", conversationId: "new" });
    expect(a.status).toBe("rate_limited");
    expect(ctx.conv.appended).toHaveLength(0);
  });
});

describe("alcance multi-organizacion: bitacora, rol y redaccion", () => {
  it("buscar_organizacion: la bitacora guarda quien consulto, la herramienta y la organizacion buscada, sin filas de resultado ni ids", async () => {
    const ctx = await setup({ modo: "falsas", sinProveedor: true });
    const sa = await ctx.alta();
    const a = await ctx.turno(sa.token, { tool: "buscar_organizacion", args: { nombre: "Taquería" } });
    expect(a.status).toBe("ok");
    expect(a.blocks[0]!.rows.map((r) => (r as { organizacion: string }).organizacion)).toEqual(["Taquería Don Beto"]);
    expect(ctx.bitacora).toHaveLength(1);
    expect(ctx.bitacora[0]).toMatchObject({ tool: "buscar_organizacion", userId: sa.id, vertical: "plataforma", outcome: "ok", rowCount: 1, params: { nombre: "Taquería" } });
    expect(JSON.stringify(ctx.bitacora)).not.toMatch(/org-a|Don Beto/);
  });

  it("el rol finanzas no puede ejecutar buscar_organizacion ni ranking_organizaciones (fuera de su catalogo)", async () => {
    const ctx = await setup({ modo: "falsas", sinProveedor: true });
    const fin = await ctx.alta({ finanzas: true });
    for (const tool of ["buscar_organizacion", "ranking_organizaciones"]) {
      const res = await ctx.app.request("/superadmin/copiloto", jsonRequestInit({ tool, args: tool === "ranking_organizaciones" ? { periodo: "este_mes" } : {} }, bearer(fin.token)));
      expect(res.status, tool).toBe(403);
    }
    expect(ctx.bitacora).toHaveLength(0);
  });
});

describe("compatibilidad: la bitacora y las fuentes no tumban el turno", () => {
  it("si la bitacora de plataforma falla el turno se responde igual (el motor la envuelve)", async () => {
    const ctx = await setup({ modo: "falsas", steps: LLM_ORGANIZACIONES });
    const sa = await ctx.alta();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    (ctx.deps.superadminCopiloto as { audit?: unknown }).audit = () => ({
      record: async () => {
        throw new Error("bitacora caida");
      },
    });
    const a = await ctx.turno(sa.token, { question: "cuantas organizaciones tenemos" });
    spy.mockRestore();
    expect(a.status).toBe("ok");
  });
});

describe("reporte PDF de un mensaje (paridad con las verticales)", () => {
  const pdf = (ctx: Awaited<ReturnType<typeof setup>>, token: string, id: string, seq: number | string, extra: Record<string, string> = {}) =>
    ctx.app.request(`/superadmin/copiloto/conversaciones/${id}/reporte?seq=${seq}`, { method: "POST", headers: bearer(token, extra) });

  it("el autor descarga el PDF de una consulta operativa (sin IA el PDF sale solo con datos y lo dice); la bitacora registra la re-consulta sin resultados", async () => {
    const ctx = await setup({ modo: "falsas", sinProveedor: true });
    const sa = await ctx.alta();
    const t = await ctx.turno(sa.token, { tool: "organizaciones", conversationId: "new" });
    const antes = ctx.bitacora.length;
    const res = await pdf(ctx, sa.token, t.conversationId!, t.seq!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="reporte-plataforma-\d{4}-\d{2}-\d{2}\.pdf"$/);
    expect(res.headers.get("x-reporte-narrativa")).toBe("no_disponible");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const nuevas = ctx.bitacora.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ tool: "organizaciones", outcome: "ok", userId: sa.id, vertical: "plataforma" });
    expect(JSON.stringify(nuevas)).not.toMatch(/Taquer/);
  });

  it("solo el autor: otro superadmin recibe 404 (nunca 403); id mal formado 404; seq invalido 400; sin token 401", async () => {
    const ctx = await setup({ modo: "falsas", sinProveedor: true });
    const a = await ctx.alta();
    const b = await ctx.alta();
    const t = await ctx.turno(a.token, { tool: "organizaciones", conversationId: "new" });
    expect((await pdf(ctx, b.token, t.conversationId!, t.seq!)).status).toBe(404);
    expect((await pdf(ctx, a.token, "no-es-uuid", 2)).status).toBe(404);
    expect((await pdf(ctx, a.token, t.conversationId!, 999)).status).toBe(400);
    expect((await pdf(ctx, a.token, t.conversationId!, "x")).status).toBe(400);
    expect((await pdf(ctx, a.token, t.conversationId!, 1)).status).toBe(404); // el mensaje 1 es de la persona, no del asistente
    expect((await ctx.app.request(`/superadmin/copiloto/conversaciones/${t.conversationId}/reporte?seq=2`, { method: "POST" })).status).toBe(401);
  });

  it("una consulta financiera exige step-up: sin el, 403 stepup_required ANTES de consultar y con huella 'denegado'; con el, PDF y huella 'consulta'", async () => {
    const ctx = await setup();
    const sa = await ctx.alta();
    const stepUp = await ctx.activarMfa(sa);
    const cab = { "x-stepup-token": stepUp };
    const t = await ctx.turno(sa.token, { tool: "mrr", args: { mes: "2026-10" }, conversationId: "new" }, cab);
    const consultasAntes = ctx.zona.entries().filter((e) => e.accion === "consulta" && e.recurso === "copiloto/mrr").length;
    const sin = await pdf(ctx, sa.token, t.conversationId!, t.seq!);
    expect(sin.status).toBe(403);
    expect(JSON.stringify(await sin.json())).toMatch(/stepup_required/);
    expect(ctx.zona.entries().filter((e) => e.accion === "denegado" && /reporte/.test(e.recurso))).toHaveLength(1);
    expect(ctx.zona.entries().filter((e) => e.accion === "consulta" && e.recurso === "copiloto/mrr")).toHaveLength(consultasAntes);
    const con = await pdf(ctx, sa.token, t.conversationId!, t.seq!, cab);
    expect(con.status).toBe(200);
    expect(con.headers.get("content-type")).toBe("application/pdf");
    expect(ctx.zona.entries().filter((e) => e.accion === "consulta" && e.recurso === "copiloto/mrr")).toHaveLength(consultasAntes + 1);
  });

  it("finanzas descarga el PDF de su consulta financiera SOLO con step-up", async () => {
    const ctx = await setup();
    const fin = await ctx.alta({ finanzas: true });
    const stepUp = await ctx.activarMfa(fin);
    const cab = { "x-stepup-token": stepUp };
    const t = await ctx.turno(fin.token, { tool: "mrr", args: { mes: "2026-10" }, conversationId: "new" }, cab);
    expect((await pdf(ctx, fin.token, t.conversationId!, t.seq!)).status).toBe(403);
    expect((await pdf(ctx, fin.token, t.conversationId!, t.seq!, cab)).status).toBe(200);
  });

  it("jamas re-ejecuta `proponer_accion`: una respuesta que solo propuso una accion no tiene cifras para un reporte (422) y no se crea ninguna propuesta", async () => {
    const ctx = await setup({ modo: "falsas", sinProveedor: true });
    const sa = await ctx.alta();
    const t = await ctx.turno(sa.token, { tool: "organizaciones", conversationId: "new" });
    ctx.conv.store[0]!.llamadas = [{ tool: "proponer_accion", args: { tipo: "apagar_agente" } }];
    const res = await pdf(ctx, sa.token, t.conversationId!, t.seq!);
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/report_no_data/);
  });

  it("limite de reportes por usuario (fail-closed): sin cupo, 429 y sin consultar", async () => {
    let cupo = true;
    const ctx = await setup({ modo: "falsas", sinProveedor: true, permitirTurnos: () => cupo });
    const sa = await ctx.alta();
    const t = await ctx.turno(sa.token, { tool: "organizaciones", conversationId: "new" });
    cupo = false;
    const antes = ctx.bitacora.length;
    expect((await pdf(ctx, sa.token, t.conversationId!, t.seq!)).status).toBe(429);
    expect(ctx.bitacora.length).toBe(antes);
    expect(ctx.limiter.at(-1)).toMatchObject({ key: `superadmin:copiloto:reporte:u:${sa.id}`, limit: 6 });
  });
});


describe("fijados del tablero (personales, sin organizacion)", () => {
  const pedir = (ctx: Awaited<ReturnType<typeof setup>>, token: string, metodo: string, ruta: string, cuerpo?: unknown) =>
    ctx.app.request(`/superadmin/copiloto/pins${ruta}`, cuerpo === undefined ? { method: metodo, headers: bearer(token) } : { ...jsonRequestInit(cuerpo, bearer(token)), method: metodo });

  async function conUnaConsulta(opciones: Opciones = {}) {
    const ctx = await setup({ modo: "falsas", sinProveedor: true, ...opciones });
    const sa = await ctx.alta();
    const t = await ctx.turno(sa.token, { tool: "ranking_actividad", args: { periodo: "este_mes" }, conversationId: "new" });
    return { ctx, sa, t };
  }

  it("fijar guarda herramienta + argumentos (no cifras), lo lista el autor, nunca es compartido y se re-ejecuta sin modelo con el alcance de ahora", async () => {
    const { ctx, sa, t } = await conUnaConsulta();
    const alta = await pedir(ctx, sa.token, "POST", "", { conversationId: t.conversationId, seq: t.seq, bloque: 0 });
    expect(alta.status).toBe(201);
    const { id } = (await alta.json()) as { id: string };
    const lista = (await (await pedir(ctx, sa.token, "GET", "")).json()) as { disponible: boolean; pins: { id: string; herramienta: string; args: Record<string, unknown>; compartido: boolean; propio: boolean }[] };
    expect(lista).toMatchObject({ disponible: true, pins: [{ id, herramienta: "ranking_actividad", args: { periodo: "este_mes" }, compartido: false, propio: true }] });
    ctx.falsas.accesosOrg.length = 0;
    const res = await pedir(ctx, sa.token, "GET", `/${id}/resultado`);
    expect(res.status).toBe(200);
    const r = (await res.json()) as { status: string; blocks: { tool: string }[]; sources: { source: string }[] };
    expect(r.status).toBe("ok");
    expect(r.blocks[0]?.tool).toBe("ranking_actividad");
    // reabrir el fijado es una lectura por organizacion: deja su fila de bitacora y no llama al modelo
    expect(ctx.falsas.accesosOrg.map((a) => a.herramienta)).toEqual(["ranking_actividad"]);
    expect(ctx.scripted.requests).toHaveLength(0);
  });

  it("fijar dos veces lo mismo no duplica; renombrar y quitar funcionan y un id ajeno o mal formado es 404", async () => {
    const { ctx, sa, t } = await conUnaConsulta();
    const cuerpo = { conversationId: t.conversationId, seq: t.seq, bloque: 0 };
    const a = ((await (await pedir(ctx, sa.token, "POST", "", cuerpo)).json()) as { id: string }).id;
    const b = ((await (await pedir(ctx, sa.token, "POST", "", cuerpo)).json()) as { id: string }).id;
    expect(b).toBe(a);
    expect(ctx.pins.store).toHaveLength(1);
    expect((await pedir(ctx, sa.token, "PATCH", `/${a}`, { titulo: "Mi ranking" })).status).toBe(200);
    expect(ctx.pins.store[0]?.titulo).toBe("Mi ranking");
    expect((await pedir(ctx, sa.token, "DELETE", `/${a}`)).status).toBe(204);
    expect((await pedir(ctx, sa.token, "DELETE", `/${a}`)).status).toBe(404);
    expect((await pedir(ctx, sa.token, "GET", `/${randomUUID()}/resultado`)).status).toBe(404);
    expect((await pedir(ctx, sa.token, "GET", "/no-es-un-id/resultado")).status).toBe(404);
  });

  it("no se puede compartir ni editar otra cosa que el titulo (400) y el cuerpo con campos de mas se rechaza", async () => {
    const { ctx, sa, t } = await conUnaConsulta();
    const id = ((await (await pedir(ctx, sa.token, "POST", "", { conversationId: t.conversationId, seq: t.seq, bloque: 0 })).json()) as { id: string }).id;
    expect((await pedir(ctx, sa.token, "PATCH", `/${id}`, { compartido: true })).status).toBe(400);
    expect((await pedir(ctx, sa.token, "PATCH", `/${id}`, { titulo: "ok", herramienta: "mrr" })).status).toBe(400);
    expect((await pedir(ctx, sa.token, "POST", "", { conversationId: t.conversationId, seq: t.seq, bloque: 0, herramienta: "mrr" })).status).toBe(400);
    expect(ctx.pins.store[0]?.compartido).toBe(false);
  });

  it("solo fija resultados de una conversacion PROPIA y de herramientas que siguen en el catalogo de su rol (una propuesta de accion o una herramienta inventada no se fijan)", async () => {
    const { ctx, sa, t } = await conUnaConsulta();
    expect((await pedir(ctx, sa.token, "POST", "", { conversationId: randomUUID(), seq: 2, bloque: 0 })).status).toBe(404);
    ctx.conv.store[0]!.llamadas = [{ tool: "ranking_actividad", args: { periodo: "no_existe" } }];
    expect((await pedir(ctx, sa.token, "POST", "", { conversationId: t.conversationId, seq: t.seq, bloque: 0 })).status).toBe(404);
    const otro = await ctx.alta();
    expect((await pedir(ctx, otro.token, "POST", "", { conversationId: t.conversationId, seq: t.seq, bloque: 0 })).status).toBe(404);
    expect((await pedir(ctx, otro.token, "GET", "")).status).toBe(200);
    expect(((await (await pedir(ctx, otro.token, "GET", "")).json()) as { pins: unknown[] }).pins).toEqual([]);
  });

  it("un fijado de otro superadmin no se lee, renombra ni borra (404)", async () => {
    const { ctx, sa, t } = await conUnaConsulta();
    const id = ((await (await pedir(ctx, sa.token, "POST", "", { conversationId: t.conversationId, seq: t.seq, bloque: 0 })).json()) as { id: string }).id;
    const otro = await ctx.alta();
    expect((await pedir(ctx, otro.token, "GET", `/${id}/resultado`)).status).toBe(404);
    expect((await pedir(ctx, otro.token, "PATCH", `/${id}`, { titulo: "robado" })).status).toBe(404);
    expect((await pedir(ctx, otro.token, "DELETE", `/${id}`)).status).toBe(404);
    expect(ctx.pins.store).toHaveLength(1);
  });

  it("un fijado financiero exige step-up al abrirse (403 stepup_required ANTES de consultar) y con step-up responde", async () => {
    const ctx = await setup({ modo: "falsas", sinProveedor: true });
    const sa = await ctx.alta();
    const stepUp = await ctx.activarMfa(sa);
    const t = await ctx.turno(sa.token, { tool: "mrr", conversationId: "new" }, { "x-stepup-token": stepUp });
    const alta = await ctx.app.request("/superadmin/copiloto/pins", jsonRequestInit({ conversationId: t.conversationId, seq: t.seq, bloque: 0 }, bearer(sa.token)));
    expect(alta.status).toBe(201);
    const { id } = (await alta.json()) as { id: string };
    const sin = await ctx.app.request(`/superadmin/copiloto/pins/${id}/resultado`, { headers: bearer(sa.token) });
    expect(sin.status).toBe(403);
    expect(JSON.stringify(await sin.json())).toMatch(/stepup_required/);
    expect(ctx.zona.entries().filter((e) => e.accion === "consulta").map((e) => e.recurso)).toEqual([]);
    const con = await ctx.app.request(`/superadmin/copiloto/pins/${id}/resultado`, { headers: bearer(sa.token, { "x-stepup-token": stepUp }) });
    expect(con.status).toBe(200);
    expect(((await con.json()) as { status: string }).status).toBe("ok");
  });

  it("el rol finanzas (solo lectura) no usa el tablero: la zona CFO responde 403 en todas las rutas de fijados, incluso con step-up", async () => {
    const ctx = await setup({ modo: "falsas", sinProveedor: true });
    const fin = await ctx.alta({ finanzas: true });
    const stepUp = await ctx.activarMfa(fin);
    const t = await ctx.turno(fin.token, { tool: "mrr", conversationId: "new" }, { "x-stepup-token": stepUp });
    const h = { "x-stepup-token": stepUp };
    for (const res of [
      await ctx.app.request("/superadmin/copiloto/pins", { headers: bearer(fin.token, h) }),
      await ctx.app.request("/superadmin/copiloto/pins", jsonRequestInit({ conversationId: t.conversationId, seq: t.seq, bloque: 0 }, bearer(fin.token, h))),
      await ctx.app.request(`/superadmin/copiloto/pins/${randomUUID()}/resultado`, { headers: bearer(fin.token, h) }),
      await ctx.app.request(`/superadmin/copiloto/pins/${randomUUID()}`, { method: "DELETE", headers: bearer(fin.token, h) }),
    ]) {
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).toMatch(/rol_finanzas_solo_lectura/);
    }
    expect(ctx.pins.store).toEqual([]);
  });

  it("un staff comun recibe 403 y sin token 401 en todas las rutas de fijados", async () => {
    const ctx = await setup();
    const staff = await ctx.s.staff();
    expect((await pedir(ctx, staff.token, "GET", "")).status).toBe(403);
    expect((await pedir(ctx, staff.token, "POST", "", { conversationId: randomUUID(), seq: 2, bloque: 0 })).status).toBe(403);
    expect((await ctx.app.request("/superadmin/copiloto/pins")).status).toBe(401);
  });

  it("con impersonacion activa la lista y la re-ejecucion responden 409 y las escrituras 403", async () => {
    const ctx = await setup({ modo: "falsas", steps: LLM_ORGANIZACIONES });
    const sa = await ctx.alta();
    const imp = ctx.s.base.deps.impersonationRepo({} as never) as InMemoryImpersonationRepository;
    imp.seedPlatformSuperadmin(sa.id, sa.email);
    await imp.startSession(sa.id, ctx.s.base.organizationId, "Soporte del cliente: revisar el pedido 123 de ayer");
    expect((await pedir(ctx, sa.token, "GET", "")).status).toBe(409);
    expect((await pedir(ctx, sa.token, "GET", `/${randomUUID()}/resultado`)).status).toBe(409);
    expect((await pedir(ctx, sa.token, "POST", "", { conversationId: randomUUID(), seq: 2, bloque: 0 })).status).toBe(403);
    expect((await pedir(ctx, sa.token, "DELETE", `/${randomUUID()}`)).status).toBe(403);
  });
});


describe("adjuntar archivo (POST /superadmin/copiloto/adjuntos)", () => {
  const CSV = ["producto,unidades,telefono", "Taco,10,999 123 4567", "Torta,5,998 765 4321"].join("\n");
  const b64 = (t: string): string => Buffer.from(t, "utf8").toString("base64");
  const subir = (ctx: Awaited<ReturnType<typeof setup>>, token: string, cuerpo: unknown, extra: Record<string, string> = {}) =>
    ctx.app.request("/superadmin/copiloto/adjuntos", jsonRequestInit(cuerpo, bearer(token, extra)));

  it("analiza el CSV en el servidor, sin modelo ni guardar nada: perfil por columna, datos personales ocultos y una fila en la bitacora SIN nombre ni contenido", async () => {
    const ctx = await setup({ modo: "falsas", steps: [{ text: "no deberia llamarse" }] });
    const sa = await ctx.alta();
    const res = await subir(ctx, sa.token, { nombre: "ventas-de-ana.csv", contenidoBase64: b64(CSV) });
    expect(res.status).toBe(200);
    const r = (await res.json()) as DataChatAnswer;
    expect(r.status).toBe("ok");
    expect(r.blocks[0]?.tool).toBe("archivo_adjunto");
    expect(r.blocks[0]?.rows.find((x) => x["columna"] === "unidades")).toMatchObject({ tipo: "numérica", suma: 15 });
    expect(r.blocks[0]?.rows.find((x) => x["columna"] === "telefono")).toMatchObject({ tipo: "personal", suma: null });
    expect(JSON.stringify(r)).not.toMatch(/999 123|998 765/);
    expect(ctx.scripted.requests).toHaveLength(0);
    expect(ctx.conv.appended).toHaveLength(0); // el archivo no se guarda en ninguna conversacion
    expect(ctx.bitacora).toHaveLength(1);
    expect(ctx.bitacora[0]).toMatchObject({ tool: "archivo_adjunto", params: { tipo: "csv" }, outcome: "ok", rowCount: 2, userId: sa.id, vertical: "plataforma" });
    expect(JSON.stringify(ctx.bitacora)).not.toContain("ventas-de-ana");
  });

  it("un archivo ilegible responde 200 con el motivo (invalid_input) y lo deja en la bitacora como error", async () => {
    const ctx = await setup({ modo: "falsas" });
    const sa = await ctx.alta();
    const res = await subir(ctx, sa.token, { nombre: "virus.exe", contenidoBase64: b64("MZ") });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "invalid_input", text: "Solo puedo leer archivos CSV, Excel (.xlsx) y PDF.", blocks: [] });
    expect(ctx.bitacora[0]).toMatchObject({ tool: "archivo_adjunto", outcome: "error", rowCount: 0 });
  });

  it("cuerpo mal formado: JSON invalido, campos de mas, base64 invalido o sin nombre = 400; mas de 5 MB = 413; ningun caso llega a la bitacora", async () => {
    const ctx = await setup({ modo: "falsas" });
    const sa = await ctx.alta();
    const ok = b64(CSV);
    expect((await subir(ctx, sa.token, { nombre: "a.csv", contenidoBase64: ok, organizationId: "x" })).status).toBe(400);
    expect((await subir(ctx, sa.token, { nombre: "a.csv", contenidoBase64: "no es base64!" })).status).toBe(400);
    expect((await subir(ctx, sa.token, { nombre: "", contenidoBase64: ok })).status).toBe(400);
    expect((await subir(ctx, sa.token, { contenidoBase64: ok })).status).toBe(400);
    const roto = await ctx.app.request("/superadmin/copiloto/adjuntos", { method: "POST", headers: { ...bearer(sa.token), "content-type": "application/json" }, body: "{no json" });
    expect(roto.status).toBe(400);
    const grande = await subir(ctx, sa.token, { nombre: "a.csv", contenidoBase64: "A".repeat(8 * 1024 * 1024) });
    expect(grande.status).toBe(413);
    expect(ctx.bitacora).toHaveLength(0);
  });

  it("solo el superadmin completo: staff comun 403, sin token 401 y el rol finanzas (solo lectura) 403 aunque tenga step-up", async () => {
    const ctx = await setup({ modo: "falsas" });
    const staff = await ctx.s.staff();
    expect((await subir(ctx, staff.token, { nombre: "a.csv", contenidoBase64: b64(CSV) })).status).toBe(403);
    expect((await ctx.app.request("/superadmin/copiloto/adjuntos", jsonRequestInit({ nombre: "a.csv", contenidoBase64: b64(CSV) }))).status).toBe(401);
    const fin = await ctx.alta({ finanzas: true });
    const stepUp = await ctx.activarMfa(fin);
    const res = await subir(ctx, fin.token, { nombre: "a.csv", contenidoBase64: b64(CSV) }, { "x-stepup-token": stepUp });
    expect(res.status).toBe(403);
    expect(ctx.bitacora).toHaveLength(0);
  });

  it("limite de 10 archivos por 10 minutos por persona (fail-closed): el 11o responde 429 y no se analiza", async () => {
    const ctx = await setup({ modo: "falsas" });
    const sa = await ctx.alta();
    for (let i = 0; i < 10; i++) expect((await subir(ctx, sa.token, { nombre: "a.csv", contenidoBase64: b64(CSV) })).status).toBe(200);
    expect((await subir(ctx, sa.token, { nombre: "a.csv", contenidoBase64: b64(CSV) })).status).toBe(429);
    expect(ctx.bitacora).toHaveLength(10);
  });

  it("con impersonacion activa se rechaza (403 del guard comun de escrituras) y no se analiza nada", async () => {
    const ctx = await setup({ modo: "falsas" });
    const sa = await ctx.alta();
    const imp = ctx.s.base.deps.impersonationRepo({} as never) as InMemoryImpersonationRepository;
    imp.seedPlatformSuperadmin(sa.id, sa.email);
    await imp.startSession(sa.id, ctx.s.base.organizationId, "Soporte del cliente: revisar el pedido 123 de ayer");
    expect((await subir(ctx, sa.token, { nombre: "a.csv", contenidoBase64: b64(CSV) })).status).toBe(403);
    expect(ctx.bitacora).toHaveLength(0);
  });
});
