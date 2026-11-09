-- Copiloto «Pregúntale a tus datos»: VALORACION de cada respuesta («Útil» / «No fue útil» con motivo opcional).
--
-- Que agrega (todo aditivo; ninguna tabla ni funcion existente cambia):
--   1. core.data_chat_feedback: una fila por (mensaje del asistente, persona). La persona la crea y la cambia (upsert); nadie mas la ve.
--   2. core.data_chat_feedback_resumen(org, desde): conteos agregados de SU organizacion para owner/admin (sin quien ni que pregunto).
--   3. core.superadmin_data_chat_feedback_resumen(caller, desde): conteos por vertical y organizacion para el back office.
--
-- Que se guarda: SOLO si fue util, un motivo de una lista cerrada (sin texto libre: cero PII) y la referencia al mensaje guardado
-- (conversacion + seq). Nunca la pregunta ni la respuesta: ya viven en core.data_chat_message, que solo lee su autor.
--
-- Compatibilidad con la base SIN migrar: nada existente depende de esto. El TypeScript (apps/api/src/data-chat/valoraciones.ts) corre cada
-- acceso en SAVEPOINT y ante 42P01/42883/42703 responde «no disponible aun» (503 en el POST, `disponible: false` en los resumenes).
--
-- Requiere: 0001 (core.organization, core.staff_user, core.membership), 0012 (core.is_platform_superadmin), 0041 (conversaciones).
--
-- ROLLBACK (si hiciera falta revertir; los datos de valoracion se pierden, nada mas depende de ellos):
--   drop function if exists core.superadmin_data_chat_feedback_resumen(uuid, timestamptz);
--   drop function if exists core.data_chat_feedback_resumen(uuid, timestamptz);
--   drop table if exists core.data_chat_feedback;
--
-- JUSTIFICACION DE SEGURIDAD (cada GRANT, policy y funcion nueva):
--   * RLS activa y `revoke all` a public/anon/authenticated/service_role. `anon` no recibe nada.
--   * GRANT `select` a authenticated: la policy deja leer SOLO las filas propias (user_id = auth.uid()); hace falta para el upsert
--     (`on conflict do update` lee la fila en conflicto). Un owner/admin NO lee filas sueltas de su staff: solo el agregado de la funcion.
--   * GRANT `insert` por COLUMNA (sin created_at/updated_at) y `update (util, motivo, updated_at)` por COLUMNA: no se puede mover una
--     valoracion a otro mensaje, persona u organizacion. Las policies de insert/update exigen user_id = auth.uid() y que el mensaje sea del
--     ASISTENTE en una conversacion PROPIA de la misma organizacion y vertical; el subselect corre con la RLS de 0041 (autor + membresia
--     vigente o superadmin para plataforma), asi que un mensaje ajeno o de otra organizacion es invisible y la escritura falla (42501).
--   * Sin `delete` para nadie: una valoracion se cambia, no se borra (cae sola con ON DELETE CASCADE si se borra la conversacion).
--   * Las dos funciones son security definer (leen filas ajenas para contarlas) con `set search_path = core, pg_temp` fijo y `revoke ... from
--     public, anon`; solo `authenticated` ejecuta. La de organizacion exige actor (28000) con membresia owner/admin de ESA organizacion
--     (42501); la de superadmin exige auth.uid() = p_caller_id y superadmin vigente (42501). Devuelven solo conteos.
-- ---------------------------------------------------------------------------

