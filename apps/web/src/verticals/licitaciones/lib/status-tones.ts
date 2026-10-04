// Tablas `estado -> tono` de licitaciones para <StatusBadge> de @atiende/ui (PR-9 del plan de
// diseno-ux, F-09): reemplazan los mapas `{ variant, className }` con pares de colores crudos
// (border-amber-500/60 text-amber-600 dark:...) y las variantes de <Badge> de cada pagina. Un
// estado que la tabla aun no conoce cae a "neutral" (via `statusTone`) en vez de pintarse mal.
// La carga semantica es la misma de antes: verde = bien/hecho, ambar = atencion, rojo = urgente
// o bloqueado, azul = en curso/informativo, gris = neutro.
import type { StatusTone } from "@atiende/ui";

type Tabla = Readonly<Record<string, StatusTone>>;

/** Semaforo de plazos de la sala de guerra y de la junta de aclaraciones. */
export const SEMAFORO_TONES: Tabla = { rojo: "danger", amarillo: "warning", verde: "success", gris: "neutral" };

/** Resultado de un requisito de cumplimiento (convocatoria y expediente de cierre). */
export const RESULTADO_CUMPLIMIENTO_TONES: Tabla = { verde: "success", ambar: "warning", rojo: "danger" };

/** Estatus del paquete de cierre: listo = verde, borrador = ambar. */
export const PAQUETE_CIERRE_TONES: Tabla = { ready: "success", draft: "warning" };

/** Estatus de una alerta del radar de renovaciones. */
export const ALERTA_RENOVACION_TONES: Tabla = { pendiente: "warning", reconocida: "success" };

/** Urgencia de una alerta del radar de renovaciones (ver `urgencyFor`). */
export const URGENCIA_RENOVACION_TONES: Readonly<Record<"urgente" | "proxima" | "seguimiento", StatusTone>> = { urgente: "danger", proxima: "warning", seguimiento: "neutral" };

/** Estatus de una factura de la post-adjudicacion. */
export const FACTURA_STATUS_TONES: Tabla = { pendiente: "warning", pagada: "success", vencida: "danger" };

/** Viabilidad de una inconformidad. */
export const VIABILIDAD_TONES: Tabla = { alta: "success", media: "warning", baja: "danger" };

/** Estatus de un borrador de inconformidad. */
export const BORRADOR_ESTATUS_TONES: Tabla = { revisado: "success", borrador: "neutral" };

/** Estatus de la propuesta propia en la autopsia del fallo. */
export const PROPUESTA_PROPIA_TONES: Tabla = { ganadora: "success", desechada: "danger", no_presentada: "warning", desconocido: "neutral" };

/** Estatus de un requisito de las bases. */
export const REQUISITO_STATUS_TONES: Tabla = { pendiente: "neutral", en_progreso: "info", cumplido: "success", bloqueado: "danger", no_evaluable: "neutral" };

/** Estatus de aprobacion de un dato de la empresa. */
export const APROBACION_DATO_TONES: Tabla = { aprobado: "success", pendiente_aprobacion: "warning", rechazado: "danger" };

/** Estatus de una pregunta de la junta de aclaraciones. */
export const PREGUNTA_JUNTA_TONES: Tabla = { borrador: "neutral", aprobada: "info", enviada: "warning", respondida: "success", descartada: "neutral" };

/** Estatus del contacto de WhatsApp de la organizacion. */
export const CONTACTO_WHATSAPP_TONES: Tabla = { pendiente: "warning", activo: "success", baja: "neutral" };

/** Estatus de una invitacion de staff. */
export const INVITACION_STAFF_TONES: Tabla = { pending: "neutral", accepted: "success", revoked: "danger", expired: "danger" };

/** Elegibilidad calculada por el matching de una convocatoria. */
export const ELEGIBILIDAD_TONES: Tabla = { cumple: "success", no_cumple: "danger", no_evaluable: "neutral" };

/** Estados del contrato que piden atencion (penalizado, rescindido, en inconformidad, cerrado). */
const CONTRATO_ALERTA: ReadonlySet<string> = new Set(["penalizado", "rescindido", "en_inconformidad", "cerrado"]);

/** Tono del estatus de un contrato: rojo en los estados de alerta, neutro en el resto. */
export function contratoStatusTone(status: string): StatusTone {
  return CONTRATO_ALERTA.has(status) ? "danger" : "neutral";
}

/** Estatus de un campo extraido de un contrato: el sugerido espera revision humana (ambar). */
export const CAMPO_CONTRATO_TONES: Tabla = { sugerido: "warning" };

/** Estado de una corrida de fuente de convocatorias: ok verde, cualquier otro rojo (via `fallback`). */
export const CORRIDA_FUENTE_TONES: Tabla = { ok: "success" };

/** Semaforo del KYC negativo 69-B del SAT (L-08): definitivo = rojo, presunto = ambar, sin riesgo vigente = verde, sin lista = neutro. */
export const KYC_SEMAFORO_TONES: Tabla = { rojo: "danger", ambar: "warning", verde: "success", sin_datos: "neutral" };

/** Estado EFECTIVO de una garantia de contrato (L-27): entregada = verde, pendiente/vencida = ambar/rojo, final = neutro. */
export const GARANTIA_ESTADO_TONES: Tabla = { pendiente_entrega: "warning", entregada: "success", liberada: "neutral", ejecutada: "danger", vencida: "danger" };

/** Estado EFECTIVO de un hito de contrato (L-27): `vencido` es un estado derivado de la fecha comprometida. */
export const HITO_ESTADO_TONES: Tabla = { pendiente: "info", vencido: "danger", cumplido: "success", cancelado: "neutral" };

/** Estado de extracción de texto de un documento de la bóveda (paridad3): sin texto nunca se inventa contenido. */
export const EXTRACCION_DOCUMENTO_TONES: Tabla = { extracted: "success", requires_ocr: "warning", failed: "danger" };

/** Estado de un conflicto entre requisitos. */
export const CONFLICTO_REQUISITO_TONES: Tabla = { abierto: "danger", resuelto: "success" };
