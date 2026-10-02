-- Fixtures + escenarios contra Postgres REAL del seed demo de citas (bloque plpgsql generado arriba: public.seed_citas_demo()).
-- Cada escenario corre en su propio `begin; ... rollback;` y ejecuta el seed dentro de la transaccion. Convenciones del gate
-- (scripts/verify-real-postgres-ci/run-gate.mjs): `should_fail` = el escenario debe terminar en ERROR; `..._deberia_ser_N` = el
-- valor de esa consulta debe ser N.
--
--   A. Resultado: 2 organizaciones demo marcadas, catalogo, clientes ficticios (@example.test), citas en TODOS los estados
--      dentro del horario del profesional (hora local en America/Merida), pasadas/futuras coherentes y lista de espera completa.
--   B. Idempotencia: dos corridas no duplican ni mueven nada; la fecha base fija las semanas.
--   C. Aislamiento y RLS: otra organizacion con los mismos nombres/telefonos queda intacta; staff ajeno y anon no leen lo
--      sembrado; nadie de la aplicacion escribe la marca demo.
--   D. Limpieza: solo borra organizaciones marcadas (la otra queda intacta); denegada a anon/authenticated y con auth.uid().
--   E. Seguridad del seed: aborta ante un slug de otra vertical, ante una cuenta de citas NO demo y sin usuario owner.
\set ON_ERROR_STOP off
\pset pager off

-- Usuarios: el owner que recibe las cuentas demo y el owner de otra organizacion (B) NO demo.
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c0001', 'owner-demo@example.test', 'Owner de las cuentas demo', 'seed'),
  ('00000000-0000-0000-0000-0000000c0002', 'owner-b@example.test', 'Owner de la organizacion B', 'seed')
on conflict do nothing;

-- Organizacion B (NO demo) con un proveedor, servicio y cliente de MISMO nombre/telefono que los del seed.
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000c00b0', 'citas', 'Clinica Real B', 'clinica-real-b')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-0000000c00b0', null, 'owner', 'owner')
on conflict do nothing;
insert into citas.tenant_config (organization_id, rubro) values ('00000000-0000-0000-0000-0000000c00b0', 'dental') on conflict do nothing;
insert into citas.providers (id, organization_id, display_name) values
  ('00000000-0000-0000-0000-0000000c00b1', '00000000-0000-0000-0000-0000000c00b0', 'Dra. Ana Lozano')
on conflict do nothing;
insert into citas.services (id, organization_id, name, duration_minutes, price_cents) values
  ('00000000-0000-0000-0000-0000000c00b2', '00000000-0000-0000-0000-0000000c00b0', 'Limpieza dental', 30, 99900)
on conflict do nothing;
insert into citas.customers (id, organization_id, full_name, phone, email) values
  ('00000000-0000-0000-0000-0000000c00b3', '00000000-0000-0000-0000-0000000c00b0', 'Cliente real de B', '5200101000', 'real-b@clinica-b.test')
on conflict do nothing;
insert into citas.appointments (id, organization_id, provider_id, service_id, customer_id, starts_at, ends_at, status) values
  ('00000000-0000-0000-0000-0000000c00b4', '00000000-0000-0000-0000-0000000c00b0', '00000000-0000-0000-0000-0000000c00b1', '00000000-0000-0000-0000-0000000c00b2', '00000000-0000-0000-0000-0000000c00b3', now() + interval '3 days', now() + interval '3 days 30 minutes', 'confirmed')
on conflict do nothing;

\echo '=== A1. Dos organizaciones demo creadas, de vertical citas y marcadas en citas.demo_organization ==='
begin;
select public.seed_citas_demo();
select count(*)::int as organizaciones_demo_deberia_ser_2
  from core.organization o join citas.demo_organization d on d.organization_id = o.id
  where o.vertical = 'citas' and o.slug in ('clinica-dental-sonrisa-demo', 'barberia-el-filo-demo');
rollback;

