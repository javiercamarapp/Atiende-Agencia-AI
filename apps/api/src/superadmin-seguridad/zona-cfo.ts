// Zona CFO segura (SA-41): corte por rol, step-up y bitacora de cada consulta financiera.
// Ver packages/db/migrations/0034_superadmin_zona_cfo.sql.
//
// Montado UNA vez en routes/superadmin.ts sobre `/superadmin/*` (autenticacion, gateo de superadmin y
// write-guard de impersonacion corren ANTES), y ANTES de `stepUpMiddleware` para que un step-up
// faltante en una ruta financiera tambien quede en la bitacora como `denegado`.
//
// Politica:
//   - Rol `finanzas` (superadmin restringido, solo lectura): SOLO puede (a) las lecturas financieras de
//     RUTAS_FINANCIERAS marcadas `finanzas` y (b) las rutas de autoservicio para enrolar/verificar su MFA
//     y ver su propio estado. TODO lo demas (cualquier escritura, impersonacion, break-glass, prospectos,
//     bitacora de consultas...) responde 403 `rol_finanzas_solo_lectura` y deja un `denegado`. Es una
//     lista blanca: una ruta nueva queda cerrada para `finanzas` hasta que alguien la agregue aqui.
//     Cada lectura financiera EXIGE step-up y no admite degradarse: sin MFA activa -> 403
//     `mfa_enrollment_required`; sin repositorio MFA o migracion 0025 sin aplicar -> 503.
//   - Superadmin completo: en cada lectura financiera aplica la politica de step-up ya existente (con
//     factor activo, token vigente; SUPERADMIN_MFA_REQUIRED=1 la vuelve obligatoria).
//   - TODA lectura financiera (de cualquier rol) se registra ANTES de ejecutar el handler, en una
//     transaccion propia ya confirmada: quien, rol, que (recurso), filtros (solo parametros de consulta
//     saneados) y cuando. Si el registro falla por cualquier causa que no sea "migracion pendiente", la
//     consulta NO se ejecuta (503): no hay lectura financiera sin huella.
//
// Compatibilidad con la base sin migrar: sin `cfoZoneRepo` o con 0034 sin aplicar no hay rol restringido
// (nadie puede tenerlo antes de la migracion) y no hay bitacora; el comportamiento es el anterior.
import type { Context, MiddlewareHandler } from "hono";
import { ApiError } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { ZonaCfoAccion } from "@atiende/db";
import type { AppDeps } from "../deps.ts";
import { Errors } from "../errors.ts";
import { exigirStepUp } from "./step-up.ts";

export interface RutaFinanciera {
  readonly pattern: RegExp;
  /** Etiqueta estable que queda en la bitacora (no depende de los ids de la URL). */
  readonly recurso: string;
  /** El rol `finanzas` puede leerla. */
  readonly finanzas: boolean;
  /** Es una exportacion (se registra como `exportacion`). */
  readonly exportacion?: boolean;
}

/** Lecturas financieras (solo GET). Lo que esta aqui se registra SIEMPRE; `finanzas: true` ademas se le permite al rol de solo lectura. */
export const RUTAS_FINANCIERAS: readonly RutaFinanciera[] = [
  { pattern: /^\/superadmin\/cfo\/dashboard$/, recurso: "cfo/dashboard", finanzas: true },
  { pattern: /^\/superadmin\/pyl$/, recurso: "pyl", finanzas: true },
  { pattern: /^\/superadmin\/pyl\/export\.csv$/, recurso: "pyl/export.csv", finanzas: true, exportacion: true },
  { pattern: /^\/superadmin\/costos\/resumen$/, recurso: "costos/resumen", finanzas: true },
  { pattern: /^\/superadmin\/costos\/organizaciones\/[^/]+\/eventos$/, recurso: "costos/organizaciones/:id/eventos", finanzas: true },
  { pattern: /^\/superadmin\/costos\/tipo-cambio$/, recurso: "costos/tipo-cambio", finanzas: true },
  { pattern: /^\/superadmin\/organizaciones\/margen$/, recurso: "organizaciones/margen", finanzas: true },
  { pattern: /^\/superadmin\/planes$/, recurso: "planes", finanzas: true },
  { pattern: /^\/superadmin\/planes\/asignaciones$/, recurso: "planes/asignaciones", finanzas: true },
  { pattern: /^\/superadmin\/contratos$/, recurso: "contratos", finanzas: true },
  { pattern: /^\/superadmin\/contratos\/estimacion$/, recurso: "contratos/estimacion", finanzas: true },
  { pattern: /^\/superadmin\/gasto-api\/(resumen|organizaciones|desglose)$/, recurso: "gasto-api", finanzas: true },
  { pattern: /^\/superadmin\/facturacion\/(resumen|organizaciones)$/, recurso: "facturacion", finanzas: true },
  { pattern: /^\/superadmin\/facturacion\/(webhooks-recientes|webhooks-bitacora)$/, recurso: "facturacion/webhooks", finanzas: false },
  { pattern: /^\/superadmin\/zona-cfo\/bitacora$/, recurso: "zona-cfo/bitacora", finanzas: false },
  { pattern: /^\/superadmin\/zona-cfo\/roles$/, recurso: "zona-cfo/roles", finanzas: false },
];

interface RutaAutoservicio {
  readonly method: string;
  readonly pattern: RegExp;
}

