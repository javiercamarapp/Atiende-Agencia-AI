// Reporte PDF del Copiloto ("Chatea con tus datos") -- CHAT-14.
//
//   POST <base>/conversaciones/:conversationId/reporte?seq=N  -> application/pdf
//
// `<base>` es la ruta de chat de cada vertical. MISMA cadena de autorizacion que el chat de datos: JWT -> sesion RLS del
// usuario -> membership verificada -> rol de la vertical (403) -> conversacion PROPIA (404 si es ajena, de otra
// organizacion, inexistente o la base aun no tiene la migracion 0041: indistinguibles). Es POST porque cada llamada
// re-consulta los datos y puede gastar IA (limite por usuario y organizacion, fail-closed, igual que el chat).
//
// Pipeline (decision de producto, ver agent-core/data-chat/reporte.ts): el codigo RE-EJECUTA las herramientas del
// mensaje con el alcance ACTUAL del usuario (jamas reutiliza cifras del texto del chat), un analista y un redactor
// producen la narrativa, la guardia numerica la verifica y el PDF se dibuja con graficas vectoriales deterministas.
// Sin proveedor de IA, con el interruptor de plataforma apagado o el tope agotado, o si la guardia rechaza dos veces el
// texto: el PDF sale SOLO con datos y lo dice (nunca una narrativa sin verificar).
//
// Compatibilidad con la base sin migrar: leer la conversacion corre en SAVEPOINT (`runWithSavepointFallback`) y cada
// consulta del catalogo tambien (una consulta que falla no aborta la transaccion unica del request).
import type { Context, Hono } from "hono";
import { assertVerticalRole } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  ejecutarHerramientasReporte,
  esReporteFinanciero,
  generarContenidoReporte,
  type DataChatAuditEntry,
  type DataChatCatalog,
  type DataChatScope,
} from "@atiende/agent-core/data-chat";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runWithSavepointFallback } from "@atiende/db";
import { ApiError } from "@atiende/core-auth";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";
import { logEvent } from "../logger.ts";
import {
  REPORTE_ANALISIS_FINANCIERO_ROLE,
  REPORTE_ANALISIS_GENERAL_ROLE,
  REPORTE_REDACCION_FINANCIERO_ROLE,
  REPORTE_REDACCION_GENERAL_ROLE,
} from "../production/llm-models.ts";
import { conversacionesRepo, type ConversacionScope, type ConversacionVertical } from "./conversaciones.ts";
import { renderReportePdf } from "./reporte-pdf.ts";

export const REPORTE_PDF_CONTENT_TYPE = "application/pdf";
/** Tope del archivo: un reporte (4 tablas x 50 filas + graficas) pesa decenas de KB; pasarse de aqui indica un fallo. */
export const REPORTE_PDF_MAX_BYTES = 5 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_LIMIT = { limit: 6, windowMs: 10 * 60_000 };
const ORG_LIMIT = { limit: 40, windowMs: 60 * 60_000 };

/** Lo que cada vertical resuelve del request (alcance verificado + catalogo ligado a la sesion RLS). */
export interface ReporteResolved {
  readonly catalog: DataChatCatalog;
  readonly scope: DataChatScope;
}

export interface ReporteRoutesConfig {
  /** Ruta base del chat de la vertical, p.ej. `/hoteles/:propertyId/chat-datos`. */
  readonly base: string;
  readonly vertical: ConversacionVertical;
  readonly roles: readonly string[];
  /** Alcance y catalogo con la sesion verificada del request; `undefined` = la vertical no esta cableada (503). */
  readonly resolve: (c: Context<CoreAuthHonoEnv>, db: TenantDbSession) => Promise<ReporteResolved | undefined>;
}

function sinCache(c: Context<CoreAuthHonoEnv>): void {
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
}

async function nombreOrganizacion(db: TenantDbSession, organizationId: string): Promise<string> {
  return runWithSavepointFallback<string>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<{ name: string }>(`select name from core.organization where id = $1::uuid;`, [organizationId]);
      return rows[0]?.name?.trim() || "Atiende";
    },
    isRecoverable: () => true, // solo adorna la marca de agua: jamas tumba el reporte
    fallback: async () => "Atiende",
  });
}

function nombreArchivo(vertical: string, ahora: Date): string {
  return `reporte-${vertical}-${ahora.toISOString().slice(0, 10)}.pdf`;
}