\echo '=== A2. Catalogo: 8 servicios, 6 profesionales con sus servicios, 20 clientes, rubro y zona horaria ==='
begin;
select public.seed_citas_demo();
select (
  (select count(*) from citas.services s join citas.demo_organization d on d.organization_id = s.organization_id) = 8
  and (select count(*) from citas.providers p join citas.demo_organization d on d.organization_id = p.organization_id) = 6
  and (select count(*) from citas.provider_services ps join citas.providers p on p.id = ps.provider_id join citas.demo_organization d on d.organization_id = p.organization_id) = 17
  and (select count(*) from citas.customers c join citas.demo_organization d on d.organization_id = c.organization_id) = 20
  and (select count(*) from citas.tenant_config t join core.organization o on o.id = t.organization_id where (o.slug, t.rubro, t.default_timezone) in (('clinica-dental-sonrisa-demo', 'dental', 'America/Merida'), ('barberia-el-filo-demo', 'barberia', 'America/Merida'))) = 2
)::int as catalogo_correcto_deberia_ser_1;
rollback;

\echo '=== A3. 49 citas; cada organizacion tiene al menos una cita en CADA uno de los 5 estados ==='
begin;
select public.seed_citas_demo();
select (
  (select count(*) from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id) = 49
  and (select count(*) from (
        select a.organization_id, count(distinct a.status) as estados from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id group by a.organization_id
      ) t where t.estados = 5) = 2
  and (select count(*) from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id where a.status = 'no_show') = 6
)::int as citas_por_estado_correctas_deberia_ser_1;
rollback;

\echo '=== A4. Toda cita activa cae dentro del horario semanal de su profesional, en HORA LOCAL (America/Merida) ==='
begin;
select public.seed_citas_demo();
select count(*)::int as citas_fuera_de_horario_deberia_ser_0
  from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id
  where a.status in ('pending', 'confirmed', 'completed')
    and not exists (
      select 1 from citas.availability_rules r
      where r.provider_id = a.provider_id
        and r.day_of_week = extract(dow from (a.starts_at at time zone 'America/Merida'))::int
        and r.start_time <= (a.starts_at at time zone 'America/Merida')::time
        and (a.ends_at at time zone 'America/Merida')::time <= r.end_time
    );
rollback;

\echo '=== A5. Clientes ficticios: correo @example.test y telefono de lada reservada 5200 ==='
begin;
select public.seed_citas_demo();
select count(*)::int as clientes_no_ficticios_deberia_ser_0
  from citas.customers c join citas.demo_organization d on d.organization_id = c.organization_id
  where c.email is null or c.email !~ '^[^@]+@example\.test$' or c.phone !~ '^5200[0-9]{6}$';
rollback;

\echo '=== A6. Lista de espera: 10 filas y los 5 estados en cada organizacion ==='
begin;
select public.seed_citas_demo();
select (
  (select count(*) from citas.appointment_waitlist w join citas.demo_organization d on d.organization_id = w.organization_id) = 10
  and (select count(*) from (
        select w.organization_id, count(distinct w.status) as estados from citas.appointment_waitlist w join citas.demo_organization d on d.organization_id = w.organization_id group by w.organization_id
      ) t where t.estados = 5) = 2
)::int as lista_de_espera_correcta_deberia_ser_1;
rollback;

\echo '=== A7. Pasado y futuro coherentes: completed/no_show ya ocurrieron; confirmed/pending aun no; la semana en curso esta libre ==='
begin;
select public.seed_citas_demo();
select (
  (select count(*) from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id where a.status in ('completed', 'no_show') and a.starts_at >= now()) = 0
  and (select count(*) from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id where a.status in ('confirmed', 'pending') and a.starts_at <= now()) = 0
  and (select count(*) from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id
        where a.starts_at >= date_trunc('week', (now() at time zone 'America/Merida')) at time zone 'America/Merida'
          and a.starts_at < date_trunc('week', (now() at time zone 'America/Merida')) at time zone 'America/Merida' + interval '7 days') = 0
)::int as pasado_y_futuro_coherentes_deberia_ser_1;
rollback;

\echo '=== A8. Excepciones de horario: 5 (3 dias cerrados o reducidos en la clinica, 2 en la barberia) ==='
begin;
select public.seed_citas_demo();
select count(*)::int as excepciones_deberia_ser_5
  from citas.availability_overrides o join citas.providers p on p.id = o.provider_id join citas.demo_organization d on d.organization_id = p.organization_id;
rollback;

