-- 083 (restaurantes, CFO paquete 03): captura de costos y configuracion del CFO, importacion de reportes exportados de
-- SoftRestaurant (SR) y bitacora de exportaciones. Interno 083, prefijo de supabase/migrations 20240101000393.
-- Diseno: work/briefs/restaurantes-cfo/00-diseno.md (secciones 2, 3, 4.3, 4.6) y 03-sql-captura-costos-y-sr-import.md.
--
-- TODO ES NUEVO (tablas cfo_*, sr_* y funciones cfo_*, sr_*). NO se redefine ninguna funcion, tabla, columna, policy ni
-- CHECK existente: la bitacora reutiliza los entity_type que 019/044 ya admiten ('configuracion', 'exportacion'). No se
-- usa `create or replace` sobre nada preexistente.
--
-- Piezas:
--   A) restaurantes.cfo_config (una fila por organizacion) + cfo_config_leer / cfo_config_guardar (action de bitacora
--      'cfo.config_actualizada').
--   B) restaurantes.cfo_costo_captura (append-only versionado: guardar inserta una version nueva y marca la anterior con
--      reemplazado_por) + cfo_costo_guardar / cfo_costos_leer / cfo_costo_historial (bitacora 'cfo.costo_capturado').
--   C) Ingesta de SoftRestaurant por archivo exportado: sr_import_lote, sr_resumen_dia, sr_ticket + sr_importar (idempotente por
--      huella) + sr_resumen_leer / sr_lotes_listar / sr_cobertura (bitacora 'cfo.sr_importado').
--   D) restaurantes.cfo_registrar_exportacion (bitacora 'cfo.exportacion', entity_type 'exportacion').
--
-- CONTRATO DE ALCANCE (4.6 del diseno; "doble puerta"):
--   * Usuario: auth.uid() no nulo, rol owner/admin de la organizacion y, por CADA sucursal pedida,
--     restaurantes.handoff_actor_en_sucursal(org, sucursal, true) (028). Una sucursal ajena, inexistente o de otra
--     organizacion produce el MISMO 42501 ('sin acceso'). Un admin con property_ids acotado solo opera sus sucursales.
--   * Sesion de sistema (auth.uid() nulo): solo LECTURAS, y solo si cada sucursal pedida pertenece a la organizacion
--     declarada (si no, 42501). Toda ESCRITURA exige usuario (la bitacora necesita un actor; sr_importar rechaza a sistema
--     explicitamente).
--   * p_props nulo = "todas las permitidas": org completa/sistema = todas las sucursales de la organizacion; admin acotado =
--     su lista. Las filas SIN sucursal (property_id nulo: costos de organizacion, "No asignado") solo salen con p_props nulo
--     y alcance de organizacion completa o sistema; con una lista explicita nunca salen (aditividad: f(todas) = suma de
--     f({p}) + f(no asignado)).
--   * Rangos de fechas de lectura: maximo 400 dias (22023).
--
-- JUSTIFICACION DE SEGURIDAD (cada tabla, policy, GRANT y funcion):
--   * Tablas (cfo_config, cfo_costo_captura, sr_import_lote, sr_resumen_dia, sr_ticket): RLS habilitada; REVOKE ALL de
--     public/anon/authenticated/service_role; GRANT SELECT a nivel de COLUMNA a authenticated (sin created_by ni updated_by:
--     ids de staff; el "quien" solo sale por cfo_costo_historial, que es owner/admin). Policy de SELECT: owner/admin con
--     handoff_actor_en_sucursal(org, property, true); en filas con property nula esa funcion solo da true a la organizacion
--     completa. cfo_config: owner/admin de cualquier alcance. NINGUN insert/update/delete directo para nadie (migracion 065:
--     authenticated no tiene DML): toda escritura pasa por las funciones definer de abajo. Triggers (SET search_path fijo)
--     hacen las tablas de captura e importacion append-only: DELETE bloqueado y UPDATE solo para marcar el reemplazo.
--   * Funciones publicas: SECURITY DEFINER con search_path = restaurantes, core, pg_temp, REVOKE ALL de public/anon, GRANT
--     EXECUTE a authenticated (anon sin execute). DEFINER es necesario porque authenticated no tiene DML sobre estas tablas
--     (065) ni sobre audit_log (019) y porque la bitacora se escribe en el mismo acto que el cambio.
--   * Funciones internas (cfo_cap_*, cfo_resolver_alcance, cfo_config_efectiva, sr_normalizar_renglon, cfo_sr_entero,
--     triggers): sin GRANT a authenticated; solo las llaman las funciones definer (mismo propietario).
--   * sr_importar: SIN datos de cliente. Acepta solo las llaves listadas por tipo; cualquier otra llave (cliente, nombre,
--     telefono...) aborta TODA la llamada con 22023 antes de escribir nada. El nombre del archivo se limita a 120 caracteres
--     sin ruta ni caracteres de control. La bitacora guarda solo conteos, nunca contenido.
--
-- PUNTO DE ENLACE F2-P06 (cierre de periodo): cuando exista el cierre mensual, un periodo cerrado debe BLOQUEAR
-- restaurantes.cfo_costo_guardar (aqui, en la validacion del mes) y la reimportacion de SR sobre dias cerrados. Hoy no hay
-- cierre, asi que no se bloquea nada.
-- PUNTO DE ENLACE F5: sr_import_lote.origen admite 'api' (integracion con credenciales del distribuidor); en v1 solo 'archivo'.
-- PUNTO DE ENLACE F2-P01: el folio estructurado de la comanda (pos_comanda_outbox, 024) NO se toca aqui; sr_ticket.folio es el
-- folio que trae el archivo de SR y solo sirve para unicidad por sucursal.
--
-- NOTAS DE USO / RIESGOS CONOCIDOS (revision del PR #504):
--   * Huella: el servidor NO la verifica contra el contenido; la misma huella con otro contenido devuelve el lote viejo
--     (creado = false). CFO-08 debe calcularla (sha-256) sobre archivo + mapeo de columnas.
--   * Quien manda: sr_resumen_leer lee SOLO sr_resumen_dia. Un resumen_servicio que cubre un dia reemplaza el resumen vigente de
--     ese dia pero NO marca las cuentas (sr_ticket) de ese dia: el detalle de cuentas es auxiliar y puede no sumar igual que el
--     resumen mas reciente. Las cifras oficiales son las de sr_resumen_leer.
--   * Folio: la unicidad vigente es por (sucursal, folio) para siempre. Si SoftRestaurant reinicia folios (p. ej. cada anio), un
--     folio repetido en un dia no cubierto se rechazara por renglon. PENDIENTE de confirmar con el distribuidor/PM; si reinicia,
--     cambiar la unicidad a (sucursal, folio, dia) en una migracion posterior.
--   * hora_local no se valida contra dia_negocio (corte de dia de negocio, p. ej. 01:00): se guarda tal cual.
--   * cfo_costos_leer devuelve hasta 5000 filas sin cursor (el diseno 4.6 pide 200 por pagina con cursor para detalle; aqui son
--     agregados mensuales por sucursal/concepto: 5000 cubre ~27 sucursales x 9 conceptos x 20 meses). Paginar si se rebasa.
--
-- Interpretacion de los layouts de SR (INFERIDA hasta tener un archivo real; no hay documentacion publica del esquema):
--   resumen_servicio: una linea por (dia, tipo de servicio, forma de pago opcional). tickets = cuentas cobradas; bruta =
--     venta de lista; descuento; cancelado = importe de cuentas canceladas; propina (fuera de ingresos); iva (null si el
--     archivo no lo trae); neta = importe cobrado sin propina. Lineas repetidas con la misma llave dentro del mismo archivo se
--     SUMAN.
--   cuentas: una linea por cuenta. total_centavos = importe cobrado sin propina; descuento_centavos = descuento aplicado;
--     bruta de la cuenta = total + descuento. Una cuenta cancelada no suma a tickets/bruta/neta: su total va a cancelado.
--     sr_resumen_dia se DERIVA de las cuentas del mismo lote (por dia, servicio y forma de pago).
--   Campos opcionales ausentes: descuento/cancelado/propina = 0, cancelado(bool) = false, iva = null, hora = null, forma_pago =
--     null. La UI (CFO-08) debe mandar solo lo que el mapeo asistido encontro.
--
-- Requiere: 081 (cfo_validar_rango), 019 (audit_log), 028 (handoff_actor_en_sucursal), core.membership/property/organization/staff_user.

-- ═══════════════════════════════════════════════════════════════════════════
-- 0) Helpers internos de alcance (sin GRANT a authenticated)
-- ═══════════════════════════════════════════════════════════════════════════

