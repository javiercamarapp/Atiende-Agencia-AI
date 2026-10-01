-- PL-07 (P0) -- outbox de correo/WhatsApp de las 6 verticales: backoff exponencial real
-- en el reintento del correo y equidad por tenant en TODOS los `claim_*_outbox_batch`.
--
-- Problema (disponibilidad, no de confidencialidad):
--   1. `<vertical>.claim_email_outbox_batch` reclamaba cualquier fila 'pending'/'failed'
--      con `attempts < 5` ordenada por `created_at`, y `complete_email_outbox_job(...,
--      'failed')` no fijaba ninguna espera: un correo que falla (proveedor caido, buzon
--      rechazado) volvia a ser elegible en la MISMA corrida siguiente del cron o del drenado
--      inline, quemando sus 5 intentos en minutos en vez de repartirlos en el tiempo.
--   2. Los 9 `claim_*_outbox_batch` (6 de correo + 3 de WhatsApp: citas, hoteles,
--      restaurantes; rentas/despachos/licitaciones no tienen canal WhatsApp) tomaban el lote
--      completo por `created_at` GLOBAL: una organizacion con miles de filas viejas
--      acaparaba todos los lotes y las demas esperaban detras de ella (el claim es
--      cross-tenant a proposito: lo corre el cron de plataforma, `auth.uid()` nulo).
--
-- Arreglo (mismo patron de lease/backoff que `rentas.claim_ical_feeds`, migracion 203, y
-- que la outbox de WhatsApp que ya fija `next_attempt_at`):
--   * `core.outbox_backoff_seconds(attempts)`: funcion pura, backoff exponencial
--     60 s * 2^(attempts-1) con tope de 6 h (1 -> 60 s, 2 -> 120 s, 3 -> 240 s, 4 -> 480 s,
--     5 -> 960 s ...). `attempts` ya incluye el intento que acaba de fallar porque el claim
--     de correo lo incrementa al reclamar.
--   * despachos/licitaciones: columna `next_attempt_at` (ya existia en citas, hoteles,
--     restaurantes y rentas).
--   * `complete_email_outbox_job(..., 'failed')` fija `next_attempt_at = now() +
--     backoff(attempts)`; 'sent' y 'dead' no la tocan.
--   * Los claim de correo solo reclaman filas con `next_attempt_at <= now()`.
--   * Equidad por tenant: dentro del conjunto elegible, cada fila se numera por turno
--     dentro de su organizacion (`row_number() over (partition by organization_id order by
--     created_at, id)`) y el lote se llena ordenando por (turno, created_at, id): reparto
--     round-robin entre organizaciones. Ninguna organizacion toma una segunda fila del lote
--     mientras otra con filas elegibles no haya tomado la primera; con una sola organizacion
--     con pendientes el lote se llena igual que antes (sin perder rendimiento). Despues del
--     reparto, la fila se bloquea con `for update of ... skip locked` repitiendo el filtro de
--     elegibilidad (READ COMMITTED lo revalida si otra corrida la tomo en medio), asi dos
--     corridas concurrentes nunca reclaman la misma fila.
--
-- Compatibilidad con la base SIN migrar (mergear despliega el codigo antes que la
-- migracion): TODAS las firmas, nombres y tipos de retorno se conservan (`create or
-- replace` sobre la misma firma), asi que el TypeScript existente que las llama no cambia y
-- sigue funcionando contra un esquema sin esta migracion -- solo con el comportamiento de
-- hoy (sin backoff ni equidad) hasta que se aplique. No hay fallback 42883/42P01/42703
-- que agregar en TypeScript: ningun codigo TypeScript nuevo llama a una funcion o columna
-- que solo exista tras esta migracion.
--
-- Justificacion de seguridad de cada objeto:
--   * `core.outbox_backoff_seconds`: funcion pura inmutable, sin acceso a tablas,
--     `set search_path = ''`; `revoke ... from public, anon` y GRANT solo a `authenticated`
--     y `service_role` (las funciones `security definer` de abajo la llaman como el rol del
--     llamador). No es security definer: no eleva privilegios.
--   * Las 15 funciones reemplazadas conservan `security definer`, `set search_path` fijo a su
--     schema, el guard `auth.uid() is not null -> 42501` (solo sesion de sistema) y sus GRANT
--     existentes (`create or replace` no los toca; no se agrega ningun GRANT nuevo ni se
--     concede nada a `anon`). La equidad por tenant NO filtra por tenant del llamador: el
--     claim sigue siendo cross-tenant por diseno (lo corre el cron de plataforma) y la tabla
--     sigue sin policy para `authenticated`/`anon`.

