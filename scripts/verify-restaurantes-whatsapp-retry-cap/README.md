# verify-restaurantes-whatsapp-retry-cap

Verificación, contra un Postgres **real**, de
`packages/domain-restaurantes/migrations/020_whatsapp_retry_cap.sql`: cierra el
hueco de Fase 2 (integridad) — "los reintentos de WhatsApp entrante no tienen
tope, y cada reintento de Meta vuelve a gastar un turno de LLM". Mismo diseño
exacto que `scripts/verify-hoteles-whatsapp-retry-cap/` (ver su README para el
detalle completo de cada escenario) sobre `restaurantes.claim_whatsapp_message` y
`organization_id` en vez de `property_id`.

## Qué demuestra (9 escenarios)

1. Sesión de sistema real — un caller con `auth.uid()` NO nulo es rechazado.
2. Intentos dentro del tope (`attempts=1`, `attempts=4`, `MAX=5`) siguen
   reclamando con normalidad — comportamiento IDÉNTICO al de hoy.
3. El intento que agotaría el tope (`attempts=5`, `'failed'`) YA NO reclama.
4. Transición explícita a estado terminal `'attempts_exhausted'` al agotar el
   tope (agregado al `CHECK` de `status` en esta misma migración).
5. El estado terminal es real y para siempre — nunca vuelve a reclamarse.
6. Un mensaje `'processed'` nunca se toca.
7. Aislamiento cross-tenant: una `organization_id` ajena no reclama ni
   transiciona la fila real de la organización dueña del mensaje.
8. Esquema de producción a medio migrar (esta migración NO aplicada): la versión
   ANTERIOR real de la función — byte-idéntica a
   `013_rpc_anti_duplicado_authenticated_grants.sql` — reclama SIEMPRE un mensaje
   `'failed'` sin importar `attempts`, sin ningún error de "función no existe"
   (misma firma exacta) — este fix nunca necesitó ningún fallback de SQLSTATE
   42883/42P01/42703 en TypeScript.

El efecto complementario — que el N-ésimo intento tampoco vuelve a invocar
`turnHandler.handleInboundMessage` (el LLM) del lado de TypeScript — se verifica
por separado con `AbortAwareFakeSession` en
`packages/domain-restaurantes/tests/whatsapp-retry-cap.spec.ts`.

## Cómo correrlo

- Manual, contra un Postgres local efímero (requiere `initdb`/`pg_ctl`/`psql` en
  PATH): `scripts/verify-restaurantes-whatsapp-retry-cap/run.sh`
- Automático en CI, contra el Postgres del workflow:
  `node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-restaurantes-whatsapp-retry-cap`
  (o sin argumento, que descubre este directorio junto con todos los demás
  `scripts/verify-*/`).
