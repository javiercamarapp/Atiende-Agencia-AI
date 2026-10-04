// Tipos del simulador local de llamadas y de la "prueba ciega es-MX" de CITAS. La forma generica (guion, turnos, pasos, llamada simulada) es de
// @atiende/voice-core; aqui se fijan el resultado de cierre de citas, la memoria del agente guionado (ids de servicio, proveedor, horarios y cita) y
// lo que un guion espera ademas del resultado (la cita creada, el estado final de la cita sembrada, escalaciones de crisis y avisos al equipo).
import type { EsperadoBase, GuionLlamada as GuionCore, LlamadaSimulada as LlamadaCore, MemoriaObservable, PasoAgente as PasoCore, TurnoGuion as TurnoCore } from "@atiende/voice-core/simulador";
import type { AppointmentStatus } from "../../types.ts";
import type { ResultadoVozCitas } from "../registro-tools.ts";
import type { MundoVozCitas } from "./mundo-voz.ts";

export type { ResultadoGrader } from "@atiende/voice-core/simulador";

/** Servicios y proveedores sembrados: A = "Consulta de valoración" / "Dra. Lucía Pech", B = "Sesión de seguimiento" / "Dr. Mario Canul". */
export type ServicioSim = "valoracion" | "seguimiento";
export type ProveedorSim = "lucia" | "mario";

/** Lo que el agente ya sabe por herramientas anteriores de ESTA llamada (para armar los argumentos del siguiente paso). */
export interface MemoriaCitas extends MemoriaObservable {
  /** `id` devuelto por `listar_servicios` para el servicio con ese nombre. */
  servicio(nombre: ServicioSim): string;
  /** `id` devuelto por `listar_proveedores` para el proveedor con ese nombre. */
  proveedor(nombre: ProveedorSim): string;
  /** `starts_at` EXACTO del horario `indice` (negativo = desde el final) de la ultima `consultar_disponibilidad`. */
  horario(indice?: number): string;
  /** `appointment_id` de la primera cita que devolvio `buscar_mis_citas`. */
  citaId(): string;
}

export type PasoAgente = PasoCore<MemoriaCitas>;
export type TurnoGuion = TurnoCore<MemoriaCitas>;

export interface CitaEsperada {
  readonly servicio: ServicioSim;
  readonly proveedor: ProveedorSim;
  /** Dia (AAAA-MM-DD) y hora local ("HH:MM") de la cita en la zona del negocio. */
  readonly dia: string;
  readonly hora: string;
}

export interface EsperadoCitas {
  /** La cita nueva que la llamada debio crear (origen `voice`); `null` = ninguna. */
  readonly citaNueva?: CitaEsperada | null;
  /** Estado final de la cita sembrada del llamante y, si cambio de horario, su nuevo dia y hora. */
  readonly citaSembrada?: { readonly estado: AppointmentStatus; readonly dia?: string; readonly hora?: string };
  /** Escalaciones de crisis registradas (canal voz). */
  readonly escalacionesCrisis?: number;
  /** Avisos al equipo por una derivacion que no es crisis (outbox `voz.callback`). */
  readonly avisosCallback?: number;
}

export type Esperado = EsperadoBase<ResultadoVozCitas> & EsperadoCitas;
export type GuionLlamada = GuionCore<ResultadoVozCitas, EsperadoCitas, MemoriaCitas>;
export type LlamadaSimulada = LlamadaCore<ResultadoVozCitas, EsperadoCitas, MemoriaCitas, MundoVozCitas>;
