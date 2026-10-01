// SQL de SOLO LECTURA del catalogo de "Chatea con tus datos" de LICITACIONES. Una constante por
// herramienta, todas parametrizadas ($n, nunca interpolacion). En licitaciones el alcance es la
// ORGANIZACION completa (no hay sucursal/cliente): `$1` organizacion siempre; despues, segun la consulta:
//   $2 zona horaria IANA del negocio · $3 "ahora" (timestamptz) · fechas/ventanas · tope de filas (ultimo).
// La zona y el instante los fija el CODIGO (nunca el modelo); "hoy" y "dias restantes" se calculan en la
// fecha LOCAL del negocio (America/Merida por defecto), no en la del servidor (UTC).
//
// Seguridad (ver docs/DATA-CHAT.md):
//  - Corren con la sesion RLS DEL USUARIO (rol authenticated + auth.uid()): las policies de
//    licitaciones.* usan `licitaciones.can_access_org` (membership real en la organizacion), asi que
//    otra organizacion no aparece aunque el filtro `$1` se omitiera. Defensa en profundidad ademas del
//    `organization_id = $1` que fija el servidor, repetido en cada JOIN (tender/contract/proposal).
//  - Solo campos de negocio (titulo, dependencia, estatus, fechas, montos): nunca documentos, requisitos,
//    secciones de propuesta, datos de la empresa ni contenido de bases.
//  - Montos: `budget_amount` solo se muestra cuando la moneda es MXN; en otra moneda se deja sin monto
//    (no se convierte ni se inventa un tipo de cambio).
//  - tests/data-chat/sql-drift.spec.ts exige que estos textos aparezcan identicos en
//    scripts/verify-data-chat-despachos-licitaciones/assertions.sql (el verify los corre contra Postgres real).

/** Estatus de una convocatoria que todavia puede presentarse (no presentada, ganada, perdida, cancelada ni no-go). */
const ABIERTA = `t.status in ('discovered', 'in_review', 'go', 'in_progress')`;
/** Dia local de un instante en la zona del negocio. */
const DIA_LOCAL = (expr: string): string => `((${expr}) at time zone $2::text)::date`;

// Zona horaria del negocio (RLS: solo la organizacion del usuario). $1 org, $2 tope.
export const SQL_ORG_TIMEZONE = `select c.timezone from licitaciones.tenant_config c where c.organization_id = $1 limit $2`;

// $3 = ahora (timestamptz), $4 = solo las que vencen en <= N dias (int | null = todas), $5 = tope.
export const SQL_CONVOCATORIAS_ABIERTAS = `select t.title as titulo, t.contracting_body as dependencia, t.state as entidad, t.status,
    to_char(t.submission_deadline at time zone $2::text, 'YYYY-MM-DD HH24:MI') as fecha_limite,
    case when t.submission_deadline is null then null
         else ${DIA_LOCAL("t.submission_deadline")} - ${DIA_LOCAL("$3::timestamptz")} end as dias_restantes,
    case when t.currency = 'MXN' then t.budget_amount end as monto_mxn,
    t.currency as moneda
  from licitaciones.tender t
  where t.organization_id = $1 and ${ABIERTA}
    and (t.submission_deadline is null or t.submission_deadline >= $3::timestamptz)
    and ($4::int is null or (t.submission_deadline is not null
         and ${DIA_LOCAL("t.submission_deadline")} - ${DIA_LOCAL("$3::timestamptz")} <= $4::int))
  order by t.submission_deadline asc nulls last, t.title asc
  limit $5`;

// $3 = ahora. Semaforo (dias naturales locales al cierre de la convocatoria): vencida (paso la fecha sin
// presentarla) · rojo (<= 3 dias) · amarillo (<= 7) · verde (> 7) · sin fecha limite registrada.
export const SQL_PLAZOS_SEMAFORO = `select b.semaforo, count(*) as convocatorias
  from (
    select case
        when t.submission_deadline is null then 'Sin fecha límite registrada'
        when t.submission_deadline < $3::timestamptz then 'Vencida sin presentar'
        when ${DIA_LOCAL("t.submission_deadline")} - ${DIA_LOCAL("$3::timestamptz")} <= 3 then 'Rojo (3 días o menos)'
        when ${DIA_LOCAL("t.submission_deadline")} - ${DIA_LOCAL("$3::timestamptz")} <= 7 then 'Amarillo (4 a 7 días)'
        else 'Verde (más de 7 días)'
      end as semaforo,
      case
        when t.submission_deadline is null then 5
        when t.submission_deadline < $3::timestamptz then 0
        when ${DIA_LOCAL("t.submission_deadline")} - ${DIA_LOCAL("$3::timestamptz")} <= 3 then 1
        when ${DIA_LOCAL("t.submission_deadline")} - ${DIA_LOCAL("$3::timestamptz")} <= 7 then 2
        else 3
      end as orden
    from licitaciones.tender t
    where t.organization_id = $1 and ${ABIERTA}
  ) b
  group by b.semaforo, b.orden
  order by b.orden
  limit $4`;

