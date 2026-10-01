-- L-08 (licitaciones): KYC negativo contra la lista 69-B del SAT (art. 69-B del CFF,
-- contribuyentes con operaciones presuntamente inexistentes) para el RFC de proveedores
-- y competidores. Requiere: 001..030 de licitaciones y la 014 de despachos (ingesta de la
-- lista: `despachos.efos_ingesta` / `despachos.efos_contribuyente`).
--
-- SIN DUPLICAR DATOS: la lista del SAT es publica y global y ya la ingiere despachos
-- (D-04). Esta migracion NO crea otra copia: expone un LECTOR de solo lectura
-- (`licitaciones.kyc_consultar_69b`) que corre como definer y lee la edicion vigente de
-- `despachos.efos_contribuyente`. Las tablas de despachos siguen sin ningun GRANT para
-- authenticated/anon; licitaciones no gana acceso directo a ellas.
--
-- Lo que SI es privado por tenant: el hecho de que una organizacion consulte un RFC (su
-- cartera de proveedores/competidores revela estrategia comercial). Por eso:
--   1. `kyc_party`    -- fichas de la organizacion (proveedor | competidor) con RLS por org.
--   2. `kyc_consulta` -- bitacora por organizacion de cada RFC consultado. Solo la escribe la
--                         funcion definer; solo la leen los roles de decision de SU org.
--
-- Seguridad (cada punto lo ejerce scripts/verify-licitaciones-kyc-69b/assertions.sql):
--   * Ninguna policy usa `using (true)`; ningun GRANT a anon; todo REVOKE explicito a public.
--   * GRANT por COLUMNA en kyc_party: el cliente solo inserta (organization_id, rfc, rol,
--     nombre) y solo actualiza `nombre`; `created_by`/`created_at`/`id` nunca los fija el
--     cliente (created_by toma auth.uid() por default de columna).
--   * kyc_consulta: authenticated solo tiene SELECT (RLS can_decide_org); sin INSERT/UPDATE/
--     DELETE -> la bitacora no se puede falsear ni borrar desde el cliente.
--   * Las tres funciones son security definer con `set search_path` fijo, revoke de public y
--     GRANT EXECUTE solo a `authenticated` (la sesion de la app corre con ese rol). Todas
--     exigen auth.uid() no nulo y membresia en una organizacion con vertical 'licitaciones'.
--   * Anti-enumeracion / anti-scraping: lote maximo de 50 RFC por llamada (22023), tope de
--     1000 RFC consultados por organizacion cada 24 horas (54000), validacion estricta de
--     la forma del RFC (12 moral / 13 fisica, fecha valida, homoclave) y rechazo de los RFC
--     genericos (publico en general / extranjero). Un advisory lock por organizacion evita
--     que consultas concurrentes salten el tope.
--
-- Compatibilidad con la base sin migrar: el TypeScript que consume estas funciones corre
-- cada operacion en SAVEPOINT y degrada a "KYC no disponible aun" ante 42P01/42703/42883
-- (tambien si falta la migracion 014 de despachos, que dispara 42P01 dentro del lector).
-- Orden de despliegue: la migracion puede aplicarse antes o despues del codigo.

-- ---------------------------------------------------------------------------
-- 1) kyc_party: fichas de proveedores y competidores de la organizacion
-- ---------------------------------------------------------------------------
create table licitaciones.kyc_party (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  rfc text not null check (rfc ~ '^[A-ZÑ&]{3,4}[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[A-Z0-9]{2}[0-9A]$'),
  rol text not null check (rol in ('proveedor', 'competidor')),
  nombre text not null default '' check (length(nombre) <= 200),
  created_by uuid default auth.uid() references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, rfc, rol)
);
create index licitaciones_kyc_party_org_idx on licitaciones.kyc_party (organization_id, rol, created_at desc);

