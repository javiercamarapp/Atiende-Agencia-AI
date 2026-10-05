// Fixtures del Cerebro de ventas (SA-L-37/42/43) para la API simulada de e2e: una cartera de prospectos FICTICIOS (empresas inventadas,
// correos @example.test y telefonos 555) repartida en las 6 verticales y en varios estados, con ubicacion, scores (algunos sin calificar),
// un contacto legado, uno con el telefono en la lista de supresion y las taxonomias vigentes con su mensaje base. Solo vive en la API
// simulada: en produccion la respuesta sale de las funciones core.*_for_superadmin (apps/api/src/routes/superadmin-cerebro.ts).
import { fallo } from "../respuestas.ts";
import type { Ruta } from "../tipos.ts";

interface Fila {
  id: string;
  empresa: string;
  vertical: string;
  subtipo: string | null;
  ciudad: string;
  municipio: string | null;
  entidad: string;
  lat: number | null;
  lng: number | null;
  estado: string;
  contactoNombre: string | null;
  telefono: string | null;
  correo: string | null;
  fuente: string | null;
  tamano: string | null;
  urgencia: number | null;
  cierre: number | null;
  ajuste: number | null;
  completitud: number | null;
  legado?: boolean;
  suprimidoTel?: boolean;
  notas?: string | null;
  sitio?: string | null;
}