create or replace function core.outbox_backoff_seconds(p_attempts integer)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  select least(21600, 60 * (2 ^ least(greatest(coalesce(p_attempts, 1), 1) - 1, 10))::integer)
$$;
revoke all on function core.outbox_backoff_seconds(integer) from public, anon;
grant execute on function core.outbox_backoff_seconds(integer) to authenticated, service_role;

alter table despachos.messaging_outbox add column if not exists next_attempt_at timestamptz not null default now();
alter table licitaciones.messaging_outbox add column if not exists next_attempt_at timestamptz not null default now();

-- citas -- correo: claim con backoff + equidad por tenant, y complete con backoff al fallar.
create or replace function citas.claim_email_outbox_batch(p_limit integer default 25)
returns setof citas.messaging_outbox
language plpgsql
security definer
set search_path = citas
as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_email_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    update citas.messaging_outbox
    set status = 'processing', attempts = attempts + 1
    where id in (
      select l.id from citas.messaging_outbox l
      join (
        select c.id from (
          select e.id, e.created_at,
                 row_number() over (partition by e.organization_id order by e.created_at, e.id) as turno
          from citas.messaging_outbox e
          where e.channel = 'email'
            and e.status in ('pending', 'failed')
            and e.attempts < 5
            and e.next_attempt_at <= now()
        ) c
        order by c.turno, c.created_at, c.id
        limit greatest(p_limit, 0)
      ) elegidos on elegidos.id = l.id
      where l.channel = 'email'
        and l.status in ('pending', 'failed')
        and l.attempts < 5
        and l.next_attempt_at <= now()
      for update of l skip locked
    )
    returning *;
end;
$$;

