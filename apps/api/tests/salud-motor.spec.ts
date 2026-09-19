// Motor puro de "Salud operativa" -- ver `../src/salud/motor.ts`. Sin I/O:
// cada caso construye su propio input y una fecha fija (`ahora`), nunca
// depende del reloj real.
import { describe, expect, it } from "vitest";
import {
  calcularAlertas,
  juzgarLatido,
  OLDEST_PENDING_ALERT_HOURS,
  TOLERANCIA_VENCIDO_MIN,
  UMBRAL_FALLOS_CONSECUTIVOS,
  type CronConEstado,
  type CronHeartbeatRow,
  type LicitacionesFuenteRunRow,
  type OutboxQueueHealthRow,
} from "../src/salud/motor.ts";

const AHORA = new Date("2026-09-19T12:00:00.000Z");

/** Tope de plataforma "sin tope configurado" -- usado en los casos que no
 *  están probando específicamente el gasto de LLM, para no confundir el
 *  motor con `null` (que SIEMPRE genera su propia alerta de "no se pudo
 *  leer", ver el caso de arriba). */
const SIN_TOPE = { monthlyCapMicroUsd: 0, alertThresholdPct: 80, spendThisMonthMicroUsd: 0 };

function latido(overrides: Partial<CronHeartbeatRow> = {}): CronHeartbeatRow {
  return {
    cronName: "/internal/licitaciones/discover-tenders",
    lastStartedAt: "2026-09-19T05:00:00.000Z",
    lastFinishedAt: "2026-09-19T05:00:05.000Z",
    lastStatus: "ok",
    lastError: null,
    lastDurationMs: 5000,
    consecutiveFailures: 0,
    ...overrides,
  };
}

describe("juzgarLatido", () => {
  it("sin ningún latido registrado -> sin_latido", () => {
    expect(juzgarLatido(null, 24 * 60, AHORA)).toBe("sin_latido");
  });

  it("latido sin lastFinishedAt (nunca debería pasar, pero es defensivo) -> sin_latido", () => {
    expect(juzgarLatido(latido({ lastFinishedAt: null, lastStatus: null }), 24 * 60, AHORA)).toBe("sin_latido");
  });

  it("último estado 'error' -> error, sin importar qué tan reciente sea", () => {
    const reciente = new Date(AHORA.getTime() - 60_000).toISOString(); // hace 1 minuto
    expect(juzgarLatido(latido({ lastStatus: "error", lastFinishedAt: reciente }), 24 * 60, AHORA)).toBe("error");
  });

  it("dentro de la cadencia esperada -> ok", () => {
    const finishedAt = new Date(AHORA.getTime() - 60 * 60_000).toISOString(); // hace 1 h
    expect(juzgarLatido(latido({ lastFinishedAt: finishedAt }), 24 * 60, AHORA)).toBe("ok");
  });

  it(`justo en el límite (cadencia + ${TOLERANCIA_VENCIDO_MIN} min exactos) -> todavía ok`, () => {
    const finishedAt = new Date(AHORA.getTime() - (24 * 60 + TOLERANCIA_VENCIDO_MIN) * 60_000).toISOString();
    expect(juzgarLatido(latido({ lastFinishedAt: finishedAt }), 24 * 60, AHORA)).toBe("ok");
  });

  it(`un minuto más allá del límite (cadencia + tolerancia) -> vencido`, () => {
    const finishedAt = new Date(AHORA.getTime() - (24 * 60 + TOLERANCIA_VENCIDO_MIN + 1) * 60_000).toISOString();
    expect(juzgarLatido(latido({ lastFinishedAt: finishedAt }), 24 * 60, AHORA)).toBe("vencido");
  });

  it("cadencia 0 (indeterminada / apagado a propósito) -> nunca vencido, aunque el latido sea viejísimo", () => {
    const finishedAt = new Date(AHORA.getTime() - 365 * 24 * 60 * 60_000).toISOString(); // hace 1 año
    expect(juzgarLatido(latido({ lastFinishedAt: finishedAt }), 0, AHORA)).toBe("ok");
  });

  it("cadencia negativa se trata igual que 0 -- nunca vencido", () => {
    const finishedAt = new Date(AHORA.getTime() - 365 * 24 * 60 * 60_000).toISOString();
    expect(juzgarLatido(latido({ lastFinishedAt: finishedAt }), -5, AHORA)).toBe("ok");
  });
});

