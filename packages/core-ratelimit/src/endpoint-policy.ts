// ─────────────────────────────────────────────────────────────────────────────
// Tabla explícita: para cada CATEGORÍA de endpoint conocida de este monorepo,
// qué debe pasar si Redis no contesta a media petición — abrir (dejar pasar,
// degradado al backend en memoria de esta instancia) o cerrar (negar).
//
// Esta tabla es el contrato que decide `DistributedRateLimiter.check()` vía
// `opts.category` cuando la llamada no fuerza `failClosed` explícitamente
// (ver rate-limiter.ts). Es EXPLÍCITA a propósito: la lección de
// ~/proyecto-origen/src/lib/ratelimit.ts (auditoría 24, SEG-4) fue que un default
// de fail-open que nadie recuerda configurar deja cuatro endpoints públicos
// sin defensa real en cuanto el proveedor de Redis tiene un blip. Aquí ese
// error estructural se cierra por diseño: una categoría SIN fila en
// `ENDPOINT_POLICIES` cae al default de `resolvePolicy`, que es CERRADO — no
// abierto. Añadir un endpoint nuevo a esta tabla es una decisión que se
// documenta con su razón, no un olvido que se resuelve solo hacia lo cómodo.
//
// Snapshot de packages/apps al escribir esta tabla (11-sep-2026): `apps/api`
// es todavía un esqueleto de Fase 0 (solo README, sin rutas reales) — así que
// esta tabla no cataloga rutas HTTP existentes, cataloga las CAPACIDADES de
// negocio que ya existen como paquete (core-auth, agent-core/gateway,
// billing, mcp-servers/*) y que un endpoint futuro para esa capacidad debe
// heredar. Cuando `apps/api` tenga rutas reales, cada handler debe pasar la
// categoría que le corresponda de aquí — o añadir una fila nueva si ninguna
// aplica, nunca omitir `category` para "que tome el default".
// ─────────────────────────────────────────────────────────────────────────────

export type FailMode = 'open' | 'closed';

export interface EndpointPolicy {
  failMode: FailMode;
  /** Por qué esta categoría está en este modo — obligatorio: una fila sin
   *  razón documentada es indistinguible de un olvido. */
  reason: string;
}

/**
 * CERRADO ('closed') = niega la petición si Redis no contesta. Úsalo donde
 * superar el límite sin control tiene un costo real y directo: fuerza bruta
 * contra credenciales, spam hacia un servicio externo con costo por llamada,
 * o una acción con efecto físico/fiscal real.
 *
 * ABIERTO ('open') = degrada al backend en memoria de ESTA instancia — nunca
 * "sin límite": sigue habiendo un tope por instancia, solo deja de ser
 * GLOBAL mientras Redis esté caído. Úsalo donde negar a una sesión YA
 * AUTENTICADA por un blip de un proveedor ajeno rompe el producto para un
 * cliente legítimo, y donde OTRA capa (guardrail de presupuesto, constraint
 * de base de datos, TTL de un lock) ya sostiene la defensa real — el rate
 * limit ahí es una segunda línea contra abuso/ráfaga, no la última.
 */
