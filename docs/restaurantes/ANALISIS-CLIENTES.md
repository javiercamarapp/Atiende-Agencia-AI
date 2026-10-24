# Análisis de clientes (pestaña CFO, Fase A, solo lectura)

Pestaña **CFO › Análisis de clientes** (`/restaurantes/:org/cfo/analisis-clientes`) y su API `GET /v1/restaurantes/:propertyId/admin/cfo/analisis-clientes`.
Solo owner/admin (`cfo.ver`, igual que el resto del CFO). No escribe nada, no envía mensajes y no crea campañas. Todos los datos de ejemplo del repo son sintéticos.

- SQL: `packages/domain-restaurantes/migrations/095_cfo_analisis_clientes.sql` (espejo `supabase/migrations/20240101000409_095_cfo_analisis_clientes.sql`).
- API y dominio: `apps/api/src/routes/verticals/restaurantes/cfo.ts`, `packages/domain-restaurantes/src/cfo/analisis-clientes.ts` (contrato, afinidad, definiciones).
- Web: `apps/web/src/verticals/restaurantes/cfo/CfoAnalisisClientes.tsx`.
- Verificación contra Postgres real: `scripts/verify-restaurantes-cfo-analisis-clientes/` (42 escenarios, en el gate de CI).

## Qué ve la persona

| Bloque | Qué muestra | Fuente |
|---|---|---|
| Resumen | Clientes con venta, recompra %, intervalo mediano, dormidos, venta en riesgo | `cfo_clientes_rfm`, `cfo_intervalo_recompra` |
| Segmentos RFM | Seis segmentos con clientes, venta, ticket y recencia mediana | `cfo_clientes_rfm` |
| Concentración (Pareto) | % de la venta que reúne el 10 %, 20 %… 100 % de los mejores clientes | `cfo_clientes_rfm` |
| Reactivación priorizada | Clientes que tardan más de lo habitual: alias, ritmo propio, venta, prioridad y **consentimiento de marketing** | `cfo_clientes_reactivacion` |
| Intervalo de recompra | p25 / mediana / p75 / p90 de días entre compras, global y por segmento | `cfo_intervalo_recompra` |
| Productos que se piden juntos | Pares con soporte, confianza y **lift** | `cfo_canasta_pares` (081), calculado en TypeScript |
| Tortilla | Renglones, unidades y pedidos por maíz / harina / mixta | `cfo_pedidos_tortilla` |
| Todavía no disponible | Lo que no tiene dato honesto, con «no disponible aún: requiere X» | contrato de la API |

Cada bloque tiene su estado de carga, error, vacío y «no disponible aún», y un botón de definición que abre la definición y el periodo (Popover: funciona con teclado y en pantallas táctiles; el texto también va en el nombre accesible del botón).

## Definiciones (única fuente; la pantalla las repite)

El periodo es el rango elegido (de 1 a 400 días). **Solo se ven ventas dentro del periodo**: un cliente con compras anteriores al periodo aparece como si no las tuviera.

- **Venta**: la regla de `cfo_venta_lean` (082): sin cancelados, no recogidos, por aprobar ni programados; sin pedidos falsos, sin tráfico demo (teléfono `0009…`) y sin reposiciones. Montos en centavos enteros. Día de negocio de la 076/077. Las ventas sin cliente identificado no entran.
- **Recencia**: días entre la última venta del cliente y **el último día del periodo** (no «hoy»; reproducible).
- **Frecuencia (F)**: ventas en el periodo, con **umbrales fijos**: 1, 2, 3 o 4 o más. No se usa `ntile`: con ~2/3 de clientes de una sola venta los empates caerían en quintiles distintos de forma arbitraria.
- **Monetario (M)** y **recencia (R)**: puntaje de 1 a 5 por quintil de rango **entre los clientes del alcance y rango consultados** (no de toda la organización): `ceil(5 × clientes con valor igual o peor ÷ clientes)`. Los empates reciben el mismo puntaje. Con menos de 5 clientes los puntajes no son estables y la pantalla lo avisa.
- **Intervalo propio**: días entre días de negocio consecutivos con venta del cliente (varias ventas el mismo día cuentan una vez). Sin intervalo propio si solo compró un día.
- **Dormido (única definición)**: 2 o más ventas y recencia mayor que `max(30 días, 1.5 × su mediana de intervalo)`. Sin mediana se usa 30.
- **Segmento** (se evalúa en este orden; gana el primero que cumpla):

  | Segmento | Regla |
  |---|---|
  | Campeón | F = 4 (4+ ventas) y R ≥ 4 |
  | Leal | F ≥ 3 y R ≥ 3 |
  | En riesgo de alto valor | R ≤ 2 y M ≥ 4 |
  | Nuevo prometedor | R ≥ 4 y una sola venta |
  | Dormido | cumple la definición única de dormido |
  | Ocasional | todo lo demás (incluye al de una venta antigua: no tiene ritmo propio para llamarlo dormido) |

  La tabla del documento de diseño definía «Dormido» como «R ≤ 2 (resto)» y la sección de definiciones como «≥ 2 ventas y sin pedir > max(30, 1.5×intervalo)»; se adoptó la segunda para no tener dos «dormidos».
