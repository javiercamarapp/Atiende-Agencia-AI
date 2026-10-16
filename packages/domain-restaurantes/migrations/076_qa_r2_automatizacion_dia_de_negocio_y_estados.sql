-- 076 (restaurantes, QA R2 automatizacion y caos): dia de negocio (PM abre 12:00-01:00), saturacion con ventana, estados sin clic con
-- referencia de respaldo, alertas operativas nuevas, cierre del dia por dia de negocio, alertas de voz evaluadas por el sistema y
-- regreso del handoff con el agente apagado. Interno 076, prefijo de supabase/migrations 20240101000376.
--
-- Todo es CREATE OR REPLACE de funciones existentes con la MISMA firma y el MISMO tipo de retorno (no se cambia ninguna firma, tabla, policy ni
-- GRANT existente), mas dos helpers, funciones de sistema nuevas y TRES columnas aditivas (customers.import_nombre, customers.import_notas,
-- customer_addresses.from_import). Requiere: 041 (generar_cierre), 043 (avisos), 050 (autopiloto,
-- order_status_events), 023 (branch_policy), 035 (voz_kpis_diarios, voz_evaluar_alertas), 053 (whatsapp_sucursal_control).
--
-- Que corrige (ids de work/qa/restaurantes/ronda-2-defectos.json):
--   automatizacion-02  agotados_reponer / agotado_marcar usan el DIA DE NEGOCIO (la fecha local menos la hora de cierre despues de medianoche).
--   automatizacion-03  tiempo_entrega_muestras.abiertos cuenta solo pedidos de las ultimas 8 horas (antes: toda la historia).
--   automatizacion-04  listo_para_recoger sin hora_recogida pasa a no_recogido con referencia de respaldo (cuando quedo listo, desde
--                      order_status_events) y un aviso al staff (restaurantes.pedido.estancado) cubre tambien los en_camino olvidados.
--   automatizacion-05  aviso a staff para un pedido pending sin aceptar (restaurantes.pedido.sin_aceptar, 15 min).
--   automatizacion-08  generar_cierre('dia') corta en el dia de negocio, no en la medianoche calendario.
--   automatizacion-09  voz_alertas_evaluar_sistema(): evalua costo del dia y tasa de error sin que nadie apriete "evaluar".
--   automatizacion-11  tiempo_entrega_muestras: franja horaria circular (23:xx y 00:xx son vecinas) y dia de la semana de NEGOCIO.
--   caos-01            handoffs_devolver_vencidos no devuelve al agente las tomas de una sucursal con el agente apagado.
--   caos-03            no_recogido cuenta desde max(hora_recogida, momento en que quedo listo): re-marcar listo reinicia el plazo.
--   caos-07            importar_clientes corrige lo que una importacion anterior escribio (nombre, nota, domicilio predeterminado) cuando se reimporta con otro
--                      mapeo, sin pisar nada que una persona o el agente hayan cambiado despues (columnas de procedencia import_nombre/import_notas/from_import).
--   caos-10            las muestras para RECOGER excluyen pedidos con hora de recogida elegida y miden hasta listo_para_recoger.
--
-- Dia de negocio: la hora de cierre mas tardia, despues de medianoche, de los turnos de branch_policy.horario que cruzan la medianoche
-- (cierra <= abre; PM 12:00-01:00 => 1 h). Dia de negocio de un instante = (hora local - ese corte)::date. Sin horario (o sin turnos que cruzan)
-- el corte es 0 y todo se comporta como hasta hoy. Las excepciones por fecha (puentes) no cambian el corte.
--
-- Compatibilidad con la base sin migrar: ningun TypeScript NUEVO exige esta migracion. Sin ella el codigo sigue con el comportamiento anterior
-- (las funciones viejas siguen ahi); lo nuevo (voz_alertas_evaluar_sistema, tipos de aviso nuevos) cae a "no disponible aun" dentro de un
-- SAVEPOINT (runWithSavepointFallback).
--
-- Justificacion de seguridad (cada funcion y GRANT):
--  * dia_negocio_corte / dia_negocio -- helpers de solo lectura, SECURITY DEFINER con search_path fijo porque branch_policy tiene RLS (staff
--    o sistema). `revoke all` de public/anon/authenticated: NO son invocables por ningun cliente; solo las demas funciones definer (que corren
--    como propietario) las llaman. No devuelven datos de la politica, solo un intervalo / una fecha.
--  * importar_clientes -- MISMOS guards y GRANT (auth.uid() obligatorio, owner/admin/staff de ESA organizacion, huella sha-256, 1..5000 renglones, telefono de
--    10 digitos). Cambia solo el calculo: una importacion puede corregir el nombre/nota que ELLA misma escribio (el valor actual sigue siendo igual al de
--    import_nombre/import_notas) y nunca uno que una persona o el agente cambiaron despues. Las 3 columnas nuevas no llevan GRANT nuevo: authenticated solo
--    las LEE con las policies de SELECT existentes (staff de la organizacion) y solo importar_clientes (definer) las escribe.
--  * agotado_marcar, agotados_reponer, autopiloto_candidatos_estados, tiempo_entrega_muestras, handoffs_devolver_vencidos, generar_cierre,
--    avisos_operativos_candidatos -- MISMOS guards, MISMOS GRANT/REVOKE que su version anterior (staff con alcance de sucursal, o sesion de
--    sistema auth.uid() is null segun el caso); solo cambia el calculo. Ninguna acepta una organizacion/sucursal sin validarla contra core.property.
--  * voz_kpis_diarios_sistema y voz_evaluar_alertas_sistema -- copias SOLO-SISTEMA de voz_kpis_diarios / voz_evaluar_alertas generadas a partir
--    de su definicion vigente (pg_get_functiondef) cambiando unicamente: el guard (auth.uid() debe ser NULO y la sucursal debe pertenecer a la
--    organizacion declarada, si no 42501: nunca cross-tenant), el alcance del costo LLM (el sistema ve el de la organizacion) y la escritura en
--    audit_log (actor_user_id es NOT NULL: la alerta de sistema queda en voice_alert, que ya es su registro). Las funciones ORIGINALES de usuario
--    NO se tocan (siguen exigiendo owner/admin con alcance). revoke de public/anon; execute a authenticated por consistencia (la guarda interna
--    rechaza a cualquier usuario). Si el texto de la definicion origen cambia, la migracion FALLA en voz alta en vez de dejar algo a medias.
--  * voz_alertas_evaluar_sistema -- SOLO sistema (auth.uid() is null => 42501 para cualquier usuario), SECURITY DEFINER con search_path fijo,
--    revoke de public/anon, execute a authenticated por consistencia con las demas funciones de sistema (la guarda interna rechaza a un usuario).
--    Recorre voice_alert_config (tope 500 sucursales) y devuelve SOLO las alertas disparadas por primera vez; sin PII (ids, fecha y tipo).
--    No escribe audit_log (actor_user_id es NOT NULL): cada alerta queda en voice_alert.

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Dia de negocio
-- ═══════════════════════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Agotado "hasta manana" por dia de negocio (automatizacion-02)
-- ═══════════════════════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Barrido de estados sin clic: referencia de respaldo para no_recogido (automatizacion-04, caos-03)
-- ═══════════════════════════════════════════════════════════════════════════
-- listo_para_recoger -> no_recogido a los N minutos de max(hora_recogida, momento en que quedo listo). El momento en que quedo listo es el
-- ULTIMO evento a listo_para_recoger de order_status_events (re-marcar listo reinicia el plazo); sin eventos (pedidos anteriores a 050) se usa
-- created_at. Sin hora_recogida (el storefront web no la manda) cuenta solo desde que quedo listo.
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
      -- listo_para_recoger -> no_recogido a los X minutos de max(hora de recogida, cuando quedo listo) (por omision 60)
      select o.id, o.organization_id, o.property_id, o.status, 'no_recogido'::text, 'limpieza_no_recogido'::text
        from restaurantes.orders o
        left join restaurantes.autopiloto_config c on c.property_id = o.property_id
       where o.status = 'listo_para_recoger'
         and greatest(
               coalesce(o.hora_recogida, '-infinity'::timestamptz),
               coalesce((select max(e.at) from restaurantes.order_status_events e where e.order_id = o.id and e.to_status = 'listo_para_recoger'), o.created_at)
             ) <= p_ahora - make_interval(mins => coalesce(c.no_recogido_minutos, 60))
      union all
      -- pending -> preparando (aceptacion automatica, sin POS): la comanda ya se imprimio o se marco capturada
      select o.id, o.organization_id, o.property_id, o.status, 'preparando'::text, 'aceptacion_automatica'::text
        from restaurantes.orders o
        join restaurantes.autopiloto_config c on c.property_id = o.property_id and c.aceptacion_auto
       where o.status = 'pending'
         and exists (select 1 from restaurantes.pos_comanda_outbox pc
                      where pc.order_id = o.id and pc.organization_id = o.organization_id and pc.estado in ('confirmada', 'capturada_manual'))
    ) x(order_id, organization_id, property_id, from_status, to_status, motivo)
    limit least(greatest(coalesce(p_limite, 200), 1), 1000);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Muestras de tiempo de entrega y saturacion (automatizacion-03, -11, caos-10)
