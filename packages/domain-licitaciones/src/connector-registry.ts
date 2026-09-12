// Fase 5 pieza 1 — andamiaje de ingesta (REQ-004/REQ-005/REQ-146..150).
//
// Port ADAPTADO (no literal) de `licitaciones/packages/sources/src/connectors/
// registry.ts` + `connectors/types.ts` + `http/response-classifier.ts` +
// `pipeline/source-health.ts`. El origen construyó un `ConnectorRegistry`
// real contra 5 fuentes (ComprasMX/DOF/OCDS-SHCP/PDN-S6/portales estatales),
// todas bloqueadas por reCAPTCHA/bot-detection (B-02, ver docs/BLOQUEOS.md del
// repo origen) -- nunca resolvió el CAPTCHA, así que TODA su ingesta real
// terminó corriendo sobre fixtures/CSV histórico, nunca contra las fuentes en
// vivo.
//
// Fusion hoy solo tiene un camino de escritura para `licitaciones.tender`:
// alta MANUAL vía `tenders.ts` (`licitacionesTendersRoutes`). Este módulo NO
// reintroduce el intento de resolver B-02 (fuera de alcance, sigue bloqueado)
// -- construye el andamiaje INTERNO que el origen ya diseñó para que, el día
// que un conector real se autorice/verifique, sea "enchufarlo" al registro en
// vez de inventar un mecanismo nuevo desde cero:
//
//  - Registro ÚNICO de conectores (REQ-004): cualquier lugar del código que
//    necesite comportarse distinto por fuente debe consultar este registro,
//    nunca ramificar con `if (sourceId === "...")`. `no-provider-branching`
//    (ver tests/connector-registry.spec.ts) falla si aparece ese patrón fuera
//    de este archivo/`source-run.ts`.
//  - Estados explícitos de salud (REQ-148): nunca se interpreta el silencio
//    de una fuente caída/CAPTCHA/cambio-de-interfaz como "cero
//    oportunidades" -- ver `source-run.ts::classifySourceFailure`.
//  - Cadencia declarada y auditable por fuente (REQ-146): `SourceCadence`
//    documenta el intervalo real medido/recomendado contra cada portal (los
//    mismos valores que `apps/worker/src/scheduler/schedule-config.ts` del
//    origen documentaba, portados tal cual como referencia -- ver `note` de
//    cada descriptor) en vez de una cadencia fija universal.
//  - Verificación puntual documentada (REQ-150, tolerancia cero): ningún
//    conector automatizado se declara `verified: true` sin evidencia real.
//    Los 5 conectores automatizados de abajo son PLACEHOLDERS deliberados
//    (`SourceNotConfiguredError` si algo intentara invocarlos) -- reservan su
//    lugar en el registro único sin fingir una integración que no existe.

export const SOURCE_CONNECTOR_IDS = ["manual", "comprasmx", "dof", "ocds_shcp", "pdn_s6", "state_portal"] as const;
export type SourceConnectorId = (typeof SOURCE_CONNECTOR_IDS)[number];

export function isSourceConnectorId(value: string): value is SourceConnectorId {
  return (SOURCE_CONNECTOR_IDS as readonly string[]).includes(value);
}

/**
 * Estados explícitos de salud de una fuente (REQ-148, port de
 * `SourceHealthState` del origen). El pipeline/repositorio NUNCA debe
 * interpretar el silencio de una fuente caída como "cero oportunidades":
 * cuando `state !== "ok"`, los contadores de la corrida se leen como "no
 * evaluado", nunca como "no hay nada nuevo".
 */
export const SOURCE_HEALTH_STATES = ["ok", "down", "captcha_detected", "interface_changed", "permission_missing", "rate_limited", "not_configured"] as const;
export type SourceHealthState = (typeof SOURCE_HEALTH_STATES)[number];

/** Lanzado por un conector automatizado que aún no tiene configuración/acceso real (REQ-150) -- `classifySourceFailure` (`source-run.ts`) lo mapea a `"not_configured"`, nunca a `"ok"`. */
export class SourceNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceNotConfiguredError";
  }
}

/** Port de `CaptchaDetectedError` del origen -- disponible para que un futuro conector real lo lance sin reinventar la clase. */
export class CaptchaDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptchaDetectedError";
  }
}

/** Port de `InterfaceChangedError` del origen. */
export class InterfaceChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterfaceChangedError";
  }
}

/** Cadencia declarada de una fuente (REQ-146): nunca una cifra universal, siempre documentada contra el límite real observado/recomendado de ESA fuente. */
export interface SourceCadence {
  /** `0` = sin cadencia automática (a demanda, caso de "manual"). */
  readonly minIntervalMinutes: number;
  readonly note: string;
}

export interface SourceLiveVerification {
  /** `true` únicamente si esta fuente fue probada con una petición real de solo lectura contra el servicio en producción, con evidencia documentada (REQ-150). */
  readonly verified: boolean;
  readonly note: string;
}

export type SourceConnectorKind = "manual" | "automated";

/**
 * Descriptor de un conector registrado. Deliberadamente SIN `discover()`/
 * `fetchDetail()` en esta fase (a diferencia del origen): Fusion no tiene
 * todavía un worker de ingesta programada (ver `apps/worker`, hoy dedicado a
 * otros verticales) ni acceso autorizado a ningún portal real -- el registro
 * documenta la IDENTIDAD, cadencia y estado de verificación de cada fuente
 * (lo que REQ-004/146/150 exigen ya), y el día que exista una implementación
 * real, su función de ingesta se añade a este mismo descriptor sin tocar el
 * resto del registro ni ningún llamador (`kind` ya distingue "manual" de
 * "automated" para ese momento).
 */