describe("calcularAlertas", () => {
  it("todo sano (arrays vacíos, sin tope de plataforma excedido) -> sin alertas", () => {
    const alertas = calcularAlertas({
      crons: [],
      colas: [],
      licitacionesFuentes: [],
      llmPlatformBudget: { monthlyCapMicroUsd: 1_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 0 },
    });
    expect(alertas).toEqual([]);
  });

  it("null en cualquier sección -> alerta propia de 'no se pudo leer', NUNCA se interpreta como 'todo bien'", () => {
    const alertas = calcularAlertas({ crons: null, colas: null, licitacionesFuentes: null, llmPlatformBudget: null });
    expect(alertas).toHaveLength(4);
    for (const a of alertas) {
      expect(a.titulo.toLowerCase()).toContain("no se pudo leer");
      expect(a.severidad).toBe("alta");
    }
  });

  it("cron vencido genera alerta 'alta' con href a la tabla de crons", () => {
    const crons: CronConEstado[] = [{ cronName: "/internal/hoteles/night-audit", estado: "vencido", heartbeat: latido({ cronName: "/internal/hoteles/night-audit" }) }];
    const alertas = calcularAlertas({ crons, colas: [], licitacionesFuentes: [], llmPlatformBudget: SIN_TOPE });
    const alertaCron = alertas.find((a) => a.titulo.includes("night-audit"));
    expect(alertaCron).toMatchObject({ severidad: "alta", href: "/superadmin/salud/crons" });
  });

  it("cron en estado 'error' genera alerta 'critica' con el mensaje real del último error", () => {
    const crons: CronConEstado[] = [{ cronName: "/internal/whatsapp/dispatch", estado: "error", heartbeat: latido({ cronName: "/internal/whatsapp/dispatch", lastStatus: "error", lastError: "WHATSAPP_ACCESS_TOKEN inválido" }) }];
    const alertas = calcularAlertas({ crons, colas: [], licitacionesFuentes: [], llmPlatformBudget: SIN_TOPE });
    const alertaError = alertas.find((a) => a.titulo.includes("con error"));
    expect(alertaError).toMatchObject({ severidad: "critica", detalle: "WHATSAPP_ACCESS_TOKEN inválido" });
  });

  it(`${UMBRAL_FALLOS_CONSECUTIVOS} o más fallos consecutivos genera una alerta ADICIONAL a la de estado 'error'`, () => {
    const crons: CronConEstado[] = [
      { cronName: "/internal/rentas/ical-sync", estado: "error", heartbeat: latido({ cronName: "/internal/rentas/ical-sync", lastStatus: "error", consecutiveFailures: UMBRAL_FALLOS_CONSECUTIVOS }) },
    ];
    const alertas = calcularAlertas({ crons, colas: [], licitacionesFuentes: [], llmPlatformBudget: SIN_TOPE });
    expect(alertas.filter((a) => a.titulo.includes("ical-sync"))).toHaveLength(2);
    expect(alertas.some((a) => a.titulo.includes("fallos consecutivos"))).toBe(true);
  });

  it("menos fallos consecutivos que el umbral -> sin la alerta adicional", () => {
    const crons: CronConEstado[] = [{ cronName: "/internal/despachos/email-dispatch", estado: "ok", heartbeat: latido({ cronName: "/internal/despachos/email-dispatch", consecutiveFailures: UMBRAL_FALLOS_CONSECUTIVOS - 1 }) }];
    const alertas = calcularAlertas({ crons, colas: [], licitacionesFuentes: [], llmPlatformBudget: SIN_TOPE });
    expect(alertas).toEqual([]);
  });

  it("cola con mensajes muertos -> alerta 'critica'", () => {
    const colas: OutboxQueueHealthRow[] = [{ queueName: "hoteles", pendingCount: 0, processingCount: 0, sentCount: 10, failedCount: 0, deadCount: 3, oldestPendingSeconds: null, lastSentAt: null }];
    const alertas = calcularAlertas({ crons: [], colas, licitacionesFuentes: [], llmPlatformBudget: SIN_TOPE });
    expect(alertas).toEqual([expect.objectContaining({ severidad: "critica", titulo: expect.stringContaining("3 mensaje(s) muerto(s)") })]);
  });

  it(`cola con pendiente más viejo por debajo de ${OLDEST_PENDING_ALERT_HOURS} h -> sin alerta`, () => {
    const colas: OutboxQueueHealthRow[] = [{ queueName: "citas", pendingCount: 1, processingCount: 0, sentCount: 0, failedCount: 0, deadCount: 0, oldestPendingSeconds: OLDEST_PENDING_ALERT_HOURS * 3600 - 1, lastSentAt: null }];
    expect(calcularAlertas({ crons: [], colas, licitacionesFuentes: [], llmPlatformBudget: SIN_TOPE })).toEqual([]);
  });

  it(`cola con pendiente más viejo por encima de ${OLDEST_PENDING_ALERT_HOURS} h -> alerta 'alta'`, () => {
    const colas: OutboxQueueHealthRow[] = [{ queueName: "citas", pendingCount: 1, processingCount: 0, sentCount: 0, failedCount: 0, deadCount: 0, oldestPendingSeconds: OLDEST_PENDING_ALERT_HOURS * 3600 + 1, lastSentAt: null }];
    const alertas = calcularAlertas({ crons: [], colas, licitacionesFuentes: [], llmPlatformBudget: SIN_TOPE });
    expect(alertas).toEqual([expect.objectContaining({ severidad: "alta" })]);
  });

  it("cola sin ningún pendiente (oldestPendingSeconds null) -> nunca se interpreta como '0 segundos' ni genera alerta", () => {
    const colas: OutboxQueueHealthRow[] = [{ queueName: "restaurantes", pendingCount: 0, processingCount: 0, sentCount: 5, failedCount: 0, deadCount: 0, oldestPendingSeconds: null, lastSentAt: "2026-09-19T00:00:00.000Z" }];
    expect(calcularAlertas({ crons: [], colas, licitacionesFuentes: [], llmPlatformBudget: SIN_TOPE })).toEqual([]);
  });

  it("fuente de licitaciones 'not_configured' -> NUNCA es una alerta (decisión de producto conocida)", () => {
    const fuentes: LicitacionesFuenteRunRow[] = [{ organizationId: "org-1", organizationName: "Org 1", source: "comprasmx", state: "not_configured", finishedAt: "2026-09-19T05:00:00.000Z", message: "sin credenciales" }];
    expect(calcularAlertas({ crons: [], colas: [], licitacionesFuentes: fuentes, llmPlatformBudget: SIN_TOPE })).toEqual([]);
  });

  it("fuente de licitaciones CONFIGURADA con estado distinto de 'ok' -> alerta 'media'", () => {
    const fuentes: LicitacionesFuenteRunRow[] = [{ organizationId: "org-1", organizationName: "Org 1", source: "compras_mx_historico", state: "captcha_detected", finishedAt: "2026-09-19T05:00:00.000Z", message: "403 Access Denied" }];
    const alertas = calcularAlertas({ crons: [], colas: [], licitacionesFuentes: fuentes, llmPlatformBudget: SIN_TOPE });
    expect(alertas).toEqual([expect.objectContaining({ severidad: "media", detalle: "403 Access Denied" })]);
  });

  it("fuente de licitaciones 'ok' -> sin alerta", () => {
    const fuentes: LicitacionesFuenteRunRow[] = [{ organizationId: "org-1", organizationName: "Org 1", source: "nl_ocds", state: "ok", finishedAt: "2026-09-19T05:00:00.000Z", message: "333 vigentes" }];
    expect(calcularAlertas({ crons: [], colas: [], licitacionesFuentes: fuentes, llmPlatformBudget: SIN_TOPE })).toEqual([]);
  });

  it("gasto de LLM por debajo del umbral de alerta -> sin alerta", () => {
    const alertas = calcularAlertas({ crons: [], colas: [], licitacionesFuentes: [], llmPlatformBudget: { monthlyCapMicroUsd: 100_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 79_000_000 } });
    expect(alertas).toEqual([]);
  });

  it("gasto de LLM en o por encima del umbral (>= 80%) -> alerta 'alta'", () => {
    const alertas = calcularAlertas({ crons: [], colas: [], licitacionesFuentes: [], llmPlatformBudget: { monthlyCapMicroUsd: 100_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 80_000_000 } });
    expect(alertas).toEqual([expect.objectContaining({ severidad: "alta" })]);
  });

  it("gasto de LLM en o por encima del 100% del tope -> alerta 'critica' (más grave que solo pasar el umbral)", () => {
    const alertas = calcularAlertas({ crons: [], colas: [], licitacionesFuentes: [], llmPlatformBudget: { monthlyCapMicroUsd: 100_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 100_000_000 } });
    expect(alertas).toEqual([expect.objectContaining({ severidad: "critica" })]);
  });

  it("tope de plataforma en 0 (sin configurar) -> nunca divide por cero ni genera una alerta falsa", () => {
    const alertas = calcularAlertas({ crons: [], colas: [], licitacionesFuentes: [], llmPlatformBudget: { monthlyCapMicroUsd: 0, alertThresholdPct: 80, spendThisMonthMicroUsd: 0 } });
    expect(alertas).toEqual([]);
  });
});
