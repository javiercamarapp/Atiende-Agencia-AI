// Validación/normalización pura de la captura de onboarding (Fase 11) -- SIN
// dependencia de infraestructura (ningún import de Postgres/Hono/@atiende/db), mismo
// principio que el resto de domain-rentas/src: la capa de aplicación (apps/api) es la
// única que sabe de HTTP/hashing/sesión de BD.
//
// `validarCapturaOnboardingRentas` es la única función pública de este archivo --
// recibe el body ya parseado de JSON (`unknown`, la ruta HTTP todavía no validó nada
// más que "es un objeto") y devuelve `CapturaOnboardingRentasValidada` o lanza
// `RentasDomainError('onboarding_datos_invalidos', ...)`. Nunca devuelve un objeto a
// medio validar -- o pasan TODAS las reglas, o ninguna escritura ocurre.
import { RentasDomainError } from "../errors.ts";
import type { CapturaOnboardingRentasInput, CapturaOnboardingRentasValidada, CapturaOnboardingUnidadInput, TipoOrganizacionRentas } from "./tipos.ts";

const TIPOS_ORGANIZACION: readonly TipoOrganizacionRentas[] = ["anfitrion", "empresa_gestora"];
const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONEDA_RE = /^[A-Z]{3}$/;
const MONEDA_POR_DEFECTO = "MXN"; // mismo DEFAULT que `rentas.property_config.moneda` (migración 001).
const LONGITUD_MAXIMA_NOMBRE = 200; // mismo tope que `empresaNombre`/`empresaRazonSocial` del origen (apps/api/src/routes/onboarding.ts).
const LONGITUD_MINIMA_PASSWORD = 10; // mismo mínimo que `adminPassword` del origen (CuerpoRegistroEmpresa).

/** Cacheada una sola vez por proceso -- `Intl.supportedValuesOf` recorre el catálogo
 * completo de ICU cada llamada, igual criterio que
 * rentas-standalone/packages/domain/src/fechas.ts::CACHE_ZONAS_VALIDAS (no portado
 * todavía a domain-rentas/src/fechas.ts de este monorepo porque ningún otro flujo de
 * los ya migrados necesita validar CONTENIDO de zona horaria, solo Fase 5 de sync
 * las guarda ya confiando en el valor que trae el feed externo). */
const ZONAS_HORARIAS_VALIDAS = new Set(Intl.supportedValuesOf("timeZone"));

/** Zona horaria IANA real (D-013 del origen) -- nunca un offset fijo ("GMT-6") ni una
 * cadena arbitraria. `"UTC"` se acepta aparte porque algunos motores ICU no la listan
 * dentro de `supportedValuesOf("timeZone")` pese a ser válida (mismo caso ya
 * documentado en el origen). */
function esZonaHorariaIanaValida(zona: string): boolean {
  return zona.length > 0 && (ZONAS_HORARIAS_VALIDAS.has(zona) || zona === "UTC");
}

function requiereTexto(valor: unknown, campo: string, maximo = LONGITUD_MAXIMA_NOMBRE): string {
  if (typeof valor !== "string" || valor.trim().length === 0) {
    throw new RentasDomainError("onboarding_datos_invalidos", `${campo}: se requiere un texto no vacío.`);
  }
  const recortado = valor.trim();
  if (recortado.length > maximo) {
    throw new RentasDomainError("onboarding_datos_invalidos", `${campo}: máximo ${maximo} caracteres (recibido ${recortado.length}).`);
  }
  return recortado;
}

/** Deriva un slug url-safe de `core.organization.slug`
 * (`^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$`, migración 0001_core_schema.sql) a partir
 * del nombre capturado -- SOLO un candidato: la colisión final (¿ya existe ese slug?)
 * la resuelve el repositorio (./repository.ts), que sí puede consultar la tabla. */
export function slugificarNombreOrganizacion(nombre: string): string {
  const normalizado = nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita marcas diacriticas combinadas (rango Unicode explicito -- e-acento tras NFD arriba queda como "e" simple).
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 98); // dentro del tope de 100 del CHECK, deja margen para un sufijo de colisión (ver repository.ts).
  if (normalizado.length === 0) {
    throw new RentasDomainError("onboarding_datos_invalidos", "organizacion.nombre: debe incluir al menos un carácter alfanumérico para poder generar un identificador público (slug).");
  }
  return normalizado;
}

