-- 0082: tabulador de REFERENCIA INTERNA (piso de negociacion, no publico), costos unitarios medidos y cotizaciones
-- auditadas. Requiere 0080 y 0081.
--
-- Decision del dueño (7-nov-2026): no hay lista publica; cada cliente recibe un plan NEGOCIADO a la medida. El tabulador
-- queda como piso/referencia del cotizador del superadmin y TODA opcion debe dejar >= 55 % de margen bruto en su peor punto
-- (cliente usando exactamente el 100 % de la bolsa incluida). Fuente de las cifras: PRECIOS-COMPETENCIA-Y-PROPUESTA.md
-- («Tabulador final >= 55 %»), fuera del repo.
--
-- Empaque final del dueño (7-nov-2026): autoservicio para 1-2 sucursales con tres planes de LISTA, mensual, con tarjeta y
-- 14 dias de prueba, precios APROBADOS por el dueño: «Basico» 1,590 (500 conversaciones), «Plus» 4,390 (1,000 + 500 min) y
-- «Pro» 7,690 (2,000 + 1,500 min), por sucursal + IVA; excedente 3.40 MXN/min y 1.50 MXN/conversacion. Margen objetivo del
-- plan (margen_minimo_pct, a bolsa llena, ANTES de comision de cobro): 75 / 65 / 60 %. Con tarjeta, Basico y Pro quedan
-- ~0.5-1 punto debajo de su objetivo (74.5 % y 59.1 %): declarado en el PR; con SPEI se cumplen.
-- Cadenas (3+ sucursales): «Contactanos» y plan NEGOCIADO por organizacion desde el cotizador (>= 55 %, excepcion con motivo).
--
-- A0) core.plan.margen_minimo_pct: margen bruto minimo del plan (dato, editable). El cotizador y las pruebas lo leen de aqui.
-- A) Semillas (on conflict do nothing: si el superadmin ya edito algo, NO se pisa):
--    * planes de lista `restaurantes-basico`, `restaurantes-plus` y `restaurantes-pro` (activos, por sucursal);
--    * planes `restaurantes-referencia-anual`, `restaurantes-referencia-mensual` y `restaurantes-referencia-whatsapp` con
--      `activo = false`: no se asignan a nadie; son la referencia del cotizador.
--    * costos unitarios medidos en core.cobro_costo_unitario (editables por el superadmin).
--    * el plan sembrado en 0028 `restaurantes-estandar` (799 MXN por agente de voz, pierde dinero) NO se toca aqui:
--      desactivarlo es decision del dueño desde la pantalla de Planes (hoy no lo tiene ninguna organizacion).
-- B) core.cotizacion: bitacora append-only de cada cotizacion convertida en plan, con su margen proyectado. Un margen menor
--    al minimo exige motivo (>= 20 caracteres): la regla vive en un CHECK de la tabla, no solo en la API.
-- C) core.superadmin_registrar_cotizacion y core.superadmin_listar_cotizaciones.
-- C2) core.plan_banda_uso: bandas de volumen (precio graduado y su costo unitario) y plan semilla de pago por uso.
-- D) core.plan_tarifa_json con margen minimo y bandas; core.superadmin_set_plan_margen_minimo.
--
-- Seguridad: tabla nueva con RLS habilitado sin policy y REVOKE ALL a public/anon/authenticated; append-only por trigger
-- (UPDATE/DELETE -> 0A000); funciones security definer con search_path fijo; escritura con superadmin_require_caller;
-- lectura con caller binding + superadmin (otro -> 0 filas). Ningun GRANT a anon.
--
-- Rollback (manual):
--   drop function if exists core.superadmin_set_plan_bandas(uuid, text, text, jsonb);
--   drop table if exists core.plan_banda_uso;
--   drop function if exists core.superadmin_set_plan_margen_minimo(uuid, text, numeric);
--   -- y volver a crear core.plan_tarifa_json con el cuerpo de 0081.
--   drop function if exists core.superadmin_listar_cotizaciones(uuid, uuid, integer);
--   drop function if exists core.superadmin_registrar_cotizacion(uuid, uuid, text, jsonb, numeric, numeric, text);
--   drop table if exists core.cotizacion;
--   drop function if exists core.cotizacion_block_mutation();
--   delete from core.plan where id like 'restaurantes-referencia-%' and not exists (select 1 from core.organization_plan op where op.plan_id = core.plan.id);
--   delete from core.cobro_costo_unitario where fuente like 'Semilla 0082%';
--   delete from core.plan where id in ('restaurantes-basico', 'restaurantes-plus', 'restaurantes-pro') and not exists (select 1 from core.organization_plan op where op.plan_id = core.plan.id);
--   alter table core.plan drop column if exists margen_minimo_pct;

