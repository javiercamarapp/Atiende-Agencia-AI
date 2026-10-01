// Tablas `estado -> tono` del back office de plataforma para <StatusBadge> de @atiende/ui
// (PR-10 del plan de diseno-ux): reemplazan las variantes de <Badge> (`default`/`destructive`/
// `secondary`/`outline`) y los pares de colores crudos (`bg-emerald-600`, `bg-amber-500`,
// `bg-violet-600`) que cada pagina elegia a mano. Un estado que la tabla aun no conoce cae a
// "neutral" (via `statusTone`) en vez de pintarse mal. La carga semantica es la de antes:
// verde = bien/hecho, ambar = atencion, rojo = urgente o bloqueado, azul = informativo.
import type { StatusTone } from "@atiende/ui";

type Tabla = Readonly<Record<string, StatusTone>>;

/** Estado de una organizacion (dashboard y gestion de organizaciones). */
export const ORG_STATUS_TONES: Tabla = { active: "success", suspended: "danger", trial: "neutral" };

/** Estado de una accion / intent de la consola (acciones, gestion de organizaciones, planes). */
export const ACCION_ESTADO_TONES: Tabla = { executed: "success", failed: "danger", expired: "warning", cancelled: "neutral", pending: "neutral" };

/** Estado de facturacion de una organizacion. */
export const BILLING_ESTADO_TONES: Tabla = { activa: "success", pago_pendiente: "danger", sin_suscripcion: "neutral", cancelada: "neutral" };

/** Severidad de una alerta de salud operativa (resumen diario y salud). */
export const SEVERIDAD_ALERTA_TONES: Tabla = { critica: "danger", alta: "warning", media: "neutral" };

/** Severidad de una alerta del dashboard CFO (critica y alta urgen igual). */
export const SEVERIDAD_CFO_TONES: Tabla = { critica: "danger", alta: "danger", media: "warning" };

/** Estado del latido de un cron. */
export const CRON_ESTADO_TONES: Tabla = { ok: "success", vencido: "warning", error: "danger" };

/** Estado de una corrida de fuente de licitaciones: ok verde, sin configurar neutro, cualquier otro rojo (via `fallback`). */
export const FUENTE_ESTADO_TONES: Tabla = { ok: "success", not_configured: "neutral" };

/** Etapa de un prospecto. */
export const PROSPECTO_ESTADO_TONES: Tabla = { nuevo: "info", ganado: "success", perdido: "danger", descartado: "danger" };

/** Riesgo de margen de una organizacion (costos y margen). */
export const RIESGO_MARGEN_TONES: Tabla = { alto: "danger", medio: "warning", bajo: "success" };
