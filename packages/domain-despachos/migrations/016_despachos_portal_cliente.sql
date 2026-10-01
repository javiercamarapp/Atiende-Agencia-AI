-- D-08 -- Portal del cliente final del despacho contable. El cliente del despacho (no es staff, no
-- tiene cuenta) entra por un ENLACE con token: ve el estatus de sus obligaciones fiscales y de sus
-- cierres mensuales, sube sus CFDI (XML) y documentos (PDF/imagen) y intercambia mensajes simples con
-- el despacho. Cada enlace pertenece a UNA property (un cliente del despacho): es imposible por
-- construcción ver datos de otro cliente u otro despacho.
--
-- Modelo:
--   * `despachos.portal_cliente_enlace`    -- un enlace por contacto/uso. Guarda SOLO el hash SHA-256 del
--                                              token (el token en claro jamás se persiste ni se loguea),
--                                              expiración obligatoria (<= 400 días) y revocación.
--   * `despachos.portal_cliente_documento` -- archivo subido por el cliente (bytea, <= 2 MiB) en bandeja
--                                              `recibido` hasta que el staff lo acepta o rechaza.
--   * `despachos.portal_cliente_mensaje`   -- hilo simple cliente <-> despacho por property.
--
-- Seguridad (cada punto lo ejerce scripts/verify-despachos-portal-cliente/assertions.sql):
--   1. Las 3 tablas: RLS habilitado y REVOKE de todo a public/anon/authenticated; después SOLO se
--      concede SELECT a `authenticated` (staff) a nivel COLUMNA y con policy `core.has_property_access`
--      -- justificación: el staff necesita listar enlaces/documentos/mensajes de SUS clientes, pero
--      `token_hash` (enlace) y `contenido` (documento, hasta 2 MiB) NO están en el GRANT, así que ni
--      un `select *` ni una policy permisiva los exponen. Ninguna escritura directa: INSERT/UPDATE/
--      DELETE no se conceden a nadie; todo cambio pasa por las funciones de abajo. No hay
--      `using (true)` ni GRANT a anon.
--   2. Funciones del CLIENTE (`portal_cliente_resumen`, `portal_cliente_documento_recibir`,
--      `portal_cliente_mensaje_enviar`): SOLO SISTEMA. security definer, search_path fijo,
--      `auth.uid() is null` o 42501, revoke de public, EXECUTE solo a `authenticated` (la sesión de
--      sistema de la app corre bajo ese rol sin sub; mismo precedente que `efos_ingestar_periodo`, 014).
--      Cualquier sesión con sub real (staff, otro usuario) se rechaza DENTRO de la función; anon no
--      tiene EXECUTE. Reciben el HASH del token (la API lo calcula), validan que exista, no esté
--      revocado ni expirado y de ahí derivan property/organización: el cliente jamás elige property.
--      Token inválido, expirado, revocado o inexistente producen el MISMO error (P0002
--      `enlace_no_valido`) -> sin enumeración ni oráculo de estado.
--   3. Funciones del STAFF (`portal_enlace_crear`, `portal_enlace_revocar`, `portal_documento_contenido`,
--      `portal_documento_resolver`, `portal_mensaje_staff_enviar`): exigen `auth.uid()` no nulo y
--      `core.has_property_access(auth.uid(), property)`; el staff de otra property/organización recibe
--      42501. `portal_enlace_crear` además exige que la property sea de vertical despachos y acota a 20
--      enlaces vigentes por property.
--   4. Defensa en profundidad del archivo en la propia base (la API ya valida antes): tamaño 1 B..2 MiB,
--      combinación tipo/mime cerrada, firma de bytes (%PDF-, PNG, JPEG), y para XML se rechazan
--      `<!DOCTYPE` y `<!ENTITY` (sin DTD ni entidades). Nada se ejecuta ni se interpreta aquí.
--   5. Topes de abuso: 300 documentos en bandeja por property, 30 documentos/hora por enlace, 30
--      mensajes/hora del cliente por property (SQLSTATE 54000). Subida idempotente por (property,
--      SHA-256): reenviar el mismo archivo no duplica la fila (replay).
--
-- Compatibilidad con la base sin migrar: el TypeScript que consume estas funciones captura
-- 42883/42P01/42703 dentro de SAVEPOINT (runWithSavepointFallback) y degrada a "portal no disponible
-- aún" (lista vacía + estado), nunca a un 500. Orden de despliegue: esta migración se puede aplicar
-- antes o después del código; sin ella el portal muestra "no disponible" y el panel del despacho
-- lo dice.

