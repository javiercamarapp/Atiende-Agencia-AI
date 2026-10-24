// Paridad3 Rn-P3-15 -- catálogo HONESTO de canales de distribución de México: qué puede
// hacer Atiende HOY con cada canal, por qué vía, con qué latencia externa declarada (y qué
// tan confiable es ese dato) y, si la vía preferida está bloqueada, el motivo exacto con su
// cita. Es DATOS, no lógica: no toca la base ni la red.
//
// Procedencia (copia literal, nada inventado): los textos, cifras y citas vienen del repo
// suelto de rentas (apps/web/src/pages/conectividad/catalogoCanales.ts para airbnb/vrbo/
// booking, y packages/db/src/migrations/0110_catalogo_canales_mexico.ts para expedia/agoda/
// despegar/google_vr y para los bloqueos de partner), que a su vez cita
// docs/fase2/PLAN-CONSTRUCCION.md §6 y las fichas RV22. Todo lo que ese repo no dice queda
// como `null` / "sin_evidencia": una cifra que no tiene fuente NO se escribe aquí
// (el test `catalogo-canales.spec.ts` lo hace cumplir: cada latencia trae fuente o es
// "sin_evidencia", y cada vía bloqueada trae motivo y cita).
//
// REGLA NO MAQUETAS: `viaHoy` describe lo que está implementado en Atiende, no lo que el
// canal ofrece en abstracto. Los canales de solo-partner (`viaHoy = "partner"`) NO tienen
// adaptador de API en Atiende (Rn-08/Rn-09 siguen fuera: requieren acuerdos); la UI debe
// mostrar el motivo, nunca un botón "Conectar API".

export type CodigoCanalCatalogo = "airbnb" | "booking" | "vrbo" | "expedia" | "agoda" | "despegar" | "google_vr" | "directo";

/** Vía disponible HOY en Atiende (no la que existiría con un acuerdo de partner). `sin_adaptador` = la
 * vía existe en el canal según la fuente, pero Atiende todavía no la implementa (no hay fila en `rentas.canal`). */
export type ViaHoy = "ical" | "partner" | "manual" | "sin_evidencia" | "sin_adaptador";

/** ¿Existe una vía iCal utilizable? `sin_evidencia` = el repo suelto no tiene ninguna fuente
 * primaria (ni a favor ni en contra): no se afirma ni se niega, se advierte. */
export type ViaIcal = "disponible" | "sin_evidencia" | "no_disponible";

export type ConfianzaLatencia = "alta" | "media" | "baja" | "sin_evidencia";

export interface CapacidadesHoy {
  /** Atiende puede leer la disponibilidad del canal (importar su iCal). */
  readonly import: boolean;
  /** El canal puede leer la disponibilidad de Atiende (exportar nuestro iCal). */
  readonly export: boolean;
  readonly tarifas: boolean;
  readonly mensajes: boolean;
}

/** Lo que el canal declara poder hacer SOLO con un acuerdo de partner (no implementado). */
export interface CapacidadesConPartner {
  readonly disponibilidad: boolean;
  readonly tarifas: boolean;
  readonly reservas: boolean;
  readonly mensajes: boolean;
}

export interface LatenciaDeclarada {
  /** Texto literal de la fuente, o "SIN EVIDENCIA". */
  readonly texto: string;
  readonly confianza: ConfianzaLatencia;
  /** Dónde se declaró (ficha/documento). `null` solo cuando `confianza = "sin_evidencia"`. */
  readonly fuente: string | null;
  readonly nota: string;
}

export interface BloqueoCanal {
  readonly motivo: string;
  readonly cita: string;
}

