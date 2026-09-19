// Correo del resumen diario -- opcional, best-effort, UN SOLO envío por
// fecha. Sin `RESEND_API_KEY` configurada (`deps.env.resend.apiKey ===
// null`), el resumen se guarda igual (visible en /superadmin/resumen) pero
// NO se envía -- lo deja dicho en el registro (nunca finge un envío). Los
// destinatarios SIEMPRE salen de `core.platform_superadmin` -> `core.
// staff_user.email` en vivo -- nunca una lista hardcodeada ni una variable
// de entorno nueva (requisito explícito del diseño).
import { escapeHtml, renderCorreo } from "@atiende/core-email";
import type { AppDeps } from "../deps.ts";
import type { DiarioAgregados } from "./motor.ts";

export type MotivoEnvioCorreo = "enviado" | "ya_enviado_antes" | "resend_no_configurado" | "sin_destinatarios" | "error_envio";

export interface ResultadoEnvioCorreo {
  readonly enviado: boolean;
  readonly motivo: MotivoEnvioCorreo;
}

async function obtenerDestinatarios(deps: AppDeps): Promise<readonly string[]> {
  try {
    return await deps.resumenDiarioRepo.listPlatformSuperadminEmailsForSystem();
  } catch (err) {
    console.error("resumen-diario correo: no se pudo leer la lista de superadmins de plataforma:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function moneda(microUsd: number | null): string {
  return microUsd === null ? "no disponible" : `$${(microUsd / 1_000_000).toFixed(2)} USD`;
}

function construirCorreo(agregados: DiarioAgregados, narrativa: string): { readonly html: string; readonly text: string; readonly subject: string } {
  const subject = `Resumen diario de operación — ${agregados.fecha}`;
  const hayAlertas = agregados.salud.alertas.length > 0;
  const filas = [
    { etiqueta: "Alertas de salud", valor: String(agregados.salud.alertas.length) },
    { etiqueta: "Gasto de LLM hoy", valor: moneda(agregados.gastoLlm.costoHoyMicroUsd) },
    { etiqueta: "Altas de facturación", valor: agregados.facturacion === null ? "no disponible" : String(agregados.facturacion.altas) },
    { etiqueta: "Morosos nuevos", valor: agregados.facturacion === null ? "no disponible" : String(agregados.facturacion.morososNuevos) },
    { etiqueta: "Prospectos nuevos", valor: agregados.prospectos === null ? "no disponible" : String(agregados.prospectos.altas) },
  ];
  const html = renderCorreo({
    titulo: subject,
    preheader: narrativa.slice(0, 140),
    etiqueta: { texto: hayAlertas ? "Revisar alertas" : "Todo en orden", color: hayAlertas ? "#B45309" : "#1D4ED8" },
    parrafosHtml: [escapeHtml(narrativa)],
    tabla: { filas },
    nota: "Este correo es informativo, solo para el superadmin de plataforma — no ejecuta ninguna acción ni contacta a ningún cliente o tenant.",
    marcaTagline: "atiende · back office de plataforma",
    piePorQueLlego: "Recibes este correo porque tu cuenta de staff tiene acceso de superadmin de plataforma en Atiende.",
  });
  const text = `${subject}\n\n${narrativa}\n\n${filas.map((f) => `${f.etiqueta}: ${f.valor}`).join("\n")}`;
  return { html, text, subject };
}

/** Envía el correo del resumen de `fecha` a los superadmins de plataforma
 *  vigentes, si corresponde -- nunca lanza (cualquier fallo se registra y se
 *  refleja en `motivo`, el llamador -- cron o "generar ahora" -- nunca debe
 *  fallar por esto). Marca `correo_enviado_en` SOLO después de que Resend
 *  aceptó el envío (ver `core.mark_daily_ops_summary_email_sent`), así que
 *  un fallo de red entre el envío real y el marcado deja la puerta abierta a
 *  un reintento (mejor que un "enviado" falso que nunca salió). */
export async function enviarCorreoResumenDiarioSiCorresponde(deps: AppDeps, fecha: string, agregados: DiarioAgregados, narrativa: string): Promise<ResultadoEnvioCorreo> {
  const yaGuardado = await deps.resumenDiarioRepo.getDailyOpsSummaryForSystem(fecha).catch(() => null);
  if (yaGuardado?.correoEnviadoEn) return { enviado: false, motivo: "ya_enviado_antes" };

  if (!deps.env.resend.apiKey) {
    console.warn(`resumen-diario correo: RESEND_API_KEY no configurada -- el resumen de ${fecha} no se envía por correo (se guardó igual, ver /superadmin/resumen).`);
    return { enviado: false, motivo: "resend_no_configurado" };
  }

  const destinatarios = await obtenerDestinatarios(deps);
  if (destinatarios.length === 0) {
    console.warn(`resumen-diario correo: sin superadmins de plataforma registrados -- el resumen de ${fecha} no se envía a nadie.`);
    return { enviado: false, motivo: "sin_destinatarios" };
  }

  const { html, text, subject } = construirCorreo(agregados, narrativa);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.env.resend.apiKey}`,
        "Content-Type": "application/json",
        // Hallazgo de auditoría a1 (BAJA, rubro D): el marcado atómico de
        // `correo_enviado_en` se hace DESPUÉS de enviar (check-then-act, ver
        // el comentario de cabecera de esta función para el porqué de NO
        // invertir el orden) -- dos corridas concurrentes del cron para la
        // MISMA fecha (p. ej. el cron real disparándose dos veces por un
        // reintento de la plataforma serverless) podían mandar el correo dos
        // veces. Resend soporta idempotencia real en el servidor vía este
        // header en `POST /emails` (confirmado contra la documentación
        // oficial, ver el cuerpo del PR: ventana de deduplicación de 24
        // horas, hasta 256 caracteres, debe ser única por request) -- con la
        // MISMA clave para la MISMA fecha, un segundo POST concurrente NUNCA
        // reenvía: si el cuerpo coincide, Resend devuelve la MISMA respuesta
        // del primer envío sin mandar nada; si no coincide (p. ej. la
        // narrativa del LLM salió distinta entre las dos corridas), Resend
        // responde 409 `invalid_idempotent_request` -- en AMBOS casos el
        // correo real se manda COMO MÁXIMO una vez. Una fecha (`YYYY-MM-DD`)
        // es la granularidad correcta: "un solo envío por fecha" es
        // exactamente el requisito de diseño de esta función.
        "Idempotency-Key": `resumen-diario/${fecha}`,
      },
      body: JSON.stringify({ from: deps.env.resend.from, to: destinatarios, subject, html, text }),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      console.error(`resumen-diario correo: Resend respondió ${res.status} para ${fecha}: ${bodyText.slice(0, 300)}`);
      return { enviado: false, motivo: "error_envio" };
    }
  } catch (err) {
    console.error(`resumen-diario correo: error de red enviando el resumen de ${fecha}:`, err instanceof Error ? err.message : String(err));
    return { enviado: false, motivo: "error_envio" };
  }

  await deps.resumenDiarioRepo.markDailyOpsSummaryEmailSent(fecha);
  return { enviado: true, motivo: "enviado" };
}
