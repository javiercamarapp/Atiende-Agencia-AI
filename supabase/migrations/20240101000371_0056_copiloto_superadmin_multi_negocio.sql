-- Copiloto de superadmin multi-negocio (seguimiento de CHAT-17): lecturas AGREGADAS por organizacion y bitacora de acceso por organizacion.
--
-- Que agrega (todo aditivo; ninguna tabla ni funcion existente cambia de comportamiento):
--   1. core.get_operaciones_por_organizacion_for_superadmin: una fila por organizacion (incluidas las que no tuvieron actividad, con 0) con
--      operaciones del rango, ingresos (solo donde la vertical los guarda), escalaciones a humano, abiertos y vencidos. Solo CONTEOS y SUMAS.
--   2. core.superadmin_org_access_log (append-only) + core.log_superadmin_org_access: una fila por organizacion consultada con quien, que
--      organizacion (id resuelto), que herramienta y cuando.
--   3. core.list_superadmin_org_access_for_superadmin: lectura de esa bitacora para el superadmin completo (transparencia y pruebas).
--   4. Fijados del Copiloto de PLATAFORMA: core.copiloto_pin admite filas con vertical 'plataforma' y organizacion NULL (CHECK de coherencia en ambos
--      sentidos, nunca compartidas), con policies propias para su autor superadmin y core.copiloto_pin_create_plataforma como unica via de alta.
--
-- DECISION: por que NO se reutilizo la ruta de break-glass / impersonacion (deps.ts: impersonationRepo, rentas.open_break_glass_session).
--   Esas rutas abren una ventana de acceso con la identidad de un miembro de la organizacion y devuelven filas de negocio completas (nombres,
--   telefonos, direcciones de clientes finales), pensadas para soporte puntual y con notificacion al cliente. El Copiloto necesita lo contrario:
--   contestar en bloque (rankings de decenas de organizaciones) y SIN datos personales. Una funcion de agregados con alcance de superadmin y
--   bitacora propia es mas estrecha: no existe forma de que devuelva un nombre, telefono, direccion o correo de un cliente final.
--
-- Datos personales y ARCO/supresion: ninguna columna de estas funciones es un dato personal. Solo se cuentan filas y se suman montos; una
-- persona suprimida o anonimizada sigue contando como "un pedido" (agregado sin identidad), igual que en los tableros de la consola. El rol
-- `finanzas` queda fuera: las funciones exigen core.cfo_zone_resolve_role = 'superadmin'.
--
-- Dia de negocio: America/Mexico_City (las marcas de tiempo se convierten con AT TIME ZONE). El API pasa `p_hoy` (no se lee current_date: las
-- funciones son deterministas y probables con un reloj fijo).
--
-- Compatibilidad con la base SIN migrar: el codigo TypeScript (apps/api/src/superadmin-copiloto/) captura 42883/42P01/42703 y responde "no
-- tengo el dato" (nunca 500 ni cifra inventada). Cada vertical se lee con EXCEPTION WHEN undefined_table/undefined_column/insufficient_privilege:
-- una vertical cuya migracion no esta aplicada devuelve sus organizaciones con `razon = 'fuente_no_migrada'` y cantidades NULL, no un 0 falso.
--
-- Requiere: 0001, 0012 (core.is_platform_superadmin), 0034 (core.cfo_zone_resolve_role).
--
-- JUSTIFICACION DE SEGURIDAD (cada GRANT, policy y funcion nueva):
--   * core.get_operaciones_por_organizacion_for_superadmin: security definer con `search_path = core, pg_temp` y tablas de vertical calificadas.
--     Razon: `authenticated` no tiene GRANT sobre las tablas de las verticales; solo esta funcion las agrega. Exige auth.uid() = p_caller_id,
--     superadmin vigente y rol efectivo 'superadmin' (no `finanzas`); a cualquier otro llamador (incluida la sesion de sistema, auth.uid() null)
--     devuelve CERO filas, nunca un error que confirme o niegue datos. REVOKE de public/anon, GRANT EXECUTE solo a authenticated. Rango acotado
--     a 400 dias (22023). Solo agregados: ningun nombre, telefono, correo, direccion ni contenido de conversacion.
--   * core.superadmin_org_access_log: RLS activa SIN policy (nadie la lee directo), `revoke all` a public/anon/authenticated/service_role y
--     triggers de bloqueo de UPDATE/DELETE (append-only). Se escribe solo por core.log_superadmin_org_access.
--   * core.log_superadmin_org_access: security definer, search_path fijo, REVOKE de public/anon, GRANT EXECUTE a authenticated. El actor sale de
--     auth.uid() (debe ser igual a p_caller_id: no se puede registrar a nombre de otro), exige superadmin vigente con rol 'superadmin' (42501), y
--     SOLO registra organizaciones que existen (la vertical se toma de core.organization, no de un parametro). Maximo 1000 organizaciones por
--     llamada y parametros limitados a un objeto jsonb de 2000 bytes.
--   * core.list_superadmin_org_access_for_superadmin: security definer, search_path fijo, exige superadmin completo; devuelve solo ids, vertical,
--     herramienta y fecha (sin parametros de consulta), acotada a 500 filas.
--   * core.copiloto_pin (fijados de plataforma): conserva RLS, `revoke all` a public/anon/authenticated/service_role y los GRANT existentes (select,
--     delete y update a nivel columna de title/shared); NO se agrega GRANT. Las policies existentes comparan con una membresia de la organizacion, que
--     no existe para NULL, asi que NO exponen ninguna fila de plataforma. Tres policies NUEVAS (select/update/delete) limitadas a
--     `vertical = 'plataforma' and author_id = auth.uid() and core.is_platform_superadmin(auth.uid())`: solo el autor, mientras siga siendo superadmin.
--     Un fijado de plataforma nunca se comparte (CHECK `not shared`): el tablero es personal. Un fijado no guarda cifras sino herramienta + argumentos;
--     al abrirlo se re-ejecuta con el rol ACTUAL del autor (si pasa a `finanzas`, solo ve lo financiero).
--   * core.copiloto_pin_create_plataforma: security definer, search_path fijo, revoke de public/anon, GRANT a authenticated; actor = auth.uid() (28000 sin
--     actor), superadmin vigente (42501), conversacion propia de ambito plataforma (P0002), tope de 50 por autor serializado con advisory lock (54000) y
--     deduplicacion por herramienta + argumentos.

