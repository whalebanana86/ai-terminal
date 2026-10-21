#!/bin/bash
# README 그림용 가짜 claude (stream-json 채팅). 실제 Claude 를 부르지 않는다.
# 메시지를 받으면 "테스트를 돌려도 될까요?" 승인 요청을 내고, 허용하면 결과를 답한다.
sid="demo-session"
while [ $# -gt 0 ]; do
  case "$1" in
    --resume|--session-id) sid="$2"; shift ;;
  esac
  shift
done
read -r _init
echo "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"$sid\"}"
while read -r line; do
  case "$line" in
    *'"behavior":"allow"'*)
      sleep 0.6
      echo '{"type":"assistant","message":{"content":[{"type":"text","text":"테스트 5개가 모두 통과했어요.\n\n- 고정한 일이 맨 위로 와요\n- 그다음 안 끝난 일 → 마감일이 가까운 순\n\nsrc/lib/sort.ts 만 고쳤고, 커밋은 아직 안 했어요."}]}}'
      echo '{"type":"result","total_cost_usd":0.012,"is_error":false}' ;;
    *'"behavior":"deny"'*)
      echo '{"type":"assistant","message":{"content":[{"type":"text","text":"알겠어요. 테스트는 돌리지 않을게요."}]}}'
      echo '{"type":"result","total_cost_usd":0.004,"is_error":false}' ;;
    *'"type":"user"'*)
      sleep 0.8
      echo '{"type":"assistant","message":{"content":[{"type":"text","text":"고정한 일을 맨 위에 두도록 정렬을 고쳤어요. 확인하려고 정렬 테스트를 돌려 볼게요."}]}}'
      echo '{"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"pnpm test -- sort","description":"정렬 테스트 실행"}}}' ;;
  esac
done
