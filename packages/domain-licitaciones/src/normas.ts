// L-24 -- registro normativo versionado de licitaciones (patron `normas/` de Likida): cada norma
// que el codigo cita (LAASSP 49/73/95, CFF 32-D/69-B, RLAASSP) tiene una ficha con su estado de
// verificacion, y una prueba (`tests/normas.spec.ts`) ata cada cita del codigo a una ficha.
//
// REGLA DE HONESTIDAD: este modulo NO transcribe texto legal ni inventa articulos ni fechas. Una
// ficha solo dice (a) que asume el codigo, (b) de donde sale ese dato y (c) cuan verificado esta.
// Lo que nadie ha contrastado contra la fuente primaria se queda en `sin_verificar` y con
// `validarConAbogado: true`; ninguna ficha de este registro esta en `verificado_fuente_primaria`
// porque ninguna se contrasto contra el texto oficial al crearlo. Esto NO es asesoria legal.

export type NormaLey = "LAASSP" | "CFF" | "RLAASSP" | "LDCMIPYME";

/**
 * - `verificado_fuente_primaria`: alguien contrasto el texto vigente en la fuente oficial (se anota fecha y quien).
 * - `verificado_en_repo_origen`: dato heredado de `docs/legal/verificacion-legal.md` del repo original (no re-verificado aqui).
 * - `sin_verificar`: lo que el codigo asume pero nadie ha contrastado.
 */
export type NormaEstadoVerificacion = "verificado_fuente_primaria" | "verificado_en_repo_origen" | "sin_verificar";

export type NormaVigencia = "vigente" | "abrogada" | "por_confirmar";

export interface NormaCitaEnCodigo {
  /** Ruta relativa a la raiz del repo. La prueba comprueba que existe y que contiene `texto`. */
  readonly archivo: string;
  /** Fragmento literal (sin distinguir mayusculas) que debe aparecer en el archivo. */
  readonly texto: string;
}

export interface NormaFicha {
  readonly id: string;
  readonly ley: NormaLey;
  readonly instrumento: string;
  /** Numero de articulo tal como se cita ("73", "69-B") o `null` si la ficha cubre la norma completa o no se conoce el numero. */
  readonly articulo: string | null;
  readonly titulo: string;
  readonly vigencia: NormaVigencia;
  readonly publicacionDof: string | null;
  readonly entradaEnVigor: string | null;
  /** Lo que el codigo da por cierto a partir de esta norma. */
  readonly queAsumeElCodigo: string;
  readonly estadoVerificacion: NormaEstadoVerificacion;
  /** `true` siempre que no este `verificado_fuente_primaria`. */
  readonly validarConAbogado: boolean;
  readonly fuente: string;
  readonly nota: string;
  /** Citas normalizadas ("LAASSP 73", "CFF 69-B") que esta ficha respalda. Vacio si la ficha no se cita por numero. */
  readonly citas: readonly string[];
  readonly usadoEnCodigo: readonly NormaCitaEnCodigo[];
  /**
   * Cifras o parametros que el codigo toma de esta ficha en vez de fijarlos en su fuente (p. ej. los topes de la
   * estratificacion MIPyME). Heredan el `estadoVerificacion` de la ficha: mientras sea `sin_verificar`, cualquier
   * resultado calculado con ellos se muestra como "pendiente de verificacion legal".
   */
  readonly parametros?: Readonly<Record<string, unknown>>;
}

const ORIGEN = "docs/legal/verificacion-legal.md del repo original de licitaciones (dato heredado; no se re-contrasto contra el texto oficial al crear esta ficha)";
const DOM = "packages/domain-licitaciones/src";

