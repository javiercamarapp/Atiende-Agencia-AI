# verify-restaurantes-lecturas-sistema

Acompaña a `packages/domain-restaurantes/migrations/071_agente_lecturas_sistema_cliente_y_pedido.sql` (QA-PM-R2-whatsapp-02).

La sesión de sistema de los agentes (`authenticated` con `auth.uid()` NULL) no veía `customers`, `customer_addresses` ni `orders` por RLS: `buscar_cliente`
devolvía siempre `isNew: true`. Las cinco funciones `sistema_*` leen con la organización como argumento explícito y solo para la sesión de sistema.

Uso: `bash scripts/verify-restaurantes-lecturas-sistema/run.sh` (Postgres local efímero; ver `run.sh`). En CI lo corre el gate automático
(`scripts/verify-real-postgres-ci/run-gate.mjs`), que descubre este directorio por su `assertions.sql`.
