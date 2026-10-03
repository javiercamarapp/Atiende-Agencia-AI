-- Cerebro de ventas, base (SA-L-37 modelo de datos, SA-L-38 taxonomia por vertical, SA-L-41 persistencia del scoring).
--
-- Especificacion: work/paridad2/superadmin-likida.md 6.2, 6.3, 6.6 y 6.7. Principio rector: el cerebro PROPONE y el humano
-- envia; esta migracion NO crea ningun camino de envio (ni correo, ni WhatsApp, ni llamada). Aislamiento: nada de aqui
-- lee ni escribe datos de clientes de los tenants; solo `core.prospecto` y tablas nuevas del propio embudo de ventas.
--
-- Que agrega:
--   1. Columnas nuevas en `core.prospecto` (subtipo, tamano, ubicacion, sitio, senales, base de licitud, scores,
--      duplicado, vendedor, organizacion, toques y siguiente paso) + `contacto_legado` (ver 1b).
--   2. `core.prospecto_contacto_persona`: personas de contacto. CHECK: origen de una lista cerrada y evidencia_url
--      http(s) obligatoria, asi que NINGUN correo deducido por patron puede guardarse.
--   3. `core.prospecto_evento`: linea de tiempo (toque saliente/entrante, cambio de etapa, nota, importacion,
--      enriquecimiento) con actor y costo. Cada cambio de etapa escribe un evento (funcion de update redefinida).
--   4. `core.cerebro_taxonomia`: catalogo versionado por vertical (subtipos, rangos de tamano, senales, ICP, objeciones,
--      mensajes base es-MX sin promesas de cifras, plan sugerido). Editar = insertar una version nueva; nunca UPDATE.
--      Semilla de 6.6 marcada 'propuesta_validar_con_javier'.
--   5. Funciones `*_for_superadmin` con caller-binding para leer y escribir.
--
-- ACCESO (justificacion de seguridad de cada GRANT, policy y funcion):
--   * Las 3 tablas nuevas tienen RLS habilitado SIN ninguna policy y `revoke all ... from public, anon, authenticated`:
--     nadie las lee ni escribe directo. El superadmin no es "dueno" de ninguna fila por `auth.uid()`, asi que una policy
--     seria innecesaria; mismo criterio que `core.prospecto` (0012) y `core.supresion_contacto` (0043). No hay `GRANT`
--     de tabla ni de columna a ningun rol porque ninguna funcion se ejecuta como el rol llamador: todas son
--     `security definer` y escriben como DUENO. Tampoco se otorga nada a `anon`.
--   * Cada funcion es `security definer` con `set search_path = core, pg_temp`, `revoke ... from public, anon` y
--     `grant execute ... to authenticated`. Lecturas: `auth.uid() = p_caller_id` + `core.is_platform_superadmin`
--     (mismo guard de `core.list_supresiones_for_superadmin`). Escrituras: `core.superadmin_require_caller`
--     (caller-binding + superadmin real). `anon` no puede ejecutar nada (auth.uid() es null y ademas no tiene EXECUTE).
--   * Las escrituras de taxonomia ademas exigen step-up MFA en la RUTA del API (SENSITIVE_ROUTES); la autoridad real
--     sigue siendo SQL.
--   * Las funciones de escritura aceptan un jsonb con lista BLANCA de campos: una clave desconocida se ignora, asi que
--     el cliente no puede tocar columnas de sistema (score_*, creado_por, organization_id, org_demo_id) por ahi; los
--     scores llegan en un parametro aparte `p_score` calculado por el modulo determinista del API.
--
-- 1b. BASE DE LICITUD OBLIGATORIA CON DATOS DE CONTACTO. CHECK `prospecto_contacto_requiere_base_chk`: una fila con
-- telefono, correo o contacto_nombre exige `base_licitud`. Las filas YA existentes (capturadas antes de esta regla) se
-- marcan `contacto_legado = true` en esta misma migracion: siguen siendo editables (por ejemplo, cambiar de etapa), pero
-- el panel las rotula "sin base de licitud registrada" y NO deben contactarse hasta registrarla. No se inventa una base.
-- Consecuencia conocida: `core.create_prospecto_for_superadmin` (0012, intacta) con datos de contacto falla con 23514
-- tras esta migracion; la ruta del API lo traduce a un 422 que dirige al Cerebro de ventas.
--
-- Orden de despliegue: CUALQUIER ORDEN. El codigo TypeScript captura 42883/42P01/42703 con savepoint
-- (`runWithSavepointFallback`): contra la base sin migrar el Cerebro responde 200 con `disponible: false` y la lista de
-- prospectos sigue funcionando por el camino anterior; no hay ningun 500.

-- 1. core.prospecto: columnas nuevas ------------------------------------------------------------------------------------
alter table core.prospecto
  add column subtipo text,
  add column tamano text,
  add column entidad text,
  add column municipio text,
  add column zona text,
  add column lat numeric(9, 6),
  add column lng numeric(9, 6),
  add column sitio_web text,
  add column sitio_verificado boolean not null default false,
  add column redes jsonb not null default '{}'::jsonb,
  add column senales jsonb not null default '[]'::jsonb,
  add column base_licitud text,
  add column consentimiento_en timestamptz,
  add column score_ajuste integer,
  add column score_urgencia integer,
  add column score_cierre integer,
  add column score_completitud integer,
  add column score_explicacion jsonb,
  add column score_version text,
  add column duplicado_de uuid references core.prospecto(id) on delete set null,
  add column vendedor_id uuid references core.staff_user(id) on delete set null,
  add column organization_id uuid references core.organization(id) on delete set null,
  add column org_demo_id uuid references core.organization(id) on delete set null,
  add column ultimo_toque_en timestamptz,
  add column siguiente_paso text,
  add column siguiente_paso_en timestamptz,
  add column contacto_legado boolean not null default false;

-- Filas previas con datos de contacto: legado (ver 1b). Va ANTES de agregar el CHECK.
update core.prospecto
set contacto_legado = true
where telefono is not null or correo is not null or contacto_nombre is not null;

alter table core.prospecto
  add constraint prospecto_subtipo_chk check (subtipo is null or char_length(subtipo) between 1 and 60),
  add constraint prospecto_tamano_chk check (tamano is null or char_length(tamano) between 1 and 40),
  add constraint prospecto_lat_chk check (lat is null or lat between -90 and 90),
  add constraint prospecto_lng_chk check (lng is null or lng between -180 and 180),
  add constraint prospecto_latlng_juntos_chk check ((lat is null) = (lng is null)),
  add constraint prospecto_sitio_web_chk check (sitio_web is null or sitio_web ~* '^https?://'),
  add constraint prospecto_redes_chk check (jsonb_typeof(redes) = 'object'),
  add constraint prospecto_senales_chk check (jsonb_typeof(senales) = 'array'),
  add constraint prospecto_base_licitud_chk check (
    base_licitud is null
    or base_licitud = any (array['interes_declarado', 'relacion_previa', 'fuente_publica_b2b', 'referido_con_consentimiento'])
  ),
  -- Interes declarado y referido con consentimiento se acreditan con la fecha del consentimiento.
  add constraint prospecto_consentimiento_chk check (
    base_licitud is null
    or base_licitud not in ('interes_declarado', 'referido_con_consentimiento')
    or consentimiento_en is not null
  ),
  add constraint prospecto_contacto_requiere_base_chk check (
    base_licitud is not null
    or contacto_legado
    or (telefono is null and correo is null and contacto_nombre is null)
  ),
  add constraint prospecto_scores_chk check (
    (score_ajuste is null or score_ajuste between 0 and 100)
    and (score_urgencia is null or score_urgencia between 0 and 100)
    and (score_cierre is null or score_cierre between 0 and 100)
    and (score_completitud is null or score_completitud between 0 and 100)
  ),
  add constraint prospecto_score_explicacion_chk check (score_explicacion is null or jsonb_typeof(score_explicacion) = 'object'),
  add constraint prospecto_duplicado_propio_chk check (duplicado_de is null or duplicado_de <> id),
  add constraint prospecto_siguiente_paso_chk check (siguiente_paso is null or char_length(siguiente_paso) <= 500);

