// Fase 8 — errores de conector extraídos a un módulo SIN dependencias
// propias (a diferencia de dejarlos definidos dentro de
// `connector-registry.ts`, como estaban hasta Fase 7). Motivo real, no
// estético: Fase 8 agrega un conector automatizado REAL
// (`connectors/compras-mx-historico.ts`) cuyo `response-classifier.ts`
// necesita lanzar `CaptchaDetectedError`/`InterfaceChangedError`, y
// `connector-registry.ts` a su vez importa (en su nivel de módulo, dentro de
// la llamada `.register({ connector: createComprasMxHistoricoConnector() })`,
// EJECUTADA en tiempo de carga, no diferida) `createComprasMxHistoricoConnector`
// desde ese mismo conector. Si estos tres errores siguieran viviendo en
// `connector-registry.ts`, el grafo de imports sería:
//
//   connector-registry.ts -> compras-mx-historico.ts -> response-classifier.ts -> connector-registry.ts
//
// un ciclo REAL que, según qué archivo cargue primero (p. ej. un test que
// importa `compras-mx-historico.ts` directamente), produce
// `ReferenceError: Cannot access 'DEFAULT_CSV_URL' before initialization`
// (verificado en esta fase: `npx vitest run tests/connectors/compras-mx-historico.spec.ts`
// lo reproducía de forma consistente antes de esta extracción). Moviendo los
// errores a este módulo sin imports propios, el ciclo desaparece por completo.
//
// `connector-registry.ts` sigue re-exportando estas tres clases (mismo
// import path que usaban `source-run.ts`/los tests/`index.ts` antes de esta
// fase) para no romper ningún consumidor existente.

/** Lanzado por un conector automatizado que aún no tiene configuración/acceso real (REQ-150) -- `classifySourceFailure` (`source-run.ts`) lo mapea a `"not_configured"`, nunca a `"ok"`. */
export class SourceNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceNotConfiguredError";
  }
}

/** Lanzado cuando un conector detecta un bloqueo anti-bot (captcha, "Access Denied", etc.) en vez del contenido real esperado. */
export class CaptchaDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptchaDetectedError";
  }
}

/** Lanzado cuando la fuente responde con una forma inesperada que no es un bloqueo reconocido (posible cambio de formato del portal). */
export class InterfaceChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterfaceChangedError";
  }
}

/**
 * Fase 9 — lanzado cuando la fuente responde `429 Too Many Requests`. El
 * "backoff" que pide el brief de esta fase (respeto a la fuente, "backoff
 * ante 429") se implementa DETENIENDO la corrida por completo en cuanto
 * aparece un 429 (nunca reintenta en el mismo proceso, nunca sigue pidiendo
 * páginas siguientes) -- el worker no tiene temporizadores propios
 * (`apps/worker/src/jobs/licitaciones/README.md`: "no corre como proceso
 * propio"), así que el backoff real ocurre entre corridas programadas
 * (`SourceCadence.minIntervalMinutes` de cada conector, ver
 * `connector-registry.ts`), no con un `sleep` dentro de esta llamada.
 */
export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitedError";
  }
}
