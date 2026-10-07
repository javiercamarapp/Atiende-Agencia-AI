// Rn-36 -- checklist de onboarding de una organizacion de rentas, calculado con DATOS REALES (nunca con una casilla que el
// usuario marca a mano). Funcion pura: recibe los conteos que lee el repositorio y devuelve cada punto con su estado.
//
// Un conteo `null` significa "esta base todavia no tiene la tabla (migracion pendiente) o el rol no puede leerla": el punto sale
// como `no_disponible` y NUNCA como `hecho` ni como `pendiente` (no se afirma lo que no se pudo medir). El bloque no cuenta para
// el progreso ni para `listoParaOperar`.

export type ClaveOnboardingRentas = "ical" | "tarifa_base" | "reglas_comision" | "acceso_huesped" | "staff" | "propietarios" | "plantilla";

export type EstadoPuntoOnboarding = "hecho" | "pendiente" | "no_disponible";

export interface DatosOnboardingRentas {
  /** Unidades de la organizacion (toda). `null` = no medible. */
  readonly unidades: number | null;
  /**
   * Feeds iCal: activos, de ellos los que estan en cuarentena (dejaron de responder: no cuentan como conectados) y los que, sin estar
   * en cuarentena, ya sincronizaron con exito al menos una vez.
   */
  readonly feeds: { readonly activos: number; readonly enCuarentena: number; readonly sincronizados: number } | null;
  /** Unidades con al menos una tarifa base vigente. */
  readonly unidadesConTarifaBase: number | null;
  /** Reglas de comision de canal CONFIRMADAS por la organizacion (las sugeridas que nacen con ella, fuente `default_sugerido...`, no cuentan). */
  readonly reglasComision: number | null;
  /** Propiedades con la politica de liberacion de acceso activa. */
  readonly propiedadesConAccesoActivo: number | null;
  /** Staff: miembros de la organizacion e invitaciones pendientes. */
  readonly staff: { readonly miembros: number; readonly invitacionesPendientes: number } | null;
  /** Propietarios dados de alta en la organizacion. */
  readonly propietarios: number | null;
  /** Plantillas de mensajeria activas y aprobadas por la organizacion. */
  readonly plantillasAprobadas: number | null;
}

export interface PuntoOnboardingRentas {
  readonly clave: ClaveOnboardingRentas;
  readonly titulo: string;
  readonly descripcion: string;
  readonly estado: EstadoPuntoOnboarding;
  /** Que se midio, con cifras reales ("2 de 3 unidades con tarifa"). `null` cuando no se pudo medir. */
  readonly detalle: string | null;
  /** Pantalla del panel que resuelve el punto (segmento relativo a `/rentas/:org/`). */
  readonly pantalla: string;
  /** Un obligatorio pendiente impide `listoParaOperar`; un recomendado solo suma al progreso. */
  readonly obligatorio: boolean;
}

export interface ChecklistOnboardingRentas {
  readonly puntos: readonly PuntoOnboardingRentas[];
  /** Puntos medibles (excluye `no_disponible`). */
  readonly medibles: number;
  readonly hechos: number;
  /** 0-100 sobre los puntos medibles; 0 si no hay ninguno medible. */
  readonly porcentaje: number;
  /** `true` si todos los obligatorios medibles estan hechos y al menos uno es medible. */
  readonly listoParaOperar: boolean;
}

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

function punto(base: Omit<PuntoOnboardingRentas, "estado" | "detalle">, medido: { hecho: boolean; detalle: string } | null): PuntoOnboardingRentas {
  if (medido === null) return { ...base, estado: "no_disponible", detalle: null };
  return { ...base, estado: medido.hecho ? "hecho" : "pendiente", detalle: medido.detalle };
}

