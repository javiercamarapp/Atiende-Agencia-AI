-- C-16 (citas) -- Centro de avisos: seguimiento de escalaciones de crisis y resumen de avisos para el productor de
-- notificaciones in-app. Prefijo de supabase/migrations asignado: 20240101000267 (interno 029).
--
-- Que resuelve:
--   * Las escalaciones de crisis (citas.emergency_escalations, 007) se registran pero nadie las ve ni las cierra:
--     el panel no tenia donde mostrarlas y no habia forma de saber si alguien ya atendio al cliente. Esta migracion
--     agrega el SEGUIMIENTO (pendiente / en seguimiento / resuelta, quien y cuando, nota corta) y la unica funcion
--     que lo escribe.
--   * El cron de recordatorios necesita contar "por confirmar", recordatorios agotados (dead) y escalaciones sin
--     seguimiento para emitir UNA notificacion por categoria (core.emit_notification, 0039). Esas tablas no son
--     legibles por la sesion de sistema con RLS plana (mismo hueco que 020/021), asi que se agrega UNA funcion de
--     solo-sistema que devuelve unicamente conteos.
--
-- Decision de compatibilidad: solo se agregan objetos NUEVOS y columnas con default; nada existente se reemplaza.
-- El codigo TypeScript que los usa corre dentro de un SAVEPOINT y, con la base sin migrar (42883/42P01/42703),
-- responde "seguimiento no disponible aun" y NO emite avisos, sin abortar la transaccion del request. Nada de
-- esto se aplica al mergear.
--
-- Justificacion de seguridad (cada columna, funcion y GRANT trae su razon):
--  * Columnas follow_up_*: citas.emergency_escalations conserva RLS habilitada con SOLO la policy de SELECT para
--    miembros (007) y `grant select` a authenticated / `select, insert` a service_role. NO se otorga UPDATE ni
--    GRANT de columna a authenticated: el seguimiento se escribe unicamente por la funcion security definer de
--    abajo, que solo toca estas 4 columnas (el resto de la fila, incluido el telefono y el extracto, sigue
--    siendo inmutable para el panel). Nada se otorga a anon. Los CHECK viven en la base (estado cerrado, nota
--    <= 500 caracteres). follow_up_by referencia core.staff_user con ON DELETE SET NULL: borrar a la persona no
--    borra la evidencia de que hubo seguimiento.
--  * citas.set_escalation_follow_up: security definer, `set search_path = citas, core, pg_temp`, `revoke all`
--    de public y anon, EXECUTE solo para authenticated. La autorizacion esta DENTRO: exige auth.uid() no nulo
--    (la sesion de sistema obtiene 42501) y que el actor sea owner/admin (vertical_role) de la organizacion
--    pedida (los telefonos y mensajes de crisis son datos de salud: mismo criterio que ARCO y que
--    data_chat_reminder_delivery). El actor SIEMPRE sale de auth.uid(), nunca de un parametro. Una escalacion de
--    otra organizacion responde "no existe" (P0002), sin confirmar que existe. Solo admite los estados
--    'in_progress' y 'resolved'; la nota se recorta con left(...) dentro de la funcion.
--  * citas.system_avisos_resumen: security definer, `set search_path = citas, pg_temp`, `revoke all` de public y
--    anon, EXECUTE solo para authenticated (el rol bajo el que corre la sesion de sistema del cron, igual que
--    system_load_live_waitlist_candidates en 020; service_role no la necesita). Funcion de SOLO-SISTEMA: si
--    auth.uid() no es nulo lanza 42501, de modo que un staff autenticado no puede usarla para leer conteos de
--    otra organizacion. Solo devuelve 4 numeros de la organizacion pedida (nunca destinatarios, cuerpos, ids ni
--    telefonos). Es de solo lectura (stable).
alter table citas.emergency_escalations
  add column follow_up_status text not null default 'pending' check (follow_up_status in ('pending', 'in_progress', 'resolved')),
  add column follow_up_by uuid references core.staff_user(id) on delete set null,
  add column follow_up_at timestamptz,
  add column follow_up_note text check (follow_up_note is null or char_length(follow_up_note) <= 500);

create index emergency_escalations_org_follow_up_idx
  on citas.emergency_escalations (organization_id, follow_up_status, created_at desc);

create or replace function citas.set_escalation_follow_up(
  p_organization_id uuid,
  p_escalation_id uuid,
  p_status text,
  p_note text default null
) returns table (out_id uuid, out_status text, out_at timestamptz)
language plpgsql
security definer
set search_path = citas, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_note text := nullif(btrim(left(coalesce(p_note, ''), 500)), '');
begin
  if v_actor is null then
    raise exception 'set_escalation_follow_up requiere un usuario autenticado' using errcode = '42501';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = v_actor and m.vertical_role in ('owner', 'admin')
  ) then
    raise exception 'solo owner/admin pueden dar seguimiento a una escalacion' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('in_progress', 'resolved') then
    raise exception 'estado de seguimiento invalido' using errcode = '22023';
  end if;

  return query
  update citas.emergency_escalations e
     set follow_up_status = p_status,
         follow_up_by = v_actor,
         follow_up_at = now(),
         follow_up_note = v_note
   where e.id = p_escalation_id and e.organization_id = p_organization_id
  returning e.id, e.follow_up_status, e.follow_up_at;

  if not found then
    raise exception 'escalacion no encontrada' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function citas.set_escalation_follow_up(uuid, uuid, text, text) from public, anon;
grant execute on function citas.set_escalation_follow_up(uuid, uuid, text, text) to authenticated;

create or replace function citas.system_avisos_resumen(p_organization_id uuid)
returns table (
  por_confirmar bigint,
  recordatorios_agotados bigint,
  ultimo_agotado_epoch bigint,
  escalaciones_sin_seguimiento bigint
)
language plpgsql
stable
security definer
set search_path = citas, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_avisos_resumen es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
  select
    -- Citas pendientes (sin confirmar) que empiezan en las proximas 48 h.
    (select count(*) from citas.appointments a
      where a.organization_id = p_organization_id and a.status = 'pending'
        and a.starts_at > now() and a.starts_at <= now() + interval '48 hours'),
    -- Recordatorios de 24 h que agotaron sus reintentos (estado 'dead') en las ultimas 48 h.
    (select count(*) from citas.messaging_outbox o
      where o.organization_id = p_organization_id and o.event_type = 'appointment.reminder_24h' and o.status = 'dead'
        and o.created_at > now() - interval '48 hours'),
    -- Instante del ultimo agotado: el productor lo usa como clave de dedupe para avisar solo cuando aparece uno NUEVO.
    (select floor(extract(epoch from max(o.created_at)))::bigint from citas.messaging_outbox o
      where o.organization_id = p_organization_id and o.event_type = 'appointment.reminder_24h' and o.status = 'dead'
        and o.created_at > now() - interval '48 hours'),
    -- Escalaciones de crisis que llevan mas de 1 hora sin que nadie las tome.
    (select count(*) from citas.emergency_escalations e
      where e.organization_id = p_organization_id and e.follow_up_status = 'pending'
        and e.created_at < now() - interval '1 hour');
end;
$$;

revoke all on function citas.system_avisos_resumen(uuid) from public, anon;
grant execute on function citas.system_avisos_resumen(uuid) to authenticated;
