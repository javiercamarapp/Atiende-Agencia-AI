// SoftRestaurant (POS de PM) -- rutas de STAFF para la bandera y las comandas que no
// llegaron al POS.
//
//   GET  /v1/restaurantes/:propertyId/admin/softrestaurant/config
//        -> modo efectivo + adaptador (MANAGER_ROLES)
//   PUT  /v1/restaurantes/:propertyId/admin/softrestaurant/config   { modo }
//        -> owner/admin. 'sombra'/'activo' exigen un adaptador REAL: con el puerto
//           "no configurado" (hoy) responde 409 y la bandera no se mueve.
//   GET  /v1/restaurantes/:propertyId/admin/softrestaurant/comandas?estado=&branchId=&limit=&offset=
//        -> por defecto las que requieren atencion o estan en camino (captura_manual,
//           fallida, pendiente, enviada). Acotado al alcance de sucursales del staff.
//   POST /v1/restaurantes/:propertyId/admin/softrestaurant/comandas/:comandaId/capturada  { nota? }
//        -> marca la comanda como capturada a mano (corta los reintentos). Bitacora de auditoria.
//   GET  /v1/restaurantes/:propertyId/admin/softrestaurant/estados?orderIds=a,b,c
//        -> estado de la comanda de cada pedido (insignia de Pedidos); lectura liviana, hasta 100 ids.
//   PUT  /v1/restaurantes/:propertyId/admin/softrestaurant/umbral-captura-manual  { branchId, minutos }
//        -> owner/admin. Minutos que una comanda puede esperar captura manual antes de avisar al staff (1..240; 5 por omision).
//
// Compatibilidad con la base SIN migrar: si la migracion 024 no esta aplicada, las
// lecturas responden `disponible: false` con lista vacia (nunca un 500) y las escrituras
// 503 con un mensaje claro.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { MANAGER_ROLES, STAFF_INVITE_ROLES, UUID_PATTERN } from "@atiende/domain-restaurantes";
import {
  ESTADOS_COMANDA,
  UMBRAL_CAPTURA_MANUAL_MAX,
  UMBRAL_CAPTURA_MANUAL_MIN,
  UMBRAL_CAPTURA_MANUAL_POR_OMISION_MIN,
  esEstadoComanda,
  esModoSoftRestaurant,
  type EstadoComanda,
  type FilaComandaOutbox,
} from "@atiende/domain-restaurantes/softrestaurant";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { parseBranchId, resolveEffectivePropertyIds } from "./admin-scope.ts";
import { softRestaurantPortFor, softRestaurantStoreFor } from "./softrestaurant-wiring.ts";

const ESTADOS_POR_DEFECTO: readonly EstadoComanda[] = ["captura_manual", "fallida", "pendiente", "enviada"];
const NOTA_MAX = 300;

function serializeComanda(f: FilaComandaOutbox, totalPedido: number | null = null) {
  return {
    id: f.id,
    propertyId: f.propertyId,
    orderId: f.orderId,
    estado: f.estado,
    modo: f.modo,
    intentos: f.intentos,
    maxIntentos: f.maxIntentos,
    proximoIntentoEn: f.proximoIntentoEn,
    folio: f.folio,
    ultimoError: f.ultimoError,
    capturadoPor: f.capturadoPor,
    capturadoEn: f.capturadoEn,
    notaCaptura: f.notaCaptura,
    creadoEn: f.creadoEn,
    /** Total del pedido en Atiende (la comanda nunca cobra: solo informa al staff que captura). */
    totalPedido,
    // Lo que el staff necesita para capturar la comanda a mano.
    comanda: f.payload,
  };
}

function parseEntero(raw: string | undefined, campo: string, min: number, max: number, defecto: number): number {
  if (raw === undefined || raw === "") return defecto;
  if (!/^\d+$/.test(raw)) throw Errors.validation(`${campo}: se esperaba un entero.`);
  const n = Number.parseInt(raw, 10);
  if (n < min || n > max) throw Errors.validation(`${campo}: se esperaba un entero entre ${min} y ${max}.`);
  return n;
}

function parseEstados(raw: string | undefined): readonly EstadoComanda[] {
  if (raw === undefined || raw === "") return ESTADOS_POR_DEFECTO;
  const partes = raw.split(",").map((s) => s.trim());
  for (const p of partes) {
    if (!esEstadoComanda(p)) throw Errors.validation(`estado: se esperaba uno de ${ESTADOS_COMANDA.join(", ")}.`);
  }
  return partes as EstadoComanda[];
}

interface ConfigBody {
  readonly modo?: unknown;
}

interface CapturaBody {
  readonly nota?: unknown;
}

interface UmbralBody {
  readonly branchId?: unknown;
  readonly minutos?: unknown;
}