-- Capacidad del llamador sobre una organizacion: 'sistema' | 'org' (owner/admin sin acotar) | 'acotado' | null.
create or replace function restaurantes.cfo_cap_gestor(p_organization_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_acotado boolean;
begin
  if v_uid is null then
    if exists (select 1 from core.organization o where o.id = p_organization_id) then
      return 'sistema';
    end if;
    return null;
  end if;
  select (m.property_ids is not null) into v_acotado
    from core.membership m
   where m.organization_id = p_organization_id and m.user_id = v_uid and m.vertical_role in ('owner', 'admin')
   limit 1;
  if not found then
    return null;
  end if;
  return case when v_acotado then 'acotado' else 'org' end;
end;
$$;
revoke all on function restaurantes.cfo_cap_gestor(uuid) from public, anon, authenticated;

-- Resuelve y VALIDA las sucursales pedidas. props = sucursales efectivas; incluye_sin_sucursal = si la llamada puede incluir
-- las filas con property nula ("No asignado").
create or replace function restaurantes.cfo_resolver_alcance(p_organization_id uuid, p_props uuid[], out props uuid[], out incluye_sin_sucursal boolean)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_cap text := restaurantes.cfo_cap_gestor(p_organization_id);
  v_p uuid;
begin
  if v_cap is null then
    raise exception 'cfo: sin acceso a la organizacion o sucursal' using errcode = '42501';
  end if;
  if p_props is not null then
    if cardinality(p_props) < 1 or cardinality(p_props) > 200 then
      raise exception 'cfo: la lista de sucursales debe tener entre 1 y 200 elementos' using errcode = '22023';
    end if;
    props := array(select distinct x from unnest(p_props) x where x is not null);
    if cardinality(props) <> cardinality(array(select distinct x from unnest(p_props) x)) then
      raise exception 'cfo: la lista de sucursales trae valores nulos' using errcode = '22023';
    end if;
    foreach v_p in array props loop
      if v_cap = 'sistema' then
        if not exists (select 1 from core.property p where p.id = v_p and p.organization_id = p_organization_id) then
          raise exception 'cfo: sin acceso a la organizacion o sucursal' using errcode = '42501';
        end if;
      elsif not restaurantes.handoff_actor_en_sucursal(p_organization_id, v_p, true) then
        raise exception 'cfo: sin acceso a la organizacion o sucursal' using errcode = '42501';
      end if;
    end loop;
    incluye_sin_sucursal := false;
    return;
  end if;
  if v_cap in ('sistema', 'org') then
    props := array(select p.id from core.property p where p.organization_id = p_organization_id order by p.id);
    incluye_sin_sucursal := true;
  else
    props := array(
      select distinct p.id from core.property p
        join core.membership m on m.organization_id = p_organization_id and m.user_id = auth.uid()
                              and m.vertical_role in ('owner', 'admin') and m.property_ids is not null
       where p.organization_id = p_organization_id and p.id = any (m.property_ids)
       order by p.id);
    incluye_sin_sucursal := false;
  end if;
end;
$$;
revoke all on function restaurantes.cfo_resolver_alcance(uuid, uuid[]) from public, anon, authenticated;

-- Puerta de ESCRITURA: solo usuario. property nula = organizacion completa; con property, alcance a esa sucursal.
create or replace function restaurantes.cfo_cap_escritura(p_organization_id uuid, p_property_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
    raise exception 'cfo: sin acceso a la organizacion o sucursal' using errcode = '42501';
  end if;
end;
$$;
revoke all on function restaurantes.cfo_cap_escritura(uuid, uuid) from public, anon, authenticated;

-- Rango de lectura: se REUTILIZA restaurantes.cfo_validar_rango(date, date) de la 081 (1 a 400 dias, ambos extremos); no se redefine aqui.

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Configuracion del CFO (una fila por organizacion)
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists restaurantes.cfo_config (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  frecuente_n integer not null default 3 check (frecuente_n between 1 and 20),
  frecuente_dias integer not null default 90 check (frecuente_dias between 30 and 365),
  activo_dias integer not null default 60 check (activo_dias between 7 and 365),
  perdido_dias integer not null default 120 check (perdido_dias between 14 and 730),
  promesa_min integer not null default 50 check (promesa_min between 10 and 180),
  iva_pct numeric(5, 2) not null default 16 check (iva_pct between 0 and 30),
  caida_pct numeric(5, 2) not null default 15 check (caida_pct between 1 and 100),
  ticket_baja_pct numeric(5, 2) not null default 10 check (ticket_baja_pct between 1 and 100),
  cancelacion_x_mediana numeric(5, 2) not null default 2 check (cancelacion_x_mediana between 1 and 20),
  descuento_max_pct numeric(5, 2) not null default 8 check (descuento_max_pct between 0 and 100),
  costo_agente_alza_pct numeric(6, 2) not null default 30 check (costo_agente_alza_pct between 1 and 1000),
  cierre_baja_pp numeric(5, 2) not null default 10 check (cierre_baja_pp between 1 and 100),
  entrega_p90_max_min integer not null default 60 check (entrega_p90_max_min between 5 and 600),
  sr_cuadre_verde_pct numeric(5, 2) not null default 1 check (sr_cuadre_verde_pct between 0 and 50),
  sr_cuadre_ambar_pct numeric(5, 2) not null default 3 check (sr_cuadre_ambar_pct between 0 and 100),
  sr_cuadre_verde_centavos bigint not null default 5000 check (sr_cuadre_verde_centavos between 0 and 100000000),
  comision_terminal_pct numeric(5, 2) check (comision_terminal_pct is null or comision_terminal_pct between 0 and 20),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (activo_dias < perdido_dias),
  check (sr_cuadre_verde_pct <= sr_cuadre_ambar_pct)
);

alter table restaurantes.cfo_config enable row level security;
revoke all on restaurantes.cfo_config from public, anon, authenticated, service_role;
grant select (organization_id, frecuente_n, frecuente_dias, activo_dias, perdido_dias, promesa_min, iva_pct, caida_pct, ticket_baja_pct,
              cancelacion_x_mediana, descuento_max_pct, costo_agente_alza_pct, cierre_baja_pp, entrega_p90_max_min, sr_cuadre_verde_pct,
              sr_cuadre_ambar_pct, sr_cuadre_verde_centavos, comision_terminal_pct, updated_at)
  on restaurantes.cfo_config to authenticated;

drop policy if exists "owner/admin lee la configuracion del CFO de su organizacion" on restaurantes.cfo_config;
create policy "owner/admin lee la configuracion del CFO de su organizacion" on restaurantes.cfo_config
  for select to authenticated
  using (exists (
    select 1 from core.membership m
    where m.organization_id = cfo_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
  ));

-- Fila efectiva: la guardada o los defaults (updated_at nulo = nunca guardada). UNICO lugar con los defaults de lectura; el
-- verify comprueba que coinciden con los DEFAULT de la tabla.
create or replace function restaurantes.cfo_config_efectiva(p_organization_id uuid)
returns restaurantes.cfo_config
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_row restaurantes.cfo_config;
begin
  select c.* into v_row from restaurantes.cfo_config c where c.organization_id = p_organization_id;
  if found then
    return v_row;
  end if;
  return jsonb_populate_record(null::restaurantes.cfo_config, jsonb_build_object(
    'organization_id', p_organization_id, 'frecuente_n', 3, 'frecuente_dias', 90, 'activo_dias', 60, 'perdido_dias', 120,
    'promesa_min', 50, 'iva_pct', 16, 'caida_pct', 15, 'ticket_baja_pct', 10, 'cancelacion_x_mediana', 2, 'descuento_max_pct', 8,
    'costo_agente_alza_pct', 30, 'cierre_baja_pp', 10, 'entrega_p90_max_min', 60, 'sr_cuadre_verde_pct', 1,
    'sr_cuadre_ambar_pct', 3, 'sr_cuadre_verde_centavos', 5000, 'comision_terminal_pct', null));
end;
$$;
revoke all on function restaurantes.cfo_config_efectiva(uuid) from public, anon, authenticated;

-- Lectura: owner/admin de cualquier alcance de la organizacion, o sesion de sistema (tick de alertas).
create or replace function restaurantes.cfo_config_leer(p_organization_id uuid)
returns setof restaurantes.cfo_config
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if restaurantes.cfo_cap_gestor(p_organization_id) is null then
    raise exception 'cfo_config_leer: sin acceso a la organizacion' using errcode = '42501';
  end if;
  return next restaurantes.cfo_config_efectiva(p_organization_id);
end;
$$;
revoke all on function restaurantes.cfo_config_leer(uuid) from public, anon;
grant execute on function restaurantes.cfo_config_leer(uuid) to authenticated;

-- Guardado: owner/admin con alcance de ORGANIZACION COMPLETA. p_cfg es un objeto jsonb con las llaves a cambiar (las demas
-- conservan su valor vigente o el default). Cada llave se valida (22023). Una sola fila de bitacora por guardado.
create or replace function restaurantes.cfo_config_guardar(p_organization_id uuid, p_cfg jsonb)
returns void
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  c_enteras constant text[] := array['frecuente_n', 'frecuente_dias', 'activo_dias', 'perdido_dias', 'promesa_min', 'entrega_p90_max_min', 'sr_cuadre_verde_centavos'];
  c_decimales constant text[] := array['iva_pct', 'caida_pct', 'ticket_baja_pct', 'cancelacion_x_mediana', 'descuento_max_pct',
                                       'costo_agente_alza_pct', 'cierre_baja_pp', 'sr_cuadre_verde_pct', 'sr_cuadre_ambar_pct'];
  v_old restaurantes.cfo_config;
  v_new restaurantes.cfo_config;
  v_existia boolean;
  v_k text;
  v_v jsonb;
  v_cambiadas text[];
  v_antes jsonb := '{}'::jsonb;
  v_despues jsonb := '{}'::jsonb;
begin
  perform restaurantes.cfo_cap_escritura(p_organization_id, null);
  if p_cfg is null or jsonb_typeof(p_cfg) <> 'object' then
    raise exception 'cfo_config_guardar: se esperaba un objeto' using errcode = '22023';
  end if;
  for v_k, v_v in select * from jsonb_each(p_cfg) loop
    if v_k = 'comision_terminal_pct' then
      if jsonb_typeof(v_v) not in ('number', 'null') then
        raise exception 'cfo_config_guardar: % debe ser numero o null', v_k using errcode = '22023';
      end if;
    elsif v_k = any (c_enteras) then
      if jsonb_typeof(v_v) <> 'number' or (v_v #>> '{}')::numeric <> trunc((v_v #>> '{}')::numeric) then
        raise exception 'cfo_config_guardar: % debe ser un entero', v_k using errcode = '22023';
      end if;
    elsif v_k = any (c_decimales) then
      if jsonb_typeof(v_v) <> 'number' then
        raise exception 'cfo_config_guardar: % debe ser un numero', v_k using errcode = '22023';
      end if;
    else
      raise exception 'cfo_config_guardar: llave desconocida' using errcode = '22023';
    end if;
  end loop;

  select c.* into v_old from restaurantes.cfo_config c where c.organization_id = p_organization_id for update;
  v_existia := found;
  if not v_existia then
    v_old := restaurantes.cfo_config_efectiva(p_organization_id);
  end if;
  begin
    v_new := jsonb_populate_record(v_old, p_cfg - 'organization_id');
  exception when numeric_value_out_of_range or invalid_text_representation then
    raise exception 'cfo_config_guardar: un valor excede el rango de su columna' using errcode = '22023';
  end;

  if v_new.frecuente_n not between 1 and 20 then raise exception 'cfo_config_guardar: frecuente_n fuera de rango (1..20)' using errcode = '22023'; end if;
  if v_new.frecuente_dias not between 30 and 365 then raise exception 'cfo_config_guardar: frecuente_dias fuera de rango (30..365)' using errcode = '22023'; end if;
  if v_new.activo_dias not between 7 and 365 then raise exception 'cfo_config_guardar: activo_dias fuera de rango (7..365)' using errcode = '22023'; end if;
  if v_new.perdido_dias not between 14 and 730 then raise exception 'cfo_config_guardar: perdido_dias fuera de rango (14..730)' using errcode = '22023'; end if;
  if v_new.activo_dias >= v_new.perdido_dias then raise exception 'cfo_config_guardar: activo_dias debe ser menor que perdido_dias' using errcode = '22023'; end if;
  if v_new.promesa_min not between 10 and 180 then raise exception 'cfo_config_guardar: promesa_min fuera de rango (10..180)' using errcode = '22023'; end if;
  if v_new.iva_pct not between 0 and 30 then raise exception 'cfo_config_guardar: iva_pct fuera de rango (0..30)' using errcode = '22023'; end if;
  if v_new.caida_pct not between 1 and 100 then raise exception 'cfo_config_guardar: caida_pct fuera de rango (1..100)' using errcode = '22023'; end if;
  if v_new.ticket_baja_pct not between 1 and 100 then raise exception 'cfo_config_guardar: ticket_baja_pct fuera de rango (1..100)' using errcode = '22023'; end if;
  if v_new.cancelacion_x_mediana not between 1 and 20 then raise exception 'cfo_config_guardar: cancelacion_x_mediana fuera de rango (1..20)' using errcode = '22023'; end if;
  if v_new.descuento_max_pct not between 0 and 100 then raise exception 'cfo_config_guardar: descuento_max_pct fuera de rango (0..100)' using errcode = '22023'; end if;
  if v_new.costo_agente_alza_pct not between 1 and 1000 then raise exception 'cfo_config_guardar: costo_agente_alza_pct fuera de rango (1..1000)' using errcode = '22023'; end if;
  if v_new.cierre_baja_pp not between 1 and 100 then raise exception 'cfo_config_guardar: cierre_baja_pp fuera de rango (1..100)' using errcode = '22023'; end if;
  if v_new.entrega_p90_max_min not between 5 and 600 then raise exception 'cfo_config_guardar: entrega_p90_max_min fuera de rango (5..600)' using errcode = '22023'; end if;
  if v_new.sr_cuadre_verde_pct not between 0 and 50 then raise exception 'cfo_config_guardar: sr_cuadre_verde_pct fuera de rango (0..50)' using errcode = '22023'; end if;
  if v_new.sr_cuadre_ambar_pct not between 0 and 100 then raise exception 'cfo_config_guardar: sr_cuadre_ambar_pct fuera de rango (0..100)' using errcode = '22023'; end if;
  if v_new.sr_cuadre_verde_pct > v_new.sr_cuadre_ambar_pct then raise exception 'cfo_config_guardar: sr_cuadre_verde_pct no puede superar a sr_cuadre_ambar_pct' using errcode = '22023'; end if;
  if v_new.sr_cuadre_verde_centavos not between 0 and 100000000 then raise exception 'cfo_config_guardar: sr_cuadre_verde_centavos fuera de rango (0..100000000)' using errcode = '22023'; end if;
  if v_new.comision_terminal_pct is not null and v_new.comision_terminal_pct not between 0 and 20 then raise exception 'cfo_config_guardar: comision_terminal_pct fuera de rango (0..20)' using errcode = '22023'; end if;

  select array_agg(k order by k) into v_cambiadas
    from jsonb_object_keys(p_cfg) k
   where (to_jsonb(v_new) -> k) is distinct from (to_jsonb(v_old) -> k);
  if v_existia and v_cambiadas is null then
    return;
  end if;

  if v_cambiadas is not null then
    foreach v_k in array v_cambiadas loop
      v_antes := v_antes || jsonb_build_object(v_k, to_jsonb(v_old) -> v_k);
      v_despues := v_despues || jsonb_build_object(v_k, to_jsonb(v_new) -> v_k);
    end loop;
  end if;

  insert into restaurantes.cfo_config (
    organization_id, frecuente_n, frecuente_dias, activo_dias, perdido_dias, promesa_min, iva_pct, caida_pct, ticket_baja_pct,
    cancelacion_x_mediana, descuento_max_pct, costo_agente_alza_pct, cierre_baja_pp, entrega_p90_max_min, sr_cuadre_verde_pct,
    sr_cuadre_ambar_pct, sr_cuadre_verde_centavos, comision_terminal_pct, updated_by, updated_at)
  values (
    p_organization_id, v_new.frecuente_n, v_new.frecuente_dias, v_new.activo_dias, v_new.perdido_dias, v_new.promesa_min, v_new.iva_pct,
    v_new.caida_pct, v_new.ticket_baja_pct, v_new.cancelacion_x_mediana, v_new.descuento_max_pct, v_new.costo_agente_alza_pct,
    v_new.cierre_baja_pp, v_new.entrega_p90_max_min, v_new.sr_cuadre_verde_pct, v_new.sr_cuadre_ambar_pct,
    v_new.sr_cuadre_verde_centavos, v_new.comision_terminal_pct, auth.uid(), now())
  on conflict (organization_id) do update set
    frecuente_n = excluded.frecuente_n, frecuente_dias = excluded.frecuente_dias, activo_dias = excluded.activo_dias,
    perdido_dias = excluded.perdido_dias, promesa_min = excluded.promesa_min, iva_pct = excluded.iva_pct,
    caida_pct = excluded.caida_pct, ticket_baja_pct = excluded.ticket_baja_pct, cancelacion_x_mediana = excluded.cancelacion_x_mediana,
    descuento_max_pct = excluded.descuento_max_pct, costo_agente_alza_pct = excluded.costo_agente_alza_pct,
    cierre_baja_pp = excluded.cierre_baja_pp, entrega_p90_max_min = excluded.entrega_p90_max_min,
    sr_cuadre_verde_pct = excluded.sr_cuadre_verde_pct, sr_cuadre_ambar_pct = excluded.sr_cuadre_ambar_pct,
    sr_cuadre_verde_centavos = excluded.sr_cuadre_verde_centavos, comision_terminal_pct = excluded.comision_terminal_pct,
    updated_by = auth.uid(), updated_at = now();

  insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
  values (p_organization_id, auth.uid(), 'cfo.config_actualizada', 'configuracion', p_organization_id,
          left(coalesce(array_to_string(v_cambiadas, ','), 'inicializacion'), 200), left(v_antes::text, 500), left(v_despues::text, 500));
end;
$$;
revoke all on function restaurantes.cfo_config_guardar(uuid, jsonb) from public, anon;
grant execute on function restaurantes.cfo_config_guardar(uuid, jsonb) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Trigger generico "solo se puede marcar el reemplazo" (append-only para las tablas de captura e importacion)
--   TG_ARGV[0] = columna mutable: 'reemplazado_por' (nulo -> no nulo) o 'estado' (-> 'reemplazado'). Todo lo demas inmutable.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function restaurantes.cfo_solo_marcar_reemplazo()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_col text := tg_argv[0];
begin
  if tg_op = 'DELETE' then
    -- Unica excepcion: la cascada de la baja de la organizacion o de la sucursal (operacion de plataforma). En ese momento el
    -- padre ya no existe en esta transaccion; un DELETE directo (padre vivo) se sigue rechazando.
    if not exists (select 1 from core.organization o where o.id = (to_jsonb(old) ->> 'organization_id')::uuid)
       or (to_jsonb(old) ->> 'property_id' is not null
           and not exists (select 1 from core.property p where p.id = (to_jsonb(old) ->> 'property_id')::uuid)) then
      return old;
    end if;
    raise exception 'cfo_append_only: DELETE no esta permitido sobre %.%', tg_table_schema, tg_table_name using errcode = '0A000';
  end if;
  -- Baja de un usuario: la FK created_by ON DELETE SET NULL solo anula el actor.
  if to_jsonb(new) ->> 'created_by' is null and to_jsonb(old) ->> 'created_by' is not null
     and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by') then
    return new;
  end if;
  if (to_jsonb(new) - v_col) is distinct from (to_jsonb(old) - v_col) then
    raise exception 'cfo_append_only: solo se puede marcar el reemplazo en %.%', tg_table_schema, tg_table_name using errcode = '0A000';
  end if;
  if v_col = 'reemplazado_por' and not (to_jsonb(old) ->> 'reemplazado_por' is null and to_jsonb(new) ->> 'reemplazado_por' is not null) then
    raise exception 'cfo_append_only: la version ya estaba reemplazada' using errcode = '0A000';
  end if;
  if v_col = 'estado' and not (to_jsonb(new) ->> 'estado' = 'reemplazado' and to_jsonb(old) ->> 'estado' in ('vigente', 'aplicado')) then
    raise exception 'cfo_append_only: solo se admite el paso a reemplazado' using errcode = '0A000';
  end if;
  return new;
end;
$$;
revoke all on function restaurantes.cfo_solo_marcar_reemplazo() from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Captura de costos (append-only versionado)
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists restaurantes.cfo_costo_captura (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid references core.property(id) on delete cascade,
  mes date not null check (mes = date_trunc('month', mes)::date),
  concepto text not null check (concepto in ('insumos', 'food_cost_objetivo_pct', 'nomina', 'renta', 'servicios', 'comision_terminal', 'marketing', 'mantenimiento', 'otros')),
  monto_centavos bigint check (monto_centavos is null or monto_centavos between 0 and 10000000000000),
  pct numeric(5, 2) check (pct is null or pct between 0 and 100),
  nota text check (nota is null or char_length(nota) <= 300),
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  reemplazado_por uuid references restaurantes.cfo_costo_captura(id) deferrable initially deferred,
  seq bigint generated always as identity,
  check ((monto_centavos is not null) <> (pct is not null)),
  check ((concepto = 'food_cost_objetivo_pct') = (pct is not null))
);
-- Una sola version vigente por (organizacion, sucursal o "No asignado", mes, concepto).
create unique index if not exists cfo_costo_captura_vigente_uq on restaurantes.cfo_costo_captura
  (organization_id, coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid), mes, concepto)
  where reemplazado_por is null;
create index if not exists cfo_costo_captura_lectura_idx on restaurantes.cfo_costo_captura (organization_id, mes) where reemplazado_por is null;

drop trigger if exists cfo_costo_captura_append_only_trg on restaurantes.cfo_costo_captura;
create trigger cfo_costo_captura_append_only_trg
  before update or delete on restaurantes.cfo_costo_captura
  for each row execute function restaurantes.cfo_solo_marcar_reemplazo('reemplazado_por');

alter table restaurantes.cfo_costo_captura enable row level security;
revoke all on restaurantes.cfo_costo_captura from public, anon, authenticated, service_role;
grant select (id, organization_id, property_id, mes, concepto, monto_centavos, pct, nota, created_at, reemplazado_por)
  on restaurantes.cfo_costo_captura to authenticated;
drop policy if exists "owner/admin con alcance lee los costos capturados" on restaurantes.cfo_costo_captura;
create policy "owner/admin con alcance lee los costos capturados" on restaurantes.cfo_costo_captura
  for select to authenticated
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));

