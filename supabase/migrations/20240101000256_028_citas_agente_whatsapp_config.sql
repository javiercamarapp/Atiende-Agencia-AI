-- C-15 (citas) -- conectar el numero de WhatsApp y editar la personalidad del agente desde el panel.
-- Prefijo de supabase/migrations asignado: 20240101000256 (interno 028).
--
-- Hasta hoy `citas.whatsapp_config` (003) solo se llenaba con SQL a mano, y el agente de WhatsApp de citas hablaba
-- siempre igual (nombre "este negocio", tono fijo). Esta migracion agrega: (1) la tabla de la personalidad del agente
-- (nombre, tono, mensaje de bienvenida y reglas del negocio), (2) las funciones para guardarla y leerla, y (3) las funciones
-- para conectar / desconectar el numero. El prompt con las reglas duras vive en el codigo y NO es editable: lo que se guarda
-- aqui son textos cortos de una linea (nunca el prompt completo).
--
-- Decision de diseno: tabla y funciones NUEVAS. Lo unico existente que se toca es `citas.whatsapp_config` (ver abajo). El
-- codigo TypeScript que usa estos objetos degrada con SAVEPOINT al comportamiento anterior (agente con la personalidad de
-- siempre; la pantalla muestra "no disponible aun") mientras la base no tenga esta migracion (SQLSTATE 42883/42P01/42703):
-- nada de esto se aplica al mergear.
--
-- Justificacion de seguridad de cada objeto:
--  * citas.whatsapp_agent_config (una fila por organizacion). RLS habilitado. `revoke all ... from public, anon,
--    authenticated, service_role` y despues SOLO `select` por COLUMNA para `authenticated`; la policy limita la lectura a
--    owner/admin de la organizacion. NO hay GRANT ni policy de INSERT/UPDATE/DELETE: toda escritura pasa por
--    `save_whatsapp_agent_config` (deny-by-default). Los CHECK acotan largo, tono permitido y prohiben caracteres de control
--    (el texto termina dentro del prompt del modelo: un tope corto y de una linea por regla limita la superficie de texto
--    libre que un owner, o una cuenta comprometida, puede meter ahi; las reglas duras del prompt siguen antes y no se editan).
--  * citas.save_whatsapp_agent_config -- `security definer`, `set search_path = citas, core, pg_temp`, `revoke ... from
--    public, anon`, EXECUTE solo para `authenticated`. Exige `auth.uid()` no nulo y membership owner/admin en
--    `p_organization_id` (42501 si no; el actor SIEMPRE sale de auth.uid()). Bloquea la fila `for update` y compara la version
--    esperada (AT409 si cambio entre tanto). Valida largo/tono/lineas de nuevo en SQL (22023) para no depender solo del TS.
--  * citas.whatsapp_agent_config_envio -- lectura para ARMAR EL PROMPT del turno de WhatsApp. El webhook corre en sesion de
--    SISTEMA (`auth.uid()` nulo, mismo mecanismo que 021/022/025/026): se acepta esa sesion o a un miembro de la organizacion;
--    otra organizacion recibe 42501. Devuelve solo las 4 columnas que entran al prompt (ni version ni autor). `stable`,
--    `security definer`, search_path fijo, EXECUTE para authenticated y service_role.
--  * citas.connect_whatsapp_number -- `security definer`, search_path fijo, solo `authenticated` con membership owner/admin
--    (42501 si no). El `phone_number_id` de Meta se valida (solo digitos, 5-40) y se hace upsert por organizacion. Si ya lo usa
--    OTRA organizacion (unique) responde `AT410` con un mensaje generico: el numero no puede estar en dos negocios porque el
--    webhook rutea por el. No revela cual es la otra organizacion. Un numero es un identificador de ruteo, NO una credencial:
--    el app_secret y el token de envio son de la plataforma y nunca pasan por esta tabla.
--  * citas.disconnect_whatsapp_number -- mismo guard owner/admin; borra la fila de la organizacion (sin ella el webhook deja de
--    rutear mensajes a este negocio y los avisos no salen).
--  * citas.whatsapp_config (existente, 003). Hasta hoy su policy `for all` dejaba escribir a CUALQUIER miembro del staff (rol
--    `staff` incluido): quien controla ese numero controla a que negocio llegan los mensajes. Se reemplaza por una policy de
--    SELECT para miembros y se revoca INSERT/UPDATE/DELETE a `authenticated`: ahora solo las dos funciones de arriba (con rol
--    owner/admin) la escriben. `service_role` conserva todos sus privilegios (el codigo no escribe ahi como staff).
--
-- Requiere: 001_citas_schema.sql, 003 (citas.whatsapp_config) y 0001_core_schema.sql (core.membership/staff_user).

