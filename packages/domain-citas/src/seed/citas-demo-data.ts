// Datos FICTICIOS de los dos negocios demo de citas (clinica dental y barberia). Nada aqui es real: nombres inventados,
// telefonos con la lada reservada "00" (no existe en Mexico) y correos @example.test (dominio reservado, RFC 2606).
// Las citas se declaran por semana relativa al lunes de la fecha base (`semana`: -3..-1 pasadas, 1..2 futuras) y dia de la
// semana (`dow`: 1 = lunes ... 6 = sabado, 0 = domingo, igual que citas.availability_rules.day_of_week), asi cada cita siempre
// cae en un dia en que el proveedor atiende, sin importar cuando se corra el seed. La semana en curso queda libre a proposito.
import type { CitaEstado, CitaOrigen, EsperaEstado, EsperaVentana } from "./citas-demo.ts";

export interface DatosNegocio {
  readonly slug: string;
  readonly nombre: string;
  readonly rubro: "dental" | "barberia";
  readonly timezone: string;
  readonly sucursal: string;
  readonly servicios: readonly { readonly nombre: string; readonly minutos: number; readonly precioCentavos: number }[];
  readonly proveedores: readonly {
    readonly nombre: string;
    readonly rol: string;
    readonly servicios: readonly string[];
    /** Tramos semanales: dias (0-6) y horas locales "HH:MM". */
    readonly horario: readonly { readonly dias: readonly number[]; readonly tramos: readonly (readonly [string, string])[] }[];
  }[];
  readonly excepciones: readonly {
    readonly proveedor: string;
    readonly semana: number;
    readonly dow: number;
    readonly cerrado: boolean;
    readonly inicio?: string;
    readonly fin?: string;
    readonly motivo: string;
  }[];
  readonly clientes: readonly { readonly nombre: string; readonly email: string }[];
  readonly citas: readonly {
    readonly clave: string;
    readonly proveedor: string;
    readonly servicio: string;
    readonly cliente: number;
    readonly semana: number;
    readonly dow: number;
    readonly hora: string;
    readonly estado: CitaEstado;
    readonly origen: CitaOrigen;
    readonly notas?: string;
  }[];
  readonly espera: readonly {
    readonly nombre: string;
    readonly servicio: string;
    readonly proveedor: string | null;
    readonly desde: readonly [number, number];
    readonly hasta: readonly [number, number];
    readonly ventana: EsperaVentana;
    readonly estado: EsperaEstado;
  }[];
}

const dentalClientes = [
  ["Sofía Canul Ek", "sofia.canul"], ["Marco Uc Pech", "marco.uc"], ["Lucía Pech Dzul", "lucia.pech"], ["Iván Cen Tun", "ivan.cen"],
  ["Paola Chan Kú", "paola.chan"], ["Elena Dzul Cab", "elena.dzul"], ["Tomás Kú Moo", "tomas.ku"], ["Carmen Euán Aké", "carmen.euan"],
  ["Hugo Ay Tzec", "hugo.ay"], ["Fabiola Ku Cauich", "fabiola.ku"],
] as const;
const barberiaClientes = [
  ["Daniel Tun May", "daniel.tun"], ["Rodrigo Pool Be", "rodrigo.pool"], ["Erick Moo Cob", "erick.moo"], ["Pedro Tzec Ake", "pedro.tzec"],
  ["Memo Aké Dzib", "memo.ake"], ["Sergio Mex Poot", "sergio.mex"], ["Luis Ake Chi", "luis.ake"], ["Iker Dzul Uc", "iker.dzul"],
  ["Beto Sosa Cetz", "beto.sosa"], ["Julio Cab Yam", "julio.cab"],
] as const;