-- Guardar una version nueva. property nula = organizacion ("No asignado"): exige organizacion completa.
create or replace function restaurantes.cfo_costo_guardar(
  p_organization_id uuid, p_property_id uuid, p_mes date, p_concepto text, p_monto_centavos bigint, p_pct numeric, p_nota text
)
returns uuid
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_nota text := nullif(btrim(coalesce(p_nota, '')), '');
  v_old restaurantes.cfo_costo_captura;
  v_new uuid := gen_random_uuid();
  v_prop_key uuid := coalesce(p_property_id, '00000000-0000-0000-0000-000000000000'::uuid);
begin
  perform restaurantes.cfo_cap_escritura(p_organization_id, p_property_id);
  if p_concepto is null or p_concepto not in ('insumos', 'food_cost_objetivo_pct', 'nomina', 'renta', 'servicios', 'comision_terminal', 'marketing', 'mantenimiento', 'otros') then
    raise exception 'cfo_costo_guardar: concepto invalido' using errcode = '22023';
  end if;
  if p_mes is null or p_mes <> date_trunc('month', p_mes)::date or p_mes < date '2020-01-01'
     or p_mes > (date_trunc('month', now()) + interval '24 months')::date then
    raise exception 'cfo_costo_guardar: el mes debe ser el dia 1 y estar entre 2020-01 y 24 meses adelante' using errcode = '22023';
  end if;
  if (p_monto_centavos is not null) = (p_pct is not null) then
    raise exception 'cfo_costo_guardar: manda exactamente uno de monto o porcentaje' using errcode = '22023';
  end if;
  if (p_concepto = 'food_cost_objetivo_pct') <> (p_pct is not null) then
    raise exception 'cfo_costo_guardar: el porcentaje solo aplica a food_cost_objetivo_pct (y ese concepto exige porcentaje)' using errcode = '22023';
  end if;
  if p_monto_centavos is not null and (p_monto_centavos < 0 or p_monto_centavos > 10000000000000) then
    raise exception 'cfo_costo_guardar: monto fuera de rango' using errcode = '22023';
  end if;
  if p_pct is not null and (p_pct < 0 or p_pct > 100) then
    raise exception 'cfo_costo_guardar: porcentaje fuera de rango (0..100)' using errcode = '22023';
  end if;
  if v_nota is not null and char_length(v_nota) > 300 then
    raise exception 'cfo_costo_guardar: la nota excede 300 caracteres' using errcode = '22023';
  end if;
  -- F2-P06: aqui se bloqueara guardar sobre un periodo cerrado.

  perform pg_advisory_xact_lock(hashtextextended('cfo_costo:' || p_organization_id::text || ':' || v_prop_key::text || ':' || p_mes::text || ':' || p_concepto, 0));
  select c.* into v_old from restaurantes.cfo_costo_captura c
   where c.organization_id = p_organization_id and coalesce(c.property_id, '00000000-0000-0000-0000-000000000000'::uuid) = v_prop_key
     and c.mes = p_mes and c.concepto = p_concepto and c.reemplazado_por is null;
  if found then
    update restaurantes.cfo_costo_captura set reemplazado_por = v_new where id = v_old.id;
  end if;
  insert into restaurantes.cfo_costo_captura (id, organization_id, property_id, mes, concepto, monto_centavos, pct, nota, created_by)
  values (v_new, p_organization_id, p_property_id, p_mes, p_concepto, p_monto_centavos, p_pct, v_nota, auth.uid());

  insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
  values (p_organization_id, auth.uid(), 'cfo.costo_capturado', 'configuracion', v_new,
          left(p_concepto || ' ' || p_mes::text || ' ' || coalesce(p_property_id::text, 'organizacion'), 200),
          case when v_old.id is null then null else coalesce(v_old.monto_centavos::text || 'c', v_old.pct::text || '%') end,
          coalesce(p_monto_centavos::text || 'c', p_pct::text || '%'));
  return v_new;