export const NORMAS_LICITACIONES: readonly NormaFicha[] = [
  {
    id: "laassp-2025-49",
    ley: "LAASSP",
    instrumento: "Ley de Adquisiciones, Arrendamientos y Servicios del Sector Publico (nueva, DOF 16-abr-2025)",
    articulo: "49",
    titulo: "Contenido del fallo y procedencia de la inconformidad",
    vigencia: "vigente",
    publicacionDof: "2025-04-16",
    entradaEnVigor: "2025-04-17",
    queAsumeElCodigo: "El fallo es el acto que se impugna con la inconformidad y debe expresar las razones de desechamiento; los fundamentos del borrador de inconformidad lo citan.",
    estadoVerificacion: "verificado_en_repo_origen",
    validarConAbogado: true,
    fuente: ORIGEN,
    nota: "El texto de la fraccion I que cita el borrador viene del repo original. Validar con abogado antes de presentar cualquier escrito.",
    citas: ["LAASSP 49"],
    usadoEnCodigo: [{ archivo: `${DOM}/inconformidad.ts`, texto: "Art. 49" }],
  },
  {
    id: "laassp-2025-73",
    ley: "LAASSP",
    instrumento: "Ley de Adquisiciones, Arrendamientos y Servicios del Sector Publico (nueva, DOF 16-abr-2025)",
    articulo: "73",
    titulo: "Plazo de pago al proveedor",
    vigencia: "vigente",
    publicacionDof: "2025-04-16",
    entradaEnVigor: "2025-04-17",
    queAsumeElCodigo: "El pago se hace dentro de los 17 dias habiles siguientes a la verificacion de la factura.",
    estadoVerificacion: "verificado_en_repo_origen",
    validarConAbogado: true,
    fuente: ORIGEN,
    nota: "Aplica a contratos cuya convocatoria se publico desde el 17-abr-2025. Para convocatorias anteriores ver la ficha laassp-2000-pago.",
    citas: ["LAASSP 73"],
    usadoEnCodigo: [
      { archivo: `${DOM}/contract-billing.ts`, texto: "Art. 73" },
      { archivo: `${DOM}/regimen-legal.ts`, texto: "Art. 73" },
    ],
  },
  {
    id: "laassp-2025-95",
    ley: "LAASSP",
    instrumento: "Ley de Adquisiciones, Arrendamientos y Servicios del Sector Publico (nueva, DOF 16-abr-2025)",
    articulo: "95",
    titulo: "Plazo para presentar la inconformidad",
    vigencia: "vigente",
    publicacionDof: "2025-04-16",
    entradaEnVigor: "2025-04-17",
    queAsumeElCodigo: "La inconformidad se presenta dentro de 6 dias habiles desde la notificacion del acto (10 en licitaciones internacionales bajo tratados).",
    estadoVerificacion: "verificado_en_repo_origen",
    validarConAbogado: true,
    fuente: ORIGEN,
    nota: "Aplica a convocatorias publicadas desde el 17-abr-2025. El computo de dias habiles usa el calendario de L-22; validar el computo con abogado.",
    citas: ["LAASSP 95"],
    usadoEnCodigo: [
      { archivo: `${DOM}/inconformidad.ts`, texto: "Art. 95" },
      { archivo: `${DOM}/regimen-legal.ts`, texto: "Art. 95" },
    ],
  },
  {
    id: "laassp-2000-pago",
    ley: "LAASSP",
    instrumento: "Ley de Adquisiciones, Arrendamientos y Servicios del Sector Publico (2000, abrogada)",
    articulo: null,
    titulo: "Plazo de pago al proveedor (regimen abrogado)",
    vigencia: "abrogada",
    publicacionDof: null,
    entradaEnVigor: null,
    queAsumeElCodigo: "Para convocatorias publicadas antes del 17-abr-2025 el pago se cuenta en 20 dias NATURALES (no habiles) desde la verificacion de la factura.",
    estadoVerificacion: "sin_verificar",
    validarConAbogado: true,
    fuente: "Referencia del propio codigo (contract-billing.ts, antes de L-23) al regimen abrogado: 20 dias naturales.",
    nota: "NO se conoce con certeza el numero de articulo ni la fecha DOF de la ley abrogada: no se citan. Confirmar con abogado el articulo, el plazo y la regla de transicion antes de confiar en el vencimiento.",
    citas: [],
    usadoEnCodigo: [{ archivo: `${DOM}/regimen-legal.ts`, texto: "20 dias naturales" }],
  },
  {
    id: "laassp-2000-inconformidad",
    ley: "LAASSP",
    instrumento: "Ley de Adquisiciones, Arrendamientos y Servicios del Sector Publico (2000, abrogada)",
    articulo: null,
    titulo: "Plazo de inconformidad (regimen abrogado)",
    vigencia: "abrogada",
    publicacionDof: null,
    entradaEnVigor: null,
    queAsumeElCodigo: "Nada: el codigo NO calcula el plazo de inconformidad de una convocatoria del regimen abrogado y lo declara (validar con abogado).",
    estadoVerificacion: "sin_verificar",
    validarConAbogado: true,
    fuente: "No hay fuente verificada en este repo para el plazo del regimen abrogado.",
    nota: "Se prefiere negar el calculo antes que presentar un plazo no verificado: un plazo de inconformidad mal contado puede hacer perder el recurso.",
    citas: [],
    usadoEnCodigo: [{ archivo: `${DOM}/regimen-legal.ts`, texto: "validar con abogado" }],
  },
  {
    id: "laassp-2025-regimen-transitorio",
    ley: "LAASSP",
    instrumento: "Ley de Adquisiciones, Arrendamientos y Servicios del Sector Publico (nueva, DOF 16-abr-2025)",
    articulo: null,
    titulo: "Que ley rige un procedimiento iniciado antes de la entrada en vigor",
    vigencia: "por_confirmar",
    publicacionDof: "2025-04-16",
    entradaEnVigor: "2025-04-17",
    queAsumeElCodigo: "El regimen se decide por la fecha de publicacion de la convocatoria: desde el 17-abr-2025 rige la ley nueva; antes, la abrogada (REQ-050).",
    estadoVerificacion: "sin_verificar",
    validarConAbogado: true,
    fuente: "Criterio de producto REQ-050; no se verifico el articulo transitorio aplicable.",
    nota: "Se desconoce el numero del transitorio que fija la regla. Casos limite (convocatorias reanudadas, modificaciones a las bases, contratos plurianuales) requieren abogado.",
    citas: [],
    usadoEnCodigo: [{ archivo: `${DOM}/regimen-legal.ts`, texto: "LAASSP_2025_ENTRADA_EN_VIGOR" }],
  },
  {
    id: "laassp-2025-plazos-firma-garantia",
    ley: "LAASSP",
    instrumento: "Ley de Adquisiciones, Arrendamientos y Servicios del Sector Publico (nueva, DOF 16-abr-2025)",
    articulo: null,
    titulo: "Plazos de firma del contrato y de entrega de la garantia de cumplimiento",
    vigencia: "por_confirmar",
    publicacionDof: "2025-04-16",
    entradaEnVigor: "2025-04-17",
    queAsumeElCodigo: "Nada sobre cuantos dias son: la organizacion declara los dias del plazo de firma y de entrega de garantia segun las bases o el fallo, y el codigo solo los cuenta como dias habiles contra el calendario efectivo (L-22).",
    estadoVerificacion: "sin_verificar",
    validarConAbogado: true,
    fuente: "Sin fuente consultada: el numero de articulo, el numero de dias y si se cuentan habiles o naturales NO se verificaron contra el texto oficial.",
    nota: "Si la norma o las bases cuentan dias naturales, la fecha limite calculada puede diferir: la pantalla lo declara y pide validar con abogado. No se cita ningun articulo hasta contar con una ficha verificada.",
    citas: [],
    usadoEnCodigo: [{ archivo: `${DOM}/post-adjudicacion.ts`, texto: "PLAZOS_POST_ADJUDICACION_NORMA_ID" }],
  },
  {
    id: "cff-32-D",
    ley: "CFF",
    instrumento: "Codigo Fiscal de la Federacion",
    articulo: "32-D",
    titulo: "Opinion de cumplimiento de obligaciones fiscales",
    vigencia: "vigente",
    publicacionDof: null,
    entradaEnVigor: null,
    queAsumeElCodigo: "La convocante puede exigir la opinion de cumplimiento (32-D) como documento de la propuesta; el motor de requisitos la reconoce como tema `opinion_cumplimiento_sat`.",
    estadoVerificacion: "sin_verificar",
    validarConAbogado: true,
    fuente: "https://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf (no se contrasto el articulo al crear esta ficha)",
    nota: "El codigo solo reconoce la mencion en las bases; no calcula vigencia de la opinion ni su sentido. Fecha de ultima reforma sin verificar.",
    citas: ["CFF 32-D"],
    usadoEnCodigo: [{ archivo: `${DOM}/requirement-matrix.ts`, texto: "32-d" }],
  },
  {
    id: "cff-69-B",
    ley: "CFF",
    instrumento: "Codigo Fiscal de la Federacion",
    articulo: "69-B",
    titulo: "Operaciones inexistentes (lista de contribuyentes EFOS)",
    vigencia: "vigente",
    publicacionDof: null,
    entradaEnVigor: null,
    queAsumeElCodigo: "El KYC de licitaciones consulta la lista publicada por el SAT y distingue presunto, definitivo, desvirtuado y sentencia favorable; no es una constancia oficial.",
    estadoVerificacion: "sin_verificar",
    validarConAbogado: true,
    fuente: "https://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf (no se contrasto el articulo al crear esta ficha)",
    nota: "La ficha equivalente de Likida (normas/cff-69-B.yaml) esta verificada contra la fuente primaria, pero esa verificacion no se hereda aqui hasta contrastarla.",
    citas: ["CFF 69-B"],
    usadoEnCodigo: [
      { archivo: `${DOM}/kyc-69b.ts`, texto: "69-B" },
      { archivo: "apps/web/src/verticals/licitaciones/pages/Kyc69b.tsx", texto: "69-B" },
    ],
  },
  {
    id: "ldcmipyme-estratificacion",
    ley: "LDCMIPYME",
    instrumento: "Ley para el Desarrollo de la Competitividad de la Micro, Pequena y Mediana Empresa y acuerdo de estratificacion publicado en el DOF",
    articulo: null,
    titulo: "Estratificacion de empresas por numero de trabajadores y ventas anuales (REQ-109)",
    vigencia: "por_confirmar",
    publicacionDof: null,
    entradaEnVigor: null,
    queAsumeElCodigo:
      "El tamano se calcula con un puntaje combinado = trabajadores x peso_trabajadores + ventas anuales (millones de pesos) x peso_ventas, y la empresa cae en el primer estrato cuyo tope de trabajadores, de ventas y de puntaje combinado cumple; si no cumple ninguno, es grande. Los pesos y los topes salen de `parametros`, no del codigo.",
    estadoVerificacion: "sin_verificar",
    validarConAbogado: true,
    fuente: "Sin fuente consultada al crear la ficha: los pesos y topes de `parametros` los capturo quien escribio esta ficha de memoria del acuerdo de 2009 y NO se contrastaron contra el texto vigente.",
    nota: "Confirmar con abogado (a) que el acuerdo de estratificacion sigue vigente, (b) cada peso y tope por sector y (c) como se combinan los rangos con el tope combinado. Hasta entonces la pantalla muestra el resultado como pendiente de verificacion legal y el manifiesto MIPyME no debe presentarse sin esa revision.",
    citas: [],
    usadoEnCodigo: [{ archivo: `${DOM}/mipyme.ts`, texto: "ldcmipyme-estratificacion" }],
    parametros: {
      pesoTrabajadores: "0.10",
      pesoVentas: "0.90",
      /** Orden de evaluacion: del estrato mas chico al mas grande. `ventasMaxMdp` y `topeCombinado` en millones de pesos. */
      estratos: [
        { estrato: "micro", porSector: { industria: { trabajadoresMax: 10, ventasMaxMdp: "4", topeCombinado: "4.6" }, comercio: { trabajadoresMax: 10, ventasMaxMdp: "4", topeCombinado: "4.6" }, servicios: { trabajadoresMax: 10, ventasMaxMdp: "4", topeCombinado: "4.6" } } },
        { estrato: "pequena", porSector: { industria: { trabajadoresMax: 50, ventasMaxMdp: "100", topeCombinado: "95" }, comercio: { trabajadoresMax: 30, ventasMaxMdp: "100", topeCombinado: "93" }, servicios: { trabajadoresMax: 50, ventasMaxMdp: "100", topeCombinado: "95" } } },
        { estrato: "mediana", porSector: { industria: { trabajadoresMax: 250, ventasMaxMdp: "250", topeCombinado: "250" }, comercio: { trabajadoresMax: 100, ventasMaxMdp: "250", topeCombinado: "235" }, servicios: { trabajadoresMax: 100, ventasMaxMdp: "250", topeCombinado: "235" } } },
      ],
    },
  },
  {
    id: "rlaassp-reglamento",
    ley: "RLAASSP",
    instrumento: "Reglamento de la Ley de Adquisiciones, Arrendamientos y Servicios del Sector Publico",
    articulo: null,
    titulo: "Reglamento de la LAASSP (sin articulos citados)",
    vigencia: "por_confirmar",
    publicacionDof: null,
    entradaEnVigor: null,
    queAsumeElCodigo: "Nada: el codigo no cita articulos del reglamento. La ficha existe para que cualquier cita futura tenga donde anclarse.",
    estadoVerificacion: "sin_verificar",
    validarConAbogado: true,
    fuente: "Sin fuente consultada.",
    nota: "No se verifico si el reglamento vigente fue actualizado a la ley de 2025. Antes de citar un articulo del reglamento, agregar su ficha.",
    citas: [],
    usadoEnCodigo: [],
  },
];

