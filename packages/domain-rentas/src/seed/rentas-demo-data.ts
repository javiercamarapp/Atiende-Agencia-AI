// Datos FICTICIOS de la cuenta demo de rentas (Rn-33). Todo es inventado para demos, pruebas y el recorrido E2E: nombres de
// personas con el apellido "Demo", correos @example.test, contactos con la lada "00" (inexistente en Mexico). Las fechas son
// OFFSETS en dias respecto de HOY (en la zona horaria de cada propiedad): negativo = pasado, 0 = hoy, positivo = futuro. Las reservas
// importadas NO se declaran aqui: salen de los .ics de scripts/seed-rentas-demo/fixtures (ver `fixturesIcs`), parseados con el
// parser REAL del dominio; sus fechas se miden contra `ANCLA_FIXTURES_ICS` (el dia 0 de esos archivos).

/** Fecha que los .ics de los fixtures usan como "hoy" (dia 0). Un evento del .ics en ANCLA + n queda a n dias de hoy. */
export const ANCLA_FIXTURES_ICS = "2026-01-05";

/** Slug de la cuenta demo. El prefijo `demo-` es el marcador: la consola de superadmin cuenta como demo toda organizacion con slug `demo-%`. */
export const SLUG_DEMO_RENTAS = "demo-rentas-gestora";
export const NOMBRE_DEMO_RENTAS = "Gestora Demo Rentas (demo)";

export type CanalSeed = "airbnb" | "vrbo" | "booking" | "manual";

export interface PropietarioSeed {
  readonly clave: string;
  readonly nombre: string;
  readonly email: string;
}

export interface UnidadSeed {
  readonly nombre: string;
  readonly propietario: string;
  readonly duracionMinimaNoches: number;
  /** Tarifa base por noche en centavos (MXN). */
  readonly tarifaBaseCentavos: number;
  readonly temporada?: { readonly nombre: string; readonly desde: number; readonly hasta: number; readonly precioCentavos: number };
}

export interface PropiedadSeed {
  readonly nombre: string;
  readonly zonaHoraria: string;
  readonly unidades: readonly UnidadSeed[];
  /** Politica de liberacion de acceso al huesped activa (checklist: "politica de acceso"). */
  readonly accesoActivo: boolean;
}

export interface FeedSeed {
  readonly propiedad: string;
  readonly unidad: string;
  readonly canal: Exclude<CanalSeed, "manual">;
  /** Nombre del .ics en scripts/seed-rentas-demo/fixtures de donde salen las reservas importadas de este feed. */
  readonly fixture: string;
  readonly estado: "ok" | "cuarentena";
}

export interface ReservaDirectaSeed {
  readonly clave: string;
  readonly propiedad: string;
  readonly unidad: string;
  readonly desde: number;
  readonly noches: number;
  readonly huesped: string;
  /** Con movimiento financiero: solo reservas ya terminadas. */
  readonly conFinanciero: boolean;
  readonly gastoLimpiezaCentavos?: number;
}

export interface BloqueoSeed {
  readonly clave: string;
  readonly propiedad: string;
  readonly unidad: string;
  readonly razon: "MANTENIMIENTO" | "BLOQUEO_PROPIETARIO";
  readonly desde: number;
  readonly noches: number;
}

export interface TareaSeed {
  readonly propiedad: string;
  readonly unidad: string;
  readonly tipo: "limpieza" | "mantenimiento" | "inspeccion";
  readonly estado: "pendiente" | "asignada" | "en_progreso" | "completada";
  readonly prioridad: "baja" | "media" | "alta" | "urgente";
  readonly programadaPara: number;
  /** Horas respecto de AHORA en que vence el SLA (negativo = ya vencida). */
  readonly slaHoras: number | null;
  /** Clave de la reserva cuyo check-out origino la tarea (limpieza de salida). */
  readonly deReserva: string | null;
  readonly asignadaAlOwner: boolean;
  readonly checklist: readonly string[];
}