\echo '=== B1. Idempotencia: dos corridas no duplican nada (citas, clientes, profesionales, servicios, reglas, excepciones, espera, marcas, membresias) ==='
begin;
select public.seed_citas_demo();
create temp table antes_b1 as
  select (select count(*) from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id) as citas,
         (select count(*) from citas.customers c join citas.demo_organization d on d.organization_id = c.organization_id) as clientes,
         (select count(*) from citas.providers p join citas.demo_organization d on d.organization_id = p.organization_id) as proveedores,
         (select count(*) from citas.services s join citas.demo_organization d on d.organization_id = s.organization_id) as servicios,
         (select count(*) from citas.provider_services ps join citas.providers p on p.id = ps.provider_id join citas.demo_organization d on d.organization_id = p.organization_id) as asignaciones,
         (select count(*) from citas.availability_rules r join citas.providers p on p.id = r.provider_id join citas.demo_organization d on d.organization_id = p.organization_id) as reglas,
         (select count(*) from citas.availability_overrides o join citas.providers p on p.id = o.provider_id join citas.demo_organization d on d.organization_id = p.organization_id) as excepciones,
         (select count(*) from citas.appointment_waitlist w join citas.demo_organization d on d.organization_id = w.organization_id) as espera,
         (select count(*) from citas.demo_organization) as marcas,
         (select count(*) from core.membership m join citas.demo_organization d on d.organization_id = m.organization_id) as membresias,
         (select count(*) from core.property p join citas.demo_organization d on d.organization_id = p.organization_id) as sucursales;
select public.seed_citas_demo();
select (
  select (a.citas, a.clientes, a.proveedores, a.servicios, a.asignaciones, a.reglas, a.excepciones, a.espera, a.marcas, a.membresias, a.sucursales) =
         ((select count(*) from citas.appointments x join citas.demo_organization d on d.organization_id = x.organization_id),
          (select count(*) from citas.customers x join citas.demo_organization d on d.organization_id = x.organization_id),
          (select count(*) from citas.providers x join citas.demo_organization d on d.organization_id = x.organization_id),
          (select count(*) from citas.services x join citas.demo_organization d on d.organization_id = x.organization_id),
          (select count(*) from citas.provider_services ps join citas.providers p on p.id = ps.provider_id join citas.demo_organization d on d.organization_id = p.organization_id),
          (select count(*) from citas.availability_rules r join citas.providers p on p.id = r.provider_id join citas.demo_organization d on d.organization_id = p.organization_id),
          (select count(*) from citas.availability_overrides o join citas.providers p on p.id = o.provider_id join citas.demo_organization d on d.organization_id = p.organization_id),
          (select count(*) from citas.appointment_waitlist x join citas.demo_organization d on d.organization_id = x.organization_id),
          (select count(*) from citas.demo_organization),
          (select count(*) from core.membership m join citas.demo_organization d on d.organization_id = m.organization_id),
          (select count(*) from core.property p join citas.demo_organization d on d.organization_id = p.organization_id))
  from antes_b1 a
)::int as sin_duplicados_deberia_ser_1;
rollback;

\echo '=== B2. Re-ejecutar no mueve ni cambia de estado ninguna cita ya sembrada (mismos ids, horarios y estados) ==='
begin;
select public.seed_citas_demo();
create temp table antes as
  select md5(string_agg(a.id::text || a.starts_at::text || a.status, ',' order by a.idempotency_key)) as h
  from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id;
select public.seed_citas_demo();
select ((select h from antes) = (select md5(string_agg(a.id::text || a.starts_at::text || a.status, ',' order by a.idempotency_key))
  from citas.appointments a join citas.demo_organization d on d.organization_id = a.organization_id))::int as citas_sin_cambios_deberia_ser_1;
rollback;

\echo '=== B3. --fecha-base fija las semanas: con base miercoles 2026-03-04 la cita d16 es el lunes 2026-03-09 a las 09:00 locales y la excepcion de la Dra. Ana el 2026-03-11 ==='
begin;
select public.seed_citas_demo_fecha_base();
select (
  exists (select 1 from citas.appointments a where a.idempotency_key = '{{HASH_D16}}' and (a.starts_at at time zone 'America/Merida') = timestamp '2026-03-09 09:00:00')
  and exists (select 1 from citas.availability_overrides o join citas.providers p on p.id = o.provider_id where p.display_name = 'Dra. Ana Lozano' and o.override_date = date '2026-03-11' and o.is_closed)
)::int as semanas_por_fecha_base_deberia_ser_1;
rollback;

