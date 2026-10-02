// Lista de supresion de plataforma (SA-L-46), vista del SUPERADMIN.
//
//   GET  /superadmin/supresion               conteos por motivo y origen (NUNCA valores ni hashes)
//   POST /superadmin/supresion/no-contactar  agrega un telefono o correo como "no contactar" (step-up MFA)
//
// Autenticacion, gateo de superadmin y step-up montados una vez en routes/superadmin.ts sobre `/superadmin/*`;
// la autoridad real sigue en SQL (core.platform_superadmin). El valor llega en claro SOLO en el cuerpo del POST,
// se hashea aqui y no se guarda ni se registra. Base sin migrar: `disponible: false` (GET, 200) / 503 (POST).
// Ver docs/SUPRESION.md y la migracion 0042.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import { agregarConteos, agregarNoContactar, listarSupresiones } from "../supresion/index.ts";
import type { AppDeps } from "../deps.ts";

export const SUPRESION_NO_DISPONIBLE = "La lista de supresión de plataforma todavía no está disponible en este despliegue (falta aplicar la migración 0042_plataforma_supresion_contacto).";
const MUTACION_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;

interface NoContactarBody {
  readonly tipo?: unknown;
  readonly valor?: unknown;
}

export function superadminSupresionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.get("/superadmin/supresion", async (c) => {
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => listarSupresiones(db, callerId));
    if (!r.disponible) return c.json({ disponible: false, mensaje: SUPRESION_NO_DISPONIBLE, total: 0, porMotivo: [], porOrigen: [], grupos: [] });
    const { total, porMotivo, porOrigen } = agregarConteos(r.grupos);
    return c.json({
      disponible: true,
      total,
      porMotivo,
      porOrigen,
      grupos: r.grupos.map((g) => ({ tipo: g.tipo, motivo: g.motivo, origen: g.origen, total: g.total, ultimoEnMs: g.ultimoEnMs })),
    });
  });

  app.post("/superadmin/supresion/no-contactar", async (c) => {
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:supresion:${requestActor(c.req.raw, callerId)}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados cambios en la lista de supresión en poco tiempo.");
    const raw = (await c.req.json().catch(() => ({}))) as NoContactarBody;
    if (raw.tipo !== "telefono" && raw.tipo !== "correo") throw Errors.validation("tipo debe ser telefono o correo.");
    const valor = typeof raw.valor === "string" ? raw.valor : "";
    if (valor.trim() === "" || valor.length > 254) throw Errors.validation("valor es obligatorio.");
    const tipo = raw.tipo;
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => agregarNoContactar(db, callerId, tipo, valor));
    if (r === "valor_invalido") throw Errors.validation(tipo === "telefono" ? "El teléfono no tiene un formato válido (10 dígitos o formato internacional)." : "El correo no tiene un formato válido.");
    if (r === "no_migrada") throw Errors.serviceUnavailable(SUPRESION_NO_DISPONIBLE);
    return c.json({ registrada: r === "registrada", yaExistia: r === "ya_existia" });
  });

  return app;
}
