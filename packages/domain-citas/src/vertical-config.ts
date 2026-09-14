// Configuración por RUBRO del motor de citas — port de
// citas-reservaciones/supabase/functions/_shared/vertical-config.ts. El motor
// sigue siendo UNO SOLO ("cada rubro tiene cosas enfocadas en él pero es el mismo
// motor"): nunca se bifurca código por rubro, solo los DATOS que este archivo
// expone. `citas.tenant_config.rubro` (001_citas_schema.sql) ya modela EXACTAMENTE
// el mismo conjunto de 14 rubros que el `Vertical` de este archivo — no una
// coincidencia: es la migración de Fase 1 la que ya portó ese enum tal cual del
// origen (ver el comentario de esa migración).
//
// Puerto real (no solo el nombre) de dos piezas de atiende.ai:
//   - FAQs canónicas: src/lib/actions/industry-actions.ts
//   - Guardrail de crisis: src/lib/guardrails/validate.ts (CAPA 3: lista real de
//     palabras clave + mensaje de crisis) y el criterio `isHealth` de
//     src/lib/actions/engine.ts (qué verticales lo reciben).

export type Vertical =
  | "medico"
  | "dental"
  | "barberia"
  | "salon"
  | "spa"
  | "veterinaria"
  | "restaurante"
  | "psicologo"
  | "gimnasio"
  | "farmacia"
  | "escuela"
  | "seguros"
  | "mecanico"
  | "otro";

export const ALL_VERTICALS: readonly Vertical[] = [
  "medico",
  "dental",
  "barberia",
  "salon",
  "spa",
  "veterinaria",
  "restaurante",
  "psicologo",
  "gimnasio",
  "farmacia",
  "escuela",
  "seguros",
  "mecanico",
  "otro",
];

// ============================================================================
// Guardrail de crisis — SOLO rubros de salud, y SIEMPRE determinista (nunca
// delegado al LLM). Puerto directo del criterio `isHealth` real de
// atiende.ai/src/lib/actions/engine.ts (ahí: dental, medical, veterinary,
// psychologist, pediatrician, gynecologist, ophthalmologist, dermatologist,
// nutritionist — de esos, este motor solo modela medico/dental/psicologo/
// veterinaria como rubros propios; los demás no existen aquí todavía).
// barberia/salon/spa/restaurante/gimnasio/farmacia/escuela/seguros/mecanico/otro
// NUNCA reciben este guardrail: no son profesionales de salud, y activarlo ahí
// generaría falsos positivos costosos y confusos.
// ============================================================================

const CRISIS_GUARDRAIL_VERTICALS: ReadonlySet<Vertical> = new Set<Vertical>(["medico", "dental", "psicologo", "veterinaria"]);

export function requiresCrisisGuardrail(rubro: string): boolean {
  return CRISIS_GUARDRAIL_VERTICALS.has(rubro as Vertical);
}

/**
 * Quita acentos y pasa a minúsculas antes de comparar — mismo criterio que
 * `normalizeForMedicalCheck` en atiende.ai/src/lib/guardrails/validate.ts: "no lo
 * aguanto más" y "no lo aguanto mas" deben matchear igual.
 */
export function normalizeForCrisisCheck(text: string): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Lista real portada de validate.ts (CAPA 3: protocolo de crisis) — ya normalizada
 * (sin acentos, minúsculas) para compararse contra el mensaje del cliente pasado
 * por `normalizeForCrisisCheck`.
 */
export const CRISIS_KEYWORDS: readonly string[] = [
  "quiero morirme",
  "no quiero vivir",
  "suicidarme",
  "suicidio",
  "me quiero matar",
  "matarme",
  "no le veo sentido",
  "me corto",
  "me lastimo",
  "hacerme dano",
  "me hago dano",
  "quiero hacerme dano",
  "estarian mejor sin mi",
  "ya no puedo mas",
  "ya no aguanto",
  "pensando en morir",
  "terminar con todo",
  "acabar con mi vida",
];

/** Devuelve la palabra clave real que matcheó, o null si el mensaje no trae ninguna. */
export function detectCrisisKeyword(message: string): string | null {
  const normalized = normalizeForCrisisCheck(message);
  return CRISIS_KEYWORDS.find((word) => normalized.includes(word)) ?? null;
}