-- ---------------------------------------------------------------------------
-- 1) Bitacora por organizacion consultada
-- ---------------------------------------------------------------------------
create table if not exists core.superadmin_org_access_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,
  -- Sin FK a proposito: la huella debe sobrevivir aunque la organizacion se elimine algun dia.
  organization_id uuid not null,
  vertical text not null,
  tool text not null check (tool ~ '^[a-z0-9_]{1,80}$'),
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object' and octet_length(params::text) <= 2000),
  created_at timestamptz not null default now()
);
create index if not exists superadmin_org_access_log_org_idx on core.superadmin_org_access_log (organization_id, created_at desc);
create index if not exists superadmin_org_access_log_actor_idx on core.superadmin_org_access_log (actor_user_id, created_at desc);

alter table core.superadmin_org_access_log enable row level security;
revoke all on core.superadmin_org_access_log from public, anon, authenticated, service_role;

create or replace function core.superadmin_org_access_log_block_mutation()
returns trigger
language plpgsql
set search_path = core, pg_temp
as $$
begin
  raise exception 'superadmin_org_access_log_append_only: % no esta permitido sobre core.superadmin_org_access_log', tg_op
    using errcode = '0A000';
end;
$$;

drop trigger if exists superadmin_org_access_log_block_update_trg on core.superadmin_org_access_log;
create trigger superadmin_org_access_log_block_update_trg
  before update on core.superadmin_org_access_log
  for each row execute function core.superadmin_org_access_log_block_mutation();
drop trigger if exists superadmin_org_access_log_block_delete_trg on core.superadmin_org_access_log;
create trigger superadmin_org_access_log_block_delete_trg
  before delete on core.superadmin_org_access_log
  for each row execute function core.superadmin_org_access_log_block_mutation();

