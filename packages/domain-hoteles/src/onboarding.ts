// H-P3-06 -- checklist de "Primeros pasos" del hotel: que falta para operar de verdad. Cada punto se CALCULA con datos reales de la
// property (tipos, habitaciones, tarifas, impuestos, politica, zona horaria, aviso de privacidad, canales, equipo, reservas): nunca un
// estado guardado a mano ni un "hecho" por defecto. Lo que no se puede comprobar desde aqui (por ejemplo que el numero de WhatsApp
// pertenezca al hotel en Meta) se declara con `detalle` honesto y no cuenta como verificado. Mismo patron que el R-33 de restaurantes
// (domain-restaurantes/src/onboarding.ts): funcion pura sobre un snapshot + gate.
export type OnboardingEstado = "hecho" | "parcial" | "pendiente";
export type OnboardingResponsable = "dueno" | "plataforma" | "meta";
export type OnboardingPantalla = "catalogo" | "configuracion" | "equipo" | "privacidad" | "mensajeria" | "reservas";

export interface OnboardingItem {
  readonly id: string;
  readonly titulo: string;
  readonly estado: OnboardingEstado;
  /** Un punto obligatorio pendiente bloquea `listoParaOperar` (el gate). */
  readonly obligatorio: boolean;
  readonly detalle: string;
  readonly responsable: OnboardingResponsable;
  readonly pantalla: OnboardingPantalla;
  /** Pestana dentro de la pantalla (solo `configuracion`). */
  readonly pestana?: "impuestos" | "cancelacion" | "sobreventa" | "tarifas";
}

export interface OnboardingGate {
  readonly bloquea: boolean;
  readonly obligatoriosPendientes: number;
  readonly operaConReservas: boolean;
}

export interface OnboardingChecklist {
  readonly items: readonly OnboardingItem[];
  readonly resumen: { readonly hechos: number; readonly total: number; readonly obligatoriosPendientes: number };
  readonly listoParaOperar: boolean;
  readonly gate: OnboardingGate;
  /** Noches (desde hoy) que el checklist exige con tarifa por tipo de habitacion. */
  readonly nochesRequeridas: number;
}

/** REGLA: bloquea solo si faltan puntos obligatorios Y la property aun no tiene reservas. Un hotel que ya opera nunca se desvia. */
export function evaluarGateOnboarding(obligatoriosPendientes: number, reservas: number): OnboardingGate {
  const operaConReservas = reservas > 0;
  return { bloquea: obligatoriosPendientes > 0 && !operaConReservas, obligatoriosPendientes, operaConReservas };
}

export interface OnboardingSnapshot {
  readonly tipos: readonly { readonly id: string; readonly nombre: string; readonly nochesConTarifa: number }[];
  readonly habitaciones: number;
  readonly nochesRequeridas: number;
  readonly impuestosConfigurados: boolean;
  readonly politicaConfigurada: boolean;
  readonly zonaHorariaConfigurada: boolean;
  /** `null` = la base no tiene la migracion de privacidad (no se puede publicar todavia). */
  readonly avisoPublicado: boolean | null;
  readonly whatsapp: { readonly configurado: boolean; readonly habilitado: boolean };
  readonly voz: { readonly configurado: boolean; readonly habilitado: boolean; readonly secretoConfigurado: boolean };
  /** Miembros activos del equipo (incluye a quien consulta). */
  readonly miembros: number;
  readonly invitacionesPendientes: number;
  readonly reservas: number;
}

export const NOCHES_TARIFA_REQUERIDAS = 30;

