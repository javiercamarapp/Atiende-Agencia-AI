-- Fixtures + assertions contra Postgres REAL (GRANT / auth.uid() / security definer reales,
-- que el repositorio en memoria de cada domain-* nunca aplica) de
-- packages/db/migrations/0031_outbox_backoff_y_equidad_por_tenant.sql (PL-07).
--
-- Qué demuestra (positivo, negativo, cross-tenant, anon), en las 6 verticales:
--   1. core.outbox_backoff_seconds: tabla del backoff exponencial 60 s * 2^(n-1), tope 6 h.
--   2. correo, equidad por tenant: una organizacion con 12 filas viejas ya NO acapara el lote;
--      las organizaciones con pocas filas reciben su turno (con el claim anterior la
--      organizacion con mas antiguedad se llevaba el lote entero).
--   3. correo, sin penalizar el caso normal: con una sola organizacion el lote se llena igual.
--   4. correo, backoff: tras 'failed' la fila queda fuera de la cola hasta
--      next_attempt_at = now() + backoff(attempts); vencida la espera vuelve a ser elegible
--      y el siguiente fallo duplica la espera; 'sent' y 'dead' no tocan next_attempt_at.
--   5. correo, compatibilidad: una fila 'failed' previa a la migracion (next_attempt_at ya
--      vencido) sigue siendo reclamable.
--   6. WhatsApp (citas, hoteles, restaurantes): misma equidad por tenant en el claim.
--   7. WhatsApp: el lease y el next_attempt_at se siguen respetando (no hay regresion).
--   8. negativo/anon: una sesion de staff (auth.uid() real) y el rol anon NO pueden reclamar
--      ni completar nada, en ninguna vertical (42501).
--   9. cross-tenant: la tabla del outbox sigue sin ser legible por authenticated.
--
-- Run vía scripts/verify-real-postgres-ci/run-gate.mjs (auto-descubierto en CI) o con
-- ./run.sh. Cada escenario corre en su propio `begin; ... rollback;` y se autoverifica con
-- bloques DO que lanzan excepcion si algo no cumple (un escenario sin error = pasa).
\set ON_ERROR_STOP off
\pset pager off

\echo '=== 1. core.outbox_backoff_seconds: 60 s * 2^(n-1), tope 6 h, entradas nulas/bajas -> 60 s ==='
begin;
do $$
begin
  if core.outbox_backoff_seconds(1) <> 60 or core.outbox_backoff_seconds(2) <> 120
     or core.outbox_backoff_seconds(3) <> 240 or core.outbox_backoff_seconds(4) <> 480
     or core.outbox_backoff_seconds(5) <> 960 then
    raise exception 'tabla de backoff inesperada';
  end if;
  if core.outbox_backoff_seconds(10) <> 21600 or core.outbox_backoff_seconds(1000) <> 21600 then
    raise exception 'el backoff no respeta el tope de 6 h';
  end if;
  if core.outbox_backoff_seconds(null) <> 60 or core.outbox_backoff_seconds(0) <> 60 or core.outbox_backoff_seconds(-3) <> 60 then
    raise exception 'entradas nulas/bajas deben dar el minimo de 60 s';
  end if;
end $$;
rollback;

\echo '=== 2. correo, equidad por tenant en las 6 verticales: A=12 viejas, B=2, C=1; lote de 6 -> A 3, B 2, C 1 ==='
begin;
create function pg_temp.seed(v text, p_channel text, n_a integer, n_b integer, n_c integer) returns void
language plpgsql as $f$
declare
  org_ids uuid[] := array[]::uuid[];
  o uuid;
  i integer;
  k integer;
  tag text;
  counts integer[] := array[n_a, n_b, n_c];
  edad interval[] := array[interval '10 days', interval '5 days', interval '1 day'];
  prop uuid;
