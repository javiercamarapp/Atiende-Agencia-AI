// «Agregados por validar» (migración 099): el cliente ya tiene un pedido enviado a la sucursal y pide agregar productos. El agente crea la solicitud; aquí la sucursal decide.
//   GET  /v1/restaurantes/:propertyId/admin/agregados?estado=pendientes|recientes   cola (la más antigua primero) con el pedido original, lo agregado y el cronómetro
//   POST /v1/restaurantes/:propertyId/admin/agregados/:id/visto                      marca la primera vez que una persona la vio (idempotente)
//   POST /v1/restaurantes/:propertyId/admin/agregados/:id/aceptar {version}          aplica los renglones al pedido y avisa al cliente (compare-and-set: doble clic = un efecto)
//   POST /v1/restaurantes/:propertyId/admin/agregados/:id/rechazar {version, motivo, nota?}   motivo de lista cerrada; avisa al cliente y deja la tarea de devolver llamada
// `version` es OBLIGATORIA: la que la persona vio en pantalla. Si el cliente pidio mas entre tanto (fusion, version + 1) responde 409 `agregado_version_cambio` con la tarjeta
// vigente y NO decide nada (el pedido y el aviso al cliente nunca quedan desfasados). Si ya pasaron 20 min la solicitud se cierra como vencida y responde 409 `agregado_vencido`.
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

  async function decidir(c: Context<CoreAuthHonoEnv>, decision: DecisionAgregado, versionEsperada: number) {
    assertAccion(c, "pedidos.agregados");
    const id = idDe(c);
    const organizationId = c.get("organizationId");
    const actorUserId = c.get("userId");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    const agregados = repoAgregados(c);
    const repo = deps.restaurantesRepo(c.get("db"));
    const { resultado, efectos } = await resolverAgregado({ agregados, repo, db: c.get("db") }, { organizationId, id, decision, actorUserId, propertyIds: scope, versionEsperada });
    if (resultado.resultado === "no_disponible") throw Errors.serviceUnavailable("Agregados por validar todavía no está disponible en esta cuenta.");
    if (resultado.resultado === "no_encontrado") throw Errors.notFound("No se encontró ese agregado.");
    const tarjeta = aTarjetaAgregado(resultado.agregado, new Date());
    // 409 SIN lanzar: lo escrito (el cierre por vencimiento y sus avisos) debe confirmarse; un throw revertiria la transaccion. La tarjeta viaja para que la pantalla se refresque.
    if (resultado.resultado === "vencido") {
      logEvent(c, "info", "restaurantes_agregado_vencido_al_decidir", { agregadoId: id, efectos: efectos.length });
      return c.json({ code: "agregado_vencido", message: "Esta solicitud ya venció (pasaron más de 20 minutos) y se cerró sin aceptarse. Ofrece al cliente un pedido aparte.", resultado: "vencido", agregado: tarjeta }, 409);
    }
    if (resultado.resultado === "version_cambio") {
      return c.json({ code: "agregado_version_cambio", message: "El cliente agregó más productos mientras la veías. Revisa la solicitud actualizada y decide de nuevo.", resultado: "version_cambio", agregado: tarjeta }, 409);
    }
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

  function versionDe(raw: { version?: unknown }): number {
    if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1 || raw.version > 50) throw Errors.validation("version: indica la versión de la solicitud que viste (entero 1..50).");
    return raw.version;
  }

  app.post(`${base}/:id/aceptar`, async (c) => {
    assertAccion(c, "pedidos.agregados");
    const raw = await readJsonCapped<{ version?: unknown }>(c.req.raw, 1024);
    return decidir(c, { tipo: "aceptar" }, versionDe(raw));
  });

  app.post(`${base}/:id/rechazar`, async (c) => {
    assertAccion(c, "pedidos.agregados");
    const raw = await readJsonCapped<{ version?: unknown; motivo?: unknown; nota?: unknown }>(c.req.raw, 2 * 1024);
    if (!esMotivoRechazoAgregado(raw.motivo)) throw Errors.validation(`motivo: debe ser uno de ${MOTIVOS_RECHAZO_AGREGADO.map((m) => `«${m}» (${ETIQUETAS_MOTIVO_RECHAZO[m]})`).join(", ")}.`);
    if (raw.nota !== undefined && raw.nota !== null && (typeof raw.nota !== "string" || raw.nota.length > 300)) throw Errors.validation("nota: texto de hasta 300 caracteres.");
    if (raw.motivo === "otro" && (typeof raw.nota !== "string" || raw.nota.trim().length === 0)) throw Errors.validation("Con el motivo «Otro motivo» escribe una nota breve.");
    return decidir(c, { tipo: "rechazar", motivo: raw.motivo, nota: typeof raw.nota === "string" ? raw.nota.trim() || null : null }, versionDe(raw));
  });

  return app;
}