// id, empresa, vertical, subtipo, ciudad, municipio, entidad, lat, lng, estado, contacto, telefono, correo, fuente, tamano, urg, cierre, ajuste, datos
const FILAS: Fila[] = [
  { id: "cp-01", empresa: "Taquería Doña Ficticia", vertical: "restaurantes", subtipo: "taqueria", ciudad: "Mérida", municipio: "Mérida", entidad: "Yucatán", lat: 20.9674, lng: -89.5926, estado: "nuevo", contactoNombre: "Lupe Pérez", telefono: "9995550101", correo: "lupe@example.test", fuente: "directorio", tamano: "s1", urgencia: 82, cierre: 64, ajuste: 71, completitud: 90, notas: "Publica su WhatsApp y no contesta reseñas." },
  { id: "cp-02", empresa: "Cafetería El Faro Ficticio", vertical: "restaurantes", subtipo: "cafeteria", ciudad: "Mérida", municipio: "Mérida", entidad: "Yucatán", lat: 20.9801, lng: -89.6203, estado: "contactado", contactoNombre: null, telefono: "9995550102", correo: null, fuente: "directorio", tamano: "s2_3", urgencia: 45, cierre: 38, ajuste: 52, completitud: 60 },
  { id: "cp-03", empresa: "Marisquería La Playita Ficticia", vertical: "restaurantes", subtipo: "taqueria", ciudad: "Progreso", municipio: "Progreso", entidad: "Yucatán", lat: 21.2822, lng: -89.6637, estado: "demo", contactoNombre: "Elena Tun", telefono: "9995550103", correo: "elena@example.test", fuente: "referido", tamano: "s1", urgencia: 71, cierre: 77, ajuste: 80, completitud: 85 },
  { id: "cp-04", empresa: "Hotel Brisa Ficticio", vertical: "hoteles", subtipo: "boutique", ciudad: "Cancún", municipio: "Benito Juárez", entidad: "Quintana Roo", lat: 21.1619, lng: -86.8515, estado: "propuesta", contactoNombre: "Marcos Aké", telefono: "9985550104", correo: "marcos@example.test", fuente: "referido", tamano: "h1", urgencia: 66, cierre: 88, ajuste: 74, completitud: 92 },
  { id: "cp-05", empresa: "Posada del Sol Ficticia", vertical: "hoteles", subtipo: "boutique", ciudad: "Playa del Carmen", municipio: "Solidaridad", entidad: "Quintana Roo", lat: 20.6296, lng: -87.0739, estado: "ganado", contactoNombre: "Ana Cupul", telefono: "9845550105", correo: null, fuente: "feria", tamano: "h1", urgencia: 30, cierre: 95, ajuste: 82, completitud: 95 },
  { id: "cp-06", empresa: "Hotel Centro Ficticio", vertical: "hoteles", subtipo: null, ciudad: "Ciudad de México", municipio: "Cuauhtémoc", entidad: "Ciudad de México", lat: 19.4326, lng: -99.1332, estado: "perdido", contactoNombre: null, telefono: null, correo: "recepcion@example.test", fuente: null, tamano: null, urgencia: null, cierre: null, ajuste: null, completitud: 35 },
  { id: "cp-07", empresa: "Rentas Costa Ficticias", vertical: "rentas", subtipo: "gestora", ciudad: "Tulum", municipio: "Tulum", entidad: "Quintana Roo", lat: 20.2114, lng: -87.4654, estado: "contactado", contactoNombre: "Sofía Canul", telefono: "9845550107", correo: "sofia@example.test", fuente: "directorio", tamano: "r1", urgencia: 58, cierre: 49, ajuste: 63, completitud: 78 },
  { id: "cp-08", empresa: "Villas del Mar Ficticias", vertical: "rentas", subtipo: "gestora", ciudad: "Puerto Vallarta", municipio: "Puerto Vallarta", entidad: "Jalisco", lat: 20.6534, lng: -105.2253, estado: "nuevo", contactoNombre: null, telefono: "3225550108", correo: null, fuente: "directorio", tamano: "r2", urgencia: 40, cierre: 33, ajuste: 55, completitud: 55 },
  { id: "cp-09", empresa: "Constructora Ficticia del Norte", vertical: "licitaciones", subtipo: "construccion", ciudad: "Monterrey", municipio: "Monterrey", entidad: "Nuevo León", lat: 25.6866, lng: -100.3161, estado: "negociacion", contactoNombre: "Raúl Garza", telefono: "8185550109", correo: "raul@example.test", fuente: "referido", tamano: "l2", urgencia: 77, cierre: 83, ajuste: 79, completitud: 88 },
  { id: "cp-10", empresa: "Suministros Ficticios del Bajío", vertical: "licitaciones", subtipo: "suministros", ciudad: "León", municipio: "León", entidad: "Guanajuato", lat: 21.1221, lng: -101.6827, estado: "nuevo", contactoNombre: null, telefono: null, correo: null, fuente: "directorio", tamano: null, urgencia: 22, cierre: 18, ajuste: 40, completitud: 40, legado: true },
  { id: "cp-11", empresa: "Despacho Contable Ficticio", vertical: "despachos", subtipo: "contable", ciudad: "Guadalajara", municipio: "Guadalajara", entidad: "Jalisco", lat: 20.6597, lng: -103.3496, estado: "contactado", contactoNombre: "Diana Ruiz", telefono: "3335550111", correo: "diana@example.test", fuente: "directorio", tamano: "d1", urgencia: 69, cierre: 61, ajuste: 66, completitud: 82, suprimidoTel: true },
  { id: "cp-12", empresa: "Asesores Fiscales Ficticios", vertical: "despachos", subtipo: "contable", ciudad: "Puebla", municipio: "Puebla", entidad: "Puebla", lat: 19.0414, lng: -98.2063, estado: "demo", contactoNombre: "Iván Soto", telefono: "2225550112", correo: "ivan@example.test", fuente: "referido", tamano: "d2", urgencia: 55, cierre: 72, ajuste: 70, completitud: 80 },
  { id: "cp-13", empresa: "Clínica Dental Ficticia", vertical: "citas", subtipo: "dental", ciudad: "Mérida", municipio: "Mérida", entidad: "Yucatán", lat: 21.0155, lng: -89.5881, estado: "propuesta", contactoNombre: "Dra. Pat Mex", telefono: "9995550113", correo: "clinica@example.test", fuente: "directorio", tamano: "c1", urgencia: 74, cierre: 68, ajuste: 77, completitud: 91 },
  { id: "cp-14", empresa: "Spa Bienestar Ficticio", vertical: "citas", subtipo: "spa", ciudad: "Mérida", municipio: "Mérida", entidad: "Yucatán", lat: 20.9493, lng: -89.6418, estado: "descartado", contactoNombre: null, telefono: "9995550114", correo: null, fuente: "directorio", tamano: "c1", urgencia: 12, cierre: 10, ajuste: 30, completitud: 50 },
  { id: "cp-15", empresa: "Veterinaria Ficticia sin ubicación", vertical: "citas", subtipo: null, ciudad: "Querétaro", municipio: null, entidad: "Querétaro", lat: null, lng: null, estado: "nuevo", contactoNombre: null, telefono: "4425550115", correo: null, fuente: null, tamano: null, urgencia: null, cierre: null, ajuste: null, completitud: 30 },
  { id: "cp-16", empresa: "Restaurante Ficticio sin plaza", vertical: "restaurantes", subtipo: "taqueria", ciudad: "Desconocida", municipio: null, entidad: "Atlántida", lat: 19.0, lng: -97.0, estado: "nuevo", contactoNombre: null, telefono: null, correo: "sin.plaza@example.test", fuente: "directorio", tamano: "s1", urgencia: 35, cierre: 25, ajuste: 45, completitud: 45 },
];

