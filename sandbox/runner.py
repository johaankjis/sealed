"""Guest-only entry point. Never run generated analysis on the application host.

Python restrictions here are conveniences, not a security boundary. CreateOS and
the server's output policy provide the isolation and release decisions.
"""
import contextlib
import json
import os
import sys


def run():
    import duckdb

    # Discard incidental output; only the structured candidate leaves this runner.
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        connection = duckdb.connect(":memory:")
        try:
            connection.execute("CREATE TABLE dataset AS SELECT * FROM read_csv_auto('/tmp/sealed-dataset.csv')")
            connection.execute("SET enable_external_access = false")
            namespace = {"con": connection, "__name__": "__sealed_analysis__"}
            with open("/tmp/sealed-analysis.py", encoding="utf-8") as source:
                exec(compile(source.read(), "analysis.py", "exec"), namespace)
            result = namespace["result"]
            encoded = json.dumps(result, allow_nan=False, separators=(",", ":"))
            if len(encoded.encode("utf-8")) > 1_000_000:
                raise ValueError("result too large")
        finally:
            connection.close()
    sys.stdout.write(encoded)


if __name__ == "__main__":
    try:
        run()
    except BaseException:
        # No tracebacks or data-bearing exception messages leave the VM.
        sys.exit(1)