-- ═══════════════════════════════════════════════════════════════════════════
-- * abiertos: solo pedidos abiertos con alta en las ultimas 8 horas (un pedido olvidado de hace dias ya no satura la sucursal).
-- * franja: dia de la semana del DIA DE NEGOCIO y hora +-1 CIRCULAR (23:xx y 00:xx son vecinas).
-- * recoger: no se usan pedidos con hora de recogida elegida por el cliente (miden su espera, no la cocina) y se mide hasta el primer
--   listo_para_recoger (la cocina), no hasta que el cliente pasa; sin evento se usa delivered_at.
create or replace function restaurantes.tiempo_entrega_muestras(
  p_organization_id uuid,
  p_property_id uuid,
  p_canal text,
  p_ahora timestamptz,
  p_limite integer default 30
) returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_tz text;
  v_local timestamp;
  v_corte interval;
  v_dow integer;
  v_hora integer;
  v_muestras jsonb;
  v_abiertos integer;
begin
  if auth.uid() is null then
    if not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
      raise exception 'tiempo_entrega_muestras: sucursal ajena' using errcode = '42501';
    end if;
  elsif not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'tiempo_entrega_muestras: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if p_canal not in ('domicilio', 'recoger') then
    raise exception 'tiempo_entrega_muestras: canal invalido' using errcode = '22023';
  end if;
  v_tz := restaurantes.voz_zona_horaria(p_property_id);
  v_local := p_ahora at time zone v_tz;
  v_corte := restaurantes.dia_negocio_corte(p_property_id);
  v_dow := extract(dow from (v_local - v_corte))::integer;
  v_hora := extract(hour from v_local)::integer;
  select coalesce(jsonb_agg(m.minutos order by m.fin_entrega desc), '[]'::jsonb) into v_muestras from (
    select round((extract(epoch from (s.fin - s.inicio)) / 60.0)::numeric, 1) as minutos, s.fin_entrega
      from (
        select coalesce(o.promovido_at, o.created_at) as inicio,
               case when p_canal = 'recoger'
                    then coalesce((select min(e.at) from restaurantes.order_status_events e where e.order_id = o.id and e.to_status = 'listo_para_recoger'), o.delivered_at)
                    else o.delivered_at end as fin,
               o.delivered_at as fin_entrega
          from restaurantes.orders o
         where o.organization_id = p_organization_id and o.property_id = p_property_id
           and o.status in ('entregado', 'completado') and o.delivered_at is not null
           and o.delivered_at >= p_ahora - interval '60 days' and o.delivered_at < p_ahora
           and coalesce(o.canal, 'domicilio') = p_canal
           and (p_canal <> 'recoger' or o.hora_recogida is null)
           and extract(dow from ((coalesce(o.promovido_at, o.created_at) at time zone v_tz) - v_corte)) = v_dow
           and least(
                 abs(extract(hour from (coalesce(o.promovido_at, o.created_at) at time zone v_tz))::integer - v_hora),
                 24 - abs(extract(hour from (coalesce(o.promovido_at, o.created_at) at time zone v_tz))::integer - v_hora)
               ) <= 1
           and o.delivered_at >= coalesce(o.promovido_at, o.created_at)
      ) s
     where s.fin >= s.inicio
     order by s.fin_entrega desc
     limit least(greatest(coalesce(p_limite, 30), 1), 100)
  ) m;
  select count(*)::integer into v_abiertos from restaurantes.orders o
   where o.organization_id = p_organization_id and o.property_id = p_property_id
     and o.status in ('pending', 'preparando', 'en_camino', 'listo_para_recoger')
     and coalesce(o.promovido_at, o.created_at) >= p_ahora - interval '8 hours';
  return jsonb_build_object('muestras', v_muestras, 'abiertos', v_abiertos);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Alertas operativas: pedido sin aceptar y pedido estancado (automatizacion-04, -05)
