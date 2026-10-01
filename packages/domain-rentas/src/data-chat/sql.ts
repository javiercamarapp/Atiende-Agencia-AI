// SQL de SOLO LECTURA del catalogo de "Chatea con tus datos" de RENTAS VACACIONALES. Una constante por
// herramienta, todas parametrizadas ($1..$6, nunca interpolacion). Alcance comun:
//   $1 organizacion · $2 propiedades permitidas (uuid[] | null = todas) · $3/$4 ventana (fechas de calendario
//   inclusive, `date`) · resto de parametros documentados en cada consulta.
//
// Seguridad (ver docs/DATA-CHAT.md):
//  - Corren con la sesion RLS DEL USUARIO (rol authenticated + auth.uid()): las policies de cada tabla
//    (`has_property_access`; `can_read_finanzas` para todo lo financiero: solo admin_gestora/contador) y el JOIN con
//    core.property limitan a las propiedades de su membership -- defensa en profundidad ademas del filtro `$2`
//    que fija el servidor.
//  - Nunca devuelven datos de huespedes (rentas.guest_minimo) ni de contacto de propietarios: solo el nombre del
//    propietario como etiqueta de agrupacion, y agregados.
//  - Montos: la base guarda CENTAVOS (bigint) por moneda. Solo se suman los de moneda MXN; los demas se cuentan
//    aparte (`other_currency`) y la herramienta lo dice, nunca se mezclan monedas.
//  - Doble conteo: `reserva_financiero` es 1:1 con la ocupacion (UNIQUE) y las lineas de gasto/impuesto NO se unen;
//    los pagos de canal agregan cabecera y lineas en CTE separados; las liquidaciones toman SOLO la ultima version.
//  - tests/data-chat/sql-drift.spec.ts exige que estos textos aparezcan identicos en
//    scripts/verify-data-chat-rentas/assertions.sql (el verify los corre contra Postgres real).

const SCOPE = (alias: string) => `${alias}.organization_id = $1
    and ($2::uuid[] is null or ${alias}.property_id = any($2::uuid[]))`;

export const SQL_VISIBLE_PROPERTIES = `select p.id as property_id, p.name, p.name as slug
   from core.property p
   where p.organization_id = $1 and p.vertical = 'rentas' and p.status = 'active'
     and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 100`;

// $3 = primer dia (date, inclusive) · $4 = ultimo dia (date, inclusive) · $5 = tope de filas. Una fila por unidad.
// Para cada (unidad, dia) se evalua UNA vez si esta reservada (reserva confirmada) o bloqueada (propietario/
// mantenimiento) con EXISTS: dos reservas/bloqueos que se traslapen nunca cuentan dos veces la misma noche.
// Los totales (`total_*`) salen de TODAS las unidades aunque el tope recorte la lista.
export const SQL_OCCUPANCY_BY_UNIT = `with days as (
    select d::date as day from generate_series($3::date, $4::date, interval '1 day') d
  ), units as (
    select u.id, u.name
    from rentas.unidad u
    join core.property p on p.id = u.property_id
    where ${SCOPE("u")} and p.status = 'active'
  ), grid as (
    select u.id, u.name, d.day,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango @> d.day) as booked,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'bloqueo' and o.razon in ('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO') and o.estado <> 'cancelado' and o.rango @> d.day) as blocked
    from units u cross join days d
  )
  select g.name as unit_name,
    count(*) filter (where g.booked) as booked_nights,
    count(*) filter (where g.blocked and not g.booked) as blocked_nights,
    count(*) as period_nights,
    sum(count(*) filter (where g.booked)) over () as total_booked,
    sum(count(*) filter (where g.blocked and not g.booked)) over () as total_blocked,
    sum(count(*)) over () as total_period,
    count(*) over () as total_units
  from grid g
  group by g.id, g.name
  order by booked_nights desc, g.name
  limit $5`;

// $3/$4 = primer/ultimo dia de LLEGADA (date, inclusive) · $5 = tope. Reservas confirmadas con llegada (inicio del
// rango) en el periodo, por canal de origen. Importes en CENTAVOS de MXN; `other_currency` cuenta las reservas en
// otra moneda (no se suman).
export const SQL_INCOME_BY_CHANNEL = `select coalesce(c.nombre, 'Sin canal registrado') as channel,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos) filter (where rf.moneda = 'MXN'), 0) as channel_fee_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join core.property p on p.id = o.property_id
  left join rentas.canal c on c.id = o.canal_origen_id
  where ${SCOPE("o")}
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by c.id, c.nombre
  order by gross_cents desc, channel limit $5`;

// Mismos parametros y reglas que SQL_INCOME_BY_CHANNEL, agrupado por propietario de la unidad. El nombre del
// propietario es solo la etiqueta de agrupacion (nunca correo ni contacto); si la RLS no deja ver al propietario se
// dice "no visible", nunca se inventa un nombre.
export const SQL_INCOME_BY_OWNER = `select coalesce(ow.name, case when u.owner_id is null then 'Sin propietario asignado' else 'Propietario no visible' end) as owner_name,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos + rf.comision_gestor_centavos) filter (where rf.moneda = 'MXN'), 0) as fees_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join rentas.unidad u on u.id = o.unidad_id
  join core.property p on p.id = o.property_id
  left join rentas.owner ow on ow.id = u.owner_id
  where ${SCOPE("o")}
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by u.owner_id, ow.name
  order by gross_cents desc, owner_name limit $5`;

