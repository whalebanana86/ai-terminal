#!/bin/bash
# 배포 앱의 CPU·메모리 사용량을 잰다. 앱 프로세스 + 앱이 띄운 WebKit 프로세스(화면·네트워크·GPU)를 합산한다.
# 사용: scripts/measure.sh [측정초=60] [앱경로]
set -euo pipefail
SECS=${1:-60}
APP=${2:-"$(cd "$(dirname "$0")/.." && pwd)/src-tauri/target/release/bundle/macos/코드행방.app"}

pkill -x ai-terminal 2>/dev/null || true
sleep 1
BEFORE=$(pgrep -f 'com.apple.WebKit' | sort -n | paste -sd' ' -)
open "$APP"
until pgrep -x ai-terminal >/dev/null; do sleep 0.2; done
APP_PID=$(pgrep -nx ai-terminal)
sleep 12   # 시작·첫 로딩이 끝나기를 기다린다
# 앱 실행 뒤 새로 생긴 WebKit 프로세스 = 이 앱의 웹뷰
KIDS=""
for p in $(pgrep -f 'com.apple.WebKit'); do
  case " $BEFORE " in *" $p "*) ;; *) KIDS="$KIDS $p";; esac
done
PIDS="$APP_PID$KIDS"

cpu_secs() { # 누적 CPU 초 합계
  ps -o time= -p "$(echo $PIDS | tr ' ' ',')" 2>/dev/null | awk -F'[:.]' '{ if (NF==3) s+=$1*60+$2+$3/100; else if (NF==4) s+=$1*3600+$2*60+$3+$4/100 } END { printf "%.2f", s }'
}
rss_mb() { ps -o rss= -p "$(echo $PIDS | tr ' ' ',')" 2>/dev/null | awk '{s+=$1} END {printf "%.1f", s/1024}'; }

C0=$(cpu_secs); T0=$(date +%s)
PEAK=0
for _ in $(seq 1 $((SECS / 2))); do
  R=$(rss_mb); PEAK=$(echo "$R $PEAK" | awk '{print ($1>$2)?$1:$2}')
  sleep 2
done
C1=$(cpu_secs); T1=$(date +%s)
echo "프로세스: $PIDS"
ps -o pid=,rss=,comm= -p "$(echo $PIDS | tr ' ' ',')" | awk '{printf "  %-6s %7.1f MB  %s\n", $1, $2/1024, $3}'
echo "평균 CPU: $(echo "$C0 $C1 $T0 $T1" | awk '{printf "%.2f", ($2-$1)/($4-$3)*100}') % (한 코어 기준, ${SECS}초)"
echo "메모리(RSS 합): 현재 $(rss_mb) MB, 최대 $PEAK MB"
