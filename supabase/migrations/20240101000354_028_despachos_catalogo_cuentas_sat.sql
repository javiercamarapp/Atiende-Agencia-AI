-- D-P3-16 / D-P3-17 / D-P3-44 -- Catálogo de cuentas con lo que el XSD de contabilidad electrónica 1.3 exige de cada cuenta:
-- nivel, cuenta padre (SubCtaDe) y código agrupador del SAT (CodAgrup, Anexo 24).
--
-- Cambios (todos aditivos sobre `despachos.libro_cuenta`, migración 020):
--   * `nivel`              integer >= 1. 1 = cuenta de mayor; n > 1 = subcuenta de una de nivel n-1.
--   * `cuenta_padre`       código de la cuenta de la que es subcuenta (NULL en nivel 1). Llave foránea COMPUESTA
--                          (property_id, cuenta_padre) -> (property_id, codigo): el padre es de la MISMA property, nunca de otra.
--   * `codigo_agrupador`   formato del SAT `ddd` o `ddd.d` / `ddd.dd`. NULL = «sin asignar».
--
-- NO se inventa ningún valor: las cuentas que ya existen quedan con nivel 1, sin padre y SIN código agrupador (NULL). El generador
-- del XML se niega a producir el catálogo mientras haya cuentas sin código y devuelve la lista de las que faltan; el staff las
-- asigna en la pestaña Catálogo. La lista cerrada de códigos válidos (1080 valores del XSD CatalogosParaEsqContE 1.3) la valida la
-- API (normas/anexo-24-codigo-agrupador.yaml); aquí solo el CHECK de formato, porque la lista cambia con cada actualización del Anexo 24.
--
-- Funciones (reemplazan a las de la migración 020; mismas firmas de uso, con parámetros opcionales nuevos):
--   * `libro_cuenta_guardar`          alta/edición de una cuenta; parámetros nuevos opcionales (NULL = no cambia). Se elimina la
--                                      sobrecarga de 4 parámetros para que una llamada de 4 argumentos no sea ambigua; el código
--                                      TypeScript que la usa sigue funcionando igual contra esta firma (y contra la base sin migrar).
--   * `libro_catalogo_sembrar`        la siembra del catálogo base ahora trae nivel/padre/código; en cuentas ya existentes SOLO completa
--                                      lo que está vacío (nunca pisa un código o una jerarquía ya capturados).
--   * `libro_cuenta_agrupador_asignar` (nueva) asigna el código agrupador a varias cuentas de un cliente en una sola operación.
--   * `libro_catalogo_importar`       (nueva) importa el catálogo XML 1.3 de otro proveedor con la semántica de `mergeCuentas`
--                                      (REQ-MIG-017): mismo código = se actualiza; código nuevo = se agrega; NUNCA se borra una cuenta.
--
-- Seguridad (la ejerce scripts/verify-despachos-catalogo-cuentas-sat/assertions.sql):
--   1. NO se concede ningún GRANT nuevo sobre la tabla: `authenticated` conserva SOLO `select` (migración 020) y la policy
--      `core.has_property_access` existente cubre las columnas nuevas. Toda escritura pasa por las funciones de abajo, por lo que
--      tampoco hace falta GRANT por columna. Sin `using (true)` y sin GRANT a anon.
--   2. Las tres funciones de escritura son `security definer` con `set search_path = despachos, pg_temp`, `revoke all ... from
--      public, anon` y EXECUTE solo a `authenticated`; exigen `auth.uid()` no nulo y `despachos.cartera_puede_escribir(property)`
--      (rol admin/contador en la organización despachos de ESA property) y que la property sea de despachos. Un contador de otra
--      organización recibe 42501.
--   3. Cross-tenant: la llave foránea compuesta impide un padre de otra property aunque se mienta en el JSON; las funciones además
--      resuelven la organización desde `core.property` (nunca del cuerpo de la petición).
--   4. Una cuenta con partidas no cambia de naturaleza (regla de 020, también en la importación).
--   5. Topes: máximo 2000 cuentas por cliente y 500 por operación de importación o siembra.
--
-- Compatibilidad con la base sin migrar: el TypeScript que consume esto captura 42883/42P01/42703 dentro de SAVEPOINT
-- (runWithSavepointFallback) y responde «no disponible aún»; contra la base vieja la edición simple de una cuenta (4 argumentos)
-- sigue llamando a la función de 020. Esta migración se puede aplicar antes o después del código.

