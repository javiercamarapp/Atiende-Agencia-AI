-- Turno de VOZ del cerebro v2 (POST /v1/restaurantes/voz/turno): estado por LLAMADA para el worker de voz (Deepgram STT -> API -> TTS).
-- Prefijo de supabase/migrations asignado: 20240101000822 (interno 191).
--
-- Que agrega (1 tabla, 2 funciones):
--   1. restaurantes.voz_turno_hilo  -- una fila por (organizacion, call_id): historial de la llamada (lo que dijo el cliente y lo que contesto el
--      agente), ultimo seq procesado y su respuesta (idempotencia por (call_id, seq)), marca «en proceso» con caducidad (un reintento concurrente del
--      mismo seq recibe 409 sin gastar modelo dos veces), version para compare-and-swap y fallos seguidos del proveedor.
--   2. restaurantes.voz_turno_resolver_secreto(hash)  -- SOLO SISTEMA: organizacion y sucursal duenas de un secreto de sucursal de voz
--      (restaurantes.voice_branch_secret, migracion 026). La ruta de voz no trae organizacion en la URL: el secreto la fija.
--   3. restaurantes.voz_turno_hilo_purgar(dias)  -- SOLO SISTEMA: retencion (borra los hilos sin actividad en N dias). No se programa aqui
--      (sin cron nuevo); queda listo para el barrido de privacidad.
--
-- Compatibilidad con la base SIN migrar: el TypeScript llama a estos objetos dentro de SAVEPOINT (runWithSavepointFallback) y trata SQLSTATE
-- 42P01/42883/42703 como «voz por turno no disponible»: responde 503 con fin=true y la frase «por ahora no podemos atenderle por telefono»
-- (nunca un 500). Solo AGREGA objetos: aplicarla no cambia nada de lo que ya corre.
--
-- Justificacion de seguridad (una por GRANT / policy / funcion):
--   * La sesion de sistema de la API corre con el rol `authenticated` y auth.uid() NULL (mismo patron que la 026 y la 099). El hilo contiene
--     transcripcion de la llamada (dato personal): NINGUN staff lo lee por PostgREST todavia (no hay pantalla que lo use) y anon no tiene nada.
--   * RLS habilitada; `revoke all` de public/anon/authenticated antes de conceder. UNA policy por operacion, todas `auth.uid() is null`
--     (solo la sesion de sistema; un staff autenticado tiene auth.uid() no nulo y no ve ni escribe nada). Ningun `using (true)`.
--   * GRANT a `authenticated` de select/insert y de update SOLO de las columnas que el turno escribe (nunca organization_id, call_id, telefono ni
--     created_at): la llamada no cambia de dueno ni de telefono. Sin delete: la retencion va por la funcion definer de purga.
--   * service_role conserva todos los privilegios (operacion de plataforma), como en el resto del esquema.
--   * Las dos funciones son `security definer` con search_path fijo, `revoke` de public/anon y exigen auth.uid() IS NULL (solo sistema).
--     resolver_secreto compara hashes sha256 (nunca el secreto) y devuelve UNA sucursal: el hash es unico entre sucursales (indice de la 026).

-- ---------------------------------------------------------------------------
-- 1) restaurantes.voz_turno_hilo
-- ---------------------------------------------------------------------------
create table restaurantes.voz_turno_hilo (
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- Mismo formato que valida el worker (normalizarCallId): [A-Za-z0-9_.:-]{6,128}.
  call_id text not null check (call_id ~ '^[A-Za-z0-9_.:-]{6,128}$'),
  -- Sucursal fijada por el secreto de voz; si la sucursal se borra el hilo queda sin sucursal (no se pierde el historial de la llamada).
  property_id uuid references core.property(id) on delete set null,
  -- Telefono canonico de 10 digitos (caller ID o el que dicto el cliente). Un call_id es de UN telefono.
  telefono text not null check (telefono ~ '^[0-9]{10}$'),
  -- Historial {role, content} de la llamada. Tope de tamano: una llamada larga no crece sin limite.
  mensajes jsonb not null default '[]'::jsonb check (jsonb_typeof(mensajes) = 'array' and octet_length(mensajes::text) <= 262144),
  pedido_id uuid,
  turnos integer not null default 0 check (turnos between 0 and 100000),
  -- Idempotencia por (call_id, seq): el mismo seq devuelve la respuesta guardada sin volver a llamar al modelo.
  seq_ultimo integer not null default 0 check (seq_ultimo between 0 and 100000),
  respuesta_ultima jsonb check (respuesta_ultima is null or (jsonb_typeof(respuesta_ultima) = 'object' and octet_length(respuesta_ultima::text) <= 16384)),
  -- Compare-and-swap: toda escritura exige la version leida.
  version integer not null default 0 check (version >= 0),
  fallos_seguidos integer not null default 0 check (fallos_seguidos between 0 and 1000),
  -- Turno con modelo en curso (seq y desde cuando). Una marca vieja (> caducidad del codigo) es de un turno muerto y se toma.
  en_proceso_seq integer check (en_proceso_seq is null or en_proceso_seq between 0 and 100000),
  en_proceso_desde timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, call_id),
  check ((en_proceso_seq is null) = (en_proceso_desde is null))
);
-- Purga por antiguedad y consulta/borrado por telefono (derechos ARCO).
create index restaurantes_voz_turno_hilo_updated_idx on restaurantes.voz_turno_hilo (updated_at);
create index restaurantes_voz_turno_hilo_telefono_idx on restaurantes.voz_turno_hilo (organization_id, telefono);

