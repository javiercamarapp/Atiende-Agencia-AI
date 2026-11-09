-- Reversa manual de packages/db/migrations/0078_onboarding_evento_metodos_pago.sql (ver docs/ROLLBACK.md): regresa la lista cerrada de
-- tipos de core.onboarding_evento a la de 0073. Borra antes las filas del tipo nuevo (solo eran confirmaciones del checklist de alta).
delete from core.onboarding_evento where tipo = 'metodos_pago_confirmados';
alter table core.onboarding_evento drop constraint if exists onboarding_evento_tipo_check;
alter table core.onboarding_evento add constraint onboarding_evento_tipo_check check (tipo in (
  'prueba_agente_whatsapp', 'prueba_voz', 'celebracion_listo_vista', 'celebracion_primer_valor'));

create or replace function core.registrar_onboarding_evento(
  p_organization_id uuid,
  p_vertical text,
  p_tipo text,
  p_property_id uuid default null,
  p_detalle jsonb default '{}'::jsonb
)
returns boolean
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_vertical text;
  v_insertadas integer;
begin
  select o.vertical into v_vertical from core.organization o where o.id = p_organization_id;
  if v_vertical is null then
    raise exception 'registrar_onboarding_evento: organizacion no encontrada' using errcode = 'P0002';
  end if;
  if auth.uid() is not null and not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = auth.uid() and m.platform_role in ('owner', 'admin')
  ) then
    raise exception 'registrar_onboarding_evento: solo owner/admin de la organizacion' using errcode = '42501';
  end if;
  if p_vertical is distinct from v_vertical then
    raise exception 'registrar_onboarding_evento: la vertical no corresponde a la organizacion' using errcode = '22023';
  end if;
  if p_tipo is null or p_tipo not in ('prueba_agente_whatsapp', 'prueba_voz', 'celebracion_listo_vista', 'celebracion_primer_valor') then
    raise exception 'registrar_onboarding_evento: tipo fuera de la lista cerrada' using errcode = '22023';
  end if;
  if p_property_id is not null and not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
    raise exception 'registrar_onboarding_evento: la sucursal no pertenece a la organizacion' using errcode = '22023';
  end if;
  if p_detalle is null or jsonb_typeof(p_detalle) <> 'object' or pg_column_size(p_detalle) > 2048 then
    raise exception 'registrar_onboarding_evento: detalle invalido' using errcode = '22023';
  end if;

  insert into core.onboarding_evento (organization_id, vertical, tipo, property_id, actor_user_id, detalle)
  values (p_organization_id, v_vertical, p_tipo, p_property_id, auth.uid(), p_detalle)
  on conflict do nothing;
  get diagnostics v_insertadas = row_count;
  return v_insertadas > 0;
end;
$$;
revoke all on function core.registrar_onboarding_evento(uuid, text, text, uuid, jsonb) from public, anon;
grant execute on function core.registrar_onboarding_evento(uuid, text, text, uuid, jsonb) to authenticated;