-- ═══════════════════════════════════════════════════════════════════════════
-- A0) Margen minimo por plan
-- ═══════════════════════════════════════════════════════════════════════════
alter table core.plan
  add column margen_minimo_pct numeric(5, 2) constraint plan_margen_minimo_chk check (margen_minimo_pct is null or margen_minimo_pct between 0 and 100);

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Semillas
-- ═══════════════════════════════════════════════════════════════════════════
-- Planes de LISTA de autoservicio (1-2 sucursales; 3+ = cotizacion). Precio por sucursal sin IVA; IVA 16 % encima.
insert into core.plan (id, nombre, vertical, activo, modelo_cobro, precio_sucursal_mxn_centavos, minutos_voz_incluidos_por_sucursal,
  conversaciones_wa_incluidas_por_sucursal, precio_minuto_voz_excedente_mxn_centavos, precio_conversacion_wa_excedente_mxn_centavos,
  uso_justo_pct, tasa_iva_bp, margen_minimo_pct)
values
  ('restaurantes-basico', 'Básico: WhatsApp', 'restaurantes', true, 'medido', 159000, 0, 500, null, 150, 150, 1600, 75),
  ('restaurantes-plus', 'Plus: WhatsApp + voz', 'restaurantes', true, 'medido', 439000, 500, 1000, 340, 150, 150, 1600, 65),
  ('restaurantes-pro', 'Pro: WhatsApp + voz', 'restaurantes', true, 'medido', 769000, 1500, 2000, 340, 150, 150, 1600, 60)
on conflict (id) do nothing;
-- Autoservicio solo hasta 2 sucursales: el tramo 3+ queda «a cotizar» (precio NULL).
insert into core.plan_tramo_sucursal (plan_id, desde_sucursales, hasta_sucursales, precio_sucursal_mxn_centavos) values
  ('restaurantes-basico', 1, 2, 159000), ('restaurantes-basico', 3, null, null),
  ('restaurantes-plus', 1, 2, 439000), ('restaurantes-plus', 3, null, null),
  ('restaurantes-pro', 1, 2, 769000), ('restaurantes-pro', 3, null, null)
on conflict do nothing;

-- Precios SIN IVA en centavos. Bolsa en bolsa compartida de la cuenta (por sucursal x sucursales activas).
insert into core.plan (id, nombre, vertical, activo, modelo_cobro, precio_base_mxn_centavos, minutos_voz_incluidos_por_sucursal,
  conversaciones_wa_incluidas_por_sucursal, precio_minuto_voz_excedente_mxn_centavos, precio_conversacion_wa_excedente_mxn_centavos,
  uso_justo_pct, cuota_alta_por_sucursal_mxn_centavos, tasa_iva_bp, margen_minimo_pct)
values
  ('restaurantes-referencia-anual', 'Referencia interna: contrato anual', 'restaurantes', false, 'medido', null, 1300, 300, 290, 150, 150, 179000, 1600, 55),
  ('restaurantes-referencia-mensual', 'Referencia interna: mensual sin contrato', 'restaurantes', false, 'medido', null, 1300, 300, 290, 150, 150, 249000, 1600, 55),
  ('restaurantes-referencia-whatsapp', 'Referencia interna: solo WhatsApp', 'restaurantes', false, 'medido', null, 0, 300, null, 150, 150, 99000, 1600, 55)