create or replace function core.log_superadmin_org_access(p_caller_id uuid, p_organization_ids uuid[], p_tool text, p_params jsonb default '{}'::jsonb)
returns integer
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_n integer;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'core.log_superadmin_org_access: requiere un actor autenticado que coincida con p_caller_id.' using errcode = '28000';
  end if;
  if not core.is_platform_superadmin(p_caller_id) or core.cfo_zone_resolve_role(p_caller_id) is distinct from 'superadmin' then
    raise exception 'core.log_superadmin_org_access: solo el superadmin completo consulta datos por organizacion.' using errcode = '42501';
  end if;
  if p_organization_ids is null or coalesce(array_length(p_organization_ids, 1), 0) = 0 then
    return 0;
  end if;
  if array_length(p_organization_ids, 1) > 1000 then
    raise exception 'core.log_superadmin_org_access: demasiadas organizaciones en una llamada (maximo 1000).' using errcode = '22023';
  end if;
  if p_tool is null or p_tool !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'core.log_superadmin_org_access: herramienta invalida.' using errcode = '22023';
  end if;
  insert into core.superadmin_org_access_log (actor_user_id, organization_id, vertical, tool, params)
  select p_caller_id, o.id, o.vertical, p_tool,
         case when p_params is not null and jsonb_typeof(p_params) = 'object' and octet_length(p_params::text) <= 2000 then p_params else '{}'::jsonb end
    from core.organization o
   where o.id = any (p_organization_ids);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function core.log_superadmin_org_access(uuid, uuid[], text, jsonb) from public, anon;
grant execute on function core.log_superadmin_org_access(uuid, uuid[], text, jsonb) to authenticated;

comment on function core.log_superadmin_org_access(uuid, uuid[], text, jsonb) is
  'Bitacora del Copiloto de superadmin: una fila por organizacion consultada (quien, que organizacion, que herramienta, cuando). Solo superadmin completo.';

