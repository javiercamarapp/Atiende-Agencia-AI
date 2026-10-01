// SQL de SOLO LECTURA del catalogo de "Chatea con tus datos" de DESPACHOS. Una constante por herramienta,
// todas parametrizadas ($n, nunca interpolacion). En despachos un CLIENTE (contribuyente) es una
// `core.property`; el alcance siempre es:
//   $1 organizacion · $2 clientes permitidos (uuid[] | null = todos los de la organizacion)
// y despues, segun la consulta: fechas locales (date, ya resueltas en la zona del negocio por el codigo,
// nunca por el modelo) y el tope de filas (ultimo parametro).
//
// Seguridad (ver docs/DATA-CHAT.md):
//  - Corren con la sesion RLS DEL USUARIO (rol authenticated + auth.uid()): las policies de
//    despachos.* usan `core.has_property_access`, asi que un cliente fuera de la membership no aparece
//    aunque el filtro `$2` se omitiera -- defensa en profundidad ademas del filtro que fija el servidor.
//  - Todas filtran por organizacion ($1) y exigen que la property sea de la vertical despachos (`p.vertical`).
//  - Solo agregados o campos de negocio (nombre del cliente = nombre de la property): nunca correos,
//    telefonos ni contenido de CFDI mas alla del RFC/nombre publico del emisor de la lista 69-B.
//  - Las cifras de cartera usan `despachos.invoice.total` (el modelo no guarda saldos parciales: un
//    `receivable` sin `pagado_en` esta pendiente por el total del CFDI).
//  - tests/data-chat/sql-drift.spec.ts exige que estos textos aparezcan identicos en
//    scripts/verify-data-chat-despachos-licitaciones/assertions.sql (el verify los corre contra Postgres real).

const SCOPE_PROPERTY = (alias: string): string => `${alias}.organization_id = $1 and p.vertical = 'despachos'
    and ($2::uuid[] is null or ${alias}.property_id = any($2::uuid[]))`;

// Clientes visibles (para resolver el nombre que pide el usuario y para el contexto del prompt).
export const SQL_VISIBLE_CLIENTS = `select p.id as property_id, p.name
   from core.property p
   where p.organization_id = $1 and p.vertical = 'despachos' and p.status = 'active' and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 200`;

// $3 = hoy (fecha local del negocio), $4 = tope de filas.
export const SQL_CARTERA_POR_CLIENTE = `select p.name as cliente,
    count(*) as cuentas_pendientes,
    coalesce(sum(i.total), 0) as monto_pendiente,
    count(*) filter (where r.fecha_vencimiento < $3::date) as cuentas_vencidas,
    coalesce(sum(i.total) filter (where r.fecha_vencimiento < $3::date), 0) as monto_vencido
  from despachos.receivable r
  join despachos.invoice i on i.id = r.invoice_id
  join core.property p on p.id = r.property_id
  where ${SCOPE_PROPERTY("r")} and r.pagado_en is null
  group by p.id, p.name
  order by monto_pendiente desc, p.name
  limit $4`;

// $3 = hoy. La antiguedad se mide en dias naturales vencidos al dia de hoy del negocio.
export const SQL_COBRANZA_ANTIGUEDAD = `select b.bucket, count(*) as cuentas, coalesce(sum(b.total), 0) as monto
  from (
    select case
        when r.fecha_vencimiento >= $3::date then 'Vigente (aún no vence)'
        when $3::date - r.fecha_vencimiento <= 30 then '1 a 30 días vencida'
        when $3::date - r.fecha_vencimiento <= 60 then '31 a 60 días vencida'
        when $3::date - r.fecha_vencimiento <= 90 then '61 a 90 días vencida'
        else 'Más de 90 días vencida'
      end as bucket,
      case
        when r.fecha_vencimiento >= $3::date then 0
        when $3::date - r.fecha_vencimiento <= 30 then 1
        when $3::date - r.fecha_vencimiento <= 60 then 2
        when $3::date - r.fecha_vencimiento <= 90 then 3
        else 4
      end as orden,
      i.total
    from despachos.receivable r
    join despachos.invoice i on i.id = r.invoice_id
    join core.property p on p.id = r.property_id
    where ${SCOPE_PROPERTY("r")} and r.pagado_en is null
  ) b
  group by b.bucket, b.orden
  order by b.orden`;

// $3 = desde (inclusive), $4 = hasta (inclusive), $5 = tope. `invoice.fecha` es la fecha del CFDI.
export const SQL_CFDI_POR_PERIODO = `select i.tipo, count(*) as cfdi, coalesce(sum(i.total), 0) as total,
    count(*) filter (where not i.valido) as invalidos,
    count(*) filter (where i.requires_human_review) as en_revision
  from despachos.invoice i
  join core.property p on p.id = i.property_id
  where ${SCOPE_PROPERTY("i")} and i.fecha >= $3::date and i.fecha <= $4::date
  group by i.tipo
  order by i.tipo
  limit $5`;