-- Tope de fichas por organizacion (defensa en profundidad contra una cartera usada como
-- volcado). Corre como el rol invocador (sin definer): cuenta bajo RLS las fichas de su org.
create or replace function licitaciones.kyc_party_before_insert()
returns trigger language plpgsql set search_path = licitaciones, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('licitaciones.kyc_party:' || new.organization_id::text, 0));
  if (select count(*) from licitaciones.kyc_party where organization_id = new.organization_id) >= 500 then
    raise exception 'kyc_party: maximo 500 fichas por organizacion' using errcode = '54000';
  end if;
  return new;
end;
$$;
create trigger kyc_party_before_insert before insert on licitaciones.kyc_party
  for each row execute function licitaciones.kyc_party_before_insert();

alter table licitaciones.kyc_party enable row level security;
-- Seguridad: cualquier miembro de la organizacion ve sus fichas (el semaforo es informacion de
-- trabajo para todo el equipo); solo roles de escritura crean/editan/borran.
create policy "kyc_party: miembros de la org la leen" on licitaciones.kyc_party
  for select using (licitaciones.can_access_org(organization_id));
create policy "kyc_party: roles de escritura insertan" on licitaciones.kyc_party
  for insert with check (licitaciones.can_write_org(organization_id));
create policy "kyc_party: roles de escritura editan" on licitaciones.kyc_party
  for update using (licitaciones.can_write_org(organization_id))
  with check (licitaciones.can_write_org(organization_id));