// Mismo mensaje real de atiende.ai/src/lib/guardrails/validate.ts (CRISIS_MESSAGE)
// — líneas de ayuda reales mexicanas (Línea de la Vida, SAPTEL) + 911. Se agrega
// una línea final propia de este motor de citas (la escalación humana YA se
// disparó del lado del servidor, no es una promesa vacía).
export const CRISIS_ESCALATION_MESSAGE =
  "Entiendo que estás pasando por un momento muy difícil. Tu vida importa. " +
  "Por favor contacta la Línea de la Vida: 800 911 2000 (24/7) o SAPTEL: 55 5259 8121. " +
  "Si es una emergencia, llama al 911. " +
  "Ya avisé a nuestro equipo para que te contacten. No estás solo/a.";

// ============================================================================
// FAQs canónicas por rubro — grounding real que se agrega al prompt del agente
// (nunca inventadas por el LLM en tiempo real): "mismo motor, datos distintos por
// rubro", tal como lo pidió Javier.
// ============================================================================

export interface VerticalFaq {
  /** Palabras clave (minúsculas, sin acentos) que identifican esta pregunta. */
  readonly keywords: readonly string[];
  readonly question: string;
  readonly answer: string;
}

export const VERTICAL_FAQS: Readonly<Record<Vertical, readonly VerticalFaq[]>> = {
  medico: [
    {
      keywords: ["resultado", "estudio"],
      question: "¿Ya tienen mis resultados de laboratorio o estudio?",
      answer: "Los resultados de estudios se entregan en consultorio por confidencialidad. ¿Le gustaría agendar una cita de seguimiento con el doctor para revisarlos?",
    },
  ],
  dental: [
    {
      keywords: ["radiografia", "rayos x"],
      question: "¿Qué necesito para una radiografía dental?",
      answer: "Para estudios de radiografía dental necesitará identificación oficial y, si aplica, la orden del dentista. El estudio se realiza en consultorio. ¿Le agendo una cita?",
    },
  ],
  barberia: [
    {
      keywords: ["color", "tinte", "mechas", "balayage"],
      question: "¿Hacen color o tinte?",
      answer: "Para servicios de color le recomendamos una valoración previa (sin costo) para determinar el mejor tratamiento para su cabello. ¿Le agendo una valoración?",
    },
    {
      keywords: ["producto", "shampoo", "tratamiento capilar"],
      question: "¿Venden productos?",
      answer: "Tenemos productos profesionales disponibles para venta. Puede adquirirlos en su próxima visita. ¿Qué tipo de producto busca?",
    },
  ],
  salon: [
    {
      keywords: ["color", "tinte", "mechas", "balayage"],
      question: "¿Hacen color o tinte?",
      answer: "Para servicios de color le recomendamos una valoración previa (sin costo) para determinar el mejor tratamiento para su cabello. ¿Le agendo una valoración?",
    },
    {
      keywords: ["producto", "shampoo", "tratamiento capilar"],
      question: "¿Venden productos?",
      answer: "Tenemos productos profesionales disponibles para venta. Puede adquirirlos en su próxima visita. ¿Qué tipo de producto busca?",
    },
  ],
  spa: [
    {
      keywords: ["pareja", "duo", "aniversario"],
      question: "¿Tienen paquetes para parejas?",
      answer: "¡Tenemos paquetes especiales para parejas! Incluyen masaje relajante, facial y acceso a área húmeda. ¿Le gustaría conocer precios y disponibilidad?",
    },
    {
      keywords: ["regalo", "gift", "tarjeta de regalo"],
      question: "¿Venden tarjetas de regalo?",
      answer: "¡Excelente idea! Ofrecemos tarjetas de regalo personalizadas. ¿Para qué monto le gustaría y a nombre de quién?",
    },
  ],
  veterinaria: [
    {
      keywords: ["vacuna", "cachorro", "gatito", "desparasit"],
      question: "¿Qué vacunas necesita mi cachorro o gatito?",
      answer: "Cachorros: primera vacuna a las 6-8 semanas. Gatitos: primera vacuna a las 8 semanas. ¿Qué edad tiene su mascota? Le indico qué vacunas necesita y agendamos.",
    },
  ],
  restaurante: [
    {
      keywords: ["alergia", "alergic", "celiac", "gluten"],
      question: "Tengo una alergia alimentaria",
      answer: "Tomamos las alergias muy en serio. Indíquenos exactamente a qué es alérgico y verificaremos cada ingrediente de su orden. ¿Qué alergia tiene?",
    },
  ],
  psicologo: [
    {
      keywords: ["primera vez", "primera sesion", "nunca he ido"],
      question: "Es mi primera vez, ¿cómo funciona?",
      answer: "Es completamente normal sentir inquietud antes de la primera sesión. La sesión dura 50 minutos, es totalmente confidencial, usted habla de lo que necesite y no hay juicio, solo escucha profesional. ¿Le gustaría agendar su primera sesión?",
    },
    {
      keywords: ["online", "en linea", "virtual", "videollamada"],
      question: "¿Dan sesiones en línea?",
      answer: "Sí, ofrecemos sesiones en línea por videollamada, con la misma confidencialidad que una sesión presencial. ¿Prefiere presencial o en línea?",
    },
  ],
  gimnasio: [
    {
      keywords: ["prueba", "trial", "probar", "conocer"],
      question: "¿Puedo probar antes de inscribirme?",
      answer: "¡Claro! Ofrecemos un día de prueba gratis para que conozca nuestras instalaciones. Solo necesita identificación oficial, ropa deportiva y toalla. ¿Qué día le gustaría venir?",
    },
    {
      keywords: ["clase", "zumba", "yoga", "spinning"],
      question: "¿Qué horario tienen las clases?",
      answer: "Nuestras clases grupales están incluidas en todas las membresías. ¿Qué tipo de clase le interesa? Le comparto el horario de esa disciplina.",
    },
  ],
  farmacia: [
    {
      keywords: ["receta", "controlado", "antibiotico"],
      question: "¿Necesito receta para ese medicamento?",
      answer: "Los medicamentos controlados y antibióticos requieren receta médica vigente. Puede traerla o enviar foto de la receta por este chat para verificar disponibilidad. ¿Tiene receta?",
    },
    {
      keywords: ["envio", "domicilio", "entrega"],
      question: "¿Hacen envío a domicilio?",
      answer: "Sí, hacemos envío a domicilio. ¿Qué productos necesita?",
    },
  ],
  escuela: [
    {
      keywords: ["inscripcion", "requisitos"],
      question: "¿Qué necesito para inscribirme?",
      answer: "Documentos para inscripción: acta de nacimiento, CURP, boleta del ciclo anterior, 2 fotografías tamaño infantil y comprobante de domicilio. ¿Para qué nivel sería la inscripción?",
    },
    {
      keywords: ["beca", "descuento", "apoyo"],
      question: "¿Tienen becas?",
      answer: "Contamos con programa de becas: solicitud formal, estudio socioeconómico y evaluación académica. ¿Le gustaría que le agende una cita con el departamento de becas?",
    },
  ],
  seguros: [
    {
      keywords: ["cotiza", "cuanto cuesta", "precio seguro"],
      question: "¿Cuánto cuesta un seguro?",
      answer: "Con gusto le cotizo. Necesito: qué tipo de seguro (auto, vida, gastos médicos, hogar), para quién (individual o familiar) y la cobertura deseada.",
    },
  ],
  mecanico: [
    {
      keywords: ["ruido", "falla", "no prende", "freno", "aceite"],
      question: "Mi auto tiene un ruido o falla, ¿qué hago?",
      answer: "Para un diagnóstico preciso necesitamos revisar su vehículo en persona. Si el vehículo no enciende o hay humo, NO lo maneje — solicite grúa. ¿Le agendo una cita de diagnóstico?",
    },
  ],
  otro: [],
};

export function getVerticalFaqs(rubro: string): readonly VerticalFaq[] {
  return VERTICAL_FAQS[rubro as Vertical] ?? VERTICAL_FAQS.otro;
}

/** Primera FAQ del rubro cuyo keyword aparece en el mensaje, o null. */
export function findVerticalFaqAnswer(rubro: string, message: string): VerticalFaq | null {
  const normalized = normalizeForCrisisCheck(message);
  const faqs = getVerticalFaqs(rubro);
  return faqs.find((faq) => faq.keywords.some((keyword) => normalized.includes(keyword))) ?? null;
}
