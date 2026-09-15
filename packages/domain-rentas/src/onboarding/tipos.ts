// Tipos de la Fase 11 -- onboarding self-serve del tenant de rentas (alta de
// organización/primera propiedad desde el producto, sin intervención manual del
// equipo de Atiende). Ver ./repository.ts para el porqué esta captura NO puede
// escribir `core.organization`/`core.property` todavía (gap de plataforma real,
// documentado ahí y en apps/api/src/production/rentas-onboarding-repository.ts).

/** `rentas.organization_perfil.tipo` (migración 001) -- 'anfitrion' es el default de
 * la propia columna Postgres, se repite aquí para que la validación de aplicación
 * (./captura.ts) pueda aplicarlo ANTES de intentar escribir, sin depender del
 * DEFAULT del motor. */
export type TipoOrganizacionRentas = "anfitrion" | "empresa_gestora";

export interface CapturaOnboardingOrganizacionInput {
  readonly nombre: string;
  readonly tipoOrganizacion?: TipoOrganizacionRentas;
}

export interface CapturaOnboardingPropiedadInput {
  readonly nombre: string;
  /** Zona horaria IANA real (D-013 del origen, `rentas.property_config.zona_horaria`)
   * -- validada contra `Intl.supportedValuesOf("timeZone")` en ./captura.ts, nunca solo
   * el CHECK de no-vacío que ya aplica la migración 001. */
  readonly zonaHoraria: string;
  /** ISO 4217, 3 letras -- mismo criterio de "solo formato, sin catálogo cerrado" que
   * `CodigoMoneda` en ../finanzas/tipos.ts (`type CodigoMoneda = string`). Default
   * 'MXN' si se omite, igual que el DEFAULT de `rentas.property_config.moneda`. */
  readonly moneda?: string;
}

/** Credenciales del primer usuario admin (`platformRole:'owner'`,
 * `verticalRole:'admin_gestora'`) -- la contraseña viaja en texto plano SOLO hasta la
 * ruta HTTP (apps/api/.../rentas/onboarding.ts), que la hashea con
 * `@atiende/db::hashPassword` antes de construir `NuevoTenantRentasInput`; este
 * paquete de dominio nunca hashea ni persiste contraseñas (mismo límite que ya
 * respeta el resto de domain-rentas, ver diseño Fase 1 §1). */
export interface CapturaOnboardingAdminInput {
  readonly nombreCompleto: string;
  readonly correo: string;
  readonly password: string;
}

/** Dueño real del inmueble (`rentas.owner`), DISTINTO del admin de arriba (que es
 * staff) -- mismo modelo de negocio que ../owner-portal/*. Opcional: un anfitrión que
 * se auto-gestiona (`tipoOrganizacion:'anfitrion'`) puede omitirlo y dar de alta el
 * owner después desde `POST /rentas/owner-portal/...` ya autenticado. */
export interface CapturaOnboardingPrimerOwnerInput {
  readonly nombre: string;
  readonly email?: string;
}

export interface CapturaOnboardingConfiguracionInicialInput {
  readonly primerOwner?: CapturaOnboardingPrimerOwnerInput;
}

/** Una unidad (listing individual rentable, `rentas.unidad`) a dar de alta EN EL
 * MISMO submit que la property que la contiene -- hallazgo de auditoría ("ni siquiera
 * tiene pantalla -- organización + property + unidades"): antes de este cambio,
 * `packages/domain-rentas` no tenía NINGÚN método para crear una `rentas.unidad`
 * (solo lectura, `findUnidad`) -- una property sin al menos una unidad es inútil
 * (calendario/pricing/mensajería cuelgan de `unidad_id`). */
export interface CapturaOnboardingUnidadInput {
  readonly nombre: string;
  /** `rentas.unidad.duracion_minima_noches` -- default 1 (mismo DEFAULT que la
   * columna Postgres) si se omite. */
  readonly duracionMinimaNoches?: number;
}

/** Cuerpo completo de `POST /rentas/onboarding/registro` -- organización + primera
 * propiedad + al menos una unidad + admin + configuración inicial de rentas EN UN
 * SOLO SUBMIT (el gap real identificado por auditoría: hoy la única forma de que un
 * tenant de rentas exista es que el equipo de Atiende lo dé de alta a mano). */
export interface CapturaOnboardingRentasInput {
  readonly organizacion: CapturaOnboardingOrganizacionInput;
  readonly primeraPropiedad: CapturaOnboardingPropiedadInput;
  readonly primerasUnidades: readonly CapturaOnboardingUnidadInput[];
  readonly admin: CapturaOnboardingAdminInput;
  readonly configuracionInicial?: CapturaOnboardingConfiguracionInicialInput;
}

/** Salida de `validarCapturaOnboardingRentas` -- MISMOS datos que la entrada, pero
 * normalizados (trim, minúsculas de correo, mayúsculas de moneda) y con
 * `slugPropuesto` ya calculado (candidato de `core.organization.slug`; el
 * repositorio resuelve la colisión final, ver ./repository.ts). Nunca lleva la
 * contraseña en texto plano más allá de este punto -- separada aparte a propósito
 * para que sea imposible loguearla por accidente si algo serializa el resto del
 * objeto (logs de auditoría, mensajes de error, etc.). */
export interface CapturaOnboardingRentasValidada {
  readonly organizacion: { readonly nombre: string; readonly tipoOrganizacion: TipoOrganizacionRentas };
  readonly primeraPropiedad: { readonly nombre: string; readonly zonaHoraria: string; readonly moneda: string };
  readonly primerasUnidades: readonly CapturaOnboardingUnidadInput[];
  readonly admin: { readonly nombreCompleto: string; readonly correo: string };
  readonly primerOwner: CapturaOnboardingPrimerOwnerInput | null;
  readonly slugPropuesto: string;
}

/** Entrada real del puerto de persistencia (./repository.ts) -- `CapturaOnboardingRentasValidada`
 * más el hash ya calculado por la ruta HTTP. */
export interface NuevoTenantRentasInput {
  readonly organizacion: { readonly nombre: string; readonly slugPropuesto: string; readonly tipoOrganizacion: TipoOrganizacionRentas };
  readonly primeraPropiedad: { readonly nombre: string; readonly zonaHoraria: string; readonly moneda: string };
  readonly primerasUnidades: readonly CapturaOnboardingUnidadInput[];
  readonly admin: { readonly nombreCompleto: string; readonly correo: string; readonly passwordHash: string };
  readonly primerOwner: CapturaOnboardingPrimerOwnerInput | null;
}

export interface ResultadoRegistroTenantRentas {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly staffId: string;
  readonly slug: string;
  /** Ids reales de `rentas.unidad` creadas, mismo orden que `primerasUnidades`. */
  readonly unidadIds: readonly string[];
  /** Siempre `true` hoy -- `core.staff_user.created_via='registro_autoservicio'`
   * (ver 0001_core_schema.sql) exige correo verificado antes de poder loguearse
   * (`apps/api/src/routes/auth.ts`, chequeo de `emailVerifiedAt`). El envío/consumo
   * real del token de verificación queda fuera de esta fase a propósito -- ver el
   * comentario de cabecera de ./repository.ts, sección "Fuera de alcance". */
  readonly requiereVerificacionCorreo: true;
}
