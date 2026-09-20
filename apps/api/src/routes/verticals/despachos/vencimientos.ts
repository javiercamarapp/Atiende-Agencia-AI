// Flujo 3 (Fase 1 despachos §4): vencimientos fiscales con escalamiento. Autocontenido
// (sin SAT-RPA/FIEL/IMSS, Fase 2+), motor 100% determinista
// (@atiende/domain-despachos/vencimientos/engine.ts — mismo criterio que
// folioEngine.ts/quote.ts de hoteles: lógica de negocio pura, nunca un LLM decidiendo
// una fecha límite fiscal).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import {
  GESTION_VENCIMIENTOS_ROLES,
  VER_VENCIMIENTOS_ROLES,
  calcularVencimientosDelPeriodo,
  diasHasta,
  decidirEscalamiento,
  tryEnqueueEscalationEmail,
} from "@atiende/domain-despachos";
import type { FiscalDeadlineRecord } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { INLINE_BATCH_SIZE, runDespachosEmailDispatch, triggerDespachosEmailDispatchInline } from "./notifications.ts";
import { resolverZonaHorariaDespachosProperty } from "./zona-horaria.ts";

interface CalcularBody {
  readonly year?: unknown;
  readonly month?: unknown;
}

interface CompletarBody {
  readonly comprobanteUrl?: unknown;
}

// Bug real (revisión r6, misma causa raíz que `apps/web/src/lib/formato-fecha.ts::
// hoyFechaSolo` de PR #164, pero del lado del SERVIDOR): `new Date().toISOString().
// slice(0, 10)` da el día UTC del proceso; Vercel corre con `TZ=UTC`, así que entre
// las 18:00 y las 23:59 de America/Mexico_City (00:00-05:59 UTC) el servidor cree
// que YA ES MAÑANA -- `diasRestantes` (abajo) y `fechaPresentacion` (al completar,
// ver `markDeadlineCompleted`) quedaban corridos un día en esa ventana. Un solo
// helper de servidor (`@atiende/core-tenancy::hoyFechaNegocio`) reemplaza este
// `todayIso()` local -- ver su comentario de cabecera para el resto de call-sites
// con el mismo bug ya corregidos en esta misma ronda.
//
// FASE 3 (producto) — hasta esta fase, `todayIso()` SIEMPRE llamaba
// `hoyFechaNegocio()` SIN argumento (el default de plataforma), porque
// `despachos` no tenía ninguna columna de zona horaria real todavía (ver el
// comentario de cabecera de la migración 012). Ahora recibe la zona YA
// resuelta (`resolverZonaHorariaDespachosProperty`, una consulta por
// request -- nunca por deadline) en vez de asumir México siempre.
function todayIso(zonaHoraria: string): string {
  return hoyFechaNegocio(zonaHoraria);
}

function serializeDeadline(d: FiscalDeadlineRecord, hoy: string) {
  return {
    id: d.id,
    tipo: d.tipo,
    periodo: d.periodo,
    fechaLimite: d.fechaLimite,
    prioridad: d.prioridad,
    estado: d.estado,
    fechaPresentacion: d.fechaPresentacion,
    comprobanteUrl: d.comprobanteUrl,
    diasRestantes: diasHasta(d.fechaLimite, hoy),
    creadoEn: d.createdAt,
  };
}