-- ---------------------------------------------------------------------------
-- Columnas nuevas.
-- ---------------------------------------------------------------------------
alter table despachos.libro_cuenta
  add column nivel integer not null default 1 check (nivel between 1 and 10),
  add column cuenta_padre text,
  add column codigo_agrupador text check (codigo_agrupador is null or codigo_agrupador ~ '^[0-9]{3}(\.[0-9]{1,2})?$');

alter table despachos.libro_cuenta
  add constraint libro_cuenta_padre_fk foreign key (property_id, cuenta_padre) references despachos.libro_cuenta (property_id, codigo),
  add constraint libro_cuenta_padre_distinto_ck check (cuenta_padre is null or cuenta_padre <> codigo),
  add constraint libro_cuenta_nivel_padre_ck check ((nivel = 1) = (cuenta_padre is null));
create index libro_cuenta_padre_idx on despachos.libro_cuenta (property_id, cuenta_padre) where cuenta_padre is not null;

-- El padre debe ser de nivel inmediato superior (nivel - 1): así la jerarquía no puede tener ciclos. Trigger de SECURITY INVOKER:
-- solo lee la propia tabla con el rol que escribe (las funciones definer de abajo, o service_role en soporte).
create or replace function despachos.libro_cuenta_jerarquia_tg() returns trigger
language plpgsql
set search_path = despachos, pg_temp
as $$
declare
  v_nivel_padre integer;
begin
  if new.cuenta_padre is not null then
    select c.nivel into v_nivel_padre from despachos.libro_cuenta c where c.property_id = new.property_id and c.codigo = new.cuenta_padre;
    if v_nivel_padre is null or v_nivel_padre <> new.nivel - 1 then
      raise exception 'libro_cuenta: el padre de la cuenta % debe existir y ser de nivel %', new.codigo, new.nivel - 1 using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function despachos.libro_cuenta_jerarquia_tg() from public, anon, authenticated;
create trigger libro_cuenta_jerarquia
  before insert or update of nivel, cuenta_padre on despachos.libro_cuenta
  for each row execute function despachos.libro_cuenta_jerarquia_tg();

