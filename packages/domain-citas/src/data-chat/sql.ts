// SQL de SOLO LECTURA del catalogo de "Chatea con tus datos" de CITAS. Una constante por herramienta, todas
// parametrizadas ($n, nunca interpolacion de valores) y con la misma forma de alcance:
//   $1 organizacion · $2 sucursales permitidas (uuid[] | null = todas) · $3 inicio · $4 fin
//   (consultas por instante: $3/$4 son timestamptz, [inicio, fin); consultas por horario de atencion: $3/$4 son dias
//   locales `date` inclusivos) · el resto de parametros se documenta en cada constante.
//
// Seguridad (ver docs/DATA-CHAT.md):
//  - Corren con la sesion RLS DEL USUARIO (rol authenticated + auth.uid()): las policies de citas.appointments
//    y citas.providers (`citas.membership_covers_property`, migracion 015) limitan a su organizacion y a sus
//    sucursales -- defensa en profundidad ademas del filtro `$2` que fija el servidor y del `organization_id = $1`.
//  - `$2` no nulo EXCLUYE las filas sin sucursal asignada (property_id null): un usuario acotado a sucursales solo
//    ve las suyas, o la que nombro, aunque la RLS dejaria ver las que no tienen sucursal.
//  - Nunca devuelven nombre, telefono ni correo de clientes: solo agregados (los clientes se cuentan por id interno
//    que jamas sale de la consulta). Los nombres de profesional, servicio y sucursal son etiquetas de agrupacion.
//  - scripts/verify-data-chat-citas/assertions.sql repite estos textos IDENTICOS (los corre el gate contra Postgres
//    real) y tests/data-chat/sql-drift.spec.ts exige que no diverjan.
//  - Estados que cuentan como cita viva: pending, confirmed, completed. Una cita cancelada o no-show no bloquea
//    horario (misma regla que la restriccion de exclusion de citas.appointments).

const APPT_SCOPE = `a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4`;

const MINUTES = (range: string): string => `extract(epoch from (upper(${range}) - lower(${range}))) / 60`;

export const SQL_VISIBLE_BRANCHES = `select p.id as property_id, p.name, p.name as slug
   from core.property p
   where p.organization_id = $1 and p.vertical = 'citas' and p.status = 'active' and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 100`;

// $5 zona horaria IANA · $6 tope de filas · $7 unidad ('day' | 'week' | 'month', la elige el CODIGO por la longitud del periodo).
export const SQL_APPOINTMENTS_BY_PERIOD = `select to_char(date_trunc($7::text, a.starts_at at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    count(*) as total,
    count(*) filter (where a.status in ('pending', 'confirmed')) as scheduled,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'cancelled') as cancelled,
    count(*) filter (where a.status = 'no_show') as no_show
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where ${APPT_SCOPE}
  group by 1 order by 1 limit $6`;

// Los profesionales (citas.providers) tienen una policy de lectura publica (catalogo para reservar), asi que la RLS no
// los acota por organizacion ni sucursal: el `exists` sobre core.membership reproduce la regla de las citas
// (`citas.membership_covers_property`, migracion 015, sin depender de ella) para que NADIE vea profesionales ni horarios de
// una organizacion o sucursal que no es suya aunque el filtro `$1`/`$2` del servidor fallara.
// Horario de atencion por profesional y dia local ($3/$4 = dias `date`, $5 zona): las excepciones del dia
// (availability_overrides) sustituyen a las reglas semanales; un dia cerrado no aporta horario. Los dias se generan con un
// entero (no con generate_series de fechas) para no depender de la zona de la sesion.
const SLOTS = `with prov as (
    select pr.id, pr.display_name, pr.property_id
    from citas.providers pr
    where pr.organization_id = $1 and pr.is_active
      and ($2::uuid[] is null or pr.property_id = any($2::uuid[]))
      and exists (
        select 1 from core.membership m
        where m.organization_id = pr.organization_id and m.user_id = auth.uid()
          and (pr.property_id is null or m.property_ids is null or pr.property_id = any(m.property_ids))
      )
  ), slots as (
    select pv.id as provider_id, ($3::date + g.n) as day,
      tstzrange((($3::date + g.n) + x.t0) at time zone $5::text, (($3::date + g.n) + x.t1) at time zone $5::text) as slot
    from prov pv
    cross join generate_series(0, $4::date - $3::date) as g(n)
    cross join lateral (
      select o.start_time as t0, o.end_time as t1
      from citas.availability_overrides o
      where o.provider_id = pv.id and o.override_date = ($3::date + g.n) and not o.is_closed
      union all
      select r.start_time, r.end_time
      from citas.availability_rules r
      where r.provider_id = pv.id and r.is_active and r.day_of_week = extract(dow from ($3::date + g.n))::int
        and not exists (select 1 from citas.availability_overrides o2 where o2.provider_id = pv.id and o2.override_date = ($3::date + g.n))
    ) as x(t0, t1)
  )`;