// $3 = ahora (timestamptz; lo fija el servidor) · $4 = tope. Conflictos de calendario SIN resolver, con su
// antiguedad en dias. `total` cuenta todos aunque el tope recorte la lista. Sin datos del huesped.
export const SQL_OPEN_CALENDAR_CONFLICTS = `select u.name as unit_name, cc.tipo as kind,
    floor(extract(epoch from ($3::timestamptz - cc.detectado_en)) / 86400)::int as days_open,
    count(*) over () as total
  from rentas.conflicto_calendario cc
  join rentas.unidad u on u.id = cc.unidad_id
  join core.property p on p.id = cc.property_id
  where ${SCOPE("cc")} and cc.resuelto_en is null
  order by cc.detectado_en, u.name limit $4`;

// $3 = primer dia programado (date | null = sin limite inferior, para incluir el rezago) · $4 = ultimo dia
// programado (date, inclusive) · $5 = ahora (timestamptz) · $6 = tipo ('limpieza' | 'mantenimiento' | 'inspeccion' |
// null = todos) · $7 = tope. Pendiente = pendiente, asignada, en progreso o bloqueada (no completada ni cancelada).
export const SQL_PENDING_TASKS = `select u.name as unit_name, t.tipo as kind, t.estado as status, t.prioridad as priority,
    t.programada_para::text as scheduled,
    (t.sla_vence_en is not null and t.sla_vence_en < $5::timestamptz) as sla_overdue,
    count(*) over () as total
  from rentas.tarea_operativa t
  join rentas.unidad u on u.id = t.unidad_id
  join core.property p on p.id = t.property_id
  where ${SCOPE("t")}
    and t.estado in ('pendiente', 'asignada', 'en_progreso', 'bloqueada')
    and ($3::date is null or t.programada_para >= $3::date) and t.programada_para <= $4::date
    and ($6::text is null or t.tipo = $6::text)
  order by t.programada_para, case t.prioridad when 'urgente' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, u.name
  limit $7`;

// $3/$4 = primer/ultimo dia (date, inclusive) · $5 = tope. Liquidaciones a propietarios cuyo periodo se TRASLAPA con
// el rango, tomando SOLO la ultima version de cada (propietario, propiedad, periodo): las versiones anteriores
// (re-emisiones) nunca se suman. Importes en CENTAVOS; la moneda viaja en la fila.
export const SQL_OWNER_STATEMENTS = `select coalesce(ow.name, 'Propietario no visible') as owner_name,
    s.periodo_inicio::text as period_start, s.periodo_fin::text as period_end, s.version, s.moneda as currency,
    s.ingresos_brutos_centavos as gross_cents, s.neto_centavos as net_cents, s.generado_en::date::text as generated_on
  from (
    select distinct on (os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin) os.*
    from rentas.owner_statement os
    join core.property p on p.id = os.property_id
    where ${SCOPE("os")}
      and os.periodo_inicio <= $4::date and os.periodo_fin >= $3::date
    order by os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin, os.version desc
  ) s
  left join rentas.owner ow on ow.id = s.owner_id
  order by s.periodo_inicio desc, owner_name, s.moneda, s.property_id limit $5`;

// $3/$4 = primer/ultimo dia de PAGO (date, inclusive) · $5 = tope. Pagos recibidos de los canales por fecha de pago,
// con las lineas por conciliar. Cabecera y lineas se agregan en CTE separados: unir pago x lineas repetiria el monto
// del pago por cada linea (doble conteo).
export const SQL_CHANNEL_PAYOUTS = `with pay as (
    select pc.id, pc.canal_id, pc.monto_total_centavos, pc.moneda
    from rentas.payout_canal pc
    join core.property p on p.id = pc.property_id
    where ${SCOPE("pc")}
      and pc.fecha_payout between $3::date and $4::date
  ), lines as (
    select pl.payout_id,
      count(*) filter (where pl.estado_conciliacion = 'pendiente') as pending_lines,
      count(*) filter (where pl.estado_conciliacion = 'discrepancia') as mismatched_lines
    from rentas.payout_linea pl
    where pl.payout_id in (select id from pay)
    group by pl.payout_id
  )
  select c.nombre as channel,
    count(*) as payouts,
    coalesce(sum(pay.monto_total_centavos) filter (where pay.moneda = 'MXN'), 0) as total_cents,
    coalesce(sum(l.pending_lines), 0) as pending_lines,
    coalesce(sum(l.mismatched_lines), 0) as mismatched_lines,
    count(*) filter (where pay.moneda <> 'MXN') as other_currency
  from pay
  join rentas.canal c on c.id = pay.canal_id
  left join lines l on l.payout_id = pay.id
  group by c.id, c.nombre
  order by total_cents desc, channel limit $5`;

export const ALL_RENTAS_DATA_CHAT_SQL: Readonly<Record<string, string>> = {
  SQL_VISIBLE_PROPERTIES,
  SQL_OCCUPANCY_BY_UNIT,
  SQL_INCOME_BY_CHANNEL,
  SQL_INCOME_BY_OWNER,
  SQL_OPEN_CALENDAR_CONFLICTS,
  SQL_PENDING_TASKS,
  SQL_OWNER_STATEMENTS,
  SQL_CHANNEL_PAYOUTS,
};
