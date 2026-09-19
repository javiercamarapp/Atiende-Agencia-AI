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

Fase 5 construyó el panel de administración visual — **desactualizado desde
entonces en varios puntos, corregido abajo (barrido de documentación,
19-sep-2026)**:

- `CitasShell.tsx` — resuelve sesión + propertyId una sola vez (vía
  `GET /v1/citas/:orgSlug/admin/branches` — ver
  `apps/api/src/routes/verticals/citas/admin.ts`) y da nav lateral común a **7
  páginas** (Agenda/Proveedores/Servicios/Clientes/Disponibilidad/Configuración
  + `Staff.tsx`, agregada en Fase 12 — no 6 como decía esta sección
  originalmente). Estilos inline, sin design system nuevo (mismo criterio que
  Fase 1/Fase 3).
- `pages/Agenda.tsx` — vista mes/semana de citas REALES, agrupadas por día, con
  filtro por proveedor y acción de cancelar (reusa
  `POST .../appointments/:id/cancel`, que ya existía desde Fase 1).
- `pages/Proveedores.tsx` / `pages/Servicios.tsx` — **ya NO son de solo
  lectura.** Al escribir esta fase, `domain-citas` no exponía crear/editar
  proveedor o servicio; una fase posterior sí agregó esa escritura
  (`NewProviderInput`/`NewServiceInput`/`ProviderPatch`/`ServicePatch` en
  `packages/domain-citas/src/repository.ts`) y ambas páginas la usan
  (`createProvider`/`updateProvider` en `Proveedores.tsx`;
  `createService`/`updateService` en `Servicios.tsx`, Fase 8). La ficha de
  proveedor también gana, en Fase 6 §2, una sección real "Calendarios
  conectados": conectar/desconectar/probar Google Calendar, Cal.com y CalDAV
  (antes solo Google, conectado desde Fase 3).
- `pages/Clientes.tsx` — lista paginada + búsqueda + ficha con citas próximas
  reales. El cliente se crea/actualiza solo implícitamente al reservar
  (`upsertCustomer`, Fase 1); el panel nunca crea/edita un cliente directamente.
- `pages/Disponibilidad.tsx` — **ya NO es de solo lectura** (Fase 10): horario
  semanal editable inline (agregar/editar/quitar por día) + sección de
  excepciones puntuales por fecha, con motivo opcional — ver
  `apps/api/src/routes/verticals/citas/README.md` §Fase 10.
- `pages/Configuracion.tsx` — **parcialmente desactualizado**: además del
  centro de conexión de Google Calendar por proveedor, ya edita configuración
  real del negocio (rubro, zona horaria por default, teléfono de notificación
  al owner — `fetchTenantConfig`/`updateTenantConfig`). Sigue pendiente, y la
  página lo marca honestamente como "Próximamente": horarios globales,
  recordatorios y configuración de WhatsApp.
- `pages/Staff.tsx` (Fase 12, no documentada hasta ahora) — alta/gestión de
  staff de citas, primer consumidor real de
  `roles.ts::PLATFORM_ROLE_BY_VERTICAL_ROLE` en este vertical.
- `lib/*.ts` — un cliente HTTP tipado por dominio: `admin-client.ts` (helpers
  compartidos + resolución de sucursal), `appointments-client.ts`,
  `providers-client.ts`, `services-client.ts`, `customers-client.ts`,
  `format.ts`, más (agregados en fases posteriores, no listados originalmente)
  `auth-client.ts`, `property-selection.ts`, `realtime-client.ts`,
  `staff-client.ts`, `tenant-config-client.ts`, `waitlist-client.ts`. Todos con
  `fetchImpl` inyectado (nunca `globalThis.fetch` directo) para poder probarlos
  con vitest en entorno "node", mismo criterio que
  `restaurantes/dashboard-client.ts`.

Fase 5 también agregó 2 endpoints de solo lectura al backend que la UI necesitaba
y que `domain-citas` no exponía todavía — ver
`apps/api/src/routes/verticals/citas/README.md`: listar/paginar citas en un rango
de fechas y listar/paginar clientes. Ninguno de los dos decide nada nuevo sobre el
dominio, solo expone/pagina filas que ya se escribían desde Fase 1.
