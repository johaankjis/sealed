"""Guest-only entry point. Never run generated analysis on the application host.

Python restrictions here are conveniences, not a security boundary. CreateOS and
the server's output policy provide the isolation and release decisions.
"""
import contextlib
import io
import json
import os
import sys


class BoundedOutput(io.StringIO):
    def __init__(self):
        super().__init__()
        self.bytes_written = 0

    def write(self, text):
        self.bytes_written += len(text.encode("utf-8"))
        if self.bytes_written > 1_000_000:
            raise ValueError("result too large")
        return super().write(text)


def run():
    import duckdb

    output = BoundedOutput()
    # Capture the agent's single JSON line, never relay diagnostics.
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(output), contextlib.redirect_stderr(sink):
        connection = duckdb.connect(":memory:")
        try:
            with open("/tmp/sealed-dataset.json", encoding="utf-8") as metadata:
                settings = json.load(metadata)
            table = '"' + settings["tableName"].replace('"', '""') + '"'
            readers = {"csv": "read_csv_auto", "parquet": "read_parquet"}
            reader = readers[settings["format"]]
            connection.execute(f"CREATE TABLE {table} AS SELECT * FROM {reader}('/tmp/sealed-dataset')")
            connection.execute("SET enable_external_access = false")
            namespace = {"con": connection, "__name__": "__sealed_analysis__"}
            with open("/tmp/sealed-analysis.py", encoding="utf-8") as source:
                exec(compile(source.read(), "analysis.py", "exec"), namespace)
            printed = output.getvalue().strip()
            if printed:
                if len(printed.splitlines()) != 1:
                    raise ValueError("expected one JSON line")
                result = json.loads(printed)
            else:
                # Compatibility with the original sandbox's assignment interface.
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