export interface IncidenciaSeed {
  readonly propiedad: string;
  readonly unidad: string;
  readonly severidad: "leve" | "moderada" | "grave";
  readonly titulo: string;
  readonly descripcion: string;
}

export interface PlantillaSeed {
  readonly evento: "confirmacion" | "pre_llegada" | "check_in" | "check_out" | "resena";
  readonly cuerpo: string;
  readonly aprobada: boolean;
}

export interface ConversacionSeed {
  readonly propiedad: string;
  readonly unidad: string;
  readonly canal: Exclude<CanalSeed, "manual">;
  /** Clave de la reserva a la que pertenece (externalId del .ics o clave directa). */
  readonly reserva: string;
  readonly huesped: string;
  readonly mensajeEntrante: string;
  readonly borradorPendiente: string;
}

export interface ReglaComisionSeed {
  readonly canal: CanalSeed;
  readonly yaNetoDeComision: boolean;
  readonly comisionBasisPoints: number;
}

export interface DatosRentasDemo {
  readonly propietarios: readonly PropietarioSeed[];
  readonly propiedades: readonly PropiedadSeed[];
  readonly feeds: readonly FeedSeed[];
  readonly reservasDirectas: readonly ReservaDirectaSeed[];
  readonly bloqueos: readonly BloqueoSeed[];
  /** Conflicto abierto: la reserva `reserva` (clave directa o UID del .ics) cruza con el bloqueo `bloqueo`. */
  readonly conflictoAbierto: { readonly propiedad: string; readonly unidad: string; readonly reserva: string; readonly bloqueo: string };
  readonly tareas: readonly TareaSeed[];
  readonly incidencias: readonly IncidenciaSeed[];
  readonly plantillas: readonly PlantillaSeed[];
  readonly conversaciones: readonly ConversacionSeed[];
  readonly reglasComision: readonly ReglaComisionSeed[];
  /** Comision del gestor (basis points sobre el neto de canal) de los movimientos financieros demo. */
  readonly comisionGestorBasisPoints: number;
}

const CASA = "Casa del Mar (demo)";
const LOFT = "Loft Centro (demo)";
const VILLA = "Villa Los Pinos (demo)";