\echo '=== B4. El preflight de esquema no reporta faltantes contra la base migrada ==='
begin;
select count(*)::int as faltantes_deberia_ser_0 from ({{PREFLIGHT}}) f;
rollback;

\echo '=== C1. El owner indicado queda como owner de las dos cuentas demo (y no se crea ningun usuario) ==='
begin;
select public.seed_citas_demo();
select (
  (select count(*) from core.membership m join citas.demo_organization d on d.organization_id = m.organization_id where m.user_id = '00000000-0000-0000-0000-0000000c0001' and m.platform_role = 'owner' and m.vertical_role = 'owner') = 2
  and (select count(*) from core.staff_user where email like '%@example.test') = 2
)::int as owner_enlazado_deberia_ser_1;
rollback;

\echo '=== C2. Aislamiento: la organizacion B (mismos nombres y mismo telefono de cliente) queda intacta ==='
begin;
select public.seed_citas_demo();
select (
  (select count(*) from citas.providers where organization_id = '00000000-0000-0000-0000-0000000c00b0') = 1
  and (select count(*) from citas.services where organization_id = '00000000-0000-0000-0000-0000000c00b0' and price_cents = 99900 and duration_minutes = 30) = 1
  and (select full_name from citas.customers where id = '00000000-0000-0000-0000-0000000c00b3') = 'Cliente real de B'
  and (select email from citas.customers where id = '00000000-0000-0000-0000-0000000c00b3') = 'real-b@clinica-b.test'
  and (select count(*) from citas.appointments where organization_id = '00000000-0000-0000-0000-0000000c00b0') = 1
  and not exists (select 1 from citas.demo_organization where organization_id = '00000000-0000-0000-0000-0000000c00b0')
)::int as organizacion_b_intacta_deberia_ser_1;
rollback;

\echo '=== C3. RLS: el staff de la organizacion B no ve ninguna cita, cliente ni marca de las cuentas demo ==='
begin;
select public.seed_citas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0002', true);
select (
  (select count(*) from citas.appointments a where a.organization_id <> '00000000-0000-0000-0000-0000000c00b0')
  + (select count(*) from citas.customers c where c.organization_id <> '00000000-0000-0000-0000-0000000c00b0')
  + (select count(*) from citas.demo_organization)
)::int as filas_demo_visibles_para_staff_ajeno_deberia_ser_0;
rollback;

\echo '=== C4. RLS: el owner de las cuentas demo si ve sus 49 citas y las 2 marcas ==='
begin;
select public.seed_citas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0001', true);
select ((select count(*) from citas.appointments) = 49 and (select count(*) from citas.demo_organization) = 2)::int as owner_demo_ve_lo_suyo_deberia_ser_1;
rollback;

\echo '=== C5. RECHAZADO (debe fallar): anon no lee las citas sembradas ==='
begin;
select public.seed_citas_demo();
set local role anon;
select count(*)::int as should_fail from citas.appointments;
rollback;

\echo '=== C6. RECHAZADO (debe fallar): anon no lee la marca demo ==='
begin;
select public.seed_citas_demo();
set local role anon;
select count(*)::int as should_fail from citas.demo_organization;
rollback;

\echo '=== C7. RECHAZADO (debe fallar): un owner de la aplicacion no puede marcar su organizacion como demo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0002', true);
insert into citas.demo_organization (organization_id, seed_version) values ('00000000-0000-0000-0000-0000000c00b0', 'x') returning 1 as should_fail;
rollback;

\echo '=== C8. RECHAZADO (debe fallar): service_role tampoco escribe la marca demo (solo el propietario de la base) ==='
begin;
grant usage on schema citas to service_role; -- en Supabase real el rol ya lo tiene: asi la negativa viene de la TABLA y no del esquema
set local role service_role;
insert into citas.demo_organization (organization_id, seed_version) values ('00000000-0000-0000-0000-0000000c00b0', 'x') returning 1 as should_fail;
rollback;

