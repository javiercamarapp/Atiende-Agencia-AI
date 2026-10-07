import { Hono } from "hono";
import { ApiError } from "@atiende/core-auth";
import { Errors } from "../errors.ts";
import { readJsonCapped, requestActor } from "../http-security.ts";
import { isDemoSolution } from "../demo-agents/profiles.ts";
import { DEMO_CONTEXT, DEMO_LIMITS, DEMO_TOPES, type DemoAgentsDeps, type DemoInput, type DemoMessage } from "../demo-agents/types.ts";

const BASE = "/v1/demo-agentes/:solution";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = () => new ApiError(503, "demo_no_disponible", "La demostración en vivo no está disponible por ahora. Puedes escuchar el ejemplo grabado.");

function parseInput(solution: string, raw: unknown): DemoInput {
  if (!isDemoSolution(solution)) throw Errors.notFound();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("Solicitud inválida.");
  const body = raw as Record<string, unknown>;
  if (typeof body.sessionId !== "string" || !UUID.test(body.sessionId)) throw Errors.validation("sessionId inválido.");
  if (body.locale !== "es" && body.locale !== "en") throw Errors.validation("locale debe ser es o en.");
  return { solution, sessionId: body.sessionId, locale: body.locale };
}

function parseMessages(raw: unknown): DemoMessage[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > DEMO_LIMITS.mensajesPorConversacion * 2 - 1 || raw.length % 2 !== 1) throw Errors.validation("La conversación admite hasta 12 mensajes del visitante.");
  return raw.map((item: unknown, index): DemoMessage => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw Errors.validation("Mensaje inválido.");
    const row = item as Record<string, unknown>;
    if (row.rol !== (index % 2 ? "agente" : "usuario") || typeof row.texto !== "string") throw Errors.validation("El historial debe alternar visitante y agente.");
    // Reject control characters rather than alter the visitor's intended words.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.texto)) throw Errors.validation("El mensaje contiene caracteres no admitidos.");
    const texto = row.texto.trim();
    const max = index % 2 ? 3000 : DEMO_LIMITS.caracteresPorMensaje;
    if (!texto || texto.length > max) throw Errors.validation(`El mensaje admite entre 1 y ${max} caracteres.`);
    return { rol: index % 2 ? "agente" : "usuario", texto };
  });
}

export function demoAgentsRoutes(deps?: DemoAgentsDeps): Hono {
  const app = new Hono();
  app.use("/v1/demo-agentes/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Origin");
    const origin = c.req.header("origin");
    if (origin && deps?.allowedOrigins.includes(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type");
      c.header("Access-Control-Expose-Headers", "Retry-After");
    } else if (origin || c.req.method !== "GET") {
      throw Errors.forbidden("Origen no permitido.");
    }
    await next();
  });
  app.options(`${BASE}/*`, (c) => c.body(null, 204));

  async function consume(scope: string, actor: string, limit: number, seconds: number) {
    if (!deps?.enabled) throw unavailable();
    let allowed: boolean;
    try { allowed = await deps.consume(scope, actor, limit, seconds); }
    catch { throw unavailable(); }
    if (!allowed) throw new ApiError(429, "demo_tope_alcanzado", "La demostración alcanzó su límite temporal. Vuelve a intentarlo más tarde.", { "Retry-After": "60" });
  }

  app.get(`${BASE}/estado`, async (c) => {
    const solution = c.req.param("solution");
    if (!isDemoSolution(solution)) throw Errors.notFound();
    let countersReady = false;
    if (deps?.enabled) {
      // Check the real durable limiter without touching provider networks or customer data.
      await consume("estado-ip", requestActor(c.req.raw), 60, 60);
      countersReady = true;
    }
    const ready = Boolean(deps?.enabled && countersReady);
    return c.json({ solution, ...DEMO_CONTEXT, chat: { disponible: ready && Boolean(deps?.chat), motivo: ready && deps?.chat ? null : "no_disponible" }, voz: { disponible: ready && Boolean(deps?.voice), motivo: ready && deps?.voice ? null : "no_disponible" }, limites: DEMO_LIMITS });
  });

  async function guard(channel: "chat" | "voz", input: DemoInput, request: Request) {
    if (!deps?.enabled || !(channel === "chat" ? deps.chat : deps.voice)) throw unavailable();
    const topes = DEMO_TOPES[channel];
    const ip = requestActor(request);
    // El orden importa: los topes que un visitante puede agotar solo (ventana corta y dia por IP) se cobran ANTES del cupo global, asi un abuso de una IP
    // se detiene en su propio cubo y no consume el cupo de los demas. Cada cubo se confirma por separado, antes de cualquier llamada con costo.
    await consume(`${channel}-ip`, ip, topes.ipVentana.limite, topes.ipVentana.segundos);
    await consume(`${channel}-ip-dia`, ip, topes.ipDia.limite, topes.ipDia.segundos);
    await consume(`${channel}-session`, input.sessionId, topes.sesion.limite, topes.sesion.segundos);
    await consume(`${channel}-platform`, "all", topes.plataforma.limite, topes.plataforma.segundos);
  }

  app.post(`${BASE}/chat`, async (c) => {
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 48 * 1024);
    const input = parseInput(c.req.param("solution"), body);
    const mensajes = parseMessages(body.mensajes);
    await guard("chat", input, c.req.raw);
    try {
      const result = await deps!.chat!({ ...input, mensajes });
      return c.json({ ...result, ...DEMO_CONTEXT });
    } catch { throw unavailable(); }
  });

  app.post(`${BASE}/voz/sesion`, async (c) => {
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 2048);
    const input = parseInput(c.req.param("solution"), body);
    await guard("voz", input, c.req.raw);
    try { return c.json({ ...await deps!.voice!(input), ...DEMO_CONTEXT }, 201); }
    catch { throw unavailable(); }
  });
  return app;
}