// $3 = desde (inclusive), $4 = hasta (exclusive), $5 = tope. Decisiones go/no-go tomadas en la ventana.
export const SQL_GO_NO_GO = `select t.title as titulo, g.decision, g.match_eligibility_status as elegibilidad, g.match_score as puntaje,
    to_char(g.decided_at at time zone $2::text, 'YYYY-MM-DD') as fecha, g.reasons[1] as motivo
  from licitaciones.go_no_go_decision g
  join licitaciones.tender t on t.id = g.tender_id and t.organization_id = g.organization_id
  where g.organization_id = $1 and g.decided_at >= $3::timestamptz and g.decided_at < $4::timestamptz
  order by g.decided_at desc
  limit $5`;

// $2 = tope. Propuestas por estatus de su convocatoria; "presentadas" = ya tienen declaracion de presentacion.
export const SQL_PROPUESTAS_POR_ESTADO = `select t.status, count(*) as propuestas,
    count(*) filter (where exists (
      select 1 from licitaciones.submission s where s.proposal_id = p.id and s.organization_id = p.organization_id
    )) as presentadas
  from licitaciones.proposal p
  join licitaciones.tender t on t.id = p.tender_id and t.organization_id = p.organization_id
  where p.organization_id = $1
  group by t.status
  order by propuestas desc, t.status asc
  limit $2`;

// $3 = desde, $4 = hasta (exclusive), $5 = tope. Fallos registrados (ganada/perdida) en la ventana.
export const SQL_FALLOS = `select t.title as titulo, t.contracting_body as dependencia, r.resolution as resultado,
    to_char(r.resolved_at at time zone $2::text, 'YYYY-MM-DD') as fecha,
    case when t.currency = 'MXN' then t.budget_amount end as monto_mxn
  from licitaciones.tender_resolution r
  join licitaciones.tender t on t.id = r.tender_id and t.organization_id = r.organization_id
  where r.organization_id = $1 and r.resolved_at >= $3::timestamptz and r.resolved_at < $4::timestamptz
  order by r.resolved_at desc
  limit $5`;

// $3 = ahora, $4 = horizonte en dias, $5 = tope. Contratos con vigencia que termina dentro del horizonte
// (no cerrados ni rescindidos), con su opcion de renovacion y si tienen una alerta del radar pendiente.
export const SQL_RENOVACIONES = `select c.contract_number as contrato, t.title as titulo, t.contracting_body as dependencia,
    to_char(c.end_date, 'YYYY-MM-DD') as fin_vigencia,
    c.end_date - ${DIA_LOCAL("$3::timestamptz")} as dias_restantes,
    c.has_renewal_option as opcion_renovacion, c.status,
    exists (
      select 1 from licitaciones.renewal_alert a
      where a.contract_id = c.id and a.organization_id = c.organization_id and a.status = 'pendiente'
    ) as alerta_pendiente
  from licitaciones.contract c
  join licitaciones.tender t on t.id = c.tender_id and t.organization_id = c.organization_id
  where c.organization_id = $1 and c.end_date is not null
    and c.status not in ('cerrado', 'rescindido')
    and c.end_date >= ${DIA_LOCAL("$3::timestamptz")}
    and c.end_date - ${DIA_LOCAL("$3::timestamptz")} <= $4::int
  order by c.end_date asc, t.title asc
  limit $5`;

export const ALL_DATA_CHAT_SQL: Readonly<Record<string, string>> = {
  SQL_ORG_TIMEZONE,
  SQL_CONVOCATORIAS_ABIERTAS,
  SQL_PLAZOS_SEMAFORO,
  SQL_GO_NO_GO,
  SQL_PROPUESTAS_POR_ESTADO,
  SQL_FALLOS,
  SQL_RENOVACIONES,
};