-- ═══════════════════════════════════════════════════════════════════════════
-- Se agregan DOS tipos a avisos_operativos_candidatos (las dos alertas existentes no cambian):
--   restaurantes.pedido.sin_aceptar -- pending desde hace 15 min o mas (ultimas 24 h): nadie lo acepto (sin POS o con la aceptacion automatica apagada).
--   restaurantes.pedido.estancado   -- listo_para_recoger o en_camino desde hace 6 h o mas (hasta 72 h): el pedido nadie lo cerro. Referencia: el
--     ultimo evento al estado en order_status_events (respaldo: created_at). No cierra nada solo: lo decide una persona.
create or replace function restaurantes.avisos_operativos_candidatos(p_now timestamptz default null)
returns table (tipo text, order_id uuid, organization_id uuid, property_id uuid, order_number bigint)
language plpgsql stable security definer set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_now timestamptz := coalesce(p_now, now());
begin
  if auth.uid() is not null then
    raise exception 'avisos_operativos_candidatos es solo para la sesion de sistema' using errcode = '42501';
  end if;

  return query
  select * from (
    select 'restaurantes.pedido.entrega_tardia'::text as tipo, o.id as order_id, o.organization_id, o.property_id, o.order_number
    from restaurantes.orders o
    left join restaurantes.sucursal_avisos_config c on c.property_id = o.property_id
    where o.status in ('preparando', 'en_camino')
      and coalesce(o.estimated_delivery_at, o.hora_recogida, coalesce(o.programado_para, o.created_at) + make_interval(mins => coalesce(c.entrega_tardia_min, 45))) < v_now
      and coalesce(o.estimated_delivery_at, o.hora_recogida, coalesce(o.programado_para, o.created_at) + make_interval(mins => coalesce(c.entrega_tardia_min, 45))) > v_now - interval '24 hours'
    union all
    select 'restaurantes.pedido.programado_por_vencer'::text, o.id, o.organization_id, o.property_id, o.order_number
    from restaurantes.orders o
    where o.programado_para is not null
      and o.programado_para > v_now - interval '24 hours'
      and (
        (o.status = 'programado' and o.programado_para <= v_now + interval '20 minutes')
        or (
          o.status in ('pending', 'preparando')
          and o.assigned_repartidor_id is null
          and coalesce(o.canal, 'domicilio') <> 'recoger'
          and o.programado_para <= v_now + interval '30 minutes'
          and o.programado_para > v_now - interval '60 minutes'
        )
      )
    union all
    select 'restaurantes.pedido.sin_aceptar'::text, o.id, o.organization_id, o.property_id, o.order_number
    from restaurantes.orders o
    where o.status = 'pending'
      and coalesce(o.promovido_at, o.created_at) <= v_now - interval '15 minutes'
      and coalesce(o.promovido_at, o.created_at) > v_now - interval '24 hours'
    union all
    select 'restaurantes.pedido.estancado'::text, o.id, o.organization_id, o.property_id, o.order_number
    from restaurantes.orders o
    where o.status in ('listo_para_recoger', 'en_camino')
      and coalesce((select max(e.at) from restaurantes.order_status_events e where e.order_id = o.id and e.to_status = o.status), o.created_at) <= v_now - interval '6 hours'
      and coalesce((select max(e.at) from restaurantes.order_status_events e where e.order_id = o.id and e.to_status = o.status), o.created_at) > v_now - interval '72 hours'
  ) x
  order by x.order_number
  limit 500;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- F) Regreso del handoff: no con el agente apagado (caos-01)
