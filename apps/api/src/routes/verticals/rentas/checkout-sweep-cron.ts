// GET/POST /internal/rentas/checkout-sweep -- corrida periódica real de
// `procesarCheckoutsPendientes` (packages/domain-rentas/src/limpieza/aplicacion/
// tareas.ts, Fase 8). Cierra el hallazgo de auditoría "en rentas no existe ninguna
// forma de que nazca una tarea de limpieza en producción": el motor transaccional
// completo (crearTareaLimpiezaPorCheckout/procesarCheckoutsPendientes) llevaba desde
// la Fase 8 sin ningún HTTP/cron que lo disparara -- apps/api/.../rentas/limpieza.ts
// (Fase 17) documentaba esto explícitamente como fuera de su propio alcance, y
// "Mis tareas" (MisTareas.tsx) siempre estaría vacío en producción por más pantalla
// que se le hubiera dado.
//
// Mismo patrón/guard EXACTO que apps/api/.../rentas/email-dispatch.ts/
// ical-sync-cron.ts (leídos primero como plantilla): acepta GET (Vercel Cron, que
// solo dispara GET con `Authorization: Bearer <CRON_SECRET>`) y POST (header manual
// `x-atiende-internal-secret`/tests), gateada por `internalOrCronSecretMatches` (ver
// comentario de cabecera de `http-security.ts::internalOrCronSecretMatches`). Ruta
// de scheduler, sin authMiddleware/dbSession -- recorre TODA la plataforma
// (`rentas.ocupacion` no está particionado por organización en este poll, mismo
// criterio que ical-sync-cron.ts sobre `rentas.canal_feed_externo`), y es idempotente
// por diseño: `procesarCheckoutsPendientes` nunca crea una segunda tarea de limpieza
// para la misma reserva (ver su propio test "es idempotente" en
// packages/domain-rentas/tests/limpieza/tareas.spec.ts).
//
// Wiring real del scheduler: `vercel.json::crons` invoca este mismo path por GET.
//
// BLOQUEADOR CONOCIDO contra Postgres real (documentado honestamente, NO resuelto
// aquí -- es una decisión de plataforma cross-cutting, no algo que este hallazgo
// pueda arreglar por su cuenta): `deps.engine.withAppSession({ userId: null }, ...)`
// abre la sesión de "sistema" con `set local role authenticated` +
// `request.jwt.claim.sub = ''` (ver packages/db/src/managed-postgres-engine.ts),
// NUNCA `service_role`. Las políticas RLS reales de `rentas.ocupacion`/
// `rentas.tarea_operativa`/`rentas.checklist_item_tarea`/`rentas.property_config`
// (migrations/001_rentas_schema.sql, migrations/010_rentas_limpieza_schema.sql)
// exigen `core.has_property_access(auth.uid(), property_id)`, y con `auth.uid()`
// NULL esa función siempre es `false` (ningún `core.membership.user_id` es NULL) --
// así que, contra Postgres real, hoy este sweep recorrería la plataforma completa y
// encontraría SIEMPRE 0 checkouts pendientes (RLS filtra la fila antes de que la
// query la vea), nunca un error explícito. El MISMO gap ya existe en
// `ical-sync-cron.ts` (`rentas.canal_feed_externo`, política idéntica) y, de forma
// más severa, en `email-dispatch.ts` (`rentas.messaging_outbox` está
// `revoke all ... from authenticated`, ahí SÍ lanzaría "permission denied" en vez de
// devolver 0 filas en silencio). Arreglarlo de raíz requiere una decisión de
// plataforma que ningún vertical individual puede tomar por su cuenta (p. ej. un
// verdadero rol `service_role` para `withAppSession({ userId: null })`, o funciones
// `SECURITY DEFINER` tipo `core.accept_staff_invite` para estas lecturas/escrituras
// de sistema) -- fuera del alcance de este hallazgo, que se limita a exponer el
// disparador HTTP/cron que faltaba con el MISMO patrón ya usado (y con el MISMO
// bloqueador ya heredado) por los 2 crons hermanos de rentas.
import { Hono } from "hono";
import { procesarCheckoutsPendientes } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

/** Mismo tamaño de lote que el default de `procesarCheckoutsPendientes` -- explícito
 *  aquí para que quede documentado en el único lugar donde el scheduler real lo
 *  dispara (a diferencia de los tests de dominio, que sí ejercitan otros límites). */
const LIMITE_POR_CORRIDA = 50;

export function rentasCheckoutSweepCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/rentas/checkout-sweep", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const resultado = await procesarCheckoutsPendientes(db, LIMITE_POR_CORRIDA);
      return c.json({ ok: true, procesados: resultado.procesados, tareasCreadas: resultado.tareasCreadas });
    });
  });

  return app;
}
