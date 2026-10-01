// SQL de SOLO LECTURA del catalogo de "Chatea con tus datos" de HOTELES. Una constante por herramienta,
// todas parametrizadas ($1..$7, nunca interpolacion). Alcance comun:
//   $1 organizacion · $2 propiedades permitidas (uuid[] | null = todas) · $3/$4 ventana (segun la consulta:
//   fechas de negocio inclusive para `stay_date`/`check_in_date`, o instantes [inicio, fin) para `created_at`/
//   `canceled_at`) · resto de parametros documentados en cada consulta.
//
// Seguridad (ver docs/DATA-CHAT.md):
//  - Corren con la sesion RLS DEL USUARIO (rol authenticated + auth.uid()): las policies de cada tabla
//    (`has_property_access`, `can_access_money` para folios/cargos, visibilidad por departamento de
//    tickets) y el JOIN con core.property limitan a las propiedades de su membership -- defensa en
//    profundidad ademas del filtro `$2` que fija el servidor.
//  - Nunca devuelven datos de huespedes ni texto libre (mensajes de tickets, notas): solo agregados.
//  - Ocupacion/ADR/RevPAR salen de las MISMAS fuentes que el P&L USALI (cargos `hospedaje` vigentes =
//    noche ocupada, inventario `availability.total_rooms` = noches disponibles), cada una agregada por
//    dia en su propio CTE y unida DESPUES: nunca un JOIN cargo x inventario (multiplicaria filas = doble conteo).
//  - tests/data-chat/sql-drift.spec.ts exige que estos textos aparezcan identicos en
//    scripts/verify-data-chat-hoteles/assertions.sql (el verify los corre contra Postgres real).

const ORG_SCOPE = (alias: string) => `${alias}.organization_id = $1
    and ($2::uuid[] is null or ${alias}.property_id = any($2::uuid[]))`;

export const SQL_VISIBLE_HOTELS = `select p.id as property_id, p.name, p.name as slug
   from core.property p
   where p.organization_id = $1 and p.vertical = 'hoteles' and p.status = 'active'
     and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 100`;

// $3 = primer dia (date, inclusive) · $4 = ultimo dia (date, inclusive) · $5 = unidad de agrupacion
// ('day' | 'week' | 'month': la elige el CODIGO por la longitud del periodo, nunca el modelo) · $6 = tope de filas.
export const SQL_OCCUPANCY_ADR_REVPAR = `with ocupadas as (
    select c.stay_date as day, count(*) as room_nights, coalesce(sum(c.amount), 0) as revenue
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    where ${ORG_SCOPE("c")}
      and c.concept = 'hospedaje' and c.reversed_by is null
      and c.stay_date between $3::date and $4::date
    group by c.stay_date
  ), disponibles as (
    select a.date as day, coalesce(sum(a.total_rooms), 0) as available
    from hoteles.availability a
    join core.property p on p.id = a.property_id
    where ${ORG_SCOPE("a")}
      and a.date between $3::date and $4::date
    group by a.date
  )
  select to_char(date_trunc($5::text, coalesce(o.day, d.day)::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.available), 0) as available_nights,
    coalesce(sum(o.room_nights), 0) as occupied_nights,
    coalesce(sum(o.revenue), 0) as room_revenue
  from ocupadas o
  full join disponibles d on d.day = o.day
  group by 1 order by 1 limit $6`;

// $3/$4 = primer/ultimo dia (date, inclusive) · $5 = unidad · $6 = zona horaria IANA (solo para cargos sin
// `stay_date`) · $7 = tope. Misma clasificacion cargo -> departamento que el P&L USALI
// (`PL_REVENUE_DEPARTMENT_CASE` de postgres-repository.ts): importes NETOS (sin IVA/ISH), 'propina' fuera,
// 'reverso' se resuelve al concepto del cargo ORIGINAL.
export const SQL_REVENUE_BY_PERIOD = `select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.amount) filter (where d.dept = 'habitaciones'), 0) as rooms,
    coalesce(sum(d.amount) filter (where d.dept = 'ab'), 0) as food_beverage,
    coalesce(sum(d.amount) filter (where d.dept = 'otros'), 0) as other
  from (
    select coalesce(c.stay_date, (c.created_at at time zone $6::text)::date) as day, c.amount,
      case coalesce(orig.concept, c.concept)
        when 'hospedaje' then 'habitaciones'
        when 'ajuste' then 'habitaciones'
        when 'descuento' then 'habitaciones'
        when 'ab' then 'ab'
        when 'extras' then 'otros'
        when 'otro' then 'otros'
        else null
      end as dept
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    left join hoteles.charge orig on orig.id = c.reverses_charge_id
    where ${ORG_SCOPE("c")}
      and coalesce(c.stay_date, (c.created_at at time zone $6::text)::date) between $3::date and $4::date
      and coalesce(orig.concept, c.concept) <> 'propina'
  ) d
  where d.dept is not null
  group by 1 order by 1 limit $7`;