-- ═══════════════════════════════════════════════════════════════════════════
-- Una toma de una sucursal con el interruptor duro del agente APAGADO (053) no vuelve al agente: nadie contestaria, el cliente quedaria sin
-- respuesta y la frase "le sigo atendiendo yo" seria falsa. La toma sigue en la bandeja de la persona.
create or replace function restaurantes.handoffs_devolver_vencidos(p_ahora timestamptz, p_limite integer default 50)
returns table (handoff_id uuid, organization_id uuid, property_id uuid, conversation_id uuid, minutos integer, avisado boolean)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  r record;
  v_pnid text;
  v_texto constant text := 'Gracias por esperar; le sigo atendiendo yo.';
  v_avisado boolean;
begin
  if auth.uid() is not null then
    raise exception 'handoffs_devolver_vencidos: solo la sesion de sistema' using errcode = '42501';
  end if;
  for r in
    select h.id as hid, h.organization_id as org, h.property_id as prop, h.conversation_id as conv, h.ultimo_cliente_at,
           c.phone, coalesce(cfg.handoff_regreso_minutos, 15) as mins,
           greatest(h.tomada_at, coalesce((
             select max(m.created_at) from restaurantes.messaging_outbox m
              where m.organization_id = h.organization_id and m.event_type = 'whatsapp.handoff_reply'
                and m.dedupe_key like 'handoff-reply:' || h.id::text || ':%'
           ), h.tomada_at)) as ultima_humana
      from restaurantes.conversation_handoff h
      join restaurantes.whatsapp_conversations c on c.id = h.conversation_id and c.organization_id = h.organization_id
      left join restaurantes.autopiloto_config cfg on cfg.property_id = h.property_id
     where h.canal = 'whatsapp' and h.estado = 'tomada' and h.tomada_at is not null
       and not exists (
         select 1 from restaurantes.whatsapp_sucursal_control w
          where w.property_id = h.property_id and w.agente_activo = false
       )
       and not exists (
         select 1 from restaurantes.solicitud_aprobacion s
           join restaurantes.orders o on o.id = s.order_id
          where s.organization_id = h.organization_id and s.estado = 'pendiente' and s.tipo = 'pedido_grande'
            and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) = right(regexp_replace(c.phone, '\D', '', 'g'), 10)
       )
     order by h.tomada_at
     limit least(greatest(coalesce(p_limite, 50), 1), 200)
     for update of h skip locked
  loop
    if r.ultima_humana > p_ahora - make_interval(mins => r.mins) then
      continue;
    end if;
    update restaurantes.conversation_handoff set estado = 'devuelta', devuelta_at = p_ahora, updated_at = p_ahora
     where id = r.hid and estado = 'tomada';
    insert into restaurantes.conversation_note (organization_id, property_id, handoff_id, autor_id, texto)
    values (r.org, r.prop, r.hid, null, 'Devuelta al agente automaticamente: sin respuesta humana en ' || r.mins::text || ' minutos.');
    v_avisado := false;
    -- La frase fija solo sale dentro de la ventana de 24 h del cliente (fuera de ella haria falta plantilla).
    if r.ultimo_cliente_at is not null and r.ultimo_cliente_at > p_ahora - interval '24 hours' then
      select b.phone_number_id into v_pnid from restaurantes.whatsapp_branch_channel b where b.property_id = r.prop;
      if v_pnid is null then
        select o.phone_number_id into v_pnid from restaurantes.whatsapp_channel_config o where o.organization_id = r.org;
      end if;
      if v_pnid is not null then
        update restaurantes.whatsapp_conversations
           set messages = messages || jsonb_build_array(jsonb_build_object('role', 'assistant', 'content', v_texto, 'autor', 'agente')),
               updated_at = p_ahora
         where id = r.conv and organization_id = r.org;
        perform restaurantes.enqueue_messaging_outbox(
          r.org, 'whatsapp', 'whatsapp.handoff_reply', 'handoff-regreso:' || r.hid::text,
          jsonb_build_object('to', r.phone, 'phone_number_id', v_pnid, 'body', v_texto)
        );
        v_avisado := true;
      end if;
    end if;
    return query select r.hid, r.org, r.prop, r.conv, r.mins, v_avisado;
  end loop;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- G) Cierre del dia por DIA DE NEGOCIO (automatizacion-08)