on conflict (id) do nothing;

insert into core.plan_tramo_sucursal (plan_id, desde_sucursales, hasta_sucursales, precio_sucursal_mxn_centavos, minutos_voz_incluidos_por_sucursal, conversaciones_wa_incluidas_por_sucursal) values
  ('restaurantes-referencia-anual', 1, 2, 479000, 1450, 300),
  ('restaurantes-referencia-anual', 3, 5, 449000, 1350, 300),
  ('restaurantes-referencia-anual', 6, 9, 429000, 1250, 300),
  ('restaurantes-referencia-anual', 10, 19, 389000, 1100, 300),
  -- 20+: piso de negociacion (se cotiza arriba de esto).
  ('restaurantes-referencia-anual', 20, null, 300000, 800, 300),
  ('restaurantes-referencia-mensual', 1, 2, 549000, 1450, 300),
  ('restaurantes-referencia-mensual', 3, 5, 519000, 1350, 300),
  ('restaurantes-referencia-mensual', 6, 9, 499000, 1250, 300),
  ('restaurantes-referencia-mensual', 10, 19, 459000, 1100, 300),
  ('restaurantes-referencia-mensual', 20, null, 370000, 800, 300),
  ('restaurantes-referencia-whatsapp', 1, null, 149000, 0, 300)
on conflict do nothing;

-- Costos unitarios (MXN, sin IVA). Supuestos declarados en PRECIOS-COMPETENCIA-Y-PROPUESTA.md:
--   minuto de voz 1.20 = costo marginal todo incluido (STT, TTS, LLM, LiveKit, Krisp, Twilio), cota alta del rango 1.04-1.20;
--   conversacion de WhatsApp 0.35 = LLM + comision de OpenRouter (las plantillas de Meta por pedido NO van aqui: riesgo declarado);
--   fijo por sucursal 150 = parte de la infraestructura fija (Fly + Vercel + Supabase) de un cliente chico;
--   numero de voz por sucursal 116 = numero local de Twilio (6.25 USD), solo en planes con voz;
--   fijo por organizacion 0 = ya repartido por sucursal.
insert into core.cobro_costo_unitario (clave, costo_mxn, fuente) values
  ('minuto_voz', 1.20, 'Semilla 0082: COSTO-MENSUAL-PM-NOV, marginal todo incluido (cota alta)'),
  ('conversacion_wa', 0.35, 'Semilla 0082: LLM + comision OpenRouter, sin plantillas de Meta'),
  ('fijo_mensual_sucursal', 150, 'Semilla 0082: parte de infraestructura fija por sucursal (cliente chico)'),
  ('numero_voz_mensual_sucursal', 116, 'Semilla 0082: numero local de Twilio, solo planes con voz'),
  ('fijo_mensual_organizacion', 0, 'Semilla 0082: repartido por sucursal'),
  ('comision_tarjeta_pct', 3.6, 'Semilla 0082: tarifa publica de tarjeta de Stripe Mexico (mas IVA sobre la comision)'),
  ('comision_tarjeta_fijo_mxn', 3, 'Semilla 0082: fijo por cobro con tarjeta de Stripe Mexico (mas IVA)')
