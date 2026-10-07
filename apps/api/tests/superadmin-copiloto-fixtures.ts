// Datos y dobles compartidos por las pruebas del Copiloto de superadmin (CHAT-16): fuentes de datos EN MEMORIA con filas realistas y utilidades para
// llamar al catalogo directo. Ninguna toca la red ni Postgres; el SQL real (RLS, caller-binding, CHECK) lo prueba scripts/verify-superadmin-copiloto/.
import type { DataChatToolContext, DataChatToolResult } from "@atiende/agent-core/data-chat";
import type { CfoOrgRow } from "@atiende/db";
import { alcanceDelMotor, type PlatformScope } from "../src/superadmin-copiloto/alcance.ts";
import type { Fuente, FuentesPlataforma, OperacionOrganizacionRow } from "../src/superadmin-copiloto/fuentes.ts";

export const AHORA = new Date("2026-10-02T15:00:00.000Z");

export const ok = <T>(data: T): Fuente<T> => ({ ok: true, data });

export const FILA_CFO: CfoOrgRow = {
  organizationId: "org-a",
  organizationName: "Taquería Don Beto",
  organizationSlug: "taqueria-don-beto",
  vertical: "restaurantes",
  orgStatus: "active",
  planId: "restaurantes-estandar",
  planNombre: "Restaurantes",
  precioBaseCentavos: 0,
  precioAsientoCentavos: 79900,
  asientosIncluidos: 1,
  billingStatus: null,
  billingSeats: null,
  sucursalesActivas: 3,
  llmMicroUsd: 4_000_000,
  vozMicroUsd: 0,
  whatsappMicroUsd: 0,
  telefoniaMicroUsd: 0,
  otrosMicroUsd: 0,
  eventosTotal: 0,
  eventosEstimados: 0,
  minutosVoz: 0,
  mensajes: 400,
  llmCapMicroUsd: 900_000_000,
  llmAlertPct: 80,
  billingPeriodEndMs: null,
  limites: [],
  mxnPorUsd: 20,
  fxFecha: "2026-10-01",
  fxFuente: "Banxico FIX",
};

export const FILA_CFO_HOTEL: CfoOrgRow = { ...FILA_CFO, organizationId: "org-b", organizationName: "Hotel Bahía", organizationSlug: "hotel-bahia", vertical: "hoteles", sucursalesActivas: 1, llmMicroUsd: 90_000_000, mensajes: 50 };

/** Filas agregadas por organizacion del doble: org-a (restaurantes, con actividad), org-b (hoteles, con actividad), org-c (hoteles, SIN actividad), org-d (despachos, sin migrar). */
export const OPERACIONES_POR_ORG: readonly OperacionOrganizacionRow[] = [
  { organizationId: "org-a", vertical: "restaurantes", operaciones: 40, ingresos: 12_500.5, escalaciones: 3, abiertos: 2, vencidos: null, razon: null },
  { organizationId: "org-b", vertical: "hoteles", operaciones: 12, ingresos: 30_000, escalaciones: null, abiertos: 5, vencidos: null, razon: null },
  { organizationId: "org-c", vertical: "hoteles", operaciones: 0, ingresos: 0, escalaciones: null, abiertos: 0, vencidos: null, razon: null },
  { organizationId: "org-d", vertical: "despachos", operaciones: null, ingresos: null, escalaciones: null, abiertos: null, vencidos: null, razon: "fuente_no_migrada" },
];