-- ═══════════════════════════════════════════════════════════════════════════
-- Misma funcion que 041 con una sola idea nueva: los limites del periodo (y los del comparativo y del desglose por dia de la semana) se
-- corren por el corte del dia de negocio de la sucursal, y "el periodo aun no termina" se mide contra el dia de negocio de hoy. El turno del
-- sabado que cierra a la 01:00 del domingo queda COMPLETO en el cierre del sabado.
create or replace function restaurantes.generar_cierre(
  p_organization_id uuid,
  p_property_id uuid,
  p_tipo text,
  p_fecha_inicio date,
  p_omitir_sin_actividad boolean default false
) returns table (
  creado boolean,
  id uuid,
  tipo text,
  fecha_inicio date,
  fecha_fin date,
  zona_horaria text,
  datos jsonb,
  generado_por text,
  generado_at timestamptz
)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_tz text;
  v_corte interval;
  v_fin date;
  v_ini_ts timestamptz;
  v_fin_ts timestamptz;
  v_datos jsonb;
  v_ant jsonb;
  v_comp_ini date;
  v_comp_fin date;
  v_dias jsonb;
  v_hoy date;
  v_row restaurantes.cierre_reporte;
  v_creado boolean := false;
  v_por text;
begin
  if not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
    raise exception 'generar_cierre: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if auth.uid() is null then
    v_por := 'sistema';
  else
    if not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
      raise exception 'generar_cierre: sin acceso a la sucursal' using errcode = '42501';
    end if;
    v_por := 'staff';
  end if;
  if p_tipo not in ('dia', 'semana') or p_fecha_inicio is null then
    raise exception 'generar_cierre: tipo o fecha invalidos' using errcode = '22023';
  end if;
  if p_tipo = 'semana' and extract(isodow from p_fecha_inicio) <> 1 then
    raise exception 'generar_cierre: la semana empieza en lunes' using errcode = '22023';
  end if;

  v_tz := restaurantes.voz_zona_horaria(p_property_id);
  v_corte := restaurantes.dia_negocio_corte(p_property_id);
  v_fin := case when p_tipo = 'dia' then p_fecha_inicio else p_fecha_inicio + 6 end;
  v_hoy := ((now() at time zone v_tz) - v_corte)::date;
  if v_fin >= v_hoy then
    raise exception 'generar_cierre: el periodo aun no termina en la zona de la sucursal' using errcode = '22023';
  end if;

  select * into v_row from restaurantes.cierre_reporte r where r.property_id = p_property_id and r.tipo = p_tipo and r.fecha_inicio = p_fecha_inicio;
  if not found then
    v_ini_ts := (p_fecha_inicio::timestamp + v_corte) at time zone v_tz;
    v_fin_ts := ((v_fin + 1)::timestamp + v_corte) at time zone v_tz;
    v_datos := restaurantes.cierre_agregados(p_organization_id, p_property_id, v_ini_ts, v_fin_ts);

    if p_omitir_sin_actividad and (v_datos ->> 'pedidos_totales_incl_cancelados')::int = 0 then
      return query select false, null::uuid, p_tipo, p_fecha_inicio, v_fin, v_tz, v_datos, v_por, null::timestamptz;
      return;
    end if;

    v_comp_ini := p_fecha_inicio - 7;
    v_comp_fin := case when p_tipo = 'dia' then v_comp_ini else v_comp_ini + 6 end;
    v_ant := restaurantes.cierre_agregados(
      p_organization_id, p_property_id,
      (v_comp_ini::timestamp + v_corte) at time zone v_tz, ((v_comp_fin + 1)::timestamp + v_corte) at time zone v_tz);
    v_datos := v_datos || jsonb_build_object(
      'version', 1,
      'comparativo', jsonb_build_object(
        'fecha_inicio', v_comp_ini, 'fecha_fin', v_comp_fin,
        'pedidos', v_ant -> 'pedidos', 'ventas_centavos', v_ant -> 'ventas_centavos'));

    if p_tipo = 'semana' then
      select jsonb_agg(jsonb_build_object(
               'fecha', d::date,
               'pedidos', (a -> 'pedidos'),
               'ventas_centavos', (a -> 'ventas_centavos')) order by d)
        into v_dias
        from generate_series(p_fecha_inicio::timestamp, v_fin::timestamp, interval '1 day') d
        cross join lateral restaurantes.cierre_agregados(
          p_organization_id, p_property_id,
          (d::date::timestamp + v_corte) at time zone v_tz, ((d::date + 1)::timestamp + v_corte) at time zone v_tz) a;
      v_datos := v_datos || jsonb_build_object('por_dia', v_dias);
    end if;

    insert into restaurantes.cierre_reporte (organization_id, property_id, tipo, fecha_inicio, fecha_fin, zona_horaria, datos, generado_por)
    values (p_organization_id, p_property_id, p_tipo, p_fecha_inicio, v_fin, v_tz, v_datos, v_por)
    on conflict (property_id, tipo, fecha_inicio) do nothing
    returning * into v_row;
    if found then
      v_creado := true;
    else
      select * into v_row from restaurantes.cierre_reporte r where r.property_id = p_property_id and r.tipo = p_tipo and r.fecha_inicio = p_fecha_inicio;
    end if;
  end if;

  return query select v_creado, v_row.id, v_row.tipo, v_row.fecha_inicio, v_row.fecha_fin, v_row.zona_horaria, v_row.datos, v_row.generado_por, v_row.generado_at;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- H) Alertas de voz evaluadas por el sistema (automatizacion-09)