create policy "kyc_party: roles de escritura borran" on licitaciones.kyc_party
  for delete using (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.kyc_party from public, anon;
grant select, delete on licitaciones.kyc_party to authenticated;
-- GRANT por columna: rfc y rol son inmutables (cambiar de RFC = borrar y crear otra ficha).
grant insert (organization_id, rfc, rol, nombre) on licitaciones.kyc_party to authenticated;
grant update (nombre) on licitaciones.kyc_party to authenticated;

-- ---------------------------------------------------------------------------
-- 2) kyc_consulta: bitacora PRIVADA por organizacion (append-only para el cliente)
-- ---------------------------------------------------------------------------
create table licitaciones.kyc_consulta (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  user_id uuid references core.staff_user(id) on delete set null,
  lote_id uuid not null,
  rfc text not null check (rfc ~ '^[A-ZÑ&]{3,4}[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[A-Z0-9]{2}[0-9A]$'),
  -- false = el RFC no aparece en la edicion vigente de la lista (o no hay edicion cargada).
  encontrado boolean not null,
  situacion text check (situacion is null or situacion in ('presunto', 'desvirtuado', 'definitivo', 'sentencia_favorable')),
  periodo text check (periodo is null or periodo ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  consultado_en timestamptz not null default now()
);
create index licitaciones_kyc_consulta_org_idx on licitaciones.kyc_consulta (organization_id, consultado_en desc);

alter table licitaciones.kyc_consulta enable row level security;
-- Seguridad: la bitacora solo la ven los roles de decision de LA MISMA organizacion; un tenant
-- jamas ve las consultas de otro. No hay policy ni GRANT de escritura: la unica via es
-- `licitaciones.kyc_consultar_69b`.
create policy "kyc_consulta: roles de decision de la org la leen" on licitaciones.kyc_consulta
  for select using (licitaciones.can_decide_org(organization_id));
revoke all on licitaciones.kyc_consulta from public, anon, authenticated;
grant select on licitaciones.kyc_consulta to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Funciones (security definer, search_path fijo, auth.uid() obligatorio)
-- ---------------------------------------------------------------------------

-- Consulta de un RFC o un lote contra la edicion MAS RECIENTE de la lista 69-B y registro en
-- la bitacora de la organizacion. Seguridad: definer porque lee despachos.efos_* (sin acceso
-- para authenticated) y escribe kyc_consulta (sin INSERT para authenticated); la autorizacion
-- se hace DENTRO: usuario real + rol de escritura en la organizacion indicada (una consulta
-- deja huella, por eso no la hace un viewer) + organizacion de la vertical licitaciones.
-- Devuelve una fila por RFC distinto del lote, aparezca o no en la lista.
create or replace function licitaciones.kyc_consultar_69b(p_organization_id uuid, p_rfcs text[])
returns table (
  out_rfc text,
  out_encontrado boolean,
  out_periodo text,
  out_nombre text,
  out_situacion text,
  out_oficio_presuncion text,
  out_fecha_publicacion text,
  out_fecha_presuncion_sat text,
  out_fecha_desvirtuado_sat text,
  out_fecha_definitivo_sat text,
  out_fecha_sentencia_favorable_sat text
)
language plpgsql
security definer
set search_path = licitaciones, despachos, core, pg_temp
as $$
declare
  v_rfcs text[];
  v_periodo text;
  v_lote uuid := gen_random_uuid();
  v_usadas integer;
begin
  if auth.uid() is null then
    raise exception 'kyc_consultar_69b requiere un usuario autenticado' using errcode = '42501';
  end if;
  if p_organization_id is null
     or not licitaciones.can_write_org(p_organization_id)
     or not exists (select 1 from core.organization o where o.id = p_organization_id and o.vertical = 'licitaciones') then
    raise exception 'kyc_consultar_69b: sin acceso a la organizacion' using errcode = '42501';
  end if;
  if p_rfcs is null or coalesce(array_length(p_rfcs, 1), 0) = 0 or array_length(p_rfcs, 1) > 50 then
    raise exception 'kyc_consultar_69b: se aceptan de 1 a 50 RFC por consulta' using errcode = '22023';
  end if;

  -- Normaliza (mayusculas, sin espacios en los extremos), quita duplicados y conserva el orden de aparicion.
  select array_agg(s.rfc order by s.ord)
    into v_rfcs
    from (select upper(btrim(t.x)) as rfc, min(t.ord) as ord
            from unnest(p_rfcs) with ordinality as t(x, ord)
           group by upper(btrim(t.x))) s;
  if exists (
    select 1 from unnest(v_rfcs) as r
    where r is null or r !~ '^[A-ZÑ&]{3,4}[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[A-Z0-9]{2}[0-9A]$'
  ) then
    raise exception 'kyc_consultar_69b: RFC con formato invalido' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_rfcs) as r where r in ('XAXX010101000', 'XEXX010101000')) then
    raise exception 'kyc_consultar_69b: RFC generico (publico en general / extranjero) no identifica a un contribuyente' using errcode = '22023';
  end if;

  -- Tope por organizacion y ventana de 24 h (anti-scraping). El lock serializa consultas concurrentes.
  perform pg_advisory_xact_lock(hashtextextended('licitaciones.kyc_consulta:' || p_organization_id::text, 0));
  select count(*) into v_usadas
    from licitaciones.kyc_consulta k
    where k.organization_id = p_organization_id and k.consultado_en > now() - interval '24 hours';
  if v_usadas + array_length(v_rfcs, 1) > 1000 then
    raise exception 'kyc_consultar_69b: tope de 1000 RFC consultados por organizacion cada 24 horas' using errcode = '54000';
  end if;

  select max(i.periodo) into v_periodo from despachos.efos_ingesta i;

  return query
    with res as (
      select r.rfc as r_rfc, r.ord as r_ord, c.periodo as c_periodo, c.nombre as c_nombre, c.situacion as c_situacion,
             c.oficio_presuncion as c_oficio, c.fecha_presuncion_sat as c_fp, c.fecha_desvirtuado_sat as c_fd,
             c.fecha_definitivo_sat as c_fdef, c.fecha_sentencia_favorable_sat as c_fs
        from unnest(v_rfcs) with ordinality as r(rfc, ord)
        left join despachos.efos_contribuyente c on c.rfc = r.rfc and c.periodo = v_periodo
    ),
    log as (
      insert into licitaciones.kyc_consulta (organization_id, user_id, lote_id, rfc, encontrado, situacion, periodo)
      select p_organization_id, auth.uid(), v_lote, res.r_rfc, res.c_situacion is not null, res.c_situacion, v_periodo
        from res
      returning 1
    )
    select res.r_rfc,
           res.c_situacion is not null,
           v_periodo,
           res.c_nombre,
           res.c_situacion,
           res.c_oficio,
           (case res.c_situacion
              when 'presunto' then res.c_fp
              when 'desvirtuado' then res.c_fd
              when 'definitivo' then res.c_fdef
              when 'sentencia_favorable' then res.c_fs
            end)::text,
           res.c_fp::text, res.c_fd::text, res.c_fdef::text, res.c_fs::text
      from res
      order by res.r_ord;