create or replace function citas.complete_email_outbox_job(
  p_id uuid,
  p_status text,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = citas
as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_email_outbox_job es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update citas.messaging_outbox
  set status = p_status,
      last_error = left(p_error, 500),
      next_attempt_at = case
        when p_status = 'failed' then now() + make_interval(secs => core.outbox_backoff_seconds(attempts))
        else next_attempt_at
      end
  where id = p_id and channel = 'email';
end;
$$;

-- despachos -- correo: claim con backoff + equidad por tenant, y complete con backoff al fallar.
create or replace function despachos.claim_email_outbox_batch(p_limit integer default 25)
returns setof despachos.messaging_outbox
language plpgsql
security definer
set search_path = despachos
as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_email_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    update despachos.messaging_outbox
    set status = 'processing', attempts = attempts + 1
    where id in (
      select l.id from despachos.messaging_outbox l
      join (
        select c.id from (
          select e.id, e.created_at,
                 row_number() over (partition by e.organization_id order by e.created_at, e.id) as turno
          from despachos.messaging_outbox e
          where e.channel = 'email'
            and e.status in ('pending', 'failed')
            and e.attempts < 5
            and e.next_attempt_at <= now()
        ) c
        order by c.turno, c.created_at, c.id
        limit greatest(p_limit, 0)
      ) elegidos on elegidos.id = l.id
      where l.channel = 'email'
        and l.status in ('pending', 'failed')
        and l.attempts < 5
        and l.next_attempt_at <= now()
      for update of l skip locked
    )
    returning *;
end;
$$;

create or replace function despachos.complete_email_outbox_job(
  p_id uuid,
  p_status text,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = despachos
as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_email_outbox_job es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update despachos.messaging_outbox
  set status = p_status,
      last_error = left(p_error, 500),
      next_attempt_at = case
        when p_status = 'failed' then now() + make_interval(secs => core.outbox_backoff_seconds(attempts))
        else next_attempt_at
      end
  where id = p_id and channel = 'email';
end;
$$;

-- hoteles -- correo: claim con backoff + equidad por tenant, y complete con backoff al fallar.
create or replace function hoteles.claim_email_outbox_batch(p_limit integer default 25)
returns setof hoteles.messaging_outbox
language plpgsql
security definer
set search_path = hoteles
as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_email_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    update hoteles.messaging_outbox
    set status = 'processing', attempts = attempts + 1
    where id in (
      select l.id from hoteles.messaging_outbox l
      join (
        select c.id from (
          select e.id, e.created_at,
                 row_number() over (partition by e.organization_id order by e.created_at, e.id) as turno
          from hoteles.messaging_outbox e
          where e.channel = 'email'
            and e.status in ('pending', 'failed')
            and e.attempts < 5
            and e.next_attempt_at <= now()
        ) c
        order by c.turno, c.created_at, c.id
        limit greatest(p_limit, 0)
      ) elegidos on elegidos.id = l.id
      where l.channel = 'email'
        and l.status in ('pending', 'failed')
        and l.attempts < 5
        and l.next_attempt_at <= now()
      for update of l skip locked
    )
    returning *;
end;
$$;

create or replace function hoteles.complete_email_outbox_job(
  p_id uuid,
  p_status text,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = hoteles
as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_email_outbox_job es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update hoteles.messaging_outbox
  set status = p_status,
      last_error_class = left(p_error, 120),
      next_attempt_at = case
        when p_status = 'failed' then now() + make_interval(secs => core.outbox_backoff_seconds(attempts))
        else next_attempt_at
      end
  where id = p_id and channel = 'email';
end;
$$;

-- licitaciones -- correo: claim con backoff + equidad por tenant, y complete con backoff al fallar.
create or replace function licitaciones.claim_email_outbox_batch(p_limit integer default 25)
returns setof licitaciones.messaging_outbox
language plpgsql
security definer
set search_path = licitaciones
as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_email_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    update licitaciones.messaging_outbox
    set status = 'processing', attempts = attempts + 1
    where id in (
      select l.id from licitaciones.messaging_outbox l
      join (
        select c.id from (
          select e.id, e.created_at,
                 row_number() over (partition by e.organization_id order by e.created_at, e.id) as turno
          from licitaciones.messaging_outbox e
          where e.channel = 'email'
            and e.status in ('pending', 'failed')
            and e.attempts < 5
            and e.next_attempt_at <= now()
        ) c
        order by c.turno, c.created_at, c.id
        limit greatest(p_limit, 0)
      ) elegidos on elegidos.id = l.id
      where l.channel = 'email'
        and l.status in ('pending', 'failed')
        and l.attempts < 5
        and l.next_attempt_at <= now()
      for update of l skip locked
    )
    returning *;
end;
$$;

create or replace function licitaciones.complete_email_outbox_job(
  p_id uuid,
  p_status text,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = licitaciones
as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_email_outbox_job es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update licitaciones.messaging_outbox
  set status = p_status,
      last_error = left(p_error, 500),
      next_attempt_at = case
        when p_status = 'failed' then now() + make_interval(secs => core.outbox_backoff_seconds(attempts))
        else next_attempt_at
      end
  where id = p_id and channel = 'email';
end;
$$;

-- rentas -- correo: claim con backoff + equidad por tenant, y complete con backoff al fallar.
create or replace function rentas.claim_email_outbox_batch(p_limit integer default 25)
returns setof rentas.messaging_outbox
language plpgsql
security definer
set search_path = rentas
as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_email_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    update rentas.messaging_outbox
    set status = 'processing', attempts = attempts + 1
    where id in (
      select l.id from rentas.messaging_outbox l
      join (
        select c.id from (
          select e.id, e.created_at,
                 row_number() over (partition by e.organization_id order by e.created_at, e.id) as turno
          from rentas.messaging_outbox e
          where e.channel = 'email'
            and e.status in ('pending', 'failed')
            and e.attempts < 5
            and e.next_attempt_at <= now()
        ) c
        order by c.turno, c.created_at, c.id
        limit greatest(p_limit, 0)
      ) elegidos on elegidos.id = l.id
      where l.channel = 'email'
        and l.status in ('pending', 'failed')
        and l.attempts < 5
        and l.next_attempt_at <= now()
      for update of l skip locked
    )
    returning *;
end;
$$;

create or replace function rentas.complete_email_outbox_job(
  p_id uuid,
  p_status text,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = rentas
as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_email_outbox_job es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update rentas.messaging_outbox
  set status = p_status,
      last_error = left(p_error, 500),
      next_attempt_at = case
        when p_status = 'failed' then now() + make_interval(secs => core.outbox_backoff_seconds(attempts))
        else next_attempt_at
      end
  where id = p_id and channel = 'email';
end;
$$;

-- restaurantes -- correo: claim con backoff + equidad por tenant, y complete con backoff al fallar.
create or replace function restaurantes.claim_email_outbox_batch(p_limit integer default 25)
returns setof restaurantes.messaging_outbox
language plpgsql
security definer
set search_path = restaurantes
as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_email_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    update restaurantes.messaging_outbox
    set status = 'processing', attempts = attempts + 1
    where id in (
      select l.id from restaurantes.messaging_outbox l
      join (
        select c.id from (
          select e.id, e.created_at,
                 row_number() over (partition by e.organization_id order by e.created_at, e.id) as turno
          from restaurantes.messaging_outbox e
          where e.channel = 'email'
            and e.status in ('pending', 'failed')
            and e.attempts < 5
            and e.next_attempt_at <= now()
        ) c
        order by c.turno, c.created_at, c.id
        limit greatest(p_limit, 0)
      ) elegidos on elegidos.id = l.id
      where l.channel = 'email'
        and l.status in ('pending', 'failed')
        and l.attempts < 5
        and l.next_attempt_at <= now()
      for update of l skip locked
    )
    returning *;
end;
$$;

create or replace function restaurantes.complete_email_outbox_job(
  p_id uuid,
  p_status text,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = restaurantes
as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_email_outbox_job es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update restaurantes.messaging_outbox
  set status = p_status,
      last_error_class = left(p_error, 120),
      next_attempt_at = case
        when p_status = 'failed' then now() + make_interval(secs => core.outbox_backoff_seconds(attempts))
        else next_attempt_at
      end
  where id = p_id and channel = 'email';
end;
$$;

-- citas -- WhatsApp: el backoff ya lo fija `complete_messaging_outbox_retry` (calculado por
-- el dispatcher); aqui solo se agrega la equidad por tenant al claim.
create or replace function citas.claim_messaging_outbox_batch(
  p_limit integer, p_lease_seconds integer default 120
) returns setof citas.messaging_outbox
language plpgsql security definer set search_path = citas as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_messaging_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'invalid claim limit'; end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'invalid lease seconds'; end if;

  return query
    update citas.messaging_outbox
    set status = 'processing', claimed_at = now()
    where id in (
      select l.id from citas.messaging_outbox l
      join (
        select c.id from (
          select e.id, e.created_at,
                 row_number() over (partition by e.organization_id order by e.created_at, e.id) as turno
          from citas.messaging_outbox e
          where e.channel = 'whatsapp'
            and (
              (e.status = 'pending' and e.next_attempt_at <= now())
              or (e.status = 'processing' and e.claimed_at < now() - make_interval(secs => p_lease_seconds))
            )
        ) c
        order by c.turno, c.created_at, c.id
        limit p_limit
      ) elegidos on elegidos.id = l.id
      where l.channel = 'whatsapp'
        and (
          (l.status = 'pending' and l.next_attempt_at <= now())
          or (l.status = 'processing' and l.claimed_at < now() - make_interval(secs => p_lease_seconds))
        )
      for update of l skip locked
    )
    returning *;
end;
$$;

-- hoteles -- WhatsApp: el backoff ya lo fija `complete_messaging_outbox_retry` (calculado por
-- el dispatcher); aqui solo se agrega la equidad por tenant al claim.
create or replace function hoteles.claim_messaging_outbox_batch(
  p_limit integer, p_lease_seconds integer default 120
) returns setof hoteles.messaging_outbox
language plpgsql security definer set search_path = hoteles as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_messaging_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'invalid claim limit'; end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'invalid lease seconds'; end if;

  return query
    update hoteles.messaging_outbox
    set status = 'processing', claimed_at = now()
    where id in (
      select l.id from hoteles.messaging_outbox l
      join (
        select c.id from (
          select e.id, e.created_at,
                 row_number() over (partition by e.organization_id order by e.created_at, e.id) as turno
          from hoteles.messaging_outbox e
          where e.channel = 'whatsapp'
            and (
              (e.status = 'pending' and e.next_attempt_at <= now())
              or (e.status = 'processing' and e.claimed_at < now() - make_interval(secs => p_lease_seconds))
            )
        ) c
        order by c.turno, c.created_at, c.id
        limit p_limit
      ) elegidos on elegidos.id = l.id
      where l.channel = 'whatsapp'
        and (
          (l.status = 'pending' and l.next_attempt_at <= now())
          or (l.status = 'processing' and l.claimed_at < now() - make_interval(secs => p_lease_seconds))
        )
      for update of l skip locked
    )
    returning *;
end;
$$;

-- restaurantes -- WhatsApp: el backoff ya lo fija `complete_messaging_outbox_retry` (calculado por
-- el dispatcher); aqui solo se agrega la equidad por tenant al claim.
create or replace function restaurantes.claim_messaging_outbox_batch(
  p_limit integer, p_lease_seconds integer default 120
) returns setof restaurantes.messaging_outbox
language plpgsql security definer set search_path = restaurantes as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_messaging_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'invalid claim limit'; end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'invalid lease seconds'; end if;

  return query
    update restaurantes.messaging_outbox
    set status = 'processing', claimed_at = now()
    where id in (
      select l.id from restaurantes.messaging_outbox l
      join (
        select c.id from (
          select e.id, e.created_at,
                 row_number() over (partition by e.organization_id order by e.created_at, e.id) as turno
          from restaurantes.messaging_outbox e
          where e.channel = 'whatsapp'
            and (
              (e.status = 'pending' and e.next_attempt_at <= now())
              or (e.status = 'processing' and e.claimed_at < now() - make_interval(secs => p_lease_seconds))
            )
        ) c
        order by c.turno, c.created_at, c.id
        limit p_limit
      ) elegidos on elegidos.id = l.id
      where l.channel = 'whatsapp'
        and (
          (l.status = 'pending' and l.next_attempt_at <= now())
          or (l.status = 'processing' and l.claimed_at < now() - make_interval(secs => p_lease_seconds))
        )
      for update of l skip locked
    )
    returning *;
end;
$$;