-- ═══════════════════════════════════════════════════════════════════════════
-- voz_kpis_diarios y voz_evaluar_alertas exigen un usuario owner/admin: la sesion de sistema (auth.uid() nulo) del tick no puede usarlas.
-- Se generan sus copias SOLO-SISTEMA desde la definicion vigente (las originales no se tocan) y un barrido que las recorre.
do $patch$
declare
  v_def text;
  v_new text;
  v_guard constant text := 'if not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then';
  v_guard_sistema constant text := 'if auth.uid() is not null or not exists (select 1 from core.property pp where pp.id = p_property_id and pp.organization_id = p_organization_id) then';
begin
  v_def := pg_get_functiondef('restaurantes.voz_kpis_diarios(uuid, uuid, date, date)'::regprocedure);
  v_new := replace(v_def, 'FUNCTION restaurantes.voz_kpis_diarios(', 'FUNCTION restaurantes.voz_kpis_diarios_sistema(');
  v_new := replace(v_new, v_guard, v_guard_sistema);
  v_new := replace(v_new, 'into v_org_completa;', E'into v_org_completa;\n  v_org_completa := true;');
  if v_new = v_def or position('voz_kpis_diarios_sistema(' in v_new) = 0 or position(v_guard_sistema in v_new) = 0 or position('v_org_completa := true;' in v_new) = 0 then
    raise exception '076: la definicion de voz_kpis_diarios cambio; revisar la migracion';
  end if;
  execute v_new;
  revoke all on function restaurantes.voz_kpis_diarios_sistema(uuid, uuid, date, date) from public, anon;
  grant execute on function restaurantes.voz_kpis_diarios_sistema(uuid, uuid, date, date) to authenticated;

  v_def := pg_get_functiondef('restaurantes.voz_evaluar_alertas(uuid, uuid)'::regprocedure);
  v_new := replace(v_def, 'FUNCTION restaurantes.voz_evaluar_alertas(', 'FUNCTION restaurantes.voz_evaluar_alertas_sistema(');
  v_new := replace(v_new, v_guard, v_guard_sistema);
  v_new := replace(v_new, 'restaurantes.voz_kpis_diarios(', 'restaurantes.voz_kpis_diarios_sistema(');
  v_new := regexp_replace(v_new, 'insert into restaurantes\.audit_log[^;]*;', 'null;', 'g');
  if position('voz_evaluar_alertas_sistema(' in v_new) = 0 or position(v_guard_sistema in v_new) = 0 or position('voz_kpis_diarios_sistema(' in v_new) = 0 or position('audit_log' in v_new) <> 0 then
    raise exception '076: la definicion de voz_evaluar_alertas cambio; revisar la migracion';
  end if;
  execute v_new;
  revoke all on function restaurantes.voz_evaluar_alertas_sistema(uuid, uuid) from public, anon;
  grant execute on function restaurantes.voz_evaluar_alertas_sistema(uuid, uuid) to authenticated;