/** Sin datos financieros: lo minimo para que el rol `finanzas` enrole/verifique su MFA y vea su estado. */
const AUTOSERVICIO_FINANZAS: readonly RutaAutoservicio[] = [
  { method: "GET", pattern: /^\/superadmin\/mfa\/estado$/ },
  { method: "POST", pattern: /^\/superadmin\/mfa\/enrolar$/ },
  { method: "POST", pattern: /^\/superadmin\/mfa\/verificar$/ },
  { method: "GET", pattern: /^\/superadmin\/zona-cfo\/estado$/ },
];

/** Copiloto de superadmin (CHAT-16): el rol `finanzas` puede abrir el chat y ver sus propias conversaciones. La RUTA es quien aplica la politica de la zona:
 *  el catalogo del rol `finanzas` contiene SOLO herramientas financieras, todas exigen step-up (obligatorio, sin degradarse) y cada llamada deja una fila en
 *  core.cfo_access_log. El reporte PDF de un mensaje propio (POST .../conversaciones/:id/reporte) tambien: la ruta exige step-up obligatorio a `finanzas` y re-ejecuta
 *  SOLO herramientas de su catalogo. Renombrar o borrar conversaciones (PATCH/DELETE) NO esta aqui: sigue siendo solo del superadmin completo. */
const COPILOTO_FINANZAS: readonly RutaAutoservicio[] = [
  { method: "GET", pattern: /^\/superadmin\/copiloto\/estado$/ },
  { method: "POST", pattern: /^\/superadmin\/copiloto$/ },
  { method: "GET", pattern: /^\/superadmin\/copiloto\/conversaciones(\/[^/]+)?$/ },
  { method: "POST", pattern: /^\/superadmin\/copiloto\/conversaciones\/[^/]+\/reporte$/ },
];

export function rutaFinanciera(method: string, path: string): RutaFinanciera | null {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return null;
  return RUTAS_FINANCIERAS.find((r) => r.pattern.test(path)) ?? null;
}

function esAutoservicio(method: string, path: string): boolean {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return [...AUTOSERVICIO_FINANZAS, ...COPILOTO_FINANZAS].some((r) => r.method === m && r.pattern.test(path));
}

const CLAVE_VALIDA = /^[A-Za-z0-9_]{1,40}$/u;
const CLAVE_SENSIBLE = /token|secret|password|passwd|key|authorization|cookie/iu;
const MAX_FILTROS = 20;
const MAX_VALOR = 120;

/** Filtros de la consulta para la bitacora: SOLO parametros de query saneados (nunca cabeceras ni cuerpo). */
export function filtrosDeConsulta(c: Context<CoreAuthHonoEnv>): Record<string, unknown> {
  const filtros: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of new URL(c.req.url).searchParams.entries()) {
    if (n >= MAX_FILTROS) break;
    if (!CLAVE_VALIDA.test(k) || CLAVE_SENSIBLE.test(k) || k in filtros) continue;
    filtros[k] = v.slice(0, MAX_VALOR);
    n += 1;
  }
  filtros._ruta = c.req.path.slice(0, 160);
  return filtros;
}

export function zonaCfoMiddleware(deps: AppDeps): MiddlewareHandler<CoreAuthHonoEnv> {
  return async (c, next) => {
    if (!deps.cfoZoneRepo) {
      await next();
      return;
    }
    const repo = deps.cfoZoneRepo;
    const callerId = c.get("userId");
    const method = c.req.method;
    const path = c.req.path;
    const ruta = rutaFinanciera(method, path);

    const { availability, rol } = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).resolveRole(callerId));
    if (availability === "not_migrated") {
      await next();
      return;
    }
    // Ya paso el gateo de superadmin; un rol nulo aqui es una inconsistencia: se falla cerrado.
    if (rol === null) throw Errors.forbidden("No tienes acceso a la zona CFO.");

    // Una transaccion PROPIA por registro: queda confirmada antes del handler y sobrevive a sus errores.
    const registrar = async (accion: ZonaCfoAccion, recurso: string): Promise<void> => {
      try {
        await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).logAccess(callerId, accion, recurso, filtrosDeConsulta(c)));
      } catch {
        throw Errors.serviceUnavailable("No se pudo registrar la consulta financiera; por seguridad no se ejecuta.");
      }
    };
    const registrarDenegado = async (recurso: string): Promise<void> => {
      try {
        await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).logAccess(callerId, "denegado", recurso, filtrosDeConsulta(c)));
      } catch {
        // Mejor esfuerzo: el error original (403/503) es el que debe llegar al cliente.
      }
    };

    if (rol === "finanzas") {
      if (esAutoservicio(method, path)) {
        await next();
        return;
      }
      const etiqueta = `${method.toUpperCase()} ${ruta?.recurso ?? "fuera-de-la-zona"}`;
      if (ruta === null || !ruta.finanzas) {
        await registrarDenegado(etiqueta);
        throw new ApiError(403, "rol_finanzas_solo_lectura", "Tu rol (finanzas) es de solo lectura y solo accede a las pantallas financieras.");
      }
      try {
        await exigirStepUp(deps, c, { obligatorio: true });
      } catch (err) {
        await registrarDenegado(`${etiqueta} (sin step-up)`);
        throw err;
      }
      await registrar(ruta.exportacion ? "exportacion" : "consulta", ruta.recurso);
      await next();
      return;
    }

    if (ruta !== null) {
      try {
        await exigirStepUp(deps, c, { obligatorio: false });
      } catch (err) {
        await registrarDenegado(`GET ${ruta.recurso} (sin step-up)`);
        throw err;
      }
      await registrar(ruta.exportacion ? "exportacion" : "consulta", ruta.recurso);
    }
    await next();
  };
}
