// Avisos de fin de prueba a 7 / 3 / 1 dias (PL-16). Cada aviso se RECLAMA en la base (`core.trial_notice_claim`, clave primaria
// organizacion + dias + fecha de fin): sale exactamente una vez aunque el cron corra varias veces el mismo dia o dos corridas se
// crucen. El dia se cuenta en la zona horaria del negocio. Dos canales: notificacion in-app a owner/admin (catalogo compartido) y
// correo a owner/admin. Un correo fallido se reintenta hasta 3 veces (el reclamo devuelve los pendientes pasada media hora).
//
// Cada aviso corre en SU PROPIA transaccion de sistema: un fallo en una organizacion no revierte las demas ni deja la sesion
// abortada. Base sin migrar: `disponible: false`, sin tocar nada y sin error.
//
// Correo: directo por Resend con clave de idempotencia (mismo patron que el resumen diario), NO por el outbox de correo de una
// vertical: esos outboxes son por vertical y por sucursal, y este aviso es de plataforma (una vez por organizacion).
import { escapeHtml, renderCorreo } from "@atiende/core-email";
import { destinatariosAvisoPrueba, emitirNotificacion, marcarAvisoPrueba, reclamarAvisosPrueba } from "@atiende/db";
import type { AvisoPrueba, EstadoCorreoAviso } from "@atiende/db";
import type { AppDeps } from "../deps.ts";

/** Ids del catalogo, literales (el catalogo y su prueba verifican que este archivo los emite). */
const EVENTO_PRUEBA: Readonly<Record<string, string>> = {
  hoteles: "hoteles.plan.prueba_por_vencer",
  restaurantes: "restaurantes.plan.prueba_por_vencer",
  rentas: "rentas.plan.prueba_por_vencer",
  licitaciones: "licitaciones.plan.prueba_por_vencer",
  citas: "citas.plan.prueba_por_vencer",
  despachos: "despachos.plan.prueba_por_vencer",
};

export interface ResumenAvisosPrueba {
  readonly disponible: boolean;
  readonly reclamados: number;
  readonly notificados: number;
  readonly correos: Readonly<Record<EstadoCorreoAviso, number>>;
  readonly errores: number;
}

function textoDias(dias: number): string {
  return dias === 1 ? "1 día" : `${dias} días`;
}

function correoPrueba(deps: AppDeps, aviso: AvisoPrueba): { subject: string; html: string; text: string } {
  const enlace = `${deps.env.appBaseUrl}/${aviso.vertical}/${aviso.slug}/plan`;
  const subject = `Su prueba de atiende termina en ${textoDias(aviso.diasAntes)}`;
  const html = renderCorreo({
    titulo: subject,
    preheader: "Revise el estado de su cuenta para no perder el acceso.",
    etiqueta: { texto: "Fin de prueba", color: "#B45309" },
    parrafosHtml: [
      `La prueba de <strong>${escapeHtml(aviso.organizationName)}</strong> termina en ${escapeHtml(textoDias(aviso.diasAntes))}.`,
      "Revise Plan y uso para ver el estado de su cuenta.",
      `<a href="${escapeHtml(enlace)}">${escapeHtml(enlace)}</a>`,
    ],
    piePorQueLlego: "Recibe este correo porque es administrador de la cuenta.",
  });
  const text = `La prueba de ${aviso.organizationName} termina en ${textoDias(aviso.diasAntes)}. Revise Plan y uso: ${enlace}`;
  return { subject, html, text };
}

async function enviarCorreo(deps: AppDeps, aviso: AvisoPrueba, destinatarios: readonly string[]): Promise<EstadoCorreoAviso> {
  if (!deps.env.resend.apiKey) return "no_configurado";
  if (destinatarios.length === 0) return "sin_destinatarios";
  const { subject, html, text } = correoPrueba(deps, aviso);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.env.resend.apiKey}`,
        "Content-Type": "application/json",
        // Un reintento o una corrida concurrente nunca duplica el correo: Resend deduplica por esta clave.
        "Idempotency-Key": `prueba/${aviso.organizationId}/${aviso.diasAntes}/${aviso.trialEndsAt.slice(0, 10)}`,
      },
      body: JSON.stringify({ from: deps.env.resend.from, to: destinatarios, subject, html, text }),
    });
    if (!res.ok) {
      console.error(`aviso-prueba: Resend respondio ${res.status}`);
      return "error";
    }
    return "enviado";
  } catch (err) {
    console.error("aviso-prueba: error de red enviando el correo:", err instanceof Error ? err.name : typeof err);
    return "error";
  }
}

export async function ejecutarAvisosPrueba(deps: AppDeps, now: Date = new Date()): Promise<ResumenAvisosPrueba> {
  const reclamo = await deps.engine.withAppSession({ userId: null }, (db) => reclamarAvisosPrueba(db, now));
  const correos: Record<EstadoCorreoAviso, number> = { enviado: 0, sin_destinatarios: 0, no_configurado: 0, error: 0 };
  let notificados = 0;
  let errores = 0;
  if (!reclamo.disponible) return { disponible: false, reclamados: 0, notificados, correos, errores };

  for (const aviso of reclamo.avisos) {
    try {
      const estado = await deps.engine.withAppSession({ userId: null }, async (db) => {
        const evento = EVENTO_PRUEBA[aviso.vertical];
        if (evento) {
          const r = await emitirNotificacion(db, {
            evento,
            organizationId: aviso.organizationId,
            clave: `${aviso.organizationId}:${aviso.diasAntes}:${aviso.trialEndsAt.slice(0, 10)}`,
            parametros: { dias: aviso.diasAntes },
            entidadTipo: "prueba",
          });
          if (r.estado === "emitida") notificados += 1;
        }
        const destinatarios = await destinatariosAvisoPrueba(db, aviso.organizationId);
        const resultado = await enviarCorreo(deps, aviso, destinatarios);
        await marcarAvisoPrueba(db, aviso, resultado);
        return resultado;
      });
      correos[estado] += 1;
    } catch (err) {
      errores += 1;
      console.error("aviso-prueba: fallo una organizacion (se reintenta en la siguiente corrida):", (err as { code?: unknown })?.code ?? null, err instanceof Error ? err.name : typeof err);
    }
  }
  return { disponible: true, reclamados: reclamo.avisos.length, notificados, correos, errores };
}