create table despachos.portal_cliente_enlace (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  etiqueta text not null check (char_length(etiqueta) between 1 and 80),
  creado_por uuid not null references core.staff_user(id) on delete restrict,
  creado_en timestamptz not null default now(),
  expira_en timestamptz not null,
  revocado_en timestamptz,
  ultimo_uso_en timestamptz,
  usos integer not null default 0 check (usos >= 0),
  check (expira_en > creado_en and expira_en <= creado_en + interval '400 days')
);
create index portal_cliente_enlace_property_idx on despachos.portal_cliente_enlace (property_id, creado_en desc);

create table despachos.portal_cliente_documento (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  enlace_id uuid not null references despachos.portal_cliente_enlace(id) on delete cascade,
  tipo text not null check (tipo in ('cfdi_xml', 'pdf', 'imagen')),
  nombre_archivo text not null check (char_length(nombre_archivo) between 1 and 120 and nombre_archivo !~ '[/\\<>:"|?*[:cntrl:]]'),
  mime_type text not null check (
    (tipo = 'cfdi_xml' and mime_type in ('application/xml', 'text/xml'))
    or (tipo = 'pdf' and mime_type = 'application/pdf')
    or (tipo = 'imagen' and mime_type in ('image/png', 'image/jpeg'))
  ),
  tamano_bytes integer not null check (tamano_bytes between 1 and 2097152),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  contenido bytea not null,
  resumen jsonb not null default '{}'::jsonb check (jsonb_typeof(resumen) = 'object' and octet_length(resumen::text) <= 4096),
  estado text not null default 'recibido' check (estado in ('recibido', 'aceptado', 'rechazado')),
  motivo text check (motivo is null or char_length(motivo) <= 500),
  invoice_id uuid references despachos.invoice(id) on delete set null,
  creado_en timestamptz not null default now(),
  resuelto_en timestamptz,
  resuelto_por uuid references core.staff_user(id) on delete set null,
  unique (property_id, sha256),
  check ((estado = 'recibido' and resuelto_en is null) or (estado <> 'recibido' and resuelto_en is not null))
);
create index portal_cliente_documento_property_idx on despachos.portal_cliente_documento (property_id, creado_en desc);
create index portal_cliente_documento_enlace_idx on despachos.portal_cliente_documento (enlace_id, creado_en desc);

create table despachos.portal_cliente_mensaje (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  autor text not null check (autor in ('cliente', 'despacho')),
  staff_user_id uuid references core.staff_user(id) on delete set null,
  cuerpo text not null check (char_length(cuerpo) between 1 and 2000),
  creado_en timestamptz not null default now()
);
create index portal_cliente_mensaje_property_idx on despachos.portal_cliente_mensaje (property_id, creado_en desc);

alter table despachos.portal_cliente_enlace enable row level security;
alter table despachos.portal_cliente_documento enable row level security;
alter table despachos.portal_cliente_mensaje enable row level security;
revoke all on despachos.portal_cliente_enlace from public, anon, authenticated;
revoke all on despachos.portal_cliente_documento from public, anon, authenticated;
revoke all on despachos.portal_cliente_mensaje from public, anon, authenticated;

-- Lectura del staff, por columna: sin `token_hash` ni `contenido`.
grant select (id, organization_id, property_id, etiqueta, creado_por, creado_en, expira_en, revocado_en, ultimo_uso_en, usos)
  on despachos.portal_cliente_enlace to authenticated;
grant select (id, organization_id, property_id, enlace_id, tipo, nombre_archivo, mime_type, tamano_bytes, sha256, resumen, estado, motivo, invoice_id, creado_en, resuelto_en, resuelto_por)
  on despachos.portal_cliente_documento to authenticated;