create index prospecto_vendedor_idx on core.prospecto (vendedor_id) where vendedor_id is not null;
create index prospecto_duplicado_idx on core.prospecto (duplicado_de) where duplicado_de is not null;

-- 2. core.prospecto_contacto_persona -------------------------------------------------------------------------------------
create table core.prospecto_contacto_persona (
  id uuid primary key default gen_random_uuid(),
  prospecto_id uuid not null references core.prospecto(id) on delete cascade,
  nombre text not null check (char_length(btrim(nombre)) between 2 and 120),
  cargo text check (cargo is null or char_length(cargo) <= 120),
  canal text not null check (canal = any (array['telefono', 'correo', 'whatsapp', 'otro'])),
  -- Telefono o correo del canal. Opcional: puede registrarse la persona (decisor) sin dato de contacto.
  dato text check (dato is null or char_length(dato) <= 254),
  -- Lista CERRADA de origenes verificables. No existe 'patron', 'deducido' ni 'adivinado': un correo armado por patron
  -- (nombre.apellido@dominio) no tiene un origen valido y por tanto no se puede guardar.
  origen text not null check (origen = any (array['sitio_web_oficial', 'directorio_publico', 'perfil_profesional_publico', 'formulario_propio', 'referido_documentado'])),
  confianza text not null check (confianza = any (array['alta', 'media', 'baja'])),
  -- Evidencia obligatoria: la pagina o documento donde se vio el dato.
  evidencia_url text not null check (evidencia_url ~* '^https?://[^[:space:]]{4,}$' and char_length(evidencia_url) <= 500),
  creado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now(),
  constraint prospecto_persona_dato_correo_chk check (canal <> 'correo' or dato is null or dato ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);
create index prospecto_contacto_persona_prospecto_idx on core.prospecto_contacto_persona (prospecto_id);
alter table core.prospecto_contacto_persona enable row level security;
revoke all on core.prospecto_contacto_persona from public, anon, authenticated;

-- 3. core.prospecto_evento ------------------------------------------------------------------------------------------------
create table core.prospecto_evento (
  id uuid primary key default gen_random_uuid(),
  prospecto_id uuid not null references core.prospecto(id) on delete cascade,
  tipo text not null check (tipo = any (array['toque_saliente', 'toque_entrante', 'cambio_etapa', 'nota', 'importacion', 'enriquecimiento'])),
  -- null = evento de sistema.
  actor_id uuid references core.staff_user(id) on delete set null,
  -- Sin PII: etapa anterior/nueva, accion, conteos.
  detalle jsonb not null default '{}'::jsonb check (jsonb_typeof(detalle) = 'object'),
  -- Costo del evento en micro-USD (LLM de enriquecimiento, datos de la fuente). null = no se sabe, nunca 0 inventado.
  costo_micro_usd bigint check (costo_micro_usd is null or costo_micro_usd >= 0),
  creado_en timestamptz not null default now()
);
create index prospecto_evento_prospecto_idx on core.prospecto_evento (prospecto_id, creado_en desc);
alter table core.prospecto_evento enable row level security;
revoke all on core.prospecto_evento from public, anon, authenticated;

-- 4. core.cerebro_taxonomia -----------------------------------------------------------------------------------------------
create table core.cerebro_taxonomia (
  id uuid primary key default gen_random_uuid(),
  vertical text not null check (vertical = any (array['hoteles', 'restaurantes', 'rentas', 'licitaciones', 'citas', 'despachos'])),
  version integer not null check (version >= 1),
  -- [{clave, nombre}]
  subtipos jsonb not null check (jsonb_typeof(subtipos) = 'array'),
  -- {unidad, rangos: [{clave, etiqueta}]}. Propuesta de segmentacion, no un hecho.
  rangos_tamano jsonb not null check (jsonb_typeof(rangos_tamano) = 'object'),
  -- [{tipo, nombre, dimension (ajuste|urgencia|cierre), puntos, como_conseguirla}]: las reglas del scoring leen esto.
  senales jsonb not null check (jsonb_typeof(senales) = 'array'),
  -- {descripcion, subtipos_objetivo: [clave], tamanos_objetivo: [clave]}
  icp jsonb not null check (jsonb_typeof(icp) = 'object'),
  -- [{objecion, respuesta}]
  objeciones jsonb not null check (jsonb_typeof(objeciones) = 'array'),
  -- [{canal, variante, texto}] en es-MX, sin promesas de cifras.
  mensajes_base jsonb not null check (jsonb_typeof(mensajes_base) = 'array'),
  -- {dolor, propuesta_valor, metricas, restricciones}
  contexto jsonb not null default '{}'::jsonb check (jsonb_typeof(contexto) = 'object'),
  -- El PRECIO nunca se guarda aqui: sale de core.plan al leer. null = 'precio por definir'.
  plan_id text references core.plan(id) on delete set null,
  estado_validacion text not null default 'propuesta_validar_con_javier' check (estado_validacion = any (array['propuesta_validar_con_javier', 'validada'])),
  nota_cambio text check (nota_cambio is null or char_length(nota_cambio) <= 500),
  vigente_desde timestamptz not null default now(),
  creado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now(),
  unique (vertical, version)
);
alter table core.cerebro_taxonomia enable row level security;
revoke all on core.cerebro_taxonomia from public, anon, authenticated;

-- 5. Funciones -----------------------------------------------------------------------------------------------------------

-- Lectura de prospectos con TODAS las columnas nuevas. Solo lectura: guard de lectura (como list_supresiones).
create or replace function core.list_prospectos_cerebro_for_superadmin(p_caller_id uuid)
returns setof core.prospecto
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'list_prospectos_cerebro_for_superadmin: caller binding invalido (auth.uid() no coincide con p_caller_id)' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'list_prospectos_cerebro_for_superadmin: solo un superadmin de plataforma real puede ejecutar esta accion' using errcode = '42501';
  end if;
  return query select p.* from core.prospecto p order by p.updated_at desc;
end;
$$;
revoke all on function core.list_prospectos_cerebro_for_superadmin(uuid) from public, anon;
grant execute on function core.list_prospectos_cerebro_for_superadmin(uuid) to authenticated;

-- Alta o edicion de un prospecto del cerebro. `p_datos`: lista blanca de campos editables por el humano (una clave
-- ausente deja el valor actual; una clave con null lo limpia). `p_score`: resultado del modulo determinista del API
-- ({ajuste, urgencia, cierre, completitud, explicacion, version}); si es null no toca los scores.
create or replace function core.save_prospecto_cerebro_for_superadmin(
  p_caller_id uuid,
  p_prospecto_id uuid,
  p_datos jsonb,
  p_score jsonb
)
returns core.prospecto
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_old core.prospecto;
  v_row core.prospecto;
  v_datos jsonb := coalesce(p_datos, '{}'::jsonb);
  v_empresa text;
  v_vertical text;
  v_telefono text;
  v_correo text;
  v_contacto text;
  v_base text;
begin
  perform core.superadmin_require_caller(p_caller_id, 'save_prospecto_cerebro_for_superadmin');
  if jsonb_typeof(v_datos) <> 'object' then
    raise exception 'save_prospecto_cerebro_for_superadmin: p_datos debe ser un objeto' using errcode = '22023';
  end if;

  if p_prospecto_id is not null then
    select * into v_old from core.prospecto where id = p_prospecto_id for update;
    if v_old.id is null then
      raise exception 'prospecto not found' using errcode = 'P0002';
    end if;
  end if;

  v_empresa := case when v_datos ? 'empresa' then nullif(btrim(v_datos ->> 'empresa'), '') else v_old.empresa end;
  v_vertical := case when v_datos ? 'vertical' then v_datos ->> 'vertical' else v_old.vertical end;
  v_telefono := case when v_datos ? 'telefono' then nullif(btrim(v_datos ->> 'telefono'), '') else v_old.telefono end;
  v_correo := case when v_datos ? 'correo' then nullif(btrim(v_datos ->> 'correo'), '') else v_old.correo end;
  v_contacto := case when v_datos ? 'contacto_nombre' then nullif(btrim(v_datos ->> 'contacto_nombre'), '') else v_old.contacto_nombre end;
  v_base := case when v_datos ? 'base_licitud' then nullif(v_datos ->> 'base_licitud', '') else v_old.base_licitud end;

  if v_empresa is null then
    raise exception 'save_prospecto_cerebro_for_superadmin: empresa requerida' using errcode = '22023';
  end if;
  if v_vertical is null then
    raise exception 'save_prospecto_cerebro_for_superadmin: vertical requerida' using errcode = '22023';
  end if;
  -- Guardia explicita (ademas del CHECK, que no se aplica a filas legado): sin base de licitud no se guardan datos de
  -- contacto NUEVOS. Una fila legado solo puede seguir como esta o registrar su base.
  if v_base is null and (v_telefono is not null or v_correo is not null or v_contacto is not null)
     and not (p_prospecto_id is not null and v_old.contacto_legado
              and v_telefono is not distinct from v_old.telefono and v_correo is not distinct from v_old.correo
              and v_contacto is not distinct from v_old.contacto_nombre) then
    raise exception 'base_licitud_requerida: indica la base de licitud para guardar datos de contacto' using errcode = '23514';
  end if;

  if p_prospecto_id is null then
    insert into core.prospecto (
      empresa, vertical, ciudad, contacto_nombre, telefono, correo, fuente, notas, creado_por,
      subtipo, tamano, entidad, municipio, zona, lat, lng, sitio_web, sitio_verificado, redes, senales,
      base_licitud, consentimiento_en, duplicado_de, vendedor_id, siguiente_paso, siguiente_paso_en
    ) values (
      v_empresa, v_vertical, nullif(btrim(v_datos ->> 'ciudad'), ''), v_contacto, v_telefono, v_correo,
      nullif(btrim(v_datos ->> 'fuente'), ''), nullif(btrim(v_datos ->> 'notas'), ''), p_caller_id,
      nullif(btrim(v_datos ->> 'subtipo'), ''), nullif(btrim(v_datos ->> 'tamano'), ''), nullif(btrim(v_datos ->> 'entidad'), ''),
      nullif(btrim(v_datos ->> 'municipio'), ''), nullif(btrim(v_datos ->> 'zona'), ''),
      nullif(v_datos ->> 'lat', '')::numeric, nullif(v_datos ->> 'lng', '')::numeric,
      nullif(btrim(v_datos ->> 'sitio_web'), ''), coalesce((v_datos ->> 'sitio_verificado')::boolean, false),
      coalesce(v_datos -> 'redes', '{}'::jsonb), coalesce(v_datos -> 'senales', '[]'::jsonb),
      v_base, nullif(v_datos ->> 'consentimiento_en', '')::timestamptz,
      nullif(v_datos ->> 'duplicado_de', '')::uuid, nullif(v_datos ->> 'vendedor_id', '')::uuid,
      nullif(btrim(v_datos ->> 'siguiente_paso'), ''), nullif(v_datos ->> 'siguiente_paso_en', '')::timestamptz
    ) returning * into v_row;

    insert into core.prospecto_evento (prospecto_id, tipo, actor_id, detalle)
    values (v_row.id, 'nota', p_caller_id, jsonb_build_object('accion', 'alta'));
  else
    update core.prospecto set
      empresa = v_empresa,
      vertical = v_vertical,
      ciudad = case when v_datos ? 'ciudad' then nullif(btrim(v_datos ->> 'ciudad'), '') else ciudad end,
      contacto_nombre = v_contacto,
      telefono = v_telefono,
      correo = v_correo,
      fuente = case when v_datos ? 'fuente' then nullif(btrim(v_datos ->> 'fuente'), '') else fuente end,
      notas = case when v_datos ? 'notas' then nullif(btrim(v_datos ->> 'notas'), '') else notas end,
      subtipo = case when v_datos ? 'subtipo' then nullif(btrim(v_datos ->> 'subtipo'), '') else subtipo end,
      tamano = case when v_datos ? 'tamano' then nullif(btrim(v_datos ->> 'tamano'), '') else tamano end,
      entidad = case when v_datos ? 'entidad' then nullif(btrim(v_datos ->> 'entidad'), '') else entidad end,
      municipio = case when v_datos ? 'municipio' then nullif(btrim(v_datos ->> 'municipio'), '') else municipio end,
      zona = case when v_datos ? 'zona' then nullif(btrim(v_datos ->> 'zona'), '') else zona end,
      lat = case when v_datos ? 'lat' then nullif(v_datos ->> 'lat', '')::numeric else lat end,
      lng = case when v_datos ? 'lng' then nullif(v_datos ->> 'lng', '')::numeric else lng end,
      sitio_web = case when v_datos ? 'sitio_web' then nullif(btrim(v_datos ->> 'sitio_web'), '') else sitio_web end,
      sitio_verificado = case when v_datos ? 'sitio_verificado' then coalesce((v_datos ->> 'sitio_verificado')::boolean, false) else sitio_verificado end,
      redes = case when v_datos ? 'redes' then coalesce(v_datos -> 'redes', '{}'::jsonb) else redes end,
      senales = case when v_datos ? 'senales' then coalesce(v_datos -> 'senales', '[]'::jsonb) else senales end,
      base_licitud = v_base,
      consentimiento_en = case when v_datos ? 'consentimiento_en' then nullif(v_datos ->> 'consentimiento_en', '')::timestamptz else consentimiento_en end,
      duplicado_de = case when v_datos ? 'duplicado_de' then nullif(v_datos ->> 'duplicado_de', '')::uuid else duplicado_de end,
      vendedor_id = case when v_datos ? 'vendedor_id' then nullif(v_datos ->> 'vendedor_id', '')::uuid else vendedor_id end,
      siguiente_paso = case when v_datos ? 'siguiente_paso' then nullif(btrim(v_datos ->> 'siguiente_paso'), '') else siguiente_paso end,
      siguiente_paso_en = case when v_datos ? 'siguiente_paso_en' then nullif(v_datos ->> 'siguiente_paso_en', '')::timestamptz else siguiente_paso_en end,
      -- Una edicion real "desmarca" el seguimiento pendiente, igual que update_prospecto_for_superadmin (0016).
      necesita_seguimiento_desde = null,
      updated_at = now()
    where id = p_prospecto_id
    returning * into v_row;
  end if;

  -- Scores: solo si el API manda `p_score` (modulo determinista). Se guardan juntos con su version y su explicacion.
  if p_score is not null then
    update core.prospecto set
      score_ajuste = (p_score ->> 'ajuste')::integer,
      score_urgencia = (p_score ->> 'urgencia')::integer,
      score_cierre = (p_score ->> 'cierre')::integer,
      score_completitud = (p_score ->> 'completitud')::integer,
      score_explicacion = p_score -> 'explicacion',
      score_version = nullif(p_score ->> 'version', '')
    where id = v_row.id
    returning * into v_row;
  end if;

  return v_row;
end;
$$;
revoke all on function core.save_prospecto_cerebro_for_superadmin(uuid, uuid, jsonb, jsonb) from public, anon;
grant execute on function core.save_prospecto_cerebro_for_superadmin(uuid, uuid, jsonb, jsonb) to authenticated;

-- Redefinicion de `core.update_prospecto_for_superadmin` (ultima version: 0016) -- MISMO cuerpo y misma firma, mas:
-- cada cambio REAL de etapa escribe un `prospecto_evento` (cambio_etapa) con la etapa anterior y la nueva (sin PII).
-- Conserva el caller-binding, el guard de superadmin, el revoke from public y el grant a authenticated.
create or replace function core.update_prospecto_for_superadmin(
  p_caller_id uuid,
  p_prospecto_id uuid,
  p_estado text,
  p_notas text
)
returns core.prospecto
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_row core.prospecto;
  v_estado_anterior text;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'update_prospecto_for_superadmin: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select estado into v_estado_anterior from core.prospecto where id = p_prospecto_id for update;

  update core.prospecto
  set estado = coalesce(p_estado, estado),
      notas = coalesce(p_notas, notas),
      necesita_seguimiento_desde = null,
      updated_at = now()
  where id = p_prospecto_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'prospecto not found' using errcode = 'P0002';
  end if;

  if v_row.estado is distinct from v_estado_anterior then
    insert into core.prospecto_evento (prospecto_id, tipo, actor_id, detalle)
    values (v_row.id, 'cambio_etapa', p_caller_id, jsonb_build_object('de', v_estado_anterior, 'a', v_row.estado));
  end if;

  return v_row;
end;
$$;
revoke all on function core.update_prospecto_for_superadmin(uuid, uuid, text, text) from public;
grant execute on function core.update_prospecto_for_superadmin(uuid, uuid, text, text) to authenticated;

-- Personas de contacto.
create or replace function core.list_prospecto_personas_for_superadmin(p_caller_id uuid, p_prospecto_id uuid)
returns setof core.prospecto_contacto_persona
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'list_prospecto_personas_for_superadmin: caller binding invalido (auth.uid() no coincide con p_caller_id)' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'list_prospecto_personas_for_superadmin: solo un superadmin de plataforma real puede ejecutar esta accion' using errcode = '42501';
  end if;
  return query select x.* from core.prospecto_contacto_persona x where x.prospecto_id = p_prospecto_id order by x.creado_en desc;
end;
$$;
revoke all on function core.list_prospecto_personas_for_superadmin(uuid, uuid) from public, anon;
grant execute on function core.list_prospecto_personas_for_superadmin(uuid, uuid) to authenticated;

create or replace function core.add_prospecto_persona_for_superadmin(
  p_caller_id uuid,
  p_prospecto_id uuid,
  p_nombre text,
  p_cargo text,
  p_canal text,
  p_dato text,
  p_origen text,
  p_confianza text,
  p_evidencia_url text
)
returns core.prospecto_contacto_persona
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_prospecto core.prospecto;
  v_row core.prospecto_contacto_persona;
begin
  perform core.superadmin_require_caller(p_caller_id, 'add_prospecto_persona_for_superadmin');
  select * into v_prospecto from core.prospecto where id = p_prospecto_id for share;
  if v_prospecto.id is null then
    raise exception 'prospecto not found' using errcode = 'P0002';
  end if;
  -- Datos de contacto de una persona exigen base de licitud en el prospecto (las filas legado deben registrarla antes).
  if v_prospecto.base_licitud is null then
    raise exception 'base_licitud_requerida: registra la base de licitud del prospecto antes de agregar personas de contacto' using errcode = '23514';
  end if;
  -- La evidencia, el origen y la forma del correo los validan los CHECK de la tabla (23514).
  insert into core.prospecto_contacto_persona (prospecto_id, nombre, cargo, canal, dato, origen, confianza, evidencia_url, creado_por)
  values (p_prospecto_id, btrim(coalesce(p_nombre, '')), nullif(btrim(coalesce(p_cargo, '')), ''), p_canal, nullif(btrim(coalesce(p_dato, '')), ''), p_origen, p_confianza, btrim(coalesce(p_evidencia_url, '')), p_caller_id)
  returning * into v_row;
  insert into core.prospecto_evento (prospecto_id, tipo, actor_id, detalle)
  values (p_prospecto_id, 'enriquecimiento', p_caller_id, jsonb_build_object('accion', 'persona_agregada', 'origen', p_origen, 'canal', p_canal));
  return v_row;
end;
$$;
revoke all on function core.add_prospecto_persona_for_superadmin(uuid, uuid, text, text, text, text, text, text, text) from public, anon;
grant execute on function core.add_prospecto_persona_for_superadmin(uuid, uuid, text, text, text, text, text, text, text) to authenticated;

-- Linea de tiempo.
create or replace function core.list_prospecto_eventos_for_superadmin(p_caller_id uuid, p_prospecto_id uuid, p_limit integer default 50)
returns setof core.prospecto_evento
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'list_prospecto_eventos_for_superadmin: caller binding invalido (auth.uid() no coincide con p_caller_id)' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'list_prospecto_eventos_for_superadmin: solo un superadmin de plataforma real puede ejecutar esta accion' using errcode = '42501';
  end if;
  return query
    select e.* from core.prospecto_evento e
    where e.prospecto_id = p_prospecto_id
    order by e.creado_en desc, e.id
    limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;
revoke all on function core.list_prospecto_eventos_for_superadmin(uuid, uuid, integer) from public, anon;
grant execute on function core.list_prospecto_eventos_for_superadmin(uuid, uuid, integer) to authenticated;

-- Taxonomia: todas las versiones (la vigente es la de mayor version por vertical) con el plan sugerido y su precio
-- LEIDO de core.plan (null = 'precio por definir'; nunca se inventa).
create or replace function core.list_cerebro_taxonomia_for_superadmin(p_caller_id uuid)
returns table (
  id uuid, vertical text, version integer, vigente boolean, subtipos jsonb, rangos_tamano jsonb, senales jsonb, icp jsonb,
  objeciones jsonb, mensajes_base jsonb, contexto jsonb, plan_id text, plan_nombre text, plan_precio_base_mxn_centavos bigint,
  plan_precio_asiento_mxn_centavos bigint, plan_asientos_incluidos integer, estado_validacion text, nota_cambio text,
  vigente_desde timestamptz, creado_en timestamptz
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'list_cerebro_taxonomia_for_superadmin: caller binding invalido (auth.uid() no coincide con p_caller_id)' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'list_cerebro_taxonomia_for_superadmin: solo un superadmin de plataforma real puede ejecutar esta accion' using errcode = '42501';
  end if;
  return query
    select t.id, t.vertical, t.version,
           t.version = (select max(t2.version) from core.cerebro_taxonomia t2 where t2.vertical = t.vertical),
           t.subtipos, t.rangos_tamano, t.senales, t.icp, t.objeciones, t.mensajes_base, t.contexto,
           t.plan_id, pl.nombre, pl.precio_base_mxn_centavos, pl.precio_asiento_mxn_centavos, pl.asientos_incluidos,
           t.estado_validacion, t.nota_cambio, t.vigente_desde, t.creado_en
    from core.cerebro_taxonomia t
    left join core.plan pl on pl.id = t.plan_id
    order by t.vertical, t.version desc;
end;
$$;
revoke all on function core.list_cerebro_taxonomia_for_superadmin(uuid) from public, anon;
grant execute on function core.list_cerebro_taxonomia_for_superadmin(uuid) to authenticated;

-- Editar la taxonomia = INSERTAR una version nueva (version + 1) de esa vertical. Nunca hay UPDATE de una version.
-- `p_contenido`: {subtipos, rangos_tamano, senales, icp, objeciones, mensajes_base, contexto}; una clave ausente hereda
-- el valor de la version vigente. Un lock consultivo por vertical serializa dos ediciones simultaneas (el unique
-- (vertical, version) es el respaldo). Guardia de promesas: un mensaje base no puede traer porcentajes ni montos.
create or replace function core.save_cerebro_taxonomia_for_superadmin(
  p_caller_id uuid,
  p_vertical text,
  p_contenido jsonb,
  p_plan_id text,
  p_nota text,
  p_validada boolean default false
)
returns core.cerebro_taxonomia
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_actual core.cerebro_taxonomia;
  v_c jsonb := coalesce(p_contenido, '{}'::jsonb);
  v_mensajes jsonb;
  v_plan_vertical text;
  v_row core.cerebro_taxonomia;
begin
  perform core.superadmin_require_caller(p_caller_id, 'save_cerebro_taxonomia_for_superadmin');
  if p_vertical is null or p_vertical <> all (array['hoteles', 'restaurantes', 'rentas', 'licitaciones', 'citas', 'despachos']) then
    raise exception 'save_cerebro_taxonomia_for_superadmin: vertical invalida' using errcode = '22023';
  end if;
  if jsonb_typeof(v_c) <> 'object' then
    raise exception 'save_cerebro_taxonomia_for_superadmin: p_contenido debe ser un objeto' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('core.cerebro_taxonomia:' || p_vertical));
  select * into v_actual from core.cerebro_taxonomia where vertical = p_vertical order by version desc limit 1;

  v_mensajes := case when v_c ? 'mensajes_base' then v_c -> 'mensajes_base' else v_actual.mensajes_base end;
  if v_mensajes is null then
    raise exception 'save_cerebro_taxonomia_for_superadmin: mensajes_base requerido' using errcode = '22023';
  end if;
  if v_mensajes::text ~* '([0-9][0-9.,]*\s*%|\$\s*[0-9]|[0-9]\s*(mxn|pesos))' then
    raise exception 'mensajes_promesa_cifras: un mensaje base no puede prometer cifras (porcentajes ni montos)' using errcode = '23514';
  end if;

  if p_plan_id is not null then
    select pl.vertical into v_plan_vertical from core.plan pl where pl.id = p_plan_id;
    if v_plan_vertical is null then
      raise exception 'save_cerebro_taxonomia_for_superadmin: el plan % no existe', p_plan_id using errcode = '22023';
    end if;
    if v_plan_vertical <> p_vertical then
      raise exception 'save_cerebro_taxonomia_for_superadmin: el plan % es de la vertical %, no de %', p_plan_id, v_plan_vertical, p_vertical using errcode = '22023';
    end if;
  end if;

  insert into core.cerebro_taxonomia (
    vertical, version, subtipos, rangos_tamano, senales, icp, objeciones, mensajes_base, contexto,
    plan_id, estado_validacion, nota_cambio, creado_por
  ) values (
    p_vertical, coalesce(v_actual.version, 0) + 1,
    coalesce(case when v_c ? 'subtipos' then v_c -> 'subtipos' end, v_actual.subtipos, '[]'::jsonb),
    coalesce(case when v_c ? 'rangos_tamano' then v_c -> 'rangos_tamano' end, v_actual.rangos_tamano, '{}'::jsonb),
    coalesce(case when v_c ? 'senales' then v_c -> 'senales' end, v_actual.senales, '[]'::jsonb),
    coalesce(case when v_c ? 'icp' then v_c -> 'icp' end, v_actual.icp, '{}'::jsonb),
    coalesce(case when v_c ? 'objeciones' then v_c -> 'objeciones' end, v_actual.objeciones, '[]'::jsonb),
    v_mensajes,
    coalesce(case when v_c ? 'contexto' then v_c -> 'contexto' end, v_actual.contexto, '{}'::jsonb),
    p_plan_id,
    case when coalesce(p_validada, false) then 'validada' else 'propuesta_validar_con_javier' end,
    nullif(btrim(coalesce(p_nota, '')), ''),
    p_caller_id
  ) returning * into v_row;
  return v_row;
end;
$$;
revoke all on function core.save_cerebro_taxonomia_for_superadmin(uuid, text, jsonb, text, text, boolean) from public, anon;
grant execute on function core.save_cerebro_taxonomia_for_superadmin(uuid, text, jsonb, text, text, boolean) to authenticated;

-- 6. Semilla de la taxonomia (6.6 de la especificacion). TODO es PROPUESTA: rangos, puntos y subtipos los valida Javier.
-- Los mensajes base no prometen cifras. El precio no se guarda: sale de core.plan por `plan_id` (rentas, licitaciones
-- y despachos quedan en 'precio por configurar' y el panel dice 'precio por definir').
do $$
declare
  -- Senales de cierre comunes (misma regla para todas las verticales).
  v_cierre jsonb := '[
    {"tipo":"decisor_identificado","nombre":"Decisor identificado con evidencia","dimension":"cierre","puntos":25,"como_conseguirla":"Registra a la persona que decide, con la pagina publica donde aparece su nombre y cargo."},
    {"tipo":"respuesta_previa","nombre":"Pidio informacion o respondio","dimension":"cierre","puntos":35,"como_conseguirla":"Revisa si escribio por el formulario, WhatsApp o correo de Atiende y registra la fecha."}
  ]'::jsonb;
