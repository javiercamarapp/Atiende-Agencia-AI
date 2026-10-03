// Mundo del simulador de llamadas de HOTELES: un hotel sembrado en los repositorios en memoria, con el MOTOR REAL de reservas (`executeReservasTool`:
// disponibilidad, cotizacion con guardia de precio, pre-reserva). Datos de prueba (tipos, tarifas, fechas inventados para el arnes); no se usan en
// ningun entorno real. El reloj es fijo (2031-06-01) para que las fechas de los guiones sean estables.
import { randomUUID } from "node:crypto";
import { InMemoryHotelesRepository } from "../../in-memory-repository.ts";
import { InMemoryReservasAgenteRepository } from "../../reservas-agente/in-memory-repository.ts";
import type { HoldRecord } from "../../reservas-agente/tipos.ts";
import type { ContactoNoOperativoRecord, NewContactoNoOperativoInput } from "../../types.ts";

export const AHORA_SIM = new Date("2031-06-01T18:00:00Z");
export const HOY_SIM = "2031-06-01";
export const TELEFONO_LLAMANTE = "+5219991230000";
export const SIP_FROM_LLAMANTE = `"Huesped" <sip:${TELEFONO_LLAMANTE}@trunk.sim.invalid;user=phone>;tag=sim`;
export const NOMBRE_HOTEL_SIM = "Hotel Casa Maya";
/** Total que cotiza la base para 2 noches de Doble: 2 x 1,500.00 + IVA 16 % + ISH 3 %. */
export const TOTAL_DOBLE_2_NOCHES = 357_000;

export interface MundoVozHoteles {
  readonly hoteles: InMemoryHotelesRepository;
  readonly reservas: InMemoryReservasAgenteRepository;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly doble: string;
  readonly suite: string;
  /** Contactos que quedaron registrados para una persona (derivaciones y no operativos), en orden. */
  readonly contactos: NewContactoNoOperativoInput[];
  holds(): Promise<readonly HoldRecord[]>;
}

export function crearMundoVozHoteles(opts: { readonly holdsActivos?: boolean } = {}): MundoVozHoteles {
  const hoteles = new InMemoryHotelesRepository();
  const reservas = new InMemoryReservasAgenteRepository();
  reservas.clock = () => AHORA_SIM;
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const doble = randomUUID();
  const suite = randomUUID();
  reservas.seedProperty(propertyId, { organizationId });
  reservas.seedRoomType(propertyId, doble, "Doble", 2);
  reservas.seedRoomType(propertyId, suite, "Suite", 4);
  reservas.seedInventory(propertyId, doble, "2031-06-01", "2031-07-15", 2, 150_000);
  // Sin cupo esas noches: la prueba "sin disponibilidad" ocupa la suite entera.
  reservas.seedInventory(propertyId, suite, "2031-06-01", "2031-07-15", 1, 500_000);
  // La tarifa publicada de la suite queda FUERA del techo de la regla de precio: el agente no la puede cotizar, una persona debe.
  reservas.setPriceGuard(propertyId, suite, 100_000, 300_000);
  void hoteles.upsertPropertyTimezone(propertyId, organizationId, "America/Mexico_City", randomUUID());
  if (opts.holdsActivos !== false) reservas.setPolicy(propertyId, { holdsEnabled: true, mode: "aprobacion_humana" });

  const contactos: NewContactoNoOperativoInput[] = [];
  const original = hoteles.insertContactoNoOperativo.bind(hoteles);
  hoteles.insertContactoNoOperativo = async (input: NewContactoNoOperativoInput): Promise<ContactoNoOperativoRecord> => {
    contactos.push(input);
    return original(input);
  };

  return {
    hoteles,
    reservas,
    organizationId,
    propertyId,
    doble,
    suite,
    contactos,
    async holds() {
      // La lectura de holds es de staff (RLS); el arnes la hace como un owner y restaura el actor de sistema del agente.
      const previo = reservas.actor;
      reservas.actor = { userId: "staff-sim", role: "owner" };
      try {
        return (await reservas.listHolds(propertyId, {})).holds;
      } finally {
        reservas.actor = previo;
      }
    },
  };
}
