// «Agregados por validar» (migración 097): el cliente ya tiene un pedido enviado a la sucursal y pide agregar productos. El agente crea la solicitud; aquí la sucursal decide.
//   GET  /v1/restaurantes/:propertyId/admin/agregados?estado=pendientes|recientes   cola (la más antigua primero) con el pedido original, lo agregado y el cronómetro
//   POST /v1/restaurantes/:propertyId/admin/agregados/:id/visto                      marca la primera vez que una persona la vio (idempotente)
//   POST /v1/restaurantes/:propertyId/admin/agregados/:id/aceptar                    aplica los renglones al pedido y avisa al cliente (compare-and-set: doble clic = un efecto)
//   POST /v1/restaurantes/:propertyId/admin/agregados/:id/rechazar {motivo, nota?}   motivo de lista cerrada; avisa al cliente y deja la tarea de devolver llamada
// Permiso: acción `pedidos.agregados` (owner/admin/staff; el repartidor NO). Alcance: la membresía (admin acotado o staff de sucursal ve solo lo suyo; fuera de alcance = 404).
// Idempotencia: la base hace compare-and-set sobre `pendiente`; la segunda llamada responde 200 `ya_resuelto` con quién y cuándo, sin repetir ningún efecto.
// SLA: el estado efectivo (`estadoEfectivo`, `sla`) se DERIVA del reloj al leer; el cierre y los avisos los hace el tick existente de 5 min (sin cron nuevo).
// Base SIN migrar: la lectura responde `disponible: false` con lista vacía y las escrituras 503 (estado honesto, nunca un 500).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { MOTIVOS_RECHAZO_AGREGADO, ETIQUETAS_MOTIVO_RECHAZO, aTarjetaAgregado, esMotivoRechazoAgregado, resolverAgregado } from "@atiende/domain-restaurantes";
import type { AgregadosRepository, DecisionAgregado } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import { assertAccion } from "./permisos-accion.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECIENTES_HORAS = 24;

export function restaurantesAdminAgregadosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/restaurantes/:propertyId/admin/agregados";
  for (const path of [base, `${base}/:id/visto`, `${base}/:id/aceptar`, `${base}/:id/rechazar`]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  function repoAgregados(c: Context<CoreAuthHonoEnv>): AgregadosRepository {
    if (!deps.agregadosRepo) throw Errors.serviceUnavailable("Agregados por validar no está disponible en este despliegue.");
    return deps.agregadosRepo(c.get("db"));
  }

  app.get(base, async (c) => {
    assertAccion(c, "pedidos.agregados");
    const organizationId = c.get("organizationId");
    const estado = c.req.query("estado") ?? "pendientes";
    if (estado !== "pendientes" && estado !== "recientes") throw Errors.validation("estado debe ser «pendientes» o «recientes».");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    const ahora = new Date();
    const agregados = deps.agregadosRepo ? deps.agregadosRepo(c.get("db")) : null;
    if (!agregados) return c.json({ disponible: false, agregados: [], pendientes: 0, ahora: ahora.toISOString() });
    const r = await agregados.listar(organizationId, {
      propertyIds: scope,
      limite: estado === "pendientes" ? 100 : 100,
      ...(estado === "pendientes" ? { estados: ["pendiente" as const] } : { desde: new Date(ahora.getTime() - RECIENTES_HORAS * 3_600_000).toISOString() }),
    });
    const tarjetas = r.valor.map((a) => aTarjetaAgregado(a, ahora));
    // Recientes: lo abierto primero (más antiguo arriba), luego lo resuelto más reciente primero.
    const ordenadas = estado === "recientes" ? [...tarjetas.filter((t) => t.estado === "pendiente"), ...tarjetas.filter((t) => t.estado !== "pendiente").sort((a, b) => Date.parse(b.resueltoEn ?? b.solicitadoEn) - Date.parse(a.resueltoEn ?? a.solicitadoEn))] : tarjetas;
    return c.json({ disponible: r.disponible, agregados: ordenadas, pendientes: tarjetas.filter((t) => t.estado === "pendiente").length, ahora: ahora.toISOString() });
  });

  function idDe(c: Context<CoreAuthHonoEnv>): string {
    const id = c.req.param("id") ?? "";
    if (!UUID_RE.test(id)) throw Errors.validation("id de agregado inválido.");
    return id;
  }

  app.post(`${base}/:id/visto`, async (c) => {
    assertAccion(c, "pedidos.agregados");
    const id = idDe(c);
    const organizationId = c.get("organizationId");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    await repoAgregados(c).marcarVisto(organizationId, id, c.get("userId"), scope);
    return c.json({ ok: true });
  });

  async function decidir(c: Context<CoreAuthHonoEnv>, decision: DecisionAgregado) {
    assertAccion(c, "pedidos.agregados");
    const id = idDe(c);
    const organizationId = c.get("organizationId");
    const actorUserId = c.get("userId");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    const agregados = repoAgregados(c);
    const repo = deps.restaurantesRepo(c.get("db"));
    const { resultado, efectos } = await resolverAgregado({ agregados, repo, db: c.get("db") }, { organizationId, id, decision, actorUserId, propertyIds: scope });
    if (resultado.resultado === "no_disponible") throw Errors.serviceUnavailable("Agregados por validar todavía no está disponible en esta cuenta.");
    if (resultado.resultado === "no_encontrado") throw Errors.notFound("No se encontró ese agregado.");
    const tarjeta = aTarjetaAgregado(resultado.agregado, new Date());
    // Bitácora de auditoría SOLO cuando esta llamada resolvió (un doble clic no duplica la entrada). Sin PII: folio, ids y motivo de lista cerrada.
    if (resultado.resultado !== "ya_resuelto") {
      await repo.registrarAuditoria({
        organizationId,
        actorUserId,
        action: resultado.resultado === "no_aplicable" ? "agregado.no_aplicable" : decision.tipo === "aceptar" ? "agregado.aceptado" : "agregado.rechazado",
        entityType: "pedido",
        entityId: resultado.agregado.orderId,
        campo: "agregado",
        antes: `solicitud ${resultado.agregado.id}: pendiente; total ${resultado.agregado.totalBefore}`,
        despues:
          decision.tipo === "aceptar" && resultado.resultado === "aplicado"
            ? `aceptado; total ${resultado.agregado.totalAfter}`
            : decision.tipo === "rechazar"
              ? `rechazado (${decision.motivo}); total ${resultado.agregado.totalBefore}`
              : `no aplicable (pedido ${resultado.agregado.orderStatus}); total ${resultado.agregado.totalBefore}`,
      });
    }
    logEvent(c, "info", "restaurantes_agregado_resuelto", { agregadoId: id, resultado: resultado.resultado, decision: decision.tipo, efectos: efectos.length });
    return c.json({ resultado: resultado.resultado, agregado: tarjeta });
  }

  app.post(`${base}/:id/aceptar`, async (c) => decidir(c, { tipo: "aceptar" }));

  app.post(`${base}/:id/rechazar`, async (c) => {
    assertAccion(c, "pedidos.agregados");
    const raw = await readJsonCapped<{ motivo?: unknown; nota?: unknown }>(c.req.raw, 2 * 1024);
    if (!esMotivoRechazoAgregado(raw.motivo)) throw Errors.validation(`motivo: debe ser uno de ${MOTIVOS_RECHAZO_AGREGADO.map((m) => `«${m}» (${ETIQUETAS_MOTIVO_RECHAZO[m]})`).join(", ")}.`);
    if (raw.nota !== undefined && raw.nota !== null && (typeof raw.nota !== "string" || raw.nota.length > 300)) throw Errors.validation("nota: texto de hasta 300 caracteres.");
    if (raw.motivo === "otro" && (typeof raw.nota !== "string" || raw.nota.trim().length === 0)) throw Errors.validation("Con el motivo «Otro motivo» escribe una nota breve.");
    return decidir(c, { tipo: "rechazar", motivo: raw.motivo, nota: typeof raw.nota === "string" ? raw.nota.trim() || null : null });
  });

  return app;
}
