-- Fase 3 del hallazgo de seguridad "caller binding" (ver `packages/db/migrations/
-- 0017_caller_binding_fase3.sql` para el resumen completo de la clase de hallazgo, y
-- `scripts/verify-caller-binding-fase2/README.md` -- sección "Fuera de alcance" --
-- donde quedó documentado este hallazgo concreto en la Fase 2).
--
-- `hoteles.record_fraude_audit_log` (`017_fraude_audit_log.sql`) es `security
-- definer` con `grant execute ... to authenticated`, y recibe `p_organization_id`/
-- `p_property_id`/`p_actor_user_id` explícitos sin atarlos a `auth.uid()` -- un
-- `authenticated` cualquiera podría, por RPC directo, insertar una entrada de
-- bitácora de fraude FALSA en CUALQUIER property, atribuida a CUALQUIER actor.
--
-- Call-site-audit (verificado contra el código real de esta rama): su ÚNICO
-- caller de producción es `ProductionHotelesFraudeAuditSink.record`
-- (`apps/api/src/production/hoteles-fraude-audit-sink.ts`), que abre SIEMPRE
-- `engine.withAppSession({ userId: null })` -- sesión de SISTEMA, `auth.uid()`
-- NULL -- el actor real llega como `entry.actorUserId`, ya resuelto por la capa
-- TS. Clase B (sistema): MISMO guard/patrón que `despachos.record_audit_log`
-- (`packages/domain-despachos/migrations/010_despachos_caller_binding_fase3.sql`)
-- y `core.revoke_refresh_token`. Sin cambio de TypeScript: el único call site ya
-- corre así hoy.
--
-- NOTA de alcance: esta migración toca ÚNICAMENTE `hoteles.record_fraude_audit_
-- log` -- nada de `packages/domain-hoteles/src/*` ni del cron de night-audit
-- (reservado a otro agente en paralelo, prefijos `...000143`/`...000146`).
create or replace function hoteles.record_fraude_audit_log(
  p_organization_id uuid,
  p_property_id uuid,
  p_actor_user_id uuid,
  p_action text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = hoteles, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'record_fraude_audit_log: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;

  insert into hoteles.fraude_audit_log (organization_id, property_id, actor_user_id, action, payload)
  values (p_organization_id, p_property_id, p_actor_user_id, p_action, coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function hoteles.record_fraude_audit_log(uuid, uuid, uuid, text, jsonb) from public;
grant execute on function hoteles.record_fraude_audit_log(uuid, uuid, uuid, text, jsonb) to authenticated;
