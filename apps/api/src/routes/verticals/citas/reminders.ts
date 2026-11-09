// Flujo 3 — POST/GET /internal/citas/confirmacion-cita (recordatorio 24h, == el
// agente agente-recordatorio-citas del origen). Ruta interna, gateada por secreto
// compartido (x-atiende-internal-secret, análogo a CRON_SECRET), pensada para ser
// invocada por un scheduler externo — no un job de apps/worker (ninguna fase
// anterior lo construyó, ver diseño Fase 1 citas §0.4).
//
// Wiring real del scheduler (cierra el hallazgo "nunca se disparan" del
// auditor): `vercel.json::crons` invoca este mismo path por GET cada 30 minutos
// (requiere plan Pro; la ventana de ±30 min de `runConfirmacionCitaCore` solo se cubre con esta cadencia) con `Authorization: Bearer
// <CRON_SECRET>`. `internalOrCronSecretMatches` acepta esa forma además del header
// manual `x-atiende-internal-secret` que ya usaban los tests/invocaciones
// manuales — mismo secreto (`INTERNAL_SECRET`), dos formas de mandarlo.
import { Hono } from "hono";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { runConfirmacionCitaCore, zonedDateStr } from "@atiende/domain-citas";
import type { CitasRepository, EventoRecordatorioFallido } from "@atiende/domain-citas";
import { emitirNotificacion } from "@atiende/db";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { emitirAvisosDeCitas } from "./avisos-ciclo.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export function citasRemindersRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/citas/confirmacion-cita", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // r4-fix-crons-transaccion-por-unidad: MISMO patrón exacto que hoteles/
    // night-audit -- YA NO se abre una única `withAppSession` para todo el
    // barrido. Un error SQL real en UNA organización dejaba esa transacción
    // compartida ABORTADA (25P02); las organizaciones siguientes fallaban en
    // cascada, y el COMMIT final -- sobre una transacción abortada -- devolvía
    // `ROLLBACK` sin lanzar, revirtiendo en silencio confirmaciones ya
    // encoladas de organizaciones anteriores. Ahora: una transacción para
    // listar, y UNA transacción POR organización.
    return withHeartbeat(deps, "/internal/citas/confirmacion-cita", async () => {
      const withRepo = <T>(fn: (repo: CitasRepository) => Promise<T>) => deps.engine.withAppSession({ userId: null }, (db) => fn(deps.citasRepo(db)));
      const organizations = await withRepo((repo) => repo.listActiveOrganizations());
      let processed = 0;
      let sent = 0;
      let sentEmail = 0;
      // PL-31 -- recordatorios cuyo WhatsApp no salio por falta de plantilla aprobada fuera de la ventana de 24 h, por organizacion.
      const sinPlantillaPorOrg = new Map<string, number>();
      // C-14 -- eventos de "recordatorio fallido" para notificaciones (sin PII; ver domain-citas/notification-events.ts).
      const notificationEvents: EventoRecordatorioFallido[] = [];
      const failures: { organization_id: string; appointment_id?: string; error: string }[] = [];

      // Un tenant con datos raros nunca tumba la corrida completa de los demás — se
      // captura y se sigue, se reporta en `failures[]` (ver diseño §5.3).
      for (const org of organizations) {
        try {
          const summary = await withRepo((repo) => runConfirmacionCitaCore(repo, org.id));
          processed += summary.processed;
          sent += summary.sent;
          sentEmail += summary.sentEmail;
          if (summary.skippedSinPlantilla > 0) sinPlantillaPorOrg.set(org.id, summary.skippedSinPlantilla);
          notificationEvents.push(...summary.failedReminderEvents);
          // Re-revisión a3 (bloqueante #1) — `runConfirmacionCitaCore` YA aísla cada
          // cita venenosa con SAVEPOINT y no lanza para la organización completa
          // (ver `failedAppointmentIds`/`failedAppointmentErrors`, domain-citas),
          // así que este `catch` de arriba NUNCA ve esos errores. Sin este volcado
          // explícito el cron respondía `ok:true, failures:[]` con el latido en
          // verde aunque una cita real se hubiera quedado sin recordatorio
          // (la siguiente corrida la reintenta mientras no empiece, pero nadie lo veía) — mismo
          // patrón que `google-calendar-sync.ts`/PR #163: cada fallo REAL por
          // cita se vuelca a `failures[]` para que dispare `CronPartialFailureError`.
          summary.failedAppointmentIds.forEach((appointmentId, i) => {
            failures.push({ organization_id: org.id, appointment_id: appointmentId, error: summary.failedAppointmentErrors[i] ?? "error desconocido" });
          });
        } catch (err) {
          failures.push({ organization_id: org.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Aviso in-app (campana): una por organizacion por dia con el CONTEO de recordatorios de 24 h que no salieron (error interno o sin
      // canal), a gerencia/duenos (sin rol de vertical extra). Una transaccion por organizacion; una emision fallida (o la base sin
      // 0039) nunca cambia el barrido, la respuesta ni el latido. El conteo no lleva datos del cliente ni de la cita.
      // "Por dia" = dia LOCAL de la organizacion (no el dia UTC: a las 18:00 de Merida cambia de dia UTC y el mismo aviso se repetiria).
      const ahora = new Date();
      const hoyDe = (organizationId: string): string => zonedDateStr(ahora, resolverZonaHorariaNegocio(organizations.find((o) => o.id === organizationId)?.timezone));
      const sinEnviarPorOrg = new Map<string, number>();
      for (const e of notificationEvents) sinEnviarPorOrg.set(e.organizationId, (sinEnviarPorOrg.get(e.organizationId) ?? 0) + 1);
      for (const [organizationId, cantidad] of sinEnviarPorOrg) {
        await deps.engine
          .withAppSession({ userId: null }, (db) => emitirNotificacion(db, { evento: "citas.recordatorio.fallido", organizationId, clave: `${organizationId}:${hoyDe(organizationId)}`, parametros: { cantidad } }))
          .catch(() => undefined);
      }

      // PL-31 -- aviso in-app (campana): una por organizacion, evento y dia con el CONTEO de avisos que no salieron por WhatsApp porque falta
      // la plantilla aprobada (el correo cubre cuando el cliente dejo uno). Mismo criterio best-effort que el aviso de arriba; sin datos del cliente.
      for (const [organizationId, cantidad] of sinPlantillaPorOrg) {
        await deps.engine
          .withAppSession({ userId: null }, (db) => emitirNotificacion(db, { evento: "citas.whatsapp.sin_plantilla", organizationId, clave: `${organizationId}:appointment.reminder_24h:${hoyDe(organizationId)}`, parametros: { cantidad } }))
          .catch(() => undefined);
      }

      // C-16 -- avisos in-app del ciclo (por confirmar, recordatorios agotados, escalaciones sin seguimiento): una transaccion por organizacion,
      // best-effort (ver avisos-ciclo.ts); no altera la respuesta ni el latido.
      await emitirAvisosDeCitas(deps, organizations, ahora);

      const response = c.json({ ok: failures.length === 0, tenants_checked: organizations.length, processed, sent, sent_email: sentEmail, sin_plantilla: [...sinPlantillaPorOrg.values()].reduce((a, b) => a + b, 0), notification_events: notificationEvents, failures });
      if (failures.length > 0) {
        // `failures.length` mezcla organizaciones que lanzaron completas (catch de
        // arriba) con citas individuales aisladas por SAVEPOINT dentro de una
        // organización que sí completó -- "de N organizaciones" describe el universo
        // recorrido, no que las N fallaran (mismo criterio que
        // `discover-tenders`/PR #163, ver `licitaciones/discover.ts`).
        throw new CronPartialFailureError(`confirmacion-cita: ${failures.length} fallo(s) real(es) de ${organizations.length} organizaciones`, response);
      }
      return response;
    })();
  });

  return app;
}