function validarTipoOrganizacion(valor: unknown): TipoOrganizacionRentas {
  if (valor === undefined) return "anfitrion"; // mismo DEFAULT que la columna Postgres (migración 001).
  if (typeof valor !== "string" || !TIPOS_ORGANIZACION.includes(valor as TipoOrganizacionRentas)) {
    throw new RentasDomainError("onboarding_datos_invalidos", `organizacion.tipoOrganizacion: debe ser uno de ${TIPOS_ORGANIZACION.join(", ")} (recibido ${JSON.stringify(valor)}).`);
  }
  return valor as TipoOrganizacionRentas;
}

function validarCorreo(valor: unknown, campo: string): string {
  const texto = requiereTexto(valor, campo, 320); // 320 = tope práctico de RFC 5321 para una dirección completa.
  const normalizado = texto.toLowerCase();
  if (!CORREO_RE.test(normalizado)) {
    throw new RentasDomainError("onboarding_datos_invalidos", `${campo}: correo inválido.`);
  }
  return normalizado;
}

function validarMoneda(valor: unknown): string {
  if (valor === undefined) return MONEDA_POR_DEFECTO;
  if (typeof valor !== "string" || !MONEDA_RE.test(valor)) {
    throw new RentasDomainError("onboarding_datos_invalidos", `primeraPropiedad.moneda: se espera un código ISO 4217 de 3 letras mayúsculas (recibido ${JSON.stringify(valor)}).`);
  }
  return valor;
}

function validarPassword(valor: unknown): void {
  if (typeof valor !== "string" || valor.length < LONGITUD_MINIMA_PASSWORD) {
    throw new RentasDomainError("onboarding_datos_invalidos", `admin.password: mínimo ${LONGITUD_MINIMA_PASSWORD} caracteres.`);
  }
}

const MAX_UNIDADES_ONBOARDING = 50; // tope práctico -- alta masiva real queda para un panel dedicado, fuera de este hallazgo puntual (ver tipos.ts, comentario de CapturaOnboardingUnidadInput).
const MIN_DURACION_MINIMA_NOCHES = 1;
const MAX_DURACION_MINIMA_NOCHES = 365; // mismo tope de sentido común que ../pricing/validacion.ts para reglas de estadía mínima.

/** Al menos 1 unidad (`rentas.unidad`), mismo criterio "nunca a medias" que el resto
 * de esta función -- hallazgo de auditoría: antes de este cambio no existía forma de
 * dar de alta una unidad self-serve, así que una property sin al menos una la deja
 * inútil (calendario/pricing/mensajería cuelgan de `unidad_id`). */
function validarPrimerasUnidades(valor: unknown): readonly CapturaOnboardingUnidadInput[] {
  if (!Array.isArray(valor) || valor.length === 0) {
    throw new RentasDomainError("onboarding_datos_invalidos", "primerasUnidades: se requiere un arreglo con al menos 1 unidad ({nombre, duracionMinimaNoches?}).");
  }
  if (valor.length > MAX_UNIDADES_ONBOARDING) {
    throw new RentasDomainError("onboarding_datos_invalidos", `primerasUnidades: máximo ${MAX_UNIDADES_ONBOARDING} unidades en el registro inicial (recibido ${valor.length}).`);
  }
  const nombresVistos = new Set<string>();
  return valor.map((entrada, indice) => {
    if (typeof entrada !== "object" || entrada === null) {
      throw new RentasDomainError("onboarding_datos_invalidos", `primerasUnidades[${indice}]: debe ser un objeto {nombre, duracionMinimaNoches?}.`);
    }
    const objeto = entrada as { nombre?: unknown; duracionMinimaNoches?: unknown };
    const nombre = requiereTexto(objeto.nombre, `primerasUnidades[${indice}].nombre`);
    const clave = nombre.toLowerCase();
    if (nombresVistos.has(clave)) {
      throw new RentasDomainError("onboarding_datos_invalidos", `primerasUnidades: el nombre "${nombre}" está repetido -- cada unidad de esta property necesita un nombre único.`);
    }
    nombresVistos.add(clave);

    if (objeto.duracionMinimaNoches === undefined) return { nombre };
    if (
      typeof objeto.duracionMinimaNoches !== "number" ||
      !Number.isInteger(objeto.duracionMinimaNoches) ||
      objeto.duracionMinimaNoches < MIN_DURACION_MINIMA_NOCHES ||
      objeto.duracionMinimaNoches > MAX_DURACION_MINIMA_NOCHES
    ) {
      throw new RentasDomainError(
        "onboarding_datos_invalidos",
        `primerasUnidades[${indice}].duracionMinimaNoches: entero entre ${MIN_DURACION_MINIMA_NOCHES} y ${MAX_DURACION_MINIMA_NOCHES} (recibido ${JSON.stringify(objeto.duracionMinimaNoches)}).`,
      );
    }
    return { nombre, duracionMinimaNoches: objeto.duracionMinimaNoches };
  });
}

