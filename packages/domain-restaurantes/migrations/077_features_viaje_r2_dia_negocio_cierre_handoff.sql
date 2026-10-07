-- QA restaurantes ronda 2, lote features-y-viaje (QA-restaurantes-R2-features-03/05/06/07/08 y R2-viaje-02/04/05/06).
-- Correcciones por causa raiz de funciones y tablas de 005, 041 y 050; ninguna cambia una firma publica ya usada por el TypeScript
-- (solo se agregan funciones nuevas). Requiere: 005 (nearest_branch_by_colonia), 023 (branch_policy), 028 (conversation_handoff,
-- handoff_actor_en_sucursal), 035 (voz_zona_horaria), 041 (cierre_agregados), 050 (autopiloto).
--
-- Compatibilidad con la base sin migrar: el TypeScript que llama a las funciones NUEVAS (dia_negocio_sucursal_actual,
-- pedido_ticket_impreso_registrar, handoffs_pendientes_por_escalar, compensacion_codigo_disponible) cae a un vacio honesto contra una base
-- sin esta migracion (SAVEPOINT + 42883/42P01/42703). Las funciones que solo cambian de cuerpo se comportan como antes hasta aplicarla.
--
--  1) R2-features-08 (P2) nearest_branch_by_colonia exigia solo que el texto normalizado fuera subcadena de la zona (o al reves), asi que
--     'a' o 'mo' devolvian una sucursal (la arreglada en R1 era solo la copia de TypeScript). Ahora la misma regla que matchKnownZone:
--     la colonia escrita contiene la zona conocida (zona de 3 o mas letras) o la zona contiene lo escrito (fragmento de 4 o mas letras).
--     Esta funcion CONSERVA lo de 056 (prefijo 326, ya aplicada): solo zonas con lat/lng no nulos y desempate por nombre normalizado exacto antes
--     que el nombre mas largo. Un create or replace con el cuerpo anterior a 056 lo regresaria.
--     AVISO #475: 076 (prefijo 376, rama fix/qa-r2-rest-automatizacion-y-caos) redefine agotado_marcar, agotados_reponer y
--     autopiloto_candidatos_estados y define dia_negocio_corte/dia_negocio. Como 077 se aplica DESPUES, repite aqui esos cuerpos de 076 (misma regla
--     de dia de negocio y de no_recogido) y les suma lo propio (ticket impreso en la aceptacion automatica). Orden de fusion: #475 primero, luego #477.
--  2) R2-features-03 (P2) "agotado hasta manana" se reponia a la medianoche CALENDARIO, en pleno turno de PM (12:00-01:00). Nueva
--     dia_negocio_sucursal: la cola de un turno que cruza la medianoche (00:30 con turno 12:00-01:00) pertenece al dia en que el turno
--     EMPEZO (misma regla que aperturaConExcepciones de horarios.ts, con excepciones por fecha). agotado_marcar y agotados_reponer
--     comparan contra ese dia; el panel pide el dia de negocio con dia_negocio_sucursal_actual.
--  3) R2-features-05 (P2) la "aceptacion automatica sin POS" nunca podia cumplirse (exigia una comanda confirmada o capturada en el POS).
--     Nueva tabla order_ticket_impreso + pedido_ticket_impreso_registrar: el panel registra que el ticket de cocina se imprimio y el tick
--     pasa el pedido de Recibido a Preparando solo cuando la sucursal activo la regla.
--  4) R2-viaje-05 (P3) un pedido para recoger SIN hora (todo el storefront) nunca pasaba solo a no_recogido: el reloj parte de la hora de
--     recogida o, si no la hay, del momento en que quedo listo_para_recoger (su evento de historial).
--  5) R2-features-06 (P3) order_status_events.at tomaba now() (inicio de la transaccion) y el desempate era un uuid aleatorio: varias
--     transiciones de una misma transaccion salian en orden aleatorio. El trigger usa clock_timestamp() y garantiza un instante
--     estrictamente mayor al del ultimo evento del pedido.
--  6) R2-viaje-02 (P2) cierre_agregados solo contaba tiempos de status = 'entregado'; el autopiloto pasa los entregados a 'completado'
--     a las 6 horas, asi que el cierre de un dia terminado salia sin tiempos. Ahora cuenta entregado y completado.
--  7) R2-viaje-04 (P3) un pedido retenido por_aprobar contaba como venta en el cierre; ahora no (sigue en el total de pedidos del dia).
--  8) R2-viaje-06 (P2) una toma de conversacion PENDIENTE que nadie toma nunca regresaba al agente ni avisaba al owner. Nueva columna
--     conversation_handoff.escalada_at y handoffs_pendientes_por_escalar (solo sistema): marca una sola vez y devuelve las tomas que
--     llevan N minutos (handoff_regreso_minutos de la sucursal, 15 por omision) sin que nadie las tome, para avisar al owner.
--  9) R2-features-07 (P2) el codigo de compensacion (GRACIAS-XXXXXXXX) no se podia canjear por WhatsApp. compensacion_codigo_disponible
--     (solo sistema) devuelve el codigo vigente y sin usar que se emitio a ESE telefono; el servidor lo aplica solo (el modelo nunca lo ve).
--
-- Justificacion de seguridad de cada objeto (security definer SIEMPRE con search_path fijo, `revoke ... from public, anon`, ningun GRANT a
-- anon, ningun using (true)):
--  * dia_negocio_sucursal: interna (sin GRANT a authenticated): solo la llaman otras funciones security definer de este archivo. Lee horario
--    y excepciones de UNA sucursal y devuelve una fecha; ante un horario malformado cae al dia calendario (nunca rompe el tick).
--  * dia_negocio_sucursal_actual: authenticated; exige que la sucursal sea de la organizacion y que quien llama sea la sesion de sistema o
--    staff con alcance a esa sucursal (handoff_actor_en_sucursal). No revela nada mas que una fecha.
--  * order_ticket_impreso: RLS por sucursal (handoff_actor_en_sucursal) solo para SELECT; sin INSERT/UPDATE/DELETE directos para
--    authenticated: la unica escritura es pedido_ticket_impreso_registrar.
--  * pedido_ticket_impreso_registrar: exige usuario con alcance a la sucursal DEL PEDIDO (sale de la base); pedido ajeno o fuera de alcance =
--    42501 igual que inexistente (no revela existencia). Idempotente (on conflict do nothing). Solo registra pedidos en estado pending.
--  * handoffs_pendientes_por_escalar y compensacion_codigo_disponible: solo sistema (auth.uid() is null); un usuario recibe 42501 / null.
--    compensacion_codigo_disponible devuelve unicamente un codigo del telefono indicado y de la organizacion indicada.
--  * autopiloto_candidatos_estados, agotado_marcar, agotados_reponer, orders_registrar_evento_estado, cierre_agregados,
--    nearest_branch_by_colonia: create or replace con las mismas firmas, el mismo search_path y los mismos GRANT (create or replace los conserva).

