// Widget publico de chat WhatsApp para DEMOS, SIN Meta (R-19): GET .../demo/:orgSlug/estado y
// POST .../demo/:orgSlug/mensaje. SIN login: igual que otras superficies públicas, este grupo se monta sin `authMiddleware` y abre su
// propia sesion de sistema (`userId: null`); su defensa es CORS por origen, topes de tasa (IP, sesion y organizacion =
// tope de costo), validacion estricta de entradas y que SOLO atiende organizaciones marcadas como demo
// (`restaurantes.demo_organization`, migracion 037): una organizacion real nunca responde por aqui.
//
// El visitante conversa con el MISMO agente real de WhatsApp (`deps.turnHandler`, el que usa el webhook, con el mismo
// gateway LLM, presupuesto y kill switch) mediante `runDemoWidgetTurn`, que reutiliza la plomeria del webhook con
// `deliverReply: false`: NADA se encola hacia Meta y este archivo ni siquiera importa el despachador de WhatsApp.
// Sin proveedor LLM el estado es "agente no disponible: requiere OPENROUTER_API_KEY": nunca hay respuestas por palabras
// clave (REGLA NO MAQUETAS).
//
// Compatibilidad con la base sin migrar: la lectura de la marca degrada con SAVEPOINT a "no es demo" (404/no disponible).
import { Hono } from "hono";
import type { Context } from "hono";
import { emitirNotificacion } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { DEMO_SESSION_ID_RE, DEMO_WIDGET_LIMITS, DAY_SECONDS, DemoWidgetValidationError, consumeRateLimit, resolveDemoWidgetEstado, runDemoWidgetTurn, sucursalPredeterminadaDemo } from "@atiende/domain-restaurantes";
import type { DemoWidgetEstado, RestaurantesRepository } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { originAllowed, readJsonCapped, requestActor } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface DemoMessageBody {
  readonly session_id?: unknown;
  readonly mensaje?: unknown;
  readonly sucursal?: unknown;
}

const noStore = (c: Context) => c.header("Cache-Control", "no-store");

export function restaurantesDemoWidgetRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  function assertOrigin(c: Context) {
    if (!originAllowed(c.req.header("origin") ?? null, deps.env.allowedOrigins)) throw Errors.forbidden("Origen no permitido");
  }

  async function resolveOrg(repo: RestaurantesRepository, orgSlug: string) {
    const org = await repo.findOrganizationBySlug(orgSlug);
    if (!org) throw Errors.notFound("Restaurante no encontrado.");
    return org;
  }

  /** El agente real esta disponible solo si el servidor tiene al menos un proveedor LLM configurado. */
  const agentAvailable = () => deps.llmGateway !== undefined;

  async function estadoDe(db: TenantDbSession, organizationId: string): Promise<DemoWidgetEstado> {
    return resolveDemoWidgetEstado(deps.demoRepo?.(db), organizationId, agentAvailable());
  }

  // GET /v1/restaurantes/demo/:orgSlug/estado -- ¿esta la demo disponible? + sucursales para elegir (solo si es demo).
  app.get("/v1/restaurantes/demo/:orgSlug/estado", async (c) => {
    noStore(c);
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      const byIp = await consumeRateLimit(repo, "demo-widget-estado", requestActor(c.req.raw, ""), 120, 60);
      if (!byIp.allowed) throw Errors.tooManyRequests();
      const estado = await estadoDe(db, org.id);
      const esDemo = estado.motivo !== "no_es_demo";
      const sucursales = esDemo ? (await repo.listBranchesForOrganizationAdmin(org.id)).filter((b) => b.status === "active").map((b) => ({ slug: b.slug, nombre: b.name })) : [];
      return c.json({
        ...estado,
        restaurante: esDemo ? { slug: org.slug, nombre: org.name } : null,
        sucursales,
        // T7 (fase 1) abre preseleccionada si esta activa; null = "Numero general" (comportamiento de siempre).
        sucursal_predeterminada: sucursalPredeterminadaDemo(sucursales),
        limites: { mensajes_por_sesion: DEMO_WIDGET_LIMITS.perSessionPerDay, caracteres_por_mensaje: DEMO_WIDGET_LIMITS.maxMessageChars },
      });
    });
  });

  // POST /v1/restaurantes/demo/:orgSlug/mensaje -- un mensaje del visitante; responde el agente real.
  app.post("/v1/restaurantes/demo/:orgSlug/mensaje", async (c) => {
    noStore(c);
    assertOrigin(c);
    const body = await readJsonCapped<DemoMessageBody>(c.req.raw, 4 * 1024);
    if (typeof body.session_id !== "string" || !DEMO_SESSION_ID_RE.test(body.session_id)) throw Errors.validation("session_id inválido.");
    const sessionId = body.session_id;
    if (typeof body.mensaje !== "string") throw Errors.validation("El mensaje debe ser texto.");
    if (body.sucursal !== undefined && (typeof body.sucursal !== "string" || body.sucursal.length > 100)) throw Errors.validation("sucursal inválida.");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));

      const estado = await estadoDe(db, org.id);
      if (estado.motivo === "no_es_demo") throw Errors.notFound("Restaurante no encontrado.");
      if (!estado.disponible) return c.json({ code: "demo_no_disponible", motivo: estado.motivo, message: estado.mensaje }, 503);

      // Topes de tasa ANTES de gastar un solo token: IP (ráfaga), organizacion/dia (costo total) y sesion/dia (costo por visitante).
      const byIp = await consumeRateLimit(repo, "demo-widget-ip", requestActor(c.req.raw, ""), DEMO_WIDGET_LIMITS.perIpPerMinute, 60);
      if (!byIp.allowed) throw Errors.tooManyRequests();
      const byOrg = await consumeRateLimit(repo, "demo-widget-org", org.id, DEMO_WIDGET_LIMITS.perOrganizationPerDay, DAY_SECONDS);
      if (!byOrg.allowed) {
        // Notificacion in-app al dueño (productor compartido, catalogo `restaurantes.demo.tope_diario_alcanzado`): una por dia, sin PII.
        // Best-effort: nunca cambia la respuesta 429 ni deja abortada la transaccion del request (SAVEPOINT dentro del productor).
        const dia = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Merida", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        await emitirNotificacion(db, { evento: "restaurantes.demo.tope_diario_alcanzado", organizationId: org.id, clave: dia, parametros: { cantidad: DEMO_WIDGET_LIMITS.perOrganizationPerDay } });
        return c.json({ code: "demo_tope_alcanzado", message: "La demo alcanzó su tope de mensajes de hoy. Inténtelo mañana o avise al equipo." }, 429);
      }
      const bySession = await consumeRateLimit(repo, "demo-widget-session", sessionId, DEMO_WIDGET_LIMITS.perSessionPerDay, DAY_SECONDS);
      if (!bySession.allowed) return c.json({ code: "demo_sesion_tope", message: "Esta conversación alcanzó su tope de mensajes. Inicie una nueva conversación." }, 429);

      let propertyId: string | null = null;
      if (typeof body.sucursal === "string" && body.sucursal) {
        const branch = await repo.findBranch(org.id, { slug: body.sucursal });
        if (!branch || branch.status !== "active") throw Errors.validation("Sucursal no encontrada.");
        propertyId = branch.propertyId;
      }

      try {
        const result = await runDemoWidgetTurn(
          { repo, turnHandler: deps.turnHandler, ...(deps.privacidadRepo ? { privacy: deps.privacidadRepo(db) } : {}), ...(deps.handoffGate ? { handoffGate: deps.handoffGate(db) } : {}) },
          { organizationId: org.id, sessionId, message: body.mensaje as string, propertyId },
        );
        if (result.kind === "reply") {
          const pedido = result.orderId ? await repo.findOrderById(org.id, result.orderId) : null;
          return c.json({
            tipo: "respuesta",
            respuesta: result.reply,
            escalado: result.escalated,
            pedido: pedido ? { id: pedido.id, total: pedido.total, estado: pedido.status } : null,
          });
        }
        return c.json({ tipo: result.kind, respuesta: result.mensaje, escalado: false, pedido: null });
      } catch (err) {
        if (err instanceof DemoWidgetValidationError) throw Errors.validation(err.message);
        throw err;
      }
    });
  });

  return app;
}
