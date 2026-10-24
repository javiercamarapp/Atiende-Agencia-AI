# verify-restaurantes-cfo-analisis-clientes

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/095_cfo_analisis_clientes.sql`
(espejo: `supabase/migrations/20240101000409_095_cfo_analisis_clientes.sql`): `restaurantes.cfo_clientes_rfm`, `cfo_clientes_reactivacion`,
`cfo_intervalo_recompra` y `cfo_pedidos_tortilla` (pestana CFO «Analisis de clientes», solo lectura), mas el helper interno `cfo_clientes_rfm_base`.

Corpus SINTETICO y pequeno con valores calculados a mano (ver la cabecera de `assertions.sql`): organizacion A con 10 clientes de segmentos conocidos,
ruido que NO cuenta (cancelado, falso, demo 0009, programado, no_recogido, reposicion, venta sin cliente, fuera de rango), B ajena y T (tortilla en
items y dia de negocio con corte de 01:00). Cubre:

- RFM: segmentos en el orden de evaluacion, definicion unica de dormido, umbrales fijos de frecuencia, quintiles de rango con EMPATES (mismo puntaje),
  recencia anclada a `p_hasta`, curva de concentracion, cliente sin pedidos / con una sola venta / con dos ventas el mismo dia, organizacion sin ventas.
- Reactivacion: elegibilidad (>= 2 ventas y recencia > max(14, 1.5 x mediana) o > 30), prioridad, tope de filas (1..200), consentimiento de marketing (052)
  visible, alias de 8 caracteres y SIN PII (ni uuid ni telefono ni nombre).
- Intervalo de recompra: percentiles global y por segmento; con menos de 5 intervalos los percentiles son NULL (supresion por muestra minima).
- Tortilla: renglones, unidades y pedidos por tipo; solo ventas; cantidad invalida; tortilla desconocida ignorada.
- Seguridad con el rol REAL `authenticated`: owner, admin acotado, staff, repartidor, otra organizacion (cross-tenant en ambos sentidos), anon, sucursal
  ajena o inexistente, rango invertido / de 401 dias / nulo (22023), limite invalido; el helper interno cerrado.
- Postura: grants, SECURITY DEFINER, STABLE, `search_path` fijo, COMMENT, transaccion READ ONLY, base sin migrar (42883) y sin 052 (42P01).
- Rendimiento: 10 000 ventas (1 500 clientes), cada funcion en menos de 2 s.

- Manual: `scripts/verify-restaurantes-cfo-analisis-clientes/run.sh` (levanta un Postgres efimero con `initdb`; `VERIFY_PGPORT` fija el puerto). Ademas aplica
  la 095 una SEGUNDA vez para probar que es idempotente.
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos). Con un Postgres propio:
  `PGPORT=<puerto> node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-restaurantes-cfo-analisis-clientes`.

## Contrato para el TypeScript

- `rfm`, `reactivacion` y `tortilla` devuelven un `jsonb` (los numeros ya son numeros JSON; los centavos son enteros). `intervalo_recompra` devuelve filas
  (`bigint`/`numeric` llegan como string desde el driver).
- Percentiles y medianas NULL = sin dato suficiente (nunca 0).