// Minutos reservados DENTRO del horario de atencion (una cita fuera de horario no cuenta: la ocupacion nunca pasa de 100%).
const OCC_CTES = `${SLOTS}, avail as (
    select s.provider_id, sum(${MINUTES("s.slot")}) as minutes
    from slots s group by s.provider_id
  ), booked as (
    select s.provider_id, sum(${MINUTES("i.r")}) as minutes
    from slots s
    join citas.appointments a on a.provider_id = s.provider_id and a.organization_id = $1
      and a.status in ('pending', 'confirmed', 'completed') and tstzrange(a.starts_at, a.ends_at) && s.slot
    cross join lateral (select tstzrange(a.starts_at, a.ends_at) * s.slot as r) as i
    group by s.provider_id
  )`;

// $6 = tope de filas.
export const SQL_OCCUPANCY_BY_PROVIDER = `${OCC_CTES}
  select pv.display_name as provider, coalesce(p.name, 'Sin sucursal asignada') as branch,
    coalesce(av.minutes, 0) as available_minutes, coalesce(bk.minutes, 0) as booked_minutes,
    sum(coalesce(av.minutes, 0)) over () as total_available, sum(coalesce(bk.minutes, 0)) over () as total_booked,
    count(*) over () as total_providers
  from prov pv
  left join avail av on av.provider_id = pv.id
  left join booked bk on bk.provider_id = pv.id
  left join core.property p on p.id = pv.property_id
  order by pv.display_name, pv.id
  limit $6`;

export const SQL_OCCUPANCY_BY_BRANCH = `${OCC_CTES}
  select coalesce(p.name, 'Sin sucursal asignada') as branch, count(*) as providers,
    sum(coalesce(av.minutes, 0)) as available_minutes, sum(coalesce(bk.minutes, 0)) as booked_minutes,
    sum(sum(coalesce(av.minutes, 0))) over () as total_available, sum(sum(coalesce(bk.minutes, 0))) over () as total_booked,
    sum(count(*)) over () as total_providers
  from prov pv
  left join avail av on av.provider_id = pv.id
  left join booked bk on bk.provider_id = pv.id
  left join core.property p on p.id = pv.property_id
  group by p.id, p.name
  order by p.name nulls last, p.id
  limit $6`;

// $5 = tope de filas. Los `grand_*` son de todo el alcance (la ventana se evalua antes del limit).
export const SQL_ATTENDANCE_BY_PROVIDER = `select pv.display_name as provider, count(*) as total,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'cancelled') as cancelled,
    count(*) filter (where a.status = 'no_show') as no_show,
    sum(count(*)) over () as grand_total,
    sum(count(*) filter (where a.status = 'cancelled')) over () as grand_cancelled,
    sum(count(*) filter (where a.status = 'no_show')) over () as grand_no_show
  from citas.appointments a
  join citas.providers pv on pv.id = a.provider_id and pv.organization_id = a.organization_id
  left join core.property p on p.id = a.property_id
  where ${APPT_SCOPE}
  group by pv.id, pv.display_name
  order by count(*) filter (where a.status in ('cancelled', 'no_show')) desc, pv.display_name
  limit $5`;

// Ingreso = precio de lista ACTUAL del servicio de las citas COMPLETADAS (la base no registra cobros ni descuentos).
// $5 zona · $6 tope · $7 unidad.
export const SQL_REVENUE_BY_PERIOD = `select to_char(date_trunc($7::text, a.starts_at at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    count(*) as appointments,
    coalesce(sum(s.price_cents), 0) as revenue_cents,
    count(*) filter (where s.price_cents is null) as without_price
  from citas.appointments a
  join citas.services s on s.id = a.service_id and s.organization_id = a.organization_id
  left join core.property p on p.id = a.property_id
  where ${APPT_SCOPE} and a.status = 'completed'
  group by 1 order by 1 limit $6`;

// $5 = tope de filas.
export const SQL_REVENUE_BY_SERVICE = `select s.name as service, count(*) as appointments,
    coalesce(sum(s.price_cents), 0) as revenue_cents,
    count(*) filter (where s.price_cents is null) as without_price,
    sum(coalesce(sum(s.price_cents), 0)) over () as total_revenue_cents
  from citas.appointments a
  join citas.services s on s.id = a.service_id and s.organization_id = a.organization_id
  left join core.property p on p.id = a.property_id
  where ${APPT_SCOPE} and a.status = 'completed'
  group by s.id, s.name
  order by revenue_cents desc, s.name
  limit $5`;