export interface CanalCatalogo {
  readonly codigo: CodigoCanalCatalogo;
  readonly nombre: string;
  /** Código del canal en `rentas.canal` si Atiende puede registrar ocupaciones/feeds con él. */
  readonly canalAtiende: "airbnb" | "booking" | "vrbo" | "manual" | null;
  readonly viaHoy: ViaHoy;
  readonly viaIcal: ViaIcal;
  readonly descripcionVia: string;
  readonly capacidades: CapacidadesHoy;
  readonly capacidadesConPartner: CapacidadesConPartner | null;
  readonly latencia: LatenciaDeclarada;
  /** Presente cuando la vía directa/preferida (API partner) está bloqueada por el canal. */
  readonly bloqueo: BloqueoCanal | null;
  /** Qué hay que conseguir fuera de Atiende (credenciales, URL del panel, contrato). */
  readonly requisitos: readonly string[];
  readonly urlProcesoOficial: string | null;
  readonly notaAntiParidad: string;
  /** Fichas/documentos de los que se copió cada dato de este canal. */
  readonly fuentes: readonly string[];
}

const SIN_EVIDENCIA_TEXTO = "SIN EVIDENCIA";
const NOTA_ANTI_PARIDAD_GENERICA =
  "El modelo de permisos y la latencia de cada canal son distintos: no asumas que lo que ocurre con un canal ocurre igual con otro (H-016, REQ-018).";

