#!/bin/bash
# Lote 1 (voz, cascada: LLM + herramientas por texto). Tope duro global US$24 (prefijo v1). Uso: OPENROUTER_API_KEY=... bash scripts/voz-bench/lote1-voz.sh <ola>
D=${VOZ_BENCH_OUT:-$HOME/atiende-loop/work/voz-bench-resultados}; CAP=24
NUCLEO=V01,V02,V03,V04,V05,V06,V07,V17,V18,V19,V20,V21,V22,V24,V25,V26,V27,V28,V29,V30,V31,V32
R="npx vite-node scripts/voz-bench/run.ts --motor cascada --lote v1-voz --cap $CAP --conc 2"
case "$1" in
  1)
    $R --out $D/v1-voz-haiku-low.jsonl --modelo anthropic/claude-haiku-5.5 --razon low --etiqueta actual --reps 5 > $D/v1-voz-haiku-low.log 2>&1 &
    $R --out $D/v1-voz-haiku-none-cache.jsonl --modelo anthropic/claude-haiku-5.5 --razon none --cache --etiqueta none-cache --reps 5 > $D/v1-voz-haiku-none-cache.log 2>&1 &
    $R --out $D/v1-voz-sonnet-low-cache.jsonl --modelo anthropic/claude-sonnet-5.5 --razon low --cache --etiqueta low-cache --reps 5 > $D/v1-voz-sonnet-low-cache.log 2>&1 &
    $R --out $D/v1-voz-luna-none.jsonl --modelo openai/gpt-6-luna --razon none --etiqueta none --reps 5 > $D/v1-voz-luna-none.log 2>&1 &
    $R --out $D/v1-voz-luna-low.jsonl --modelo openai/gpt-6-luna --razon low --etiqueta low --reps 5 > $D/v1-voz-luna-low.log 2>&1 &
    wait ;;
  2)
    $R --out $D/v1-voz-flash38-low.jsonl --modelo google/gemini-3.8-flash --razon low --etiqueta low --reps 5 > $D/v1-voz-flash38-low.log 2>&1 &
    $R --out $D/v1-voz-sol61-low.jsonl --modelo openai/gpt-6.1-sol --razon low --etiqueta low --reps 3 --guiones $NUCLEO > $D/v1-voz-sol61-low.log 2>&1 &
    wait ;;
esac