function validarPrimerOwner(valor: unknown): CapturaOnboardingRentasValidada["primerOwner"] {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== "object") {
    throw new RentasDomainError("onboarding_datos_invalidos", "configuracionInicial.primerOwner: debe ser un objeto {nombre, email?}.");
  }
  const objeto = valor as { nombre?: unknown; email?: unknown };
  const nombre = requiereTexto(objeto.nombre, "configuracionInicial.primerOwner.nombre");
  const email = objeto.email === undefined || objeto.email === null || objeto.email === "" ? undefined : validarCorreo(objeto.email, "configuracionInicial.primerOwner.email");
  return email === undefined ? { nombre } : { nombre, email };
}

/** Punto de entrada único de este archivo -- ver comentario de cabecera. */
export function validarCapturaOnboardingRentas(body: unknown): CapturaOnboardingRentasValidada {
  if (typeof body !== "object" || body === null) {
    throw new RentasDomainError("onboarding_datos_invalidos", "El cuerpo de la solicitud debe ser un objeto JSON.");
  }
  const cuerpo = body as Partial<CapturaOnboardingRentasInput>;

  if (typeof cuerpo.organizacion !== "object" || cuerpo.organizacion === null) {
    throw new RentasDomainError("onboarding_datos_invalidos", "organizacion: requerido ({nombre, tipoOrganizacion?}).");
  }
  if (typeof cuerpo.primeraPropiedad !== "object" || cuerpo.primeraPropiedad === null) {
    throw new RentasDomainError("onboarding_datos_invalidos", "primeraPropiedad: requerido ({nombre, zonaHoraria, moneda?}).");
  }
  if (typeof cuerpo.admin !== "object" || cuerpo.admin === null) {
    throw new RentasDomainError("onboarding_datos_invalidos", "admin: requerido ({nombreCompleto, correo, password}).");
  }

  const nombreOrganizacion = requiereTexto(cuerpo.organizacion.nombre, "organizacion.nombre");
  const tipoOrganizacion = validarTipoOrganizacion(cuerpo.organizacion.tipoOrganizacion);

  const nombrePropiedad = requiereTexto(cuerpo.primeraPropiedad.nombre, "primeraPropiedad.nombre");
  const zonaHorariaTexto = requiereTexto(cuerpo.primeraPropiedad.zonaHoraria, "primeraPropiedad.zonaHoraria", 100);
  if (!esZonaHorariaIanaValida(zonaHorariaTexto)) {
    throw new RentasDomainError("onboarding_datos_invalidos", `primeraPropiedad.zonaHoraria: "${zonaHorariaTexto}" no es una zona horaria IANA reconocida (ej. "America/Mexico_City").`);
  }
  const moneda = validarMoneda(cuerpo.primeraPropiedad.moneda);
  const primerasUnidades = validarPrimerasUnidades(cuerpo.primerasUnidades);

  const nombreCompletoAdmin = requiereTexto(cuerpo.admin.nombreCompleto, "admin.nombreCompleto");
  const correoAdmin = validarCorreo(cuerpo.admin.correo, "admin.correo");
  validarPassword(cuerpo.admin.password);

  const primerOwner = validarPrimerOwner(cuerpo.configuracionInicial?.primerOwner);

  return {
    organizacion: { nombre: nombreOrganizacion, tipoOrganizacion },
    primeraPropiedad: { nombre: nombrePropiedad, zonaHoraria: zonaHorariaTexto, moneda },
    primerasUnidades,
    admin: { nombreCompleto: nombreCompletoAdmin, correo: correoAdmin },
    primerOwner,
    slugPropuesto: slugificarNombreOrganizacion(nombreOrganizacion),
  };
}