export const CATALOGO_CANALES_MX: readonly CanalCatalogo[] = [
  {
    codigo: "airbnb",
    nombre: "Airbnb",
    canalAtiende: "airbnb",
    viaHoy: "ical",
    viaIcal: "disponible",
    descripcionVia: "iCal import/export (única vía sin aprobación de partner)",
    capacidades: { import: true, export: true, tarifas: false, mensajes: false },
    capacidadesConPartner: { disponibilidad: true, tarifas: false, reservas: true, mensajes: true },
    latencia: {
      texto: "~3 horas; ventana de importación de hasta 2 años",
      confianza: "baja",
      fuente: "RV03 S1, corrección BC5; RV22 F01-F02, D-003",
      nota: "Confianza baja/media al generalizar a cualquier conexión iCal producto-Airbnb. Latencia externa no controlada por Atiende: nunca se suma a la latencia interna.",
    },
    bloqueo: {
      motivo: "API partner (Homes/Activities certificada) requiere NDA + revisión de seguridad + 6 meses post-aprobación",
      cita: "PLAN-CONSTRUCCION.md §6 — sin fecha estimada de aprobación",
    },
    requisitos: ["URL del calendario iCal de la unidad en Airbnb (Configuración > Disponibilidad > Sincronizar calendarios)"],
    urlProcesoOficial: "https://www.airbnb.mx/help/article/99",
    notaAntiParidad: "El modelo de permisos/latencia de Airbnb no es equivalente al de Vrbo/Booking.com — no asumas el mismo efecto (H-016, REQ-018).",
    fuentes: ["apps/web/src/pages/conectividad/catalogoCanales.ts (suelto)", "0110_catalogo_canales_mexico.ts (suelto): RV22 F01-F02, RV03, D-003"],
  },
  {
    codigo: "booking",
    nombre: "Booking.com",
    canalAtiende: "booking",
    viaHoy: "sin_evidencia",
    viaIcal: "sin_evidencia",
    descripcionVia: "Ninguna vía directa documentada: solo extranet manual o channel manager certificado de terceros",
    capacidades: { import: false, export: false, tarifas: false, mensajes: false },
    capacidadesConPartner: { disponibilidad: true, tarifas: true, reservas: true, mensajes: false },
    latencia: {
      texto: SIN_EVIDENCIA_TEXTO,
      confianza: "sin_evidencia",
      fuente: null,
      nota: "Cero fuente primaria sobre iCal de Booking.com (elegibilidad/frecuencia), ni viva ni archivada: no se muestra ninguna cifra estimada.",
    },
    bloqueo: {
      motivo: 'Pausado activamente por el canal: "pausing integrations with new connectivity providers until further notice"',
      cita: "docs/fuentes/b002-archivo.md F01 — no es 'pendiente de aprobación', es puerta cerrada hoy",
    },
    requisitos: ["Machine account de Booking.com (usuario/clave del Connectivity Partner Program)", "Certificación PCI/PII diferenciada por API"],
    urlProcesoOficial: "https://connect.booking.com",
    notaAntiParidad: "Booking.com no acepta conexiones directas de propiedades individuales (F02) — sin botón de 'conectar directo' en ningún flujo.",
    fuentes: ["apps/web/src/pages/conectividad/catalogoCanales.ts (suelto)", "0110_catalogo_canales_mexico.ts (suelto): RV22 F03, D-011"],
  },
  {
    codigo: "vrbo",
    nombre: "Vrbo",
    canalAtiende: "vrbo",
    viaHoy: "ical",
    viaIcal: "disponible",
    descripcionVia: "iCal import/export (única vía sin aprobación de partner)",
    capacidades: { import: true, export: true, tarifas: false, mensajes: false },
    capacidadesConPartner: { disponibilidad: true, tarifas: true, reservas: true, mensajes: false },
    latencia: {
      texto: "~30 min + 20 min de propagación",
      confianza: "media",
      fuente: "RV22 F14, D-003",
      nota: "Confianza media. Latencia externa no controlada por Atiende.",
    },
    bloqueo: {
      motivo: "Connectivity Partner Program (Elite/Preferred/Integrated) — requisitos/costos exactos no confirmados; sin selector de nivel en esta UI",
      cita: "PLAN-CONSTRUCCION.md §6 — solicitar información directa con Expedia Partner Central",
    },
    requisitos: ["URL del calendario iCal de la unidad en el Owner Dashboard de Vrbo"],
    urlProcesoOficial: "https://www.vrbo.com/help",
    notaAntiParidad: "El modelo de permisos/latencia de Vrbo no es equivalente al de Airbnb/Booking.com — no asumas el mismo efecto (H-016, REQ-018).",
    fuentes: ["apps/web/src/pages/conectividad/catalogoCanales.ts (suelto)", "0110_catalogo_canales_mexico.ts (suelto): RV22 F13-F14, D-003"],
  },
  {
    codigo: "expedia",
    nombre: "Expedia Group",
    canalAtiende: null,
    viaHoy: "partner",
    viaIcal: "no_disponible",
    descripcionVia: "Lodging Connectivity API: requiere acuerdo de partner",
    capacidades: { import: false, export: false, tarifas: false, mensajes: false },
    capacidadesConPartner: { disponibilidad: true, tarifas: true, reservas: true, mensajes: false },
    latencia: {
      texto: "sin SLA publicado para Availability & Rates; Booking Notification push único al crear la reserva",
      confianza: "baja",
      fuente: "RV22 F04-F13",
      nota: "Latencia externa; Atiende no tiene adaptador de este canal.",
    },
    bloqueo: {
      motivo: "Requiere PCI/TLS/license agreement y aprobación de partner; formulario comercial no público (sin autoservicio)",
      cita: "RV22 F04-F13",
    },
    requisitos: [
      "Cuenta de partner con licencia comercial (Expedia Partner Solutions)",
      "Attestation of Compliance PCI anual",
      "TLS 1.2+",
      "Credenciales OAuth2 client_credentials del sandbox api.sandbox.expediagroup.com",
    ],
    urlProcesoOficial: "https://connectivityportal.expediagroup.com",
    notaAntiParidad: NOTA_ANTI_PARIDAD_GENERICA,
    fuentes: ["0110_catalogo_canales_mexico.ts (suelto): RV22 F04-F13"],
  },
  {
    codigo: "agoda",
    nombre: "Agoda",
    canalAtiende: null,
    viaHoy: "sin_adaptador",
    viaIcal: "disponible",
    descripcionVia: "Enlace de calendario (calendar link) del extranet YCS, equivalente a iCal; Atiende aún no lo registra como canal conectable",
    capacidades: { import: false, export: false, tarifas: false, mensajes: false },
    capacidadesConPartner: null,
    latencia: {
      texto: '"varias veces al día" (no oficial exacto)',
      confianza: "baja",
      fuente: "RV22 §2.8/§4 Nivel A #3, RV05 [R]",
      nota: "Cifra no oficial; confianza baja.",
    },
    bloqueo: null,
    requisitos: ['URL del "calendar link" del extranet/YCS de Agoda para la propiedad'],
    urlProcesoOficial: "https://ycs.agoda.com",
    notaAntiParidad: NOTA_ANTI_PARIDAD_GENERICA,
    fuentes: ["0110_catalogo_canales_mexico.ts (suelto): RV22 §2.8/§4, RV05"],
  },
  {
    codigo: "despegar",
    nombre: "Despegar / Decolar",
    canalAtiende: null,
    viaHoy: "partner",
    viaIcal: "no_disponible",
    descripcionVia: "Solo vía channel manager certificado (SiteMinder / Rentals United): sin API propia",
    capacidades: { import: false, export: false, tarifas: false, mensajes: false },
    capacidadesConPartner: { disponibilidad: true, tarifas: true, reservas: true, mensajes: false },
    latencia: {
      texto: "onboarding 3-5 días declarado por el channel manager (vía tercero)",
      confianza: "baja",
      fuente: "RV22 F16-F19",
      nota: "Dato de un tercero (channel manager), no del canal.",
    },
    bloqueo: {
      motivo: "Sin API/spec técnica pública propia (developers.despegar.com no resuelve); solo vía channel manager certificado",
      cita: "RV22 F16-F19",
    },
    requisitos: ["Sin API/spec pública propia — requiere alta con un channel manager certificado (SiteMinder/Rentals United)"],
    urlProcesoOficial: "https://www.rentalsunited.com/connected-listings/despegar",
    notaAntiParidad: NOTA_ANTI_PARIDAD_GENERICA,
    fuentes: ["0110_catalogo_canales_mexico.ts (suelto): RV22 F16-F19"],
  },
  {
    codigo: "google_vr",
    nombre: "Google Vacation Rentals",
    canalAtiende: null,
    viaHoy: "partner",
    viaIcal: "no_disponible",
    descripcionVia: "Feed ARI (XML): programa por invitación de Google",
    capacidades: { import: false, export: false, tarifas: false, mensajes: false },
    capacidadesConPartner: { disponibilidad: true, tarifas: true, reservas: false, mensajes: false },
    latencia: {
      texto: "sin SLA publicado",
      confianza: "baja",
      fuente: "RV22 F29-F30",
      nota: "Latencia externa; Atiende no tiene adaptador de este canal.",
    },
    bloqueo: {
      motivo: "Programa exclusivamente por invitación (Technical Account Manager); sin autoservicio (RV22-R-08)",
      cita: "RV22 F29-F30",
    },
    requisitos: ["Invitación de un Technical Account Manager de Google (sin autoservicio)", "Feeds XML: Property Listings + Pricing + Landing Pages"],
    urlProcesoOficial: "https://developers.google.com/hotels/vacation-rentals/dev-guide/onboarding",
    notaAntiParidad: NOTA_ANTI_PARIDAD_GENERICA,
    fuentes: ["0110_catalogo_canales_mexico.ts (suelto): RV22 F29-F30, RV22-R-08"],
  },
  {
    codigo: "directo",
    nombre: "Reserva directa",
    canalAtiende: "manual",
    viaHoy: "manual",
    viaIcal: "no_disponible",
    descripcionVia: "Reserva directa o bloqueo manual: se registra en el calendario de Atiende; no hay feed externo que conectar",
    capacidades: { import: false, export: false, tarifas: false, mensajes: false },
    capacidadesConPartner: null,
    latencia: {
      texto: "sin canal externo: la ocupación se registra en Atiende al guardarla",
      confianza: "alta",
      fuente: "Diseño de Atiende (rentas.ocupacion con canal 'manual'): no depende de ningún tercero",
      nota: "No es una latencia de canal; solo indica que no hay espera externa.",
    },
    bloqueo: null,
    requisitos: [],
    urlProcesoOficial: null,
    notaAntiParidad: NOTA_ANTI_PARIDAD_GENERICA,
    fuentes: ["packages/domain-rentas/migrations/001_rentas_schema.sql (canal 'manual')"],
  },
];

export function buscarCanalCatalogo(codigo: string): CanalCatalogo | undefined {
  return CATALOGO_CANALES_MX.find((c) => c.codigo === codigo);
}

/** Catálogo por código de `rentas.canal` (airbnb/booking/vrbo/manual); `undefined` si Atiende no lo registra. */
export function buscarCanalCatalogoPorCanalAtiende(canalAtiende: string): CanalCatalogo | undefined {
  return CATALOGO_CANALES_MX.find((c) => c.canalAtiende === canalAtiende);
}
