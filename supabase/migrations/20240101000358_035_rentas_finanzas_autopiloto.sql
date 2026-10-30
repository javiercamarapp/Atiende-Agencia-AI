-- ---------------------------------------------------------------------------
-- Rentas 035 (paridad3, Rn-P3-05/06/07): cadena de dinero de rentas en piloto automatico.
--
--   A) rentas.ocupacion: codigo de confirmacion del canal y ultimos 4 digitos del telefono (los trae el feed iCal).
--   B) rentas.reserva_financiero: origen del movimiento y estado `requiere_revision` (+ trigger sobre rentas.ocupacion que lo
--      marca cuando la reserva cambia de fechas o se cancela; nunca recalcula montos).
--   C) rentas.importacion_pagos / importacion_pagos_linea: importacion idempotente del reporte de pagos de la OTA (CSV).
--   D) rentas.system_reservas_sin_movimiento: conteo por organizacion para el aviso diario de "reservas sin movimiento financiero".
--   E) Clase de retencion rentas_huesped_pii: la purga tambien pone en NULL telefono_ultimos4 (create or replace de
--      rentas.system_purge_retencion con el cuerpo vigente de 028 mas ese unico bloque).
--
-- Compatibilidad con la base sin migrar: el codigo TypeScript captura 42703/42P01 (columnas/tablas nuevas) dentro de SAVEPOINT
-- y cae al camino anterior o a un estado "no disponible aun". Esta migracion no es requisito para que el codigo viejo funcione.
--
-- Seguridad (cada pieza lleva su justificacion):
--   * Las columnas nuevas de ocupacion heredan las policies y el GRANT existentes (select/insert/update de la property); el
--     telefono_ultimos4 es PII acotada a 4 digitos, con CHECK de forma y purga por retencion.
--   * El trigger es security definer con search_path fijo y EXECUTE revocado a todos: lo dispara la propia UPDATE de ocupacion
--     (cualquier staff de calendario, que no tiene UPDATE sobre reserva_financiero por RLS) y solo toca la fila 1:1 de esa
--     ocupacion, solo para poner el flag; no acepta parametros ni es invocable.
--   * Las tablas nuevas tienen RLS por property con rentas.can_read_finanzas / can_write_finanzas (admin_gestora escribe;
--     admin_gestora y contador leen), sin `using (true)`, sin GRANT a anon. El UPDATE de lineas es a nivel COLUMNA: solo las
--     columnas que la reevaluacion de una linea pendiente necesita. No hay DELETE para authenticated.
--   * Las lineas no guardan nombre ni contacto del huesped: solo el codigo de confirmacion del canal y montos.
-- ---------------------------------------------------------------------------

-- A) Columnas de ocupacion
alter table rentas.ocupacion
  add column codigo_confirmacion text check (codigo_confirmacion is null or codigo_confirmacion ~ '^[A-Za-z0-9]{1,40}$'),
  add column telefono_ultimos4 text check (telefono_ultimos4 is null or telefono_ultimos4 ~ '^[0-9]{4}$');
create index ocupacion_codigo_confirmacion_idx on rentas.ocupacion (property_id, canal_origen_id, codigo_confirmacion) where codigo_confirmacion is not null;

-- B) reserva_financiero: origen y revision
alter table rentas.reserva_financiero
  add column origen text not null default 'manual' check (origen in ('manual', 'directa_automatica', 'importacion_csv')),
  add column requiere_revision boolean not null default false,
  add column motivo_revision text check (motivo_revision is null or motivo_revision in ('reserva_modificada', 'reserva_cancelada', 'comision_gestor_pendiente', 'discrepancia_importacion')),
  add constraint reserva_financiero_revision_coherente check (requiere_revision or motivo_revision is null);
create index reserva_financiero_revision_idx on rentas.reserva_financiero (property_id) where requiere_revision;

create function rentas.ocupacion_marcar_movimiento_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, rentas, pg_temp
as $$
begin
  update rentas.reserva_financiero rf
     set requiere_revision = true,
         motivo_revision = case when new.estado = 'cancelado' then 'reserva_cancelada' else 'reserva_modificada' end,
         updated_at = now()
   where rf.ocupacion_id = new.id;
  return null;
