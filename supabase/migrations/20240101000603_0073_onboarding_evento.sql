-- Onboarding P0: hitos de onboarding que NO dejan fila en ninguna tabla de negocio, guardados como evento verificable.
--
-- Problema: el checklist de onboarding es DERIVADO de datos reales (packages/domain-restaurantes/src/onboarding.ts), pero «Probar el
-- agente» no persiste nada por diseño (apps/api/src/routes/verticals/restaurantes/agente-preview.ts: la conversacion de prueba no toca
-- pedidos, clientes ni conversaciones). Sin rastro, el paso no se podia verificar ni medir (investigacion A §1.5-3).
--
-- Que agrega (aditivo, schema core; diseño de la investigacion A §4 «core.onboarding_evento», reducido a lo que hoy se escribe):
--   A) core.onboarding_evento: un hito por (organizacion, vertical, tipo, sucursal). Lista cerrada de tipos.
--   B) core.registrar_onboarding_evento(...): UNICO camino de escritura (idempotente: on conflict do nothing).
--   C) Lectura: RLS de SELECT para owner/admin de la organizacion.
--
-- Justificacion de seguridad:
--   * Tabla con RLS habilitada. GRANT SELECT a authenticated con policy acotada a miembros owner/admin (platform_role) de la organizacion:
--     un staff/repartidor no lo necesita y otra organizacion nunca lo ve. Sin GRANT de INSERT/UPDATE/DELETE a nadie (ni a anon): la unica
--     escritura es la funcion B. Sin datos personales: `detalle` es jsonb de conteos/ids que escribe el servidor.
--   * B: security definer, `set search_path = core, pg_temp`, `revoke all from public, anon`, execute solo a authenticated. Dos caminos:
--       - sesion de staff (auth.uid() no nulo): el caller debe ser miembro owner/admin de ESA organizacion (si no, 42501), y la sucursal,
--         si se indica, debe ser de esa organizacion (22023). El actor se toma de auth.uid(), nunca de un parametro.
--       - sesion de sistema (auth.uid() nulo): para crons/servidor; actor nulo.
--     Tipo fuera de la lista cerrada o vertical distinta a la de la organizacion: 22023. Organizacion inexistente: P0002.

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Tabla
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists core.onboarding_evento (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  vertical        text not null check (vertical in ('hoteles','restaurantes','rentas','licitaciones','citas','despachos')),
  tipo            text not null check (tipo in (
                    'prueba_agente_whatsapp',   -- la prueba del agente llego a un pedido/cita/reserva simulado
                    'prueba_voz',
                    'celebracion_listo_vista',
                    'celebracion_primer_valor')),
  property_id     uuid references core.property(id) on delete cascade,
  actor_user_id   uuid,
  detalle         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create unique index if not exists onboarding_evento_unico
  on core.onboarding_evento (organization_id, vertical, tipo, coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid));

alter table core.onboarding_evento enable row level security;

-- Lectura: solo owner/admin de la organizacion (mismo umbral que el checklist de onboarding de la API).
drop policy if exists onboarding_evento_select_owner_admin on core.onboarding_evento;
create policy onboarding_evento_select_owner_admin on core.onboarding_evento
  for select to authenticated
  using (exists (
    select 1 from core.membership m
    where m.organization_id = onboarding_evento.organization_id
      and m.user_id = auth.uid()
      and m.platform_role in ('owner', 'admin')
  ));
revoke all on core.onboarding_evento from public, anon, authenticated;
grant select on core.onboarding_evento to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Escritura (unico camino)
-- ═══════════════════════════════════════════════════════════════════════════
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
