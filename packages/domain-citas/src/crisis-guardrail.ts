// Guardia de crisis — capa DETERMINISTA (nunca delegada al LLM) que intercepta un
// mensaje con una palabra clave real de riesgo (autolesión o suicidio) ANTES de que
// el agente conversacional de WhatsApp siquiera llame al proveedor de LLM, deja un
// registro real (`citas.emergency_escalations`) para seguimiento humano, y — si el
// negocio configuró un teléfono de aviso — encola una notificación real de WhatsApp
// al dueño/staff. Port de
// citas-reservaciones/supabase/functions/_shared/crisis-guardrail-core.ts sobre
// `CitasRepository` en vez de un cliente supabase-js crudo (mismo cambio de firma
// que el resto de este paquete).
//
// Solo aplica a rubros de salud (ver vertical-config.ts::requiresCrisisGuardrail).
// Aplica a WhatsApp (whatsapp/inbound.ts) y a la VOZ: el agente de voz corre sobre
// @atiende/voice-core, cuyo controlador evalúa lo que dice el cliente con
// `voz/guardia-crisis.ts` (misma lista de palabras y mismo rubro), dice el mensaje de crisis
// tal cual y escala con la herramienta `derivar_a_humano`, que registra la escalación
// con `registrarEscalacionCrisis` (canal 'voice').
import type { HandoffAgentGate } from "./conversaciones/repository.ts";
import type { CitasRepository } from "./repository.ts";
import { CRISIS_ESCALATION_MESSAGE, crisisGuardActivaPara, detectCrisisKeyword } from "./vertical-config.ts";

export interface CrisisGuardrailResult {
  readonly triggered: boolean;
  readonly reply?: string;
  readonly escalationId?: string;
}

/**
 * Best-effort: si el negocio configuró `owner_notification_phone` (citas.tenant_config)
 * y tiene un número de WhatsApp activo (citas.whatsapp_config), encola un aviso real
 * al dueño/staff vía el mismo outbox que usa el resto del canal — nunca habla directo
 * con Graph API. Sin esa configuración, no hace nada (la escalación YA quedó
 * registrada en `emergency_escalations`; esto es un aviso adicional, no la única
 * forma de enterarse).
 *
 * f2-citas-whatsapp-config-sesion-sistema — el ÚNICO caller real de
 * `runCrisisGuardrail` (`whatsapp/inbound.ts::handleInboundWhatsAppMessage`,
 * invocado desde `apps/api/.../citas/whatsapp.ts`) corre dentro de
 * `deps.engine.withAppSession({ userId: null }, ...)` -- SIEMPRE sesión de
 * SISTEMA (el webhook entrante de Meta no tiene usuario autenticado). Mismo
 * gap de RLS que ya se cerró para `runOptimizadorCore`/`runListaEsperaCore`
 * (ver `repository.ts::resolveActiveWhatsAppPhoneNumberIdAsSystem` y la
 * migración 021_whatsapp_config_sistema_lectura.sql, que documenta este
 * caller como "preexistente, fuera de alcance" de esa tarea): la variante de
 * STAFF (`resolveActiveWhatsAppPhoneNumberId`, SELECT plano contra
 * `citas.whatsapp_config`, policy de RLS solo de staff) SIEMPRE devolvía 0
 * filas bajo `auth.uid()` null -- el aviso de crisis al dueño/staff NUNCA
 * salía contra Postgres real, con o sin la migración 021 ya aplicada (la
 * escalación SÍ quedaba registrada en `citas.emergency_escalations`, que no
 * tiene este gap -- solo el aviso adicional de WhatsApp se perdía en
 * silencio).
 */