/** Fuentes en memoria: cada metodo devuelve datos de ejemplo; `sobre` reemplaza los que cada prueba necesite. Registra las llamadas a `registrarAccesoCfo`. */
export function fuentesFalsas(sobre: Partial<FuentesPlataforma> = {}): FuentesPlataforma & { readonly accesosCfo: { accion: string; recurso: string; filtros: Readonly<Record<string, unknown>> }[]; readonly accesosOrg: { ids: string[]; herramienta: string; filtros: Readonly<Record<string, unknown>> }[]; readonly llamadasOperaciones: { desde: string; hasta: string; hoy: string; organizationId: string | null }[] } {
  const accesosOrg: { ids: string[]; herramienta: string; filtros: Readonly<Record<string, unknown>> }[] = [];
  const llamadasOperaciones: { desde: string; hasta: string; hoy: string; organizationId: string | null }[] = [];
  const accesosCfo: { accion: string; recurso: string; filtros: Readonly<Record<string, unknown>> }[] = [];
  const base: FuentesPlataforma = {
    organizaciones: async () =>
      ok([
        { id: "org-a", vertical: "restaurantes", name: "Taquería Don Beto", slug: "taqueria-don-beto", status: "active" as const, createdAt: "2026-03-01T10:00:00.000Z", staffCount: 4 },
        { id: "org-b", vertical: "hoteles", name: "Hotel Bahía", slug: "hotel-bahia", status: "trial" as const, createdAt: "2026-09-10T10:00:00.000Z", staffCount: 2 },
        { id: "org-c", vertical: "hoteles", name: "Posada Sol", slug: "posada-sol", status: "suspended" as const, createdAt: "2026-01-05T10:00:00.000Z", staffCount: 1 },
      ]),
    llmResumen: async () => ok({ tokensIn: 100, tokensOut: 50, costMicroUsd: 5_000_000, callCount: 12, fallbackCallCount: 1 }),
    llmPorOrganizacion: async () =>
      ok([
        { organizationId: "org-a", organizationName: "Taquería Don Beto", organizationSlug: "taqueria-don-beto", vertical: "restaurantes", tokensIn: 100, tokensOut: 50, costMicroUsd: 3_500_000, callCount: 8, monthlyCapMicroUsd: 10_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 4_000_000 },
        { organizationId: "org-b", organizationName: "Hotel Bahía", organizationSlug: "hotel-bahia", vertical: "hoteles", tokensIn: 10, tokensOut: 5, costMicroUsd: 1_500_000, callCount: 4, monthlyCapMicroUsd: 2_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 1_800_000 },
      ]),
    llmPorModelo: async () =>
      ok([
        { vertical: "restaurantes", providerId: "openrouter:deepseek/deepseek-v4.1-flash", model: "deepseek/deepseek-v4.1-flash", tokensIn: 100, tokensOut: 50, costMicroUsd: 3_500_000, callCount: 8 },
        { vertical: "hoteles", providerId: "openrouter:deepseek/deepseek-v4.1-flash", model: "deepseek/deepseek-v4.1-flash", tokensIn: 10, tokensOut: 5, costMicroUsd: 500_000, callCount: 2 },
        { vertical: "hoteles", providerId: "openrouter:anthropic/claude-sonnet-5.5", model: "anthropic/claude-sonnet-5.5", tokensIn: 10, tokensOut: 5, costMicroUsd: 1_000_000, callCount: 2 },
      ]),
    llmPorRolMes: async () =>
      ok([
        { organizationId: "org-a", organizationName: "Taquería Don Beto", role: "restaurantes:data_chat", month: "2026-10", costMicroUsd: 2_000_000, callCount: 6, fallbackCallCount: 1, tokensIn: 1, tokensOut: 1 },
        { organizationId: "org-b", organizationName: "Hotel Bahía", role: "restaurantes:data_chat", month: "2026-10", costMicroUsd: 1_000_000, callCount: 2, fallbackCallCount: 0, tokensIn: 1, tokensOut: 1 },
        { organizationId: "org-b", organizationName: "Hotel Bahía", role: "hoteles:whatsapp_agent", month: "2026-10", costMicroUsd: 500_000, callCount: 3, fallbackCallCount: 0, tokensIn: 1, tokensOut: 1 },
      ]),
    presupuestoPlataforma: async () => ok({ monthlyCapMicroUsd: 100_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 25_000_000 }),
    copilotoGastoMes: async () => ok(2_000_000),
    copilotoUso: async () =>
      ok([
        { vertical: "plataforma", outcome: "ok", route: "llm", consultas: 5, filas: 20, duracionMs: 900, costoMicroUsd: 2_000_000 },
        { vertical: "restaurantes", outcome: "ok", route: "directa", consultas: 30, filas: 100, duracionMs: 1200, costoMicroUsd: 0 },
      ]),
    consolaOrganizaciones: async () =>
      ok([
        { vertical: "restaurantes", total: 5, demo: 1, activas: 4 },
        { vertical: "hoteles", total: 3, demo: 0, activas: 2 },
      ]),
    consolaOperaciones: async () =>
      ok([
        { vertical: "restaurantes", dia: null, cantidad: 900, razon: null },
        { vertical: "restaurantes", dia: "2026-10-01", cantidad: 40, razon: null },
        { vertical: "restaurantes", dia: "2026-10-02", cantidad: 25, razon: null },
        { vertical: "hoteles", dia: "2026-10-01", cantidad: null, razon: "fuente_no_migrada" as const },
      ]),
    consolaConversacionesWa: async () =>
      ok([
        { vertical: "restaurantes", total: 120, razon: null },
        { vertical: "hoteles", total: null, razon: "sin_whatsapp" as const },
      ]),
    consolaAgentesActividad: async () =>
      ok([
        { vertical: "restaurantes", role: "restaurantes:whatsapp_agent", llamadasHist: 100, costoHistMicroUsd: 9_000_000, fallbackHist: 2, llamadas30d: 60, costo30dMicroUsd: 3_000_000, fallback30d: 1 },
        { vertical: "hoteles", role: "hoteles:whatsapp_agent", llamadasHist: 10, costoHistMicroUsd: 900_000, fallbackHist: 0, llamadas30d: 10, costo30dMicroUsd: 900_000, fallback30d: 0 },
      ]),
    interruptores: async () =>
      ok([
        { scope: "agente" as const, target: "hoteles:whatsapp_agent", blocked: true, reason: "Pausado por revisión de costos del trimestre", updatedBy: null, updatedAtMs: 1 },
        { scope: "cron" as const, target: "/internal/whatsapp/dispatch", blocked: true, reason: "Pausa de mantenimiento programada", updatedBy: null, updatedAtMs: 2 },
      ]),
    corridasAgentes: async () => ok([]),
    heartbeats: async () =>
      ok([
        { cronName: "/internal/whatsapp/dispatch", lastStartedAt: "2026-10-02T14:00:00.000Z", lastFinishedAt: "2026-10-02T14:00:05.000Z", lastStatus: "ok" as const, lastError: null, lastDurationMs: 5000, consecutiveFailures: 0 },
        { cronName: "/internal/hoteles/night-audit", lastStartedAt: "2026-10-02T08:00:00.000Z", lastFinishedAt: "2026-10-02T08:00:09.000Z", lastStatus: "error" as const, lastError: "falló con juan@ejemplo.com tras 3 intentos", lastDurationMs: 9000, consecutiveFailures: 3 },
      ]),
    colas: async () =>
      ok([
        { queueName: "restaurantes", pendingCount: 4, processingCount: 1, sentCount: 500, failedCount: 2, deadCount: 1, oldestPendingSeconds: 120, lastSentAt: "2026-10-02T14:30:00.000Z" },
        { queueName: "citas", pendingCount: 0, processingCount: 0, sentCount: 30, failedCount: 0, deadCount: 0, oldestPendingSeconds: null, lastSentAt: null },
      ]),
    colasMuertos: async () =>
      ok([
        { queueName: "restaurantes" as const, id: "m1", organizationId: "org-a", organizationName: "Taquería Don Beto", channel: "whatsapp", eventType: "pedido_confirmado", error: "numero +52 999 123 4567 invalido", createdAt: "2026-10-01T10:00:00.000Z" },
        { queueName: "restaurantes" as const, id: "m2", organizationId: "org-a", organizationName: "Taquería Don Beto", channel: "whatsapp", eventType: "pedido_confirmado", error: null, createdAt: "2026-10-02T10:00:00.000Z" },
      ]),
    fuentesLicitaciones: async () =>
      ok([
        { organizationId: "org-d", organizationName: "Constructora Sur", source: "comprasmx", state: "down", finishedAt: "2026-10-02T12:00:00.000Z", message: "tiempo agotado en https://compras.example/api" },
        { organizationId: "org-d", organizationName: "Constructora Sur", source: "dof", state: "ok", finishedAt: "2026-10-02T12:00:00.000Z", message: "" },
        { organizationId: "org-d", organizationName: "Constructora Sur", source: "nl_ocds", state: "not_configured", finishedAt: "2026-10-02T12:00:00.000Z", message: "" },
      ]),
    denegaciones: async () =>
      ok([
        { id: "a1", actorUserId: "u-1", actorIp: "10.0.0.1", organizationId: null, action: "superadmin.access", route: "/superadmin/organizations", method: "GET", decision: "denied" as const, reason: "no_superadmin", metadata: {}, occurredAtMs: AHORA.getTime() - 1000 },
        { id: "a2", actorUserId: "u-2", actorIp: "10.0.0.2", organizationId: null, action: "superadmin.access", route: "/superadmin/organizations", method: "GET", decision: "denied" as const, reason: "no_superadmin", metadata: {}, occurredAtMs: AHORA.getTime() - 500 },
      ]),
    eventosSeguridad: async () =>
      ok([
        { id: "e1", seq: 2, area: "switch" as const, event: "interruptor_apagado", actorUserId: "u-1", targetUserId: null, organizationId: null, detail: { objetivo: "hoteles:whatsapp_agent" }, occurredAtMs: AHORA.getTime() - 60_000 },
        { id: "e2", seq: 1, area: "mfa" as const, event: "mfa_activado", actorUserId: "u-1", targetUserId: "u-1", organizationId: null, detail: {}, occurredAtMs: AHORA.getTime() - 120_000 },
      ]),
    planes: async () =>
      ok([
        { id: "restaurantes-estandar", nombre: "Restaurantes Estándar", vertical: "restaurantes", precioBaseCentavos: 0, precioAsientoCentavos: 79900, asientosIncluidos: 1, activo: true, limites: [{ metrica: "mensajes_mes" as const, limite: 5000, accion: "avisar" as const }], organizaciones: 4, updatedAtMs: 1 },
      ]),
    asignaciones: async () =>
      ok([{ id: "as1", organizationId: "org-a", organizationName: "Taquería Don Beto", planId: "restaurantes-estandar", motivo: "Cambio de plan solicitado por el cliente", estado: "pending" as const, creadoPor: "u-1", creadoEnMs: AHORA.getTime() - 3_600_000, venceEnMs: AHORA.getTime() + 3_600_000, confirmadoPor: null, confirmadoEnMs: null, resultado: null }]),
    prospectos: async () =>
      ok([
        { id: "p1", empresa: "Cafetería Luna", vertical: "restaurantes", ciudad: "Mérida", contactoNombre: "Ana Pérez", telefono: "+52 999 111 2222", correo: "ana@luna.mx", estado: "demo", fuente: "referido", notas: "pidió descuento, vive en calle 5", creadoPor: null, createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z", necesitaSeguimientoDesde: null },
        { id: "p2", empresa: "Hotel Brisa", vertical: "hoteles", ciudad: "Cancún", contactoNombre: "Luis Soto", telefono: "+52 998 333 4444", correo: "luis@brisa.mx", estado: "nuevo", fuente: null, notas: null, creadoPor: null, createdAt: "2026-09-10T10:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z", necesitaSeguimientoDesde: null },
        { id: "p3", empresa: "Hotel Mar", vertical: "hoteles", ciudad: null, contactoNombre: null, telefono: null, correo: null, estado: "nuevo", fuente: null, notas: null, creadoPor: null, createdAt: "2026-09-11T10:00:00.000Z", updatedAt: "2026-09-21T10:00:00.000Z", necesitaSeguimientoDesde: null },
      ]),
    cfoFilas: async () => ok([FILA_CFO, FILA_CFO_HOTEL]),
    cfoFotos: async () => ok([]),
    infra: async () => ok([{ mes: "2026-10-01", concepto: "Vercel", montoMxnCentavos: 100_000, nota: null }]),
    contratos: async () =>
      ok([
        { id: "v1", contractId: "c1", organizationId: "org-a", organizationName: "Taquería Don Beto", version: 1, vigenteDesde: "2025-10-01", vigenteHasta: "2026-10-20", moneda: "MXN" as const, baseCentavos: 150_000, porSucursalCentavos: 0, sucursalesIncluidas: 1, bolsaMinutos: 0, excedenteCentavosMinuto: 0, instalacionCentavos: 0, descuentoBp: 0, descuentoFijoCentavos: 0, motivo: "Alta", creadoPor: "u-1", creadoPorCorreo: null, creadoEnMs: 1 },
        // Misma contrato, version 2: la vigente es esta (vence mas tarde, fuera de la ventana de 30 dias).
        { id: "v2", contractId: "c1", organizationId: "org-a", organizationName: "Taquería Don Beto", version: 2, vigenteDesde: "2025-10-01", vigenteHasta: "2027-01-01", moneda: "MXN" as const, baseCentavos: 150_000, porSucursalCentavos: 0, sucursalesIncluidas: 1, bolsaMinutos: 0, excedenteCentavosMinuto: 0, instalacionCentavos: 0, descuentoBp: 0, descuentoFijoCentavos: 0, motivo: "Renovación", creadoPor: "u-1", creadoPorCorreo: null, creadoEnMs: 2 },
        { id: "v3", contractId: "c2", organizationId: "org-b", organizationName: "Hotel Bahía", version: 1, vigenteDesde: "2025-10-01", vigenteHasta: "2026-10-25", moneda: "MXN" as const, baseCentavos: 250_000, porSucursalCentavos: 0, sucursalesIncluidas: 1, bolsaMinutos: 0, excedenteCentavosMinuto: 0, instalacionCentavos: 0, descuentoBp: 0, descuentoFijoCentavos: 0, motivo: "Alta", creadoPor: "u-1", creadoPorCorreo: null, creadoEnMs: 3 },
        { id: "v4", contractId: "c3", organizationId: "org-c", organizationName: "Posada Sol", version: 1, vigenteDesde: "2025-10-01", vigenteHasta: null, moneda: "MXN" as const, baseCentavos: 90_000, porSucursalCentavos: 0, sucursalesIncluidas: 1, bolsaMinutos: 0, excedenteCentavosMinuto: 0, instalacionCentavos: 0, descuentoBp: 0, descuentoFijoCentavos: 0, motivo: "Alta", creadoPor: "u-1", creadoPorCorreo: null, creadoEnMs: 4 },
      ]),
    facturacion: async () =>
      ok([
        { organizationId: "org-a", vertical: "restaurantes", name: "Taquería Don Beto", slug: "taqueria-don-beto", orgStatus: "active" as const, createdAt: "2026-03-01T10:00:00.000Z", billingStatus: "activa" as const, seats: 3, staffCount: 4, priceId: "price_x", stripeCustomerId: "cus_secreto", stripeSubscriptionId: "sub_secreto", currentPeriodEnd: "2026-10-28T00:00:00.000Z", lastAppliedEventUnix: null },
        { organizationId: "org-b", vertical: "hoteles", name: "Hotel Bahía", slug: "hotel-bahia", orgStatus: "active" as const, createdAt: "2026-04-01T10:00:00.000Z", billingStatus: "pago_pendiente" as const, seats: 1, staffCount: 2, priceId: "price_y", stripeCustomerId: "cus_otro", stripeSubscriptionId: "sub_otro", currentPeriodEnd: "2026-10-05T00:00:00.000Z", lastAppliedEventUnix: null },
        { organizationId: "org-c", vertical: "hoteles", name: "Posada Sol", slug: "posada-sol", orgStatus: "trial" as const, createdAt: "2026-09-01T10:00:00.000Z", billingStatus: "sin_suscripcion" as const, seats: 0, staffCount: 1, priceId: null, stripeCustomerId: null, stripeSubscriptionId: null, currentPeriodEnd: null, lastAppliedEventUnix: null },
      ]),
    operacionesPorOrganizacion: async (_desde, _hasta, _hoy, organizationId) => {
      llamadasOperaciones.push({ desde: _desde, hasta: _hasta, hoy: _hoy, organizationId: organizationId ?? null });
      return ok(OPERACIONES_POR_ORG.filter((x) => !organizationId || x.organizationId === organizationId));
    },
    registrarAccesoOrganizaciones: async (ids, herramienta, filtros) => {
      accesosOrg.push({ ids: [...ids], herramienta, filtros });
      return "ok";
    },
    registrarAccesoCfo: async (accion, recurso, filtros) => {
      accesosCfo.push({ accion, recurso, filtros });
      return "ok";
    },
  };
  return Object.assign({ ...base, ...sobre }, { accesosCfo, accesosOrg, llamadasOperaciones });
}

export const SCOPE_SUPERADMIN: PlatformScope = { userId: "u-sa", rol: "superadmin", stepUp: true, timezone: "America/Mexico_City" };
export const SCOPE_FINANZAS: PlatformScope = { userId: "u-fin", rol: "finanzas", stepUp: true, timezone: "America/Mexico_City" };

export function ctxHerramienta(scope: PlatformScope, now: Date = AHORA): DataChatToolContext {
  return { scope: alcanceDelMotor(scope), now, signal: new AbortController().signal, maxRows: 50 };
}

/** Todas las columnas y filas de un resultado como texto: para comprobar que ningun dato de contacto ni PII llega al resultado. */
export function volcado(r: DataChatToolResult): string {
  return JSON.stringify({ columns: r.columns, rows: r.rows, summary: r.summary, source: r.source, message: r.message });
}
