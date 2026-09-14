// ═══════════════════════════════════════════════════════════════════════════
// MAPA EXPLÍCITO RUTA → ÁREA — generalización del patrón real de
// proyecto-origen/src/lib/auth/visibilidad.ts (AREA_POR_RUTA / puedeVerRuta /
// areasDe), portado a un factory genérico porque core-authz sirve a las 5
// verticales de este monorepo (hoteles/restaurantes/rentas/licitaciones/
// citas) y no puede conocer los nombres de ruta de ninguna en particular —
// mismo principio que "core-tenancy nunca conoce 'frontdesk' ni
// 'housekeeping'" (ver packages/core-tenancy/src/types.ts).
//
// Cada app (apps/web, o cada domain-<vertical> que exponga sus propias
// rutas admin) declara SU PROPIO mapa ruta→área con `createRouteAreaMap`,
// igual que proyecto-origen declara el suyo en un solo archivo de app. Lo que
// vive aquí es el MECANISMO, no los datos.
//
// LA REGLA QUE SE PORTA TAL CUAL (es la que importa, ver visibilidad.ts
// líneas 58-61): una ruta no clasificada NO se ve. Explícito y no por
// prefijo, fail-closed — "es preferible que una pantalla nueva no se vea a
// que se vea de más: el error caro es el segundo".
// ═══════════════════════════════════════════════════════════════════════════

/** Config declarativa de un mapa ruta→área para un rol de plataforma dado. */
export interface RouteAreaConfig<TArea extends string> {
  /** Qué áreas ve cada rol (llave = PlatformRole u otro string de rol). Un rol
   * ausente de este record no ve NINGUNA área — mismo `?? []` que `areasDe`
   * en visibilidad.ts: fail-closed para rol desconocido. */
  readonly areasByRole: Readonly<Record<string, readonly TArea[]>>;
  /** A qué área pertenece cada ruta EXACTA. Sin matching por prefijo a
   * propósito (ver comentario de cabecera de AREA_POR_RUTA en visibilidad.ts):
   * una ruta nueva que nadie clasifique cae a `undefined` y queda denegada. */
  readonly areaByRoute: Readonly<Record<string, TArea>>;
  /** Rutas de cuenta/persona que ve TODO rol conocido (con al menos un área),
   * equivalente a RUTAS_TODO_ROL en visibilidad.ts — ej. "mi perfil". */
  readonly routesForAnyKnownRole?: ReadonlySet<string>;
}

export interface RouteAreaMap<TArea extends string> {
  /** Áreas visibles para `role`. `[]` si el rol no está declarado. */
  areasOf(role: string): readonly TArea[];
  /** ¿`role` puede ver el área `area`? */
  canViewArea(role: string, area: TArea): boolean;
  /** Área de una ruta exacta, o `undefined` si nadie la clasificó. */
  areaOfRoute(path: string): TArea | undefined;
  /** ¿`role` puede ver la ruta `path`? `false` fail-closed para ruta o rol
   * desconocidos — nunca lanza, para poder usarse tanto en gateo de UI
   * (ocultar un link) como en gateo de servidor (ver `requireAreaAccess` en
   * admin-middleware.ts, que sí lanza 403 a partir de este `false`). */
  canViewRoute(role: string, path: string): boolean;
}

export function createRouteAreaMap<TArea extends string>(config: RouteAreaConfig<TArea>): RouteAreaMap<TArea> {
  const routesForAnyKnownRole = config.routesForAnyKnownRole ?? new Set<string>();

  function areasOf(role: string): readonly TArea[] {
    return config.areasByRole[role] ?? [];
  }

  function canViewArea(role: string, area: TArea): boolean {
    return areasOf(role).includes(area);
  }

  function areaOfRoute(path: string): TArea | undefined {
    return config.areaByRoute[path];
  }

  function canViewRoute(role: string, path: string): boolean {
    if (routesForAnyKnownRole.has(path)) return areasOf(role).length > 0;
    const area = areaOfRoute(path);
    return area !== undefined && canViewArea(role, area);
  }

  return { areasOf, canViewArea, areaOfRoute, canViewRoute };
}