create table citas.whatsapp_agent_config (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  agent_name text check (agent_name is null or (char_length(agent_name) between 1 and 60 and agent_name !~ '[[:cntrl:]]')),
  tone_style text check (tone_style is null or tone_style in ('calido_cercano', 'formal_directo', 'profesional_neutro', 'divertido_desenfadado')),
  greeting_text text check (greeting_text is null or (char_length(greeting_text) between 1 and 200 and greeting_text !~ '[[:cntrl:]]')),
  -- Hasta 5 reglas, una por linea (el salto de linea es el unico caracter de control permitido).
  rules_text text check (rules_text is null or (char_length(rules_text) between 1 and 800 and rules_text !~ E'[\\x01-\\x09\\x0b-\\x1f\\x7f]')),
  version integer not null default 1 check (version >= 1),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table citas.whatsapp_agent_config enable row level security;

create policy "owner/admin lee la personalidad del agente de whatsapp" on citas.whatsapp_agent_config for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = whatsapp_agent_config.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin')
  ));

revoke all on citas.whatsapp_agent_config from public, anon, authenticated, service_role;
grant select (organization_id, agent_name, tone_style, greeting_text, rules_text, version, updated_by, updated_at)
  on citas.whatsapp_agent_config to authenticated;

-- Guardar o restablecer. `p_expected_version` = 0 cuando todavia no hay fila. Devuelve la version nueva.
-- AT409 si la version vigente no es la esperada; 42501 sin sesion o sin rol owner/admin; 22023 datos invalidos.
create or replace function citas.save_whatsapp_agent_config(
  p_organization_id uuid,
  p_expected_version integer,
  p_accion text,
  p_config jsonb
) returns integer
language plpgsql
security definer
set search_path = citas, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_old citas.whatsapp_agent_config;
  v_version integer;
  v_name text;
  v_tone text;
  v_greeting text;
  v_rules text;
begin
  if v_uid is null or p_organization_id is null or not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = v_uid and m.vertical_role in ('owner', 'admin')
  ) then
    raise exception 'save_whatsapp_agent_config: sin acceso' using errcode = '42501';
  end if;
  if p_accion not in ('actualizado', 'restablecido') then
    raise exception 'save_whatsapp_agent_config: accion invalida' using errcode = '22023';
  end if;

  if p_accion = 'actualizado' then
    v_name := nullif(btrim(p_config ->> 'agentName'), '');
    v_tone := nullif(btrim(p_config ->> 'toneStyle'), '');
    v_greeting := nullif(btrim(p_config ->> 'greetingText'), '');
    v_rules := nullif(btrim(p_config ->> 'rulesText', E' \t\r\n'), '');
    if v_tone is not null and v_tone not in ('calido_cercano', 'formal_directo', 'profesional_neutro', 'divertido_desenfadado') then
      raise exception 'save_whatsapp_agent_config: tono invalido' using errcode = '22023';
    end if;
    if v_rules is not null and (
      coalesce(array_length(string_to_array(v_rules, E'\n'), 1), 0) > 5
      or exists (select 1 from unnest(string_to_array(v_rules, E'\n')) l where char_length(btrim(l)) > 160)
    ) then
      raise exception 'save_whatsapp_agent_config: maximo 5 reglas de 160 caracteres' using errcode = '22023';
    end if;
  end if;

  select * into v_old from citas.whatsapp_agent_config c where c.organization_id = p_organization_id for update;
  if not found then
    if coalesce(p_expected_version, 0) <> 0 then
      raise exception 'save_whatsapp_agent_config: la configuracion cambio' using errcode = 'AT409';
    end if;
    v_version := 1;
  else
    if p_expected_version is distinct from v_old.version then
      raise exception 'save_whatsapp_agent_config: la configuracion cambio' using errcode = 'AT409';
    end if;
    v_version := v_old.version + 1;
  end if;

  insert into citas.whatsapp_agent_config as c (organization_id, agent_name, tone_style, greeting_text, rules_text, version, updated_by, updated_at)
  values (p_organization_id, v_name, v_tone, v_greeting, v_rules, v_version, v_uid, now())
  on conflict (organization_id) do update set
    agent_name = excluded.agent_name, tone_style = excluded.tone_style, greeting_text = excluded.greeting_text,
    rules_text = excluded.rules_text, version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return v_version;
