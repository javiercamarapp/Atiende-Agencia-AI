// RESOLUCIÓN DE LA ORGANIZACIÓN EFECTIVA PARA UN SUPERADMIN — el módulo que
// existe para cerrar el incidente real: "un superadmin sin tenant
// seleccionado caía a modo demo en silencio". Puerto generalizado de
// `requireSessionTenant`/`resolverTenantEfectivo` en
// ~/likida.ai/src/lib/auth/{guard.ts,tenant-efectivo.ts}.
//
// El superadmin de este monorepo (a diferencia de `Membership` en
// core-tenancy) no pertenece a NINGUNA organización por diseño — es un actor
// de PLATAFORMA. Este módulo nunca decide QUIÉN es superadmin (eso es un
// hecho de sesión que `apps/api` ya resolvió antes de llamar aquí, igual que
// `s.rol === 'superadmin'` en guard.ts es un hecho de `getSessionTenant()`);
// solo decide A QUÉ ORGANIZACIÓN apunta esta petición, con una única regla:
// NUNCA UN DEFAULT IMPLÍCITO.
import { NoOrganizationSelectedError } from "./errors.ts";
import { verifyImpersonationSelection } from "./cookie.ts";

/** El actor de plataforma que impersona. Solo lo mínimo que la resolución y
 *  la bitácora necesitan — nunca un `Membership` (el superadmin no tiene
 *  una fila de membership; forzarlo a tener una fue el error original). */
export interface SuperadminActor {
  readonly userId: string;
  readonly email?: string | null;
}

export interface ResolveImpersonatedOrganizationInput {
  readonly actor: SuperadminActor;
  /**
   * Selección explícita de ESTA petición puntual — el equivalente de
   * `?tenant=<id>` en el flujo de "ver como" auditado de Likida
   * (tenant-efectivo.ts). Tiene PRIORIDAD sobre la cookie: es una intención
   * todavía más explícita que una selección persistente de hace rato.
   * `apps/api` es quien decide si expone este parámetro y desde qué ruta
   * auditada (p. ej. el botón "Ver como" de un panel de organizaciones).
   */
  readonly explicitOrganizationId?: string | null;
  /** Valor CRUDO (aún sin verificar) de la cookie `IMPERSONATION_COOKIE_NAME`
   *  — típicamente `req.cookies[IMPERSONATION_COOKIE_NAME]` en la ruta. */
  readonly cookieValue?: string | null;
  /** La llave de firma — ver `IMPERSONATION_COOKIE_SECRET_ENV_HINT` en
   *  cookie.ts para cuál variable de entorno debe traerla el llamador. */
  readonly secret: string | null | undefined;
  readonly nowMs?: number;
}

export interface ResolvedImpersonation {
  readonly organizationId: string;
  /** `"explicit"` cuando vino de `explicitOrganizationId` (el "ver como"
   *  puntual de esta petición); `"cookie"` cuando vino de la selección
   *  persistente. El llamador lo usa para decidir si además debe correr el
   *  flujo de "ver como" (firmar impersonación siempre) o si ya está
   *  cubierto por la cookie ya firmada al elegir. */
  readonly source: "explicit" | "cookie";
}

/**
 * Resuelve la organización efectiva de un superadmin para esta petición.
 *
 * CONTRATO: o devuelve una organización EXPLÍCITAMENTE elegida (por esta
 * petición o por una selección de cookie previa y vigente), o LANZA
 * `NoOrganizationSelectedError`. Nunca hay una tercera salida silenciosa
 * ("me quedo con la demo", "me quedo con la primera organización",
 * "undefined que alguna query de abajo interpreta como todas"). El llamador
 * HTTP atrapa `NoOrganizationSelectedError` y responde con un rebote a
 * "elegir organización" (302) o un 409 explícito — nunca sirve un panel.
 *
 * Esta es la función que el test de "no debe existir un tenant implícito"
 * (ver tests/impersonation/resolve.spec.ts) ejercita directamente.
 */
export function resolveImpersonatedOrganization(
  input: ResolveImpersonatedOrganizationInput,
): ResolvedImpersonation {
  if (input.explicitOrganizationId) {
    return { organizationId: input.explicitOrganizationId, source: "explicit" };
  }

  const nowMs = input.nowMs ?? Date.now();
  const selection = verifyImpersonationSelection(input.cookieValue, input.secret, nowMs);
  if (selection) {
    return { organizationId: selection.organizationId, source: "cookie" };
  }

  // EL CASO DEL INCIDENTE: sin `?org=` de esta petición, sin cookie válida
  // (ausente, expirada, corrupta, o firmada con una llave que ya no es la
  // vigente). Fallar CERRADO — nunca un default.
  throw new NoOrganizationSelectedError(input.actor.userId);
}