// $3 = desde, $4 = hasta, $5 = tope. Misma convencion que la DIOT / el reporte de impuestos del repo:
// IVA de los CFDI tipo Ingreso ("I") VALIDOS ingeridos, tratado como acreditable.
export const SQL_IVA_ACREDITABLE = `select p.name as cliente, count(*) as cfdi,
    coalesce(sum(i.subtotal), 0) as base, coalesce(sum(i.iva), 0) as iva_acreditable
  from despachos.invoice i
  join core.property p on p.id = i.property_id
  where ${SCOPE_PROPERTY("i")} and i.fecha >= $3::date and i.fecha <= $4::date
    and i.tipo = 'I' and i.valido
  group by p.id, p.name
  order by iva_acreditable desc, p.name
  limit $5`;

// $3 = desde, $4 = hasta (por fecha limite), $5 = hoy, $6 = tope. Un vencimiento no completado cuya
// fecha limite ya paso se reporta "vencido" aunque el estado guardado siga "pendiente".
export const SQL_OBLIGACIONES_FISCALES = `select p.name as cliente, d.tipo, d.periodo,
    to_char(d.fecha_limite, 'YYYY-MM-DD') as fecha_limite,
    case when d.estado = 'completado' then 'completado'
         when d.fecha_limite < $5::date then 'vencido'
         else d.estado end as estado,
    d.prioridad
  from despachos.fiscal_deadline d
  join core.property p on p.id = d.property_id
  where ${SCOPE_PROPERTY("d")} and d.fecha_limite >= $3::date and d.fecha_limite <= $4::date
  order by d.fecha_limite asc, p.name, d.tipo
  limit $6`;

// $3 = hoy, $4 = tope. Periodos de cierre mensual sin cerrar con el avance de su checklist.
export const SQL_CIERRES_PENDIENTES = `select p.name as cliente, c.anio, c.mes, c.status,
    count(t.id) as tareas_total,
    count(t.id) filter (where t.status in ('pending', 'in_progress', 'blocked')) as tareas_pendientes,
    count(t.id) filter (where t.status in ('pending', 'in_progress', 'blocked') and t.due_date < $3::date) as tareas_vencidas
  from despachos.periodo_cierre c
  join core.property p on p.id = c.property_id
  left join despachos.periodo_cierre_tarea t on t.periodo_cierre_id = c.id
  where ${SCOPE_PROPERTY("c")} and c.status <> 'closed'
  group by c.id, p.name, c.anio, c.mes, c.status
  order by c.anio asc, c.mes asc, p.name
  limit $4`;

// $3 = hoy, $4 = tope. Carga de trabajo POR CLIENTE: el modelo no guarda responsable (contador) por
// revision/tarea/vencimiento, asi que no existe una carga por persona.
export const SQL_CARGA_DE_TRABAJO = `select p.name as cliente,
    (select count(*) from despachos.invoice_review rv where rv.property_id = p.id and rv.status = 'pendiente') as revisiones_pendientes,
    (select count(*) from despachos.fiscal_deadline d where d.property_id = p.id and d.estado <> 'completado') as vencimientos_abiertos,
    (select count(*) from despachos.fiscal_deadline d where d.property_id = p.id and d.estado <> 'completado' and d.fecha_limite < $3::date) as vencimientos_vencidos,
    (select count(*) from despachos.periodo_cierre_tarea t join despachos.periodo_cierre c on c.id = t.periodo_cierre_id
       where c.property_id = p.id and c.status <> 'closed' and t.status in ('pending', 'in_progress', 'blocked')) as tareas_cierre_pendientes
  from core.property p
  where p.organization_id = $1 and p.vertical = 'despachos' and p.status = 'active' and ($2::uuid[] is null or p.id = any($2::uuid[]))
  order by vencimientos_vencidos desc, revisiones_pendientes desc, p.name
  limit $4`;

// Lista 69-B del SAT (EFOS): las tablas efos_* NO son legibles por `authenticated`; la unica via es la
// funcion security definer de la migracion 014 (exige auth.uid() + has_property_access de ESA property).
// $1 = property (cliente).
export const SQL_EFOS_AFECTADOS = `select out_rfc_emisor, out_emisor_nombre, out_fecha, out_total, out_situacion, out_periodo_lista
  from despachos.efos_invoices_afectados($1::uuid)`;

export const SQL_EFOS_ESTADO = `select out_periodo from despachos.efos_estado()`;

export const ALL_DATA_CHAT_SQL: Readonly<Record<string, string>> = {
  SQL_VISIBLE_CLIENTS,
  SQL_CARTERA_POR_CLIENTE,
  SQL_COBRANZA_ANTIGUEDAD,
  SQL_CFDI_POR_PERIODO,
  SQL_IVA_ACREDITABLE,
  SQL_OBLIGACIONES_FISCALES,
  SQL_CIERRES_PENDIENTES,
  SQL_CARGA_DE_TRABAJO,
  SQL_EFOS_AFECTADOS,
  SQL_EFOS_ESTADO,
};