grant select (id, organization_id, property_id, autor, staff_user_id, cuerpo, creado_en)
  on despachos.portal_cliente_mensaje to authenticated;

create policy "staff ve enlaces del portal de su property" on despachos.portal_cliente_enlace for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve documentos del portal de su property" on despachos.portal_cliente_documento for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve mensajes del portal de su property" on despachos.portal_cliente_mensaje for select
  using (core.has_property_access(auth.uid(), property_id));

-- Helper interno (no se concede a nadie): resuelve el enlace VIGENTE por hash. Falla siempre con el
-- mismo error genérico, sin distinguir inexistente/expirado/revocado.
create or replace function despachos.portal_cliente_enlace_resolver(p_token_hash text)
returns despachos.portal_cliente_enlace
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
declare
  v despachos.portal_cliente_enlace;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'enlace_no_valido' using errcode = 'P0002';
  end if;
  select * into v
  from despachos.portal_cliente_enlace e
  where e.token_hash = p_token_hash and e.revocado_en is null and e.expira_en > now();
  if not found then
    raise exception 'enlace_no_valido' using errcode = 'P0002';
  end if;
  return v;
end;
$$;
revoke all on function despachos.portal_cliente_enlace_resolver(text) from public;

-- 1) CLIENTE: resumen del portal (obligaciones, cierres, documentos y mensajes de SU property).
create or replace function despachos.portal_cliente_resumen(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v despachos.portal_cliente_enlace;
  v_resultado jsonb;
begin
  if auth.uid() is not null then
    raise exception 'portal_cliente_resumen: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;
  v := despachos.portal_cliente_enlace_resolver(p_token_hash);

  -- Contador de accesos muestreado a lo sumo 1 vez por minuto (evita una escritura por cada GET).
  update despachos.portal_cliente_enlace
     set usos = usos + 1, ultimo_uso_en = now()
   where id = v.id and (ultimo_uso_en is null or ultimo_uso_en < now() - interval '1 minute');

  select jsonb_build_object(
    'cliente', jsonb_build_object('nombre', p.name),
    'despacho', jsonb_build_object('nombre', coalesce(tp.razon_social, o.name)),
    'expira_en', v.expira_en,
    'obligaciones', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tipo', d.tipo, 'periodo', d.periodo, 'fecha_limite', d.fecha_limite,
               'estado', d.estado, 'fecha_presentacion', d.fecha_presentacion)
             order by d.fecha_limite desc, d.tipo)
      from (select * from despachos.fiscal_deadline f where f.property_id = v.property_id order by f.fecha_limite desc, f.tipo limit 24) d
    ), '[]'::jsonb),
    'cierres', coalesce((
      select jsonb_agg(jsonb_build_object(
               'anio', c.anio, 'mes', c.mes, 'estado', c.status,
               'tareas_total', (select count(*) from despachos.periodo_cierre_tarea t where t.periodo_cierre_id = c.id and t.required),
               'tareas_listas', (select count(*) from despachos.periodo_cierre_tarea t where t.periodo_cierre_id = c.id and t.required and t.status in ('done', 'skipped')))
             order by c.anio desc, c.mes desc)
      from (select * from despachos.periodo_cierre pc where pc.property_id = v.property_id order by pc.anio desc, pc.mes desc limit 12) c
    ), '[]'::jsonb),
    'documentos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'tipo', x.tipo, 'nombre_archivo', x.nombre_archivo, 'estado', x.estado,
               'motivo', x.motivo, 'creado_en', x.creado_en)
             order by x.creado_en desc)
      from (select * from despachos.portal_cliente_documento dd where dd.property_id = v.property_id order by dd.creado_en desc limit 20) x
    ), '[]'::jsonb),
    'mensajes', coalesce((
      select jsonb_agg(jsonb_build_object('autor', m.autor, 'cuerpo', m.cuerpo, 'creado_en', m.creado_en) order by m.creado_en asc)
      from (select * from despachos.portal_cliente_mensaje mm where mm.property_id = v.property_id order by mm.creado_en desc limit 50) m
    ), '[]'::jsonb)
  ) into v_resultado
  from core.property p
  join core.organization o on o.id = p.organization_id
  left join despachos.tenant_profile tp on tp.organization_id = o.id
  where p.id = v.property_id;

  return v_resultado;
