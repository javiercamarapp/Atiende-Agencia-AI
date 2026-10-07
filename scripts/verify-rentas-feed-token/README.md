# verify-rentas-feed-token

Verificación contra Postgres real de
`packages/domain-rentas/migrations/037_rentas_feed_export_token.sql`
(paridad3 rentas: URL de exportación iCal con token opaco y rotable, y reclamo manual de un feed para
"Sincronizar ahora").

Se auto-descubre en CI (`scripts/verify-real-postgres-ci/run-gate.mjs`); a mano:
`scripts/verify-rentas-feed-token/run.sh` (requiere `initdb`/`pg_ctl`/`psql`).

## Qué cubre (`assertions.sql`)

- A. `rotar_feed_export_token`: lo ejecutan admin_gestora y operador:calendario_mensajeria; lo rechazan el rol de solo
  calendario, el contador, otra organización, el sistema y anon; rotar deja un único token vigente y el anterior queda
  revocado; hash inválido y unidad inexistente se rechazan.
- B. Tabla: el staff ve las filas sin `token_hash`; cross-tenant sin filas; sin INSERT/UPDATE/DELETE directos para
  authenticated; anon sin acceso; un solo token vigente por (unidad, canal).
- C. `resolver_feed_export_token`: solo sistema; solo tokens vigentes; último acceso con tope de una escritura por minuto.
- D. `claim_ical_feed_manual`: solo sistema; entrega un feed aunque esté en backoff, nunca uno con lease vigente ni inactivo.
- E. definer con search_path fijo y EXECUTE revocado a public/anon.

## Qué NO cubre

- El TypeScript en vivo (rate limit por token, ETag, comparación de hashes en tiempo constante): vive en
  `packages/domain-rentas/tests/` y `apps/api/tests/rentas-ical-feed-token.spec.ts`.