export function mountReporteRoutes(app: Hono<CoreAuthHonoEnv>, deps: AppDeps, cfg: ReporteRoutesConfig): void {
  app.post(`${cfg.base}/conversaciones/:conversationId/reporte`, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const id = c.req.param("conversationId") ?? "";
    // Un id mal formado jamas llega a la base y es indistinguible de uno inexistente.
    if (!UUID_RE.test(id)) throw Errors.notFound("Conversación no encontrada.");
    const seqRaw = c.req.query("seq") ?? "";
    const seq = /^\d{1,3}$/.test(seqRaw) ? Number(seqRaw) : NaN;
    if (!Number.isInteger(seq) || seq < 1 || seq > 100) throw Errors.validation("seq: se esperaba la posición del mensaje (1 a 100).");

    const dataChat = deps.dataChat;
    if (!dataChat) throw Errors.serviceUnavailable("Los reportes todavía no están activados para tu cuenta.");
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const db = c.get("db");

    // Limite de uso (por usuario y por organizacion), fail-closed: un reporte re-consulta datos y puede gastar IA.
    let permitido = false;
    try {
      const u = await dataChat.rateLimiter.allow(`datachat:reporte:u:${organizationId}:${userId}`, USER_LIMIT.limit, USER_LIMIT.windowMs);
      permitido = u && (await dataChat.rateLimiter.allow(`datachat:reporte:o:${organizationId}`, ORG_LIMIT.limit, ORG_LIMIT.windowMs));
    } catch {
      permitido = false;
    }
    if (!permitido) throw Errors.tooManyRequests("Has pedido muchos reportes en poco tiempo. Espera unos minutos e inténtalo de nuevo.");

    const convScope: ConversacionScope = { organizationId, userId, vertical: cfg.vertical };
    const repo = conversacionesRepo(deps, db);
    if (!repo.cargarFuenteReporte) throw Errors.serviceUnavailable("Los reportes todavía no están disponibles para tu cuenta.");
    const fuente = await repo.cargarFuenteReporte(convScope, id.toLowerCase(), seq);
    if (!fuente) throw Errors.notFound("Conversación no encontrada.");
    if (fuente.toolCalls.length === 0) throw new ApiError(422, "report_no_data", "Esta respuesta no tiene cifras para armar un reporte.");

    const resolved = await cfg.resolve(c, db);
    if (!resolved) throw Errors.serviceUnavailable("Los reportes todavía no están disponibles para tu cuenta.");

    const abort = new AbortController();
    const raw = c.req.raw.signal;
    const onAbort = (): void => abort.abort();
    if (raw.aborted) abort.abort();
    else raw.addEventListener("abort", onAbort, { once: true });

    try {
      const organizacion = await nombreOrganizacion(db, organizationId);
      const onError = (where: string, err: unknown): void =>
        console.error(JSON.stringify({ level: "error", event: "data_chat_reporte_error", vertical: cfg.vertical, where, message: err instanceof Error ? err.message.slice(0, 200) : "error" }));

      // 1) Codigo: tablas deterministas con el alcance ACTUAL. Cada consulta aislada con SAVEPOINT (transaccion unica).
      const inicio = Date.now();
      const { tablas, omitidas } = await ejecutarHerramientasReporte({
        catalog: resolved.catalog,
        scope: resolved.scope,
        calls: fuente.toolCalls,
        now: new Date(),
        signal: abort.signal,
        onError,
        aislar: <T>(trabajo: () => Promise<T>) =>
          runWithSavepointFallback<T>({
            session: db,
            primary: trabajo,
            isRecoverable: () => false,
            fallback: async (err) => {
              throw err;
            },
          }),
      });

      // Bitacora de las consultas (sin resultados): quien, que herramienta, con que parametros, cuantas filas.
      const durationMs = Date.now() - inicio;
      for (const call of fuente.toolCalls) {
        const tabla = tablas.find((t) => t.tool === call.tool);
        const entry: DataChatAuditEntry = {
          organizationId,
          userId,
          vertical: cfg.vertical,
          tool: call.tool,
          params: call.args,
          outcome: tabla ? "ok" : "unavailable",
          rowCount: tabla?.rows.length ?? 0,
          durationMs,
        };
        try {
          await dataChat.audit(db).record(entry);
        } catch (err) {
          onError("audit", err);
        }
      }

      if (tablas.length === 0) {
        throw new ApiError(422, "report_no_data", omitidas[0]?.motivo ?? "No hay cifras para armar el reporte con tu alcance actual.");
      }

      // 2-4) Analista + redactor + guardia numerica (o solo datos).
      const financiero = esReporteFinanciero(cfg.vertical, tablas);
      const completion = dataChat.completion;
      const contenido = await generarContenidoReporte({
        tablas,
        omitidas,
        vertical: cfg.vertical,
        ...(completion
          ? {
              analisis: completion(organizationId, financiero ? REPORTE_ANALISIS_FINANCIERO_ROLE : REPORTE_ANALISIS_GENERAL_ROLE),
              redaccion: completion(organizationId, financiero ? REPORTE_REDACCION_FINANCIERO_ROLE : REPORTE_REDACCION_GENERAL_ROLE),
            }
          : {}),
        signal: abort.signal,
        onError,
      });

      const generadoEn = new Date();
      const bytes = await renderReportePdf({ contenido, organizacion, vertical: cfg.vertical, generadoEn, zonaHoraria: resolved.scope.timezone });
      if (bytes.byteLength > REPORTE_PDF_MAX_BYTES) throw Errors.payloadTooLarge("El reporte excede el tamaño máximo permitido.");

      logEvent(c, "info", "data_chat_reporte", {
        vertical: cfg.vertical,
        financiero,
        tablas: tablas.length,
        omitidas: omitidas.length,
        narrativa: contenido.narrativa !== null,
        ...(contenido.motivoSinNarrativa ? { motivoSinNarrativa: contenido.motivoSinNarrativa } : {}),
        llmCalls: contenido.uso.llmCalls,
        costUsd: contenido.uso.costUsd,
        reintento: contenido.uso.reintento,
        bytes: bytes.byteLength,
      });

      sinCache(c);
      c.header("content-type", REPORTE_PDF_CONTENT_TYPE);
      c.header("content-disposition", `attachment; filename="${nombreArchivo(cfg.vertical, generadoEn)}"`);
      c.header("x-reporte-narrativa", contenido.narrativa ? "ok" : "no_disponible");
      return c.body(bytes as unknown as ArrayBuffer);
    } finally {
      raw.removeEventListener("abort", onAbort);
    }
  });
}