async function notifyOwnerOfEscalation(repo: CitasRepository, organizationId: string, ownerNotificationPhone: string | null, escalationId: string, keyword: string, customerPhone: string, channel: "whatsapp" | "voice" = "whatsapp"): Promise<void> {
  if (!ownerNotificationPhone) return;
  const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberIdAsSystem(organizationId);
  if (!phoneNumberId) return;

  await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "crisis.escalated", `crisis:${escalationId}`, {
    to: ownerNotificationPhone,
    phone_number_id: phoneNumberId,
    body:
      channel === "voice"
        ? `🆘 CRISIS DETECTADA\nUn cliente (${customerPhone}) mostró señales de crisis en una LLAMADA ("${keyword}"). Contáctelo lo antes posible.`
        : `🆘 CRISIS DETECTADA\nUn cliente (${customerPhone}) escribió un mensaje con señales de crisis ("${keyword}"). Contáctelo lo antes posible.`,
  });
}

export interface EntradaEscalacionCrisis {
  readonly customerPhone: string;
  readonly channel: "whatsapp" | "voice";
  readonly keyword: string;
  /** Fragmento del mensaje (WhatsApp). En voz va vacío: no se guarda la transcripción. */
  readonly excerpt: string;
}

/**
 * Registro de UNA escalación de crisis (compartido por WhatsApp y voz): fila en `citas.emergency_escalations` (que emite la notificación in-app
 * crítica), handoff pendiente si hay conversación (C-11; en voz no la hay y el puerto devuelve null) y aviso best-effort al dueño/staff.
 * El llamador ya decidió que es una crisis (la detección es determinista y vive en cada canal).
 */
export async function registrarEscalacionCrisis(
  repo: CitasRepository,
  organizationId: string,
  ownerNotificationPhone: string | null,
  entrada: EntradaEscalacionCrisis,
  handoffGate?: HandoffAgentGate,
): Promise<{ readonly escalationId: string }> {
  const escalation = await repo.insertEmergencyEscalation({
    organizationId,
    customerPhone: entrada.customerPhone,
    channel: entrada.channel,
    keywordMatched: entrada.keyword,
    messageExcerpt: entrada.excerpt,
  });

  // C-11 -- la escalacion abre un handoff (pendiente, marcado como crisis) para que una persona tome la conversacion y el agente deje de
  // responder; el motivo es texto fijo (sin la palabra clave ni el mensaje). Sin puerto, o con la base sin migrar, no hace nada: la
  // escalacion de arriba ya quedo registrada y el comportamiento es el de siempre.
  await handoffGate?.solicitarHumano({ organizationId, phone: entrada.customerPhone, motivo: "Escalación de crisis: un cliente necesita atención humana.", crisis: true });

  await notifyOwnerOfEscalation(repo, organizationId, ownerNotificationPhone, escalation.id, entrada.keyword, entrada.customerPhone, entrada.channel);
  return { escalationId: escalation.id };
}

/**
 * Si el rubro del tenant requiere el guardrail y el mensaje trae una palabra clave
 * real de crisis: registra la escalación, intenta avisar al dueño, y regresa el
 * mensaje de crisis a devolver AL CLIENTE TAL CUAL — sin pasar por el LLM, nunca
 * reformulado ni resumido.
 */
export async function runCrisisGuardrail(repo: CitasRepository, organizationId: string, customerPhone: string, customerMessage: string, handoffGate?: HandoffAgentGate): Promise<CrisisGuardrailResult> {
  const tenantConfig = await repo.findTenantConfig(organizationId);
  // Sin configuración o con el rubro por defecto ('otro') la guardia SIGUE activa: un negocio de salud que no eligió su rubro no queda sin ella.
  if (!crisisGuardActivaPara(tenantConfig?.rubro)) return { triggered: false };

  const keyword = detectCrisisKeyword(customerMessage);
  if (!keyword) return { triggered: false };

  const { escalationId } = await registrarEscalacionCrisis(
    repo,
    organizationId,
    tenantConfig?.ownerNotificationPhone ?? null,
    { customerPhone, channel: "whatsapp", keyword, excerpt: (customerMessage ?? "").slice(0, 300) },
    handoffGate,
  );

  return { triggered: true, reply: CRISIS_ESCALATION_MESSAGE, escalationId };
}