end;
$$;
revoke all on function rentas.ocupacion_marcar_movimiento_revision() from public, anon, authenticated;

create trigger ocupacion_marcar_movimiento_revision
  after update of rango, estado on rentas.ocupacion
  for each row
  when (old.rango is distinct from new.rango or (old.estado is distinct from new.estado and new.estado = 'cancelado'))
  execute function rentas.ocupacion_marcar_movimiento_revision();

-- C) Importacion de reportes de pagos de la OTA
create table rentas.importacion_pagos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  canal_id uuid not null references rentas.canal(id),
  archivo_sha256 text not null check (archivo_sha256 ~ '^[0-9a-f]{64}$'),
  lineas_total integer not null check (lineas_total >= 0),
  creadas integer not null default 0 check (creadas >= 0),
  conciliadas integer not null default 0 check (conciliadas >= 0),
  discrepancias integer not null default 0 check (discrepancias >= 0),
  pendientes integer not null default 0 check (pendientes >= 0),
  ya_importadas integer not null default 0 check (ya_importadas >= 0),
  ignoradas integer not null default 0 check (ignoradas >= 0),
  creado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now()
);
create index importacion_pagos_property_idx on rentas.importacion_pagos (property_id, creado_en desc);

create table rentas.importacion_pagos_linea (
  id uuid primary key default gen_random_uuid(),
  importacion_id uuid not null references rentas.importacion_pagos(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  canal_id uuid not null references rentas.canal(id),
  huella text not null check (huella ~ '^[0-9a-f]{64}$'),
  codigo_confirmacion text check (codigo_confirmacion is null or codigo_confirmacion ~ '^[A-Za-z0-9]{1,40}$'),
  tipo_linea text not null check (tipo_linea in ('reserva', 'ajuste')),
  fecha date,
  moneda char(3) not null check (moneda ~ '^[A-Z]{3}$'),
  monto_neto_centavos bigint not null,
  monto_bruto_centavos bigint,
  comision_canal_centavos bigint,
  ocupacion_id uuid references rentas.ocupacion(id) on delete set null,
  resultado text not null check (resultado in ('creada', 'conciliada', 'discrepancia', 'pendiente')),
  nota text check (nota is null or length(nota) <= 300),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  -- Idempotencia: la misma linea (misma huella) en la misma property y canal se registra una sola vez.
  unique (organization_id, property_id, canal_id, huella)
);
create index importacion_pagos_linea_pendientes_idx on rentas.importacion_pagos_linea (property_id, creado_en desc) where resultado in ('pendiente', 'discrepancia');
create index importacion_pagos_linea_importacion_idx on rentas.importacion_pagos_linea (importacion_id);

alter table rentas.importacion_pagos enable row level security;
alter table rentas.importacion_pagos_linea enable row level security;

create policy "finanzas: lectura de importacion_pagos" on rentas.importacion_pagos for select using (rentas.can_read_finanzas(property_id));
create policy "finanzas: escritura de importacion_pagos" on rentas.importacion_pagos for insert with check (rentas.can_write_finanzas(property_id));
create policy "finanzas: lectura de importacion_pagos_linea" on rentas.importacion_pagos_linea for select using (rentas.can_read_finanzas(property_id));
create policy "finanzas: escritura de importacion_pagos_linea" on rentas.importacion_pagos_linea for insert with check (rentas.can_write_finanzas(property_id));
create policy "finanzas: reevaluacion de importacion_pagos_linea" on rentas.importacion_pagos_linea for update
  using (rentas.can_write_finanzas(property_id)) with check (rentas.can_write_finanzas(property_id));

revoke all on rentas.importacion_pagos, rentas.importacion_pagos_linea from public, anon;
grant select, insert on rentas.importacion_pagos to authenticated;
grant select, insert on rentas.importacion_pagos_linea to authenticated;
-- Solo lo que cambia al reevaluar una linea pendiente cuando ya existe la reserva (o su movimiento).
grant update (ocupacion_id, resultado, nota, actualizado_en) on rentas.importacion_pagos_linea to authenticated;
grant select, insert, update, delete on rentas.importacion_pagos, rentas.importacion_pagos_linea to service_role;

-- D) Barrido de sistema del aviso "reservas confirmadas sin movimiento financiero".
-- Por que security definer: el cron corre como sesion de sistema (rol authenticated con auth.uid() NULL) y las policies de
-- rentas.reserva_financiero se evaluan con auth.uid(); sin esta funcion el barrido no veria NINGUN movimiento y reportaria como "sin
-- movimiento" todas las reservas de todas las organizaciones (falso positivo masivo). Guard auth.uid() is null: un usuario autenticado
-- no puede llamarla (42501). Devuelve solo conteos por organizacion, nunca filas ni PII. Ventana acotada a 62 dias. search_path fijo;
-- EXECUTE revocado a public y anon, concedido a authenticated porque la sesion de sistema usa ese rol.
create function rentas.system_reservas_sin_movimiento(p_desde date, p_hasta date)
returns table (organization_id uuid, cantidad integer)
language plpgsql
stable
security definer
set search_path = pg_catalog, rentas, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'rentas.system_reservas_sin_movimiento: solo la sesion de sistema (auth.uid() es NULL).' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta <= p_desde or p_hasta - p_desde > 62 then
    raise exception 'rentas.system_reservas_sin_movimiento: ventana invalida (maximo 62 dias).' using errcode = '22023';
  end if;
  return query
    select o.organization_id, count(*)::integer
      from rentas.ocupacion o
     where o.capa = 'reserva' and o.estado = 'confirmado'
       and lower(o.rango) >= p_desde and lower(o.rango) < p_hasta
       and not exists (select 1 from rentas.reserva_financiero rf where rf.ocupacion_id = o.id)
     group by o.organization_id
     order by o.organization_id;
