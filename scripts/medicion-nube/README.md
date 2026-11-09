# Medicion del agente de PM en GitHub Actions

Corre la medicion R21 (42 escenarios NUCLEO) o el simulador (piloto ~108) en paralelo: una repeticion por job, cada job con su
propio runner y su propio Postgres efimero (puerto 55491, SSL autofirmado, todas las migraciones de `supabase/migrations`).
Reproduce `correr-r21.sh` / `correr-sim.sh` del arnes local. **Gasta saldo real de OpenRouter**; el workflow es solo `workflow_dispatch`.

## Lanzar

```
gh workflow run medicion-agente.yml --ref <rama> \
  -f etiqueta=m34 -f repeticiones=5 -f suite=r21 -f evidencia_alineada=false
gh run watch   # o la pestana Actions; el resultado agregado queda en el Summary del run
```

Inputs: `etiqueta`, `repeticiones` (1-5), `suite` (`r21`|`sim`), `evidencia_alineada` (EVIDENCIA_AGREGADOS=1), `modo` (on|off|default),
`max_paralelo`, `conc` (conversaciones simultaneas por job, 2 como en la Mac), `tope_job_usd` (vacio = 2 en r21 / 5 en sim),
`tope_total_usd` (corte global sobre el uso de la llave al lanzar; por omision 8).
**El workflow debe existir en la rama por defecto para poder lanzarse** (limite de GitHub para `workflow_dispatch`); `--ref` elige
la rama cuyo codigo se mide (migraciones, agente y arnes salen de ese checkout).

## Costo estimado (medido en la Mac, delta de `/api/v1/key`)

| suite | por repeticion | tiempo por rep | 5 reps |
|---|---|---|---|
| r21 | USD 0.2 a 0.56 (promedio ~0.4) | ~27 min (Mac con carga); limite del job 75 min | ~USD 2 |
| sim (piloto) | USD ~1.4 a 2.8 | 2.8 h en la Mac cargada; limite del job 180 min | ~USD 7 a 14 (subir `tope_total_usd`) |

Minutos de Actions: gratis en repo publico. Los cortes: cada job consulta `/api/v1/key` cada 15 s y se mata si el uso sube
`tope_job_usd` desde que arranco o `tope_total_usd` sobre el uso base leido al lanzar. El uso de la llave es global: con reps en
paralelo, el delta de un job incluye lo que gastan los demas (por eso el tope por job es holgado y el corte global es el real).
El job `preparar` tambien aborta si `limit_remaining` de la llave es menor que `tope_total_usd`.

## Secretos

- `OPENROUTER_API_KEY` (ya existe). Solo es env del paso que corre `correr.sh` y del paso de `preparar`.
- Suite `sim`: el corpus de escenarios es PRIVADO y no puede vivir en el repo. Requiere el secreto `CORPUS_SIM_GZ_B64` con el JSON
  gzip + base64 (limite de un secreto: 48 KB). El corpus completo (477) pesa ~84 KB en base64 y NO cabe; hay que subir el subconjunto
  del piloto (~108 ids, ~22-30 KB):
  `python3 -c "import json,gzip,base64,sys; print(base64.b64encode(gzip.compress(open(sys.argv[1],'rb').read(),9)).decode())" corpus-piloto.json | gh secret set CORPUS_SIM_GZ_B64`
  (el JSON debe conservar la forma `{"escenarios":[...]}` y el piloto se genera con la misma seleccion `QA_SIM_FILTRO=piloto` del arnes).
  Para sim, los artefactos y logs de un repo publico son publicos: `correr.sh` NO sube `log.txt` ni las conversaciones, solo un resumen sin
  texto (`convos-sim-min.json`), la telemetria y las marcas.

## Contenido

- `correr.sh` — una repeticion, parametrizada por env (ver su cabecera): suite, etiqueta, modelo, modo, `NUCLEO`, `CONC`, `EVIDENCIA_AGREGADOS`, topes.
- `pg-up.sh` — Postgres efimero (derivado de `r18-ejec/qa/pg-up.sh`: usa los binarios que trae `ubuntu-latest`, o los instala).
- `agregar.py` — agrega las reps: pasan/total, pasan sin invalidas, p95 de turno (convos y telemetria), `fetch_failed`, `error_proveedor`, escenarios fallidos.
- `arnes/` — copia del arnes local (`run`, `suites*`, `lib`, `stack`, `evidencia-juez`, `setup-orders`, `llm`, `inv-precio`, `vite-node.config`, SQL, `cargar-config.py`).
  Los `.ts` van como `*.ts.txt` para que el typecheck/lint de la raiz no los tomen (importan `../repo/...` y usan extensiones `.ts`); `correr.sh` los
  restaura y arma el layout `<tmp>/qa` + `<tmp>/repo -> checkout` que el arnes espera. Cambios respecto a la copia local: solo las rutas por omision
  con `$HOME` de `run.ts` (carpeta de resultados) y `suites.ts` (corpus), ahora relativas / sin default.