export interface SourceConnectorDescriptor {
  readonly id: SourceConnectorId;
  readonly kind: SourceConnectorKind;
  readonly label: string;
  readonly termsNote: string;
  readonly cadence: SourceCadence;
  readonly liveVerification: SourceLiveVerification;
}

/**
 * Registro único de conectores (REQ-004). Única estructura autorizada a
 * asociar un `SourceConnectorId` con su descriptor -- ningún otro módulo debe
 * comparar `source === "manual"` (o similar) para decidir comportamiento;
 * debe pedirle el descriptor a este registro.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<SourceConnectorId, SourceConnectorDescriptor>();

  register(descriptor: SourceConnectorDescriptor): this {
    if (this.connectors.has(descriptor.id)) {
      throw new Error(`Ya existe un conector registrado con id "${descriptor.id}".`);
    }
    this.connectors.set(descriptor.id, descriptor);
    return this;
  }

  get(id: SourceConnectorId): SourceConnectorDescriptor | undefined {
    return this.connectors.get(id);
  }

  requireById(id: SourceConnectorId): SourceConnectorDescriptor {
    const descriptor = this.get(id);
    if (!descriptor) throw new Error(`No hay conector registrado para "${id}".`);
    return descriptor;
  }

  all(): SourceConnectorDescriptor[] {
    return [...this.connectors.values()];
  }
}

/**
 * Instancia única del registro de conectores de licitaciones. Cadencias
 * portadas tal cual de `apps/worker/src/scheduler/schedule-config.ts` del
 * repo origen (`DEFAULT_SCHEDULES`) -- mismos valores, misma justificación
 * documentada ahí (límites reales observados de cada portal), aunque aquí
 * ningún conector automatizado esté conectado todavía.
 */
export const LICITACIONES_CONNECTOR_REGISTRY = new ConnectorRegistry()
  .register({
    id: "manual",
    kind: "manual",
    label: "Alta manual",
    termsNote: "Captura directa por el staff de la organización (incluye transcripción manual de un CSV/PDF exportado del portal oficial) -- no automatiza ninguna petición contra un portal externo, así que no hay ToS/robots.txt que observar.",
    cadence: { minIntervalMinutes: 0, note: "A demanda: cada alta/actualización ocurre cuando un usuario la captura, sin cadencia programada." },
    liveVerification: { verified: true, note: "No depende de un portal externo -- verificado por los tests de integración HTTP de tenders.ts (POST real contra la ruta, no una simulación)." },
  })
  .register({
    id: "comprasmx",
    kind: "automated",
    label: "ComprasMX (sucesor de CompraNet)",
    termsNote: "Portal oficial de compras públicas federales; exige reCAPTCHA para consultas automatizadas (bloqueo documentado por el repo origen, nunca resuelto).",
    cadence: { minIntervalMinutes: 30, note: "30 min: no tiene sentido reintentar más seguido contra un endpoint que responde 401/reCAPTCHA de forma consistente." },
    liveVerification: { verified: false, note: "No verificado: sin acceso/permiso autorizado para superar el reCAPTCHA. Placeholder registrado (REQ-150) hasta que se autorice un acceso real -- NUNCA se declara verificado sin esa evidencia." },
  })
  .register({
    id: "dof",
    kind: "automated",
    label: "Diario Oficial de la Federación",
    termsNote: "Publicación oficial de convocatorias vía notas del DOF; formato HTML por nota, sin API estable documentada.",
    cadence: { minIntervalMinutes: 60, note: "60 min: el DOF publica cuando mucho dos ediciones al día (matutina/vespertina), no hay ganancia en consultar más seguido." },
    liveVerification: { verified: false, note: "No verificado en este monorepo: ningún parser real de notas del DOF está implementado todavía." },
  })
  .register({
    id: "ocds_shcp",
    kind: "automated",
    label: "OCDS-SHCP",
    termsNote: "API estándar Open Contracting Data Standard publicada por SHCP.",
    cadence: { minIntervalMinutes: 15, note: "15 min: API OCDS estándar, cadencia moderada apropiada para una API (no un portal con anti-bot)." },
    liveVerification: { verified: false, note: "No verificado: el repo origen documentó este endpoint como inalcanzable en sus intentos; sin verificación puntual propia todavía." },
  })
  .register({
    id: "pdn_s6",
    kind: "automated",
    label: "Plataforma Digital Nacional, sistema 6",
    termsNote: "API OCDS de la Plataforma Digital Nacional; con bot-detection documentado por el repo origen.",
    cadence: { minIntervalMinutes: 15, note: "15 min: misma cadencia que OCDS-SHCP por ser también una API OCDS estándar." },
    liveVerification: { verified: false, note: "No verificado: bot-detection bloqueó los intentos del repo origen; sin acceso autorizado propio todavía." },
  })
  .register({
    id: "state_portal",
    kind: "automated",
    label: "Portales estatales (genérico)",
    termsNote: "Cobertura de portales de compras estatales; sin URL/API única (cada estado publica distinto).",
    cadence: { minIntervalMinutes: 60, note: "60 min: se mantiene registrado con cadencia conservadora para que, en cuanto se identifique una URL real verificable, ya tenga cadencia declarada." },
    liveVerification: { verified: false, note: "No verificado: ningún portal estatal específico tiene todavía una URL/API localizada y confirmada." },
  });