export function calcularChecklistOnboardingRentas(d: DatosOnboardingRentas): ChecklistOnboardingRentas {
  const puntos: PuntoOnboardingRentas[] = [
    punto(
      { clave: "ical", titulo: "Conectar un calendario iCal", descripcion: "Importa las reservas de Airbnb, Vrbo o Booking para evitar dobles reservas.", pantalla: "ical-sync", obligatorio: true },
      d.feeds === null
        ? null
        : {
            // Un feed en cuarentena (dejo de responder) no es un calendario conectado: si TODOS los activos estan asi, el punto sigue pendiente.
            hecho: d.feeds.activos - d.feeds.enCuarentena > 0,
            detalle:
              d.feeds.activos === 0
                ? "Ningún feed conectado"
                : `${plural(d.feeds.activos, "feed activo", "feeds activos")}, ${d.feeds.sincronizados} ya sincronizado${d.feeds.sincronizados === 1 ? "" : "s"}${d.feeds.enCuarentena > 0 ? `, ${d.feeds.enCuarentena} en cuarentena` : ""}`,
          },
    ),
    punto(
      { clave: "tarifa_base", titulo: "Definir la tarifa base", descripcion: "Cada unidad necesita un precio por noche para cotizar y calcular ingresos.", pantalla: "precios", obligatorio: true },
      d.unidadesConTarifaBase === null || d.unidades === null
        ? null
        : { hecho: d.unidades > 0 && d.unidadesConTarifaBase >= d.unidades, detalle: d.unidades === 0 ? "Aún no hay unidades" : `${d.unidadesConTarifaBase} de ${plural(d.unidades, "unidad", "unidades")} con tarifa` },
    ),
    punto(
      { clave: "reglas_comision", titulo: "Confirmar las reglas de comisión", descripcion: "Los valores sugeridos de cada canal hay que confirmarlos o editarlos: alimentan el movimiento por reserva y el estado de cuenta.", pantalla: "finanzas", obligatorio: true },
      d.reglasComision === null ? null : { hecho: d.reglasComision > 0, detalle: d.reglasComision === 0 ? "Solo valores sugeridos sin confirmar" : plural(d.reglasComision, "regla confirmada", "reglas confirmadas") },
    ),
    punto(
      { clave: "acceso_huesped", titulo: "Definir la política de acceso al huésped", descripcion: "Cuándo y bajo qué condiciones se liberan las instrucciones de llegada.", pantalla: "acceso-huesped", obligatorio: false },
      d.propiedadesConAccesoActivo === null ? null : { hecho: d.propiedadesConAccesoActivo > 0, detalle: d.propiedadesConAccesoActivo === 0 ? "Política inactiva" : plural(d.propiedadesConAccesoActivo, "propiedad con política activa", "propiedades con política activa") },
    ),
    punto(
      { clave: "staff", titulo: "Invitar al equipo", descripcion: "Operadores, limpieza y contador con el rol que les corresponde.", pantalla: "equipo", obligatorio: false },
      d.staff === null
        ? null
        : { hecho: d.staff.miembros > 1 || d.staff.invitacionesPendientes > 0, detalle: `${plural(d.staff.miembros, "miembro", "miembros")}, ${plural(d.staff.invitacionesPendientes, "invitación pendiente", "invitaciones pendientes")}` },
    ),
    punto(
      { clave: "propietarios", titulo: "Dar de alta a los propietarios", descripcion: "Cada unidad se liga a su propietario para liquidar y mostrarle su portal.", pantalla: "catalogo", obligatorio: true },
      d.propietarios === null ? null : { hecho: d.propietarios > 0, detalle: d.propietarios === 0 ? "Sin propietarios" : plural(d.propietarios, "propietario", "propietarios") },
    ),
    punto(
      { clave: "plantilla", titulo: "Aprobar una plantilla de mensaje", descripcion: "Solo las plantillas aprobadas se programan para salir automáticamente.", pantalla: "plantillas", obligatorio: false },
      d.plantillasAprobadas === null ? null : { hecho: d.plantillasAprobadas > 0, detalle: d.plantillasAprobadas === 0 ? "Ninguna plantilla aprobada" : plural(d.plantillasAprobadas, "plantilla aprobada", "plantillas aprobadas") },
    ),
  ];
  const medibles = puntos.filter((p) => p.estado !== "no_disponible");
  const hechos = medibles.filter((p) => p.estado === "hecho").length;
  const obligatoriosMedibles = medibles.filter((p) => p.obligatorio);
  return {
    puntos,
    medibles: medibles.length,
    hechos,
    porcentaje: medibles.length === 0 ? 0 : Math.round((hechos / medibles.length) * 100),
    listoParaOperar: medibles.length > 0 && obligatoriosMedibles.every((p) => p.estado === "hecho"),
  };
}
