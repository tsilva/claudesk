import subprocess
import sys
from pathlib import Path


def _root() -> Path:
    # In editable mode, __file__ is the actual source file, so parent.parent = project root
    return Path(__file__).resolve().parent.parent


def main():
    """Start the claudesk server. Pass --dev for file-watching dev mode."""
    dev = "--dev" in sys.argv
    root = _root()
    cmd = ["bun", "run"]
    if dev:
        cmd.append("--watch")
    cmd.append(str(root / "src" / "server.ts"))
    try:
        subprocess.run(cmd, cwd=root)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