end;
$$;
revoke all on function restaurantes.cfo_costo_guardar(uuid, uuid, date, text, bigint, numeric, text) from public, anon;
grant execute on function restaurantes.cfo_costo_guardar(uuid, uuid, date, text, bigint, numeric, text) to authenticated;

-- Solo versiones vigentes. p_props nulo = todas las permitidas (con las filas de organizacion si el alcance es completo).
create or replace function restaurantes.cfo_costos_leer(p_organization_id uuid, p_props uuid[], p_mes_desde date, p_mes_hasta date)
returns table (id uuid, property_id uuid, mes date, concepto text, monto_centavos bigint, pct numeric, nota text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_props uuid[];
  v_nulos boolean;
begin
  perform restaurantes.cfo_validar_rango(p_mes_desde, p_mes_hasta);
  select a.props, a.incluye_sin_sucursal into v_props, v_nulos from restaurantes.cfo_resolver_alcance(p_organization_id, p_props) a;
  return query
    select c.id, c.property_id, c.mes, c.concepto, c.monto_centavos, c.pct, c.nota, c.created_at
      from restaurantes.cfo_costo_captura c
     where c.organization_id = p_organization_id and c.reemplazado_por is null
       and c.mes >= date_trunc('month', p_mes_desde)::date and c.mes <= date_trunc('month', p_mes_hasta)::date
       and ((c.property_id is not null and c.property_id = any (v_props)) or (c.property_id is null and v_nulos))
     order by c.mes, c.property_id nulls last, c.concepto
     limit 5000;
end;
$$;
revoke all on function restaurantes.cfo_costos_leer(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.cfo_costos_leer(uuid, uuid[], date, date) to authenticated;

-- Historial de versiones de un (sucursal | organizacion, mes, concepto), con quien y cuando.
create or replace function restaurantes.cfo_costo_historial(p_organization_id uuid, p_property_id uuid, p_mes date, p_concepto text)
returns table (id uuid, version integer, monto_centavos bigint, pct numeric, nota text, created_by uuid, created_at timestamptz, vigente boolean)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
    raise exception 'cfo_costo_historial: sin acceso a la organizacion o sucursal' using errcode = '42501';
  end if;
  return query
    select c.id, (row_number() over (order by c.created_at, c.seq))::integer, c.monto_centavos, c.pct, c.nota, c.created_by, c.created_at,
           (c.reemplazado_por is null)
      from restaurantes.cfo_costo_captura c
     where c.organization_id = p_organization_id and c.property_id is not distinct from p_property_id
       and c.mes = p_mes and c.concepto = p_concepto
     order by c.created_at, c.seq;
end;
$$;
revoke all on function restaurantes.cfo_costo_historial(uuid, uuid, date, text) from public, anon;
grant execute on function restaurantes.cfo_costo_historial(uuid, uuid, date, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Ingesta de SoftRestaurant por archivo exportado
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists restaurantes.sr_import_lote (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  huella text not null check (huella ~ '^[0-9a-f]{64}$'),
  tipo text not null check (tipo in ('resumen_servicio', 'cuentas')),
  nombre_archivo text not null check (char_length(nombre_archivo) between 1 and 120 and nombre_archivo !~ '[/\\[:cntrl:]]'),
  fecha_min date,
  fecha_max date,
  renglones integer not null check (renglones >= 0),
  aceptados integer not null check (aceptados >= 0),
  rechazados integer not null check (rechazados >= 0),
  estado text not null default 'aplicado' check (estado in ('aplicado', 'reemplazado')),
  origen text not null default 'archivo' check (origen in ('archivo', 'api')),
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, huella),
  unique (id, organization_id, property_id)
);
create index if not exists sr_import_lote_prop_idx on restaurantes.sr_import_lote (property_id, created_at desc);

create table if not exists restaurantes.sr_resumen_dia (
  id uuid primary key default gen_random_uuid(),
  lote_id uuid not null,
  organization_id uuid not null,
  property_id uuid not null,
  dia_negocio date not null,
  tipo_servicio text not null check (tipo_servicio in ('comedor', 'para_llevar', 'domicilio', 'rapido', 'otro')),
  forma_pago text check (forma_pago is null or (char_length(forma_pago) between 1 and 40 and forma_pago = lower(forma_pago))),
  tickets bigint not null check (tickets >= 0),
  bruta_centavos bigint not null check (bruta_centavos >= 0),
  descuento_centavos bigint not null check (descuento_centavos >= 0),
  cancelado_centavos bigint not null check (cancelado_centavos >= 0),
  propina_centavos bigint not null check (propina_centavos >= 0),
  iva_centavos bigint check (iva_centavos is null or iva_centavos >= 0),
  neta_centavos bigint not null check (neta_centavos >= 0),
  estado text not null default 'vigente' check (estado in ('vigente', 'reemplazado')),
  foreign key (lote_id, organization_id, property_id) references restaurantes.sr_import_lote (id, organization_id, property_id) on delete cascade
);
create unique index if not exists sr_resumen_dia_vigente_uq on restaurantes.sr_resumen_dia
  (property_id, dia_negocio, tipo_servicio, coalesce(forma_pago, '')) where estado = 'vigente';
create index if not exists sr_resumen_dia_lectura_idx on restaurantes.sr_resumen_dia (property_id, dia_negocio) where estado = 'vigente';
create index if not exists sr_resumen_dia_lote_idx on restaurantes.sr_resumen_dia (lote_id);

create table if not exists restaurantes.sr_ticket (
  id uuid primary key default gen_random_uuid(),
  lote_id uuid not null,
  organization_id uuid not null,
  property_id uuid not null,
  folio text not null check (char_length(folio) between 1 and 40 and folio !~ '[[:cntrl:]]'),
  dia_negocio date not null,
  hora_local time,
  tipo_servicio text not null check (tipo_servicio in ('comedor', 'para_llevar', 'domicilio', 'rapido', 'otro')),
  total_centavos bigint not null check (total_centavos >= 0),
  descuento_centavos bigint not null check (descuento_centavos >= 0),
  propina_centavos bigint not null check (propina_centavos >= 0),
  forma_pago text check (forma_pago is null or (char_length(forma_pago) between 1 and 40 and forma_pago = lower(forma_pago))),
  cancelado boolean not null default false,
  estado text not null default 'vigente' check (estado in ('vigente', 'reemplazado')),
  foreign key (lote_id, organization_id, property_id) references restaurantes.sr_import_lote (id, organization_id, property_id) on delete cascade
);
create unique index if not exists sr_ticket_folio_vigente_uq on restaurantes.sr_ticket (property_id, folio) where estado = 'vigente';
create index if not exists sr_ticket_dia_idx on restaurantes.sr_ticket (property_id, dia_negocio) where estado = 'vigente';
create index if not exists sr_ticket_lote_idx on restaurantes.sr_ticket (lote_id);

drop trigger if exists sr_import_lote_append_only_trg on restaurantes.sr_import_lote;
create trigger sr_import_lote_append_only_trg before update or delete on restaurantes.sr_import_lote
  for each row execute function restaurantes.cfo_solo_marcar_reemplazo('estado');
drop trigger if exists sr_resumen_dia_append_only_trg on restaurantes.sr_resumen_dia;
create trigger sr_resumen_dia_append_only_trg before update or delete on restaurantes.sr_resumen_dia
  for each row execute function restaurantes.cfo_solo_marcar_reemplazo('estado');
drop trigger if exists sr_ticket_append_only_trg on restaurantes.sr_ticket;
create trigger sr_ticket_append_only_trg before update or delete on restaurantes.sr_ticket
  for each row execute function restaurantes.cfo_solo_marcar_reemplazo('estado');

alter table restaurantes.sr_import_lote enable row level security;
alter table restaurantes.sr_resumen_dia enable row level security;
alter table restaurantes.sr_ticket enable row level security;
revoke all on restaurantes.sr_import_lote from public, anon, authenticated, service_role;
revoke all on restaurantes.sr_resumen_dia from public, anon, authenticated, service_role;
revoke all on restaurantes.sr_ticket from public, anon, authenticated, service_role;
grant select (id, organization_id, property_id, huella, tipo, nombre_archivo, fecha_min, fecha_max, renglones, aceptados, rechazados, estado, origen, created_at)
  on restaurantes.sr_import_lote to authenticated;
grant select (id, lote_id, organization_id, property_id, dia_negocio, tipo_servicio, forma_pago, tickets, bruta_centavos, descuento_centavos,
              cancelado_centavos, propina_centavos, iva_centavos, neta_centavos, estado)
  on restaurantes.sr_resumen_dia to authenticated;
grant select (id, lote_id, organization_id, property_id, folio, dia_negocio, hora_local, tipo_servicio, total_centavos, descuento_centavos,
              propina_centavos, forma_pago, cancelado, estado)
  on restaurantes.sr_ticket to authenticated;

drop policy if exists "owner/admin con alcance lee los lotes de SoftRestaurant" on restaurantes.sr_import_lote;
create policy "owner/admin con alcance lee los lotes de SoftRestaurant" on restaurantes.sr_import_lote
  for select to authenticated using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));