export function despachosVencimientosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/vencimientos/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/despachos/:propertyId/vencimientos", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // Hallazgo de auditoría (severidad MEDIO, "el rol 'readonly' está definido pero
  // ninguna ruta lo usa realmente"): listar vencimientos es lectura de un
  // calendario ya persistido -- auditor/readonly SÍ pueden verlo
  // (VER_VENCIMIENTOS_ROLES), aunque nunca calcular/completar/escalar
  // (GESTION_VENCIMIENTOS_ROLES, sin cambios, abajo).
  app.get("/despachos/:propertyId/vencimientos", async (c) => {
    assertVerticalRole(c, VER_VENCIMIENTOS_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const estado = c.req.query("estado");
    const [deadlines, zonaHoraria] = await Promise.all([repo.listDeadlines(propertyId, estado ? { estado } : undefined), resolverZonaHorariaDespachosProperty(repo, propertyId)]);
    const hoy = todayIso(zonaHoraria);
    return c.json(deadlines.map((d) => serializeDeadline(d, hoy)));
  });

  app.post("/despachos/:propertyId/vencimientos/calcular", async (c) => {
    assertVerticalRole(c, GESTION_VENCIMIENTOS_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<CalcularBody>(c.req.raw, 1024);
    const zonaHoraria = await resolverZonaHorariaDespachosProperty(repo, propertyId);
    const hoy = todayIso(zonaHoraria);
    // Mismo bug/mismo fix que `todayIso()` de arriba: el default de year/month (cuando
    // el caller no los manda) se deriva del día de NEGOCIO (`hoy`), nunca de
    // `now.getUTCFullYear()/getUTCMonth()` -- si no, el último día del mes en CDMX
    // (o la zona real de esta property) entre las 18:00 y las 23:59 hora local
    // calcularía los vencimientos del mes SIGUIENTE por error.
    const hoyPartes = hoy.split("-");
    const hoyYear = Number(hoyPartes[0]);
    const hoyMonth = Number(hoyPartes[1]);
    const year = typeof raw.year === "number" ? raw.year : hoyYear;
    const month = typeof raw.month === "number" ? raw.month : hoyMonth;
    if (!Number.isInteger(month) || month < 1 || month > 12) throw Errors.validation("month: se esperaba un entero 1-12.");

    const nuevos = calcularVencimientosDelPeriodo(year, month, hoy);
    const creados: FiscalDeadlineRecord[] = [];
    for (const n of nuevos) {
      creados.push(await repo.createDeadline({ organizationId, propertyId, tipo: n.tipo, periodo: n.periodo, fechaLimite: n.fechaLimite, prioridad: n.prioridad }));
    }
    return c.json(creados.map((d) => serializeDeadline(d, hoy)), 201);
  });

  app.post("/despachos/:propertyId/vencimientos/:deadlineId/completar", async (c) => {
    assertVerticalRole(c, GESTION_VENCIMIENTOS_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const deadlineId = c.req.param("deadlineId");
    const raw = await readJsonCapped<CompletarBody>(c.req.raw, 1024);
    const comprobanteUrl = typeof raw.comprobanteUrl === "string" ? raw.comprobanteUrl : null;

    const existing = await repo.findDeadline(propertyId, deadlineId);
    if (!existing) throw Errors.notFound("Vencimiento no encontrado.");
    if (existing.estado === "completado") throw Errors.conflict("Este vencimiento ya está marcado como completado.");

    const hoy = todayIso(await resolverZonaHorariaDespachosProperty(repo, propertyId));
    const updated = await repo.markDeadlineCompleted(deadlineId, comprobanteUrl, hoy);
    return c.json(serializeDeadline(updated!, hoy));
  });

  app.post("/despachos/:propertyId/vencimientos/:deadlineId/escalar", async (c) => {
    assertVerticalRole(c, GESTION_VENCIMIENTOS_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const deadlineId = c.req.param("deadlineId");

    const deadline = await repo.findDeadline(propertyId, deadlineId);
    if (!deadline) throw Errors.notFound("Vencimiento no encontrado.");
    if (deadline.estado === "completado") throw Errors.conflict("No se puede escalar un vencimiento ya completado.");

    const hoy = todayIso(await resolverZonaHorariaDespachosProperty(repo, propertyId));
    const dias = diasHasta(deadline.fechaLimite, hoy);
    const decision = decidirEscalamiento(deadline.tipo, deadline.fechaLimite, dias);
    const escalation = await repo.insertEscalation(deadlineId, decision.level, new Date().toISOString(), decision.notes);
    await repo.updateDeadlineEstado(deadlineId, "escalado");

    // Hallazgo de auditoría (severidad ALTA): hasta esta fase, escalar un
    // vencimiento solo insertaba la fila en BD sin notificar a nadie. Aviso
    // real por correo (best-effort, ver email-notifications.ts) al staff
    // owner/admin de la organización -- el escalamiento en sí YA quedó
    // registrado con éxito arriba, así que un fallo al notificar nunca
    // convierte esta respuesta en un error.
    const organization = await repo.findOrganizationById(deadline.organizationId);
    const notificacion = await tryEnqueueEscalationEmail(repo, deadline, decision, organization?.name ?? "tu despacho", dias);
    // Cierre del hallazgo "despachos no tiene disparo inline de correo" (ver
    // ./notifications.ts::triggerDespachosEmailDispatchInline) — mismo `repo`/
    // transacción del request, best-effort real.
    await triggerDespachosEmailDispatchInline(deps, c.get("db"), repo);
    // Arreglo de fondo (auditoría a2, parte 3) — en sesión de staff el intento
    // inline de arriba SIEMPRE es un no-op seguro (42501); el envío real solo
    // puede pasar DESPUÉS de que esta transacción confirme, en sesión de
    // sistema (runDespachosEmailDispatch ya pasa el guard auth.uid() is null).
    c.get("postCommitTasks").push(() => runDespachosEmailDispatch(deps, INLINE_BATCH_SIZE).then(() => undefined));

    return c.json(
      {
        escalamiento: { id: escalation.id, nivel: escalation.level, enviadoEn: escalation.sentAt, notas: escalation.notes },
        requiereRevisionHumana: decision.requiresHumanReview,
        motivoRevisionHumana: decision.humanReviewReason,
        notificacion: { destinatarios: notificacion?.recipients ?? 0, correosEncolados: notificacion?.enqueued ?? 0 },
      },
      201,
    );
  });

  return app;
}