-- ---------------------------------------------------------------------------
-- 1) nearest_branch_by_colonia: mismo criterio que matchKnownZone (TypeScript)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.nearest_branch_by_colonia(p_organization_id uuid, p_colonia text)
 returns table(
   property_id uuid,
   organization_id uuid,
   name text,
   slug text,
   status text,
   phone text,
   address text,
   lat numeric,
   lng numeric,
   distance_km numeric,
   recognized_zone_name text
 )
 language plpgsql
 stable
 set search_path = restaurantes, public, extensions, pg_temp
as $function$
declare
  v_zone_lat numeric;
  v_zone_lng numeric;
  v_zone_name text;
  v_input_norm text := regexp_replace(unaccent(lower(coalesce(p_colonia, ''))), '[^a-z0-9]', '', 'g');
begin
  -- Una colonia vacia o de menos de 3 letras no identifica nada: cero filas, nunca una sucursal adivinada.
  if char_length(v_input_norm) < 3 then
    return;
  end if;
  -- Solo zonas CON coordenadas (056): una colonia sin coordenadas no sirve de punto para medir distancia. Entre las que empatan, la zona cuyo
  -- nombre normalizado es EXACTAMENTE lo dicho gana; si no, la de nombre mas largo/especifico.
  select z.name, z.lat, z.lng into v_zone_name, v_zone_lat, v_zone_lng
  from restaurantes.known_zone z
  where z.organization_id = p_organization_id
    and z.lat is not null and z.lng is not null
    and char_length(regexp_replace(unaccent(lower(z.name)), '[^a-z0-9]', '', 'g')) >= 3
    and (
      -- La colonia escrita contiene la zona conocida (zona de 3 o mas letras)...
      strpos(v_input_norm, regexp_replace(unaccent(lower(z.name)), '[^a-z0-9]', '', 'g')) > 0
      -- ...o la zona contiene lo escrito (fragmento de 4 o mas letras: una o dos letras son subcadena de casi cualquier zona).
      or (char_length(v_input_norm) >= 4 and strpos(regexp_replace(unaccent(lower(z.name)), '[^a-z0-9]', '', 'g'), v_input_norm) > 0)
    )
  order by (regexp_replace(unaccent(lower(z.name)), '[^a-z0-9]', '', 'g') = v_input_norm) desc, length(z.name) desc
  limit 1;

  -- Cero-match real: ninguna zona conocida con coordenadas se parece a lo que dijo el cliente: cero filas, nunca una sucursal adivinada.
  if v_zone_lat is null then
    return;
  end if;

  return query
  select
    bd.property_id,
    p.organization_id,
    p.name,
    bd.slug,
    p.status,
    bd.phone,
    bd.address,
    bd.lat,
    bd.lng,
    round((
      6371 * acos(
        least(1, greatest(-1,
          cos(radians(v_zone_lat)) * cos(radians(bd.lat)) * cos(radians(bd.lng) - radians(v_zone_lng))
          + sin(radians(v_zone_lat)) * sin(radians(bd.lat))
        ))
      )
    )::numeric, 1) as distance_km,
    v_zone_name
  from restaurantes.branch_detail bd
  join core.property p on p.id = bd.property_id
  where bd.organization_id = p_organization_id
    and p.status = 'active'
    and bd.lat is not null and bd.lng is not null
  order by distance_km asc
  limit 1;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2) Dia de negocio de la sucursal y "agotado hasta manana"