end;
$$;
revoke all on function despachos.portal_cliente_resumen(text) from public;
grant execute on function despachos.portal_cliente_resumen(text) to authenticated;

-- 2) CLIENTE: recibir un documento. Idempotente por (property, SHA-256 calculado AQUÍ, no confiado).
create or replace function despachos.portal_cliente_documento_recibir(
  p_token_hash text, p_tipo text, p_nombre_archivo text, p_mime_type text, p_contenido bytea, p_resumen jsonb
)
returns table (out_id uuid, out_estado text, out_duplicado boolean)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v despachos.portal_cliente_enlace;
  v_len integer;
  v_sha text;
  v_id uuid;
  v_existente despachos.portal_cliente_documento;
begin
  if auth.uid() is not null then
    raise exception 'portal_cliente_documento_recibir: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;
  v := despachos.portal_cliente_enlace_resolver(p_token_hash);

  if p_contenido is null then
    raise exception 'portal_cliente_documento_recibir: archivo vacío' using errcode = '22023';
  end if;
  v_len := octet_length(p_contenido);
  if v_len < 1 or v_len > 2097152 then
    raise exception 'portal_cliente_documento_recibir: tamaño fuera de rango (1 B a 2 MiB)' using errcode = '22023';
  end if;
  if p_tipo = 'pdf' and substring(p_contenido from 1 for 5) <> decode('255044462d', 'hex') then
    raise exception 'portal_cliente_documento_recibir: no es un PDF' using errcode = '22023';
  elsif p_tipo = 'imagen' and not (
    substring(p_contenido from 1 for 8) = decode('89504e470d0a1a0a', 'hex')
    or substring(p_contenido from 1 for 3) = decode('ffd8ff', 'hex')
  ) then
    raise exception 'portal_cliente_documento_recibir: no es PNG/JPEG' using errcode = '22023';
  elsif p_tipo = 'cfdi_xml' and (
    position(decode('3c21444f43545950', 'hex') in p_contenido) > 0   -- '<!DOCTYPE'
    or position(decode('3c21454e54495459', 'hex') in p_contenido) > 0 -- '<!ENTITY'
  ) then
    raise exception 'portal_cliente_documento_recibir: XML con DTD/entidades no permitido' using errcode = '22023';
  end if;

  v_sha := encode(sha256(p_contenido), 'hex');

  -- Replay: mismo archivo para la misma property -> la fila ya existente, sin duplicar ni contar cuota.
  select * into v_existente from despachos.portal_cliente_documento d where d.property_id = v.property_id and d.sha256 = v_sha;
  if found then
    return query select v_existente.id, v_existente.estado, true;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('despachos.portal_cliente_documento:' || v.property_id::text, 0));
  if (select count(*) from despachos.portal_cliente_documento d where d.property_id = v.property_id and d.estado = 'recibido') >= 300 then
    raise exception 'portal_cliente_documento_recibir: bandeja llena' using errcode = '54000';
  end if;
  if (select count(*) from despachos.portal_cliente_documento d where d.enlace_id = v.id and d.creado_en > now() - interval '1 hour') >= 30 then
    raise exception 'portal_cliente_documento_recibir: demasiados archivos en la última hora' using errcode = '54000';
  end if;

  insert into despachos.portal_cliente_documento
    (organization_id, property_id, enlace_id, tipo, nombre_archivo, mime_type, tamano_bytes, sha256, contenido, resumen)
  values
    (v.organization_id, v.property_id, v.id, p_tipo, p_nombre_archivo, p_mime_type, v_len, v_sha, p_contenido, coalesce(p_resumen, '{}'::jsonb))
  on conflict (property_id, sha256) do nothing
  returning id into v_id;

  if v_id is null then
    select * into v_existente from despachos.portal_cliente_documento d where d.property_id = v.property_id and d.sha256 = v_sha;
    return query select v_existente.id, v_existente.estado, true;
    return;
  end if;
  return query select v_id, 'recibido'::text, false;