end;
$$;
revoke all on function licitaciones.kyc_consultar_69b(uuid, text[]) from public;
grant execute on function licitaciones.kyc_consultar_69b(uuid, text[]) to authenticated;

-- Estado de la lista vigente (periodo y filas). Cero filas = nunca se ingirio. Seguridad: la
-- lista es publica, pero igual se exige usuario real con membresia en una org de licitaciones
-- (no se ofrece a anon ni a staff de otras verticales).
create or replace function licitaciones.kyc_estado_lista()
returns table (out_periodo text, out_filas integer, out_ingestado_en text)
language plpgsql
stable
security definer
set search_path = licitaciones, despachos, core, pg_temp
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from core.membership m
    join core.organization o on o.id = m.organization_id
    where m.user_id = auth.uid() and o.vertical = 'licitaciones'
  ) then
    raise exception 'kyc_estado_lista: requiere staff de licitaciones' using errcode = '42501';
  end if;
  return query
    select i.periodo, i.filas, i.ingestado_en::text
    from despachos.efos_ingesta i
    order by i.periodo desc
    limit 1;
end;
$$;
revoke all on function licitaciones.kyc_estado_lista() from public;
grant execute on function licitaciones.kyc_estado_lista() to authenticated;

-- Fichas de la organizacion con su situacion VIGENTE (semaforo de la ficha y alerta de
-- proveedor propio). No registra en la bitacora: es la lectura de la propia cartera, no una
-- consulta nueva de RFC. Seguridad: definer solo para leer despachos.efos_*; el alcance lo
-- fija p_organization_id + can_access_org (cualquier miembro) + vertical licitaciones, y solo
-- devuelve las fichas de ESA organizacion (maximo 500, igual que el tope de la tabla).
create or replace function licitaciones.kyc_fichas_con_situacion(p_organization_id uuid)
returns table (
  out_id uuid,
  out_rfc text,
  out_rol text,
  out_nombre text,
  out_creada_en text,
  out_periodo text,
  out_encontrado boolean,
  out_situacion text,
  out_fecha_publicacion text
)
language plpgsql
stable
security definer
set search_path = licitaciones, despachos, core, pg_temp
as $$
declare
  v_periodo text;
begin
  if auth.uid() is null
     or p_organization_id is null
     or not licitaciones.can_access_org(p_organization_id)
     or not exists (select 1 from core.organization o where o.id = p_organization_id and o.vertical = 'licitaciones') then
    raise exception 'kyc_fichas_con_situacion: sin acceso a la organizacion' using errcode = '42501';
  end if;
  select max(i.periodo) into v_periodo from despachos.efos_ingesta i;
  return query
    select p.id, p.rfc, p.rol, p.nombre, p.created_at::text, v_periodo,
           c.situacion is not null, c.situacion,
           (case c.situacion
              when 'presunto' then c.fecha_presuncion_sat
              when 'desvirtuado' then c.fecha_desvirtuado_sat
              when 'definitivo' then c.fecha_definitivo_sat
              when 'sentencia_favorable' then c.fecha_sentencia_favorable_sat
            end)::text
      from licitaciones.kyc_party p
      left join despachos.efos_contribuyente c on c.rfc = p.rfc and c.periodo = v_periodo
     where p.organization_id = p_organization_id
     order by p.rol, p.created_at desc, p.id
     limit 500;
end;
$$;
revoke all on function licitaciones.kyc_fichas_con_situacion(uuid) from public;
grant execute on function licitaciones.kyc_fichas_con_situacion(uuid) to authenticated;