\echo '=== D1. Limpieza: borra SOLO la organizacion demo indicada (con sus citas, clientes y espera); la otra demo y la organizacion B quedan intactas ==='
begin;
select public.seed_citas_demo();
select citas.demo_limpiar(id) from core.organization where slug = 'clinica-dental-sonrisa-demo';
select (
  not exists (select 1 from core.organization where slug = 'clinica-dental-sonrisa-demo')
  and (select count(*) from citas.appointments a join core.organization o on o.id = a.organization_id where o.slug = 'barberia-el-filo-demo') = 24
  and (select count(*) from citas.appointment_waitlist w join core.organization o on o.id = w.organization_id where o.slug = 'barberia-el-filo-demo') = 5
  and (select count(*) from citas.demo_organization) = 1
  and (select count(*) from citas.appointments where organization_id = '00000000-0000-0000-0000-0000000c00b0') = 1
  and (select count(*) from citas.customers where organization_id = '00000000-0000-0000-0000-0000000c00b0') = 1
)::int as limpieza_aislada_deberia_ser_1;
rollback;

\echo '=== D2. Limpieza completa de las dos demos no deja filas huerfanas de citas en ninguna tabla ==='
begin;
select public.seed_citas_demo();
select citas.demo_limpiar(id) from core.organization where slug in ('clinica-dental-sonrisa-demo', 'barberia-el-filo-demo');
select (
  (select count(*) from citas.appointments where organization_id <> '00000000-0000-0000-0000-0000000c00b0')
  + (select count(*) from citas.customers where organization_id <> '00000000-0000-0000-0000-0000000c00b0')
  + (select count(*) from citas.providers where organization_id <> '00000000-0000-0000-0000-0000000c00b0')
  + (select count(*) from citas.services where organization_id <> '00000000-0000-0000-0000-0000000c00b0')
  + (select count(*) from citas.appointment_waitlist where organization_id <> '00000000-0000-0000-0000-0000000c00b0')
  + (select count(*) from citas.availability_rules r where not exists (select 1 from citas.providers p where p.id = r.provider_id))
  + (select count(*) from citas.demo_organization)
)::int as filas_huerfanas_deberia_ser_0;
rollback;

\echo '=== D3. RECHAZADO (debe fallar): la limpieza se niega a borrar una organizacion NO marcada como demo ==='
begin;
select citas.demo_limpiar('00000000-0000-0000-0000-0000000c00b0') as should_fail;
rollback;

\echo '=== D4. RECHAZADO (debe fallar): un usuario autenticado no puede ejecutar la limpieza ==='
begin;
select public.seed_citas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0001', true);
select citas.demo_limpiar(id) as should_fail from core.organization where slug = 'barberia-el-filo-demo';
rollback;

\echo '=== D5. RECHAZADO (debe fallar): anon no puede ejecutar la limpieza ==='
begin;
select public.seed_citas_demo();
set local role anon;
select citas.demo_limpiar('00000000-0000-0000-0000-0000000c00b0') as should_fail;
rollback;

\echo '=== D6. RECHAZADO (debe fallar): defensa en profundidad: con auth.uid() presente la funcion se niega aunque quien llama sea el propietario de la base ==='
begin;
select public.seed_citas_demo();
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0001', true);
select citas.demo_limpiar(id) as should_fail from core.organization where slug = 'barberia-el-filo-demo';
rollback;

\echo '=== E1. RECHAZADO (debe fallar): el slug ya existe en OTRA vertical; el seed aborta sin tocarla ==='
begin;
insert into core.organization (vertical, name, slug) values ('restaurantes', 'Otra vertical', 'barberia-el-filo-demo');
select public.seed_citas_demo() as should_fail;
rollback;

\echo '=== E2. RECHAZADO (debe fallar): el slug ya existe como cuenta de citas que NO es demo; el seed aborta sin tocarla ==='
begin;
insert into core.organization (vertical, name, slug) values ('citas', 'Cuenta real de citas', 'clinica-dental-sonrisa-demo');
select public.seed_citas_demo() as should_fail;
rollback;

\echo '=== E3. RECHAZADO (debe fallar): sin un usuario de staff con ese correo el seed aborta y no crea credenciales ==='
begin;
select public.seed_citas_demo_sin_owner() as should_fail;
rollback;

\echo '=== E4. Atomicidad: si el seed aborta a media corrida (la segunda cuenta ya existe como cuenta real), no queda NADA de la primera ==='
begin;
insert into core.organization (vertical, name, slug) values ('citas', 'Cuenta real de citas', 'barberia-el-filo-demo');
do $$ begin
  begin
    perform public.seed_citas_demo();
  exception when others then
    null;
  end;
end $$;
select count(*)::int as organizaciones_demo_tras_aborto_deberia_ser_0 from core.organization where slug = 'clinica-dental-sonrisa-demo';
rollback;