// Cliente nuevo = su primera cita viva (en el alcance) cae en el periodo; recurrente = ya tenia una antes. El id del
// cliente NUNCA sale de la consulta, solo conteos. $5 = tope de filas.
export const SQL_CUSTOMERS = `with in_period as (
    select a.customer_id
    from citas.appointments a
    left join core.property p on p.id = a.property_id
    where ${APPT_SCOPE} and a.status in ('pending', 'confirmed', 'completed')
    group by a.customer_id
  ), before_period as (
    select distinct a.customer_id
    from citas.appointments a
    left join core.property p on p.id = a.property_id
    where a.organization_id = $1 and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
      and a.starts_at < $3 and a.status in ('pending', 'confirmed', 'completed')
  )
  select count(*) as customers,
    count(*) filter (where b.customer_id is null) as new_customers,
    count(*) filter (where b.customer_id is not null) as recurring
  from in_period i left join before_period b on b.customer_id = i.customer_id
  limit $5`;

// Horas libres por profesional y dia de `$6` (ahora) en adelante: horario de atencion futuro menos citas vivas.
// $3/$4 = dias `date` · $5 zona · $6 = ahora (timestamptz) · $7 = tope de filas. Los `total_free` son de todo el alcance.
export const SQL_FREE_SLOTS = `${SLOTS}, live as (
    select s.provider_id, s.day, s.slot * tstzrange($6::timestamptz, null) as slot
    from slots s
  ), cap as (
    select l.provider_id, l.day, sum(${MINUTES("l.slot")}) as minutes
    from live l where not isempty(l.slot) group by l.provider_id, l.day
  ), bk as (
    select l.provider_id, l.day, sum(${MINUTES("i.r")}) as minutes
    from live l
    join citas.appointments a on a.provider_id = l.provider_id and a.organization_id = $1
      and a.status in ('pending', 'confirmed', 'completed') and tstzrange(a.starts_at, a.ends_at) && l.slot
    cross join lateral (select tstzrange(a.starts_at, a.ends_at) * l.slot as r) as i
    where not isempty(l.slot)
    group by l.provider_id, l.day
  )
  select to_char(c.day, 'YYYY-MM-DD') as day, pv.display_name as provider, coalesce(p.name, 'Sin sucursal asignada') as branch,
    c.minutes - coalesce(b.minutes, 0) as free_minutes,
    sum(c.minutes - coalesce(b.minutes, 0)) over () as total_free
  from cap c
  join prov pv on pv.id = c.provider_id
  left join bk b on b.provider_id = c.provider_id and b.day = c.day
  left join core.property p on p.id = pv.property_id
  where c.minutes - coalesce(b.minutes, 0) > 0
  order by c.day, pv.display_name, pv.id
  limit $7`;

// Recordatorios por enviar: citas por atender de ahora ($5) en adelante dentro del periodo, sin marca de recordatorio.
// $6 = tope de filas.
export const SQL_PENDING_REMINDERS = `select count(*) as pending,
    count(*) filter (where a.starts_at < $5::timestamptz + interval '24 hours') as next_24h
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1 and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= greatest($3::timestamptz, $5::timestamptz) and a.starts_at < $4
    and a.status in ('pending', 'confirmed') and a.reminder_24h_sent_at is null
  limit $6`;

// Estado de envio de los recordatorios (WhatsApp y correo): SOLO por la funcion de la migracion 027 (el outbox no es
// legible para authenticated). Devuelve conteos por canal y estado. $5 = tope de filas.
export const SQL_REMINDER_DELIVERY = `select d.channel, d.status, d.total
  from citas.data_chat_reminder_delivery($1::uuid, $2::uuid[], $3::timestamptz, $4::timestamptz) as d
  limit $5`;

export const ALL_CITAS_DATA_CHAT_SQL: Readonly<Record<string, string>> = {
  SQL_VISIBLE_BRANCHES,
  SQL_APPOINTMENTS_BY_PERIOD,
  SQL_OCCUPANCY_BY_PROVIDER,
  SQL_OCCUPANCY_BY_BRANCH,
  SQL_ATTENDANCE_BY_PROVIDER,
  SQL_REVENUE_BY_PERIOD,
  SQL_REVENUE_BY_SERVICE,
  SQL_CUSTOMERS,
  SQL_FREE_SLOTS,
  SQL_PENDING_REMINDERS,
  SQL_REMINDER_DELIVERY,
};