export function buildHotelOnboardingChecklist(s: OnboardingSnapshot): OnboardingChecklist {
  const items: OnboardingItem[] = [];
  const add = (item: OnboardingItem) => items.push(item);

  add({
    id: "tipos_habitacion",
    titulo: "Tipos de habitación",
    estado: s.tipos.length > 0 ? "hecho" : "pendiente",
    obligatorio: true,
    detalle: s.tipos.length > 0 ? `${s.tipos.length} tipo(s) de habitación creados.` : "Aún no hay ningún tipo de habitación: no se puede cotizar ni reservar.",
    responsable: "dueno",
    pantalla: "catalogo",
  });

  add({
    id: "habitaciones",
    titulo: "Habitaciones físicas",
    estado: s.habitaciones > 0 ? "hecho" : "pendiente",
    obligatorio: true,
    detalle: s.habitaciones > 0 ? `${s.habitaciones} habitación(es) registradas.` : "No hay habitaciones físicas: recepción y housekeeping no tienen qué asignar ni limpiar.",
    responsable: "dueno",
    pantalla: "catalogo",
  });

  const sinTarifa = s.tipos.filter((t) => t.nochesConTarifa < s.nochesRequeridas);
  const tarifasEstado: OnboardingEstado = s.tipos.length === 0 || sinTarifa.length === s.tipos.length ? "pendiente" : sinTarifa.length === 0 ? "hecho" : "parcial";
  add({
    id: "tarifas",
    titulo: `Tarifas para los próximos ${s.nochesRequeridas} días`,
    estado: tarifasEstado,
    obligatorio: true,
    detalle:
      s.tipos.length === 0
        ? "Primero crea los tipos de habitación."
        : tarifasEstado === "hecho"
          ? `Todos los tipos tienen tarifa para las próximas ${s.nochesRequeridas} noches.`
          : `Sin tarifa completa para ${s.nochesRequeridas} noches en: ${sinTarifa.map((t) => `${t.nombre} (${t.nochesConTarifa}/${s.nochesRequeridas})`).join(", ")}.`,
    responsable: "dueno",
    pantalla: "configuracion",
    pestana: "tarifas",
  });

  add({
    id: "impuestos",
    titulo: "Impuestos revisados",
    estado: s.impuestosConfigurados ? "hecho" : "pendiente",
    obligatorio: true,
    detalle: s.impuestosConfigurados
      ? "IVA, ISH y umbral de descuento guardados por el hotel."
      : "Todavía no guardas tus impuestos: confirma IVA e ISH (el ISH depende del estado; verifícalo con tu contador).",
    responsable: "dueno",
    pantalla: "configuracion",
    pestana: "impuestos",
  });

  add({
    id: "politica_cancelacion",
    titulo: "Política de cancelación",
    estado: s.politicaConfigurada ? "hecho" : "pendiente",
    obligatorio: true,
    detalle: s.politicaConfigurada ? "Horas libres, penalidad y texto para el huésped guardados." : "Aún no defines cuándo es gratis cancelar ni la penalidad: se usan los valores por omisión.",
    responsable: "dueno",
    pantalla: "configuracion",
    pestana: "cancelacion",
  });

  add({
    id: "zona_horaria",
    titulo: "Zona horaria del hotel",
    estado: s.zonaHorariaConfigurada ? "hecho" : "pendiente",
    obligatorio: false,
    detalle: s.zonaHorariaConfigurada ? "El hotel tiene su zona horaria propia." : "Sin zona horaria propia se usa la de Ciudad de México: confírmala si tu hotel está en otra (Cancún, Los Cabos, Tijuana).",
    responsable: "dueno",
    pantalla: "catalogo",
  });

  add({
    id: "aviso_privacidad",
    titulo: "Aviso de privacidad publicado",
    estado: s.avisoPublicado === true ? "hecho" : "pendiente",
    obligatorio: false,
    detalle:
      s.avisoPublicado === true
        ? "Hay un aviso de privacidad vigente."
        : s.avisoPublicado === null
          ? "No disponible aún: requiere aplicar la migración de privacidad."
          : "Publica tu aviso de privacidad antes de recabar datos de huéspedes.",
    responsable: "dueno",
    pantalla: "privacidad",
  });

  const whatsappEstado: OnboardingEstado = s.whatsapp.configurado && s.whatsapp.habilitado ? "hecho" : s.whatsapp.configurado ? "parcial" : "pendiente";
  add({
    id: "whatsapp",
    titulo: "WhatsApp conectado",
    estado: whatsappEstado,
    obligatorio: false,
    detalle:
      whatsappEstado === "hecho"
        ? "Número registrado y habilitado. No se verifica contra Meta desde aquí: prueba mandando un mensaje."
        : whatsappEstado === "parcial"
          ? "Hay un número registrado pero el canal está apagado."
          : "Sin número de WhatsApp: el agente no recibe mensajes de huéspedes. Requiere el número y las credenciales de Meta.",
    responsable: "meta",
    pantalla: "mensajeria",
  });

  const vozEstado: OnboardingEstado = s.voz.configurado && s.voz.habilitado && s.voz.secretoConfigurado ? "hecho" : s.voz.configurado || s.voz.secretoConfigurado ? "parcial" : "pendiente";
  add({
    id: "voz",
    titulo: "Agente de voz",
    estado: vozEstado,
    obligatorio: false,
    detalle:
      vozEstado === "hecho"
        ? "Voz habilitada con su secreto."
        : vozEstado === "parcial"
          ? "La voz está a medias: falta habilitarla o generar su secreto."
          : "La voz no está configurada: genera su secreto y habilítala desde Mensajería.",
    responsable: "plataforma",
    pantalla: "mensajeria",
  });

  add({
    id: "equipo",
    titulo: "Al menos un miembro del equipo",
    estado: s.miembros > 1 ? "hecho" : s.invitacionesPendientes > 0 ? "parcial" : "pendiente",
    obligatorio: false,
    detalle:
      s.miembros > 1
        ? `${s.miembros} personas en el equipo.`
        : s.invitacionesPendientes > 0
          ? `${s.invitacionesPendientes} invitación(es) pendiente(s) de aceptar.`
          : "Solo tú tienes acceso: invita a recepción, housekeeping o contabilidad.",
    responsable: "dueno",
    pantalla: "equipo",
  });

  add({
    id: "reserva_prueba",
    titulo: "Reserva de prueba",
    estado: s.reservas > 0 ? "hecho" : "pendiente",
    obligatorio: false,
    detalle: s.reservas > 0 ? `${s.reservas} reserva(s) registradas.` : "Aún no hay reservas: crea una de prueba para comprobar cotización, folio y cancelación.",
    responsable: "dueno",
    pantalla: "reservas",
  });

  const hechos = items.filter((i) => i.estado === "hecho").length;
  const obligatoriosPendientes = items.filter((i) => i.obligatorio && i.estado !== "hecho").length;
  return {
    items,
    resumen: { hechos, total: items.length, obligatoriosPendientes },
    listoParaOperar: obligatoriosPendientes === 0,
    gate: evaluarGateOnboarding(obligatoriosPendientes, s.reservas),
    nochesRequeridas: s.nochesRequeridas,
  };
}
