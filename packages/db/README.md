# @atiende/db

`migrations/0001_core_schema.sql` — esquema `core` real (`organization`, `property`,
`staff_user`, `membership`, `core.has_property_access`), prerequisito bloqueante que
`@atiende/core-tenancy`/`@atiende/core-auth` ya asumían solo como contrato TS. Aplicado
por primera vez como parte de la Fase 1 de restaurantes.

`src/` — `hashPassword`/`verifyPassword` (scrypt, port literal de
`hoteles/packages/db/src/password.ts`) y el puerto `CoreRepository`
(`InMemoryCoreRepository` para tests, `PostgresCoreRepository` para producción) que
usan las rutas núcleo de login (`apps/api/src/routes/auth.ts`).

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