-- ---------------------------------------------------------------------------
-- Helpers del dia de negocio: copia BYTE A BYTE de los de 076 (#475). Se repiten aqui con create or replace para que 077 no dependa de que 076
-- ya este aplicada; si 076 ya esta, no cambia nada. UNA sola definicion de dia de negocio para todo el sistema (agotados, cierre, muestras):
-- la fecha local menos la hora de cierre, despues de medianoche, de los turnos que cruzan la medianoche (PM 12:00-01:00 => 1 h).
create or replace function restaurantes.dia_negocio_corte(p_property_id uuid)
returns interval
language sql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
  select coalesce((
    select max((t.value ->> 'cierra')::time - time '00:00')
      from restaurantes.branch_policy bp,
           jsonb_array_elements(case when jsonb_typeof(bp.horario) = 'array' then bp.horario else '[]'::jsonb end) as t(value)
     where bp.property_id = p_property_id
       and jsonb_typeof(t.value) = 'object'
       and (t.value ->> 'abre') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       and (t.value ->> 'cierra') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       and (t.value ->> 'cierra') <= (t.value ->> 'abre')
  ), interval '0');
$$;
revoke all on function restaurantes.dia_negocio_corte(uuid) from public, anon, authenticated;

create or replace function restaurantes.dia_negocio(p_property_id uuid, p_instante timestamptz)
returns date
language sql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
  select ((p_instante at time zone restaurantes.voz_zona_horaria(p_property_id)) - restaurantes.dia_negocio_corte(p_property_id))::date;
$$;
revoke all on function restaurantes.dia_negocio(uuid, timestamptz) from public, anon, authenticated;

-- dia_negocio_sucursal: nombre usado por dia_negocio_sucursal_actual y por el TypeScript de este lote; delega en dia_negocio (076) para que
-- agotados y cierre no se contradigan (las excepciones por fecha no mueven el corte, igual que en 076).
create or replace function restaurantes.dia_negocio_sucursal(p_property_id uuid, p_instante timestamptz)
returns date
language sql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
  select restaurantes.dia_negocio(p_property_id, p_instante);
$$;
revoke all on function restaurantes.dia_negocio_sucursal(uuid, timestamptz) from public, anon, authenticated;

create or replace function restaurantes.dia_negocio_sucursal_actual(p_organization_id uuid, p_property_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
    raise exception 'dia_negocio_sucursal_actual: sucursal ajena' using errcode = '42501';
  end if;
  if auth.uid() is not null and not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'dia_negocio_sucursal_actual: sin acceso a la sucursal' using errcode = '42501';
  end if;
  return restaurantes.dia_negocio_sucursal(p_property_id, now());
end;
$$;
revoke all on function restaurantes.dia_negocio_sucursal_actual(uuid, uuid) from public, anon;
grant execute on function restaurantes.dia_negocio_sucursal_actual(uuid, uuid) to authenticated;

create or replace function restaurantes.agotado_marcar(p_organization_id uuid, p_property_id uuid, p_product_id uuid, p_hasta date)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_hoy date;
  v_n integer;
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'agotado_marcar: sin acceso a la sucursal' using errcode = '42501';
  end if;
  -- QA R2 features-03 / automatizacion-02: "hoy" es el dia de NEGOCIO (a las 00:30 de un turno 12:00-01:00 sigue siendo el dia que empezo ayer).
  v_hoy := restaurantes.dia_negocio(p_property_id, now());
  if p_hasta is null or p_hasta <= v_hoy or p_hasta > v_hoy + 7 then
    raise exception 'agotado_marcar: la fecha de reposicion debe ser posterior a hoy y a lo mucho en 7 dias' using errcode = '22023';
  end if;
  update restaurantes.branch_products bp set is_available = false, agotado_hasta = p_hasta, updated_at = now()
   where bp.property_id = p_property_id and bp.product_id = p_product_id
     and exists (select 1 from restaurantes.products p where p.id = bp.product_id and p.organization_id = p_organization_id);
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

create or replace function restaurantes.agotados_reponer(p_ahora timestamptz)
returns table (property_id uuid, product_id uuid, organization_id uuid, agotado_hasta date)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is not null then
    raise exception 'agotados_reponer: solo la sesion de sistema' using errcode = '42501';
  end if;
  return query
    with cand as (
      select bp.id as bid, bp.agotado_hasta as hasta
        from restaurantes.branch_products bp
       where bp.agotado_hasta is not null and bp.is_available = false
         -- QA R2 features-03: se repone al cambiar el dia de NEGOCIO (tras el cierre del turno que cruza la medianoche), no a las 00:00.
         and restaurantes.dia_negocio(bp.property_id, p_ahora) >= bp.agotado_hasta
       for update of bp skip locked
    ), upd as (
      update restaurantes.branch_products bp set is_available = true, agotado_hasta = null, updated_at = p_ahora
        from cand where bp.id = cand.bid
      returning bp.property_id as pid, bp.product_id as prid, cand.hasta
    )
    select u.pid, u.prid, (select p.organization_id from core.property p where p.id = u.pid), u.hasta from upd u;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Ticket de cocina impreso (aceptacion automatica sin POS)
-- ---------------------------------------------------------------------------
create table if not exists restaurantes.order_ticket_impreso (
  order_id uuid primary key references restaurantes.orders(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  impreso_por uuid references core.staff_user(id) on delete set null,
  impreso_at timestamptz not null default now()
);
create index if not exists order_ticket_impreso_org_prop_idx on restaurantes.order_ticket_impreso (organization_id, property_id);

alter table restaurantes.order_ticket_impreso enable row level security;
drop policy if exists "staff lee los tickets impresos de sus sucursales" on restaurantes.order_ticket_impreso;
create policy "staff lee los tickets impresos de sus sucursales" on restaurantes.order_ticket_impreso for select
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, false));
revoke all on restaurantes.order_ticket_impreso from public, anon, authenticated;
grant select on restaurantes.order_ticket_impreso to authenticated;
grant select on restaurantes.order_ticket_impreso to service_role;

create or replace function restaurantes.pedido_ticket_impreso_registrar(p_organization_id uuid, p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_prop uuid;
  v_status text;
begin
  select o.property_id, o.status into v_prop, v_status
    from restaurantes.orders o where o.id = p_order_id and o.organization_id = p_organization_id;
  if not found or auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, v_prop, false) then
    raise exception 'pedido inexistente en la organizacion o fuera de su sucursal' using errcode = '42501';
  end if;
  -- Solo importa mientras el pedido espera aceptacion; despues no hay nada que registrar.
  if v_status <> 'pending' then
    return false;
  end if;
  insert into restaurantes.order_ticket_impreso (order_id, organization_id, property_id, impreso_por)
  values (p_order_id, p_organization_id, v_prop, auth.uid())
  on conflict (order_id) do nothing;
  return true;
end;
$$;
revoke all on function restaurantes.pedido_ticket_impreso_registrar(uuid, uuid) from public, anon;
grant execute on function restaurantes.pedido_ticket_impreso_registrar(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Barrido de estados sin clic: no_recogido sin hora de recogida y aceptacion sin POS
-- ---------------------------------------------------------------------------
create or replace function restaurantes.autopiloto_candidatos_estados(p_ahora timestamptz, p_limite integer default 200)
returns table (order_id uuid, organization_id uuid, property_id uuid, from_status text, to_status text, motivo text)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is not null then
    raise exception 'autopiloto_candidatos_estados: solo la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select * from (
      -- entregado -> completado a las N horas (por sucursal; por omision 6)
      select o.id, o.organization_id, o.property_id, o.status, 'completado'::text, 'limpieza_entregado'::text
        from restaurantes.orders o
        left join restaurantes.autopiloto_config c on c.property_id = o.property_id
       where o.status = 'entregado' and o.delivered_at is not null
         and o.delivered_at <= p_ahora - make_interval(hours => coalesce(c.completado_horas, 6))
      union all
      -- listo_para_recoger -> no_recogido a los X minutos de max(hora de recogida, cuando quedo listo) (por omision 60). Cuerpo de 076 (#475,
      -- caos-03): el ULTIMO evento a listo_para_recoger (re-marcar listo reinicia el plazo); sin eventos se usa created_at. QA R2 viaje-05: sin
      -- `hora_recogida` (el storefront no la manda) cuenta solo desde que quedo listo.
      select o.id, o.organization_id, o.property_id, o.status, 'no_recogido'::text, 'limpieza_no_recogido'::text
        from restaurantes.orders o
        left join restaurantes.autopiloto_config c on c.property_id = o.property_id
       where o.status = 'listo_para_recoger'
         and greatest(
               coalesce(o.hora_recogida, '-infinity'::timestamptz),
               coalesce((select max(e.at) from restaurantes.order_status_events e where e.order_id = o.id and e.to_status = 'listo_para_recoger'), o.created_at)
             ) <= p_ahora - make_interval(mins => coalesce(c.no_recogido_minutos, 60))
      union all
      -- pending -> preparando (aceptacion automatica): la comanda ya se confirmo/capturo en el POS, o (sin POS) el ticket de cocina ya se imprimio
      select o.id, o.organization_id, o.property_id, o.status, 'preparando'::text, 'aceptacion_automatica'::text
        from restaurantes.orders o
        join restaurantes.autopiloto_config c on c.property_id = o.property_id and c.aceptacion_auto
       where o.status = 'pending'
         and (
           exists (select 1 from restaurantes.pos_comanda_outbox pc
                    where pc.order_id = o.id and pc.organization_id = o.organization_id and pc.estado in ('confirmada', 'capturada_manual'))
           or exists (select 1 from restaurantes.order_ticket_impreso t where t.order_id = o.id and t.organization_id = o.organization_id)
         )
    ) x(order_id, organization_id, property_id, from_status, to_status, motivo)
    limit least(greatest(coalesce(p_limite, 200), 1), 1000);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Historial de estados con orden estricto
-- ---------------------------------------------------------------------------
create or replace function restaurantes.orders_registrar_evento_estado()
returns trigger
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_actor text;
  v_motivo text;
  v_at timestamptz;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  if auth.uid() is not null then
    v_actor := 'staff:' || auth.uid()::text;
  else
    v_actor := coalesce(nullif(current_setting('app.actor', true), ''), 'sistema');
    if v_actor not in ('agente', 'pos', 'sistema') then
      v_actor := 'sistema';
    end if;
  end if;
  v_motivo := left(nullif(current_setting('app.motivo', true), ''), 200);
  -- QA R2 features-06: now() es el inicio de la TRANSACCION (varias transiciones comparten instante y el desempate era un uuid aleatorio).
  -- Se usa el reloj real y se exige un instante estrictamente mayor al del ultimo evento del pedido.
  v_at := greatest(
    clock_timestamp(),
    coalesce((select max(e.at) from restaurantes.order_status_events e where e.order_id = new.id), '-infinity'::timestamptz) + interval '1 microsecond'
  );
  insert into restaurantes.order_status_events (order_id, organization_id, property_id, from_status, to_status, actor, motivo, at)
  values (new.id, new.organization_id, new.property_id, case when tg_op = 'UPDATE' then old.status else null end, new.status, v_actor, v_motivo, v_at);
  return new;
end;
$$;
revoke all on function restaurantes.orders_registrar_evento_estado() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) Cierre del dia: tiempos de entrega de entregado + completado; por_aprobar no es venta
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cierre_agregados(
  p_organization_id uuid,
  p_property_id uuid,
  p_ini timestamptz,
  p_fin timestamptz
) returns jsonb
language sql
stable
set search_path = restaurantes, core, pg_temp
as $$
  with base as (
    select o.status, o.source, o.total,
           coalesce(o.promovido_at, o.created_at) as inicio,
           o.delivered_at
    from restaurantes.orders o
    where o.organization_id = p_organization_id and o.property_id = p_property_id
      and o.status <> 'programado'
      and coalesce(o.promovido_at, o.created_at) >= p_ini and coalesce(o.promovido_at, o.created_at) < p_fin
      and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) not like '0009%'
  ),
  ventas as (
    -- por_aprobar (QA R2 viaje-04): retenido sin aprobar, todavia no es venta.
    select * from base where status not in ('cancelado', 'no_recogido', 'por_aprobar')
  ),
  canales as (
    select c.canal,
           (select count(*) from ventas v where v.source = c.canal) as pedidos,
           (select coalesce(round(sum(v.total) * 100), 0) from ventas v where v.source = c.canal) as ventas_centavos,
           (select count(*) from base b where b.source = c.canal and b.status = 'cancelado') as cancelados
    from (values ('web'), ('whatsapp'), ('voice'), ('admin')) as c(canal)
  ),
  tiempos as (
    -- QA R2 viaje-02: el autopiloto pasa entregado -> completado a las N horas; el tiempo de entrega sigue siendo delivered_at - inicio.
    select count(*) as n,
           avg(extract(epoch from (delivered_at - inicio)) / 60.0) as prom,
           percentile_cont(0.5) within group (order by extract(epoch from (delivered_at - inicio)) / 60.0) as med,
           percentile_cont(0.9) within group (order by extract(epoch from (delivered_at - inicio)) / 60.0) as p90
    from base
    where status in ('entregado', 'completado') and delivered_at is not null and delivered_at >= inicio
  )
  select jsonb_build_object(
    'pedidos', (select count(*) from ventas),
    'ventas_centavos', (select coalesce(round(sum(total) * 100), 0)::bigint from ventas),
    'ticket_promedio_centavos', (select case when count(*) = 0 then null else round(sum(total) * 100 / count(*))::bigint end from ventas),
    'con_problema', (select count(*) from ventas where status = 'problema'),
    'cancelados', (select count(*) from base where status = 'cancelado'),
    'cancelados_centavos', (select coalesce(round(sum(total) * 100), 0)::bigint from base where status = 'cancelado'),
    'no_recogidos', (select count(*) from base where status = 'no_recogido'),
    'cancelacion_pct', (select case when (select count(*) from ventas) + count(*) = 0 then null
                                    else round(count(*) * 100.0 / ((select count(*) from ventas) + count(*)), 1) end
                        from base where status = 'cancelado'),
    'por_canal', (select jsonb_agg(jsonb_build_object('canal', canal, 'pedidos', pedidos, 'ventas_centavos', ventas_centavos, 'cancelados', cancelados) order by canal) from canales),
    'tiempos', (select jsonb_build_object(
                  'entregados', n,
                  'promedio_min', case when n = 0 then null else round(prom::numeric, 1) end,
                  'mediana_min', case when n = 0 then null else round(med::numeric, 1) end,
                  'p90_min', case when n = 0 then null else round(p90::numeric, 1) end) from tiempos),
    'pedidos_totales_incl_cancelados', (select count(*) from base)
  );
