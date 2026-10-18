// Asserts DUROS de la simulacion, evaluados contra las tablas reales del Postgres efimero (no contra lo que el simulador "cree" que
// hizo). Cada uno devuelve ok + detalle con los contraejemplos (maximo 5). Si falla alguno, main.ts sale con codigo distinto de 0.
import type { Client } from "pg";
import type { ResultadoAssert } from "./ledger.ts";

async function contraejemplos(db: Client, sql: string, params: unknown[] = []): Promise<{ n: number; muestra: string }> {
  const { rows } = await db.query(sql, params);
  return { n: rows.length, muestra: JSON.stringify(rows.slice(0, 5)) };
}

function resultado(id: string, descripcion: string, c: { n: number; muestra: string }): ResultadoAssert {
  return { id, descripcion, ok: c.n === 0, detalle: c.n === 0 ? "0 contraejemplos" : `${c.n} contraejemplos: ${c.muestra}` };
}

const ESTADOS_ACTIVOS = `('confirmada','check_in','en_estancia','check_out','cerrada')`;

export async function assertsDeDatos(db: Client, propertyId: string, ultimaNocheCerrada: string | null, barridoSla: Date | null): Promise<ResultadoAssert[]> {
  const out: ResultadoAssert[] = [];

  out.push(
    resultado(
      "cero-sobreventa-inventario",
      "Ninguna noche tiene mas cuartos vendidos (booked_rooms) que el inventario total",
      await contraejemplos(db, `select room_type_id, date, total_rooms, booked_rooms from hoteles.availability where property_id = $1 and booked_rooms > total_rooms`, [propertyId]),
    ),
  );
  out.push(
    resultado(
      "cero-sobreventa-reservas",
      "Las reservas activas, las pre-reservas abiertas (holds) y los cuartos de grupo no liberados (confirmados sin reserva propia incluidos) que cubren cada noche nunca exceden el inventario y coinciden con booked_rooms",
      await contraejemplos(
        db,
        `select a.room_type_id, a.date::text, a.total_rooms, a.booked_rooms, coalesce(r.n, 0) as reservas, coalesce(h.n, 0) as holds, coalesce(g.n, 0) as grupo
           from hoteles.availability a
           left join lateral (select count(*) as n from hoteles.reservation r where r.room_type_id = a.room_type_id and r.status in ${ESTADOS_ACTIVOS} and a.date >= r.check_in_date and a.date < r.check_out_date) r on true
           left join lateral (select coalesce(sum(n.blocked_rooms - n.released_rooms), 0) as n from hoteles.group_block_night n where n.room_type_id = a.room_type_id and n.date = a.date) g on true
           left join lateral (select count(*) as n from hoteles.booking_hold h where h.room_type_id = a.room_type_id and h.status in ('pendiente_aprobacion','pendiente_pago','aprobado') and a.date >= h.check_in_date and a.date < h.check_out_date) h on true
          where a.property_id = $1 and (coalesce(r.n, 0) + coalesce(h.n, 0) + coalesce(g.n, 0) > a.total_rooms or coalesce(r.n, 0) + coalesce(h.n, 0) + coalesce(g.n, 0) <> a.booked_rooms)`,
        [propertyId],
      ),
    ),
  );
  out.push(
    resultado(
      "cero-habitacion-doble",
      "Ninguna habitacion fisica esta asignada a dos reservas activas con fechas traslapadas",
      await contraejemplos(
        db,
        `select r1.id as a, r2.id as b, r1.room_id from hoteles.reservation r1 join hoteles.reservation r2
            on r1.room_id = r2.room_id and r1.id < r2.id
           and r1.status in ${ESTADOS_ACTIVOS} and r2.status in ${ESTADOS_ACTIVOS}
           and r1.check_in_date < r2.check_out_date and r2.check_in_date < r1.check_out_date
          where r1.property_id = $1`,
        [propertyId],
      ),
    ),
  );
  out.push(
    resultado(
      "noche-posteada-una-vez",
      "Cada (folio, noche) tiene a lo mas un cargo de hospedaje vigente",
      await contraejemplos(
        db,
        `select folio_id, stay_date, count(*) from hoteles.charge
          where property_id = $1 and concept = 'hospedaje' and reversed_by is null and reverses_charge_id is null
          group by folio_id, stay_date having count(*) > 1`,
        [propertyId],
      ),
    ),
  );
  if (ultimaNocheCerrada) {
    out.push(
      resultado(
        "noche-posteada-completa",
        `Toda noche en casa hasta ${ultimaNocheCerrada} (cerrada por el night audit) tiene su cargo de hospedaje`,
        await contraejemplos(
          db,
          `select r.id, d::date as noche from hoteles.reservation r, generate_series(r.check_in_date, r.check_out_date - 1, interval '1 day') d
            where r.property_id = $1 and r.status in ('en_estancia','check_out','cerrada') and r.room_id is not null and d::date <= $2::date
              and not exists (select 1 from hoteles.charge c join hoteles.folio f on f.id = c.folio_id
                               where f.reservation_id = r.id and c.concept = 'hospedaje' and c.stay_date = d::date and c.reversed_by is null)`,
          [propertyId, ultimaNocheCerrada],
        ),
      ),
    );
  }
  if (ultimaNocheCerrada) {
    out.push(
      resultado(
        "no-show-procesado",
        `Ninguna reserva confirmada con llegada anterior a ${ultimaNocheCerrada} sigue sin check-in: el night audit ya la paso a no-show`,
        await contraejemplos(db, `select id, check_in_date::text from hoteles.reservation where property_id = $1 and status = 'confirmada' and check_in_date < $2::date`, [propertyId, ultimaNocheCerrada]),
      ),
    );
  }
  out.push(
    resultado(
      "folios-en-cero-al-checkout",
      "Todo folio de una reserva con salida registrada esta cerrado y en saldo cero (o con cuenta por cobrar aprobada)",
      await contraejemplos(
        db,
        `select f.id, f.status, f.close_reason, coalesce(c.total, 0) - coalesce(p.total, 0) as saldo
           from hoteles.folio f join hoteles.reservation r on r.id = f.reservation_id
           left join lateral (select sum(amount + tax_amount) as total from hoteles.charge where folio_id = f.id) c on true
           left join lateral (select sum(amount) as total from hoteles.payment where folio_id = f.id and status = 'capturado') p on true
          where f.property_id = $1 and r.status in ('check_out','cerrada')
            and (f.status <> 'cerrado' or (f.close_reason = 'saldo_cero' and abs(coalesce(c.total, 0) - coalesce(p.total, 0)) > 0.005)
                 or (f.close_reason = 'cuenta_por_cobrar' and f.ar_approved_by is null))`,
        [propertyId],
      ),
    ),
  );
  out.push(
    resultado(
      "alergia-sin-promesa-de-seguridad",
      "Ningun pedido de F&B con alergia declarada tiene una promesa de seguridad al huesped sin confirmacion previa de un cocinero",
      await contraejemplos(db, `select id from hoteles.fnb_order where property_id = $1 and allergy_declared and safety_assurance_sent_at is not null and kitchen_confirmed_by is null`, [propertyId]),
    ),
  );
  out.push(
    resultado(
      "iva-ish-cuadran",
      "El impuesto de cada cargo coincide con IVA 16% (+ ISH 3% solo en noches de hospedaje; las penalizaciones sin noche llevan solo IVA) recalculado de forma independiente",
      await contraejemplos(
        db,
        `select id, concept, amount, tax_amount from hoteles.charge
          where property_id = $1 and concept in ('hospedaje','ab','extras','ajuste','otro','propina') and reverses_charge_id is null and transferred_from_charge_id is null
            and tax_amount <> case concept
                  when 'hospedaje' then round(amount * 0.16, 2) + case when stay_date is null then 0 else round(amount * 0.03, 2) end
                  when 'propina' then 0
                  else round(amount * 0.16, 2) end`,
        [propertyId],
      ),
    ),
  );
  out.push(
    resultado(
      "hospedaje-igual-a-tarifa",
      "El neto de cada noche posteada por el night audit es la tarifa del tipo de habitacion para esa noche",
      await contraejemplos(
        db,
        `select c.id, c.stay_date, c.amount, rp.price from hoteles.charge c
           join hoteles.folio f on f.id = c.folio_id join hoteles.reservation r on r.id = f.reservation_id
           left join hoteles.rate_plan rp on rp.room_type_id = r.room_type_id and rp.date = c.stay_date
          where c.property_id = $1 and c.concept = 'hospedaje' and c.reverses_charge_id is null and c.reversed_by is null
            and c.stay_date is not null and (rp.price is null or c.amount <> rp.price)`,
        [propertyId],
      ),
    ),
  );
  out.push(
    resultado(
      "night-audit-una-corrida-por-noche",
      "Hay exactamente una corrida completada del night audit por cada noche cerrada",
      await contraejemplos(
        db,
        `select business_date, count(*) as corridas, bool_and(status = 'completado') as completas from hoteles.night_audit_run
          where property_id = $1 group by business_date having count(*) <> 1 or not bool_and(status = 'completado')`,
        [propertyId],
      ),
    ),
  );
  if (barridoSla) {
    out.push(
      resultado(
        "sla-vencido-escalado",
        "Todo ticket de huesped abierto o en progreso cuyo SLA ya habia vencido a la hora del ultimo barrido (reloj simulado) fue escalado por el barrido",
        await contraejemplos(db, `select id, status, sla_due_at from hoteles.guest_ticket where property_id = $1 and status in ('abierto','en_progreso') and sla_due_at < $2::timestamptz and escalated_at is null`, [propertyId, barridoSla.toISOString()]),
      ),
    );
  }
  out.push(
    resultado(
      "cfdi-un-vigente-por-folio",
      "Ningun folio tiene mas de un CFDI de hospedaje vigente (no cancelado)",
      await contraejemplos(db, `select folio_id, count(*) from hoteles.cfdi_emision where property_id = $1 and tipo = 'hospedaje' and status <> 'cancelado' group by folio_id having count(*) > 1`, [propertyId]),
    ),
  );
  out.push(
    resultado(
      "cfdi-total-cuadra",
      "En cada CFDI timbrado el total es subtotal + IVA + ISH + DSA y trae UUID fiscal",
      await contraejemplos(db, `select id, subtotal, iva, ish_monto, dsa_monto, total, uuid_fiscal from hoteles.cfdi_emision where property_id = $1 and status in ('timbrado','cancelado') and (abs(total - (subtotal + iva + ish_monto + dsa_monto)) > 0.01 or uuid_fiscal is null)`, [propertyId]),
    ),
  );
  return out;
}
