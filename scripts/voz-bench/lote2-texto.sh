#!/bin/bash
# Lote 2 (texto/WhatsApp, casos dorados de PM + S1). Tope duro global US$24 (prefijo v2). Uso: OPENROUTER_API_KEY=... bash scripts/voz-bench/lote2-texto.sh <ola>
D=${VOZ_BENCH_OUT:-$HOME/atiende-loop/work/voz-bench-resultados}; CAP=24
CASOS=$(cat $D/casos-texto.txt)
R="npx vite-node scripts/voz-bench/texto.ts --lote v2-texto --cap $CAP --conc 2"
case "$1" in
  1)
    $R --out $D/v2-texto-haiku-low.jsonl --modelo anthropic/claude-haiku-5.5 --razon low --etiqueta actual --reps 3 --casos $CASOS > $D/v2-texto-haiku-low.log 2>&1 &
    $R --out $D/v2-texto-haiku-none-cache.jsonl --modelo anthropic/claude-haiku-5.5 --razon none --cache --etiqueta none-cache --reps 3 --casos $CASOS > $D/v2-texto-haiku-none-cache.log 2>&1 &
    $R --out $D/v2-texto-luna-none.jsonl --modelo openai/gpt-6-luna --razon none --etiqueta none --reps 3 --casos $CASOS > $D/v2-texto-luna-none.log 2>&1 &
    $R --out $D/v2-texto-luna-low.jsonl --modelo openai/gpt-6-luna --razon low --etiqueta low --reps 3 --casos $CASOS > $D/v2-texto-luna-low.log 2>&1 &
    wait ;;
  2)
    $R --out $D/v2-texto-sonnet-low-cache.jsonl --modelo anthropic/claude-sonnet-5.5 --razon low --cache --etiqueta low-cache --reps 2 --casos $CASOS > $D/v2-texto-sonnet-low-cache.log 2>&1 &
    $R --out $D/v2-texto-flash38-low.jsonl --modelo google/gemini-3.8-flash --razon low --etiqueta low --reps 1 --casos $CASOS > $D/v2-texto-flash38-low.log 2>&1 &
    wait ;;
  3)
    # S1 con 5 repeticiones por modelo (orden de Javier)
    for cfg in "anthropic/claude-haiku-5.5|low|actual" "anthropic/claude-haiku-5.5|none|none-cache" "openai/gpt-6-luna|none|none" "openai/gpt-6-luna|low|low" "anthropic/claude-sonnet-5.5|low|low-cache" "google/gemini-3.8-flash|low|low" "openai/gpt-6.1-sol|low|low"; do
      IFS='|' read m r e <<< "$cfg"; X=""; [[ "$e" == *cache ]] && X="--cache"
      $R --out $D/v2-texto-s1-$(echo $m | tr '/.' '--')-$e.jsonl --modelo $m --razon $r --etiqueta $e $X --reps 5 --casos S1 > /dev/null 2>&1
    done ;;
esac