const ESTADOS_IDS_MAX = 100;

export function restaurantesAdminSoftRestauranteRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const prefix = "/v1/restaurantes/:propertyId/admin/softrestaurant";
  app.use(`${prefix}/*`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(`${prefix}/config`, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const store = softRestaurantStoreFor(deps, c.get("db"));
    const organizationId = c.get("organizationId");
    const port = softRestaurantPortFor(deps);
    const modo = await store.leerModo(organizationId);
    const resumen = await store.resumen(organizationId, null);
    const umbrales = await store.leerUmbralesCapturaManual(organizationId);
    return c.json({
      modo,
      disponible: resumen.disponible,
      adaptador: { nombre: port.nombre, esReal: port.esReal },
      umbralCapturaManual: { porOmisionMin: UMBRAL_CAPTURA_MANUAL_POR_OMISION_MIN, minimo: UMBRAL_CAPTURA_MANUAL_MIN, maximo: UMBRAL_CAPTURA_MANUAL_MAX, disponible: umbrales.disponible, porSucursal: umbrales.porSucursal },
    });
  });

  app.put(`${prefix}/umbral-captura-manual`, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<UmbralBody>(c.req.raw, 2 * 1024);
    if (typeof raw.branchId !== "string" || !UUID_PATTERN.test(raw.branchId)) throw Errors.validation("branchId: se esperaba el id de una sucursal.");
    if (typeof raw.minutos !== "number" || !Number.isInteger(raw.minutos) || raw.minutos < UMBRAL_CAPTURA_MANUAL_MIN || raw.minutos > UMBRAL_CAPTURA_MANUAL_MAX) {
      throw Errors.validation(`minutos: se esperaba un entero entre ${UMBRAL_CAPTURA_MANUAL_MIN} y ${UMBRAL_CAPTURA_MANUAL_MAX}.`);
    }
    // La sucursal debe ser de la organizacion del staff (y de su alcance).
    await resolveEffectivePropertyIds(deps, c, organizationId, raw.branchId);
    const store = softRestaurantStoreFor(deps, c.get("db"));
    const antes = (await store.leerUmbralesCapturaManual(organizationId)).porSucursal[raw.branchId] ?? UMBRAL_CAPTURA_MANUAL_POR_OMISION_MIN;
    let resultado: { disponible: boolean };
    try {
      resultado = await store.fijarUmbralCapturaManual(raw.branchId, raw.minutos);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "42501") throw Errors.forbidden("Solo owner/admin pueden cambiar el umbral de captura manual.");
      throw err;
    }
    if (!resultado.disponible) throw Errors.serviceUnavailable("Esta funcion requiere la migracion 054 de restaurantes, aun no aplicada en esta base.");
    logEvent(c, "info", "restaurantes_softrestaurant_umbral_captura_manual", { actorUserId: c.get("userId"), organizationId, branchId: raw.branchId, antes, despues: raw.minutos });
    if (antes !== raw.minutos) {
      await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
        organizationId,
        actorUserId: c.get("userId"),
        action: "softrestaurant.umbral_captura_manual",
        entityType: "configuracion",
        entityId: raw.branchId,
        campo: "softrestaurant.umbral_captura_manual_min",
        antes: String(antes),
        despues: String(raw.minutos),
      });
    }
    return c.json({ branchId: raw.branchId, minutos: raw.minutos });
  });

  app.get(`${prefix}/estados`, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const crudo = c.req.query("orderIds") ?? "";
    const ids = crudo === "" ? [] : crudo.split(",").map((x) => x.trim());
    if (ids.length > ESTADOS_IDS_MAX) throw Errors.validation(`orderIds: hasta ${ESTADOS_IDS_MAX} ids por consulta.`);
    for (const id of ids) if (!UUID_PATTERN.test(id)) throw Errors.validation("orderIds: se esperaba una lista de ids separados por coma.");
    const store = softRestaurantStoreFor(deps, c.get("db"));
    const r = await store.estadosPorPedidos(c.get("organizationId"), [...new Set(ids)]);
    return c.json({ disponible: r.disponible, estados: r.estados });
  });

  app.put(`${prefix}/config`, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<ConfigBody>(c.req.raw, 2 * 1024);
    if (!esModoSoftRestaurant(raw.modo)) throw Errors.validation("modo: se esperaba apagado, sombra o activo.");
    const nuevo = raw.modo;
    const port = softRestaurantPortFor(deps);
    if (nuevo !== "apagado" && !port.esReal) {
      // Con un adaptador falso/no configurado prender la bandera mandaria TODAS las
      // comandas a captura manual y llenaria al staff de alertas: se rechaza.
      throw Errors.conflict("El adaptador real de SoftRestaurant aun no esta configurado: solo se puede dejar la bandera en 'apagado'.");
    }
    const store = softRestaurantStoreFor(deps, c.get("db"));
    const antes = await store.leerModo(organizationId);
    let resultado: { disponible: boolean };
    try {
      resultado = await store.fijarModo(organizationId, nuevo);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "42501") throw Errors.forbidden("Solo owner/admin pueden cambiar la bandera de SoftRestaurant.");
      throw err;
    }
    if (!resultado.disponible) throw Errors.serviceUnavailable("La migracion de SoftRestaurant (024) aun no esta aplicada en esta base.");
    logEvent(c, "info", "restaurantes_softrestaurant_modo_cambiado", { actorUserId: c.get("userId"), organizationId, antes, despues: nuevo });
    if (antes !== nuevo) {
      await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
        organizationId,
        actorUserId: c.get("userId"),
        action: "softrestaurant.modo_cambiado",
        entityType: "configuracion",
        entityId: null,
        campo: "softrestaurant.modo",
        antes,
        despues: nuevo,
      });
    }
    return c.json({ modo: nuevo });
  });

  app.get(`${prefix}/comandas`, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const store = softRestaurantStoreFor(deps, c.get("db"));
    const organizationId = c.get("organizationId");
    const propertyIds = await resolveEffectivePropertyIds(deps, c, organizationId, parseBranchId(c.req.query("branchId")));
    const estados = parseEstados(c.req.query("estado"));
    const limite = parseEntero(c.req.query("limit"), "limit", 1, 100, 50);
    const offset = parseEntero(c.req.query("offset"), "offset", 0, 100000, 0);
    const lista = await store.listar(organizationId, { propertyIds, estados, limite, offset });
    const resumen = await store.resumen(organizationId, propertyIds);
    // Total del pedido de cada comanda (hasta `limit` lecturas por llave primaria; el outbox no guarda totales).
    const repo = deps.restaurantesRepo(c.get("db"));
    const totales = new Map<string, number>();
    for (const f of lista.filas) {
      const pedido = await repo.findOrderById(organizationId, f.orderId);
      if (pedido) totales.set(f.orderId, pedido.total);
    }
    return c.json({
      disponible: lista.disponible,
      comandas: lista.filas.map((f) => serializeComanda(f, totales.get(f.orderId) ?? null)),
      resumen: resumen.porEstado,
      // Conteo de "requieren atencion" para el badge del panel.
      requierenAtencion: resumen.porEstado.captura_manual + resumen.porEstado.fallida,
    });
  });

  app.post(`${prefix}/comandas/:comandaId/capturada`, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const comandaId = c.req.param("comandaId");
    if (!UUID_PATTERN.test(comandaId)) throw Errors.validation("comandaId invalido.");
    const raw = await readJsonCapped<CapturaBody>(c.req.raw, 4 * 1024);
    if (raw.nota !== undefined && raw.nota !== null && (typeof raw.nota !== "string" || raw.nota.length > NOTA_MAX)) {
      throw Errors.validation(`nota: texto de hasta ${NOTA_MAX} caracteres.`);
    }
    const nota = typeof raw.nota === "string" && raw.nota.trim() ? raw.nota.trim() : null;

    const store = softRestaurantStoreFor(deps, c.get("db"));
    const fila = await store.obtener(organizationId, comandaId);
    if (!fila) throw Errors.notFound("Comanda no encontrada.");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null && !scope.includes(fila.propertyId)) throw Errors.forbidden("No tienes acceso a esta comanda.");

    const r = await store.marcarCapturada(organizationId, comandaId, c.get("userId"), nota);
    if (r.resultado === "no_encontrada") throw Errors.notFound("Comanda no encontrada.");
    if (r.resultado === "estado_invalido") throw Errors.conflict(`La comanda esta en estado '${fila.estado}' y ya no admite captura manual.`);
    if (r.resultado === "prohibido") throw Errors.forbidden("No tienes permiso para capturar esta comanda.");
    if (r.resultado === "no_disponible") throw Errors.serviceUnavailable("La migracion de SoftRestaurant (024) aun no esta aplicada en esta base.");

    logEvent(c, "info", "restaurantes_softrestaurant_comanda_capturada", { actorUserId: c.get("userId"), organizationId, comandaId, orderId: fila.orderId, estadoAnterior: fila.estado });
    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "comanda.captura_manual",
      entityType: "pedido",
      entityId: fila.orderId,
      campo: "comanda_pos.estado",
      antes: fila.estado,
      despues: nota ? `capturada_manual: ${nota}` : "capturada_manual",
    });
    return c.json({ comanda: serializeComanda(r.fila) });
  });

  return app;
}
