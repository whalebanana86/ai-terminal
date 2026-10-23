"""End-to-end CLI checks using a fake Codex process; no model requests."""
import importlib.util
import json
import os
import pty
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('codewhere', SCRIPTS / 'codewhere.py')
router = importlib.util.module_from_spec(spec)
spec.loader.exec_module(router)

FAKE = r'''#!/usr/bin/env python3
import json,os,sys,time,signal
from pathlib import Path
args=sys.argv[1:]
prompt=sys.stdin.read()
log=Path(os.environ['FAKE_LOG'])
previous=log.read_text().splitlines() if log.exists() else []
sid=args[-2] if 'resume' in args else 'session-'+str(len(previous)+1)
with log.open('a') as out:
 out.write(json.dumps({'argv':args,'prompt':prompt,'cwd':os.getcwd(),'sid':sid})+'\n')
print(json.dumps({'type':'thread.started','thread_id':sid}),flush=True)
if os.environ.get('FAKE_SLEEP'):
 if os.environ.get('FAKE_IGNORE_INTERRUPT'):
  signal.signal(signal.SIGINT, signal.SIG_IGN)
 time.sleep(30)
if os.environ.get('FAKE_FAIL'):
 print(json.dumps({'type':'turn.failed','error':{'message':'Model unavailable'}}),flush=True)
 sys.exit(7)
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'answer:'+prompt}}),flush=True)
print(json.dumps({'type':'item.completed','item':{'type':'command_execution','command':'git status','aggregated_output':'clean\n','exit_code':0}}),flush=True)
print(json.dumps({'type':'item.completed','item':{'type':'file_change','changes':[{'path':'file.txt','kind':'update'}]}}),flush=True)
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1}}),flush=True)
'''


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / 'repo with spaces'
        self.repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        self.fake = self.base / 'fake codex'
        self.fake.write_text(FAKE)
        self.fake.chmod(0o755)
        self.state = self.base / 'state'
        self.log = self.base / 'calls.jsonl'
        self.env = dict(os.environ, CODEWHERE_STATE_DIR=str(self.state),
                        CODEWHERE_CODEX_BIN=str(self.fake), FAKE_LOG=str(self.log))

    def call(self, *args, cwd=None, env=None, expected=0, input=None):
        result = subprocess.run([sys.executable, str(SCRIPTS / 'codewhere.py'), *args],
                                cwd=cwd or self.repo, env=env or self.env, input=input,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, expected, result.stderr)
        return result

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_routes_resume_and_continuations(self):
        for prompt in ['git pull', '로그인 기능 구현', '동시성 버그 수정', '네, 이어서 작업해']:
            self.call(prompt)
        calls = self.calls()
        self.assertEqual([c['argv'][c['argv'].index('--model') + 1] for c in calls],
                         ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6.1-sol'])
        self.assertEqual([next(x for x in c['argv'] if x.startswith('model_reasoning_effort')) for c in calls],
                         ['model_reasoning_effort="low"', 'model_reasoning_effort="low"',
                          'model_reasoning_effort="medium"', 'model_reasoning_effort="medium"'])
        self.assertEqual(len({c['sid'] for c in calls}), 1)
        self.assertNotIn('resume', calls[0]['argv'])
        self.assertTrue(all('resume' in c['argv'] for c in calls[1:]))
        self.assertTrue(all('--last' not in c['argv'] for c in calls))
        saved = json.loads(next(self.state.glob('*.json')).read_text())
        self.assertEqual(saved['task'], 'complex')
        self.assertNotIn('prompt', saved)
        self.assertEqual(next(self.state.glob('*.json')).stat().st_mode & 0o777, 0o600)

    def test_repository_name_worktree_and_subfolder_isolation(self):
        self.call('first')
        sub = self.repo / 'nested'
        sub.mkdir()
        self.call('second', cwd=sub)
        self.call('--session', 'other', 'third')
        other = self.base / 'other-repo'
        subprocess.run(['git', 'init', '-q', str(other)], check=True)
        self.call('fourth', cwd=other)
        subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=test', '-c', 'user.email=test@example.com',
                        'commit', '-q', '--allow-empty', '-m', 'init'], check=True)
        linked = self.base / 'linked'
        subprocess.run(['git', '-C', str(self.repo), 'worktree', 'add', '-q', '-b', 'test-linked', str(linked)], check=True)
        self.call('fifth', cwd=linked)
        calls = self.calls()
        self.assertEqual(calls[0]['sid'], calls[1]['sid'])
        self.assertEqual(len({c['sid'] for c in calls}), 4)
        self.assertEqual(len(list(self.state.glob('*.json'))), 4)

    def test_prompt_is_stdin_not_shell_and_modes_are_explicit(self):
        prompt = '-x $(touch SHOULD_NOT_EXIST) `echo nope`\n한글 요청'
        self.call('--mode', 'simple', '--sandbox', 'read-only', '--', prompt)
        invocation = self.calls()[0]
        self.assertEqual(invocation['prompt'], prompt)
        self.assertNotIn(prompt, invocation['argv'])
        self.assertIn('sandbox_mode="read-only"', invocation['argv'])
        self.assertNotIn('--dangerously-bypass-approvals-and-sandbox', invocation['argv'])
        self.assertFalse((self.repo / 'SHOULD_NOT_EXIST').exists())

    def test_failure_keeps_session_without_retry_or_downgrade(self):
        self.call('동시성 버그', env=dict(self.env, FAKE_FAIL='1'), expected=7)
        self.assertEqual(len(self.calls()), 1)
        self.call('계속해')
        self.assertEqual(self.calls()[0]['sid'], self.calls()[1]['sid'])
        self.assertIn('resume', self.calls()[1]['argv'])
        self.assertIn('model_reasoning_effort="medium"', self.calls()[1]['argv'])

    def test_preview_reset_status_and_piped_input(self):
        preview = self.call('--dry-run', '동시성 버그')
        self.assertEqual(json.loads(preview.stdout)['task'], 'complex')
        self.assertFalse(self.log.exists())
        self.call(input='git pull\n')
        sid = self.calls()[0]['sid']
        status = json.loads(self.call('--status').stdout)
        self.assertEqual(status['sessionId'], sid)
        self.call('--new', '구현해')
        self.assertNotEqual(self.calls()[1]['sid'], sid)
        self.assertNotIn('resume', self.calls()[1]['argv'])

    def test_busy_lock_and_cancellation(self):
        command = [sys.executable, str(SCRIPTS / 'codewhere.py'), '동시성 버그']
        proc = subprocess.Popen(command, cwd=self.repo, env=dict(self.env, FAKE_SLEEP='1'),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 5
            while not list(self.state.glob('*.json')) and time.monotonic() < deadline:
                time.sleep(0.02)
            busy = self.call('other', expected=1)
            self.assertIn('Session is busy', busy.stderr)
            proc.send_signal(signal.SIGINT)
            proc.communicate(timeout=7)
            self.assertEqual(proc.returncode, 130)
            self.call('continue')
            self.assertIn('resume', self.calls()[-1]['argv'])
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate()

    def test_cancellation_escalates_if_codex_ignores_interrupt(self):
        proc = subprocess.Popen([sys.executable, str(SCRIPTS / 'codewhere.py'), 'hello'],
                                cwd=self.repo, env=dict(self.env, FAKE_SLEEP='1', FAKE_IGNORE_INTERRUPT='1'),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 5
            while not list(self.state.glob('*.json')) and time.monotonic() < deadline:
                time.sleep(0.02)
            # Let the fake install its SIGINT handler after emitting thread.started.
            time.sleep(0.1)
            proc.send_signal(signal.SIGINT)
            proc.communicate(timeout=8)
            self.assertEqual(proc.returncode, 130)
            self.call('continue')
            self.assertIn('resume', self.calls()[-1]['argv'])
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate()

    def test_invalid_state_does_not_silently_start_another_conversation(self):
        self.call('hello')
        next(self.state.glob('*.json')).write_text('{broken')
        self.call('continue', expected=1)
        self.assertEqual(len(self.calls()), 1)

    def test_output_and_non_git_error(self):
        out = self.call('hello')
        self.assertIn('answer:hello', out.stdout)
        self.assertIn('clean', out.stderr)
        self.assertIn('[update] file.txt', out.stderr)
        self.call('hello', cwd=self.base, expected=1)
        self.assertEqual(len(self.calls()), 1)

    def test_standalone_install_and_reinstall(self):
        bin_dir, data_dir = self.base / 'bin', self.base / 'installed'
        command = [sys.executable, str(SCRIPTS / 'install_cli.py'), '--bin-dir', str(bin_dir), '--data-dir', str(data_dir)]
        for _ in range(2):
            subprocess.run(command, check=True, capture_output=True)
        result = subprocess.run([str(bin_dir / 'codewhere'), '--dry-run', 'git pull'],
                                cwd=self.repo, env=self.env, text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout)['model'], 'gpt-6-luna')
        (bin_dir / 'codewhere').unlink()
        (bin_dir / 'codewhere').write_text('unrelated command')
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.assertEqual((bin_dir / 'codewhere').read_text(), 'unrelated command')

    def test_interactive_models_multiline_and_new_conversation(self):
        master, slave = pty.openpty()
        proc = subprocess.Popen([sys.executable, str(SCRIPTS / 'codewhere.py')], cwd=self.repo,
                                env=self.env, stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        os.close(slave)
        try:
            os.write(master, b'/model complex\nhello\n/status\n/new\n/model auto\n/paste\ngit pull\n.\n/exit\n')
            stdout, stderr = proc.communicate(timeout=10)
            self.assertEqual(proc.returncode, 0, stderr)
            calls = self.calls()
            self.assertEqual(len(calls), 2)
            self.assertIn('model_reasoning_effort="medium"', calls[0]['argv'])
            self.assertIn('gpt-6-luna', calls[1]['argv'])
            self.assertNotEqual(calls[0]['sid'], calls[1]['sid'])
            self.assertIn('answer:hello', stdout)
            self.assertIn('answer:git pull', stdout)
        finally:
            os.close(master)
            if proc.poll() is None:
                proc.kill()
                proc.communicate()

    def test_policy_fixtures(self):
        for prompt, previous, expected in [
            ('git pull', None, 'simple'), ('커밋하고 메인머지 푸시해', None, 'simple'),
            ('Fix git pull errors', None, 'general'), ('기능 추가', None, 'general'),
            ('renderer race condition', None, 'complex'), ('어 구현해', 'complex', 'complex'),
            ('네, 이어서 작업해', 'complex', 'complex'), ('continue', 'simple', 'simple'),
            ('알 수 없는 요청', None, 'general'), ('x' * 1601, None, 'complex')]:
            with self.subTest(prompt=prompt):
                self.assertEqual(router.classify(prompt, previous=previous), expected)


if __name__ == '__main__':
    unittest.main()