// $3/$4 = primer/ultimo dia (date, inclusive) · $5 = unidad de agrupacion ('day' | 'week' | 'month', la elige el
// CODIGO) · $6 = tope. Llegadas = check-in previsto/real del dia; salidas = check-out previsto/real del dia. Solo
// reservas vigentes (ni cotizadas, ni canceladas, ni no-show). Una reserva cuenta UNA vez como llegada (su dia de
// entrada) y UNA como salida (su dia de salida): nunca el mismo dia (check_out_date > check_in_date).
export const SQL_ARRIVALS_DEPARTURES = `select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    count(*) filter (where d.kind = 'llegada') as arrivals,
    count(*) filter (where d.kind = 'salida') as departures
  from (
    select r.check_in_date as day, 'llegada' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where ${ORG_SCOPE("r")}
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_in_date between $3::date and $4::date
    union all
    select r.check_out_date as day, 'salida' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where ${ORG_SCOPE("r")}
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_out_date between $3::date and $4::date
  ) d
  group by 1 order by 1 limit $6`;

// $3 = inicio (timestamptz, inclusive) · $4 = fin (timestamptz, exclusivo) · $5 = unidad · $6 = zona horaria · $7 = tope.
// Cancelaciones agrupadas por el dia LOCAL en que se cancelaron (`canceled_at`), no por la fecha de estancia.
export const SQL_CANCELLATIONS = `select to_char(date_trunc($5::text, (r.canceled_at at time zone $6::text))::date, 'YYYY-MM-DD') as bucket,
    count(*) as cancelled, coalesce(sum(r.total_amount), 0) as booked_value,
    coalesce(sum(r.cancellation_penalty_amount), 0) as penalties
  from hoteles.reservation r
  join core.property p on p.id = r.property_id
  where ${ORG_SCOPE("r")}
    and r.status = 'cancelada' and r.canceled_at >= $3 and r.canceled_at < $4
  group by 1 order by 1 limit $7`;

// $3 = ahora (timestamptz; lo fija el servidor, no el modelo) · $4 = tope. Abiertos = abierto/en_progreso/escalado.
// Nunca devuelve el texto del huesped (`guest_message`).
export const SQL_OPEN_TICKETS_SLA = `select t.department, t.priority, count(*) as open_tickets,
    count(*) filter (where t.sla_due_at < $3) as overdue,
    count(*) filter (where t.sla_due_at >= $3 and t.sla_due_at < $3 + interval '2 hours') as due_soon,
    count(*) filter (where t.status = 'escalado') as escalated
  from hoteles.guest_ticket t
  join core.property p on p.id = t.property_id
  where ${ORG_SCOPE("t")}
    and t.status in ('abierto', 'en_progreso', 'escalado')
  group by t.department, t.priority
  order by overdue desc, open_tickets desc, t.department, t.priority limit $4`;

// $3 = hoy (date, dia de negocio de la propiedad; lo fija el servidor) · $4 = tope. Pendiente = tarea 'pendiente' o
// 'en_progreso' con dia de trabajo hasta hoy; `backlog` = las de dias anteriores (rezago). Una fila por tipo de tarea.
export const SQL_HOUSEKEEPING_PENDING = `select t.task_type,
    count(*) filter (where t.status = 'pendiente') as pending,
    count(*) filter (where t.status = 'en_progreso') as in_progress,
    count(*) filter (where t.work_date < $3::date) as backlog,
    count(*) filter (where t.priority = 'alta') as high_priority
  from hoteles.housekeeping_task t
  join core.property p on p.id = t.property_id
  where ${ORG_SCOPE("t")}
    and t.status in ('pendiente', 'en_progreso') and t.work_date <= $3::date
  group by t.task_type order by t.task_type limit $4`;

export const ALL_HOTELES_DATA_CHAT_SQL: Readonly<Record<string, string>> = {
  SQL_VISIBLE_HOTELS,
  SQL_OCCUPANCY_ADR_REVPAR,
  SQL_REVENUE_BY_PERIOD,
  SQL_ARRIVALS_DEPARTURES,
  SQL_CANCELLATIONS,
  SQL_OPEN_TICKETS_SLA,
  SQL_HOUSEKEEPING_PENDING,
};