-- ---------------------------------------------------------------------------
-- Siembra del catálogo base (ahora con nivel / padre / código agrupador).
-- ---------------------------------------------------------------------------
create or replace function despachos.libro_catalogo_sembrar(p_property_id uuid, p_cuentas jsonb)
returns integer
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_nuevas integer;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'libro_catalogo_sembrar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'libro_catalogo_sembrar: la property no es de despachos' using errcode = '42501';
  end if;
  if p_cuentas is null or jsonb_typeof(p_cuentas) <> 'array' or jsonb_array_length(p_cuentas) < 1 or jsonb_array_length(p_cuentas) > 500 then
    raise exception 'libro_catalogo_sembrar: se esperan de 1 a 500 cuentas' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.libro_cuenta:' || p_property_id::text, 0));
  select count(*) into v_nuevas from (select distinct btrim(c.codigo) as codigo from jsonb_to_recordset(p_cuentas) as c(codigo text, descripcion text, naturaleza text)) n
    where not exists (select 1 from despachos.libro_cuenta x where x.property_id = p_property_id and x.codigo = n.codigo);
  if (select count(*) from despachos.libro_cuenta x where x.property_id = p_property_id) + v_nuevas > 2000 then
    raise exception 'libro_catalogo_sembrar: máximo 2000 cuentas por cliente' using errcode = '54000';
  end if;
  -- Orden por nivel: el padre se inserta antes que sus subcuentas (el trigger de jerarquía lo exige). `nivel` ausente = 1.
  -- En cuentas que YA existen solo se completa lo vacío: código agrupador si es NULL, y jerarquía si la cuenta sigue en nivel 1 sin
  -- padre. Nunca se pisa una descripción, naturaleza, código o jerarquía ya capturados.
  insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, nivel, cuenta_padre, codigo_agrupador)
  select p_property_id, v_org, d.codigo, d.descripcion, d.naturaleza, d.nivel, d.cuenta_padre, d.codigo_agrupador
  from (
    select distinct on (btrim(c.codigo)) btrim(c.codigo) as codigo, btrim(c.descripcion) as descripcion, c.naturaleza, coalesce(c.nivel, 1) as nivel,
           nullif(btrim(c.cuenta_padre), '') as cuenta_padre, nullif(btrim(c.codigo_agrupador), '') as codigo_agrupador
    from jsonb_to_recordset(p_cuentas) as c(codigo text, descripcion text, naturaleza text, nivel integer, cuenta_padre text, codigo_agrupador text)
    order by btrim(c.codigo)
  ) d
  order by d.nivel, d.codigo
  on conflict (property_id, codigo) do update set
    codigo_agrupador = coalesce(despachos.libro_cuenta.codigo_agrupador, excluded.codigo_agrupador),
    nivel = case when despachos.libro_cuenta.cuenta_padre is null and despachos.libro_cuenta.nivel = 1 and excluded.cuenta_padre is not null then excluded.nivel else despachos.libro_cuenta.nivel end,
    cuenta_padre = case when despachos.libro_cuenta.cuenta_padre is null and despachos.libro_cuenta.nivel = 1 then excluded.cuenta_padre else despachos.libro_cuenta.cuenta_padre end
  where despachos.libro_cuenta.codigo_agrupador is null
     or (despachos.libro_cuenta.cuenta_padre is null and despachos.libro_cuenta.nivel = 1 and excluded.cuenta_padre is not null);
  -- Devuelve cuántas cuentas NUEVAS se agregaron (completar metadatos de cuentas existentes no cuenta).
  return v_nuevas;
exception
  when check_violation or invalid_text_representation or datatype_mismatch or foreign_key_violation then
    raise exception 'libro_catalogo_sembrar: cuenta inválida (código de 4 a 10 dígitos, descripción, naturaleza D/A, padre existente y código agrupador ddd o ddd.dd)' using errcode = '22023';