on conflict (clave) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Cotizaciones (append-only)
-- ═══════════════════════════════════════════════════════════════════════════
create table core.cotizacion (
  id uuid primary key default gen_random_uuid(),
  folio bigint generated always as identity,
  organization_id uuid not null references core.organization(id) on delete restrict,
  plan_id text not null references core.plan(id) on delete restrict,
  -- Supuestos (llamadas, minutos, conversaciones esperados), tarifa, factura y costo proyectados: lo que vio el superadmin.
  detalle jsonb not null check (jsonb_typeof(detalle) = 'object'),
  margen_pct numeric(6, 2) not null check (margen_pct between -1000 and 100),
  margen_minimo_pct numeric(6, 2) not null check (margen_minimo_pct between 0 and 100),
  -- Debajo del minimo: motivo obligatorio (override auditado).
  motivo_excepcion text check (motivo_excepcion is null or char_length(btrim(motivo_excepcion)) >= 20),
  creado_por uuid not null references core.staff_user(id),
  creado_en timestamptz not null default now(),
  constraint cotizacion_margen_o_motivo_chk check (margen_pct >= margen_minimo_pct or motivo_excepcion is not null)
);
create index cotizacion_org_idx on core.cotizacion (organization_id, creado_en desc);
alter table core.cotizacion enable row level security;
revoke all on core.cotizacion from public, anon, authenticated;

create or replace function core.cotizacion_block_mutation()
returns trigger language plpgsql set search_path = core, pg_temp as $$
begin
  raise exception 'cotizacion_append_only: % no esta permitido', tg_op using errcode = '0A000';
end;
$$;
create trigger cotizacion_block_update_trg before update on core.cotizacion for each row execute function core.cotizacion_block_mutation();
create trigger cotizacion_block_delete_trg before delete on core.cotizacion for each row execute function core.cotizacion_block_mutation();

-- Registra la cotizacion convertida en plan (el plan a la medida ya se creo con superadmin_upsert_plan + set_plan_tarifa).
-- Seguridad: superadmin_require_caller; el plan debe ser a la medida de ESA organizacion; bitacora en plan_audit_log.
create or replace function core.superadmin_registrar_cotizacion(
  p_caller_id uuid, p_organization_id uuid, p_plan_id text, p_detalle jsonb, p_margen_pct numeric, p_margen_minimo_pct numeric, p_motivo_excepcion text
) returns jsonb language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_row core.cotizacion;
  v_exclusiva uuid;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_registrar_cotizacion');
  select pl.organizacion_exclusiva_id into v_exclusiva from core.plan pl where pl.id = p_plan_id;
  if not found then
    raise exception 'superadmin_registrar_cotizacion: el plan no existe' using errcode = 'P0002';
  end if;
  if v_exclusiva is distinct from p_organization_id then
    raise exception 'superadmin_registrar_cotizacion: el plan no es a la medida de esta organizacion' using errcode = '22023';
  end if;
  if p_margen_pct < p_margen_minimo_pct and (p_motivo_excepcion is null or char_length(btrim(p_motivo_excepcion)) < 20) then
    raise exception 'superadmin_registrar_cotizacion: margen % %% debajo del minimo % %%: indica el motivo (minimo 20 caracteres)', p_margen_pct, p_margen_minimo_pct using errcode = '22023';
  end if;
  insert into core.cotizacion (organization_id, plan_id, detalle, margen_pct, margen_minimo_pct, motivo_excepcion, creado_por)
  values (p_organization_id, p_plan_id, p_detalle, round(p_margen_pct, 2), round(p_margen_minimo_pct, 2), nullif(btrim(coalesce(p_motivo_excepcion, '')), ''), p_caller_id)
  returning * into v_row;
  perform core.plan_audit_write('plan_upserted', p_caller_id, p_organization_id, p_plan_id, jsonb_build_object(
    'cotizacion_id', v_row.id, 'folio', v_row.folio, 'margen_pct', v_row.margen_pct, 'margen_minimo_pct', v_row.margen_minimo_pct,
    'excepcion', v_row.motivo_excepcion is not null, 'motivo_excepcion', v_row.motivo_excepcion));
  return jsonb_build_object('id', v_row.id, 'folio', v_row.folio, 'creadoEn', v_row.creado_en);
end;
$$;
revoke all on function core.superadmin_registrar_cotizacion(uuid, uuid, text, jsonb, numeric, numeric, text) from public, anon;
grant execute on function core.superadmin_registrar_cotizacion(uuid, uuid, text, jsonb, numeric, numeric, text) to authenticated;

