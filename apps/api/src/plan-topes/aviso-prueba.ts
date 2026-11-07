// Avisos de fin de prueba a 7 / 3 / 1 dias (PL-16) y, desde la migracion 0072, el aviso "la prueba termino" (dias 0). Cada aviso se
// RECLAMA en la base (`core.trial_notice_claim`, clave primaria organizacion + dias + fecha de fin): sale exactamente una vez aunque el
// cron corra varias veces el mismo dia o dos corridas se crucen. El dia se cuenta en la zona horaria del negocio. Dos canales:
// notificacion in-app a owner/admin (catalogo compartido) y correo a owner/admin; el aviso de prueba terminada avisa ademas a
// superadmin. Un correo fallido se reintenta hasta 3 veces (el reclamo devuelve los pendientes pasada media hora).
//
// Texto neutro e igual en las 6 verticales: al terminar la prueba NADA se apaga (la organizacion sigue operando; el pago la activa y
// suspender es decision humana), asi que ningun aviso promete ni amenaza un corte. Las organizaciones demo no se reclaman (0072).
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

/** Aviso "su prueba termino, elija un plan" (dias 0). */
const EVENTO_PRUEBA_TERMINADA: Readonly<Record<string, string>> = {
  hoteles: "hoteles.plan.prueba_terminada",
  restaurantes: "restaurantes.plan.prueba_terminada",
  rentas: "rentas.plan.prueba_terminada",
  licitaciones: "licitaciones.plan.prueba_terminada",
  citas: "citas.plan.prueba_terminada",
  despachos: "despachos.plan.prueba_terminada",
};

/** Alerta de plataforma: la prueba de una organizacion termino (sigue operando; superadmin decide el seguimiento). */
const EVENTO_PRUEBA_TERMINADA_SUPERADMIN = "superadmin.plan.prueba_terminada";

/** Codigo corto sin PII para el texto de la alerta de superadmin (mismo criterio que medidor.ts). */
function slugCorto(slug: string): string {
  const limpio = slug.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 40);
  return limpio.length > 0 ? limpio : "organizacion";
}

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
  const terminada = aviso.diasAntes === 0;
  const subject = terminada ? "Su prueba de atiende terminó: elija un plan" : `Su prueba de atiende termina en ${textoDias(aviso.diasAntes)}`;
  const html = renderCorreo({
    titulo: subject,
    preheader: "Revise Plan y uso para elegir el plan de su cuenta.",
    etiqueta: { texto: "Fin de prueba", color: "#B45309" },
    parrafosHtml: [
      terminada
        ? `La prueba de <strong>${escapeHtml(aviso.organizationName)}</strong> terminó.`
        : `La prueba de <strong>${escapeHtml(aviso.organizationName)}</strong> termina en ${escapeHtml(textoDias(aviso.diasAntes))}.`,
      "Revise Plan y uso para elegir el plan de su cuenta.",
      `<a href="${escapeHtml(enlace)}">${escapeHtml(enlace)}</a>`,
    ],
    piePorQueLlego: "Recibe este correo porque es administrador de la cuenta.",
  });
  const text = terminada
    ? `La prueba de ${aviso.organizationName} terminó. Revise Plan y uso para elegir el plan de su cuenta: ${enlace}`
    : `La prueba de ${aviso.organizationName} termina en ${textoDias(aviso.diasAntes)}. Revise Plan y uso para elegir el plan de su cuenta: ${enlace}`;
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
        const terminada = aviso.diasAntes === 0;
        const clave = `${aviso.organizationId}:${aviso.diasAntes}:${aviso.trialEndsAt.slice(0, 10)}`;
        const evento = (terminada ? EVENTO_PRUEBA_TERMINADA : EVENTO_PRUEBA)[aviso.vertical];
        if (evento) {
          const r = await emitirNotificacion(db, {
            evento,
            organizationId: aviso.organizationId,
            clave,
            parametros: terminada ? {} : { dias: aviso.diasAntes },
            entidadTipo: "prueba",
          });
          if (r.estado === "emitida") notificados += 1;
        }
        // Un reintento de correo no repite la alerta de superadmin (el dedupe la descartaria igual).
        if (terminada && !aviso.esReintento) {
          await emitirNotificacion(db, {
            evento: EVENTO_PRUEBA_TERMINADA_SUPERADMIN,
            organizationId: null,
            clave,
            parametros: { organizacion: slugCorto(aviso.slug) },
            entidadTipo: "organizacion",
            entidadId: aviso.organizationId,
          });
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