$$;

-- ---------------------------------------------------------------------------
-- 7) Tomas de conversacion PENDIENTES que nadie toma: aviso al owner (solo sistema)
-- ---------------------------------------------------------------------------
alter table restaurantes.conversation_handoff add column if not exists escalada_at timestamptz;

create or replace function restaurantes.handoffs_pendientes_por_escalar(p_ahora timestamptz, p_limite integer default 50)
returns table (handoff_id uuid, organization_id uuid, property_id uuid, conversation_id uuid, canal text, minutos integer)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is not null then
    raise exception 'handoffs_pendientes_por_escalar: solo la sesion de sistema' using errcode = '42501';
  end if;
  return query
    with cand as (
      select h.id as hid
        from restaurantes.conversation_handoff h
        left join restaurantes.autopiloto_config c on c.property_id = h.property_id
       where h.estado = 'pendiente' and h.escalada_at is null
         and h.solicitada_at <= p_ahora - make_interval(mins => coalesce(c.handoff_regreso_minutos, 15))
       order by h.solicitada_at
       limit least(greatest(coalesce(p_limite, 50), 1), 200)
       for update of h skip locked
    ), marc as (
      update restaurantes.conversation_handoff h set escalada_at = p_ahora
        from cand where h.id = cand.hid
      returning h.id, h.organization_id, h.property_id, h.conversation_id, h.canal, h.solicitada_at
    )
    select m.id, m.organization_id, m.property_id, m.conversation_id, m.canal,
           greatest(0, floor(extract(epoch from (p_ahora - m.solicitada_at)) / 60))::integer
      from marc m;