create or replace function core.superadmin_listar_cotizaciones(p_caller_id uuid, p_organization_id uuid, p_limit integer default 50)
returns setof jsonb language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select jsonb_build_object('id', c.id, 'folio', c.folio, 'organizationId', c.organization_id, 'planId', c.plan_id, 'detalle', c.detalle,
      'margenPct', c.margen_pct, 'margenMinimoPct', c.margen_minimo_pct, 'motivoExcepcion', c.motivo_excepcion, 'creadoPor', c.creado_por, 'creadoEn', c.creado_en)
    from core.cotizacion c
    where p_organization_id is null or c.organization_id = p_organization_id
    order by c.creado_en desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;
revoke all on function core.superadmin_listar_cotizaciones(uuid, uuid, integer) from public, anon;
grant execute on function core.superadmin_listar_cotizaciones(uuid, uuid, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C2) Bandas de volumen para el precio por uso (pago por uso y excedente)
-- ═══════════════════════════════════════════════════════════════════════════
-- Precio GRADUADO por volumen mensual de la cuenta: cada unidad paga el precio de la banda en la que cae (como los tramos
-- del ISR), asi no hay saltos. Cada banda trae su COSTO unitario (el costo tambien baja con el volumen: planes Business/Scale
-- de ElevenLabs y LiveKit, volumen de Twilio), para que la revision de margen use el costo correcto. Si un plan tiene bandas
-- para una metrica, el excedente de esa metrica se cobra por bandas (en vez del precio plano de 0080). Banda con precio NULL
-- = a cotizar (arriba de ese volumen no se factura solo).
create table core.plan_banda_uso (
  plan_id text not null references core.plan(id) on delete cascade,
  metrica text not null check (metrica in ('minuto_voz', 'conversacion_wa')),
  desde_unidades integer not null check (desde_unidades >= 0),
  hasta_unidades integer check (hasta_unidades is null or hasta_unidades > desde_unidades),
  precio_centavos bigint check (precio_centavos is null or precio_centavos >= 0),
  costo_unitario_mxn numeric(12, 4) not null check (costo_unitario_mxn >= 0),
  primary key (plan_id, metrica, desde_unidades)
);
alter table core.plan_banda_uso enable row level security;
revoke all on core.plan_banda_uso from public, anon, authenticated;