comment on table restaurantes.voz_turno_hilo is
  'Hilo del agente por llamada de voz (turno de voz del cerebro v2). Contiene transcripcion de la llamada: dato personal; solo la sesion de sistema lo toca.';

alter table restaurantes.voz_turno_hilo enable row level security;
revoke all on restaurantes.voz_turno_hilo from public, anon, authenticated;

-- Solo la sesion de sistema (auth.uid() NULL) lee el hilo: un staff autenticado no ve transcripciones por PostgREST.
create policy "sistema lee el hilo de voz" on restaurantes.voz_turno_hilo for select
  using (auth.uid() is null);
-- Solo la sesion de sistema crea el hilo (la ruta de voz, autenticada por el secreto de sucursal).
create policy "sistema crea el hilo de voz" on restaurantes.voz_turno_hilo for insert
  with check (auth.uid() is null);
-- Solo la sesion de sistema avanza el hilo (compare-and-swap por version en el codigo).
create policy "sistema actualiza el hilo de voz" on restaurantes.voz_turno_hilo for update
  using (auth.uid() is null)
  with check (auth.uid() is null);

-- select/insert para la sesion de sistema (rol authenticated + auth.uid() NULL; las policies de arriba excluyen a todo staff).
grant select, insert on restaurantes.voz_turno_hilo to authenticated;
-- update solo de las columnas del turno: organization_id, call_id, telefono y created_at no cambian nunca.
grant update (property_id, mensajes, pedido_id, turnos, seq_ultimo, respuesta_ultima, version, fallos_seguidos, en_proceso_seq, en_proceso_desde, updated_at)
  on restaurantes.voz_turno_hilo to authenticated;
-- service_role: operacion de plataforma (respaldo, soporte), como en el resto del esquema.
grant select, insert, update, delete on restaurantes.voz_turno_hilo to service_role;

-- ---------------------------------------------------------------------------
-- 2) voz_turno_resolver_secreto -- SOLO SISTEMA. Organizacion y sucursal duenas del secreto de voz (vigente, o el anterior dentro de su ventana
--    de gracia). Justificacion: el worker de voz no conoce la organizacion; el secreto POR SUCURSAL (hash unico, 026) la determina. Devuelve
--    a lo mas una fila; un hash con formato invalido no devuelve nada. Nunca devuelve el hash.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.voz_turno_resolver_secreto(p_secret_hash text)
returns table (organization_id uuid, property_id uuid)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'restaurantes.voz_turno_resolver_secreto: solo la sesion de sistema (auth.uid() es NULL).'
      using errcode = '42501';
  end if;
  if p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  return query
    select s.organization_id, s.property_id
    from restaurantes.voice_branch_secret s
    where s.secret_hash = p_secret_hash
       or (s.previous_hash = p_secret_hash and s.previous_valid_until > now())
    order by (s.secret_hash = p_secret_hash) desc
    limit 1;
end;
$$;
revoke all on function restaurantes.voz_turno_resolver_secreto(text) from public, anon;
-- authenticated: la sesion de sistema de la API (la funcion rechaza a todo staff con auth.uid() no nulo).
grant execute on function restaurantes.voz_turno_resolver_secreto(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) voz_turno_hilo_purgar -- SOLO SISTEMA. Retencion: borra los hilos sin actividad en p_dias (>= 1). Devuelve cuantos borro.
--    Justificacion: authenticated no tiene DELETE sobre la tabla; la purga es la unica via de borrado y solo la corre el sistema.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.voz_turno_hilo_purgar(p_dias integer)
returns integer
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_borrados integer;
begin
  if auth.uid() is not null then
    raise exception 'restaurantes.voz_turno_hilo_purgar: solo la sesion de sistema (auth.uid() es NULL).'
      using errcode = '42501';
  end if;
  if p_dias is null or p_dias < 1 then
    raise exception 'restaurantes.voz_turno_hilo_purgar: p_dias debe ser >= 1' using errcode = '22023';
  end if;
  delete from restaurantes.voz_turno_hilo where updated_at < now() - make_interval(days => p_dias);
  get diagnostics v_borrados = row_count;
  return v_borrados;
end;
$$;
revoke all on function restaurantes.voz_turno_hilo_purgar(integer) from public, anon;
-- authenticated: la sesion de sistema (la funcion rechaza a todo staff con auth.uid() no nulo).
grant execute on function restaurantes.voz_turno_hilo_purgar(integer) to authenticated, service_role;
