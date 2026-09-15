// Cliente web del onboarding self-serve del tenant de rentas — hallazgo de auditoría
// (severidad CRÍTICA, "el onboarding self-serve de rentas está bloqueado en
// producción y ni siquiera tiene pantalla"). Consume
// `POST /rentas/onboarding/registro` (`apps/api/src/routes/verticals/rentas/
// onboarding.ts`), la ÚNICA ruta pública (sin sesión) que crea un tenant de rentas
// desde cero. `fetchImpl` siempre inyectado (nunca `globalThis.fetch` directo), mismo
// criterio que `auth-client.ts`/`owner-portal-client.ts`.
export class OnboardingError extends Error {}

export interface RegistroUnidadInput {
  readonly nombre: string;
  readonly duracionMinimaNoches?: number;
}

export interface RegistroTenantInput {
  readonly organizacionNombre: string;
  readonly tipoOrganizacion: "anfitrion" | "empresa_gestora";
  readonly propiedadNombre: string;
  readonly zonaHoraria: string;
  readonly moneda: string;
  readonly unidades: readonly RegistroUnidadInput[];
  readonly adminNombreCompleto: string;
  readonly adminCorreo: string;
  readonly adminPassword: string;
  readonly primerOwnerNombre?: string;
  readonly primerOwnerEmail?: string;
}

export interface RegistroTenantResultado {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly staffId: string;
  readonly slug: string;
  readonly unidadIds: readonly string[];
  readonly requiereVerificacionCorreo: boolean;
}

/** Validación de UI real (mismo criterio de mensajes accionables que
 * `validateLoginForm`) -- el servidor SIEMPRE re-valida todo esto con más detalle
 * (`captura.ts`), esta capa solo evita un viaje de red para el error más común. */
export function validateRegistroForm(input: RegistroTenantInput): string | null {
  if (!input.organizacionNombre.trim()) return "Escribe el nombre de tu organización.";
  if (!input.propiedadNombre.trim()) return "Escribe el nombre de tu primera propiedad.";
  if (!input.zonaHoraria.trim()) return "Elige una zona horaria.";
  if (input.unidades.length === 0) return "Agrega al menos una unidad (depa, habitación, casa…).";
  if (input.unidades.some((u) => !u.nombre.trim())) return "Cada unidad necesita un nombre.";
  const nombresUnidades = input.unidades.map((u) => u.nombre.trim().toLowerCase());
  if (new Set(nombresUnidades).size !== nombresUnidades.length) return "Dos unidades no pueden tener el mismo nombre.";
  if (!input.adminNombreCompleto.trim()) return "Escribe tu nombre completo.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.adminCorreo.trim())) return "Ese correo no parece válido.";
  if (input.adminPassword.length < 10) return "La contraseña debe tener al menos 10 caracteres.";
  return null;
}

export async function registrarTenant(fetchImpl: typeof fetch, apiBaseUrl: string, input: RegistroTenantInput): Promise<RegistroTenantResultado> {
  const validationError = validateRegistroForm(input);
  if (validationError) throw new OnboardingError(validationError);

  const res = await fetchImpl(`${apiBaseUrl}/rentas/onboarding/registro`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizacion: { nombre: input.organizacionNombre.trim(), tipoOrganizacion: input.tipoOrganizacion },
      primeraPropiedad: { nombre: input.propiedadNombre.trim(), zonaHoraria: input.zonaHoraria, moneda: input.moneda },
      primerasUnidades: input.unidades.map((u) => ({ nombre: u.nombre.trim(), ...(u.duracionMinimaNoches ? { duracionMinimaNoches: u.duracionMinimaNoches } : {}) })),
      admin: { nombreCompleto: input.adminNombreCompleto.trim(), correo: input.adminCorreo.trim().toLowerCase(), password: input.adminPassword },
      ...(input.primerOwnerNombre?.trim()
        ? { configuracionInicial: { primerOwner: { nombre: input.primerOwnerNombre.trim(), ...(input.primerOwnerEmail?.trim() ? { email: input.primerOwnerEmail.trim() } : {}) } } }
        : {}),
    }),
  });

  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new OnboardingError(body?.message ?? "Ya existe una cuenta u organización con esos datos.");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new OnboardingError(body?.message ?? "No se pudo completar el registro. Revisa los datos e intenta de nuevo.");
  }

  return (await res.json()) as RegistroTenantResultado;
}

/** Catálogo corto de zonas horarias frecuentes para el selector -- el servidor
 * acepta CUALQUIER zona IANA real (`Intl.supportedValuesOf("timeZone")`), esta lista
 * es solo una conveniencia de UI para no forzar a escribir el string exacto. */
export const ZONAS_HORARIAS_FRECUENTES: readonly string[] = [
  "America/Mexico_City",
  "America/Cancun",
  "America/Monterrey",
  "America/Tijuana",
  "America/Bogota",
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "America/Lima",
  "UTC",
];
