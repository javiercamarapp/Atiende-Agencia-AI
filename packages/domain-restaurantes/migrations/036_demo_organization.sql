-- R-19/R-20: marca de organizacion DEMO (`is_demo`). Prefijo de supabase/migrations asignado para esta tarea:
-- 20240101000253 (interno 036).
--
-- Una organizacion demo es una cuenta de demostracion (p. ej. "Los Taquitos de PM" cargada por
-- scripts/seed-pm-demo) que se puede presentar a un cliente SIN credenciales de Meta/Twilio/ElevenLabs/SoftRestaurant.
-- Esta marca cumple tres funciones y ninguna mas:
--   1. El widget publico de chat (/v1/restaurantes/demo/:orgSlug/*) solo atiende organizaciones marcadas aqui: una
--      organizacion real NUNCA se puede alcanzar por esa ruta aunque alguien adivine su slug.
--   2. El seed de volumen y el script de limpieza solo escriben/borran sobre organizaciones marcadas aqui (la
--      limpieza se niega a tocar una organizacion sin marca).
--   3. `activo = false` apaga el widget publico de esa demo sin borrar nada (se cambia por SQL, ver docs/DEMO-PM-CARGA.md).
--
-- Decision de diseno: tabla NUEVA del esquema `restaurantes`, no modifica `core.organization` ni nada existente. El
-- codigo TypeScript que la lee degrada con SAVEPOINT a "esta organizacion no es demo" (widget no disponible) cuando la
-- base todavia no la tiene (SQLSTATE 42P01/42703/42501): nada de esto se aplica al mergear.
--
-- Justificacion de seguridad de cada GRANT / policy (una por una):
--  * RLS habilitado y `revoke all ... from public, anon`: `anon` no tiene NINGUN acceso.
--  * SELECT para `authenticated`: policy `auth.uid() is null or <staff de la organizacion>`. La rama `auth.uid() is null`
--    es la sesion de SISTEMA del widget publico (sin usuario), que solo necesita saber si una organizacion es demo;
--    mismo escape hatch que `branch_policy` (023), `whatsapp_agent_config` (029) y `known_zone` (016). La tabla no guarda
--    PII, credenciales ni secretos (solo la version del seed y dos banderas).
--  * SIN INSERT/UPDATE/DELETE para ningun rol de la aplicacion: la marca la escribe unicamente quien carga el seed con la
--    cadena de conexion del propietario de la base (un operador, nunca un request). Un owner de cualquier organizacion no
--    puede marcarse como demo ni quitar la marca de otra: ni siquiera de la suya. No hay funcion SECURITY DEFINER aqui.
--  * `service_role` solo lee (para el panel de plataforma); no escribe.
create table restaurantes.demo_organization (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  -- Version de los datos del seed que la creo (trazabilidad; no se usa para decidir nada).
  seed_version text not null check (char_length(seed_version) between 1 and 60),
  -- false = el widget publico de esta demo responde "no disponible" (interruptor del operador).
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

alter table restaurantes.demo_organization enable row level security;

create policy "staff o sistema lee la marca demo" on restaurantes.demo_organization for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = demo_organization.organization_id and m.user_id = auth.uid()
    )
  );

revoke all on restaurantes.demo_organization from public, anon, authenticated, service_role;
grant select on restaurantes.demo_organization to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Limpieza de una demo (R-20). Funcion de OPERADOR: se invoca con la conexion del propietario de la base desde
-- `scripts/seed-pm-demo/limpiar-demo.ts` (nunca desde un request).
--
-- Identidad de lo generado por la demo: los telefonos de personas ficticias usan un rango RESERVADO que no existe en
-- Mexico (lada 000): el seed de volumen usa `+52 0001xxxxxx` y las sesiones del widget publico `+52 0009xxxxxx`. Por eso la
-- limpieza puede borrar solo lo ficticio sin tocar pedidos, clientes ni conversaciones reales de la misma organizacion.
--
-- Modos:
--   'sesiones_widget' -> conversaciones, tomas de handoff, avisos al equipo, pedidos y clientes del widget publico.
--   'volumen'         -> pedidos, clientes y conversaciones del seed de volumen.
--   'todo'            -> la organizacion completa (cascada). Solo si esta marcada como demo.
-- En cualquier modo se NIEGA a operar sobre una organizacion que no este en `restaurantes.demo_organization`.
--
-- Justificacion de seguridad:
--  * SECURITY DEFINER con `set search_path = pg_catalog, public` y nombres calificados: sin secuestro por search_path.
--  * Guarda `auth.uid() is null`: solo la sesion de sistema/operador puede ejecutarla; un usuario autenticado, aunque
--    llegara a tener EXECUTE, recibe un error (defensa en profundidad).
--  * `revoke all ... from public, anon, authenticated, service_role`: ningun rol de la aplicacion la ejecuta; solo el
--    propietario de la base (el operador).
create or replace function restaurantes.demo_limpiar(p_organization_id uuid, p_modo text, p_horas integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_prefijo text;
  v_corte timestamptz;
  v_conv_ids uuid[];
  v_pedidos integer := 0;
  v_conversaciones integer := 0;
  v_clientes integer := 0;
  v_callbacks integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'demo_limpiar: solo la sesion de sistema u operador puede ejecutarla' using errcode = '42501';
  end if;
  if p_modo not in ('sesiones_widget', 'volumen', 'todo') then
    raise exception 'demo_limpiar: modo invalido (%)', p_modo using errcode = '22023';
  end if;
  if p_horas is null or p_horas < 0 then
    raise exception 'demo_limpiar: horas invalidas' using errcode = '22023';
  end if;
  if not exists (select 1 from restaurantes.demo_organization d where d.organization_id = p_organization_id) then
    raise exception 'demo_limpiar: la organizacion no esta marcada como demo; no se toca' using errcode = '42501';
  end if;

  if p_modo = 'todo' then
    delete from core.organization where id = p_organization_id;
    return jsonb_build_object('modo', p_modo, 'organizacion_borrada', true);
  end if;

  v_prefijo := case p_modo when 'volumen' then '0001' else '0009' end;
  v_corte := now() - make_interval(hours => p_horas);

  select coalesce(array_agg(c.id), '{}') into v_conv_ids
    from restaurantes.whatsapp_conversations c
   where c.organization_id = p_organization_id
     and right(regexp_replace(c.phone, '\D', '', 'g'), 10) like v_prefijo || '%'
     and c.updated_at <= v_corte;

  delete from restaurantes.conversation_handoff h
   where h.organization_id = p_organization_id and h.canal = 'whatsapp' and h.conversation_id = any (v_conv_ids);
  delete from restaurantes.whatsapp_conversations c where c.id = any (v_conv_ids);
  get diagnostics v_conversaciones = row_count;

  delete from restaurantes.orders o
   where o.organization_id = p_organization_id
     and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) like v_prefijo || '%'
     and o.created_at <= v_corte;
  get diagnostics v_pedidos = row_count;

  delete from restaurantes.callback_requests r
   where r.organization_id = p_organization_id
     and right(regexp_replace(r.customer_phone, '\D', '', 'g'), 10) like v_prefijo || '%'
     and r.created_at <= v_corte;
  get diagnostics v_callbacks = row_count;

  delete from restaurantes.customers cu
   where cu.organization_id = p_organization_id
     and right(regexp_replace(cu.phone, '\D', '', 'g'), 10) like v_prefijo || '%'
     and not exists (select 1 from restaurantes.orders o where o.customer_id = cu.id);
  get diagnostics v_clientes = row_count;

  return jsonb_build_object('modo', p_modo, 'conversaciones', v_conversaciones, 'pedidos', v_pedidos, 'callbacks', v_callbacks, 'clientes', v_clientes);
end;
$$;

revoke all on function restaurantes.demo_limpiar(uuid, text, integer) from public, anon, authenticated, service_role;