-- Superadmin: reemplaza las bandas de UNA metrica de un plan (contiguas desde 0, solo la ultima abierta). [] = quitarlas.
create or replace function core.superadmin_set_plan_bandas(p_caller_id uuid, p_plan_id text, p_metrica text, p_bandas jsonb)
returns void language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_b jsonb;
  v_esperado integer := 0;
  v_n integer;
  v_i integer := 0;
  v_hasta integer;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_set_plan_bandas');
  if p_metrica is null or p_metrica not in ('minuto_voz', 'conversacion_wa') then
    raise exception 'superadmin_set_plan_bandas: metrica invalida' using errcode = '22023';
  end if;
  if p_bandas is null or jsonb_typeof(p_bandas) <> 'array' or jsonb_array_length(p_bandas) > 20 then
    raise exception 'superadmin_set_plan_bandas: las bandas deben ser un arreglo de maximo 20' using errcode = '22023';
  end if;
  if not exists (select 1 from core.plan pl where pl.id = p_plan_id) then
    raise exception 'superadmin_set_plan_bandas: el plan no existe' using errcode = 'P0002';
  end if;
  v_n := jsonb_array_length(p_bandas);
  delete from core.plan_banda_uso b where b.plan_id = p_plan_id and b.metrica = p_metrica;
  for v_b in select value from jsonb_array_elements(p_bandas) loop
    v_i := v_i + 1;
    if jsonb_typeof(v_b -> 'desde') <> 'number' or jsonb_typeof(v_b -> 'costoUnitarioMxn') <> 'number'
       or coalesce(jsonb_typeof(v_b -> 'hasta'), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(v_b -> 'precioCentavos'), 'null') not in ('number', 'null') then
      raise exception 'superadmin_set_plan_bandas: banda % con forma invalida', v_i using errcode = '22023';
    end if;
    if (v_b ->> 'desde')::integer <> v_esperado then
      raise exception 'superadmin_set_plan_bandas: la banda % debe empezar en % (sin huecos ni traslapes)', v_i, v_esperado using errcode = '22023';
    end if;
    v_hasta := (v_b ->> 'hasta')::integer;
    if v_hasta is null and v_i < v_n then
      raise exception 'superadmin_set_plan_bandas: solo la ultima banda puede quedar abierta' using errcode = '22023';
    end if;
    if jsonb_typeof(v_b -> 'precioCentavos') = 'number' and (v_b ->> 'precioCentavos')::numeric <> trunc((v_b ->> 'precioCentavos')::numeric) then
      raise exception 'superadmin_set_plan_bandas: el precio va en centavos enteros' using errcode = '22023';
    end if;
    insert into core.plan_banda_uso (plan_id, metrica, desde_unidades, hasta_unidades, precio_centavos, costo_unitario_mxn)
    values (p_plan_id, p_metrica, v_esperado, v_hasta, (v_b ->> 'precioCentavos')::bigint, (v_b ->> 'costoUnitarioMxn')::numeric);
    v_esperado := coalesce(v_hasta, 0);
  end loop;
  update core.plan pl set updated_at = now(), updated_by = p_caller_id where pl.id = p_plan_id;
  perform core.plan_audit_write('plan_upserted', p_caller_id, null, p_plan_id, jsonb_build_object('bandas', jsonb_build_object(p_metrica, p_bandas)));
end;
$$;
revoke all on function core.superadmin_set_plan_bandas(uuid, text, text, jsonb) from public, anon;
grant execute on function core.superadmin_set_plan_bandas(uuid, text, text, jsonb) to authenticated;

-- Semilla: plan de PAGO POR USO (cuota de plataforma por sucursal + minutos y conversaciones por bandas, sin bolsa).
insert into core.plan (id, nombre, vertical, activo, modelo_cobro, precio_sucursal_mxn_centavos, minutos_voz_incluidos_por_sucursal,
  conversaciones_wa_incluidas_por_sucursal, uso_justo_pct, tasa_iva_bp, margen_minimo_pct)