export const DATOS_RENTAS_DEMO: DatosRentasDemo = {
  propietarios: [
    { clave: "ana", nombre: "Ana Demo Propietaria", email: "ana.propietaria@example.test" },
    { clave: "beto", nombre: "Beto Demo Propietario", email: "beto.propietario@example.test" },
    { clave: "carla", nombre: "Carla Demo Propietaria", email: "carla.propietaria@example.test" },
  ],
  propiedades: [
    {
      nombre: CASA,
      zonaHoraria: "America/Cancun",
      accesoActivo: true,
      unidades: [
        { nombre: "Depto 1", propietario: "ana", duracionMinimaNoches: 2, tarifaBaseCentavos: 180000, temporada: { nombre: "Temporada alta demo", desde: 20, hasta: 40, precioCentavos: 240000 } },
        { nombre: "Depto 2", propietario: "ana", duracionMinimaNoches: 2, tarifaBaseCentavos: 165000 },
      ],
    },
    { nombre: LOFT, zonaHoraria: "America/Mexico_City", accesoActivo: false, unidades: [{ nombre: "Loft A", propietario: "beto", duracionMinimaNoches: 1, tarifaBaseCentavos: 120000 }] },
    {
      nombre: VILLA,
      zonaHoraria: "America/Merida",
      accesoActivo: false,
      unidades: [
        { nombre: "Villa", propietario: "carla", duracionMinimaNoches: 3, tarifaBaseCentavos: 350000 },
        { nombre: "Cabaña", propietario: "carla", duracionMinimaNoches: 2, tarifaBaseCentavos: 140000 },
      ],
    },
  ],
  feeds: [
    { propiedad: CASA, unidad: "Depto 1", canal: "airbnb", fixture: "airbnb-casa-del-mar-depto-1.ics", estado: "ok" },
    { propiedad: CASA, unidad: "Depto 1", canal: "booking", fixture: "booking-casa-del-mar-depto-1.ics", estado: "ok" },
    { propiedad: LOFT, unidad: "Loft A", canal: "vrbo", fixture: "vrbo-loft-centro-loft-a.ics", estado: "cuarentena" },
  ],
  reservasDirectas: [
    { clave: "d1", propiedad: CASA, unidad: "Depto 1", desde: -30, noches: 5, huesped: "Diego Demo", conFinanciero: true, gastoLimpiezaCentavos: 45000 },
    { clave: "d2", propiedad: CASA, unidad: "Depto 1", desde: 4, noches: 3, huesped: "Elena Demo", conFinanciero: false },
    { clave: "d3", propiedad: CASA, unidad: "Depto 2", desde: -7, noches: 3, huesped: "Fabian Demo", conFinanciero: true, gastoLimpiezaCentavos: 45000 },
    { clave: "d4", propiedad: CASA, unidad: "Depto 2", desde: 2, noches: 4, huesped: "Gabriela Demo", conFinanciero: false },
    { clave: "d5", propiedad: CASA, unidad: "Depto 2", desde: 10, noches: 3, huesped: "Hugo Demo", conFinanciero: false },
    { clave: "d6", propiedad: CASA, unidad: "Depto 2", desde: -20, noches: 3, huesped: "Irene Demo", conFinanciero: true },
    { clave: "d7", propiedad: LOFT, unidad: "Loft A", desde: 8, noches: 2, huesped: "Jorge Demo", conFinanciero: false },
    { clave: "d8", propiedad: LOFT, unidad: "Loft A", desde: -12, noches: 3, huesped: "Karla Demo", conFinanciero: true, gastoLimpiezaCentavos: 35000 },
    { clave: "d9", propiedad: VILLA, unidad: "Villa", desde: -9, noches: 5, huesped: "Luis Demo", conFinanciero: true, gastoLimpiezaCentavos: 80000 },
    { clave: "d10", propiedad: VILLA, unidad: "Villa", desde: 1, noches: 4, huesped: "Marta Demo", conFinanciero: false },
    { clave: "d11", propiedad: VILLA, unidad: "Villa", desde: 15, noches: 5, huesped: "Nico Demo", conFinanciero: false },
    { clave: "d12", propiedad: VILLA, unidad: "Cabaña", desde: -6, noches: 4, huesped: "Olga Demo", conFinanciero: true, gastoLimpiezaCentavos: 30000 },
    { clave: "d13", propiedad: VILLA, unidad: "Cabaña", desde: 6, noches: 2, huesped: "Pablo Demo", conFinanciero: false },
  ],
  bloqueos: [{ clave: "b1", propiedad: CASA, unidad: "Depto 1", razon: "MANTENIMIENTO", desde: 10, noches: 1 }],
  // La reserva de Airbnb demo-abnb-0003 ocupa [9, 12) en Depto 1; el mantenimiento [10, 11) la cruza.
  conflictoAbierto: { propiedad: CASA, unidad: "Depto 1", reserva: "demo-abnb-0003@airbnb.example", bloqueo: "b1" },
  tareas: [
    { propiedad: CASA, unidad: "Depto 1", tipo: "limpieza", estado: "completada", prioridad: "media", programadaPara: -11, slaHoras: null, deReserva: "demo-abnb-0001@airbnb.example", asignadaAlOwner: true, checklist: ["Cambiar sábanas", "Limpiar baños", "Reponer amenidades"] },
    { propiedad: CASA, unidad: "Depto 1", tipo: "limpieza", estado: "pendiente", prioridad: "alta", programadaPara: 0, slaHoras: -3, deReserva: "demo-abnb-0002@airbnb.example", asignadaAlOwner: false, checklist: ["Cambiar sábanas", "Limpiar baños", "Reponer amenidades"] },
    { propiedad: CASA, unidad: "Depto 2", tipo: "limpieza", estado: "asignada", prioridad: "media", programadaPara: 1, slaHoras: 20, deReserva: null, asignadaAlOwner: true, checklist: ["Cambiar sábanas", "Limpiar cocina"] },
    { propiedad: LOFT, unidad: "Loft A", tipo: "inspeccion", estado: "en_progreso", prioridad: "baja", programadaPara: 0, slaHoras: 30, deReserva: null, asignadaAlOwner: true, checklist: ["Revisar aire acondicionado", "Revisar cerradura"] },
    { propiedad: VILLA, unidad: "Villa", tipo: "mantenimiento", estado: "pendiente", prioridad: "media", programadaPara: 3, slaHoras: 72, deReserva: null, asignadaAlOwner: false, checklist: ["Revisar bomba de la alberca"] },
  ],
  incidencias: [{ propiedad: VILLA, unidad: "Villa", severidad: "moderada", titulo: "Gotera en la terraza (demo)", descripcion: "Incidencia ficticia de la cuenta demo: una gotera en la terraza que no impide hospedar." }],
  plantillas: [
    { evento: "confirmacion", cuerpo: "Hola {{huesped}}, tu reserva en {{propiedad}} ({{unidad}}) del {{fecha_check_in}} al {{fecha_check_out}} está confirmada. ¡Gracias!", aprobada: true },
    { evento: "pre_llegada", cuerpo: "Hola {{huesped}}, te esperamos en {{propiedad}} el {{fecha_check_in}}. Cualquier duda, escríbenos por aquí.", aprobada: true },
    { evento: "check_in", cuerpo: "Bienvenido {{huesped}} a {{unidad}}. Que disfrutes tus {{noches}} noches.", aprobada: false },
    { evento: "check_out", cuerpo: "Hola {{huesped}}, recuerda que tu salida de {{unidad}} es el {{fecha_check_out}}.", aprobada: false },
    { evento: "resena", cuerpo: "Gracias por hospedarte en {{propiedad}}, {{huesped}}. ¿Nos dejas tu reseña?", aprobada: false },
  ],
  conversaciones: [
    {
      propiedad: CASA,
      unidad: "Depto 1",
      canal: "airbnb",
      reserva: "demo-abnb-0003@airbnb.example",
      huesped: "Quino Demo",
      mensajeEntrante: "Hola, ¿se puede hacer check-in más temprano el día de llegada?",
      borradorPendiente: "Hola Quino, con gusto lo revisamos: el check-in estándar es a las 15:00 y confirmamos si el depto está listo antes. Te avisamos.",
    },
    {
      propiedad: LOFT,
      unidad: "Loft A",
      canal: "vrbo",
      reserva: "demo-vrbo-0002@vrbo.example",
      huesped: "Rosa Demo",
      mensajeEntrante: "¿Tienen estacionamiento para un coche?",
      borradorPendiente: "Hola Rosa, el loft cuenta con un lugar de estacionamiento. Si necesitas otro, te recomendamos opciones cercanas.",
    },
  ],
  // Valores ILUSTRATIVOS de la demo (no son las tarifas oficiales de ningun canal): la fuente de cada regla lo dice textualmente.
  reglasComision: [
    { canal: "airbnb", yaNetoDeComision: true, comisionBasisPoints: 0 },
    { canal: "booking", yaNetoDeComision: false, comisionBasisPoints: 1500 },
    { canal: "vrbo", yaNetoDeComision: false, comisionBasisPoints: 800 },
    { canal: "manual", yaNetoDeComision: true, comisionBasisPoints: 0 },
  ],
  comisionGestorBasisPoints: 2000,
};
