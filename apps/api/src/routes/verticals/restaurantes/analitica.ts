// Analítica del dueño (F7): demanda, zonas, productos/combos y ratios bajo `/v1/restaurantes/:propertyId/admin/analitica/*`. Solo lectura, salvo el costo por
// producto (PUT), que alimenta el margen.
//
// Seguridad y alcance (mismas reglas que el CFO):
//  - authMiddleware -> dbSession -> requirePropertyMembership. Acción `cfo.ver` (solo owner/admin; staff y repartidor reciben 403 SIN tocar la base). El costo
//    por producto exige `cfo.capturar` Y alcance de organización completa (un admin acotado a sucursales lo lee pero no lo cambia).
//  - `sucursales=<ids>`: cada id se valida contra el alcance del actor (membresía); ajena, de otra organización o inexistente da el MISMO 403. La base vuelve
//    a validar (cfo_resolver_sucursales): doble puerta. Sin PII en ninguna respuesta (agregados, colonias con k = 5, nombres de menú).
//  - Estados honestos: base sin las migraciones 160-162 => 200 con `disponible: false` (nunca 500); SQL 22023 => 400; 42501 => 403; query inválida => 422.
//  - Tope por persona y organización (consume_api_rate_limit en sesión de sistema); lecturas con ETag débil.
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { AnaliticaNoDisponibleError, AnaliticaParametroInvalidoError, AnaliticaSinAccesoError, ServicioAnalitica } from "@atiende/domain-restaurantes/analitica";
import type { AnaliticaRepository } from "@atiende/domain-restaurantes/analitica";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { assertAccion } from "./permisos-accion.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import { consumirTopesEnSesionDeSistema } from "./rate-limit-sistema.ts";
import { invalido, parsearConsulta } from "./cfo-esquemas.ts";

const BASE = "/v1/restaurantes/:propertyId/admin/analitica";
const MENSAJE_SIN_ACCESO = "No tienes acceso a esta sucursal.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ANALITICA_LIMITES = { lecturaPorMin: 60, escrituraPorMin: 20 } as const;

function repoDe(deps: AppDeps, c: Context<CoreAuthHonoEnv>): AnaliticaRepository {
  if (!deps.analiticaRestaurantesRepo) throw Errors.serviceUnavailable("La analítica no está disponible en este despliegue.");
  return deps.analiticaRestaurantesRepo(c.get("db"));
}

async function protegido<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof AnaliticaParametroInvalidoError) throw Errors.validation(err.message);
    if (err instanceof AnaliticaSinAccesoError) throw Errors.forbidden(MENSAJE_SIN_ACCESO);
    if (err instanceof AnaliticaNoDisponibleError) throw Errors.serviceUnavailable("Esta función de analítica todavía no está disponible: falta aplicar la actualización de base de datos.");
    throw err;
  }
}

