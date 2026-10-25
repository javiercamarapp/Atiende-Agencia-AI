// ANDAMIAJE del panel movil del operador (PLAN-PANEL-OPERADOR §6, «commit 0»). Registra TODAS las rutas nuevas de la seccion 2 para que
// los paquetes B (Cola, Nuevo pedido, Viajes) y C (chofer y Turno) construyan contra rutas que ya existen, sin tocar archivos ajenos.
//
// Cada ruta: (1) autentica y abre la sesion de BD igual que el resto de las rutas de staff; (2) exige la membresia de la sucursal;
// (3) exige el rol (accion de la matriz para el encargado, REPARTIDOR_ROLES para el chofer) ANTES de contestar, de modo que un rol
// sin permiso recibe 403 y nunca se entera de si la ruta esta activa; y (4) responde 501 `no_implementado` con un mensaje honesto.
// Nunca devuelve un exito falso ni datos de ejemplo. El paquete A1 reemplaza cada 501 por la logica real moviendo la ruta a su
// archivo definitivo (admin-orders.ts, repartidor-orders.ts, admin-operacion...) y borrando su linea de aqui.
//
// Montaje: este router va ANTES de admin-orders / admin-customers / repartidor-orders en restaurantes.ts. Las rutas llevan su
// middleware a nivel de ruta (no `app.use` por prefijo) para no duplicar la sesion de BD de las rutas vigentes que comparten
// prefijo (p. ej. `GET admin/orders`); una ruta de este archivo que responde corta la cadena, asi que el middleware por prefijo
// de los otros archivos nunca corre dos veces. Las rutas vigentes (GET admin/orders, GET admin/orders/:orderId, PATCH .../status,
// GET repartidor/orders, ...) NO se tocan.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { ApiError, assertVerticalRole, authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { REPARTIDOR_ROLES } from "@atiende/domain-restaurantes";
import type { AccionRestaurantes } from "@atiende/domain-restaurantes";
import { MENSAJE_NO_IMPLEMENTADO, RUTAS_OPERACION } from "@atiende/domain-restaurantes/operacion";
import type { NombreRutaOperacion } from "@atiende/domain-restaurantes/operacion";
import type { AppDeps } from "../../../deps.ts";
import { assertAccion } from "./permisos-accion.ts";

/** Quien puede llamar cada ruta: una accion de la matriz (encargado/cajero) o el rol repartidor (chofer). */
const PERMISO: Readonly<Record<NombreRutaOperacion, AccionRestaurantes | "repartidor">> = {
  capturarPedido: "pedidos.capturar",
  cotizarPedido: "pedidos.capturar",
  clientePorTelefono: "pedidos.capturar",
  cola: "pedidos.gestionar",
  despachar: "viajes.despachar",
  marcarListo: "pedidos.gestionar",
  viajes: "viajes.despachar",
  hoy: "turno.ver",
  entregasChofer: "repartidor",
  entregar: "repartidor",
  deshacerEntrega: "repartidor",
  problema: "repartidor",
  llamar: "repartidor",
  hoyChofer: "repartidor",
};

function noImplementado(c: Context<CoreAuthHonoEnv>, nombre: NombreRutaOperacion): never {
  const permiso = PERMISO[nombre];
  if (permiso === "repartidor") assertVerticalRole(c, REPARTIDOR_ROLES);
  else assertAccion(c, permiso);
  throw new ApiError(501, "no_implementado", MENSAJE_NO_IMPLEMENTADO);
}

/** Rutas que ya tienen logica real en su archivo definitivo: el andamiaje NO las registra (el 501 taparia la real). */
const IMPLEMENTADAS: ReadonlySet<NombreRutaOperacion> = new Set<NombreRutaOperacion>(["llamar"]);

export function restaurantesOperacionAndamiajeRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const sesion = (): MiddlewareHandler<CoreAuthHonoEnv>[] => [authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId")];

  for (const nombre of Object.keys(RUTAS_OPERACION) as NombreRutaOperacion[]) {
    if (IMPLEMENTADAS.has(nombre)) continue;
    const { metodo, patron } = RUTAS_OPERACION[nombre];
    const [m1, m2, m3] = sesion();
    const manejador = async (c: Context<CoreAuthHonoEnv>): Promise<Response> => noImplementado(c, nombre);
    if (metodo === "GET") app.get(patron, m1!, m2!, m3!, manejador);
    else app.post(patron, m1!, m2!, m3!, manejador);
  }

  return app;
}