begin
  insert into core.cerebro_taxonomia (vertical, version, subtipos, rangos_tamano, senales, icp, objeciones, mensajes_base, contexto, plan_id, estado_validacion, nota_cambio) values
  ('restaurantes', 1,
   '[{"clave":"taqueria","nombre":"Taquería"},{"clave":"fonda","nombre":"Fonda / cocina económica"},{"clave":"cafeteria","nombre":"Cafetería"},{"clave":"dark_kitchen","nombre":"Dark kitchen"},{"clave":"cadena_pequena","nombre":"Cadena pequeña (2 a 10 sucursales)"},{"clave":"servicio_completo","nombre":"Restaurante de servicio completo"},{"clave":"marisqueria_bar","nombre":"Marisquería / bar-restaurante"}]'::jsonb,
   '{"unidad":"sucursales","rangos":[{"clave":"s1","etiqueta":"1"},{"clave":"s2_3","etiqueta":"2-3"},{"clave":"s4_10","etiqueta":"4-10"},{"clave":"s11_mas","etiqueta":"Más de 10"}]}'::jsonb,
   '[{"tipo":"whatsapp_publicado","nombre":"WhatsApp publicado en Google o redes","dimension":"ajuste","puntos":15,"como_conseguirla":"Busca el negocio en Google Maps e Instagram y anota la URL donde aparece el número de WhatsApp."},
     {"tipo":"menu_en_linea","nombre":"Menú en línea","dimension":"ajuste","puntos":10,"como_conseguirla":"Revisa su sitio o redes y anota la URL del menú."},
     {"tipo":"horario_extendido","nombre":"Horario extendido","dimension":"ajuste","puntos":5,"como_conseguirla":"Anota el horario publicado en Google Maps."},
     {"tipo":"resenas_no_contestan","nombre":"Reseñas que mencionan que no contestan el teléfono","dimension":"urgencia","puntos":35,"como_conseguirla":"Lee las reseñas recientes en Google Maps y anota la URL de la reseña."},
     {"tipo":"apps_delivery","nombre":"Presencia en apps de delivery (comisiones)","dimension":"urgencia","puntos":25,"como_conseguirla":"Busca el negocio en las apps de reparto y anota la URL de su ficha."},
     {"tipo":"vacante_telefonista","nombre":"Vacante de cajero o telefonista","dimension":"urgencia","puntos":30,"como_conseguirla":"Busca en bolsas de trabajo y en sus redes y anota la URL de la vacante."}]'::jsonb || v_cierre,
   '{"descripcion":"Reparte a domicilio o recibe muchos pedidos por teléfono o WhatsApp; de 1 a 10 sucursales; ticket medio o alto; dueño operador.","subtipos_objetivo":["taqueria","cafeteria","dark_kitchen","cadena_pequena","servicio_completo","marisqueria_bar"],"tamanos_objetivo":["s1","s2_3","s4_10"]}'::jsonb,
   '[{"objecion":"Mis clientes quieren hablar con una persona","respuesta":"El agente pasa la conversación a una persona cuando el cliente lo pide."},{"objecion":"Ya uso apps de reparto","respuesta":"Es un canal propio, sin comisión por pedido."},{"objecion":"Es caro","respuesta":"El precio es por agente de voz; el costo contra los pedidos recuperados se calcula con datos del prospecto, no se promete."}]'::jsonb,
   '[{"canal":"whatsapp","variante":"A","texto":"Hola {nombre}, vi que {restaurante} recibe pedidos por WhatsApp. En atiende.ai tenemos un agente que contesta llamadas y WhatsApp con tu menú, toma el pedido y lo manda a cocina, para que no se te vaya ninguno en hora pico. ¿Te muestro en 15 minutos cómo quedaría con tu menú? Si no te interesa, responde BAJA."}]'::jsonb,
   '{"dolor":"Llamadas y WhatsApp perdidos en hora pico, errores en pedidos, comisión de las apps.","propuesta_valor":"Agente de voz y WhatsApp que toma pedidos con el menú real, tienda en línea propia, cocina y reparto conectados.","metricas":["Demos agendadas por cada 100 toques","% de piloto ganado","Pedidos atendidos por el agente en la demo"],"restricciones":[]}'::jsonb,
   'restaurantes-estandar', 'propuesta_validar_con_javier', 'Semilla de la sección 6.6 de la especificación: propuesta, validar con Javier.'),
  ('hoteles', 1,
   '[{"clave":"boutique","nombre":"Boutique"},{"clave":"hostal","nombre":"Hostal"},{"clave":"resort_pequeno","nombre":"Resort pequeño (menos de 80 habitaciones)"},{"clave":"posada","nombre":"Posada"},{"clave":"hotel_ciudad","nombre":"Hotel de ciudad independiente"},{"clave":"cadena_regional","nombre":"Cadena regional pequeña"}]'::jsonb,
   '{"unidad":"habitaciones","rangos":[{"clave":"h_menos_20","etiqueta":"Menos de 20"},{"clave":"h20_50","etiqueta":"20-50"},{"clave":"h51_120","etiqueta":"51-120"},{"clave":"h_mas_120","etiqueta":"Más de 120"}]}'::jsonb,
   '[{"tipo":"boton_whatsapp_sitio","nombre":"Botón de WhatsApp en el sitio","dimension":"ajuste","puntos":15,"como_conseguirla":"Abre su sitio y anota la URL de la página donde aparece el botón."},
     {"tipo":"dependencia_otas","nombre":"Dependencia de OTAs","dimension":"ajuste","puntos":10,"como_conseguirla":"Revisa si sus ventas visibles están solo en Booking o Expedia y anota la URL."},
     {"tipo":"recepcion_24h_poco_personal","nombre":"Recepción de 24 h con poco personal","dimension":"ajuste","puntos":10,"como_conseguirla":"Anota lo que publica sobre su recepción y la URL."},
     {"tipo":"resenas_respuesta_lenta","nombre":"Reseñas sobre respuesta lenta","dimension":"urgencia","puntos":40,"como_conseguirla":"Lee las reseñas recientes y anota la URL de la reseña."},
     {"tipo":"vacante_recepcion","nombre":"Vacante de recepcionista o reservaciones","dimension":"urgencia","puntos":35,"como_conseguirla":"Busca en bolsas de trabajo y anota la URL de la vacante."}]'::jsonb || v_cierre,
   '{"descripcion":"Hotel independiente de 10 a 120 habitaciones, sin call center, con ventas directas por WhatsApp.","subtipos_objetivo":["boutique","hostal","resort_pequeno","posada","hotel_ciudad"],"tamanos_objetivo":["h_menos_20","h20_50","h51_120"]}'::jsonb,
   '[{"objecion":"Ya tengo PMS o channel manager","respuesta":"Se integra y convive con lo que ya usa."},{"objecion":"Mis huéspedes son internacionales","respuesta":"Hay que validar los idiomas que soporta el agente antes de ofrecerlo."},{"objecion":"Privacidad del huésped","respuesta":"El aviso de privacidad y el ejercicio de derechos ARCO van incluidos."}]'::jsonb,
   '[{"canal":"whatsapp","variante":"A","texto":"Hola {nombre}, soy de atiende.ai. Ayudamos a hoteles como {hotel} a contestar reservas por WhatsApp y teléfono a cualquier hora y a llevar tickets y limpieza en un solo lugar. ¿Le muestro una demo con sus tarifas? Responda BAJA si prefiere no recibir mensajes."}]'::jsonb,
   '{"dolor":"Reservas directas perdidas fuera de horario, comisión de OTAs y operación (housekeeping, tickets).","propuesta_valor":"Agente de reservas por WhatsApp y voz, tickets con SLA, housekeeping y facturación CFDI en un solo panel.","metricas":["Demos","Pilotos","% de reservas directas atendidas por el agente en el piloto"],"restricciones":[]}'::jsonb,
   'hoteles-estandar', 'propuesta_validar_con_javier', 'Semilla de la sección 6.6 de la especificación: propuesta, validar con Javier.'),
  ('rentas', 1,
   '[{"clave":"anfitrion_individual","nombre":"Anfitrión individual (1 a 2 propiedades)"},{"clave":"anfitrion_multiple","nombre":"Anfitrión múltiple (3 a 10)"},{"clave":"administradora","nombre":"Administradora / gestora (11 a 50)"},{"clave":"operador_grande","nombre":"Operador grande (más de 50)"},{"clave":"condominio_pool","nombre":"Condominio o desarrollo con pool de renta"}]'::jsonb,
   '{"unidad":"propiedades administradas","rangos":[{"clave":"p1_2","etiqueta":"1-2"},{"clave":"p3_10","etiqueta":"3-10"},{"clave":"p11_50","etiqueta":"11-50"},{"clave":"p51_mas","etiqueta":"Más de 50"}]}'::jsonb,
   '[{"tipo":"sitio_con_listado","nombre":"Sitio de la gestora con listado de propiedades","dimension":"ajuste","puntos":20,"como_conseguirla":"Abre su sitio y anota la URL del listado."},
     {"tipo":"anuncio_administramos","nombre":"Anuncio de «administramos tu propiedad»","dimension":"ajuste","puntos":15,"como_conseguirla":"Busca el anuncio en su sitio o redes y anota la URL."},
     {"tipo":"varios_destinos","nombre":"Presencia en varios destinos","dimension":"ajuste","puntos":10,"como_conseguirla":"Anota los destinos que publica y la URL."},
     {"tipo":"vacante_limpieza_operacion","nombre":"Vacante de limpieza u operación","dimension":"urgencia","puntos":40,"como_conseguirla":"Busca en bolsas de trabajo y anota la URL de la vacante."}]'::jsonb || v_cierre,
   '{"descripcion":"Gestoras de 5 a 50 unidades con varios propietarios y canales (Airbnb, Booking, directo).","subtipos_objetivo":["anfitrion_multiple","administradora","condominio_pool"],"tamanos_objetivo":["p3_10","p11_50"]}'::jsonb,
   '[{"objecion":"Ya uso un PMS como Guesty u Hostaway","respuesta":"El enfoque es México: precio en pesos y liquidación a propietarios."},{"objecion":"No quiero que una IA hable con mis huéspedes","respuesta":"Los mensajes son siempre un borrador con aprobación humana."}]'::jsonb,
   '[{"canal":"whatsapp","variante":"A","texto":"Hola {nombre}, vi que {gestora} administra propiedades en {destino}. atiende.ai junta tus calendarios, evita dobles reservas y te arma el estado de cuenta de cada propietario. ¿Te interesa verlo con 2 o 3 de tus propiedades? Responde BAJA si no quieres más mensajes."}]'::jsonb,
   '{"dolor":"Dobles reservas entre canales, mensajes repetitivos a huéspedes y liquidación a propietarios a mano.","propuesta_valor":"Calendario unificado iCal con conflictos, mensajería con aprobación, limpieza y estado de cuenta del propietario.","metricas":["Demos","Unidades en piloto","Conflictos detectados en el piloto"],"restricciones":[]}'::jsonb,
   'rentas-estandar', 'propuesta_validar_con_javier', 'Semilla de la sección 6.6 de la especificación: propuesta, validar con Javier.'),
  ('despachos', 1,
   '[{"clave":"independiente","nombre":"Contador independiente"},{"clave":"despacho_chico","nombre":"Despacho chico (2 a 5 personas)"},{"clave":"despacho_mediano","nombre":"Despacho mediano (6 a 20)"},{"clave":"despacho_grande","nombre":"Despacho grande (más de 20)"},{"clave":"especializado","nombre":"Especializado (nómina, comercio exterior, RESICO)"}]'::jsonb,
   '{"unidad":"personas","rangos":[{"clave":"d1","etiqueta":"1"},{"clave":"d2_5","etiqueta":"2-5"},{"clave":"d6_20","etiqueta":"6-20"},{"clave":"d21_mas","etiqueta":"Más de 20"}]}'::jsonb,
   '[{"tipo":"servicios_contabilidad_electronica","nombre":"Sitio o perfil con contabilidad electrónica y DIOT","dimension":"ajuste","puntos":20,"como_conseguirla":"Revisa su sitio o perfil y anota la URL de la página de servicios."},
     {"tipo":"membresia_colegio","nombre":"Membresía en un colegio de contadores","dimension":"ajuste","puntos":10,"como_conseguirla":"Busca el directorio público del colegio y anota la URL."},
     {"tipo":"publica_cambios_sat","nombre":"Publicaciones sobre cambios del SAT","dimension":"ajuste","puntos":10,"como_conseguirla":"Revisa sus redes y blog y anota la URL de una publicación reciente."},
     {"tipo":"vacante_auxiliar_contable","nombre":"Vacante de auxiliar contable","dimension":"urgencia","puntos":40,"como_conseguirla":"Busca en bolsas de trabajo y anota la URL de la vacante."}]'::jsonb || v_cierre,
   '{"descripcion":"Despacho de 2 a 20 personas con una cartera de 20 a 300 contribuyentes, mucho CFDI y cierre mensual manual.","subtipos_objetivo":["despacho_chico","despacho_mediano","especializado"],"tamanos_objetivo":["d2_5","d6_20"]}'::jsonb,
   '[{"objecion":"Ya uso CONTPAQi o Aspel","respuesta":"Es un complemento, no un reemplazo."},{"objecion":"Seguridad de la e.firma","respuesta":"No se almacena la FIEL; hay que verificar lo que soporta el módulo de despachos antes de afirmarlo."},{"objecion":"Precio por cliente","respuesta":"El precio está por definir."}]'::jsonb,
   '[{"canal":"whatsapp","variante":"A","texto":"Hola {nombre}, en atiende.ai ayudamos a despachos a conciliar CFDI contra estados de cuenta, vigilar la lista 69-B y llevar el cierre de cada cliente en un tablero. ¿Le muestro cómo se vería con uno de sus clientes? Responda BAJA si prefiere no recibir mensajes."}]'::jsonb,
   '{"dolor":"Descarga y conciliación de CFDI, calendario de obligaciones, 69-B/EFOS y pedir documentos a los clientes.","propuesta_valor":"Conciliación asistida, alertas 69-B, cierre mensual y portal del cliente.","metricas":["Demos","Contribuyentes cargados en el piloto","Horas de cierre reportadas por el despacho (declaradas, no prometidas)"],"restricciones":[]}'::jsonb,
   'despachos-estandar', 'propuesta_validar_con_javier', 'Semilla de la sección 6.6 de la especificación: propuesta, validar con Javier.'),
  ('licitaciones', 1,
   '[{"clave":"pyme_licita","nombre":"PyME que ya licita"},{"clave":"pyme_inicia","nombre":"PyME que quiere empezar"},{"clave":"proveedor_recurrente","nombre":"Proveedor recurrente de una dependencia"},{"clave":"consultor_gestor","nombre":"Consultor o gestor de licitaciones"}]'::jsonb,
   '{"unidad":"procedimientos por año","rangos":[{"clave":"l0","etiqueta":"0"},{"clave":"l1_5","etiqueta":"1-5"},{"clave":"l6_30","etiqueta":"6-30"},{"clave":"l31_mas","etiqueta":"Más de 30"}]}'::jsonb,
   '[{"tipo":"contratos_adjudicados_recientes","nombre":"Contratos adjudicados recientes en ComprasMX","dimension":"ajuste","puntos":25,"como_conseguirla":"Consulta los datos abiertos de contrataciones y anota la URL del registro."},
     {"tipo":"padron_proveedores","nombre":"Registro en el padrón de proveedores","dimension":"ajuste","puntos":15,"como_conseguirla":"Consulta el padrón público y anota la URL."},
     {"tipo":"giro_convocatorias_frecuentes","nombre":"Giro con convocatorias frecuentes","dimension":"ajuste","puntos":10,"como_conseguirla":"Revisa las convocatorias de su giro y anota la URL de una reciente."},
     {"tipo":"vacante_licitaciones","nombre":"Vacante de licitaciones","dimension":"urgencia","puntos":40,"como_conseguirla":"Busca en bolsas de trabajo y anota la URL de la vacante."}]'::jsonb || v_cierre,
   '{"descripcion":"PyMEs con 1 a 30 procedimientos al año en giros recurrentes (limpieza, papelería, TI, obra menor, insumos médicos).","subtipos_objetivo":["pyme_licita","pyme_inicia","proveedor_recurrente"],"tamanos_objetivo":["l1_5","l6_30"]}'::jsonb,
   '[{"objecion":"No quiero que la IA decida","respuesta":"Decide la persona; la IA prepara."},{"objecion":"Riesgo de desechamiento","respuesta":"Hay checklist de requisitos y una revisión previa antes de enviar."},{"objecion":"Confidencialidad","respuesta":"Cada organización está aislada de las demás."}]'::jsonb,
   '[{"canal":"whatsapp","variante":"A","texto":"Hola {nombre}, vimos que {empresa} participa en licitaciones de {giro}. atiende.ai te avisa de convocatorias de tu giro, te arma el checklist de requisitos y te marca los plazos para que no se te pase ninguno. ¿Te enseño las convocatorias abiertas de tu giro esta semana? Responde BAJA si no quieres más mensajes."}]'::jsonb,
   '{"dolor":"Encontrar convocatorias a tiempo, requisitos y plazos, propuestas a mano y riesgo de desechamiento.","propuesta_valor":"Descubrimiento de convocatorias, semáforo de plazos, checklist de requisitos, go/no-go y KYC 69-B.","metricas":["Demos","Convocatorias seguidas en el piloto","Propuestas presentadas a tiempo"],"restricciones":["Nunca prometer adjudicaciones ni insinuar influencia."]}'::jsonb,
   'licitaciones-estandar', 'propuesta_validar_con_javier', 'Semilla de la sección 6.6 de la especificación: propuesta, validar con Javier.'),
  ('citas', 1,
   '[{"clave":"consultorio","nombre":"Consultorio médico"},{"clave":"clinica_multi","nombre":"Clínica multi-especialidad"},{"clave":"dentista","nombre":"Dentista"},{"clave":"estetica_salon","nombre":"Estética / salón"},{"clave":"barberia","nombre":"Barbería"},{"clave":"spa","nombre":"Spa"},{"clave":"fisio_nutricion","nombre":"Fisioterapia / nutrición"},{"clave":"psicologia","nombre":"Psicología (protocolo especial de crisis)"}]'::jsonb,
   '{"unidad":"doctores o sillones/cabinas","rangos":[{"clave":"c1","etiqueta":"1"},{"clave":"c2_5","etiqueta":"2-5"},{"clave":"c6_15","etiqueta":"6-15"},{"clave":"c16_mas","etiqueta":"Más de 15"}]}'::jsonb,
   '[{"tipo":"whatsapp_canal_citas","nombre":"WhatsApp como canal de citas","dimension":"ajuste","puntos":15,"como_conseguirla":"Revisa su sitio, Google Maps o redes y anota la URL donde invita a agendar por WhatsApp."},
     {"tipo":"varios_profesionales","nombre":"Varios profesionales en el sitio","dimension":"ajuste","puntos":15,"como_conseguirla":"Cuenta los profesionales publicados en su sitio y anota la URL."},
     {"tipo":"agenda_papel_o_calendar","nombre":"Agenda en papel o Google Calendar","dimension":"ajuste","puntos":10,"como_conseguirla":"Anota lo que publica o menciona sobre cómo lleva su agenda y la URL."},
     {"tipo":"resenas_dificil_agendar","nombre":"Reseñas sobre «difícil agendar»","dimension":"urgencia","puntos":40,"como_conseguirla":"Lee las reseñas recientes y anota la URL de la reseña."},
     {"tipo":"vacante_recepcionista","nombre":"Vacante de recepcionista","dimension":"urgencia","puntos":35,"como_conseguirla":"Busca en bolsas de trabajo y anota la URL de la vacante."}]'::jsonb || v_cierre,
   '{"descripcion":"De 1 a 15 profesionales con agenda saturada por WhatsApp y teléfono, y ausencias que cuestan.","subtipos_objetivo":["consultorio","clinica_multi","dentista","estetica_salon","barberia","spa","fisio_nutricion"],"tamanos_objetivo":["c1","c2_5","c6_15"]}'::jsonb,
   '[{"objecion":"Mis pacientes son mayores","respuesta":"Hay voz y teléfono además de WhatsApp."},{"objecion":"Datos de salud","respuesta":"Aviso de privacidad, derechos ARCO y protocolo de crisis."},{"objecion":"Ya uso Doctoralia","respuesta":"Es un canal propio, sin comisión."}]'::jsonb,
   '[{"canal":"whatsapp","variante":"A","texto":"Hola {nombre}, en atiende.ai ayudamos a {tipo} como {negocio} a agendar por WhatsApp y teléfono, mandar recordatorios y llenar huecos con lista de espera. ¿Le muestro cómo quedaría con su agenda? Responda BAJA si prefiere no recibir mensajes."}]'::jsonb,
   '{"dolor":"Ausencias (no-show), llamadas perdidas y dobles citas.","propuesta_valor":"Agenda por WhatsApp y voz, recordatorios, lista de espera y reagendado.","metricas":["Demos","Pilotos","% de ausencias en el piloto contra su base declarada"],"restricciones":[]}'::jsonb,
   'citas-estandar', 'propuesta_validar_con_javier', 'Semilla de la sección 6.6 de la especificación: propuesta, validar con Javier.')
  on conflict (vertical, version) do nothing;
end;
$$;
