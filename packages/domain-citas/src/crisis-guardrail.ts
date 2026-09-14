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
// Aplica hoy solo al canal de WhatsApp (whatsapp/inbound.ts) — el agente de voz de
// ElevenLabs corre su propio loop de conversación fuera de este repo y no pasa por
// aquí (mismo alcance que el origen).
import type { CitasRepository } from "./repository.ts";
import { CRISIS_ESCALATION_MESSAGE, detectCrisisKeyword, requiresCrisisGuardrail } from "./vertical-config.ts";

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
 */
async function notifyOwnerOfEscalation(repo: CitasRepository, organizationId: string, ownerNotificationPhone: string | null, escalationId: string, keyword: string, customerPhone: string): Promise<void> {
  if (!ownerNotificationPhone) return;
  const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberId(organizationId);
  if (!phoneNumberId) return;

  await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "crisis.escalated", `crisis:${escalationId}`, {
    to: ownerNotificationPhone,
    phone_number_id: phoneNumberId,
    body: `🆘 CRISIS DETECTADA\nUn cliente (${customerPhone}) escribió un mensaje con señales de crisis ("${keyword}"). Contáctelo lo antes posible.`,
  });
}

/**
 * Si el rubro del tenant requiere el guardrail y el mensaje trae una palabra clave
 * real de crisis: registra la escalación, intenta avisar al dueño, y regresa el
 * mensaje de crisis a devolver AL CLIENTE TAL CUAL — sin pasar por el LLM, nunca
 * reformulado ni resumido.
 */
export async function runCrisisGuardrail(repo: CitasRepository, organizationId: string, customerPhone: string, customerMessage: string): Promise<CrisisGuardrailResult> {
  const tenantConfig = await repo.findTenantConfig(organizationId);
  if (!tenantConfig || !requiresCrisisGuardrail(tenantConfig.rubro)) return { triggered: false };

  const keyword = detectCrisisKeyword(customerMessage);
  if (!keyword) return { triggered: false };

  const escalation = await repo.insertEmergencyEscalation({
    organizationId,
    customerPhone,
    channel: "whatsapp",
    keywordMatched: keyword,
    messageExcerpt: (customerMessage ?? "").slice(0, 300),
  });

  await notifyOwnerOfEscalation(repo, organizationId, tenantConfig.ownerNotificationPhone, escalation.id, keyword, customerPhone);

  return { triggered: true, reply: CRISIS_ESCALATION_MESSAGE, escalationId: escalation.id };
}