- **Reactivación**: 2 o más ventas y (recencia > `max(14, 1.5 × mediana)` **o** recencia > 30). **Prioridad** = venta del periodo × `min(1, umbral ÷ recencia)`, con `umbral = max(14, 1.5 × mediana)`. Es una heurística simple para ordenar, **no una probabilidad calibrada**.
- **Venta en riesgo**: venta del periodo de los clientes dormidos o en riesgo de alto valor.
- **Concentración (Pareto)**: clientes ordenados por venta descendente (empate por identificador).
- **Intervalo de recompra**: percentiles de todos los intervalos juntos; con **menos de 5 intervalos no se calcula** (se muestra «—», nunca 0).
- **Afinidad**: soporte = pedidos con A y B ÷ pedidos del periodo; confianza A→B = pedidos con A y B ÷ pedidos con A; **lift** = soporte ÷ (P(A)·P(B)). Solo se publican pares con **5 o más pedidos juntos** (k-anonimato); los demás se cuentan como ocultos.
- **Tortilla**: `orders.items[].tortilla` (maíz, harina, mixta) de las ventas. Es el único modificador estructurado. **Salsas, omisiones y notas son texto libre y no se parsean.**

### Relación con lo que ya existía (sin duplicarlo)

`cfo_clientes_frecuentes_dormidos` (084) y el hallazgo `frecuentes_dormidos` miden a los **frecuentes de `cfo_config`** (N pedidos en X días) que llevan ≥ M días sin pedir, y alimentan la alerta del cierre; **no se modifican**. El análisis mide a **cada cliente contra su propio ritmo**. Son dos preguntas distintas con nombres distintos en pantalla; «dormido» dentro del análisis (RFM, reactivación) siempre significa lo de arriba. Las campañas de marketing de la 052 (`inactivo_30/60/90`) siguen siendo un segmento aparte y la pantalla solo enlaza a Campañas.

## Seguridad y privacidad

- Funciones `SECURITY DEFINER` con `search_path` fijo, `revoke` de `public`/`anon` y `grant execute` solo a `authenticated`; doble puerta con `cfo_resolver_sucursales` (usuario owner/admin con alcance a cada sucursal, o sesión de sistema con sucursales de la organización) y `cfo_validar_rango`. El helper interno `cfo_clientes_rfm_base` está cerrado a todos los roles.
- Sin PII: ni nombre, teléfono, dirección ni `customer_id` salen de la base. El cliente se identifica con un **alias de 8 caracteres** (primeros del sha-256 del `customer_id`). Un alias de 8 caracteres **no es k-anónimo** (es un cliente individual con su valor): se acepta porque es una lista operativa solo para owner/admin.
- API: `assertAccion(c, "cfo.ver")`, tope por persona (120 lecturas por minuto, el del CFO), validación cerrada de la query (rango ≤ 400 días, `limite` 1..200, sucursales ≤ 20), ETag débil y una línea de bitácora (`restaurantes_cfo_analisis_clientes_leido`) sin datos de clientes.
- Base sin migrar: 42883 / 42P01 / 42703 → la sección sale `disponible: false` con su motivo y respuesta 200 (SAVEPOINT por llamada con `runWithSavepointFallback`). Sin la 095 siguen disponibles las secciones que no la necesitan (la afinidad usa la 081). Un error no recuperable en una lectura degrada solo esa sección, sin filtrar el mensaje.
- No se crean crons (`vercel.json` sigue en 40/40) ni tablas; no hay escrituras.

## Orden de despliegue y reversa

1. Aplicar la migración 095 (con OK de Javier; **nunca** al fusionar). 2. Desplegar el código. 3. Verificar en la pestaña. Antes del paso 1 el código ya funciona: las secciones de la 095 dicen «no disponible aún».
Reversa: `drop function` de las cinco funciones de la 095 (sin tablas ni datos que revertir); la pantalla vuelve a «no disponible aún».

## Límites y huecos conocidos (Fase A)

- **Exportación** (`analisis_clientes` en CSV/XLSX): diferida. Cabe en el exportador, pero `cfo_registrar_exportacion` (083) valida las vistas permitidas con una lista cerrada en SQL, y sumar una vista exige redefinirla (fuera de las reglas de esta fase: «no redefinas nada existente»). El botón de exportar se oculta en esta pestaña. Cuando se haga, debe llevar anti-inyección de CSV (prefijo `'` si la celda empieza con `= + - @`) y solo alias.
- **Validación de la query**: el repositorio no usa Zod; se usaron los validadores cerrados de `cfo-esquemas.ts` (mismo papel que en el resto del CFO).
- **Afinidad en varias sucursales**: `cfo_canasta_pares` corta el top por sucursal (se pide con el máximo, 500) e informa los pedidos por producto solo de los productos que salen en esos pares; con varias sucursales el lift es una **cota superior**. La pantalla lo dice.
- **Producto más frecuente por cliente** en la reactivación: no entra (exigiría leer `items` por cliente); queda para una fase posterior. Tampoco «segmentos que compran cada producto».
- **Lista de reactivación**: tope de filas (`limite` 1..200), sin cursor ni paginación real; no es k-anónima (ver arriba).
- **Fuera de A, declarado**: botón «Preparar campaña» (la generación de borradores es solo-sistema y requiere una función de escritura nueva, con consentimiento), quejas por tipo (no hay motivos estructurados), respuesta humana por hora (los mensajes no tienen marca de tiempo), salsas/omisiones estructuradas, historial importado (Fase B), alertas (Fase C).
- **Historial importado**: cuando exista (Fase B) aparecerá solo aquí y rotulado; no entra a KPIs ni al cierre en vivo.
- **Rendimiento**: probado con 10 000 ventas y 1 500 clientes (< 2 s por función). `cfo_venta_lean` es lineal en los pedidos del rango; con organizaciones muy grandes hace falta `EXPLAIN` con volumen (Fase D).
- **No verificado contra la base real**: nada se aplicó a producción; las cifras de referencia del documento de diseño (p. ej. 496 clientes) no se contrastaron.