end
$patch$;

create or replace function restaurantes.voz_alertas_evaluar_sistema()
returns table (organization_id uuid, property_id uuid, fecha date, tipo text)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  r record;
  a record;
begin
  if auth.uid() is not null then
    raise exception 'voz_alertas_evaluar_sistema: solo la sesion de sistema' using errcode = '42501';
  end if;
  for r in
    select c.organization_id as org, c.property_id as prop
      from restaurantes.voice_alert_config c
     where c.umbral_costo_dia_centavos_mxn is not null or c.umbral_tasa_error_pct is not null
     order by c.property_id
     limit 500
  loop
    for a in select * from restaurantes.voz_evaluar_alertas_sistema(r.org, r.prop) e where e.nueva loop
      return query select r.org, r.prop, a.fecha, a.tipo;
    end loop;
  end loop;
end;
$$;
revoke all on function restaurantes.voz_alertas_evaluar_sistema() from public, anon;
grant execute on function restaurantes.voz_alertas_evaluar_sistema() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- I) Reimportar de cartera corrige lo que escribio una importacion anterior (caos-07)
-- ═══════════════════════════════════════════════════════════════════════════
-- Antes: importar_clientes NUNCA pisaba un nombre/nota conocido, asi que un mapeo de columnas equivocado (Nombre apuntando a Colonia) dejaba el nombre
-- malo para siempre y el agente saludaba "Hola Itzimna". Ahora la importacion recuerda lo que ella escribio (import_nombre, import_notas) y solo ese
-- valor se puede corregir: si una persona o el agente cambiaron el nombre despues, ya no coincide y NO se pisa. El domicilio importado marca
-- from_import; una reimportacion cuyo domicilio es nuevo vuelve predeterminado al nuevo si el predeterminado actual tambien vino de una importacion.
alter table restaurantes.customers add column if not exists import_nombre text;
alter table restaurantes.customers add column if not exists import_notas text;
alter table restaurantes.customers drop constraint if exists customers_import_len_check;
alter table restaurantes.customers add constraint customers_import_len_check
  check ((import_nombre is null or char_length(import_nombre) <= 120) and (import_notas is null or char_length(import_notas) <= 500));
alter table restaurantes.customer_addresses add column if not exists from_import boolean not null default false;

create or replace function restaurantes.importar_clientes(p_organization_id uuid, p_file_hash text, p_rows jsonb)
returns table (ya_importado boolean, total integer, creados integer, actualizados integer, sin_cambios integer, rechazados integer)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_import uuid;
  v_total integer;
  v_creados integer := 0;
  v_actualizados integer := 0;
  v_sin_cambios integer := 0;
  v_rechazados integer := 0;
  e jsonb;
  v_phone text;
  v_name text;
  v_address text;
  v_notes text;
  v_c restaurantes.customers%rowtype;
  v_id uuid;
  v_nombre_final text;
  v_nota_final text;
  v_n integer;
  v_vistos text[] := '{}';