export const ENDPOINT_POLICIES: Record<string, EndpointPolicy> = {
  'auth:login': {
    failMode: 'closed',
    reason:
      'Superficie NO autenticada de fuerza bruta (packages/core-auth). Mismo caso que login: en el proyecto origen tras la auditoría 24 (SEG-4) — negar es la defensa, no un efecto secundario.',
  },
  'auth:password-reset': {
    failMode: 'closed',
    reason:
      'Superficie no autenticada — reenvío de link/código. Abrir sin freno es spam de correo/SMS hacia terceros que no pidieron nada, con el mismo mecanismo que el magic link del proyecto origen.',
  },
  'auth:token-issue': {
    failMode: 'closed',
    reason:
      'Emisión/canje de tokens (JWT, OAuth) vía packages/core-auth. Mismo criterio que /api/mcp/oauth/token en el proyecto origen: es la puerta, no un endpoint conveniente.',
  },
  'auth:accept-invite': {
    failMode: 'closed',
    reason:
      'Superficie NO autenticada de canje de invitación (POST /auth/accept-invite, packages/core-auth vía apps/api/src/routes/auth.ts) — quien la llama todavía no probó nada, solo trae un token de invitación de un solo uso. Mismo riesgo que auth:login: fuerza bruta contra el token (o contra el password que fija en el mismo request) sin ningún freno hasta este hallazgo.',
  },
  'mcp:locks': {
    failMode: 'closed',
    reason:
      'packages/mcp-servers/locks controla cerraduras físicas reales. Una ráfaga sin freno aquí no es solo cómputo de más — es una acción del mundo real repetida sin control mientras dure la avería de Redis.',
  },
  'mcp:cfdi': {
    failMode: 'closed',
    reason:
      'packages/mcp-servers/cfdi timbra ante el PAC (servicio fiscal externo). Cada llamada de más tiene costo monetario directo y riesgo de comprobantes fiscales duplicados frente al SAT — no es un límite de UX, es un límite de dinero y de cumplimiento.',
  },
  'billing:charge': {
    failMode: 'closed',
    reason:
      'packages/billing — disparar cargos/cobros repetidos sin freno mueve dinero real. Mismo tipo de daño que timbrar de más: preferible negar una petición legítima aislada a permitir una ráfaga de cargos duplicados.',
  },
  admin: {
    failMode: 'closed',
    reason:
      'Superficie de operador con privilegios elevados. Nota: si este repo llega a tener un limitador dedicado a /admin (in-memory, fail-closed, patrón "hoteles" que ya circula en el ecosistema atiende — ver README de este paquete, sección "Cuándo usar cada paquete"), las rutas /admin deben usar ESE limitador y no este. Esta fila es el default seguro mientras esa pieza no exista en este repo.',
  },
  'agent:gateway': {
    failMode: 'open',
    reason:
      'packages/agent-core/src/gateway ya tiene budget.ts (presupuesto por carril) y circuit-breaker.ts como guardrails de costo primarios sobre la sesión de un tenant YA autenticado. Negar aquí solo porque Redis tuvo un blip rompe conversaciones en curso sin bajar el riesgo real — el presupuesto sigue vigente en memoria.',
  },
  'mcp:pms': {
    failMode: 'open',
    reason:
      'Acciones operativas de un tenant autenticado (disponibilidad, reservas) vía packages/mcp-servers/pms. La integridad real la sostiene la capa de datos (constraints, locks de packages/core-conversation) — este límite es contra abuso/ráfaga, no la última defensa.',
  },
  'mcp:channel-manager': {
    failMode: 'open',
    reason:
      'Sincronización de un tenant autenticado con canales externos (OTAs) vía packages/mcp-servers/channel-manager. Negar por un blip de Redis puede dejar inventario desincronizado más tiempo que dejarlo pasar acotado; el proveedor externo trae su propio rate limit como defensa real.',
  },
  'mcp:scheduling': {
    failMode: 'open',
    reason: 'Acciones de un tenant autenticado (citas) vía packages/mcp-servers/scheduling — mismo criterio que mcp:pms.',
  },
  'mcp:pos': {
    failMode: 'open',
    reason: 'Acciones de un tenant autenticado (punto de venta) vía packages/mcp-servers/pos — mismo criterio que mcp:pms.',
  },
  'conversation:inbound-webhook': {
    failMode: 'open',
    reason:
      'ADVERTENCIA para quien use esta fila: un webhook entrante (WhatsApp u otro canal, vía packages/core-conversation) NO se resuelve solo con abrir/cerrar. "Abierto" aquí es la aproximación de ESTA tabla (nunca deja el conteo en cero), pero el handler real, ante una negativa, debe responder con un código que provoque reintento (p. ej. 429) en vez de aceptar sin límite o descartar en silencio — mismo matiz que la nota del proyecto origen sobre su webhook de WhatsApp: "negar" no es "tirar".',
  },
};

const DEFAULT_POLICY: EndpointPolicy = {
  failMode: 'closed',
  reason:
    'Categoría sin fila explícita en ENDPOINT_POLICIES. Cerrado por default: una categoría nueva se cataloga aquí con su razón, no se asume abierta por comodidad (ver SEG-4 en la cabecera del archivo).',
};

/** Resuelve la política de una categoría. Sin categoría, o con una categoría
 *  no catalogada, devuelve el default seguro (cerrado). */
export function resolvePolicy(category?: string): EndpointPolicy & { failClosed: boolean } {
  const policy = (category ? ENDPOINT_POLICIES[category] : undefined) ?? DEFAULT_POLICY;
  return { ...policy, failClosed: policy.failMode === 'closed' };
}
