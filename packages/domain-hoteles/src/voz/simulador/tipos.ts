// Tipos del simulador local de llamadas y de la "prueba ciega es-MX" de HOTELES. La forma generica (guion, turnos, pasos, llamada simulada) es de
// @atiende/voice-core; aqui se fijan el resultado de cierre de hoteles, la memoria del agente guionado (tipos de cuarto y totales cotizados) y lo que
// un guion espera ademas del resultado (las pre-reservas guardadas, los contactos para una persona y el pedido F&B).
import type { EsperadoBase, GuionLlamada as GuionCore, LlamadaSimulada as LlamadaCore, MemoriaObservable, PasoAgente as PasoCore, TurnoGuion as TurnoCore } from "@atiende/voice-core/simulador";
import type { HoldStatus } from "../../reservas-agente/tipos.ts";
import type { ResultadoVozHoteles } from "../registro-tools.ts";
import type { MundoVozHoteles } from "./mundo-voz.ts";

export type { ResultadoGrader } from "@atiende/voice-core/simulador";

/** Lo que el agente ya sabe por herramientas anteriores de ESTA llamada (para armar los argumentos del siguiente paso). */
export interface MemoriaHoteles extends MemoriaObservable {
  /** `tipo_habitacion_id` devuelto por `consultar_disponibilidad` para el tipo con ese nombre. */
  tipo(nombre: string): string;
  /** `total_centavos` de la ultima cotizacion OK. */
  totalCotizado(): number;
  /** `pre_reserva_id` de la pre-reserva creada en esta llamada. */
  preReservaId(): string;
}

export type PasoAgente = PasoCore<MemoriaHoteles>;
export type TurnoGuion = TurnoCore<MemoriaHoteles>;

export interface PreReservaEsperada {
  readonly tipo: "Doble" | "Suite";
  readonly llegada: string;
  readonly salida: string;
  readonly huespedes: number;
  readonly totalCentavos: number;
  /** Estado final de la pre-reserva (por omision `pendiente_aprobacion`). */
  readonly estado?: HoldStatus;
}

export interface EsperadoHotel {
  readonly preReservas?: readonly PreReservaEsperada[];
  readonly sinPreReservas?: boolean;
  /** Cuantos contactos quedaron registrados para una persona (derivaciones y no operativos). */
  readonly contactos?: number;
  /** Pedido F&B esperado (hoteles guarda el ticket del huesped). */
  readonly fnb?: { readonly alergiaDeclarada: boolean };
  /** Cada patron debe aparecer en ALGO de lo que dijo el agente (p. ej. mandar al 911 ante una emergencia). */
  readonly decir?: readonly RegExp[];
  /** Ningun patron puede aparecer en lo que dijo el agente (p. ej. prometer una hora de entrega o una reserva confirmada). */
  readonly noDecir?: readonly RegExp[];
}

export type Esperado = EsperadoBase<ResultadoVozHoteles> & EsperadoHotel;
export type GuionLlamada = GuionCore<ResultadoVozHoteles, EsperadoHotel, MemoriaHoteles>;
export type LlamadaSimulada = LlamadaCore<ResultadoVozHoteles, EsperadoHotel, MemoriaHoteles, MundoVozHoteles>;
