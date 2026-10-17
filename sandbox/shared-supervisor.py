"""Remote-only bounded supervisor for cooperative synthetic demo analyses.

Process groups do not contain hostile code that deliberately escapes its group.
This shared-VM mode is NOT suitable for private datasets or hostile tenants.
"""
import os
import resource
import signal
import subprocess
import sys
import tempfile

with tempfile.TemporaryFile() as output:
    # Bound file output in the child, including direct writes bypassing the runner.
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (1_000_001, 1_000_001))

    child = subprocess.Popen([sys.executable, "-I", sys.argv[1] + "/sealed-runner.py"],
                             stdout=output, stderr=subprocess.DEVNULL, start_new_session=True,
                             preexec_fn=limits)
    status = 1
    try:
        status = 0 if child.wait(timeout=float(sys.argv[2])) == 0 else 1
    except subprocess.TimeoutExpired:
        status = 124
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
    output.seek(0)
    result = output.read(1_000_001)
    if len(result) > 1_000_000:
        status = 1
    if status == 0:
        sys.stdout.buffer.write(result)
    sys.exit(status)
