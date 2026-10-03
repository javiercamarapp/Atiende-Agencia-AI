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

export async function assertsDeDatos(db: Client, propertyId: string, ultimaNocheCerrada: string | null): Promise<ResultadoAssert[]> {
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
      "Las reservas activas que cubren cada noche nunca exceden el inventario y coinciden con booked_rooms",
      await contraejemplos(
        db,
        `select a.room_type_id, a.date, a.total_rooms, a.booked_rooms, count(r.id) as reservas
           from hoteles.availability a
           left join hoteles.reservation r on r.room_type_id = a.room_type_id and r.status in ${ESTADOS_ACTIVOS} and a.date >= r.check_in_date and a.date < r.check_out_date
          where a.property_id = $1
          group by a.room_type_id, a.date, a.total_rooms, a.booked_rooms
         having count(r.id) > a.total_rooms or count(r.id) <> a.booked_rooms`,
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
      "iva-ish-cuadran",
      "El impuesto de cada cargo coincide con IVA 16% (+ ISH 3% solo en hospedaje) recalculado de forma independiente",
      await contraejemplos(
        db,
        `select id, concept, amount, tax_amount from hoteles.charge
          where property_id = $1 and concept in ('hospedaje','ab','extras','ajuste','otro','propina') and reverses_charge_id is null and transferred_from_charge_id is null
            and tax_amount <> case concept
                  when 'hospedaje' then round(amount * 0.16, 2) + round(amount * 0.03, 2)
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
            and (rp.price is null or c.amount <> rp.price)`,
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
  return out;
}
