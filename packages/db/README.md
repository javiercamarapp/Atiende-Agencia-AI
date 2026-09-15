# @atiende/db

`migrations/0001_core_schema.sql` — esquema `core` real (`organization`, `property`,
`staff_user`, `membership`, `core.has_property_access`), prerequisito bloqueante que
`@atiende/core-tenancy`/`@atiende/core-auth` ya asumían solo como contrato TS. Aplicado
por primera vez como parte de la Fase 1 de restaurantes.

`migrations/0002_staff_invite_schema.sql` — Fase 10 restaurantes: `core.staff_invite`
(token hasheado + expiración) + `core.accept_staff_invite()` (función `security
definer`) — mecanismo genérico para invitar/dar de alta staff adicional en CUALQUIER
vertical después del alta inicial de una organización (gap detectado en la Fase 8
mientras se construía el rol "repartidor" — ver el comentario de cabecera de la
migración y de `src/core-repository.ts` para el detalle completo). Solo restaurantes
expone la ruta HTTP por ahora (`apps/api/src/routes/verticals/restaurantes/
admin-staff.ts`), el esquema ya queda listo para el resto.

`migrations/0004_list_org_members_by_vertical_role.sql` — hallazgo de auditoría
(severidad ALTA, "asignar repartidor a un pedido no tiene UI"): `core.list_org_
members_by_vertical_role()` (función `security definer`, mismo patrón que
`core.has_property_access`/`core.accept_staff_invite`) lista los miembros YA
aceptados de una organización con un `vertical_role` exacto — usada por
`GET .../admin/staff/repartidores` (selector real de repartidores) y corrige de
paso un gap real de RLS en la validación de `PATCH .../assign-repartidor` (ver
el comentario de cabecera de la propia migración para el detalle completo).

`src/` — `hashPassword`/`verifyPassword` (scrypt, port literal de
`hoteles/packages/db/src/password.ts`) y los puertos `CoreRepository`/
`CoreStaffRepository` (`InMemoryCoreRepository` para tests, `PostgresCoreRepository`
para producción — una sola clase implementa ambas interfaces) que usan las rutas
núcleo de login (`apps/api/src/routes/auth.ts`) y de invitación de staff
(`apps/api/src/routes/verticals/restaurantes/admin-staff.ts`).

**Todavía reservado**: motor de conexión real (PGlite/embedded-postgres/Postgres
gestionado) y corredor de migraciones (`db:migrate`/`db:seed` en el `package.json`
raíz apuntan aquí pero no hay `src/cli.ts` todavía). Sin esa pieza, `apps/api` no
puede levantar un servidor de producción real todavía — ver el comentario de
`apps/api/src/index.ts`.

Numeración de migraciones por bloques (ver el propio `migrations/` de cada paquete):
`0000–0099` núcleo (aquí), `0100–0199` restaurantes (vive en
`packages/domain-restaurantes/migrations/`, no aquí — mismo patrón que
`packages/core-conversation/migrations/`), `0200+` reservado para el resto de
verticales conforme se migren.