- `arnes/real-dump/` — catalogo y configuracion del negocio (menus, precios, sucursales, zonas, textos del agente) exportada de solo lectura. No contiene
  clientes finales, pedidos ni correos; si no se quiere en un repo publico, quitarla y servirla como artefacto privado.

## No cubre

`analiza-r21.py` (comparacion ON/OFF con Fisher/bootstrap) no se copio: depende de `analiza-cierre.py` y de la estructura de carpetas local. Descargar los
artefactos (`gh run download`) y usarlo localmente si hace falta.

## Suite C3 (banco ciego 3) en la Mac — `correr-c3-local.sh`

Banco ciego C3 (80 escenarios, `arnes/ciego-3.fuente.json` = copia literal de `wt-medir21/scripts/medicion/escenarios/ciego-3.json`) portado a este arnes:
API real + Postgres efimero + catalogo `real-dump` + Meta simulado. **Veredicto determinista, sin juez LLM** (`arnes/suites-c3.ts.txt`, puerto de
`lib/verificar.mjs` sobre `restaurantes.orders`, `callback_requests` y `conversation_handoff`). Cliente simulado = `anthropic/claude-haiku-5.5` con
`persona.descripcion` + `hechos` + guion como intenciones (o el guion literal si el escenario trae `modo_cliente: "guion"`), igual que el origen.

```
# seco (sin LLM, sin gasto): herramientas reales por escenario -> c3-seco.json; despues regenerar el banco portado
SECO=1 ETQ=c3-seco bash scripts/medicion-nube/correr-c3-local.sh
python3 scripts/medicion-nube/c3-conciliar.py --seco <salida>/c3-seco.json --escribir
# medicion (gasta): espera a que no corra otra medicion; corte duro por TOPE_USD sobre el uso de la llave
QA_WA_MODEL=openai/gpt-6-luna TOPE_USD=1.5 REPS=1 CONC=2 [FILTRO='^C3-PED-'] bash scripts/medicion-nube/correr-c3-local.sh
python3 scripts/medicion-nube/agregar-c3.py <OUT_BASE>/<ETQ>     # (lo corre solo al final)
```

Mecanica que cambia respecto al origen (decisiones del puerto):
- **Numero POR SUCURSAL** (desde el 2026-11-06, decision del dueno de PM: cada sucursal tiene su propio WhatsApp): cada escenario escribe al numero
  de la sucursal `sucursal_chat` (lo fija `c3-conciliar.py`; reglas R1-R5 y la lista de casos cruzados en `_port.numeros_por_sucursal` y en
  `C3-CONCILIACION.md`). Los numeros salen de `whatsapp_branch_channel` (`prep-canales.sql` + `arnes/prep-canales-c3.sql`). Si el domicilio lo cubre otra
  sucursal, el agente toma el pedido para la que lo cubre (no rechaza), asi que `esperado.sucursal` no cambia. `QA_C3_NUMERO=org` reproduce el banco
  anterior: todos escriben al numero de la organizacion `5550009999` (en `whatsapp_channel_config` y NO en `whatsapp_branch_channel`, sin "sucursal de este chat").
- **Reloj por conversacion** (`stack.ts`: `conRelojPropio`/`cabeceraReloj`, AsyncLocalStorage + cabecera `x-qa-reloj`): cada escenario corre con su
  propio `reloj` (desplazado 7*k dias como todo el arnes), lo que permite `CONC=2` con 80 relojes distintos. Sin contexto, el reloj global de siempre.
- **Clientes existentes**: los pedidos previos se crean por la ruta de herramientas de voz en la sucursal que asigna la herramienta a la direccion
  guardada, y despues se ajustan `created_at`/`status` (`completed` -> `entregado`); las direcciones van a `customer_addresses` por SQL.
- **Escalaciones** = `max(callback_requests, conversation_handoff nuevos)` (un aviso suele dejar las dos filas). Silencio del agente con toma de
  handoff abierta = fin de la conversacion; silencio sin toma = FALLA `responde_cada_mensaje`.
- **INVALIDA** cuando el turno del agente fallo por el proveedor (telemetria `error_proveedor`/`presupuesto_agotado`, atribuida por el HMAC del
  telefono como en `deps.ts`), "fetch failed", HTTP 5xx o el cliente simulado no respondio. `agregar-c3.py` imprime ademas el conteo ESTRICTO del
  origen (proveedor = FALLA) para comparar con la referencia 364/400 (91 %).
