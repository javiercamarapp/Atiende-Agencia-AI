// Pin de sucursal: buscar una direccion o colonia y (al mover el pin) sugerir la direccion del punto. La llamada al proveedor de mapas sale
// del SERVIDOR (apps/api/src/geocodificacion.ts): ninguna llave llega al navegador y el proveedor se elige por configuracion.
//   GET /v1/restaurantes/:propertyId/admin/geocodificar?q=texto            -> { proveedor, resultados: [{ etiqueta, lat, lng }] }
//   GET /v1/restaurantes/:propertyId/admin/geocodificar/inverso?lat=&lng=  -> { proveedor, etiqueta | null }
//
// Autorizacion: la misma accion que editar la sucursal (`sucursal.editar`: dueno o administrador). Solo sirve para capturar la ubicacion.
// Tope por persona (sesion de sistema, `consumirTopesEnSesionDeSistema`): 30 por minuto, suficiente para escribir y mover el pin y lo
// bastante bajo para respetar la politica de uso de Nominatim. Sin proveedor configurado: 503 «no disponible aun», nunca un pin inventado.
// La bitacora NO guarda el texto buscado (es la direccion del negocio, pero no aporta nada al registro).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { GeocodificacionFallidaError } from "../../../geocodificacion.ts";
import type { Geocodificador } from "../../../geocodificacion.ts";
import { Errors } from "../../../errors.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { assertAccion } from "./permisos-accion.ts";
import { consumirTopesEnSesionDeSistema } from "./rate-limit-sistema.ts";

export const GEOCODIFICAR_Q_MIN = 3;
export const GEOCODIFICAR_Q_MAX = 200;
export const GEOCODIFICAR_TOPE_POR_MINUTO = 30;
export const AVISO_GEOCODIFICACION_NO_CONFIGURADA = "La búsqueda de direcciones no está disponible aún: requiere configurar GEOCODING_PROVIDER en la API.";

function coordenada(raw: string | undefined, campo: "lat" | "lng"): number {
  const limite = campo === "lat" ? 90 : 180;
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(n) || n < -limite || n > limite) throw Errors.validation(`${campo}: se esperaba un número entre -${limite} y ${limite}.`);
  // 6 decimales (~10 cm) bastan para un pin y no mandan al proveedor mas precision de la que existe.
  return Math.round(n * 1e6) / 1e6;
}

export function restaurantesGeocodificarRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/restaurantes/:propertyId/admin/geocodificar";
  for (const path of [base, `${base}/inverso`]) app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function preparar(c: Context<CoreAuthHonoEnv>): Promise<Geocodificador> {
    assertAccion(c, "sucursal.editar");
    const geo = deps.geocodificador;
    if (!geo) throw Errors.serviceUnavailable(AVISO_GEOCODIFICACION_NO_CONFIGURADA);
    const agotado = await consumirTopesEnSesionDeSistema(deps, [{ scope: "geocodificar", actor: `${c.get("organizationId")}:${c.get("userId")}`, maxRequests: GEOCODIFICAR_TOPE_POR_MINUTO, windowSeconds: 60 }]);
    if (agotado !== null) throw Errors.tooManyRequests("Demasiadas búsquedas seguidas: espera un minuto.");
    return geo;
  }

  async function conProveedor<T>(c: Context<CoreAuthHonoEnv>, geo: Geocodificador, accion: () => Promise<T>): Promise<T> {
    try {
      return await accion();
    } catch (err) {
      if (err instanceof GeocodificacionFallidaError) {
        logEvent(c, "warn", "restaurantes_geocodificar_proveedor_fallo", { proveedor: geo.proveedor, organizationId: c.get("organizationId") });
        throw Errors.serviceUnavailable("El servicio de mapas no respondió. Intenta de nuevo o pega las coordenadas de Google Maps.");
      }
      throw err;
    }
  }

  app.get(base, async (c) => {
    const q = (c.req.query("q") ?? "").trim().replace(/\s+/g, " ");
    if (q.length < GEOCODIFICAR_Q_MIN || q.length > GEOCODIFICAR_Q_MAX) throw Errors.validation(`q: escribe de ${GEOCODIFICAR_Q_MIN} a ${GEOCODIFICAR_Q_MAX} caracteres.`);
    const geo = await preparar(c);
    const resultados = await conProveedor(c, geo, () => geo.buscar(q));
    return c.json({ proveedor: geo.proveedor, resultados });
  });

  app.get(`${base}/inverso`, async (c) => {
    const lat = coordenada(c.req.query("lat"), "lat");
    const lng = coordenada(c.req.query("lng"), "lng");
    const geo = await preparar(c);
    const etiqueta = await conProveedor(c, geo, () => geo.inverso(lat, lng));
    return c.json({ proveedor: geo.proveedor, etiqueta });
  });

  return app;
}
