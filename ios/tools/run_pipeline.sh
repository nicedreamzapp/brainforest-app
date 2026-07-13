#!/bin/bash
# Brainforest content pipeline: wait for factory -> judge -> enrich -> voice pack
set -x
while pgrep -f "generate_content.py" > /dev/null; do sleep 30; done
echo "=== factory done, judging ==="
python3 judge_content.py
echo "=== enriching ==="
python3 enrich_banks.py
echo "=== voice pack ==="
~/JaneOS/.venv/bin/python3 build_voice_pack.py
echo "=== PIPELINE COMPLETE ==="
