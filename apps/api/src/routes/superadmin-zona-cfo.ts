// Zona CFO segura (SA-41): estado del rol propio, bitacora de consultas financieras y asignacion del rol
// `finanzas` (solo lectura). Ver packages/db/migrations/0034_superadmin_zona_cfo.sql y
// superadmin-seguridad/zona-cfo.ts (corte por rol, step-up y registro de cada consulta).
//
// Autenticacion, gateo de superadmin, corte por rol y step-up corren ANTES (montados una vez en
// routes/superadmin.ts sobre `/superadmin/*`). Aqui la autoridad real sigue estando en SQL: las lecturas
// devuelven cero filas a quien no es superadmin completo y la asignacion exige caller-binding.
//
// Base sin migrar (0034 sin aplicar): `disponible: false` con mensaje honesto (200), la asignacion
// responde 503; nunca un 500.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import type { CfoAccessLogRow, CfoZoneRoleRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import { traducirErrorSeguridad } from "./superadmin-mfa.ts";
import type { AppDeps } from "../deps.ts";

export const ZONA_CFO_NO_DISPONIBLE = "La zona CFO segura todavía no está disponible en este despliegue (falta aplicar la migración 0034_superadmin_zona_cfo).";
const MUTACION_RATE_LIMIT = { max: 20, windowMs: 5 * 60_000 } as const;
const LIMITE_DEFAULT = 100;
const LIMITE_MAX = 500;
const UINT_RE = /^\d{1,15}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const serializarEntrada = (e: CfoAccessLogRow) => ({ seq: e.seq, actorUserId: e.actorUserId, actorRol: e.actorRol, accion: e.accion, recurso: e.recurso, filtros: e.filtros, ocurrioEnMs: e.occurredAtMs });
const serializarRol = (r: CfoZoneRoleRow) => ({ usuarioId: r.staffUserId, correo: r.email, rol: r.rol, asignadoPor: r.assignedBy, motivo: r.reason, desdeMs: r.createdAtMs });

export function superadminZonaCfoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  // Autoservicio (tambien lo ve el rol `finanzas`, sin step-up, para saber si debe enrolar su MFA).
  app.get("/superadmin/zona-cfo/estado", async (c) => {
    const mfaObligatoriaGlobal = deps.env.superadminMfaRequired === true;
    if (!deps.cfoZoneRepo) return c.json({ disponible: false, rol: null, soloLectura: false, mfaObligatoria: mfaObligatoriaGlobal, mensaje: ZONA_CFO_NO_DISPONIBLE });
    const repo = deps.cfoZoneRepo;
    const callerId = c.get("userId");
    const { availability, rol } = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).resolveRole(callerId));
    if (availability === "not_migrated") return c.json({ disponible: false, rol: null, soloLectura: false, mfaObligatoria: mfaObligatoriaGlobal, mensaje: ZONA_CFO_NO_DISPONIBLE });
    return c.json({ disponible: true, rol, soloLectura: rol === "finanzas", mfaObligatoria: mfaObligatoriaGlobal || rol === "finanzas" });
  });

  // Bitacora de consultas financieras (superadmin completo; el SQL devuelve cero filas al rol finanzas).
  app.get("/superadmin/zona-cfo/bitacora", async (c) => {
    const limiteRaw = c.req.query("limite");
    let limite = LIMITE_DEFAULT;
    if (limiteRaw !== undefined && limiteRaw !== "") {
      if (!UINT_RE.test(limiteRaw) || Number(limiteRaw) < 1) throw Errors.validation("limite debe ser un entero >= 1.");
      limite = Math.min(LIMITE_MAX, Number(limiteRaw));
    }
    const antesRaw = c.req.query("antesDeSeq");
    let antes: number | null = null;
    if (antesRaw !== undefined && antesRaw !== "") {
      if (!UINT_RE.test(antesRaw)) throw Errors.validation("antesDeSeq debe ser un entero >= 0.");
      antes = Number(antesRaw);
    }
    if (!deps.cfoZoneRepo) return c.json({ disponible: false, mensaje: ZONA_CFO_NO_DISPONIBLE, entradas: [], siguienteAntesDeSeq: null });
    const repo = deps.cfoZoneRepo;
    const callerId = c.get("userId");
    const { availability, entries } = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).listAccessLog(callerId, limite, antes));
    if (availability === "not_migrated") return c.json({ disponible: false, mensaje: ZONA_CFO_NO_DISPONIBLE, entradas: [], siguienteAntesDeSeq: null });
    const ultima = entries[entries.length - 1];
    return c.json({ disponible: true, entradas: entries.map(serializarEntrada), siguienteAntesDeSeq: entries.length === limite && ultima ? ultima.seq : null });
  });

  app.get("/superadmin/zona-cfo/roles", async (c) => {
    if (!deps.cfoZoneRepo) return c.json({ disponible: false, mensaje: ZONA_CFO_NO_DISPONIBLE, roles: [] });
    const repo = deps.cfoZoneRepo;
    const callerId = c.get("userId");
    const { availability, roles } = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).listRoles(callerId));
    if (availability === "not_migrated") return c.json({ disponible: false, mensaje: ZONA_CFO_NO_DISPONIBLE, roles: [] });
    return c.json({ disponible: true, roles: roles.map(serializarRol) });
  });

  // Sensible (step-up): asigna (`rol: "finanzas"`) o retira (`rol: null`) el rol de solo lectura de OTRO superadmin.
  app.put("/superadmin/zona-cfo/roles/:userId", async (c) => {
    if (!deps.cfoZoneRepo) throw Errors.serviceUnavailable(ZONA_CFO_NO_DISPONIBLE);
    const repo = deps.cfoZoneRepo;
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:zona-cfo-rol:${requestActor(c.req.raw, callerId)}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados cambios de rol en poco tiempo.");

    const destino = c.req.param("userId");
    if (!UUID_RE.test(destino)) throw Errors.validation("userId debe ser un uuid.");
    const raw = (await c.req.json().catch(() => ({}))) as { rol?: unknown; motivo?: unknown };
    if (raw.rol !== null && raw.rol !== "finanzas") throw Errors.validation('rol debe ser "finanzas" o null (retirar).');
    const rol: "finanzas" | null = raw.rol;
    const motivo = typeof raw.motivo === "string" ? raw.motivo.trim() : "";
    if (motivo.length < 20 || motivo.length > 500) throw Errors.validation("motivo es obligatorio (20 a 500 caracteres).");

    try {
      const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).setRole(callerId, destino, rol, motivo));
      if (r.availability === "not_migrated") throw Errors.serviceUnavailable(ZONA_CFO_NO_DISPONIBLE);
      return c.json({ ok: true });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  return app;
}