end;
$$;
revoke all on function despachos.libro_catalogo_sembrar(uuid, jsonb) from public, anon;
grant execute on function despachos.libro_catalogo_sembrar(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Alta / edición de UNA cuenta (con jerarquía y código agrupador opcionales).
-- ---------------------------------------------------------------------------
drop function if exists despachos.libro_cuenta_guardar(uuid, text, text, text);
create or replace function despachos.libro_cuenta_guardar(
  p_property_id uuid,
  p_codigo text,
  p_descripcion text,
  p_naturaleza text,
  p_nivel integer default null,
  p_cuenta_padre text default null,
  p_codigo_agrupador text default null
)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_codigo text := btrim(coalesce(p_codigo, ''));
  v_desc text := btrim(coalesce(p_descripcion, ''));
  v_padre text := nullif(btrim(coalesce(p_cuenta_padre, '')), '');
  v_agrup text := nullif(btrim(coalesce(p_codigo_agrupador, '')), '');
  v_actual text;
  v_nivel integer;
  v_nivel_actual integer;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'libro_cuenta_guardar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'libro_cuenta_guardar: la property no es de despachos' using errcode = '42501';
  end if;
  if v_codigo !~ '^[0-9]{4,10}$' or char_length(v_desc) < 1 or char_length(v_desc) > 200 or p_naturaleza is null or p_naturaleza not in ('D', 'A') then
    raise exception 'libro_cuenta_guardar: código de 4 a 10 dígitos, descripción de 1 a 200 caracteres y naturaleza D/A' using errcode = '22023';
  end if;
  if v_agrup is not null and v_agrup !~ '^[0-9]{3}(\.[0-9]{1,2})?$' then
    raise exception 'libro_cuenta_guardar: el código agrupador del SAT es ddd o ddd.dd' using errcode = '22023';
  end if;
  if p_nivel is not null and (p_nivel < 1 or p_nivel > 10) then
    raise exception 'libro_cuenta_guardar: nivel de 1 a 10' using errcode = '22023';
  end if;
  if p_nivel is not null and (p_nivel = 1) <> (v_padre is null) then
    raise exception 'libro_cuenta_guardar: el nivel 1 no lleva cuenta padre y los demás niveles sí' using errcode = '22023';
  end if;
  if p_nivel is null and v_padre is not null then
    raise exception 'libro_cuenta_guardar: indica el nivel junto con la cuenta padre' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.libro_cuenta:' || p_property_id::text, 0));
  if (select count(*) from despachos.libro_cuenta c where c.property_id = p_property_id) >= 2000
     and not exists (select 1 from despachos.libro_cuenta c where c.property_id = p_property_id and c.codigo = v_codigo) then
    raise exception 'libro_cuenta_guardar: máximo 2000 cuentas por cliente' using errcode = '54000';
  end if;
  if v_padre is not null then
    if v_padre = v_codigo then
      raise exception 'libro_cuenta_guardar: una cuenta no es subcuenta de sí misma' using errcode = '22023';
    end if;
    -- Mismo rubro (primer dígito): una subcuenta de gastos no cuelga de una cuenta de activo.
    if left(v_padre, 1) <> left(v_codigo, 1) then
      raise exception 'libro_cuenta_guardar: la cuenta padre debe ser del mismo rubro (primer dígito)' using errcode = '22023';
    end if;
    if not exists (select 1 from despachos.libro_cuenta c where c.property_id = p_property_id and c.codigo = v_padre and c.nivel = p_nivel - 1) then
      raise exception 'libro_cuenta_guardar: la cuenta padre debe existir en el catálogo del cliente con nivel %', p_nivel - 1 using errcode = '22023';
    end if;
  end if;
  select c.naturaleza, c.nivel into v_actual, v_nivel_actual from despachos.libro_cuenta c where c.property_id = p_property_id and c.codigo = v_codigo;
  if v_actual is null then
    v_nivel := coalesce(p_nivel, 1);
    insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, nivel, cuenta_padre, codigo_agrupador)
    values (p_property_id, v_org, v_codigo, v_desc, p_naturaleza, v_nivel, v_padre, v_agrup);
  else
    if v_actual <> p_naturaleza and exists (select 1 from despachos.libro_movimiento m where m.property_id = p_property_id and m.cuenta = v_codigo) then
      raise exception 'libro_cuenta_guardar: una cuenta con partidas no cambia de naturaleza' using errcode = '22023';
    end if;
    if p_nivel is not null and p_nivel <> v_nivel_actual and exists (select 1 from despachos.libro_cuenta h where h.property_id = p_property_id and h.cuenta_padre = v_codigo) then
      raise exception 'libro_cuenta_guardar: una cuenta con subcuentas no cambia de nivel' using errcode = '22023';
    end if;
    update despachos.libro_cuenta set
      descripcion = v_desc,
      naturaleza = p_naturaleza,
      nivel = coalesce(p_nivel, nivel),
      cuenta_padre = case when p_nivel is null then cuenta_padre else v_padre end,
      codigo_agrupador = coalesce(v_agrup, codigo_agrupador)
    where property_id = p_property_id and codigo = v_codigo;
  end if;
