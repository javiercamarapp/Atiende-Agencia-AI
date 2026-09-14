-- Fase 6 §1 — guardia de crisis para verticales de salud (medico/dental/
-- psicologo/veterinaria, ver `citas.tenant_config.rubro` de 001_citas_schema.sql,
-- que ya modela exactamente el mismo conjunto de rubros que
-- citas-reservaciones/supabase/functions/_shared/vertical-config.ts). Port de
-- `emergency_escalations` (20260908050000_vertical_config_and_agenda_agents.sql del
-- origen) — registro real, append-only, de cada mensaje de crisis detectado por el
-- guardrail determinista (ver domain-citas/src/crisis-guardrail.ts), NUNCA algo que
-- el LLM decide escribir.
--
-- `owner_notification_phone` NO se agrega aquí — ya existe en
-- `citas.tenant_config` desde 001_citas_schema.sql (el origen del guardrail real de
-- atiende.ai ya lo modeló como parte de la config general del tenant).

create table citas.emergency_escalations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  customer_phone text not null check (length(customer_phone) between 1 and 64),
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'voice')),
  keyword_matched text not null check (length(keyword_matched) between 1 and 120),
  message_excerpt text not null check (length(message_excerpt) <= 300),
  created_at timestamptz not null default now()
);
create index emergency_escalations_org_created_idx
  on citas.emergency_escalations (organization_id, created_at desc);

alter table citas.emergency_escalations enable row level security;

-- Solo lectura para staff de la organización — la inserción SIEMPRE la hace el
-- guardrail server-side (sesión de sistema, sin auth.uid(), mismo criterio que
-- appointments/customers vía las rutas "de sistema" del canal de WhatsApp/voz).
create policy "staff ve escalaciones de crisis de su organización" on citas.emergency_escalations for select
  using (exists (select 1 from core.membership m where m.organization_id = emergency_escalations.organization_id and m.user_id = auth.uid()));

revoke all on citas.emergency_escalations from public, anon;
grant select on citas.emergency_escalations to authenticated;
grant select, insert on citas.emergency_escalations to service_role;