end;
$$;
revoke all on function despachos.portal_cliente_documento_recibir(text, text, text, text, bytea, jsonb) from public;
grant execute on function despachos.portal_cliente_documento_recibir(text, text, text, text, bytea, jsonb) to authenticated;

-- 3) CLIENTE: mensaje al despacho.
create or replace function despachos.portal_cliente_mensaje_enviar(p_token_hash text, p_cuerpo text)
returns uuid
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v despachos.portal_cliente_enlace;
  v_cuerpo text;
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'portal_cliente_mensaje_enviar: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;
  v := despachos.portal_cliente_enlace_resolver(p_token_hash);
  v_cuerpo := btrim(coalesce(p_cuerpo, ''));
  if char_length(v_cuerpo) < 1 or char_length(v_cuerpo) > 2000 then
    raise exception 'portal_cliente_mensaje_enviar: el mensaje debe tener entre 1 y 2000 caracteres' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.portal_cliente_mensaje:' || v.property_id::text, 0));
  if (select count(*) from despachos.portal_cliente_mensaje m where m.property_id = v.property_id and m.autor = 'cliente' and m.creado_en > now() - interval '1 hour') >= 30 then
    raise exception 'portal_cliente_mensaje_enviar: demasiados mensajes en la última hora' using errcode = '54000';
  end if;
  insert into despachos.portal_cliente_mensaje (organization_id, property_id, autor, cuerpo)
  values (v.organization_id, v.property_id, 'cliente', v_cuerpo)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function despachos.portal_cliente_mensaje_enviar(text, text) from public;
grant execute on function despachos.portal_cliente_mensaje_enviar(text, text) to authenticated;

-- 4) STAFF: crear enlace (la API genera el token y entrega solo el hash).
create or replace function despachos.portal_enlace_crear(p_property_id uuid, p_token_hash text, p_etiqueta text, p_dias integer)
returns table (out_id uuid, out_expira_en timestamptz)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_etiqueta text;
  v_id uuid;
  v_expira timestamptz;
begin
  if auth.uid() is null or not core.has_property_access(auth.uid(), p_property_id) then
    raise exception 'portal_enlace_crear: sin acceso a la property' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'portal_enlace_crear: la property no es de despachos' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'portal_enlace_crear: hash inválido' using errcode = '22023';
  end if;
  v_etiqueta := btrim(coalesce(p_etiqueta, ''));
  if char_length(v_etiqueta) < 1 or char_length(v_etiqueta) > 80 then
    raise exception 'portal_enlace_crear: etiqueta de 1 a 80 caracteres' using errcode = '22023';
  end if;
  if p_dias is null or p_dias < 1 or p_dias > 365 then
    raise exception 'portal_enlace_crear: vigencia de 1 a 365 días' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.portal_cliente_enlace:' || p_property_id::text, 0));
  if (select count(*) from despachos.portal_cliente_enlace e where e.property_id = p_property_id and e.revocado_en is null and e.expira_en > now()) >= 20 then
    raise exception 'portal_enlace_crear: máximo 20 enlaces vigentes por cliente' using errcode = '54000';
  end if;
  v_expira := now() + make_interval(days => p_dias);
  insert into despachos.portal_cliente_enlace (organization_id, property_id, token_hash, etiqueta, creado_por, expira_en)
  values (v_org, p_property_id, p_token_hash, v_etiqueta, auth.uid(), v_expira)
  returning id into v_id;
  return query select v_id, v_expira;
end;
$$;
revoke all on function despachos.portal_enlace_crear(uuid, text, text, integer) from public;
grant execute on function despachos.portal_enlace_crear(uuid, text, text, integer) to authenticated;

-- 5) STAFF: revocar enlace (idempotente; false si no existe en esa property o ya estaba revocado).
create or replace function despachos.portal_enlace_revocar(p_property_id uuid, p_enlace_id uuid)
returns boolean
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_n integer;
begin
  if auth.uid() is null or not core.has_property_access(auth.uid(), p_property_id) then
    raise exception 'portal_enlace_revocar: sin acceso a la property' using errcode = '42501';
  end if;
  update despachos.portal_cliente_enlace
     set revocado_en = now()
   where id = p_enlace_id and property_id = p_property_id and revocado_en is null;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