exception
  when unique_violation then
    -- Dos primeras escrituras a la vez: la segunda pierde y el codigo la devuelve como conflicto.
    raise exception 'save_whatsapp_agent_config: la configuracion cambio' using errcode = 'AT409';
end;
$$;

-- Lectura para armar el prompt del turno (sesion de sistema del webhook o miembro de la organizacion). Sin fila: 0 filas.
create or replace function citas.whatsapp_agent_config_envio(p_organization_id uuid)
returns table (agent_name text, tone_style text, greeting_text text, rules_text text)
language plpgsql
stable
security definer
set search_path = citas, core, pg_temp
as $$
begin
  if auth.uid() is not null and not exists (
    select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = auth.uid()
  ) then
    raise exception 'whatsapp_agent_config_envio: sin acceso' using errcode = '42501';
  end if;
  return query
  select c.agent_name, c.tone_style, c.greeting_text, c.rules_text
    from citas.whatsapp_agent_config c
   where c.organization_id = p_organization_id;
end;
$$;

-- Conectar (o cambiar / activar / pausar) el numero de WhatsApp Business del negocio. Devuelve el `phone_number_id` guardado.
create or replace function citas.connect_whatsapp_number(p_organization_id uuid, p_phone_number_id text, p_is_active boolean)
returns text
language plpgsql
security definer
set search_path = citas, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_id text := btrim(p_phone_number_id);
begin
  if v_uid is null or p_organization_id is null or not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = v_uid and m.vertical_role in ('owner', 'admin')
  ) then
    raise exception 'connect_whatsapp_number: sin acceso' using errcode = '42501';
  end if;
  if v_id is null or v_id !~ '^[0-9]{5,40}$' then
    raise exception 'connect_whatsapp_number: identificador invalido' using errcode = '22023';
  end if;

  insert into citas.whatsapp_config as w (organization_id, phone_number_id, is_active)
  values (p_organization_id, v_id, coalesce(p_is_active, true))
  on conflict (organization_id) do update set phone_number_id = excluded.phone_number_id, is_active = excluded.is_active;
  return v_id;
exception
  when unique_violation then
    -- El numero ya esta en OTRO negocio: el webhook rutea por el, no puede estar en dos. Mensaje generico a proposito.
    raise exception 'connect_whatsapp_number: ese numero ya esta conectado a otro negocio' using errcode = 'AT410';
end;
$$;

-- Desconectar: sin fila el webhook deja de rutear mensajes a este negocio y los avisos no salen. Devuelve si habia numero.
create or replace function citas.disconnect_whatsapp_number(p_organization_id uuid)
returns boolean
language plpgsql
security definer
set search_path = citas, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null or p_organization_id is null or not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = v_uid and m.vertical_role in ('owner', 'admin')
  ) then
    raise exception 'disconnect_whatsapp_number: sin acceso' using errcode = '42501';
  end if;
  delete from citas.whatsapp_config w where w.organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function citas.save_whatsapp_agent_config(uuid, integer, text, jsonb) from public, anon;
revoke all on function citas.whatsapp_agent_config_envio(uuid) from public, anon;
revoke all on function citas.connect_whatsapp_number(uuid, text, boolean) from public, anon;
revoke all on function citas.disconnect_whatsapp_number(uuid) from public, anon;
grant execute on function citas.save_whatsapp_agent_config(uuid, integer, text, jsonb) to authenticated;
grant execute on function citas.whatsapp_agent_config_envio(uuid) to authenticated, service_role;
grant execute on function citas.connect_whatsapp_number(uuid, text, boolean) to authenticated;
grant execute on function citas.disconnect_whatsapp_number(uuid) to authenticated;

-- citas.whatsapp_config: de "cualquier miembro escribe" a "solo las funciones de arriba (owner/admin) escriben".
drop policy "staff gestiona whatsapp_config de su organización" on citas.whatsapp_config;
create policy "staff lee whatsapp_config de su organización" on citas.whatsapp_config for select
  using (exists (select 1 from core.membership m where m.organization_id = whatsapp_config.organization_id and m.user_id = auth.uid()));
revoke insert, update, delete on citas.whatsapp_config from authenticated;
