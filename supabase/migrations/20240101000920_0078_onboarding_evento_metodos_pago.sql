-- Alta autoservicio («primer valor en <30 min»): el dueño CONFIRMA los metodos de pago con los que cobra su sucursal. Es un hito que no
-- deja fila en ninguna tabla de negocio (no hay configuracion de metodos de pago por sucursal: el agente cobra en efectivo o con tarjeta
-- llevando terminal, reglas fijas de agent-tools/cierre-maquina.ts), asi que se registra en core.onboarding_evento (0073) como
-- 'metodos_pago_confirmados', por sucursal.
--
-- Que cambia (aditivo):
--   * CHECK de core.onboarding_evento.tipo: agrega 'metodos_pago_confirmados' (los demas valores no cambian).
--   * core.registrar_onboarding_evento: MISMA firma, mismo cuerpo y mismos permisos que 0073; solo la lista cerrada de tipos crece.
--
-- Justificacion de seguridad: no hay tablas, policies ni GRANT nuevos. create or replace conserva security definer, el search_path fijo
-- y los permisos de 0073 (se reafirman abajo): owner/admin de la organizacion o sesion de sistema; staff, otra organizacion y anon no.
--
-- Rollback: scripts/rollback/migraciones/0078_onboarding_evento_metodos_pago.down.sql (borra las filas del tipo nuevo y regresa el CHECK
-- y la funcion a la lista de 0073).

alter table core.onboarding_evento drop constraint if exists onboarding_evento_tipo_check;
alter table core.onboarding_evento add constraint onboarding_evento_tipo_check check (tipo in (
  'prueba_agente_whatsapp', 'prueba_voz', 'celebracion_listo_vista', 'celebracion_primer_valor', 'metodos_pago_confirmados'));

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
  if p_tipo is null or p_tipo not in ('prueba_agente_whatsapp', 'prueba_voz', 'celebracion_listo_vista', 'celebracion_primer_valor', 'metodos_pago_confirmados') then
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
