# Evals del agente de Los Taquitos de PM (WhatsApp y voz)

Fuente única de verdad de las mediciones del agente de PM. Antes de este documento los informes y los resultados crudos vivían solo en la Mac del
loop (`~/atiende-loop`, que no es repo git). Aquí queda: qué se midió, con qué código, con qué arnés y comando, cuánto costó y qué tan comparable es.
Voz tiene su propio documento: [`voz.md`](voz.md).

Corte: **9-nov-2026**, `main` = `cd4eeadc3` (Merge #778). Ninguna medición es punta a punta con Meta real ni con telefonía real.

## Cómo leer las cifras

- **Tres arneses distintos**; sus porcentajes **no se suman ni se comparan directo** entre arneses:
  1. **pm-agente-loop (rondas 1-8, oct)**: API real local (`buildProductionDeps`) + Postgres efímero con la configuración real de PM (export de solo lectura) +
     OpenRouter real (agente `openai/gpt-6-luna`, esfuerzo `low`) + cliente simulado y juez LLM; Meta **simulado**. Métrica principal: **cierre real**
     (conversaciones donde el agente creó el pedido / conversaciones). Suites: guion demo, adversariales, PM-C5 (escenarios de chats reales de T7, anonimizados), carga.
  2. **Banco ciego C3/C4 en el monorepo** (`scripts/medicion-nube/correr-c3-local.sh`, hoy en la rama de #718): API real local **por webhook** + Postgres efímero
     fresco por repetición; cliente simulado Haiku 5.5; veredicto **determinista** por escenario (pedidos, renglones, total, pago, escalaciones, frases obligatorias y prohibidas).
  3. **Banco ciego C3/C4 en el suelto** (repo privado `javiercamarapp/atiende-restaurantes`, `scripts/medicion/correr.mjs`): mismo banco y mismo verificador, pero el
     agente corre **en proceso** (sin webhook ni ráfaga de 6 s).
- **Punta a punta local** = LLM real + API real + base real efímera, con el canal (Meta) simulado. **Guionado** = sin LLM (agente de referencia o corrida seca).
- Los intervalos son **Wilson 95 %**. Con n=5 por escenario, 1-2 repeticiones de diferencia no son señal.
- El gasto se mide como delta del uso de la llave de OpenRouter, que es **compartida** con otros agentes: es cota superior salvo donde se dice «suma de `usage.cost`».

## Trayectoria (WhatsApp)

| Fecha | % | Fracción | Código (repo) | Arnés / suite | n | Costo | Tipo |
|---|---|---|---|---|---|---|---|
| 8-oct | **36.5 %** | 50/137 cierre real | monorepo `e4bb1d98` (main, Merge #517) | pm-agente-loop, ronda 4 (guion 8 + adversariales 48 + PM-C5 71 + carga) | ×1 | 1.76 USD de OpenRouter para toda la ronda (agente, cliente, juez y evals) | punta a punta local |
| 8-oct | **59.8 %** | 76/127 cierre real | monorepo #528 `0c9426fa1` | pm-agente-loop, ronda 5 re-corrida con #528 | ×1 | sin dato | punta a punta local |
| — | **83 %** | — | — | **Sin fuente, pendiente de aclarar con Javier.** No existe ninguna medición de WhatsApp con 83 %. Sí hay 83 % en voz (r3 restaurante 10/12, ver `voz.md`) | — | — | — |
| 3-nov | **93.5 %** | 374/400 | **suelto** `ace28e8` | C3 (ciego-3, 80 escenarios), Luna + cliente Haiku 5.5 | ×5 | 1.64 USD (suma `usage.cost`) / 1.68 (llave) | punta a punta en proceso |
| 6-nov | 91.0 % | 364/400 | suelto PR21 `1939849` | C3 ×5 (C3 ya no era ciego: se usó para desarrollar) | ×5 | 2.15 USD | punta a punta en proceso |
| 7-nov | 88.4 % | 160/181 válidas | monorepo #718 `e084d5a` | C3 ×3, **cortada por tope** en 183/237 | ×2.3 | 3.51 USD | punta a punta local (webhook) |
| 7/8-nov | **88.8 %** | 213/240 | suelto `e69279e` | **C4 ciego** (80 escenarios) | ×3 | 1.11 USD (suma) / 1.13 (llave) | punta a punta en proceso |
| 7-nov | **86.8 %** | 347/400 | monorepo #718 `5107d110d` | **C4 ciego**, cerebro_v2 (Luna → Haiku 5.5, ZDR) | ×5 | 4.56 USD (llave) / 3.87 (gateway) | punta a punta local (webhook) |
| 8-nov | — | 20/23 | monorepo #718 `fa304de9f` | C4 ×5 **interrumpida** por orden de Javier en la rep 1 | — | ~0.32 USD | **no cuenta** |

**C4: suelto 88.8 % contra monorepo #718 86.8 %**: los intervalos se traslapan (84-92 % contra 83-90 %); con este n no hay diferencia significativa.
#718 pierde en tres defectos del servidor (17 de 53 fallos) y una regla de negocio sin decidir (umbral de pedido grande en efectivo sin historial: el servidor usa
más de $2,500, el banco asume más de $4,000; 5 fallos). Esos tres defectos se arreglaron en `fa304de9f`, **que sigue sin medir**. Análisis completo:
`resultados/2026-11-07-c4-monorepo718-5107d110d/AGREGADO.txt` y la sección «Fallos por causa» abajo.

Por qué no hay serie continua: la meta cambió (cierre real ≥ 85 % → ≥ 95 % por suite), el arnés cambió (rondas → banco ciego) y C3 dejó de ser ciego después del
3-nov (cualquier arreglo hecho viendo sus fallas lo convierte en banco de desarrollo). El número honesto vigente es **C4**.

## Detalle por medición

### R4 — 8-oct, `e4bb1d98` (36.5 %)
- Modelo: agente `openai/gpt-6-luna` `low`; juez Sonnet; voz por Gemini Live real (14/15).
- Arnés: workflow `~/atiende-loop/pm-agente-loop.js` `{ronda:4}` con `qa/run.ts` local (fuera del repo); Postgres efímero `:55491`, config real de PM (169 zonas, 189 `known_zone`, 2 promos).
- Otras cifras de la ronda: tareas (juez) 47/120; latencia mediana 11.8 s (meta ≤ 10 s); 0 duplicados; 0 precios inventados; 5 afirmaciones falsas (0 P0).
- Crudos: `resultados/2026-10-08-r4-monorepo-e4bb1d98/` (métricas por conversación de cada suite, voz y resúmenes de la lente «romper»).

### R5 — 8-oct, `0d69e8a5` (0 %) y con #528 `0c9426fa1` (59.8 %)
- Sobre main `0d69e8a5` hubo una **regresión P0 de #522**: `crear_pedido` rechazaba `propina_porcentaje: 0` → 0 pedidos de WhatsApp en 128 conversaciones. Crudos de esa corrida: `resultados/2026-10-08-r5-main-0d69e8a5/`.
- Con el arreglo (#528, `0c9426fa1`) la re-corrida dio **76/127 = 59.8 %**, latencia mediana 11.81 s. La cifra sale del relevo del 8-oct y de la tabla de la ronda 6;
  **sus crudos no se localizaron** en la Mac (no se copian).

### C3 suelto — 3-nov, `ace28e8` (93.5 %)
- Comando (repo suelto): `node scripts/medicion/correr.mjs --modelo openai/gpt-6-luna --repeticiones 5 --concurrencia 2 --solo-json --escenarios-json <ciego-3.json>`.
- Turno p50/p95 4.9/12.6 s; 0.0041 USD por conversación; 64 escenarios siempre pasan, 16 inestables, 0 siempre fallan.
- Lectura de sus 26 fallas: solo ~6 puntos eran defectos reales del agente; el resto, verificador estricto (13), ruido del cliente simulado (5) y regex (2).
- Crudos: `resultados/2026-11-03-c3-suelto-ace28e8/`.

### C3 suelto PR21 — 6-nov, `1939849` (91 %)
- Mismo comando; C3 ya no era ciego. Crudos: `resultados/2026-11-06-c3-suelto-pr21-1939849/`.

### C3 monorepo #718 — 7-nov, `e084d5a` (88 %)
- Comando: `QA_C3_JSON=<ciego-3> REPS=3 CEREBRO_V2=1 MODO=default TOPE_USD=3.5 ETQ=c3-x3-e084d5a bash scripts/medicion-nube/correr-c3-local.sh`.
- Cortada por tope en 183/237; 2 inválidas por proveedor; sin 2 escenarios imposibles en el destino: 160/177 = 90 %. Turno (telemetría) 8.7/23.4 s.
- Crudos: `resultados/2026-11-07-c3-monorepo718-e084d5a/`.

### C4 monorepo #718 — 7-nov, `5107d110d` (86.8 %)
- Comando: `QA_C3_JSON=<banco-c4/ciego-4.json> REPS=5 CEREBRO_V2=1 MODO=default TOPE_USD=10 ETQ=c4-5107d11-x5 bash scripts/medicion-nube/correr-c3-local.sh`.
- Agente: escalera ZDR de producción Luna → Haiku 5.5 (respondieron Luna 377, Haiku 42). 0 inválidas, 0 fallas de proveedor en 1,908 turnos.
- Turno: telemetría 5.8/13.2 s; webhook 8.0/15.5 s (incluye la espera de ráfaga). 0.0114 USD por conversación (2.5× el suelto: ~224k tokens de entrada contra ~105k).
- Crudos: `resultados/2026-11-07-c4-monorepo718-5107d110d/`.

### C4 suelto — 7/8-nov, `e69279e` (88.8 %)
- Comando: `node scripts/medicion/correr.mjs --modelo openai/gpt-6-luna --repeticiones 3 --concurrencia 2 --solo-json --escenarios-json <ciego-4.json>`.
- Turno 4.5/12.3 s; 0.0046 USD por conversación. Crudos: `resultados/2026-11-08-c4-suelto-e69279e/`.

### C4 monorepo #718 — 8-nov, `fa304de9f` (interrumpida)
- Tras arreglar 3 defectos (colonia en dirección completa y nombre que no cuenta como intento; disculpa al pedir al gerente; tiempo de la sucursal asignada).
- Detenida en la rep 1 (23 conversaciones, 20 pasan). **No es comparable.** Pendiente con OK de gasto: C4 ×5 sobre la cabeza congelada.
- Crudos parciales: `resultados/2026-11-08-c4-monorepo718-fa304de9f-INTERRUMPIDA/`.

### Fallos por causa de C4 en #718 `5107d110d` (53)
| n | causa | clase |
|---|---|---|
| 9 | renglones o total distintos, sin patrón único | agente |
| 7 | escala por `zona_no_reconocida` con colonia válida, o cuenta un mensaje sin colonia como intento | **servidor** (arreglado en `fa304de9f`) |
| 7 | escalación de más bajo presión del cliente | agente / verificador |
| 6 | escalación rápida sin disculpa («quiero al gerente») | **servidor** (arreglado en `fa304de9f`) |
| 5 | pedido grande: $3,700 en efectivo sin historial queda `por_aprobar` | **regla del dueño** (umbral $2,500 contra $4,000) |
| 5 | no dice «40-50 min»: la sucursal que cubre no trae `tiempo_entrega` | **servidor** (arreglado en `fa304de9f`) |
| 5 | el cliente desiste (mínimo de $200, piezas sueltas) | cliente simulado / regla |
| 9 | frase obligatoria faltante, aviso tras crear, taquiza sin escalar, propina sumada, pago | agente / verificador |

## Cómo reproducir

### Sin gastar (guionado / dobles)
- **Casos dorados del agente (68, sin LLM)**: `npx vitest run packages/domain-restaurantes/tests/evals-agente-pm.spec.ts --maxWorkers=2`
  (agente de referencia guionado + 19 graders deterministas; ver `packages/domain-restaurantes/src/evals/agente-pm/README.md`). También corre en CI.
- **Corrida seca del banco C3/C4** (rama de #718): `SECO=1 QA_C3_BANCO=c3 bash scripts/medicion-nube/correr-c3-local.sh` — sin cliente ni agente:
  `buscar_sucursal_cercana` y `cotizar_pedido` reales contra Postgres efímero; no lee la llave. Concilia con `python3 scripts/medicion-nube/c3-conciliar.py --seco`.
- **Agregar resultados ya existentes**: `python3 scripts/medicion-nube/agregar.py` (en main) o `agregar-c3.py` (rama de #718) sobre las repeticiones de una medición.
- **Voz sin gastar**: ver `voz.md` (pruebas unitarias de la cascada y `evals:hoteles:voz:falso`).

### Con LLM real (gasta OpenRouter)
- Requisito: confirmación expresa de Javier (desde el 8-nov **no hay mediciones de pago** hasta nueva orden) y solo modelos de la lista barata.
- Una medición a la vez: el uso de la llave es global y otra corrida contamina el tope.
- C4 en el monorepo (cabeza a medir checada, Postgres local en `~/.local/pg17`):
  `QA_C3_JSON=<ruta>/ciego-4.json REPS=5 CEREBRO_V2=1 MODO=default TOPE_USD=6 ETQ=c4-<sha>-x5 bash scripts/medicion-nube/correr-c3-local.sh`
  — `TOPE_USD` es corte **duro** sobre el delta de la llave (la ×5 de `5107d110d` gastó 4.56 USD; 6 deja margen). Resultado: `<OUT_BASE>/<ETQ>/AGREGADO.txt`.
- Casos dorados con LLM: `PM_EVALS_REAL=1 PM_EVALS_MODEL=openai/gpt-6-luna PM_EVALS_MAX_USD=2 npm run evals:pm:real -w @atiende/domain-restaurantes`
  (la llave va por entorno, nunca en el repo; `PM_EVALS_MAX_USD` corta la corrida).
- En GitHub Actions: `scripts/medicion-nube/README.md` (`medicion-agente.yml`, `tope_total_usd` 8 por omisión). Hoy **Actions está bloqueado por facturación** (desde 8-nov).

## Carpeta `resultados/`

Una carpeta por medición: `<fecha>-<etiqueta>-<commit>`. Contenido **solo métricas** (ver «Privacidad»): veredicto, comprobaciones (id y ok), pedidos
(sucursal, entrega, total, pago, renglones del menú), códigos de escalación, latencias, tokens, costo y modelos que respondieron; `AGREGADO.txt` y `uso-*.txt` tal cual.

| Carpeta | Medición | Origen local (no versionado) |
|---|---|---|
| `2026-10-08-r4-monorepo-e4bb1d98` | R4 | `~/atiende-loop/work/qa/pm-agente-loop/ronda-4/datos`, `casos-whatsapp/resumen-*.json` |
| `2026-10-08-r5-main-0d69e8a5` | R5 sin #528 (0/128) | `.../ronda-5/datos` |
| `2026-11-03-c3-suelto-ace28e8` | C3 suelto 93.5 % | `~/atiende-loop/work/pm-cuenta-real/medicion-suelto/examen-c3` |
| `2026-11-06-c3-suelto-pr21-1939849` | C3 suelto 91 % | `.../medicion-suelto/pr21` |
| `2026-11-07-c3-monorepo718-e084d5a` | C3 #718 88 % | `.../medicion-c3/c3-x3-e084d5a` |
| `2026-11-07-c4-monorepo718-5107d110d` | C4 #718 86.8 % | `.../medicion-c3/c4-5107d11-x5` |
| `2026-11-08-c4-suelto-e69279e` | C4 suelto 88.8 % | `.../medicion-suelto/c4` |
| `2026-11-08-c4-monorepo718-fa304de9f-INTERRUMPIDA` | parcial, no cuenta | `.../medicion-c3/c4-fa304de-x5-INTERRUMPIDA` |
| `2026-11-0*-voz-*` y `voz-llamadas.csv` | voz r3/r3b/r3c/r4 | `~/atiende-loop/work/wt-voz-r3/.voz-qa/results` (ver `voz.md`) |

Lo que **no** se copió y dónde vivía: transcripciones completas (`texto`, `transcript`, `turnos`), `log.txt`, `pg.log` y `telemetria-turnos.jsonl` de cada repetición,
los barridos de modelos (`medicion-suelto/barrido-*`, `nube-resultados/`, ~25 MB + 11 MB), las corridas de desarrollo (`medicion-c3/c3-seco*`, `c3-v2-*`, `principal-*`),
los informes `MEDICION-*.md`, `HANDOFF-*.md`, `COSTOS-MEDIDOS.md` (su contenido relevante está resumido aquí y en `voz.md`) y las grabaciones de voz (`.wav`, ~1 GB).

## Privacidad

Repo público. Los bancos C3/C4 son sintéticos (nombres, direcciones y teléfonos inventados), pero PM-C5 se derivó de chats reales anonimizados y las conversaciones
del cliente simulado repiten datos de las personas del banco. Por eso los JSON se copiaron **sin ningún texto de conversación**: se quitaron transcripciones,
motivos del juez, eventos, nombres, direcciones y teléfonos; los códigos de escalación quedan sin su texto libre y las fallas del verificador sin el texto citado
(`[detalle omitido]`). Después se escanearon todos los archivos buscando teléfonos (10 dígitos, con o sin +52), correos, rutas de la Mac y llaves: 0 hallazgos
(las únicas cadenas de 10 dígitos son marcas de tiempo Unix).
