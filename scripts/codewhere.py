#!/usr/bin/env python3
# Code Whereabouts terminal router. Python standard library only.
"""Route Codex requests locally and resume one session per Git worktree/name."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
try:
    import readline  # Enables normal cursor editing and in-memory history in the REPL.
except ImportError:
    pass

POLICY = json.loads(Path(__file__).resolve().with_name('codex-routing.json').read_text())
PRESETS = {
    'simple': ('gpt-6-luna', 'low'),
    'general': ('gpt-6.1-sol', 'low'),
    'complex': ('gpt-6.1-sol', 'medium'),
}
MODES = ('auto', *PRESETS)


def classify(text, mode='auto', previous=None):
    if mode != 'auto':
        return mode
    text = text.strip().lower()
    continuation = text.rstrip('.!?')
    for prefix in ('응 ', '네 ', '어 ', '응, ', '네, ', '어, ', 'yes, '):
        if continuation.startswith(prefix):
            continuation = continuation[len(prefix):]
            break
    if continuation in POLICY['followup']:
        return previous if previous in PRESETS else 'general'
    if len(text) > 1600 or any(w in text for w in POLICY['complex']):
        return 'complex'
    development = any(w in text for w in POLICY['development'])
    return 'simple' if not development and any(w in text for w in POLICY['simple']) else 'general'


def worktree(directory):
    result = subprocess.run(['git', '-C', str(directory), 'rev-parse', '--show-toplevel'],
                            text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('Git 저장소 안에서 실행하세요. / Run inside a Git repository.')
    return str(Path(result.stdout.strip()).resolve())


class Session:
    def __init__(self, root, name, state_dir):
        self.root, self.name = root, name
        key = hashlib.sha256(json.dumps([root, name]).encode()).hexdigest()
        self.directory = state_dir
        self.path = state_dir / (key + '.json')
        self.lockpath = state_dir / (key + '.lock')

    @contextlib.contextmanager
    def locked(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(self.lockpath, os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(fd, 'w') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('이 저장소 세션이 실행 중입니다. 다른 --session 이름을 사용하세요. / Session is busy.') from None
            yield

    def load(self):
        if not self.path.exists():
            return {}
        try:
            data = json.loads(self.path.read_text())
            if not isinstance(data, dict) or data.get('root') != self.root or data.get('name') != self.name:
                raise ValueError('invalid session identity')
            sid = data.get('sessionId')
            if sid is not None and (not isinstance(sid, str) or not sid or sid.startswith('-')):
                raise ValueError('invalid session ID')
            if data.get('task') not in (None, *PRESETS):
                raise ValueError('invalid task')
            return data
        except (ValueError, OSError) as error:
            raise RuntimeError(f'세션 기록을 읽을 수 없습니다: {self.path}: {error}') from error

    def save(self, data):
        # State deliberately excludes prompts, output, credentials and CLI configuration.
        data = dict(data, root=self.root, name=self.name)
        fd, temporary = tempfile.mkstemp(dir=self.directory)
        try:
            with os.fdopen(fd, 'w') as out:
                json.dump(data, out, ensure_ascii=False)
                out.write('\n')
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def reset(self):
        with self.locked():
            self.path.unlink(missing_ok=True)
        print('새 대화를 시작합니다. 기존 Codex 대화 기록은 유지됩니다. / New conversation.', file=sys.stderr)


def render(event):
    kind = event.get('type')
    if kind == 'item.started' and (event.get('item') or {}).get('type') == 'command_execution':
        print(f"$ {event['item'].get('command', '')}", file=sys.stderr, flush=True)
    elif kind == 'item.completed':
        item = event.get('item') or {}
        item_type = item.get('type')
        if item_type == 'agent_message':
            print(item.get('text', ''), flush=True)
        elif item_type == 'command_execution':
            output = item.get('aggregated_output')
            if output:
                print(output, end='' if output.endswith('\n') else '\n', file=sys.stderr, flush=True)
            if item.get('exit_code'):
                print(f"[command exit {item['exit_code']}]", file=sys.stderr)
        elif item_type == 'file_change':
            for change in item.get('changes', []):
                print(f"[{change.get('kind', 'change')}] {change.get('path', '')}", file=sys.stderr, flush=True)
        elif item_type in ('mcp_tool_call', 'web_search'):
            print(f"[{item_type}] {item.get('tool', item.get('query', ''))}", file=sys.stderr, flush=True)
    elif kind in ('error', 'turn.failed'):
        detail = event.get('error') or event.get('message') or event
        print(f'[Codex error] {detail}', file=sys.stderr, flush=True)


def execute(session, prompt, mode, sandbox, binary='codex', dry_run=False):
    with session.locked():
        state = session.load()
        task = classify(prompt, mode, state.get('task'))
        model, effort = PRESETS[task]
        sid = state.get('sessionId')
        args = [binary, 'exec'] + (['resume'] if sid else [])
        args += ['--json', '--model', model, '-c', f'model_reasoning_effort="{effort}"',
                 '-c', f'sandbox_mode="{sandbox}"']
        args += [sid, '-'] if sid else ['-C', session.root, '-']
        print(f'[Code Whereabouts] {task} → {model} {effort} · {"resume " + sid if sid else "new"}', file=sys.stderr, flush=True)
        if dry_run:
            print(json.dumps({'task': task, 'model': model, 'effort': effort, 'cwd': session.root,
                              'sessionId': sid, 'argv': args}, ensure_ascii=False))
            return 0
        # No shell, no automatic retries, and no approval/sandbox bypass flags.
        proc = subprocess.Popen(args, cwd=session.root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                text=True, encoding='utf-8', errors='replace', start_new_session=True)
        old_handlers = {}
        cancelled = 0
        cancel_timer = None

        def interrupt(signum, _frame):
            nonlocal cancelled, cancel_timer
            repeated = bool(cancelled)
            cancelled = 128 + signum
            try:
                os.killpg(proc.pid, signal.SIGKILL if repeated else signum)
            except ProcessLookupError:
                pass
            if not repeated:
                def force_stop():
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                cancel_timer = threading.Timer(5.0, force_stop)
                cancel_timer.daemon = True
                cancel_timer.start()

        for sig in (signal.SIGINT, signal.SIGTERM):
            old_handlers[sig] = signal.signal(sig, interrupt)
        completed = False
        failed = False
        try:
            try:
                proc.stdin.write(prompt)
                proc.stdin.close()
            except BrokenPipeError:
                pass
            for line in proc.stdout:
                try:
                    event = json.loads(line)
                except ValueError:
                    print(line, end='', file=sys.stderr, flush=True)
                    continue
                if not isinstance(event, dict):
                    continue
                if event.get('type') == 'thread.started':
                    received = event.get('thread_id')
                    if not isinstance(received, str) or not received or received.startswith('-') or (sid and sid != received):
                        raise RuntimeError('Codex returned an unexpected session ID; stopping this request.')
                    sid = received
                    # Persist immediately so interrupted/failed turns can resume the same conversation.
                    state.update(sessionId=sid, task=task, model=model, effort=effort)
                    session.save(state)
                if event.get('type') == 'turn.completed':
                    completed = True
                if event.get('type') == 'turn.failed':
                    failed = True
                render(event)
            code = proc.wait()
            if cancelled:
                return cancelled
            if code or failed or not completed or not sid:
                print('요청 실패: 같은 세션을 유지합니다. 자동 재시도하지 않았습니다. / Request failed; session retained.', file=sys.stderr)
                return code if code > 0 else 1
            state.update(sessionId=sid, task=task, model=model, effort=effort)
            session.save(state)
            return 0
        finally:
            if cancel_timer is not None:
                cancel_timer.cancel()
            if cancelled or proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
                # Also stop descendants left behind by a cancelled group leader.
                if cancelled:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            proc.stdout.close()
            for sig, old in old_handlers.items():
                signal.signal(sig, old)


HELP = '''요청을 입력하세요. / Enter a request.
/model auto|simple|general|complex  모델 선택 / Model selection
/new                               새 대화 / New conversation
/status                            현재 세션 / Current session
/paste                             여러 줄 입력, 단독 . 으로 마침 / Multiline, end with .
/exit                              종료 / Exit
'''


def main(argv=None):
    parser = argparse.ArgumentParser(description='Code Whereabouts: 요청마다 모델을 선택하는 Codex 터미널 / Codex model router')
    parser.add_argument('prompt', nargs='*', help='한 번 실행할 요청. 없으면 대화형 입력 / Request, or interactive if omitted')
    parser.add_argument('-C', '--cd', default='.', help='저장소 폴더 / Repository directory')
    parser.add_argument('--session', default='default', help='저장소 안의 대화 이름 / Conversation name within this worktree')
    parser.add_argument('--mode', choices=MODES, default='auto')
    parser.add_argument('--sandbox', choices=('workspace-write', 'read-only'), default='workspace-write')
    parser.add_argument('--new', action='store_true', help='기존 대화를 보존하고 새 대화 시작 / Start a new conversation')
    parser.add_argument('--status', action='store_true', help='저장된 세션 확인 / Show saved session')
    parser.add_argument('--dry-run', action='store_true', help='모델/명령만 표시, Codex 실행 안 함 / Preview without running Codex')
    args = parser.parse_args(argv)
    base = Path(os.environ.get('CODEWHERE_STATE_DIR', Path.home() / '.local/state/code-whereabouts'))
    session = Session(worktree(args.cd), args.session, base)
    if args.new and args.dry_run:
        parser.error('--new and --dry-run cannot be combined')
    if args.new:
        session.reset()
    if args.status:
        print(json.dumps(session.load(), ensure_ascii=False, indent=2))
        return 0
    binary = os.environ.get('CODEWHERE_CODEX_BIN', 'codex')
    if args.prompt:
        return execute(session, ' '.join(args.prompt), args.mode, args.sandbox, binary, args.dry_run)
    if not sys.stdin.isatty():
        prompt = sys.stdin.read().strip()
        if not prompt:
            parser.error('요청이 비어 있습니다. / Empty request')
        return execute(session, prompt, args.mode, args.sandbox, binary, args.dry_run)
    print(HELP, file=sys.stderr)
    while True:
        try:
            prompt = input('codewhere> ').strip()
            if not prompt:
                continue
            if prompt in ('/exit', '/quit'):
                return 0
            if prompt == '/help':
                print(HELP)
            elif prompt == '/new':
                session.reset()
            elif prompt == '/status':
                print(json.dumps(session.load(), ensure_ascii=False, indent=2))
            elif prompt == '/model' or prompt.startswith('/model '):
                mode = prompt.split(maxsplit=1)[1] if ' ' in prompt else args.mode
                if mode in MODES:
                    args.mode = mode
                    print('model mode:', mode)
                else:
                    print('Choose: ' + ', '.join(MODES), file=sys.stderr)
            else:
                if prompt == '/paste':
                    lines = []
                    while True:
                        line = input('... ')
                        if line == '.':
                            break
                        lines.append(line)
                    prompt = '\n'.join(lines).strip()
                    if not prompt:
                        continue
                elif prompt.startswith('/'):
                    print('알 수 없는 명령입니다. / Unknown command. /help', file=sys.stderr)
                    continue
                execute(session, prompt, args.mode, args.sandbox, binary, args.dry_run)
        except EOFError:
            return 0
        except KeyboardInterrupt:
            print('\n취소했습니다. / Cancelled.', file=sys.stderr)
        except (RuntimeError, OSError) as error:
            print(error, file=sys.stderr)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, OSError) as error:
        print(f'codewhere: {error}', file=sys.stderr)
        sys.exit(1)