values ('restaurantes-por-uso', 'Pago por uso', 'restaurantes', true, 'medido', 69000, 0, 0, null, 1600, 55)
on conflict (id) do nothing;
insert into core.plan_banda_uso (plan_id, metrica, desde_unidades, hasta_unidades, precio_centavos, costo_unitario_mxn) values
  ('restaurantes-por-uso', 'minuto_voz', 0, 10000, 340, 1.20),
  ('restaurantes-por-uso', 'minuto_voz', 10000, 50000, 310, 1.10),
  ('restaurantes-por-uso', 'minuto_voz', 50000, 150000, 290, 1.00),
  ('restaurantes-por-uso', 'minuto_voz', 150000, null, null, 1.00),
  ('restaurantes-por-uso', 'conversacion_wa', 0, 3000, 150, 0.35),
  ('restaurantes-por-uso', 'conversacion_wa', 3000, 15000, 120, 0.35),
  ('restaurantes-por-uso', 'conversacion_wa', 15000, null, 99, 0.35)
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Tarifa con margen minimo y su edicion
-- ═══════════════════════════════════════════════════════════════════════════
-- Misma firma que 0080/0081; agrega 'margenMinimoPct'.
create or replace function core.plan_tarifa_json(p_plan core.plan)
returns jsonb language sql stable set search_path = core, pg_temp as $$
  select jsonb_build_object(
    'planId', p_plan.id,
    'nombre', p_plan.nombre,
    'vertical', p_plan.vertical,
    'activo', p_plan.activo,
    'modeloCobro', p_plan.modelo_cobro,
    'cuotaFijaCentavos', p_plan.precio_base_mxn_centavos,
    'precioSucursalCentavos', p_plan.precio_sucursal_mxn_centavos,
    'sucursalesIncluidas', p_plan.sucursales_incluidas,
    'minutosVozIncluidos', p_plan.minutos_voz_incluidos,
    'minutosVozIncluidosPorSucursal', p_plan.minutos_voz_incluidos_por_sucursal,
    'precioMinutoVozExcedenteCentavos', p_plan.precio_minuto_voz_excedente_mxn_centavos,
    'conversacionesWaIncluidas', p_plan.conversaciones_wa_incluidas,
    'conversacionesWaIncluidasPorSucursal', p_plan.conversaciones_wa_incluidas_por_sucursal,
    'precioConversacionWaExcedenteCentavos', p_plan.precio_conversacion_wa_excedente_mxn_centavos,
    'usoJustoPct', p_plan.uso_justo_pct,
    'cuotaAltaCentavos', p_plan.cuota_alta_mxn_centavos,
    'cuotaAltaPorSucursalCentavos', p_plan.cuota_alta_por_sucursal_mxn_centavos,
    'tasaIvaBp', p_plan.tasa_iva_bp,
    'margenMinimoPct', p_plan.margen_minimo_pct,
    'bandasUso', coalesce((
      select jsonb_agg(jsonb_build_object('metrica', b.metrica, 'desde', b.desde_unidades, 'hasta', b.hasta_unidades, 'precioCentavos', b.precio_centavos,
        'costoUnitarioMxn', b.costo_unitario_mxn) order by b.metrica, b.desde_unidades)
      from core.plan_banda_uso b where b.plan_id = p_plan.id
    ), '[]'::jsonb),
    'organizacionExclusivaId', p_plan.organizacion_exclusiva_id,
    'tramosSucursal', coalesce((
      select jsonb_agg(jsonb_build_object('desde', t.desde_sucursales, 'hasta', t.hasta_sucursales, 'precioCentavos', t.precio_sucursal_mxn_centavos,
        'minutosVozIncluidosPorSucursal', t.minutos_voz_incluidos_por_sucursal, 'conversacionesWaIncluidasPorSucursal', t.conversaciones_wa_incluidas_por_sucursal) order by t.desde_sucursales)
      from core.plan_tramo_sucursal t where t.plan_id = p_plan.id
    ), '[]'::jsonb)
  );
$$;
revoke all on function core.plan_tarifa_json(core.plan) from public, anon, authenticated;

-- Superadmin: margen minimo del plan (NULL = el del cotizador por omision). superadmin_require_caller + bitacora.
create or replace function core.superadmin_set_plan_margen_minimo(p_caller_id uuid, p_plan_id text, p_margen_pct numeric)
returns void language plpgsql security definer set search_path = core, pg_temp as $$
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_set_plan_margen_minimo');
  if p_margen_pct is not null and (p_margen_pct < 0 or p_margen_pct > 100) then
    raise exception 'superadmin_set_plan_margen_minimo: el margen debe estar entre 0 y 100' using errcode = '22023';
  end if;
  update core.plan pl set margen_minimo_pct = p_margen_pct, updated_at = now(), updated_by = p_caller_id where pl.id = p_plan_id;
  if not found then
    raise exception 'superadmin_set_plan_margen_minimo: el plan no existe' using errcode = 'P0002';
  end if;
  perform core.plan_audit_write('plan_upserted', p_caller_id, null, p_plan_id, jsonb_build_object('margen_minimo_pct', p_margen_pct));
end;
$$;
revoke all on function core.superadmin_set_plan_margen_minimo(uuid, text, numeric) from public, anon;
grant execute on function core.superadmin_set_plan_margen_minimo(uuid, text, numeric) to authenticated;