export const NEGOCIOS_DEMO: readonly DatosNegocio[] = [
  {
    slug: "clinica-dental-sonrisa-demo",
    nombre: "Clínica Dental Sonrisa (demo)",
    rubro: "dental",
    timezone: "America/Merida",
    sucursal: "Sucursal Centro (demo)",
    servicios: [
      { nombre: "Limpieza dental", minutos: 45, precioCentavos: 60000 },
      { nombre: "Consulta de valoración", minutos: 30, precioCentavos: 40000 },
      { nombre: "Resina o empaste", minutos: 60, precioCentavos: 120000 },
      { nombre: "Blanqueamiento", minutos: 90, precioCentavos: 350000 },
    ],
    proveedores: [
      { nombre: "Dra. Ana Lozano", rol: "Odontóloga general", servicios: ["Limpieza dental", "Consulta de valoración", "Resina o empaste"], horario: [{ dias: [1, 2, 3, 4, 5], tramos: [["09:00", "14:00"], ["16:00", "19:00"]] }] },
      { nombre: "Dr. Luis Pech", rol: "Endodoncista", servicios: ["Limpieza dental", "Consulta de valoración", "Resina o empaste"], horario: [{ dias: [2, 3, 4, 5, 6], tramos: [["10:00", "18:00"]] }] },
      { nombre: "Dra. Marisol Canché", rol: "Higienista", servicios: ["Limpieza dental", "Blanqueamiento"], horario: [{ dias: [1, 3, 5], tramos: [["09:00", "15:00"]] }] },
    ],
    excepciones: [
      { proveedor: "Dra. Ana Lozano", semana: 1, dow: 3, cerrado: true, motivo: "Capacitación (demo)" },
      { proveedor: "Dr. Luis Pech", semana: 2, dow: 6, cerrado: false, inicio: "10:00", fin: "14:00", motivo: "Medio día (demo)" },
      { proveedor: "Dra. Marisol Canché", semana: 1, dow: 1, cerrado: true, motivo: "Día inhábil (demo)" },
    ],
    clientes: dentalClientes.map(([nombre, u]) => ({ nombre, email: `${u}@example.test` })),
    citas: [
      { clave: "d01", proveedor: "Dra. Ana Lozano", servicio: "Consulta de valoración", cliente: 0, semana: -3, dow: 1, hora: "09:00", estado: "completed", origen: "whatsapp" },
      { clave: "d02", proveedor: "Dra. Ana Lozano", servicio: "Limpieza dental", cliente: 1, semana: -3, dow: 2, hora: "10:00", estado: "completed", origen: "voice" },
      { clave: "d03", proveedor: "Dr. Luis Pech", servicio: "Resina o empaste", cliente: 2, semana: -3, dow: 3, hora: "11:00", estado: "completed", origen: "manual", notas: "Molar superior derecho" },
      { clave: "d04", proveedor: "Dra. Marisol Canché", servicio: "Blanqueamiento", cliente: 3, semana: -3, dow: 3, hora: "09:30", estado: "completed", origen: "web" },
      { clave: "d05", proveedor: "Dra. Ana Lozano", servicio: "Limpieza dental", cliente: 4, semana: -3, dow: 4, hora: "16:00", estado: "no_show", origen: "whatsapp" },
      { clave: "d06", proveedor: "Dr. Luis Pech", servicio: "Consulta de valoración", cliente: 5, semana: -2, dow: 2, hora: "12:00", estado: "completed", origen: "whatsapp" },
      { clave: "d07", proveedor: "Dra. Marisol Canché", servicio: "Limpieza dental", cliente: 6, semana: -2, dow: 1, hora: "10:00", estado: "completed", origen: "web" },
      { clave: "d08", proveedor: "Dra. Ana Lozano", servicio: "Resina o empaste", cliente: 0, semana: -2, dow: 5, hora: "17:00", estado: "completed", origen: "manual" },
      { clave: "d09", proveedor: "Dr. Luis Pech", servicio: "Limpieza dental", cliente: 7, semana: -2, dow: 6, hora: "10:30", estado: "no_show", origen: "voice" },
      { clave: "d10", proveedor: "Dra. Ana Lozano", servicio: "Consulta de valoración", cliente: 8, semana: -2, dow: 3, hora: "09:00", estado: "cancelled", origen: "whatsapp", notas: "Avisó que tenía junta" },
      { clave: "d11", proveedor: "Dra. Ana Lozano", servicio: "Limpieza dental", cliente: 1, semana: -1, dow: 1, hora: "09:00", estado: "completed", origen: "whatsapp" },
      { clave: "d12", proveedor: "Dra. Marisol Canché", servicio: "Blanqueamiento", cliente: 9, semana: -1, dow: 5, hora: "09:00", estado: "completed", origen: "web" },
      { clave: "d13", proveedor: "Dr. Luis Pech", servicio: "Resina o empaste", cliente: 3, semana: -1, dow: 4, hora: "14:00", estado: "completed", origen: "voice" },
      { clave: "d14", proveedor: "Dra. Ana Lozano", servicio: "Consulta de valoración", cliente: 2, semana: -1, dow: 2, hora: "16:30", estado: "no_show", origen: "whatsapp" },
      { clave: "d15", proveedor: "Dr. Luis Pech", servicio: "Consulta de valoración", cliente: 4, semana: -1, dow: 3, hora: "10:00", estado: "cancelled", origen: "web" },
      { clave: "d16", proveedor: "Dra. Ana Lozano", servicio: "Limpieza dental", cliente: 5, semana: 1, dow: 1, hora: "09:00", estado: "confirmed", origen: "whatsapp" },
      { clave: "d17", proveedor: "Dr. Luis Pech", servicio: "Resina o empaste", cliente: 6, semana: 1, dow: 2, hora: "11:00", estado: "confirmed", origen: "manual" },
      { clave: "d18", proveedor: "Dra. Marisol Canché", servicio: "Limpieza dental", cliente: 7, semana: 1, dow: 3, hora: "10:00", estado: "pending", origen: "web" },
      { clave: "d19", proveedor: "Dra. Ana Lozano", servicio: "Consulta de valoración", cliente: 0, semana: 1, dow: 4, hora: "17:00", estado: "pending", origen: "whatsapp" },
      { clave: "d20", proveedor: "Dr. Luis Pech", servicio: "Consulta de valoración", cliente: 8, semana: 1, dow: 5, hora: "15:00", estado: "confirmed", origen: "voice" },
      { clave: "d21", proveedor: "Dra. Marisol Canché", servicio: "Blanqueamiento", cliente: 9, semana: 1, dow: 5, hora: "11:00", estado: "cancelled", origen: "web" },
      { clave: "d22", proveedor: "Dra. Ana Lozano", servicio: "Limpieza dental", cliente: 1, semana: 2, dow: 2, hora: "10:00", estado: "confirmed", origen: "whatsapp" },
      { clave: "d23", proveedor: "Dr. Luis Pech", servicio: "Resina o empaste", cliente: 2, semana: 2, dow: 6, hora: "13:00", estado: "pending", origen: "manual" },
      { clave: "d24", proveedor: "Dra. Marisol Canché", servicio: "Limpieza dental", cliente: 3, semana: 2, dow: 1, hora: "09:00", estado: "confirmed", origen: "web" },
      { clave: "d25", proveedor: "Dra. Ana Lozano", servicio: "Resina o empaste", cliente: 4, semana: 2, dow: 4, hora: "09:00", estado: "confirmed", origen: "whatsapp" },
    ],
    espera: [
      { nombre: "Andrea Pat Mex", servicio: "Limpieza dental", proveedor: "Dra. Ana Lozano", desde: [1, 1], hasta: [1, 5], ventana: "morning", estado: "active" },
      { nombre: "Raúl Cupul Ix", servicio: "Consulta de valoración", proveedor: null, desde: [1, 1], hasta: [2, 5], ventana: "any", estado: "notified" },
      { nombre: "Diana Balam Hau", servicio: "Resina o empaste", proveedor: "Dr. Luis Pech", desde: [-1, 1], hasta: [-1, 5], ventana: "afternoon", estado: "fulfilled" },
      { nombre: "Víctor Ek Naal", servicio: "Blanqueamiento", proveedor: "Dra. Marisol Canché", desde: [1, 1], hasta: [2, 5], ventana: "any", estado: "cancelled" },
      { nombre: "Mireya Tuz Xool", servicio: "Limpieza dental", proveedor: null, desde: [-3, 1], hasta: [-3, 5], ventana: "evening", estado: "expired" },
    ],
  },
  {
    slug: "barberia-el-filo-demo",
    nombre: "Barbería El Filo (demo)",
    rubro: "barberia",
    timezone: "America/Merida",
    sucursal: "Sucursal Norte (demo)",
    servicios: [
      { nombre: "Corte de cabello", minutos: 30, precioCentavos: 25000 },
      { nombre: "Arreglo de barba", minutos: 20, precioCentavos: 15000 },
      { nombre: "Corte y barba", minutos: 45, precioCentavos: 35000 },
      { nombre: "Afeitado clásico", minutos: 30, precioCentavos: 20000 },
    ],
    proveedores: [
      { nombre: "Beto", rol: "Barbero", servicios: ["Corte de cabello", "Arreglo de barba", "Corte y barba", "Afeitado clásico"], horario: [{ dias: [2, 3, 4, 5, 6], tramos: [["10:00", "20:00"]] }] },
      { nombre: "Chuy", rol: "Barbero", servicios: ["Corte de cabello", "Arreglo de barba", "Corte y barba"], horario: [{ dias: [1, 2, 3, 4, 5], tramos: [["11:00", "19:00"]] }] },
      { nombre: "Memo", rol: "Barbero", servicios: ["Corte de cabello", "Afeitado clásico"], horario: [{ dias: [4, 5, 6], tramos: [["12:00", "21:00"]] }] },
    ],
    excepciones: [
      { proveedor: "Beto", semana: 1, dow: 5, cerrado: true, motivo: "Descanso (demo)" },
      { proveedor: "Chuy", semana: 2, dow: 5, cerrado: false, inicio: "11:00", fin: "15:00", motivo: "Salida temprano (demo)" },
    ],
    clientes: barberiaClientes.map(([nombre, u]) => ({ nombre, email: `${u}@example.test` })),
    citas: [
      { clave: "b01", proveedor: "Beto", servicio: "Corte de cabello", cliente: 0, semana: -3, dow: 2, hora: "10:00", estado: "completed", origen: "whatsapp" },
      { clave: "b02", proveedor: "Chuy", servicio: "Corte y barba", cliente: 1, semana: -3, dow: 1, hora: "11:00", estado: "completed", origen: "web" },
      { clave: "b03", proveedor: "Memo", servicio: "Afeitado clásico", cliente: 2, semana: -3, dow: 4, hora: "12:00", estado: "completed", origen: "manual" },
      { clave: "b04", proveedor: "Beto", servicio: "Arreglo de barba", cliente: 3, semana: -3, dow: 6, hora: "15:00", estado: "no_show", origen: "whatsapp" },
      { clave: "b05", proveedor: "Chuy", servicio: "Corte de cabello", cliente: 4, semana: -3, dow: 3, hora: "17:00", estado: "completed", origen: "voice" },
      { clave: "b06", proveedor: "Beto", servicio: "Corte y barba", cliente: 5, semana: -2, dow: 2, hora: "18:00", estado: "completed", origen: "whatsapp" },
      { clave: "b07", proveedor: "Chuy", servicio: "Corte de cabello", cliente: 6, semana: -2, dow: 5, hora: "11:30", estado: "completed", origen: "web" },
      { clave: "b08", proveedor: "Memo", servicio: "Corte de cabello", cliente: 7, semana: -2, dow: 6, hora: "19:00", estado: "completed", origen: "whatsapp" },
      { clave: "b09", proveedor: "Beto", servicio: "Afeitado clásico", cliente: 0, semana: -2, dow: 4, hora: "10:30", estado: "cancelled", origen: "manual", notas: "Pidió cambiar de día" },
      { clave: "b10", proveedor: "Chuy", servicio: "Arreglo de barba", cliente: 8, semana: -2, dow: 1, hora: "15:00", estado: "no_show", origen: "whatsapp" },
      { clave: "b11", proveedor: "Beto", servicio: "Corte de cabello", cliente: 1, semana: -1, dow: 3, hora: "10:00", estado: "completed", origen: "whatsapp" },
      { clave: "b12", proveedor: "Chuy", servicio: "Corte y barba", cliente: 9, semana: -1, dow: 2, hora: "13:00", estado: "completed", origen: "web" },
      { clave: "b13", proveedor: "Memo", servicio: "Corte de cabello", cliente: 2, semana: -1, dow: 4, hora: "12:30", estado: "completed", origen: "voice" },
      { clave: "b14", proveedor: "Beto", servicio: "Corte y barba", cliente: 3, semana: -1, dow: 5, hora: "16:00", estado: "no_show", origen: "whatsapp" },
      { clave: "b15", proveedor: "Chuy", servicio: "Arreglo de barba", cliente: 4, semana: -1, dow: 4, hora: "18:00", estado: "cancelled", origen: "web" },
      { clave: "b16", proveedor: "Beto", servicio: "Corte de cabello", cliente: 5, semana: 1, dow: 2, hora: "10:00", estado: "confirmed", origen: "whatsapp" },
      { clave: "b17", proveedor: "Chuy", servicio: "Corte y barba", cliente: 6, semana: 1, dow: 3, hora: "14:00", estado: "confirmed", origen: "web" },
      { clave: "b18", proveedor: "Memo", servicio: "Corte de cabello", cliente: 7, semana: 1, dow: 4, hora: "13:00", estado: "pending", origen: "whatsapp" },
      { clave: "b19", proveedor: "Beto", servicio: "Arreglo de barba", cliente: 8, semana: 1, dow: 6, hora: "12:00", estado: "pending", origen: "voice" },
      { clave: "b20", proveedor: "Chuy", servicio: "Corte de cabello", cliente: 9, semana: 1, dow: 1, hora: "11:00", estado: "cancelled", origen: "manual" },
      { clave: "b21", proveedor: "Beto", servicio: "Corte y barba", cliente: 0, semana: 2, dow: 2, hora: "17:00", estado: "confirmed", origen: "whatsapp" },
      { clave: "b22", proveedor: "Memo", servicio: "Afeitado clásico", cliente: 1, semana: 2, dow: 5, hora: "19:30", estado: "confirmed", origen: "web" },
      { clave: "b23", proveedor: "Chuy", servicio: "Corte de cabello", cliente: 2, semana: 2, dow: 3, hora: "11:00", estado: "confirmed", origen: "whatsapp" },
      { clave: "b24", proveedor: "Beto", servicio: "Corte de cabello", cliente: 3, semana: 2, dow: 6, hora: "10:00", estado: "pending", origen: "manual" },
    ],
    espera: [
      { nombre: "Ramón Che Pat", servicio: "Corte de cabello", proveedor: "Beto", desde: [1, 2], hasta: [1, 6], ventana: "afternoon", estado: "active" },
      { nombre: "Gael Puc Nah", servicio: "Corte y barba", proveedor: null, desde: [1, 2], hasta: [2, 6], ventana: "any", estado: "notified" },
      { nombre: "Ismael Ucán Kú", servicio: "Afeitado clásico", proveedor: "Memo", desde: [-1, 4], hasta: [-1, 6], ventana: "evening", estado: "fulfilled" },
      { nombre: "Octavio Mis Tun", servicio: "Arreglo de barba", proveedor: "Chuy", desde: [1, 1], hasta: [2, 5], ventana: "morning", estado: "cancelled" },
      { nombre: "Néstor Cen Aké", servicio: "Corte de cabello", proveedor: null, desde: [-3, 1], hasta: [-3, 6], ventana: "any", estado: "expired" },
    ],
  },
];