end;
$$;
revoke all on function despachos.libro_cuenta_guardar(uuid, text, text, text, integer, text, text) from public, anon;
grant execute on function despachos.libro_cuenta_guardar(uuid, text, text, text, integer, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Asignación masiva del código agrupador: [{codigo, codigo_agrupador}, ...].
-- ---------------------------------------------------------------------------
create or replace function despachos.libro_cuenta_agrupador_asignar(p_property_id uuid, p_asignaciones jsonb)
returns integer
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_actualizadas integer;
  v_inexistentes integer;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'libro_cuenta_agrupador_asignar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  if not exists (select 1 from core.property p where p.id = p_property_id and p.vertical = 'despachos') then
    raise exception 'libro_cuenta_agrupador_asignar: la property no es de despachos' using errcode = '42501';
  end if;
  if p_asignaciones is null or jsonb_typeof(p_asignaciones) <> 'array' or jsonb_array_length(p_asignaciones) < 1 or jsonb_array_length(p_asignaciones) > 500 then
    raise exception 'libro_cuenta_agrupador_asignar: se esperan de 1 a 500 asignaciones' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.libro_cuenta:' || p_property_id::text, 0));
  select count(*) into v_inexistentes
  from (select distinct btrim(a.codigo) as codigo from jsonb_to_recordset(p_asignaciones) as a(codigo text, codigo_agrupador text)) n
  where not exists (select 1 from despachos.libro_cuenta c where c.property_id = p_property_id and c.codigo = n.codigo);
  if v_inexistentes > 0 then
    raise exception 'libro_cuenta_agrupador_asignar: hay cuentas que no existen en el catálogo del cliente' using errcode = '22023';
  end if;
  update despachos.libro_cuenta c set codigo_agrupador = btrim(a.codigo_agrupador)
  from jsonb_to_recordset(p_asignaciones) as a(codigo text, codigo_agrupador text)
  where c.property_id = p_property_id and c.codigo = btrim(a.codigo);
  get diagnostics v_actualizadas = row_count;
  return v_actualizadas;
exception
  when check_violation or invalid_text_representation or datatype_mismatch then
    raise exception 'libro_cuenta_agrupador_asignar: código agrupador inválido (ddd o ddd.dd)' using errcode = '22023';
end;
$$;
revoke all on function despachos.libro_cuenta_agrupador_asignar(uuid, jsonb) from public, anon;
grant execute on function despachos.libro_cuenta_agrupador_asignar(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Importación del catálogo de otro proveedor: [{codigo, descripcion, naturaleza, nivel, cuenta_padre, codigo_agrupador}].
-- ---------------------------------------------------------------------------
create or replace function despachos.libro_catalogo_importar(p_property_id uuid, p_cuentas jsonb)
returns table (out_agregadas integer, out_actualizadas integer)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_nuevas integer;
  v_existentes integer;
  v_cambio_naturaleza integer;
  v_norm jsonb;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'libro_catalogo_importar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'libro_catalogo_importar: la property no es de despachos' using errcode = '42501';
  end if;
  if p_cuentas is null or jsonb_typeof(p_cuentas) <> 'array' or jsonb_array_length(p_cuentas) < 1 or jsonb_array_length(p_cuentas) > 500 then
    raise exception 'libro_catalogo_importar: se esperan de 1 a 500 cuentas' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.libro_cuenta:' || p_property_id::text, 0));

  -- Se normaliza y deduplica por código UNA vez (gana la última aparición); sin tablas temporales.
  select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) into v_norm from (
    select distinct on (x.codigo) x.codigo, x.descripcion, x.naturaleza, x.nivel, x.cuenta_padre, x.codigo_agrupador
    from (
      select btrim(e.elem->>'codigo') as codigo, btrim(e.elem->>'descripcion') as descripcion, e.elem->>'naturaleza' as naturaleza,
             coalesce((e.elem->>'nivel')::integer, 1) as nivel, nullif(btrim(e.elem->>'cuenta_padre'), '') as cuenta_padre,
             nullif(btrim(e.elem->>'codigo_agrupador'), '') as codigo_agrupador, e.ord
      from jsonb_array_elements(p_cuentas) with ordinality as e(elem, ord)
    ) x
    order by x.codigo, x.ord desc
  ) d;

  select count(*) filter (where not exists (select 1 from despachos.libro_cuenta x where x.property_id = p_property_id and x.codigo = t.codigo)),
         count(*) filter (where exists (select 1 from despachos.libro_cuenta x where x.property_id = p_property_id and x.codigo = t.codigo))
    into v_nuevas, v_existentes
  from jsonb_to_recordset(v_norm) as t(codigo text, descripcion text, naturaleza text, nivel integer, cuenta_padre text, codigo_agrupador text);
  if (select count(*) from despachos.libro_cuenta x where x.property_id = p_property_id) + v_nuevas > 2000 then
    raise exception 'libro_catalogo_importar: máximo 2000 cuentas por cliente' using errcode = '54000';
  end if;
  -- Una cuenta con partidas no cambia de naturaleza, tampoco por importación.
  select count(*) into v_cambio_naturaleza
  from jsonb_to_recordset(v_norm) as t(codigo text, descripcion text, naturaleza text, nivel integer, cuenta_padre text, codigo_agrupador text)
  join despachos.libro_cuenta x on x.property_id = p_property_id and x.codigo = t.codigo
  where x.naturaleza <> t.naturaleza
    and exists (select 1 from despachos.libro_movimiento m where m.property_id = p_property_id and m.cuenta = t.codigo);
  if v_cambio_naturaleza > 0 then
    raise exception 'libro_catalogo_importar: una cuenta con partidas no cambia de naturaleza' using errcode = '22023';
  end if;
  -- Una cuenta con subcuentas existentes no cambia de nivel.
  if exists (
    select 1 from jsonb_to_recordset(v_norm) as t(codigo text, descripcion text, naturaleza text, nivel integer, cuenta_padre text, codigo_agrupador text)
    join despachos.libro_cuenta x on x.property_id = p_property_id and x.codigo = t.codigo
    where x.nivel <> t.nivel and exists (select 1 from despachos.libro_cuenta h where h.property_id = p_property_id and h.cuenta_padre = t.codigo)
  ) then
    raise exception 'libro_catalogo_importar: una cuenta con subcuentas no cambia de nivel' using errcode = '22023';
  end if;

  -- Orden por nivel: el padre antes que sus subcuentas.
  insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, nivel, cuenta_padre, codigo_agrupador)
  select p_property_id, v_org, t.codigo, t.descripcion, t.naturaleza, t.nivel, t.cuenta_padre, t.codigo_agrupador
  from jsonb_to_recordset(v_norm) as t(codigo text, descripcion text, naturaleza text, nivel integer, cuenta_padre text, codigo_agrupador text)
  order by t.nivel, t.codigo
  on conflict (property_id, codigo) do update set
    descripcion = excluded.descripcion,
    naturaleza = excluded.naturaleza,
    nivel = excluded.nivel,
    cuenta_padre = excluded.cuenta_padre,
    codigo_agrupador = coalesce(excluded.codigo_agrupador, despachos.libro_cuenta.codigo_agrupador);
  return query select v_nuevas, v_existentes;
exception
  when check_violation or invalid_text_representation or datatype_mismatch or foreign_key_violation then
    raise exception 'libro_catalogo_importar: cuenta inválida (código de 4 a 10 dígitos, descripción, naturaleza D/A, padre existente y código agrupador ddd o ddd.dd)' using errcode = '22023';
end;
$$;
revoke all on function despachos.libro_catalogo_importar(uuid, jsonb) from public, anon;
grant execute on function despachos.libro_catalogo_importar(uuid, jsonb) to authenticated;