const FECHA = "2026-09-20T12:00:00.000Z";

function prospecto(f: Fila) {
  const sinScore = f.urgencia === null && f.cierre === null && f.ajuste === null;
  return {
    id: f.id,
    empresa: f.empresa,
    vertical: f.vertical,
    ciudad: f.ciudad,
    contactoNombre: f.contactoNombre,
    telefono: f.telefono,
    correo: f.correo,
    estado: f.estado,
    fuente: f.fuente,
    notas: f.notas ?? null,
    creadoPor: null,
    createdAt: FECHA,
    updatedAt: FECHA,
    necesitaSeguimientoDesde: null,
    subtipo: f.subtipo,
    tamano: f.tamano,
    entidad: f.entidad,
    municipio: f.municipio,
    zona: null,
    lat: f.lat,
    lng: f.lng,
    sitioWeb: f.sitio ?? null,
    sitioVerificado: false,
    redes: {},
    senales: [],
    baseLicitud: f.legado ? null : "fuente_publica_b2b",
    consentimientoEn: null,
    scoreAjuste: f.ajuste,
    scoreUrgencia: f.urgencia,
    scoreCierre: f.cierre,
    scoreCompletitud: f.completitud,
    scoreExplicacion: sinScore
      ? { version: "reglas-v1/tax-1", dimensiones: {}, insuficiente: { mensaje: "SEÑAL INSUFICIENTE: falta al menos 2 señales válidas; búscalas en Google Maps y en su sitio." } }
      : { version: "reglas-v1/tax-1", insuficiente: null, dimensiones: { urgencia: { puntaje: f.urgencia, items: [{ regla: "Reseñas: no contestan", puntos: 35, evidencia: { fuente: "Google Maps", fecha: "2026-09-18" } }] }, cierre: { puntaje: f.cierre, items: [{ regla: "Base de licitud: fuente pública B2B", puntos: 5, evidencia: { fuente: "captura en Cerebro de ventas", fecha: "2026-09-20" } }] } } },
    scoreVersion: sinScore ? null : "reglas-v1/tax-1",
    duplicadoDe: null,
    vendedorId: null,
    organizationId: null,
    orgDemoId: null,
    ultimoToqueEn: f.estado === "contactado" ? "2026-09-25T15:00:00.000Z" : null,
    siguientePaso: null,
    siguientePasoEn: null,
    contactoLegado: f.legado === true,
    suprimido: { telefono: f.suprimidoTel === true, correo: false },
  };
}