drop policy if exists "owner/admin con alcance lee el resumen de SoftRestaurant" on restaurantes.sr_resumen_dia;
create policy "owner/admin con alcance lee el resumen de SoftRestaurant" on restaurantes.sr_resumen_dia
  for select to authenticated using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));
drop policy if exists "owner/admin con alcance lee las cuentas de SoftRestaurant" on restaurantes.sr_ticket;
create policy "owner/admin con alcance lee las cuentas de SoftRestaurant" on restaurantes.sr_ticket
  for select to authenticated using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));

-- Entero no negativo desde un jsonb numerico (nulo si no es un numero entero valido o excede el maximo).
create or replace function restaurantes.cfo_sr_entero(p_valor jsonb, p_max bigint)
returns bigint
language plpgsql
immutable
set search_path = restaurantes, pg_temp
as $$
declare
  v numeric;
begin
  if p_valor is null or jsonb_typeof(p_valor) <> 'number' then
    return null;
  end if;
  v := (p_valor #>> '{}')::numeric;
  if v < 0 or v <> trunc(v) or v > p_max then
    return null;
  end if;
  return v::bigint;
end;
$$;
revoke all on function restaurantes.cfo_sr_entero(jsonb, bigint) from public, anon, authenticated;

-- Normaliza y valida UN renglon. Devuelve el objeto normalizado o {"error": {"campo", "motivo"}}. No lee tablas.
create or replace function restaurantes.sr_normalizar_renglon(p_tipo text, p_row jsonb)
returns jsonb
language plpgsql
stable
set search_path = restaurantes, pg_temp
as $$
declare
  c_max constant bigint := 1000000000000; -- 10 mil millones de pesos en centavos
  v_dia date;
  v_serv text;
  v_pago text;
  v_hora text;
  v_folio text;
  v_tickets bigint;
  v_bruta bigint;
  v_desc bigint;
  v_canc bigint;
  v_prop bigint;
  v_iva bigint;
  v_neta bigint;
  v_total bigint;
  v_cancelado boolean;
begin
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    return jsonb_build_object('error', jsonb_build_object('campo', 'renglon', 'motivo', 'el renglon no es un objeto'));
  end if;

  if coalesce(jsonb_typeof(p_row -> 'dia_negocio'), '') <> 'string' or (p_row ->> 'dia_negocio') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return jsonb_build_object('error', jsonb_build_object('campo', 'dia_negocio', 'motivo', 'fecha invalida (AAAA-MM-DD)'));
  end if;
  begin
    v_dia := (p_row ->> 'dia_negocio')::date;
  exception when others then
    return jsonb_build_object('error', jsonb_build_object('campo', 'dia_negocio', 'motivo', 'fecha invalida (AAAA-MM-DD)'));
  end;
  if v_dia < date '2015-01-01' or v_dia > current_date + 1 then
    return jsonb_build_object('error', jsonb_build_object('campo', 'dia_negocio', 'motivo', 'fecha fuera de rango'));
  end if;

  if coalesce(jsonb_typeof(p_row -> 'tipo_servicio'), '') <> 'string' then
    return jsonb_build_object('error', jsonb_build_object('campo', 'tipo_servicio', 'motivo', 'falta el tipo de servicio'));
  end if;
  v_serv := lower(btrim(p_row ->> 'tipo_servicio'));
  if v_serv not in ('comedor', 'para_llevar', 'domicilio', 'rapido', 'otro') then
    return jsonb_build_object('error', jsonb_build_object('campo', 'tipo_servicio', 'motivo', 'tipo de servicio desconocido'));
  end if;

  if p_row ? 'forma_pago' and jsonb_typeof(p_row -> 'forma_pago') <> 'null' then
    if jsonb_typeof(p_row -> 'forma_pago') <> 'string' then
      return jsonb_build_object('error', jsonb_build_object('campo', 'forma_pago', 'motivo', 'debe ser texto'));
    end if;
    v_pago := nullif(lower(btrim(p_row ->> 'forma_pago')), '');
    if v_pago is not null and (char_length(v_pago) > 40 or v_pago ~ '[[:cntrl:]]') then
      return jsonb_build_object('error', jsonb_build_object('campo', 'forma_pago', 'motivo', 'texto invalido o mayor a 40 caracteres'));
    end if;
  end if;

  if p_tipo = 'resumen_servicio' then
    v_tickets := restaurantes.cfo_sr_entero(p_row -> 'tickets', 10000000);
    v_bruta := restaurantes.cfo_sr_entero(p_row -> 'bruta_centavos', c_max);
    v_neta := restaurantes.cfo_sr_entero(p_row -> 'neta_centavos', c_max);
    if v_tickets is null then
      return jsonb_build_object('error', jsonb_build_object('campo', 'tickets', 'motivo', 'entero >= 0 requerido'));
    end if;
    if v_bruta is null then
      return jsonb_build_object('error', jsonb_build_object('campo', 'bruta_centavos', 'motivo', 'entero >= 0 requerido (centavos)'));
    end if;
    if v_neta is null then
      return jsonb_build_object('error', jsonb_build_object('campo', 'neta_centavos', 'motivo', 'entero >= 0 requerido (centavos)'));
    end if;
    v_desc := case when p_row ? 'descuento_centavos' then restaurantes.cfo_sr_entero(p_row -> 'descuento_centavos', c_max) else 0 end;
    v_canc := case when p_row ? 'cancelado_centavos' then restaurantes.cfo_sr_entero(p_row -> 'cancelado_centavos', c_max) else 0 end;
    v_prop := case when p_row ? 'propina_centavos' then restaurantes.cfo_sr_entero(p_row -> 'propina_centavos', c_max) else 0 end;
    if v_desc is null then
      return jsonb_build_object('error', jsonb_build_object('campo', 'descuento_centavos', 'motivo', 'entero >= 0 (centavos)'));
    end if;
    if v_canc is null then
      return jsonb_build_object('error', jsonb_build_object('campo', 'cancelado_centavos', 'motivo', 'entero >= 0 (centavos)'));
    end if;
    if v_prop is null then
      return jsonb_build_object('error', jsonb_build_object('campo', 'propina_centavos', 'motivo', 'entero >= 0 (centavos)'));
    end if;
    if p_row ? 'iva_centavos' and jsonb_typeof(p_row -> 'iva_centavos') <> 'null' then
      v_iva := restaurantes.cfo_sr_entero(p_row -> 'iva_centavos', c_max);
      if v_iva is null then
        return jsonb_build_object('error', jsonb_build_object('campo', 'iva_centavos', 'motivo', 'entero >= 0 (centavos) o null'));
      end if;
    end if;
    return jsonb_build_object('dia', v_dia, 'serv', v_serv, 'pago', v_pago, 'tickets', v_tickets, 'bruta', v_bruta, 'desc', v_desc,
                              'canc', v_canc, 'prop', v_prop, 'iva', v_iva, 'neta', v_neta);
  end if;

  -- cuentas
  if jsonb_typeof(p_row -> 'folio') = 'number' then
    if (p_row ->> 'folio') !~ '^[0-9]{1,15}$' then
      return jsonb_build_object('error', jsonb_build_object('campo', 'folio', 'motivo', 'folio numerico invalido'));
    end if;
    v_folio := p_row ->> 'folio';
  elsif jsonb_typeof(p_row -> 'folio') = 'string' then
    v_folio := btrim(p_row ->> 'folio');
  end if;
  if v_folio is null or char_length(v_folio) not between 1 and 40 or v_folio ~ '[[:cntrl:]]' then
    return jsonb_build_object('error', jsonb_build_object('campo', 'folio', 'motivo', 'folio requerido de 1 a 40 caracteres'));
  end if;
  v_total := restaurantes.cfo_sr_entero(p_row -> 'total_centavos', c_max);
  if v_total is null then
    return jsonb_build_object('error', jsonb_build_object('campo', 'total_centavos', 'motivo', 'entero >= 0 requerido (centavos)'));
  end if;
  v_desc := case when p_row ? 'descuento_centavos' then restaurantes.cfo_sr_entero(p_row -> 'descuento_centavos', c_max) else 0 end;
  v_prop := case when p_row ? 'propina_centavos' then restaurantes.cfo_sr_entero(p_row -> 'propina_centavos', c_max) else 0 end;
  if v_desc is null then
    return jsonb_build_object('error', jsonb_build_object('campo', 'descuento_centavos', 'motivo', 'entero >= 0 (centavos)'));
  end if;
  if v_prop is null then
    return jsonb_build_object('error', jsonb_build_object('campo', 'propina_centavos', 'motivo', 'entero >= 0 (centavos)'));
  end if;
  if p_row ? 'hora_local' and jsonb_typeof(p_row -> 'hora_local') <> 'null' then
    v_hora := case when jsonb_typeof(p_row -> 'hora_local') = 'string' then p_row ->> 'hora_local' end;
    if v_hora is null or v_hora !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then
      return jsonb_build_object('error', jsonb_build_object('campo', 'hora_local', 'motivo', 'hora invalida (HH:MM)'));
    end if;
  end if;
  v_cancelado := false;
  if p_row ? 'cancelado' and jsonb_typeof(p_row -> 'cancelado') <> 'null' then
    if jsonb_typeof(p_row -> 'cancelado') <> 'boolean' then
      return jsonb_build_object('error', jsonb_build_object('campo', 'cancelado', 'motivo', 'debe ser verdadero o falso'));
    end if;
    v_cancelado := (p_row ->> 'cancelado')::boolean;
  end if;
  return jsonb_build_object('folio', v_folio, 'dia', v_dia, 'hora', v_hora, 'serv', v_serv, 'total', v_total, 'desc', v_desc,
                            'prop', v_prop, 'pago', v_pago, 'canc', v_cancelado);
end;
$$;
revoke all on function restaurantes.sr_normalizar_renglon(text, jsonb) from public, anon, authenticated;

-- Importar un reporte exportado de SoftRestaurant (una sucursal por archivo). Solo usuario owner/admin con alcance a la
-- sucursal (la sesion de sistema recibe 42501). Idempotente por (organizacion, huella): el mismo archivo devuelve el lote
-- existente con creado = false y no escribe nada.
--   aceptados/rechazados cuentan renglones; errores = hasta 50 {renglon, campo, motivo} sin contenido del archivo.
--   Si NINGUN renglon es valido no se crea lote (lote_id nulo, creado = false).
create or replace function restaurantes.sr_importar(
  p_organization_id uuid, p_property_id uuid, p_huella text, p_tipo text, p_nombre_archivo text, p_renglones jsonb
)
returns table (lote_id uuid, creado boolean, aceptados integer, rechazados integer, errores jsonb)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  c_llaves_resumen constant text[] := array['dia_negocio', 'tipo_servicio', 'forma_pago', 'tickets', 'bruta_centavos', 'descuento_centavos',
                                            'cancelado_centavos', 'propina_centavos', 'iva_centavos', 'neta_centavos'];
  c_llaves_cuentas constant text[] := array['folio', 'dia_negocio', 'hora_local', 'tipo_servicio', 'total_centavos', 'descuento_centavos',
                                            'propina_centavos', 'forma_pago', 'cancelado'];
  v_total integer;
  v_max integer;
  v_llaves text[];
  v_mala integer;
  v_lote restaurantes.sr_import_lote;
  v_norm jsonb;
  v_ok jsonb;
  v_dias date[];
  v_rech integer;
  v_acep integer;
  v_errores jsonb;
  v_id uuid;
  v_viejos uuid[];
begin
  if auth.uid() is null then
    raise exception 'sr_importar: requiere un usuario autenticado (la sesion de sistema no importa)' using errcode = '42501';
  end if;
  perform restaurantes.cfo_cap_escritura(p_organization_id, p_property_id);
  if p_property_id is null then
    raise exception 'sr_importar: la sucursal es obligatoria (un archivo = una sucursal)' using errcode = '22023';
  end if;
  if p_huella is null or p_huella !~ '^[0-9a-f]{64}$' then
    raise exception 'sr_importar: huella invalida (sha-256 hexadecimal en minusculas)' using errcode = '22023';
  end if;
  if p_tipo is null or p_tipo not in ('resumen_servicio', 'cuentas') then
    raise exception 'sr_importar: tipo invalido' using errcode = '22023';
  end if;
  if p_nombre_archivo is null or char_length(p_nombre_archivo) not between 1 and 120 or p_nombre_archivo ~ '[/\\[:cntrl:]]' then
    raise exception 'sr_importar: nombre de archivo invalido (1 a 120 caracteres, sin ruta)' using errcode = '22023';
  end if;
  if p_renglones is null or jsonb_typeof(p_renglones) <> 'array' then
    raise exception 'sr_importar: se esperaba un arreglo de renglones' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_renglones);
  v_max := case when p_tipo = 'cuentas' then 20000 else 2000 end;
  if v_total < 1 or v_total > v_max then
    raise exception 'sr_importar: entre 1 y % renglones para %', v_max, p_tipo using errcode = '22023';
  end if;

  -- Idempotencia por huella (serializa dos peticiones simultaneas del mismo archivo).
  -- Una importacion a la vez por sucursal (dos archivos distintos sobre los mismos dias no se pisan); luego, por huella.
  perform pg_advisory_xact_lock(hashtextextended('sr_importar_sucursal:' || p_property_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('sr_importar:' || p_organization_id::text || ':' || p_huella, 0));
  select l.* into v_lote from restaurantes.sr_import_lote l where l.organization_id = p_organization_id and l.huella = p_huella;
  if found then
    if v_lote.property_id <> p_property_id then
      raise exception 'sr_importar: ese archivo ya se importo para otra sucursal' using errcode = '22023';
    end if;
    return query select v_lote.id, false, v_lote.aceptados, v_lote.rechazados, '[]'::jsonb;
    return;
  end if;

  -- Llaves desconocidas (cliente, nombre, telefono...) abortan TODO antes de escribir.
  v_llaves := case p_tipo when 'cuentas' then c_llaves_cuentas else c_llaves_resumen end;
  select (t.ord)::integer into v_mala
    from jsonb_array_elements(p_renglones) with ordinality t(x, ord)
    cross join lateral jsonb_object_keys(case when jsonb_typeof(t.x) = 'object' then t.x else '{}'::jsonb end) k
   where k <> all (v_llaves)
   order by t.ord limit 1;
  if v_mala is not null then
    raise exception 'sr_importar: el renglon % trae llaves no permitidas (no se aceptan datos de cliente)', v_mala using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('o', t.ord, 'r', restaurantes.sr_normalizar_renglon(p_tipo, t.x)) order by t.ord), '[]'::jsonb)
    into v_norm
    from jsonb_array_elements(p_renglones) with ordinality t(x, ord);

  if p_tipo = 'cuentas' then
    with n as (
      select (e ->> 'o')::integer as o, e -> 'r' as r from jsonb_array_elements(v_norm) e
    ), fmt as (
      select o, r from n where not (r ? 'error')
    ), dias as materialized (
      select coalesce(array_agg(distinct (r ->> 'dia')::date), '{}'::date[]) as d from fmt
    ), f2 as (
      select o, r, row_number() over (partition by r ->> 'folio' order by o) as rn from fmt
    ), f3 as (
      select f2.o, f2.r, f2.rn,
             exists (select 1 from restaurantes.sr_ticket t, dias
                      where t.property_id = p_property_id and t.folio = f2.r ->> 'folio' and t.estado = 'vigente'
                        and not (t.dia_negocio = any (dias.d))) as conflicto
        from f2
    ), malos as (
      select n.o, n.r #>> '{error,campo}' as campo, n.r #>> '{error,motivo}' as motivo from n where n.r ? 'error'
      union all
      select f3.o, 'folio', case when f3.rn > 1 then 'folio duplicado en el archivo' else 'el folio ya existe en un dia que este archivo no cubre' end
        from f3 where f3.rn > 1 or f3.conflicto
    )
    select (select coalesce(array_agg(distinct (f3.r ->> 'dia')::date), '{}'::date[]) from f3 where f3.rn = 1 and not f3.conflicto),
           (select coalesce(jsonb_agg(f3.r order by f3.o), '[]'::jsonb) from f3 where f3.rn = 1 and not f3.conflicto),
           (select count(*)::integer from malos),
           (select coalesce(jsonb_agg(jsonb_build_object('renglon', m.o, 'campo', m.campo, 'motivo', m.motivo) order by m.o), '[]'::jsonb)
              from (select * from malos order by o limit 50) m)
      into v_dias, v_ok, v_rech, v_errores;
  else
    with n as (
      select (e ->> 'o')::integer as o, e -> 'r' as r from jsonb_array_elements(v_norm) e
    ), malos as (
      select n.o, n.r #>> '{error,campo}' as campo, n.r #>> '{error,motivo}' as motivo from n where n.r ? 'error'
    )
    select (select coalesce(array_agg(distinct (n.r ->> 'dia')::date), '{}'::date[]) from n where not (n.r ? 'error')),
           (select coalesce(jsonb_agg(n.r order by n.o), '[]'::jsonb) from n where not (n.r ? 'error')),
           (select count(*)::integer from malos),
           (select coalesce(jsonb_agg(jsonb_build_object('renglon', m.o, 'campo', m.campo, 'motivo', m.motivo) order by m.o), '[]'::jsonb)
              from (select * from malos order by o limit 50) m)
      into v_dias, v_ok, v_rech, v_errores;
  end if;
  v_acep := v_total - v_rech;

  if v_acep = 0 then
    return query select null::uuid, false, 0, v_rech, v_errores;
    return;
  end if;

  insert into restaurantes.sr_import_lote (organization_id, property_id, huella, tipo, nombre_archivo, fecha_min, fecha_max,
                                           renglones, aceptados, rechazados, estado, origen, created_by)
  values (p_organization_id, p_property_id, p_huella, p_tipo, p_nombre_archivo, (select min(d) from unnest(v_dias) d),
          (select max(d) from unnest(v_dias) d), v_total, v_acep, v_rech, 'aplicado', 'archivo', auth.uid())
  returning id into v_id;

  -- Los dias que cubre este lote reemplazan (marcan, no borran) lo vigente de la misma sucursal.
  with u as (
    update restaurantes.sr_resumen_dia r set estado = 'reemplazado'
     where r.property_id = p_property_id and r.estado = 'vigente' and r.dia_negocio = any (v_dias)
    returning r.lote_id
  )
  select coalesce(array_agg(distinct u.lote_id), '{}'::uuid[]) into v_viejos from u;
  if p_tipo = 'cuentas' then
    with u as (
      update restaurantes.sr_ticket t set estado = 'reemplazado'
       where t.property_id = p_property_id and t.estado = 'vigente' and t.dia_negocio = any (v_dias)
      returning t.lote_id
    )
    select v_viejos || coalesce(array_agg(distinct u.lote_id), '{}'::uuid[]) into v_viejos from u;
  end if;

  if p_tipo = 'cuentas' then
    insert into restaurantes.sr_ticket (lote_id, organization_id, property_id, folio, dia_negocio, hora_local, tipo_servicio,
                                        total_centavos, descuento_centavos, propina_centavos, forma_pago, cancelado)
    select v_id, p_organization_id, p_property_id, r ->> 'folio', (r ->> 'dia')::date, nullif(r ->> 'hora', '')::time, r ->> 'serv',
           (r ->> 'total')::bigint, (r ->> 'desc')::bigint, (r ->> 'prop')::bigint, r ->> 'pago', (r ->> 'canc')::boolean
      from jsonb_array_elements(v_ok) r;
    -- Resumen derivado de las cuentas del mismo lote.
    insert into restaurantes.sr_resumen_dia (lote_id, organization_id, property_id, dia_negocio, tipo_servicio, forma_pago, tickets,
                                             bruta_centavos, descuento_centavos, cancelado_centavos, propina_centavos, iva_centavos, neta_centavos)
    select v_id, p_organization_id, p_property_id, t.dia_negocio, t.tipo_servicio, t.forma_pago,
           (count(*) filter (where not t.cancelado))::integer,
           coalesce(sum(t.total_centavos + t.descuento_centavos) filter (where not t.cancelado), 0),
           coalesce(sum(t.descuento_centavos) filter (where not t.cancelado), 0),
           coalesce(sum(t.total_centavos) filter (where t.cancelado), 0),
           coalesce(sum(t.propina_centavos) filter (where not t.cancelado), 0),
           null,
           coalesce(sum(t.total_centavos) filter (where not t.cancelado), 0)
      from restaurantes.sr_ticket t
     where t.lote_id = v_id
     group by t.dia_negocio, t.tipo_servicio, t.forma_pago;
  else
    insert into restaurantes.sr_resumen_dia (lote_id, organization_id, property_id, dia_negocio, tipo_servicio, forma_pago, tickets,
                                             bruta_centavos, descuento_centavos, cancelado_centavos, propina_centavos, iva_centavos, neta_centavos)
    select v_id, p_organization_id, p_property_id, (r ->> 'dia')::date, r ->> 'serv', r ->> 'pago',
           sum((r ->> 'tickets')::bigint), sum((r ->> 'bruta')::bigint), sum((r ->> 'desc')::bigint), sum((r ->> 'canc')::bigint),
           sum((r ->> 'prop')::bigint),
           case when bool_and(r ->> 'iva' is not null) then sum((r ->> 'iva')::bigint) end,
           sum((r ->> 'neta')::bigint)
      from jsonb_array_elements(v_ok) r
     group by (r ->> 'dia')::date, r ->> 'serv', r ->> 'pago';
  end if;

  -- Un lote viejo sin renglones vigentes pasa a 'reemplazado'.
  update restaurantes.sr_import_lote l set estado = 'reemplazado'
   where l.id = any (v_viejos) and l.id <> v_id and l.estado = 'aplicado'
     and not exists (select 1 from restaurantes.sr_resumen_dia r where r.lote_id = l.id and r.estado = 'vigente')
     and not exists (select 1 from restaurantes.sr_ticket t where t.lote_id = l.id and t.estado = 'vigente');

  insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
  values (p_organization_id, auth.uid(), 'cfo.sr_importado', 'configuracion', v_id, left(p_tipo, 200), null,
          left('renglones=' || v_total || ';aceptados=' || v_acep || ';rechazados=' || v_rech || ';dias=' || cardinality(v_dias), 500));

  return query select v_id, true, v_acep, v_rech, v_errores;
