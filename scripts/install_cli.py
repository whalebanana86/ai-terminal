#!/usr/bin/env python3
"""Install the Code Whereabouts CLI without touching shell/Codex configuration."""
import argparse
import os
from pathlib import Path
import shutil
import tempfile


def install(bin_dir, data_dir):
    source = Path(__file__).resolve().parent
    bin_dir, data_dir = bin_dir.expanduser().resolve(), data_dir.expanduser().resolve()
    command = bin_dir / 'codewhere'
    target = data_dir / 'codewhere.py'
    if os.path.lexists(command) and not (command.is_symlink() and command.resolve() == target):
        raise RuntimeError(f'Refusing to replace an existing unrelated command: {command}')
    data_dir.mkdir(parents=True, exist_ok=True)
    bin_dir.mkdir(parents=True, exist_ok=True)
    for name in ('codex-routing.json', 'codewhere.py'):
        fd, temporary = tempfile.mkstemp(dir=data_dir)
        os.close(fd)
        try:
            shutil.copyfile(source / name, temporary)
            os.chmod(temporary, 0o755 if name.endswith('.py') else 0o644)
            os.replace(temporary, data_dir / name)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    if not command.is_symlink():
        command.symlink_to(target)
    print(f'Installed: {command}')
    if str(bin_dir) not in os.environ.get('PATH', '').split(os.pathsep):
        print(f'Add this directory to PATH: {bin_dir}')
    print('Run codewhere in any Git repository. Existing Codex and shell settings are unchanged.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin-dir', type=Path, default=Path.home() / '.local/bin')
    parser.add_argument('--data-dir', type=Path, default=Path.home() / '.local/share/code-whereabouts/cli')
    args = parser.parse_args()
    install(args.bin_dir, args.data_dir)
