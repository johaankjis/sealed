"""Trusted remote preflight; no dataset or generated code is uploaded yet."""
import socket
import sys
# Verified preinstalled location on sealed-runtime; -I excludes user site paths.
sys.path.append("/root/.local/lib/python3.13/site-packages")
import duckdb
assert duckdb.__version__ == "1.5.4"
for host in ("1.1.1.1", "pypi.org", "2606:4700:4700::1111"):
    try:
        connection = socket.create_connection((host, 443), timeout=2)
    except OSError:
        continue
    connection.close()
    raise SystemExit(1)
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
    sock.settimeout(2)
    try:
        sock.sendto(bytes.fromhex("123401000001000000000000076578616d706c6503636f6d0000010001"), ("1.1.1.1", 53))
        sock.recvfrom(512)
    except OSError:
        pass
    else:
        raise SystemExit(1)
print("BLOCKED")
