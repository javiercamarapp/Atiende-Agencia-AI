# Vertical: citas (web)

Fase 1 construida: `pages/Login.tsx` — pantalla real de login (email+password contra
`POST /auth/login` de `@atiende/core-auth`, mismo mecanismo que
`verticals/hoteles/pages/Login.tsx`). `lib/auth-client.ts` reutiliza las funciones
genéricas de red del lib compartido y solo redefine lo específico de citas: la llave
de sesión (`atiende.citas.session`) y el landing path (`/citas/:slug`).

**Bloqueante de producto, NO de esta fase de construcción** (ver diseño Fase 1 citas
§7.1): antes de dar de baja el login viejo de `citas-reservaciones`
(magic-link + "Continuar con Google", `AdminLogin.tsx`), hay que confirmar con
Javier si el Supabase de producción de citas (ref `jfvfoettxagcqgizenum`) tiene
`tenant_staff`/`auth.users` con filas reales — a diferencia de restaurantes/hoteles,
aquí no se verificó que esté vacío. Si hay staff real, falta además un flujo de
`POST /auth/set-initial-password` (no existe todavía, trabajo genuino nuevo) antes de
poder cortar el login viejo.

Fase 5 construyó el panel de administración visual completo:

- `CitasShell.tsx` — resuelve sesión + propertyId una sola vez (vía
  `GET /v1/citas/:orgSlug/admin/branches`, nuevo en esta fase — ver
  `apps/api/src/routes/verticals/citas/admin.ts`) y da a las 6 páginas la misma nav
  lateral. Estilos inline, sin design system nuevo (mismo criterio que Fase 1/Fase 3).
- `pages/Agenda.tsx` — vista mes/semana de citas REALES, agrupadas por día, con
  filtro por proveedor y acción de cancelar (reusa
  `POST .../appointments/:id/cancel`, que ya existía desde Fase 1).
- `pages/Proveedores.tsx` / `pages/Servicios.tsx` — lista + ficha, de **solo
  lectura**: `domain-citas` todavía no expone crear/editar un proveedor o servicio
  (solo `findProvider`/`findService`/`listActive*`), y esta fase es de UI de panel
  sobre lógica ya existente, nunca de lógica de negocio nueva — inventar esa
  escritura habría sido justamente lo que esta fase tenía prohibido. La ficha de
  proveedor SÍ ofrece una acción real de escritura: conectar Google Calendar (ya
  existía desde Fase 3, `google-calendar-oauth.ts` — esta es su primera UI real).
- `pages/Clientes.tsx` — lista paginada + búsqueda + ficha con citas próximas
  reales. El cliente se crea/actualiza solo implícitamente al reservar
  (`upsertCustomer`, Fase 1); el panel nunca crea/edita un cliente directamente.
- `pages/Disponibilidad.tsx` — selector de proveedor + su horario semanal real, de
  solo lectura (mismo motivo que Proveedores/Servicios).
- `pages/Configuracion.tsx` — centro de conexión de Google Calendar por proveedor.
  El resto de "configuración" del negocio (horarios globales, recordatorios,
  WhatsApp) no tiene todavía ninguna lectura/escritura expuesta en `domain-citas` —
  se documenta como pendiente en vez de inventar un formulario que no guardaría
  nada real.
- `lib/*.ts` — un cliente HTTP tipado por dominio (`admin-client.ts` con los
  helpers compartidos + resolución de sucursal, `appointments-client.ts`,
  `providers-client.ts`, `services-client.ts`, `customers-client.ts`,
  `format.ts`), todos con `fetchImpl` inyectado (nunca `globalThis.fetch` directo)
  para poder probarlos con vitest en entorno "node", mismo criterio que
  `restaurantes/dashboard-client.ts`.

Fase 5 también agregó 2 endpoints de solo lectura al backend que la UI necesitaba
y que `domain-citas` no exponía todavía — ver
`apps/api/src/routes/verticals/citas/README.md`: listar/paginar citas en un rango
de fechas y listar/paginar clientes. Ninguno de los dos decide nada nuevo sobre el
dominio, solo expone/pagina filas que ya se escribían desde Fase 1.