export function restaurantesAnaliticaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.use(`${BASE}/*`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function limitar(c: Context<CoreAuthHonoEnv>, scope: string, max: number): Promise<void> {
    const agotado = await consumirTopesEnSesionDeSistema(deps, [{ scope, actor: `${c.get("organizationId")}:${c.get("userId")}`, maxRequests: max, windowSeconds: 60 }]);
    if (agotado !== null) throw Errors.tooManyRequests();
  }

  function jsonConEtag(c: Context<CoreAuthHonoEnv>, data: unknown): Response {
    const texto = JSON.stringify(data);
    const etag = `W/"${createHash("sha256").update(texto).digest("base64url").slice(0, 22)}"`;
    const headers: Record<string, string> = { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Authorization" };
    const previo = c.req.header("if-none-match");
    if (previo && previo.split(",").some((x) => x.trim() === etag)) return new Response(null, { status: 304, headers });
    return new Response(texto, { status: 200, headers: { ...headers, "content-type": "application/json; charset=UTF-8" } });
  }

  /** Alcance del actor (membresía) y sucursales elegidas. `ids === null` = todas las permitidas. */
  async function alcance(c: Context<CoreAuthHonoEnv>, ids: readonly string[] | null) {
    const organizationId = c.get("organizationId");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    const ramas = await deps.restaurantesRepo(c.get("db")).listBranchesForOrganizationAdmin(organizationId);
    const organizacionCompleta = scope === null;
    const permitidas = ramas.filter((b) => organizacionCompleta || (scope as readonly string[]).includes(b.propertyId)).map((b) => ({ propertyId: b.propertyId, nombre: b.name }));
    let elegidas = permitidas;
    let propertyIds: readonly string[] | null = organizacionCompleta ? null : permitidas.map((p) => p.propertyId);
    if (ids !== null) {
      elegidas = ids.map((id) => {
        const s = permitidas.find((p) => p.propertyId === id);
        if (!s) throw Errors.forbidden(MENSAJE_SIN_ACCESO);
        return s;
      });
      propertyIds = elegidas.map((s) => s.propertyId);
    }
    return { organizationId, organizacionCompleta, permitidas, servicio: new ServicioAnalitica(repoDe(deps, c), { organizationId, propertyIds, sucursales: elegidas }) };
  }

  function lectura(path: string, armar: (s: ServicioAnalitica, q: { desde: string; hasta: string }, c: Context<CoreAuthHonoEnv>) => Promise<unknown>): void {
    app.get(`${BASE}${path}`, async (c) => {
      assertAccion(c, "cfo.ver");
      await limitar(c, "analitica-lectura", ANALITICA_LIMITES.lecturaPorMin);
      const q = parsearConsulta((k) => c.req.query(k));
      return protegido(async () => {
        const { servicio } = await alcance(c, q.sucursales);
        const vista = await armar(servicio, q, c);
        logEvent(c, "info", "restaurantes_analitica_leida", { actorUserId: c.get("userId"), organizationId: c.get("organizationId"), vista: path.slice(1), desde: q.desde, hasta: q.hasta });
        return jsonConEtag(c, vista);
      });
    });
  }

  lectura("/demanda", (s, q) => s.demanda(q.desde, q.hasta));
  lectura("/zonas", (s, q) => s.zonas(q.desde, q.hasta));
  lectura("/ratios", (s, q) => s.ratios(q.desde, q.hasta));
  lectura("/productos", (s, q, c) => {
    const raw = c.req.query("limite");
    if (raw !== undefined && (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 200)) throw invalido("limite debe ser un entero entre 1 y 200.");
    return s.productos(q.desde, q.hasta, raw === undefined ? undefined : Number(raw));
  });

  // Costo unitario de un producto (alimenta el margen). null borra el costo.
  app.put(`${BASE}/productos/:productId/costo`, async (c) => {
    assertAccion(c, "cfo.capturar");
    await limitar(c, "analitica-escritura", ANALITICA_LIMITES.escrituraPorMin);
    const productId = c.req.param("productId");
    if (!UUID_RE.test(productId)) throw invalido("productId inválido.");
    const cuerpo = await readJsonCapped<unknown>(c.req.raw, 1024);
    if (cuerpo === null || typeof cuerpo !== "object" || Array.isArray(cuerpo) || !("costo" in cuerpo)) throw invalido("Falta el costo (número en pesos, o null para borrarlo).");
    const costo = (cuerpo as { costo: unknown }).costo;
    if (costo !== null && (typeof costo !== "number" || !Number.isFinite(costo) || costo < 0 || costo > 100000)) throw invalido("costo debe ser un número entre 0 y 100000, o null.");
    return protegido(async () => {
      const a = await alcance(c, null);
      // El costo es de la ORGANIZACIÓN: un admin acotado a sucursales lo lee pero no lo cambia (la base también lo exige).
      if (!a.organizacionCompleta) throw Errors.forbidden("Solo el dueño o un administrador de toda la organización puede capturar costos de productos.");
      await repoDe(deps, c).guardarCostoProducto(a.organizationId, productId, costo === null ? null : Math.round(costo * 100) / 100);
      logEvent(c, "info", "restaurantes_analitica_costo_producto", { actorUserId: c.get("userId"), organizationId: a.organizationId, borrado: costo === null });
      return c.json({ guardado: true, productId, costo });
    });
  });

  return app;
}