revoke all on function despachos.portal_enlace_revocar(uuid, uuid) from public;
grant execute on function despachos.portal_enlace_revocar(uuid, uuid) to authenticated;

-- 6) STAFF: contenido de un documento (para revisarlo o ingerirlo como CFDI). Única vía a `contenido`.
create or replace function despachos.portal_documento_contenido(p_property_id uuid, p_documento_id uuid)
returns table (out_tipo text, out_nombre_archivo text, out_mime_type text, out_estado text, out_contenido bytea)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
begin
  if auth.uid() is null or not core.has_property_access(auth.uid(), p_property_id) then
    raise exception 'portal_documento_contenido: sin acceso a la property' using errcode = '42501';
  end if;
  return query
    select d.tipo, d.nombre_archivo, d.mime_type, d.estado, d.contenido
    from despachos.portal_cliente_documento d
    where d.id = p_documento_id and d.property_id = p_property_id;
end;
$$;
revoke all on function despachos.portal_documento_contenido(uuid, uuid) from public;
grant execute on function despachos.portal_documento_contenido(uuid, uuid) to authenticated;

-- 7) STAFF: aceptar/rechazar un documento 'recibido' (una sola resolución; false si ya estaba resuelto).
create or replace function despachos.portal_documento_resolver(p_property_id uuid, p_documento_id uuid, p_estado text, p_motivo text, p_invoice_id uuid)
returns boolean
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_n integer;
begin
  if auth.uid() is null or not core.has_property_access(auth.uid(), p_property_id) then
    raise exception 'portal_documento_resolver: sin acceso a la property' using errcode = '42501';
  end if;
  if p_estado is null or p_estado not in ('aceptado', 'rechazado') then
    raise exception 'portal_documento_resolver: estado inválido' using errcode = '22023';
  end if;
  if p_motivo is not null and char_length(p_motivo) > 500 then
    raise exception 'portal_documento_resolver: motivo de hasta 500 caracteres' using errcode = '22023';
  end if;
  if p_invoice_id is not null and not exists (select 1 from despachos.invoice i where i.id = p_invoice_id and i.property_id = p_property_id) then
    raise exception 'portal_documento_resolver: el CFDI no pertenece a esta property' using errcode = '42501';
  end if;
  update despachos.portal_cliente_documento
     set estado = p_estado, motivo = nullif(btrim(coalesce(p_motivo, '')), ''), invoice_id = p_invoice_id,
         resuelto_en = now(), resuelto_por = auth.uid()
   where id = p_documento_id and property_id = p_property_id and estado = 'recibido';
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
revoke all on function despachos.portal_documento_resolver(uuid, uuid, text, text, uuid) from public;
grant execute on function despachos.portal_documento_resolver(uuid, uuid, text, text, uuid) to authenticated;

-- 8) STAFF: responder al cliente.
create or replace function despachos.portal_mensaje_staff_enviar(p_property_id uuid, p_cuerpo text)
returns uuid
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_cuerpo text;
  v_id uuid;
begin
  if auth.uid() is null or not core.has_property_access(auth.uid(), p_property_id) then
    raise exception 'portal_mensaje_staff_enviar: sin acceso a la property' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'portal_mensaje_staff_enviar: la property no es de despachos' using errcode = '42501';
  end if;
  v_cuerpo := btrim(coalesce(p_cuerpo, ''));
  if char_length(v_cuerpo) < 1 or char_length(v_cuerpo) > 2000 then
    raise exception 'portal_mensaje_staff_enviar: el mensaje debe tener entre 1 y 2000 caracteres' using errcode = '22023';
  end if;
  insert into despachos.portal_cliente_mensaje (organization_id, property_id, autor, staff_user_id, cuerpo)
  values (v_org, p_property_id, 'despacho', auth.uid(), v_cuerpo)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function despachos.portal_mensaje_staff_enviar(uuid, text) from public;
grant execute on function despachos.portal_mensaje_staff_enviar(uuid, text) to authenticated;
