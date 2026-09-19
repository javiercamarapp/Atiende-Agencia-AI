// Errores tipados de la impersonación de superadmin — mismo estilo que
// `TenancyError`/`NotAMemberError` en packages/core-tenancy/src/session.ts:
// una clase base con `code`, y una subclase por causa para que el llamador
// (apps/api) distinga sin volver a parsear el mensaje.

export class ImpersonationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * EL FALLO QUE ESTE PAQUETE EXISTE PARA CERRAR.
 *
 * Nace de un incidente real: un superadmin sin tenant/organización
 * seleccionada caía a "modo demo" EN SILENCIO — mismo hallazgo que el #1 de
 * la auditoría externa del proyecto origen (ver `admin-context.ts`/`guard.ts` en
 * ~/proyecto-origen/src/lib/auth). La corrección allá fue "nunca debería existir un
 * tenant implícito": sin selección explícita (cookie firmada) NI un
 * parámetro explícito de la petición, la resolución de organización efectiva
 * (`resolveImpersonatedOrganization`) LANZA esto en vez de devolver
 * cualquier organización por default.
 *
 * El llamador (una ruta de apps/api) atrapa este error y responde con un
 * rebote a "elegir organización" o un 409/403 explícito — nunca sirve un
 * panel con una organización que el superadmin no pidió.
 */
export class NoOrganizationSelectedError extends ImpersonationError {
  readonly actorId: string;

  constructor(actorId: string) {
    super(
      `El superadmin "${actorId}" no tiene una organización seleccionada de forma explícita ` +
        `(ni cookie de impersonación válida, ni selección explícita de esta petición). ` +
        `No se otorga acceso a ninguna organización por default — falla cerrado.`,
      "no_organization_selected",
    );
    this.actorId = actorId;
  }
}

/**
 * La llave de firma HMAC vino vacía/ausente. Fail-closed: sin llave no se
 * firma NI se valida nada — nunca se cae a otro secreto ya usado para otra
 * cosa (ver comentario de `IMPERSONATION_COOKIE_SECRET_ENV_HINT` en cookie.ts
 * y AUDITORÍA 18-B13 del proyecto origen: la llave de firma cayendo a la service-role
 * key fue exactamente el error que este paquete evita desde el diseño).
 */
export class ImpersonationSigningKeyMissingError extends ImpersonationError {
  constructor() {
    super(
      "Falta la llave de firma de impersonación (secret vacío/ausente). " +
        "Sin ella no se firma ni se valida ninguna selección — fail-closed.",
      "signing_key_missing",
    );
  }
}

/** `organizationId` vacío pasado a `signImpersonationSelection` — no tiene
 *  sentido firmar una selección sin organización, y hacerlo en silencio
 *  produciría una cookie "válida" que apunta a nada. */
export class InvalidOrganizationIdError extends ImpersonationError {
  constructor() {
    super("organizationId vacío: no se firma una selección de impersonación sin organización.", "invalid_organization_id");
  }
}

/**
 * Se lanza cuando un request MUTANTE (POST/PUT/PATCH/DELETE) llega con una
 * sesión de impersonación de superadmin activa — ver `write-guard.ts` para el
 * middleware que la produce. Por diseño (requisito no negociable de "Bloque
 * C"), toda impersonación es SOLO LECTURA por default: ningún endpoint
 * conectado a `blockWritesWhileImpersonating` acepta una escritura mientras
 * dure la sesión, salvo que el propio caller la excluya explícitamente
 * (`exemptPaths`) porque SÍ define con claridad que esa ruta es parte del
 * conjunto permitido (ej. terminar la propia sesión de impersonación).
 */
export class ImpersonationWriteBlockedError extends ImpersonationError {
  constructor(method: string, path: string) {
    super(
      `Escritura bloqueada (${method} ${path}): hay una sesión de impersonación de superadmin activa. ` +
        `La impersonación es de solo lectura por default — termina la sesión antes de escribir.`,
      "impersonation_write_blocked",
    );
  }
}
