// Compone el "resumen legible" que se guarda EN el intent al crearlo
// (`core.superadmin_action_intent.resumen`) -- MISMO criterio que
// `resumen-diario/redaccion.ts::plantillaDeterminista`: texto compuesto en
// TS a partir de datos YA leídos, NUNCA por un LLM, siempre antes de
// persistir (la función SQL solo guarda el texto ya compuesto).
import type { OutboxDeadMessageDetailRow } from "@atiende/db";

/** Intenta extraer un destinatario legible del payload de un mensaje de
 *  outbox -- la forma del payload varía por vertical/evento (nunca hay un
 *  esquema único), así que se prueban las claves más comunes en orden;
 *  `"desconocido"` si ninguna aparece -- NUNCA se inventa un valor. */
function extraerDestinatarioCrudo(payload: Record<string, unknown>): string | null {
  for (const key of ["to", "telefono", "phone", "destinatario", "recipient", "email", "correo"]) {
    const v = payload[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

const EMAIL_RE = /^([^@]+)@(.+)$/;

/** Enmascara un destinatario para mostrarlo en un resumen que un superadmin
 *  (no necesariamente con acceso a datos personales de un tenant) va a
 *  leer antes de confirmar un envío real -- conserva lo suficiente para
 *  reconocerlo (últimos 2-4 caracteres / dominio de correo), nunca el dato
 *  completo. */
export function enmascararDestinatario(payload: Record<string, unknown>): string {
  const crudo = extraerDestinatarioCrudo(payload);
  if (crudo === null) return "destinatario desconocido";

  const email = EMAIL_RE.exec(crudo);
  if (email) {
    const [, local, dominio] = email;
    const localEnmascarado = (local ?? "").length <= 2 ? "**" : `${(local ?? "")[0]}***${(local ?? "").slice(-1)}`;
    return `${localEnmascarado}@${dominio}`;
  }

  // Teléfono u otro identificador -- conserva los últimos 4 caracteres.
  const cola = crudo.slice(-4);
  return crudo.length <= 4 ? "*".repeat(crudo.length) : `${"*".repeat(crudo.length - 4)}${cola}`;
}

/** Resumen de `reencolar_mensaje_muerto` -- canal, vertical, organización,
 *  destinatario enmascarado, y el error que lo mató (requisito explícito
 *  del encargo). */
export function construirResumenReencolarMensajeMuerto(detalle: OutboxDeadMessageDetailRow): string {
  const destinatario = enmascararDestinatario(detalle.payload);
  const error = detalle.error ?? "sin detalle de error registrado";
  return (
    `Esto provocará un envío real por ${detalle.channel} a ${destinatario} ` +
    `(organización "${detalle.organizationName}", vertical ${detalle.queueName}, evento "${detalle.eventType}"). ` +
    `Murió con el error: ${error}.`
  );
}

/** Resumen de `cerrar_prospecto`. */
export function construirResumenCerrarProspecto(empresa: string, estadoActual: string, estadoDestino: "perdido" | "descartado"): string {
  return `Cambiará el prospecto "${empresa}" de "${estadoActual}" a "${estadoDestino}". No contacta a nadie ni afecta datos de ningún tenant.`;
}

/** Resumen de `ejecutar_mantenimiento_ahora`. */
export function construirResumenEjecutarMantenimientoAhora(): string {
  return "Corre ahora mismo las dos automatizaciones internas (desatascar outbox colgado + marcar prospectos sin movimiento). No envía nada ni contacta a nadie.";
}