begin
  foreach tag in array array['a', 'b', 'c'] loop
    insert into core.organization (vertical, name, slug) values (v, 'eq ' || v || ' ' || tag, 'eq-' || v || '-' || tag || '-' || p_channel)
    returning id into o;
    org_ids := org_ids || o;
  end loop;
  for k in 1..3 loop
    o := org_ids[k];
    if v in ('hoteles', 'rentas') then
      insert into core.property (organization_id, vertical, name) values (o, v, 'prop') returning id into prop;
    end if;
    for i in 1..counts[k] loop
      if v in ('hoteles', 'rentas') then
        execute format('insert into %I.messaging_outbox (organization_id, property_id, channel, event_type, dedupe_key, payload, created_at) values ($1, $2, $3, ''t'', $4, ''{}''::jsonb, $5)', v)
          using o, prop, p_channel, 'k' || i, now() - edad[k] + i * interval '1 minute';
      else
        execute format('insert into %I.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, created_at) values ($1, $2, ''t'', $3, ''{}''::jsonb, $4)', v)
          using o, p_channel, 'k' || i, now() - edad[k] + i * interval '1 minute';
      end if;
    end loop;
  end loop;
end $f$;
select pg_temp.seed(v, 'email', 12, 2, 1) from unnest(array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes']) as v;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare
  v text;
  na integer; nb integer; nc integer;
begin
  foreach v in array array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes'] loop
    execute format($q$
      select count(*) filter (where o.slug like 'eq-%%-a-%%'), count(*) filter (where o.slug like 'eq-%%-b-%%'), count(*) filter (where o.slug like 'eq-%%-c-%%')
      from %I.claim_email_outbox_batch(6) r join core.organization o on o.id = r.organization_id
    $q$, v) into na, nb, nc;
    if na <> 3 or nb <> 2 or nc <> 1 then
      raise exception '% correo: reparto inesperado A=% B=% C=% (se esperaba 3/2/1)', v, na, nb, nc;
    end if;
    -- segundo lote: ya solo queda A (9 pendientes) y llena el lote completo.
    execute format($q$ select count(*) from %I.claim_email_outbox_batch(6) $q$, v) into na;
    if na <> 6 then raise exception '% correo: el segundo lote deberia llenarse con la unica organizacion restante (%)', v, na; end if;
  end loop;
end $$;
rollback;

\echo '=== 3. correo, una sola organizacion con pendientes: el lote se llena igual (sin perder rendimiento) ==='
begin;
create function pg_temp.seed_one(v text, n integer) returns void
language plpgsql as $f$
declare o uuid; prop uuid; i integer;
begin
  insert into core.organization (vertical, name, slug) values (v, 'uno ' || v, 'uno-' || v) returning id into o;
  if v in ('hoteles', 'rentas') then
    insert into core.property (organization_id, vertical, name) values (o, v, 'prop') returning id into prop;
  end if;
  for i in 1..n loop
    if v in ('hoteles', 'rentas') then
      execute format('insert into %I.messaging_outbox (organization_id, property_id, channel, event_type, dedupe_key, payload) values ($1, $2, ''email'', ''t'', $3, ''{}''::jsonb)', v) using o, prop, 'k' || i;
    else
      execute format('insert into %I.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload) values ($1, ''email'', ''t'', $2, ''{}''::jsonb)', v) using o, 'k' || i;
    end if;
  end loop;
end $f$;
select pg_temp.seed_one(v, 10) from unnest(array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes']) as v;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare v text; n integer;
begin
  foreach v in array array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes'] loop
    execute format('select count(*) from %I.claim_email_outbox_batch(6)', v) into n;
    if n <> 6 then raise exception '% correo: un solo tenant deberia llenar el lote de 6, obtuvo %', v, n; end if;
    execute format('select count(*) from %I.claim_email_outbox_batch(0)', v) into n;
    if n <> 0 then raise exception '% correo: p_limit 0 no debe reclamar nada', v; end if;
  end loop;
end $$;
rollback;

\echo '=== 4. correo, backoff: fallo -> fuera de cola 60 s -> reclamable -> segundo fallo -> 120 s; sent/dead no mueven next_attempt_at ==='
begin;
create function pg_temp.seed_one(v text, n integer) returns void
language plpgsql as $f$
declare o uuid; prop uuid; i integer;
begin
  insert into core.organization (vertical, name, slug) values (v, 'uno ' || v, 'uno-' || v) returning id into o;
  if v in ('hoteles', 'rentas') then
    insert into core.property (organization_id, vertical, name) values (o, v, 'prop') returning id into prop;
  end if;
  for i in 1..n loop
    if v in ('hoteles', 'rentas') then
      execute format('insert into %I.messaging_outbox (organization_id, property_id, channel, event_type, dedupe_key, payload) values ($1, $2, ''email'', ''t'', $3, ''{}''::jsonb)', v) using o, prop, 'k' || i;
    else
      execute format('insert into %I.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload) values ($1, ''email'', ''t'', $2, ''{}''::jsonb)', v) using o, 'k' || i;
    end if;
  end loop;
end $f$;
select pg_temp.seed_one(v, 1) from unnest(array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes']) as v;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare v text; n integer; j uuid;
begin
  foreach v in array array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes'] loop
    execute format('select id from %I.claim_email_outbox_batch(5)', v) into j;
    if j is null then raise exception '% correo: el primer claim debio reclamar la fila', v; end if;
    execute format('select %I.complete_email_outbox_job($1, ''failed'', ''boom'')', v) using j;
    execute format('select count(*) from %I.claim_email_outbox_batch(5)', v) into n;
    if n <> 0 then raise exception '% correo: la fila fallida se reclamo sin respetar el backoff', v; end if;
  end loop;
end $$;
reset role;
do $$
declare v text; n integer; esperado integer;
begin
  foreach v in array array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes'] loop
    execute format('select count(*) from %I.messaging_outbox where status = ''failed'' and attempts = 1 and next_attempt_at = now() + interval ''60 seconds''', v) into n;
    if n <> 1 then raise exception '% correo: next_attempt_at no quedo en now()+60 s tras el primer fallo', v; end if;
    -- simula que ya paso la espera
    execute format('update %I.messaging_outbox set next_attempt_at = now() - interval ''1 second''', v);
  end loop;
end $$;
set local role authenticated;
do $$
declare v text; n integer; j uuid;
begin
  foreach v in array array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes'] loop
    execute format('select id from %I.claim_email_outbox_batch(5)', v) into j;
    if j is null then raise exception '% correo: vencida la espera la fila debio ser reclamable', v; end if;
    execute format('select %I.complete_email_outbox_job($1, ''failed'', ''boom'')', v) using j;
  end loop;
end $$;
reset role;
do $$
declare v text; n integer; j uuid;
begin
  foreach v in array array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes'] loop
    execute format('select count(*) from %I.messaging_outbox where attempts = 2 and next_attempt_at = now() + interval ''120 seconds''', v) into n;
    if n <> 1 then raise exception '% correo: el segundo fallo debio duplicar la espera a 120 s', v; end if;
    -- 'sent' y 'dead' no mueven next_attempt_at
    execute format('update %I.messaging_outbox set next_attempt_at = now() - interval ''1 second'', status = ''processing''', v);
    execute format('select id from %I.messaging_outbox limit 1', v) into j;
    perform set_config('app.job_' || v, j::text, true);
  end loop;
end $$;
set local role authenticated;
do $$
declare v text; n integer; j uuid;
begin
  foreach v in array array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes'] loop
    j := current_setting('app.job_' || v)::uuid;
    execute format('select %I.complete_email_outbox_job($1, ''sent'', null)', v) using j;
  end loop;
end $$;
reset role;
do $$
declare v text; n integer;
begin
  foreach v in array array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes'] loop
    execute format('select count(*) from %I.messaging_outbox where status = ''sent'' and next_attempt_at < now()', v) into n;
    if n <> 1 then raise exception '% correo: completar como sent no debe mover next_attempt_at', v; end if;
  end loop;
end $$;
rollback;

\echo '=== 5. correo, compatibilidad: una fila failed previa a la migracion (next_attempt_at vencido) sigue siendo reclamable; attempts >= 5 no ==='
begin;
create function pg_temp.seed_one(v text, n integer) returns void
language plpgsql as $f$
declare o uuid; prop uuid; i integer;
begin
  insert into core.organization (vertical, name, slug) values (v, 'uno ' || v, 'uno-' || v) returning id into o;
  if v in ('hoteles', 'rentas') then
    insert into core.property (organization_id, vertical, name) values (o, v, 'prop') returning id into prop;
  end if;
  for i in 1..n loop
    if v in ('hoteles', 'rentas') then
      execute format('insert into %I.messaging_outbox (organization_id, property_id, channel, event_type, dedupe_key, payload, status, attempts, next_attempt_at) values ($1, $2, ''email'', ''t'', $3, ''{}''::jsonb, ''failed'', $4, now() - interval ''1 hour'')', v) using o, prop, 'k' || i, case when i = 1 then 3 else 5 end;
    else
      execute format('insert into %I.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, status, attempts, next_attempt_at) values ($1, ''email'', ''t'', $2, ''{}''::jsonb, ''failed'', $3, now() - interval ''1 hour'')', v) using o, 'k' || i, case when i = 1 then 3 else 5 end;
    end if;
  end loop;
end $f$;
select pg_temp.seed_one(v, 2) from unnest(array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes']) as v;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare v text; n integer;
begin
  foreach v in array array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes'] loop
    execute format('select count(*) from %I.claim_email_outbox_batch(10)', v) into n;
    if n <> 1 then raise exception '% correo: debio reclamar solo la fila failed con attempts 3 (obtuvo %)', v, n; end if;
  end loop;
end $$;
rollback;

\echo '=== 6. WhatsApp (citas, hoteles, restaurantes): equidad por tenant, A=12 viejas, B=2, C=1; lote de 6 -> 3/2/1 ==='
begin;
create function pg_temp.seed(v text, p_channel text, n_a integer, n_b integer, n_c integer) returns void
language plpgsql as $f$
declare
  org_ids uuid[] := array[]::uuid[];
  o uuid;
  i integer;
  k integer;
  tag text;
  counts integer[] := array[n_a, n_b, n_c];
  edad interval[] := array[interval '10 days', interval '5 days', interval '1 day'];
  prop uuid;
begin
  foreach tag in array array['a', 'b', 'c'] loop
    insert into core.organization (vertical, name, slug) values (v, 'eq ' || v || ' ' || tag, 'eq-' || v || '-' || tag || '-' || p_channel)
    returning id into o;
    org_ids := org_ids || o;
  end loop;
  for k in 1..3 loop
    o := org_ids[k];
    if v in ('hoteles', 'rentas') then
      insert into core.property (organization_id, vertical, name) values (o, v, 'prop') returning id into prop;
    end if;
    for i in 1..counts[k] loop
      if v in ('hoteles', 'rentas') then
        execute format('insert into %I.messaging_outbox (organization_id, property_id, channel, event_type, dedupe_key, payload, created_at) values ($1, $2, $3, ''t'', $4, ''{}''::jsonb, $5)', v)
          using o, prop, p_channel, 'k' || i, now() - edad[k] + i * interval '1 minute';
      else
        execute format('insert into %I.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, created_at) values ($1, $2, ''t'', $3, ''{}''::jsonb, $4)', v)
          using o, p_channel, 'k' || i, now() - edad[k] + i * interval '1 minute';
      end if;
    end loop;
  end loop;
end $f$;
select pg_temp.seed(v, 'whatsapp', 12, 2, 1) from unnest(array['citas', 'hoteles', 'restaurantes']) as v;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare v text; na integer; nb integer; nc integer;
begin
  foreach v in array array['citas', 'hoteles', 'restaurantes'] loop
    execute format($q$
      select count(*) filter (where o.slug like 'eq-%%-a-%%'), count(*) filter (where o.slug like 'eq-%%-b-%%'), count(*) filter (where o.slug like 'eq-%%-c-%%')
      from %I.claim_messaging_outbox_batch(6, 120) r join core.organization o on o.id = r.organization_id
    $q$, v) into na, nb, nc;
    if na <> 3 or nb <> 2 or nc <> 1 then
      raise exception '% whatsapp: reparto inesperado A=% B=% C=% (se esperaba 3/2/1)', v, na, nb, nc;
    end if;
  end loop;
end $$;
rollback;

\echo '=== 7. WhatsApp: next_attempt_at futuro no se reclama, lease vigente no se reclama, lease vencido si ==='
begin;
create function pg_temp.seed_ws(v text) returns void
language plpgsql as $f$
declare o uuid; prop uuid; i integer;
begin
  insert into core.organization (vertical, name, slug) values (v, 'ws ' || v, 'ws-' || v) returning id into o;
  if v = 'hoteles' then
    insert into core.property (organization_id, vertical, name) values (o, v, 'prop') returning id into prop;
  end if;
  for i in 1..4 loop
    if v = 'hoteles' then
      execute format('insert into %I.messaging_outbox (organization_id, property_id, channel, event_type, dedupe_key, payload, status, next_attempt_at, claimed_at) values ($1, $2, ''whatsapp'', ''t'', $3, ''{}''::jsonb, $4, $5, $6)', v)
        using o, prop, 'k' || i, case when i <= 2 then 'pending' else 'processing' end,
              case when i = 1 then now() + interval '1 hour' else now() - interval '1 minute' end,
              case when i = 3 then now() - interval '10 seconds' when i = 4 then now() - interval '1 hour' else null end;
    else
      execute format('insert into %I.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, status, next_attempt_at, claimed_at) values ($1, ''whatsapp'', ''t'', $2, ''{}''::jsonb, $3, $4, $5)', v)
        using o, 'k' || i, case when i <= 2 then 'pending' else 'processing' end,
              case when i = 1 then now() + interval '1 hour' else now() - interval '1 minute' end,
              case when i = 3 then now() - interval '10 seconds' when i = 4 then now() - interval '1 hour' else null end;
    end if;
  end loop;
end $f$;
select pg_temp.seed_ws(v) from unnest(array['citas', 'hoteles', 'restaurantes']) as v;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare v text; keys text[];
begin
  foreach v in array array['citas', 'hoteles', 'restaurantes'] loop
    -- k2 (pending vencido) y k4 (processing con lease vencido) si; k1 (futuro) y k3 (lease vigente) no.
    execute format('select array_agg(dedupe_key order by dedupe_key) from %I.claim_messaging_outbox_batch(10, 120)', v) into keys;
    if keys is distinct from array['k2', 'k4'] then raise exception '% whatsapp: lease/next_attempt_at regresionaron, reclamo %', v, keys; end if;
  end loop;
end $$;
rollback;

\echo '=== 8. negativo + anon: staff con sesion real y el rol anon no pueden reclamar ni completar (42501) en ninguna vertical ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
do $$
declare v text;
begin
  foreach v in array array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes'] loop
    begin
      execute format('select count(*) from %I.claim_email_outbox_batch(5)', v);
      raise exception '% staff pudo reclamar correo', v;
    exception when insufficient_privilege then null;
    end;
    begin
      execute format('select %I.complete_email_outbox_job(gen_random_uuid(), ''failed'', ''x'')', v);
      raise exception '% staff pudo completar correo', v;
    exception when insufficient_privilege then null;
    end;
  end loop;
  foreach v in array array['citas', 'hoteles', 'restaurantes'] loop
    begin
      execute format('select count(*) from %I.claim_messaging_outbox_batch(5, 120)', v);
      raise exception '% staff pudo reclamar whatsapp', v;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
rollback;

begin;
set local role anon;
do $$
declare v text;
begin
  foreach v in array array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes'] loop
    begin
      execute format('select count(*) from %I.claim_email_outbox_batch(5)', v);
      raise exception '% anon pudo reclamar correo', v;
    exception when insufficient_privilege then null;
    end;
    begin
      execute format('select %I.complete_email_outbox_job(gen_random_uuid(), ''failed'', ''x'')', v);
      raise exception '% anon pudo completar correo', v;
    exception when insufficient_privilege then null;
    end;
  end loop;
  foreach v in array array['citas', 'hoteles', 'restaurantes'] loop
    begin
      execute format('select count(*) from %I.claim_messaging_outbox_batch(5, 120)', v);
      raise exception '% anon pudo reclamar whatsapp', v;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
rollback;

\echo '=== 9. cross-tenant: authenticated (staff real) sigue sin poder leer las tablas del outbox; anon tampoco ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
do $$
declare v text;
begin
  foreach v in array array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes'] loop
    begin
      execute format('select count(*) from %I.messaging_outbox', v);
      raise exception '% staff pudo leer el outbox directamente', v;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
rollback;

begin;
set local role anon;
do $$
declare v text;
begin
  foreach v in array array['citas', 'despachos', 'hoteles', 'licitaciones', 'rentas', 'restaurantes'] loop
    begin
      execute format('select count(*) from %I.messaging_outbox', v);
      raise exception '% anon pudo leer el outbox directamente', v;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
rollback;

\echo ''
\echo 'Todos los escenarios son autoverificables: un escenario que termina sin ERROR cumple su asercion; cualquier incumplimiento lanza una excepcion con la vertical y el motivo.'
