// Interruptores (kill switches) de plataforma: detener un agente LLM, un cron o
// todo el LLM / todos los crons, con motivo obligatorio y bitacora. Ver
// docs/SUPERADMIN_INTERRUPTORES.md y la migracion 0025.
//
// `PUT /superadmin/interruptores` esta en la lista de acciones sensibles
// (step-up MFA, ver superadmin-seguridad/step-up.ts). El efecto real lo aplican
// el gateway LLM (GatewayKillSwitch) y `withHeartbeat` (crons) via el guard con
// cache de 10 s; esta ruta invalida el cache de ESTA instancia para que el
// cambio sea inmediato aqui (otras instancias serverless lo ven en <= 10 s).
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import type { PlatformSwitchRow, SwitchScope } from "@atiende/db";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import { SWITCHABLE_AGENT_ROLES, SWITCHABLE_CRONS, isSwitchableTarget } from "../platform-switches.ts";
import { traducirErrorSeguridad } from "./superadmin-mfa.ts";
import type { AppDeps } from "../deps.ts";

const NO_DISPONIBLE = "Los interruptores de plataforma todavía no están disponibles en este despliegue (falta aplicar la migración 0025_superadmin_mfa_switches_orgs).";
const MUTACION_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;
const SCOPES = new Set<SwitchScope>(["global", "agente", "cron"]);

function serialize(r: PlatformSwitchRow) {
  return { scope: r.scope, target: r.target, bloqueado: r.blocked, motivo: r.reason, actualizadoPor: r.updatedBy, actualizadoEnMs: r.updatedAtMs };
}

interface SetBody {
  readonly scope?: unknown;
  readonly target?: unknown;
  readonly bloqueado?: unknown;
  readonly motivo?: unknown;
}

export function superadminInterruptoresRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.get("/superadmin/interruptores", async (c) => {
    const catalogo = { globales: ["llm", "crons"], agentes: SWITCHABLE_AGENT_ROLES, crons: SWITCHABLE_CRONS };
    if (!deps.platformSwitchRepo) return c.json({ disponible: false, catalogo, interruptores: [] });
    const repo = deps.platformSwitchRepo;
    const callerId = c.get("userId");
    const { availability, switches } = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).list(callerId));
    return c.json({ disponible: availability === "available", catalogo, interruptores: switches.map(serialize) });
  });

  app.put("/superadmin/interruptores", async (c) => {
    if (!deps.platformSwitchRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.platformSwitchRepo;
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:interruptores:${requestActor(c.req.raw, callerId)}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados cambios de interruptores en poco tiempo.");

    const raw = (await c.req.json().catch(() => ({}))) as SetBody;
    const scope = typeof raw.scope === "string" ? (raw.scope as SwitchScope) : undefined;
    const target = typeof raw.target === "string" ? raw.target : "";
    const motivo = typeof raw.motivo === "string" ? raw.motivo : "";
    if (!scope || !SCOPES.has(scope)) throw Errors.validation("scope debe ser global, agente o cron.");
    if (typeof raw.bloqueado !== "boolean") throw Errors.validation("bloqueado debe ser true o false.");
    if (!isSwitchableTarget(scope, target)) throw Errors.validation(`target "${target}" no existe en el catálogo de interruptores (ver GET /superadmin/interruptores).`);
    if (motivo.trim().length < 20) throw Errors.validation("motivo obligatorio (mínimo 20 caracteres).");

    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).setSwitch(callerId, scope, target, raw.bloqueado as boolean, motivo));
      if (result.availability === "not_migrated" || !result.row) throw Errors.serviceUnavailable(NO_DISPONIBLE);
      deps.platformSwitchGuard?.invalidate();
      return c.json({ interruptor: serialize(result.row) });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  return app;
}