const MENSAJES: Record<string, string> = {
  restaurantes: "Hola {nombre}, vi que {restaurante} recibe pedidos por WhatsApp. En atiende.ai tenemos un agente que contesta llamadas y WhatsApp con tu menú y toma el pedido. ¿Te muestro en 15 minutos cómo quedaría? Si no te interesa, responde BAJA.",
  hoteles: "Hola {nombre}, soy de atiende.ai. Ayudamos a hoteles como {hotel} a contestar reservas por WhatsApp y teléfono a cualquier hora. ¿Le muestro una demo? Responda BAJA si prefiere no recibir mensajes.",
  rentas: "Hola {nombre}, vi que {gestora} administra propiedades en {destino}. atiende.ai junta tus calendarios y evita dobles reservas. ¿Te interesa verlo? Responde BAJA si no quieres más mensajes.",
  licitaciones: "Hola {nombre}, vimos que {empresa} participa en licitaciones de {giro}. atiende.ai te avisa de convocatorias de tu giro. ¿Te enseño las abiertas esta semana? Responde BAJA si no quieres más mensajes.",
  despachos: "Hola {nombre}, en atiende.ai ayudamos a despachos a conciliar CFDI contra estados de cuenta y vigilar la lista 69-B. ¿Le muestro cómo se vería? Responda BAJA si prefiere no recibir mensajes.",
  citas: "Hola {nombre}, en atiende.ai ayudamos a {tipo} como {negocio} a agendar por WhatsApp y teléfono y mandar recordatorios. ¿Le muestro cómo quedaría? Responda BAJA si prefiere no recibir mensajes.",
};
const SUBTIPOS: Record<string, Array<[string, string]>> = {
  restaurantes: [["taqueria", "Taquería"], ["cafeteria", "Cafetería"]],
  hoteles: [["boutique", "Hotel boutique"]],
  rentas: [["gestora", "Gestora de rentas"]],
  licitaciones: [["construccion", "Construcción"], ["suministros", "Suministros"]],
  despachos: [["contable", "Despacho contable"]],
  citas: [["dental", "Clínica dental"], ["spa", "Spa"]],
};
const RANGOS: Record<string, { unidad: string; rangos: Array<[string, string]> }> = {
  restaurantes: { unidad: "sucursales", rangos: [["s1", "1"], ["s2_3", "2-3"]] },
  hoteles: { unidad: "habitaciones", rangos: [["h1", "1-20"]] },
  rentas: { unidad: "propiedades", rangos: [["r1", "1-10"], ["r2", "11-50"]] },
  licitaciones: { unidad: "empleados", rangos: [["l2", "11-50"]] },
  despachos: { unidad: "empleados", rangos: [["d1", "1-5"], ["d2", "6-20"]] },
  citas: { unidad: "profesionales", rangos: [["c1", "1-3"]] },
};

function taxonomias() {
  return Object.keys(MENSAJES).map((v) => ({
    vertical: v,
    version: 1,
    subtipos: (SUBTIPOS[v] ?? []).map(([clave, nombre]) => ({ clave, nombre })),
    rangosTamano: { unidad: RANGOS[v]!.unidad, rangos: RANGOS[v]!.rangos.map(([clave, etiqueta]) => ({ clave, etiqueta })) },
    mensajesBase: [{ canal: "whatsapp", variante: "A", texto: MENSAJES[v]! }],
  }));
}

function detalle(id: string) {
  const f = FILAS.find((x) => x.id === id);
  if (!f) return null;
  return {
    disponible: true,
    personas: f.contactoNombre
      ? [{ id: `${id}-p1`, nombre: f.contactoNombre, cargo: "Dirección", canal: f.correo ? "correo" : "telefono", dato: f.correo ?? f.telefono, origen: "sitio_web_oficial", confianza: "alta", evidenciaUrl: "https://example.test/equipo", creadoEn: FECHA }]
      : [],
    eventos: [
      { id: `${id}-e1`, tipo: "nota", actorId: null, detalle: { accion: "alta" }, costoMicroUsd: null, creadoEn: FECHA },
      ...(f.estado === "contactado" ? [{ id: `${id}-e2`, tipo: "cambio_etapa", actorId: null, detalle: { de: "nuevo", a: "contactado" }, costoMicroUsd: null, creadoEn: "2026-09-25T15:00:00.000Z" }] : []),
    ],
  };
}

export const rutasCerebro: readonly Ruta[] = [
  { metodo: "GET", patron: "/superadmin/cerebro/prospectos", manejador: () => ({ disponible: true, prospectos: FILAS.map(prospecto), taxonomias: taxonomias() }) },
  { metodo: "GET", patron: "/superadmin/cerebro/prospectos/:id/detalle", manejador: (p) => detalle(String(p.params["id"])) ?? fallo(404, "El prospecto no existe.") },
  // Rastro de una exportacion (bitacora de acceso, accion `exportacion`): la API simulada lo acepta y lo deja en el registro de peticiones.
  { metodo: "POST", patron: "/superadmin/cerebro/exportaciones", manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { total?: unknown };
      if (typeof c.total !== "number") return fallo(400, "total debe ser un entero.");
      return { registrada: true };
    } },
];
