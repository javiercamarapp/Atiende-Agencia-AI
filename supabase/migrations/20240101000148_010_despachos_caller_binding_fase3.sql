-- Fase 3 del hallazgo de seguridad "caller binding" (ver `packages/db/migrations/
-- 0017_caller_binding_fase3.sql` para el resumen completo de la clase de hallazgo, y
-- `scripts/verify-caller-binding-fase2/README.md` -- sección "Fuera de alcance" --
-- donde quedó documentado este hallazgo concreto en la Fase 2).
--
-- `despachos.record_audit_log` (`008_despachos_audit_log.sql`) es `security
-- definer` con `grant execute ... to authenticated`, y recibe `p_organization_id`/
-- `p_actor_user_id` explícitos sin atarlos a `auth.uid()` -- un `authenticated`
-- cualquiera podría, por RPC directo, insertar una entrada de bitácora FALSA en la
-- auditoría de CUALQUIER organización, atribuida a CUALQUIER actor (bypass total de
-- "quién hizo qué").
--
-- Call-site-audit (verificado contra el código real de esta rama, no solo
-- sospechado): su ÚNICO caller de producción es `ProductionDespachosAuditSink.
-- record` (`apps/api/src/production/despachos-audit-sink.ts`), que abre SIEMPRE
-- `engine.withAppSession({ userId: null })` -- sesión de SISTEMA, `auth.uid()`
-- NULL -- el actor real llega como `entry.actorUserId`, un dato que la propia
-- capa TS ya resolvió (nunca algo que este SQL pudiera re-derivar de una sesión
-- que no existe). Clase B (sistema): el guard correcto es "solo sesión de
-- sistema" -- MISMO patrón exacto que `core.revoke_refresh_token`
-- (`packages/db/migrations/0012_caller_binding_fase2.sql`). Sin cambio de
-- TypeScript: el único call site ya corre así hoy.
create or replace function despachos.record_audit_log(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_action text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'record_audit_log: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;

  insert into despachos.audit_log (organization_id, actor_user_id, action, payload)
  values (p_organization_id, p_actor_user_id, p_action, coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function despachos.record_audit_log(uuid, uuid, text, jsonb) from public;
grant execute on function despachos.record_audit_log(uuid, uuid, text, jsonb) to authenticated;