end;
$$;
revoke all on function rentas.system_reservas_sin_movimiento(date, date) from public, anon;
grant execute on function rentas.system_reservas_sin_movimiento(date, date) to authenticated;

-- E) Purga de retencion: cuerpo vigente de 028 + bloque de telefono_ultimos4
create or replace function rentas.system_purge_retencion(p_org uuid, p_class text, p_cutoff timestamptz, p_dry boolean, p_limit integer)
returns table (out_afectadas integer, out_anonimizadas integer, out_protegidas integer)
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_dia_corte date := (p_cutoff at time zone 'UTC')::date;
  v_afectadas integer := 0;
  v_anon integer := 0;
  v_prot integer := 0;
  v_tel integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'rentas.system_purge_retencion: solo la sesion de sistema (auth.uid() es NULL).' using errcode = '42501';
  end if;
  if p_class = 'rentas_huesped_pii' then
    -- Elegible: huesped con datos, creado antes del corte y sin estancia que termine en o despues del dia de corte.
    -- Protegido (se conserva): coincide por contacto o nombre con una solicitud ARCO abierta de la organizacion.
    select count(*) into v_prot
      from rentas.guest_minimo g
     where g.organization_id = p_org and (g.nombre is not null or g.contacto is not null) and g.created_at < p_cutoff
       and not exists (select 1 from rentas.ocupacion o where o.huesped_minimo_id = g.id and upper(o.rango) >= v_dia_corte)
       and exists (
         select 1 from rentas.arco_solicitud r
          where r.organization_id = g.organization_id and r.estado in ('recibida', 'en_proceso', 'bloqueada')
            and (lower(btrim(r.solicitante_contacto)) = lower(btrim(coalesce(g.contacto, '')))
                 or lower(btrim(r.solicitante_nombre)) = lower(btrim(coalesce(g.nombre, ''))))
       );
    if p_dry then
      select count(*) into v_afectadas from (
        select 1 from rentas.guest_minimo g
         where g.organization_id = p_org and (g.nombre is not null or g.contacto is not null) and g.created_at < p_cutoff
           and not exists (select 1 from rentas.ocupacion o where o.huesped_minimo_id = g.id and upper(o.rango) >= v_dia_corte)
           and not exists (
             select 1 from rentas.arco_solicitud r
              where r.organization_id = g.organization_id and r.estado in ('recibida', 'en_proceso', 'bloqueada')
                and (lower(btrim(r.solicitante_contacto)) = lower(btrim(coalesce(g.contacto, '')))
                     or lower(btrim(r.solicitante_nombre)) = lower(btrim(coalesce(g.nombre, ''))))
           )
         order by g.created_at limit v_limit
      ) s;
    else
      with victimas as (
        select g.id from rentas.guest_minimo g
         where g.organization_id = p_org and (g.nombre is not null or g.contacto is not null) and g.created_at < p_cutoff
           and not exists (select 1 from rentas.ocupacion o where o.huesped_minimo_id = g.id and upper(o.rango) >= v_dia_corte)
           and not exists (
             select 1 from rentas.arco_solicitud r
              where r.organization_id = g.organization_id and r.estado in ('recibida', 'en_proceso', 'bloqueada')
                and (lower(btrim(r.solicitante_contacto)) = lower(btrim(coalesce(g.contacto, '')))
                     or lower(btrim(r.solicitante_nombre)) = lower(btrim(coalesce(g.nombre, ''))))
           )
         order by g.created_at limit v_limit
      ), anonimizados as (
        update rentas.guest_minimo g set nombre = null, contacto = null from victimas v where g.id = v.id returning 1
      )
      select count(*) into v_afectadas from anonimizados;
    end if;
    -- Rn-P3-05 (035): ultimos 4 digitos del telefono que el feed iCal trae por reserva (rentas.ocupacion.telefono_ultimos4).
    -- Elegible: reserva cuya salida es anterior al dia de corte. Se pone en NULL el dato; la reserva y sus montos se conservan.
    if p_dry then
      select count(*) into v_tel from (
        select 1 from rentas.ocupacion o
         where o.organization_id = p_org and o.telefono_ultimos4 is not null and upper(o.rango) < v_dia_corte
         order by o.updated_at limit v_limit
      ) s;
    else
      with victimas as (
        select o.id from rentas.ocupacion o
         where o.organization_id = p_org and o.telefono_ultimos4 is not null and upper(o.rango) < v_dia_corte
         order by o.updated_at limit v_limit
      ), limpiados as (
        update rentas.ocupacion o set telefono_ultimos4 = null from victimas v where o.id = v.id returning 1
      )
      select count(*) into v_tel from limpiados;
    end if;
    v_afectadas := v_afectadas + v_tel;
    v_anon := v_afectadas;
  elsif p_class = 'rentas_acceso_instrucciones' then
    -- Elegible: instrucciones sin tocar desde antes del corte y unidad sin reserva (no cancelada) que termine en o
    -- despues del dia de corte (nada vigente ni futuro ni reciente). No son datos de un titular: sin proteccion ARCO.
    if p_dry then
      select count(*) into v_afectadas from (
        select 1 from rentas.acceso_instruccion ai
         where ai.organization_id = p_org and ai.updated_at < p_cutoff
           and not exists (select 1 from rentas.ocupacion o where o.unidad_id = ai.unidad_id and o.capa = 'reserva' and o.estado <> 'cancelado' and upper(o.rango) >= v_dia_corte)
         order by ai.updated_at limit v_limit
      ) s;
    else
      with victimas as (
        select ai.unidad_id from rentas.acceso_instruccion ai
         where ai.organization_id = p_org and ai.updated_at < p_cutoff
           and not exists (select 1 from rentas.ocupacion o where o.unidad_id = ai.unidad_id and o.capa = 'reserva' and o.estado <> 'cancelado' and upper(o.rango) >= v_dia_corte)
         order by ai.updated_at limit v_limit
      ), borradas as (
        delete from rentas.acceso_instruccion ai using victimas v where ai.unidad_id = v.unidad_id
        returning ai.organization_id, ai.property_id, ai.unidad_id
      ), bitacora as (
        insert into rentas.acceso_instruccion_bitacora (organization_id, property_id, unidad_id, evento, actor_id)
        select b.organization_id, b.property_id, b.unidad_id, 'purga_retencion', null from borradas b returning 1
      )
      select count(*) into v_afectadas from borradas;
    end if;
  else
    raise exception 'rentas.system_purge_retencion: clase no soportada.' using errcode = '22023';
  end if;
  return query select v_afectadas, v_anon, v_prot;
end;
$$;
revoke all on function rentas.system_purge_retencion(uuid, text, timestamptz, boolean, integer) from public, anon, authenticated;