create table core.data_chat_feedback (
  conversation_id uuid not null,
  seq integer not null,
  user_id uuid not null references core.staff_user(id) on delete cascade,
  -- null solo con vertical 'plataforma' (Copiloto de superadmin), igual que core.data_chat_conversation.
  organization_id uuid references core.organization(id) on delete cascade,
  vertical text not null check (vertical in ('restaurantes', 'hoteles', 'rentas', 'despachos', 'licitaciones', 'citas', 'plataforma')),
  util boolean not null,
  motivo text check (motivo is null or motivo in ('dato_incorrecto', 'incompleta', 'no_entendio', 'otro')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (conversation_id, seq, user_id),
  foreign key (conversation_id, seq) references core.data_chat_message (conversation_id, seq) on delete cascade,
  -- El motivo solo acompaña a «No fue útil».
  check (util = false or motivo is null),
  check ((vertical = 'plataforma') = (organization_id is null))
);

create index data_chat_feedback_org_idx on core.data_chat_feedback (organization_id, created_at desc);
create index data_chat_feedback_creado_idx on core.data_chat_feedback (created_at desc);

alter table core.data_chat_feedback enable row level security;

create policy "autor lee su valoracion del copiloto" on core.data_chat_feedback for select
  using (user_id = auth.uid());

create policy "autor valora una respuesta de su conversacion" on core.data_chat_feedback for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1
        from core.data_chat_message m
        join core.data_chat_conversation c on c.id = m.conversation_id
       where m.conversation_id = data_chat_feedback.conversation_id
         and m.seq = data_chat_feedback.seq
         and m.role = 'assistant'
         and c.user_id = auth.uid()
         and c.organization_id is not distinct from data_chat_feedback.organization_id
         and c.vertical = data_chat_feedback.vertical)
  );

create policy "autor cambia su valoracion del copiloto" on core.data_chat_feedback for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1
        from core.data_chat_message m
        join core.data_chat_conversation c on c.id = m.conversation_id
       where m.conversation_id = data_chat_feedback.conversation_id
         and m.seq = data_chat_feedback.seq
         and m.role = 'assistant'
         and c.user_id = auth.uid()
         and c.organization_id is not distinct from data_chat_feedback.organization_id
         and c.vertical = data_chat_feedback.vertical)
  );

revoke all on core.data_chat_feedback from public, anon, authenticated, service_role;
grant select on core.data_chat_feedback to authenticated;
grant insert (conversation_id, seq, user_id, organization_id, vertical, util, motivo) on core.data_chat_feedback to authenticated;
grant update (util, motivo, updated_at) on core.data_chat_feedback to authenticated;

-- ---------------------------------------------------------------------------
-- Agregado de UNA organizacion (owner/admin). `p_desde` null = ultimos 30 dias.
-- ---------------------------------------------------------------------------
create or replace function core.data_chat_feedback_resumen(p_organization_id uuid, p_desde timestamptz)
returns table (vertical text, util boolean, motivo text, total bigint)
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'data_chat_feedback_resumen: sin actor' using errcode = '28000';
  end if;
  if not exists (
    select 1 from core.membership m
     where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.platform_role in ('owner', 'admin')
  ) then
    raise exception 'data_chat_feedback_resumen: solo owner/admin de la organizacion' using errcode = '42501';
  end if;
  return query
    select f.vertical, f.util, f.motivo, count(*)::bigint
      from core.data_chat_feedback f
     where f.organization_id = p_organization_id
       and f.created_at >= coalesce(p_desde, now() - interval '30 days')
     group by f.vertical, f.util, f.motivo
     order by f.vertical, f.util desc, f.motivo nulls first;
end;
$$;

revoke all on function core.data_chat_feedback_resumen(uuid, timestamptz) from public, anon;
grant execute on function core.data_chat_feedback_resumen(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Agregado de PLATAFORMA (superadmin): por vertical y organizacion. `p_desde` null = ultimos 30 dias.
-- ---------------------------------------------------------------------------
create or replace function core.superadmin_data_chat_feedback_resumen(p_caller_id uuid, p_desde timestamptz)
returns table (vertical text, organization_id uuid, organization_name text, util boolean, motivo text, total bigint)
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    raise exception 'superadmin_data_chat_feedback_resumen: solo superadmin' using errcode = '42501';
  end if;
  return query
    select f.vertical, f.organization_id, o.name, f.util, f.motivo, count(*)::bigint
      from core.data_chat_feedback f
      left join core.organization o on o.id = f.organization_id
     where f.created_at >= coalesce(p_desde, now() - interval '30 days')
     group by f.vertical, f.organization_id, o.name, f.util, f.motivo
     order by f.vertical, o.name nulls first, f.util desc, f.motivo nulls first;
end;
$$;

revoke all on function core.superadmin_data_chat_feedback_resumen(uuid, timestamptz) from public, anon;
grant execute on function core.superadmin_data_chat_feedback_resumen(uuid, timestamptz) to authenticated;