- **Tiempos permitidos**: 10/25/30 del origen + los numeros de `delivery_time_text` de la cuenta real (35, 40, 45, 50, 60, 75, 90).
- No se porta `cotiza_antes_de_crear` (no hay traza de herramientas por conversacion sin `QA_TRACE`; el servidor ya exige cotizacion confirmada).
- Conciliacion de catalogo y adaptaciones (A1-A4): `c3-conciliar.py` y su salida `C3-CONCILIACION.md`; cada escenario adaptado lleva `_port`.

## Banco principal (51 escenarios del suelto) en la Mac — mismo corredor que C3

Banco PRINCIPAL del arnes suelto (`wt-medir21/scripts/medicion/escenarios/catalogo.mjs`, export `ESCENARIOS`: 51 sinteticos) con la misma mecanica y
el mismo veredicto determinista que C3 (`verificarC3`). Referencia del suelto con Luna: 88/102 (`pm-cuenta-real/medicion-suelto/pr21/principal-1939849-luna-x2.json`).

- `arnes/principal.fuente.json` — export literal a JSON (`{"banco":"principal","escenarios":[...]}`; los regex ya eran strings en el origen).
- `arnes/principal.json` — banco PORTADO, generado por `python3 c3-conciliar.py --banco principal --seco arnes/principal-seco.json --escribir`
  (detalle en `PRINCIPAL-CONCILIACION.md`). Con `--banco c3` (por omision) la salida de C3 queda byte-identica.
- `QA_C3_BANCO=principal` hace que la suite `c3` cargue `principal.json` en vez de `ciego-3.json`; la ETQ por omision empieza con el banco.

```
# seco (sin LLM, sin gasto) y regenerar el banco portado
QA_C3_BANCO=principal SECO=1 ETQ=principal-seco bash scripts/medicion-nube/correr-c3-local.sh
python3 scripts/medicion-nube/c3-conciliar.py --banco principal --seco <OUT_BASE>/principal-seco/c3-seco.json --escribir
# principal x2 (GASTA): 50 conversaciones por rep (S-NEW-005 excluido) x 2 = 100 conversaciones
QA_C3_BANCO=principal REPS=2 CEREBRO_V2=1 MODO=default TOPE_USD=2.5 bash scripts/medicion-nube/correr-c3-local.sh
```

Costo esperado: ~0.012 USD por conversacion (agente + cliente simulado) => ~0.6 USD por rep, ~1.2 USD las dos. El `TOPE_USD` por omision (1.5) queda
justo para x2; con 2.5 hay margen para reintentos sin dejar de ser un corte duro.

Adaptaciones del puerto (todas en `_port` de cada escenario y en `PRINCIPAL-CONCILIACION.md`; ninguna relaja la conducta medida):
- **X1 excluido** `S-NEW-005-sin-domicilio`: depende del override del fixture `sucursales.garcia-lavin.acepta_domicilio=false` y en la cuenta real
  todas las sucursales entregan. `_port.excluido`; la suite no lo corre (correrlo mediria otra cosa).
- **A5** `S-PED-013`: el nombre sintetico «Cliente Frecuente» esta en `NOMBRES_GENERICOS` del servidor destino (no deja crear el pedido); pasa a
  «Cliente Prueba Frecuente», como los demas.
- **A3** `S-NEW-018` (Caucel): la herramienta real asigna `fco-montejo` (4.8 km), no `pensiones`; el cliente escribe al numero de Pensiones (R1, caso cruzado).
- **P1** `S-NEW-007`/`S-NEW-008`: el servidor destino aplica en automatico `LUNES2X1PM` al recoger (renglon de cortesia a $0). El verificador cuenta la
  cortesia junto a su renglon pagado y no la toma como renglon de mas (`verificarC3`; sin cortesia el veredicto no cambia, tambien en C3).
  **Riesgo** en `S-NEW-008`: el destino aplica la promo en garcia-lavin, que segun la regla del dueno no tiene promos.
- **U1**: los bordes de monto (`S-NEW-001` 4450 > 4000, `S-NEW-002` = 4000, `S-REC-004` 5000, `S-NEW-015` 95 < 200) se conservan con la lista real.
- **Riesgo** `S-NEW-016`/`S-NEW-017` (Kanasin, Uman): la herramienta real responde `no_reconocida` (no `fuera_de_zona`).
- Seca: las 28 cotizaciones esperadas cotizan (26 = suma de catalogo; 2 con la promo), y las 5 semillas de clientes existentes se crean.
- Sin portar (igual que C3): `cotiza_antes_de_crear` y `espera_s` del guion (la rafaga de `S-PED-012` se manda mensaje a mensaje esperando respuesta).
  `escalacion_razon_re` usa los codigos del suelto (`cancelacion`, `transferencia_realizada`, `privacidad_arco`, `cobro_duplicado`): con `cerebro_v2` el
  servidor los conserva (`cerebro-v2/avisos.ts`, prefijo `alto_riesgo:`); `modificacion` casa con `modificacion_pedido`.