end;
$$;
revoke all on function restaurantes.sr_importar(uuid, uuid, text, text, text, jsonb) from public, anon;
grant execute on function restaurantes.sr_importar(uuid, uuid, text, text, text, jsonb) to authenticated;

-- Lectura: suma lo VIGENTE (todas las formas de pago) por sucursal, dia de negocio y tipo de servicio.
-- iva_centavos es nulo si algun renglon del grupo no traia IVA (no se inventa).
create or replace function restaurantes.sr_resumen_leer(p_organization_id uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (property_id uuid, dia_negocio date, tipo_servicio text, tickets bigint, bruta_centavos bigint, descuento_centavos bigint,
               cancelado_centavos bigint, propina_centavos bigint, iva_centavos bigint, neta_centavos bigint)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_props uuid[];
begin
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  select a.props into v_props from restaurantes.cfo_resolver_alcance(p_organization_id, p_props) a;
  return query
    select r.property_id, r.dia_negocio, r.tipo_servicio, sum(r.tickets)::bigint, sum(r.bruta_centavos)::bigint, sum(r.descuento_centavos)::bigint,
           sum(r.cancelado_centavos)::bigint, sum(r.propina_centavos)::bigint,
           case when bool_and(r.iva_centavos is not null) then sum(r.iva_centavos)::bigint end,
           sum(r.neta_centavos)::bigint
      from restaurantes.sr_resumen_dia r
     where r.organization_id = p_organization_id and r.estado = 'vigente' and r.property_id = any (v_props)
       and r.dia_negocio between p_desde and p_hasta
     group by r.property_id, r.dia_negocio, r.tipo_servicio
     order by r.property_id, r.dia_negocio, r.tipo_servicio;
end;
$$;
revoke all on function restaurantes.sr_resumen_leer(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.sr_resumen_leer(uuid, uuid[], date, date) to authenticated;

create or replace function restaurantes.sr_lotes_listar(p_organization_id uuid, p_props uuid[], p_limite integer default 50)
returns table (id uuid, property_id uuid, tipo text, nombre_archivo text, fecha_min date, fecha_max date, renglones integer,
               aceptados integer, rechazados integer, estado text, origen text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_props uuid[];
begin
  if p_limite is null or p_limite < 1 or p_limite > 200 then
    raise exception 'sr_lotes_listar: limite invalido (1..200)' using errcode = '22023';
  end if;
  select a.props into v_props from restaurantes.cfo_resolver_alcance(p_organization_id, p_props) a;
  return query
    select l.id, l.property_id, l.tipo, l.nombre_archivo, l.fecha_min, l.fecha_max, l.renglones, l.aceptados, l.rechazados, l.estado,
           l.origen, l.created_at
      from restaurantes.sr_import_lote l
     where l.organization_id = p_organization_id and l.property_id = any (v_props)
     order by l.created_at desc, l.id
     limit p_limite;
end;
$$;
revoke all on function restaurantes.sr_lotes_listar(uuid, uuid[], integer) from public, anon;
grant execute on function restaurantes.sr_lotes_listar(uuid, uuid[], integer) to authenticated;

-- Cobertura: por sucursal, los dias con dato VIGENTE (ultimos 800 dias con dato como maximo en `dias`).
create or replace function restaurantes.sr_cobertura(p_organization_id uuid, p_props uuid[])
returns table (property_id uuid, dias_con_dato integer, dia_min date, dia_max date, dias date[])
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_props uuid[];
begin
  select a.props into v_props from restaurantes.cfo_resolver_alcance(p_organization_id, p_props) a;
  return query
    select p.id, d.n, d.dmin, d.dmax, d.dias
      from unnest(v_props) p(id)
      left join lateral (
        select count(*)::integer as n, min(x.dia_negocio) as dmin, max(x.dia_negocio) as dmax,
               (select array_agg(y.dia_negocio order by y.dia_negocio)
                  from (select distinct r2.dia_negocio from restaurantes.sr_resumen_dia r2
                         where r2.property_id = p.id and r2.estado = 'vigente' order by r2.dia_negocio desc limit 800) y) as dias
          from (select distinct r.dia_negocio from restaurantes.sr_resumen_dia r where r.property_id = p.id and r.estado = 'vigente') x
      ) d on true
     order by p.id;
end;
$$;
revoke all on function restaurantes.sr_cobertura(uuid, uuid[]) from public, anon;
grant execute on function restaurantes.sr_cobertura(uuid, uuid[]) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Bitacora de exportaciones (Excel/PDF del CFO)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function restaurantes.cfo_registrar_exportacion(
  p_organization_id uuid, p_props uuid[], p_vista text, p_formato text, p_desde date, p_hasta date
)
returns uuid
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_props uuid[];
  v_todas boolean := p_props is null;
  v_ids jsonb;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'cfo_registrar_exportacion: requiere un usuario autenticado' using errcode = '42501';
  end if;
  select a.props into v_props from restaurantes.cfo_resolver_alcance(p_organization_id, p_props) a;
  if p_vista is null or p_vista not in ('resumen', 'ventas', 'sucursales', 'estado_resultados', 'clientes', 'platillos', 'patrones', 'operacion', 'softrestaurant') then
    raise exception 'cfo_registrar_exportacion: vista no permitida' using errcode = '22023';
  end if;
  if p_formato is null or p_formato not in ('xlsx', 'pdf') then
    raise exception 'cfo_registrar_exportacion: formato invalido (xlsx o pdf)' using errcode = '22023';
  end if;
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  v_ids := case when cardinality(v_props) <= 8 then to_jsonb(v_props) else null end;
  insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
  values (p_organization_id, auth.uid(), 'cfo.exportacion', 'exportacion', null, left('cfo/' || p_vista, 200), null,
          left(jsonb_build_object('vista', p_vista, 'formato', p_formato, 'desde', p_desde, 'hasta', p_hasta, 'todas', v_todas,
                                  'n_sucursales', cardinality(v_props), 'sucursales', v_ids)::text, 500))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function restaurantes.cfo_registrar_exportacion(uuid, uuid[], text, text, date, date) from public, anon;
grant execute on function restaurantes.cfo_registrar_exportacion(uuid, uuid[], text, text, date, date) to authenticated;
