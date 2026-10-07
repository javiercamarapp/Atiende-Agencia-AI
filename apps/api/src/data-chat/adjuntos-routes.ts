// "Adjuntar archivo" del Copiloto (CSV / Excel / PDF), seguimiento de CHAT-17. UNA ruta por chat, la misma para las seis verticales y para la plataforma:
//
//   POST <base>/adjuntos   { nombre, contenidoBase64 }   -> respuesta con la forma de DataChatAnswer (perfil del archivo)
//
// `<base>` es la ruta de chat de cada vertical (`/hoteles/:propertyId/chat-datos`) o `/superadmin/copiloto`. MISMA cadena de autorizacion que el chat (JWT -> sesion RLS ->
// membership -> rol de la vertical; en plataforma la cadena de /superadmin/*, donde el rol `finanzas` no tiene esta ruta). El analisis es DETERMINISTA y vive en
// adjuntos-analisis.ts: sin modelo, sin gasto de IA, sin guardar el archivo ni sus filas. Limite: 5 MB por archivo y 10 archivos por 10 minutos por persona (fail-closed).
// Cada archivo deja una fila en la bitacora del Copiloto (herramienta `archivo_adjunto`, solo el tipo y el numero de filas; nunca el nombre ni el contenido).
import type { Context, Hono } from "hono";
import { assertVerticalRole } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { DataChatAuditSink } from "@atiende/agent-core/data-chat";
import { rateLimit } from "@atiende/core-ratelimit";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { AppDeps } from "../deps.ts";
import { Errors } from "../errors.ts";
import { ADJUNTO_MAX_BYTES, analizarAdjunto } from "./adjuntos-analisis.ts";

const LIMITE = { max: 10, windowMs: 10 * 60_000 } as const;
/** base64 infla 4/3; el margen cubre el JSON que lo envuelve. */
const MAX_CUERPO_CHARS = Math.ceil((ADJUNTO_MAX_BYTES * 4) / 3) + 4096;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface ProcesoAdjunto {
  /** Organizacion de la fila de bitacora (`plataforma` en el Copiloto de superadmin). */
  readonly organizationId: string;
  readonly userId: string;
  readonly vertical: string;
  readonly role: string;
  /** Bitacora del Copiloto (la misma del chat). Sin ella no se registra nada (la ruta sigue funcionando). */
  readonly audit: DataChatAuditSink | undefined;
}

/** Lee y valida el cuerpo: SOLO `nombre` y `contenidoBase64` (cualquier otro campo es 400). */
async function leerCuerpo(c: Context<CoreAuthHonoEnv>): Promise<{ nombre: string; bytes: Uint8Array }> {
  const largo = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(largo) && largo > MAX_CUERPO_CHARS) throw Errors.payloadTooLarge("El archivo supera los 5 MB.");
  const crudo = await c.req.text();
  if (crudo.length > MAX_CUERPO_CHARS) throw Errors.payloadTooLarge("El archivo supera los 5 MB.");
  let raw: unknown;
  try {
    raw = JSON.parse(crudo);
  } catch {
    throw Errors.validation("Cuerpo inválido: se esperaba JSON.");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("Cuerpo inválido: se esperaba un objeto JSON.");
  const cuerpo = raw as Record<string, unknown>;
  for (const k of Object.keys(cuerpo)) if (k !== "nombre" && k !== "contenidoBase64") throw Errors.validation(`Campo no permitido: ${k.slice(0, 40)}.`);
  const nombre = cuerpo["nombre"];
  const b64 = cuerpo["contenidoBase64"];
  if (typeof nombre !== "string" || nombre.trim() === "" || nombre.length > 200) throw Errors.validation("nombre: se esperaba el nombre del archivo (hasta 200 caracteres).");
  if (typeof b64 !== "string" || b64.length === 0 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) throw Errors.validation("contenidoBase64: se esperaba el archivo en base64.");
  return { nombre: nombre.trim(), bytes: new Uint8Array(Buffer.from(b64, "base64")) };
}

export async function procesarAdjunto(c: Context<CoreAuthHonoEnv>, p: ProcesoAdjunto): Promise<Response> {
  const permitido = await rateLimit(`copiloto:adjunto:${p.vertical}:${p.userId}`, LIMITE.max, LIMITE.windowMs, { category: "admin" }).catch(() => false);
  if (!permitido) throw Errors.tooManyRequests("Adjuntaste muchos archivos en poco tiempo. Espera unos minutos e inténtalo de nuevo.");
  const { nombre, bytes } = await leerCuerpo(c);
  const inicio = Date.now();
  const r = await analizarAdjunto(nombre, bytes);
  try {
    await p.audit?.record({
      organizationId: p.organizationId,
      userId: p.userId,
      vertical: p.vertical,
      tool: "archivo_adjunto",
      params: r.ok ? { tipo: r.tipo } : {},
      outcome: r.ok ? "ok" : "error",
      rowCount: r.ok ? r.filas : 0,
      durationMs: Date.now() - inicio,
      route: "directa",
      role: p.role,
    });
  } catch {
    // La bitacora nunca tumba la respuesta (mismo criterio que el motor del chat).
  }
  c.header("cache-control", "no-store");
  if (r.ok) return c.json(r.respuesta);
  return c.json({ status: r.status, text: r.motivo, blocks: [], sources: [], toolsUsed: [] });
}

export interface AdjuntosRoutesConfig {
  /** Ruta base del chat de la vertical, p.ej. `/hoteles/:propertyId/chat-datos`. */
  readonly base: string;
  readonly vertical: string;
  readonly roles: readonly string[];
  /** Rol del gateway de la vertical (`<vertical>:data_chat`), solo para etiquetar la fila de bitacora. */
  readonly role: string;
}

export function mountAdjuntosRoutes(app: Hono<CoreAuthHonoEnv>, deps: AppDeps, cfg: AdjuntosRoutesConfig): void {
  app.post(`${cfg.base}/adjuntos`, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const db: TenantDbSession = c.get("db");
    return procesarAdjunto(c, {
      organizationId: c.get("organizationId"),
      userId: c.get("userId"),
      vertical: cfg.vertical,
      role: cfg.role,
      audit: deps.dataChat?.audit(db),
    });
  });
}