end;
$$;
revoke all on function restaurantes.handoffs_pendientes_por_escalar(timestamptz, integer) from public, anon;
grant execute on function restaurantes.handoffs_pendientes_por_escalar(timestamptz, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) Codigo de compensacion vigente de ESTE cliente (solo sistema)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.compensacion_codigo_disponible(p_organization_id uuid, p_phone text)
returns text
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_tel text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  v_codigo text;
begin
  -- Solo la sesion de sistema (agentes de WhatsApp y voz): un usuario nunca lee los codigos de los clientes.
  if auth.uid() is not null or char_length(v_tel) < 10 then
    return null;
  end if;
  select s.codigo_descuento into v_codigo
    from restaurantes.solicitud_aprobacion s
    join restaurantes.orders o on o.id = s.order_id and o.organization_id = s.organization_id
    join restaurantes.promotions p on p.organization_id = s.organization_id and p.code = s.codigo_descuento
   where s.organization_id = p_organization_id
     and s.tipo = 'compensacion' and s.estado = 'resuelta' and s.decision = 'descuento_proximo' and s.codigo_descuento is not null
     and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) = v_tel
     and p.is_active
     and (p.max_uses is null or p.times_used < p.max_uses)
     and (p.starts_at is null or p.starts_at <= now())
     and (p.ends_at is null or p.ends_at >= now())
   order by s.resuelta_at desc nulls last
   limit 1;
  return v_codigo;
end;
$$;
revoke all on function restaurantes.compensacion_codigo_disponible(uuid, text) from public, anon;
grant execute on function restaurantes.compensacion_codigo_disponible(uuid, text) to authenticated;