begin
  if v_uid is null then
    raise exception 'importar_clientes: requiere un usuario autenticado' using errcode = '42501';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = v_uid and m.vertical_role in ('owner', 'admin', 'staff')
  ) then
    raise exception 'importar_clientes: rol sin permiso en la organizacion' using errcode = '42501';
  end if;
  if p_file_hash is null or p_file_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'importar_clientes: huella invalida' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'importar_clientes: se esperaba un arreglo de renglones' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total < 1 or v_total > 5000 then
    raise exception 'importar_clientes: entre 1 y 5000 renglones' using errcode = '22023';
  end if;

  -- Reclama la huella: el mismo archivo con el mismo mapeo dos veces (o dos peticiones simultaneas) no duplica ni vuelve a escribir.
  insert into restaurantes.customer_imports (organization_id, file_hash, created_by, total)
  values (p_organization_id, p_file_hash, v_uid, v_total)
  on conflict (organization_id, file_hash) do nothing
  returning id into v_import;
  if v_import is null then
    return query
      select true, i.total, i.creados, i.actualizados, i.sin_cambios, i.rechazados
      from restaurantes.customer_imports i
      where i.organization_id = p_organization_id and i.file_hash = p_file_hash;
    return;
  end if;

  for e in select x from jsonb_array_elements(p_rows) x loop
    if jsonb_typeof(e) <> 'object' then
      v_rechazados := v_rechazados + 1;
      continue;
    end if;
    v_phone := e->>'phone';
    if v_phone is null or v_phone !~ '^[0-9]{10}$' then
      v_rechazados := v_rechazados + 1;
      continue;
    end if;
    v_name := nullif(btrim(left(coalesce(e->>'name', ''), 120)), '');
    v_address := nullif(btrim(left(coalesce(e->>'address', ''), 300)), '');
    v_notes := nullif(btrim(left(coalesce(e->>'notes', ''), 500)), '');

    select * into v_c from restaurantes.customers c where c.organization_id = p_organization_id and c.phone = v_phone for update;
    if not found then
      insert into restaurantes.customers (organization_id, phone, name, notes, import_nombre, import_notas)
      values (p_organization_id, v_phone, v_name, v_notes, v_name, v_notes)
      on conflict (organization_id, phone) do nothing
      returning id into v_id;
      if v_id is null then
        -- Otra transaccion lo creo entre el select y el insert: no se pisa nada.
        select c.id into v_id from restaurantes.customers c where c.organization_id = p_organization_id and c.phone = v_phone;
        v_sin_cambios := v_sin_cambios + 1;
      else
        v_creados := v_creados + 1;
      end if;
    else
      v_id := v_c.id;
      -- Un valor se completa si estaba vacio y se CORRIGE solo si es el que escribio una importacion ANTERIOR y nadie lo cambio despues (un telefono
      -- repetido dentro del MISMO archivo no se corrige a si mismo: gana el primer renglon, como siempre).
      v_nombre_final := case
        when v_name is null then v_c.name
        when v_c.name is null then v_name
        when v_phone <> all (v_vistos) and v_c.import_nombre is not null and v_c.name = v_c.import_nombre then v_name
        else v_c.name end;
      v_nota_final := case
        when v_notes is null then v_c.notes
        when v_c.notes is null then v_notes
        when v_phone <> all (v_vistos) and v_c.import_notas is not null and v_c.notes = v_c.import_notas then v_notes
        else v_c.notes end;
      if v_nombre_final is distinct from v_c.name or v_nota_final is distinct from v_c.notes then
        update restaurantes.customers set
          name = v_nombre_final,
          notes = v_nota_final,
          import_nombre = case when v_nombre_final is distinct from v_c.name then v_nombre_final else import_nombre end,
          import_notas = case when v_nota_final is distinct from v_c.notes then v_nota_final else import_notas end,
          updated_at = now()
        where id = v_id;
        v_actualizados := v_actualizados + 1;
      else
        v_sin_cambios := v_sin_cambios + 1;
      end if;
    end if;

    v_vistos := v_vistos || v_phone;
    if v_address is not null then
      insert into restaurantes.customer_addresses (customer_id, address, is_default, from_import)
      values (v_id, v_address, not exists (select 1 from restaurantes.customer_addresses a where a.customer_id = v_id), true)
      on conflict (customer_id, address) do nothing;
      get diagnostics v_n = row_count;
      -- Domicilio NUEVO de esta importacion: si el predeterminado actual tambien vino de una importacion (nadie lo confirmo), pasa a ser este.
      if v_n = 1 and exists (
        select 1 from restaurantes.customer_addresses a where a.customer_id = v_id and a.is_default and a.from_import and a.address <> v_address
      ) then
        update restaurantes.customer_addresses a set is_default = (a.address = v_address) where a.customer_id = v_id;
      end if;
    end if;
  end loop;

  update restaurantes.customer_imports
  set creados = v_creados, actualizados = v_actualizados, sin_cambios = v_sin_cambios, rechazados = v_rechazados
  where id = v_import;

  return query select false, v_total, v_creados, v_actualizados, v_sin_cambios, v_rechazados;
end;
$$;