export function fichaNormaPorId(id: string): NormaFicha | undefined {
  return NORMAS_LICITACIONES.find((f) => f.id === id);
}

/** Fichas que respaldan una cita normalizada ("LAASSP 73"). */
export function fichasParaCita(cita: string): readonly NormaFicha[] {
  return NORMAS_LICITACIONES.filter((f) => f.citas.includes(cita));
}

/**
 * Extrae las citas normalizadas ("LAASSP 73", "CFF 69-B") de un texto: "Art. 73 LAASSP", "art. 69-B del
 * CFF", "LAASSP nueva, Art. 95" y las menciones sueltas de "69-B"/"32-D" (que en este vertical son
 * siempre del CFF). Es la base de la prueba que ata el codigo al registro.
 */
export function extraerCitasNormativas(texto: string): readonly string[] {
  const out = new Set<string>();
  const art = "(\\d{1,3}(?:-[A-Z])?)";
  const delante = new RegExp(`\\b[Aa]rt(?:[íi]culo|\\.)?s?\\.?\\s*${art}\\b[^\\n]{0,40}?\\b(RLAASSP|LAASSP|CFF)\\b`, "g");
  const detras = new RegExp(`\\b(RLAASSP|LAASSP|CFF)\\b[^\\n.]{0,30}?\\b[Aa]rt(?:[íi]culo|\\.)\\s*${art}\\b`, "g");
  for (const m of texto.matchAll(delante)) out.add(`${m[2]} ${m[1]}`);
  for (const m of texto.matchAll(detras)) out.add(`${m[1]} ${m[2]}`);
  for (const m of texto.matchAll(/(?<![\w-])(69-B|32-D)(?![\w-])/gi)) out.add(`CFF ${m[1]!.toUpperCase()}`);
  return [...out].sort();
}