create or replace function core.list_superadmin_org_access_for_superadmin(p_caller_id uuid, p_limit integer default 100)
returns table (actor_user_id uuid, organization_id uuid, vertical text, tool text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  if core.cfo_zone_resolve_role(p_caller_id) is distinct from 'superadmin' then
    return;
  end if;
  return query
    select l.actor_user_id, l.organization_id, l.vertical, l.tool, l.created_at
      from core.superadmin_org_access_log l
     order by l.created_at desc, l.id
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;
revoke all on function core.list_superadmin_org_access_for_superadmin(uuid, integer) from public, anon;
grant execute on function core.list_superadmin_org_access_for_superadmin(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Operaciones agregadas por organizacion
-- ---------------------------------------------------------------------------
-- Significado por vertical (las columnas que no aplican salen NULL, no 0):
--   restaurantes: operaciones = pedidos no cancelados creados en el rango; ingresos = suma de su total (MXN); escalaciones = tomas humanas
--                 solicitadas en el rango (restaurantes.conversation_handoff); abiertos = pedidos pendientes/preparando/en camino ahora.
--   hoteles:      operaciones = reservas (no canceladas, cotizadas ni no-show) creadas en el rango; ingresos = suma de su total_amount (MXN); abiertos = reservas con la estancia vigente
--                 en p_hoy (ocupacion actual).
--   rentas:       operaciones = reservas de canal (no canceladas) creadas en el rango; abiertos = reservas confirmadas que ocupan p_hoy.
--   citas:        operaciones = citas (no canceladas ni no-show) creadas en el rango; abiertos = citas pendientes/confirmadas desde p_hoy.
--   despachos:    operaciones = CFDI registrados en el rango; abiertos = vencimientos fiscales sin completar; vencidos = de esos, con fecha limite
--                 anterior a p_hoy.
--   licitaciones: operaciones = convocatorias creadas en el rango; abiertos = convocatorias con fecha de cierre desde p_hoy.
create or replace function core.get_operaciones_por_organizacion_for_superadmin(
  p_caller_id uuid, p_desde date, p_hasta date, p_hoy date, p_organization_id uuid default null
)
returns table (
  organization_id uuid, vertical text, operaciones bigint, ingresos numeric, escalaciones bigint, abiertos bigint, vencidos bigint, razon text
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
#variable_conflict use_column
declare
  v_esc jsonb := null;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  if core.cfo_zone_resolve_role(p_caller_id) is distinct from 'superadmin' then
    return;
  end if;
  if p_desde is null or p_hasta is null or p_hoy is null or p_hasta < p_desde or p_hasta - p_desde > 400 then
    raise exception 'get_operaciones_por_organizacion_for_superadmin: rango invalido (maximo 400 dias)' using errcode = '22023';
  end if;

  -- restaurantes (las escalaciones viven en una migracion posterior: se leen aparte para no perder pedidos si falta)
  begin
    select coalesce(jsonb_object_agg(x.organization_id::text, x.n), '{}'::jsonb) into v_esc
      from (
        select h.organization_id, count(*) as n
          from restaurantes.conversation_handoff h
         where (h.solicitada_at at time zone 'America/Mexico_City')::date between p_desde and p_hasta
         group by h.organization_id
      ) x;
  exception when undefined_table or undefined_column or insufficient_privilege then
    v_esc := null;
  end;
  begin
    return query
      select o.id, 'restaurantes'::text,
             coalesce(op.n, 0)::bigint, coalesce(op.ingresos, 0)::numeric,
             case when v_esc is null then null::bigint else coalesce((v_esc ->> o.id::text)::bigint, 0) end,
             coalesce(ab.n, 0)::bigint, null::bigint, null::text
        from core.organization o
        left join (
          select r.organization_id, count(*) as n, sum(r.total) as ingresos
            from restaurantes.orders r
           where r.status <> 'cancelado' and (r.created_at at time zone 'America/Mexico_City')::date between p_desde and p_hasta
           group by r.organization_id
        ) op on op.organization_id = o.id
        left join (
          select r.organization_id, count(*) as n from restaurantes.orders r where r.status in ('pending', 'preparando', 'en_camino') group by r.organization_id
        ) ab on ab.organization_id = o.id
       where o.vertical = 'restaurantes' and (p_organization_id is null or o.id = p_organization_id);
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query
      select o.id, 'restaurantes'::text, null::bigint, null::numeric, null::bigint, null::bigint, null::bigint, 'fuente_no_migrada'::text
        from core.organization o where o.vertical = 'restaurantes' and (p_organization_id is null or o.id = p_organization_id);
  end;

  -- hoteles
  begin
    return query
      select o.id, 'hoteles'::text, coalesce(op.n, 0)::bigint, coalesce(op.ingresos, 0)::numeric, null::bigint, coalesce(ab.n, 0)::bigint, null::bigint, null::text
        from core.organization o
        left join (
          select r.organization_id, count(*) as n, sum(r.total_amount) as ingresos
            from hoteles.reservation r
           where r.status::text not in ('cancelada', 'cotizada', 'no_show') and (r.created_at at time zone 'America/Mexico_City')::date between p_desde and p_hasta
           group by r.organization_id
        ) op on op.organization_id = o.id
        left join (
          select r.organization_id, count(*) as n
            from hoteles.reservation r
           where r.status::text not in ('cancelada', 'cotizada', 'no_show') and r.check_in_date <= p_hoy and r.check_out_date > p_hoy
           group by r.organization_id
        ) ab on ab.organization_id = o.id
       where o.vertical = 'hoteles' and (p_organization_id is null or o.id = p_organization_id);
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query
      select o.id, 'hoteles'::text, null::bigint, null::numeric, null::bigint, null::bigint, null::bigint, 'fuente_no_migrada'::text
        from core.organization o where o.vertical = 'hoteles' and (p_organization_id is null or o.id = p_organization_id);
  end;

  -- rentas
  begin
    return query
      select o.id, 'rentas'::text, coalesce(op.n, 0)::bigint, null::numeric, null::bigint, coalesce(ab.n, 0)::bigint, null::bigint, null::text
        from core.organization o
        left join (
          select c.organization_id, count(*) as n
            from rentas.ocupacion c
           where c.capa = 'reserva' and c.estado <> 'cancelado' and (c.created_at at time zone 'America/Mexico_City')::date between p_desde and p_hasta
           group by c.organization_id
        ) op on op.organization_id = o.id
        left join (
          select c.organization_id, count(*) as n
            from rentas.ocupacion c
           where c.capa = 'reserva' and c.estado = 'confirmado' and c.rango @> p_hoy
           group by c.organization_id
        ) ab on ab.organization_id = o.id
       where o.vertical = 'rentas' and (p_organization_id is null or o.id = p_organization_id);
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query
      select o.id, 'rentas'::text, null::bigint, null::numeric, null::bigint, null::bigint, null::bigint, 'fuente_no_migrada'::text
        from core.organization o where o.vertical = 'rentas' and (p_organization_id is null or o.id = p_organization_id);
  end;

  -- citas
  begin
    return query
      select o.id, 'citas'::text, coalesce(op.n, 0)::bigint, null::numeric, null::bigint, coalesce(ab.n, 0)::bigint, null::bigint, null::text
        from core.organization o
        left join (
          select a.organization_id, count(*) as n
            from citas.appointments a
           where a.status not in ('cancelled', 'no_show') and (a.created_at at time zone 'America/Mexico_City')::date between p_desde and p_hasta
           group by a.organization_id
        ) op on op.organization_id = o.id
        left join (
          select a.organization_id, count(*) as n
            from citas.appointments a
           where a.status in ('pending', 'confirmed') and a.starts_at >= (p_hoy::timestamp at time zone 'America/Mexico_City')
           group by a.organization_id
        ) ab on ab.organization_id = o.id
       where o.vertical = 'citas' and (p_organization_id is null or o.id = p_organization_id);
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query
      select o.id, 'citas'::text, null::bigint, null::numeric, null::bigint, null::bigint, null::bigint, 'fuente_no_migrada'::text
        from core.organization o where o.vertical = 'citas' and (p_organization_id is null or o.id = p_organization_id);
  end;

  -- despachos
  begin
    return query
      select o.id, 'despachos'::text, coalesce(op.n, 0)::bigint, null::numeric, null::bigint, coalesce(ab.n, 0)::bigint, coalesce(ab.vencidos, 0)::bigint, null::text
        from core.organization o
        left join (
          select i.organization_id, count(*) as n
            from despachos.invoice i
           where (i.created_at at time zone 'America/Mexico_City')::date between p_desde and p_hasta
           group by i.organization_id
        ) op on op.organization_id = o.id
        left join (
          select d.organization_id, count(*) as n, count(*) filter (where d.fecha_limite < p_hoy) as vencidos
            from despachos.fiscal_deadline d
           where d.estado <> 'completado'
           group by d.organization_id
        ) ab on ab.organization_id = o.id
       where o.vertical = 'despachos' and (p_organization_id is null or o.id = p_organization_id);
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query
      select o.id, 'despachos'::text, null::bigint, null::numeric, null::bigint, null::bigint, null::bigint, 'fuente_no_migrada'::text
        from core.organization o where o.vertical = 'despachos' and (p_organization_id is null or o.id = p_organization_id);
  end;

  -- licitaciones
  begin
    return query
      select o.id, 'licitaciones'::text, coalesce(op.n, 0)::bigint, null::numeric, null::bigint, coalesce(ab.n, 0)::bigint, null::bigint, null::text
        from core.organization o
        left join (
          select t.organization_id, count(*) as n
            from licitaciones.tender t
           where (t.created_at at time zone 'America/Mexico_City')::date between p_desde and p_hasta
           group by t.organization_id
        ) op on op.organization_id = o.id
        left join (
          select t.organization_id, count(*) as n
            from licitaciones.tender t
           where t.submission_deadline >= (p_hoy::timestamp at time zone 'America/Mexico_City')
           group by t.organization_id
        ) ab on ab.organization_id = o.id
       where o.vertical = 'licitaciones' and (p_organization_id is null or o.id = p_organization_id);
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query
      select o.id, 'licitaciones'::text, null::bigint, null::numeric, null::bigint, null::bigint, null::bigint, 'fuente_no_migrada'::text
        from core.organization o where o.vertical = 'licitaciones' and (p_organization_id is null or o.id = p_organization_id);
  end;
end;
$$;
revoke all on function core.get_operaciones_por_organizacion_for_superadmin(uuid, date, date, date, uuid) from public, anon;
grant execute on function core.get_operaciones_por_organizacion_for_superadmin(uuid, date, date, date, uuid) to authenticated;

comment on function core.get_operaciones_por_organizacion_for_superadmin(uuid, date, date, date, uuid) is
  'Conteos y sumas por organizacion (todas, con 0 si no hubo actividad) para el Copiloto de superadmin. Sin datos personales. Solo superadmin completo.';

-- ---------------------------------------------------------------------------
-- 3) Fijados del Copiloto de plataforma (core.copiloto_pin con organizacion NULL)
-- ---------------------------------------------------------------------------
alter table core.copiloto_pin alter column organization_id drop not null;

alter table core.copiloto_pin drop constraint if exists copiloto_pin_vertical_check;
alter table core.copiloto_pin
  add constraint copiloto_pin_vertical_check
  check (vertical in ('restaurantes', 'hoteles', 'rentas', 'despachos', 'licitaciones', 'citas', 'plataforma'));
alter table core.copiloto_pin
  add constraint copiloto_pin_plataforma_sin_org
  check ((vertical = 'plataforma') = (organization_id is null));
alter table core.copiloto_pin
  add constraint copiloto_pin_plataforma_no_compartido
  check (vertical <> 'plataforma' or not shared);

-- El UNIQUE (author_id, organization_id, tool, args) de la 0045 no aplica con organization_id NULL (Postgres trata los NULL como distintos): este indice parcial
-- da la deduplicacion de los fijados de plataforma a nivel de datos, ademas del advisory lock y el SELECT previo de la funcion de alta.
create unique index if not exists copiloto_pin_plataforma_uniq on core.copiloto_pin (author_id, tool, args) where vertical = 'plataforma';

create policy "superadmin lee sus fijados de plataforma" on core.copiloto_pin for select
  using (vertical = 'plataforma' and author_id = auth.uid() and core.is_platform_superadmin(auth.uid()));

create policy "superadmin edita sus fijados de plataforma" on core.copiloto_pin for update
  using (vertical = 'plataforma' and author_id = auth.uid() and core.is_platform_superadmin(auth.uid()))
  with check (vertical = 'plataforma' and author_id = auth.uid() and core.is_platform_superadmin(auth.uid()));

create policy "superadmin borra sus fijados de plataforma" on core.copiloto_pin for delete
  using (vertical = 'plataforma' and author_id = auth.uid() and core.is_platform_superadmin(auth.uid()));

create or replace function core.copiloto_pin_create_plataforma(
  p_conversation_id uuid,
  p_message_seq integer,
  p_block_index integer,
  p_tool text,
  p_args jsonb,
  p_title text
)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_title text := left(btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g')), 80);
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
  v_id uuid;
  v_count integer;
begin
  if v_actor is null then
    raise exception 'core.copiloto_pin_create_plataforma: requiere un actor autenticado (auth.uid() es NULL) -- nunca corre desde la sesion de sistema.'
      using errcode = '28000';
  end if;
  if not core.is_platform_superadmin(v_actor) or core.cfo_zone_resolve_role(v_actor) is distinct from 'superadmin' then
    -- Mismo guard que las demas funciones de la 0056: el superadmin restringido a `finanzas` no fija en el tablero de plataforma (defensa en profundidad:
    -- la zona CFO ya no expone /pins, y un fijado se re-ejecuta con el rol vigente).
    raise exception 'core.copiloto_pin_create_plataforma: el actor no es superadmin completo de plataforma.' using errcode = '42501';
  end if;
  if p_tool is null or p_tool !~ '^[a-z0-9_]{1,80}$' or jsonb_typeof(v_args) <> 'object' or pg_column_size(v_args) > 2000 or v_title = '' then
    raise exception 'core.copiloto_pin_create_plataforma: argumentos invalidos.' using errcode = '22023';
  end if;
  if p_conversation_id is not null and not exists (
    select 1 from core.data_chat_conversation c where c.id = p_conversation_id and c.user_id = v_actor and c.scope = 'plataforma'
  ) then
    raise exception 'core.copiloto_pin_create_plataforma: la conversacion no existe.' using errcode = 'P0002';
  end if;

  -- Serializa las altas del mismo autor para que el tope no se rebase por carreras.
  perform pg_advisory_xact_lock(hashtextextended('copiloto_pin:' || v_actor::text || ':plataforma', 0));

  select p.id into v_id from core.copiloto_pin p
   where p.author_id = v_actor and p.vertical = 'plataforma' and p.tool = p_tool and p.args = v_args;
  if v_id is not null then
    return v_id;
  end if;

  select count(*) into v_count from core.copiloto_pin p where p.author_id = v_actor and p.vertical = 'plataforma';
  if v_count >= 50 then
    raise exception 'core.copiloto_pin_create_plataforma: limite_fijados (50).' using errcode = '54000';
  end if;

  insert into core.copiloto_pin (organization_id, vertical, author_id, conversation_id, message_seq, block_index, tool, args, title)
  values (null, 'plataforma', v_actor, p_conversation_id, p_message_seq, p_block_index, p_tool, v_args, v_title)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function core.copiloto_pin_create_plataforma(uuid, integer, integer, text, jsonb, text) from public, anon;
grant execute on function core.copiloto_pin_create_plataforma(uuid, integer, integer, text, jsonb, text) to authenticated;

comment on function core.copiloto_pin_create_plataforma(uuid, integer, integer, text, jsonb, text) is
  'Unica via de alta de fijados del Copiloto de plataforma: actor = auth.uid() superadmin, conversacion propia de plataforma, tope de 50, deduplica por herramienta + argumentos.';
