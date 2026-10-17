"""Run ONLY in a dedicated CreateOS test sandbox, never on the application host.

The script does not change firewall rules. Run baseline, restrict the VM's egress
with the control plane, then run restricted. No customer data is used.
"""
import argparse
import json
from pathlib import Path
import socket
import sys


def tcp(host):
    with socket.create_connection((host, 443), timeout=3):
        return True


def dns():
    # A fixed, synthetic example.com A question sent directly to a public resolver.
    query = bytes.fromhex("534501000001000000000000076578616d706c6503636f6d0000010001")
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(3)
        sock.connect(("1.1.1.1", 53))
        sock.send(query)
        reply = sock.recv(512)
    return len(reply) >= 12 and reply[:2] == query[:2] and bool(reply[2] & 128)


def probe():
    targets = {
        "hostname_https": lambda: tcp("pypi.org"),
        "ipv4_https": lambda: tcp("1.1.1.1"),
        "ipv6_https": lambda: tcp("2606:4700:4700::1111"),
        "direct_udp_dns": dns,
    }
    results = {}
    for name, test in targets.items():
        try:
            results[name] = {"reachable": bool(test())}
        except OSError as error:
            results[name] = {"reachable": False, "error": type(error).__name__}
    return results


def assess(baseline, restricted):
    # Failure alone is not evidence of enforcement: require working positive controls.
    controls = all(baseline.get(key, {}).get("reachable") is True
                   for key in ("hostname_https", "ipv4_https"))
    blocked = all(value.get("reachable") is False for value in restricted.values())
    same_targets = set(baseline) == set(restricted) == {
        "hostname_https", "ipv4_https", "ipv6_https", "direct_udp_dns"}
    return controls and blocked and same_targets


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["baseline", "restricted"])
    parser.add_argument("--baseline", default="/tmp/sealed-egress-baseline.json")
    args = parser.parse_args()
    import duckdb

    assert duckdb.__version__ == "1.5.4"
    assert duckdb.sql("SELECT 42").fetchone() == (42,)
    current = probe()
    report = {"mode": args.mode, "duckdb": duckdb.__version__, "probes": current}
    if args.mode == "baseline":
        Path(args.baseline).write_text(json.dumps(current), encoding="utf-8")
        passed = all(current[key]["reachable"] for key in ("hostname_https", "ipv4_https"))
    else:
        baseline = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
        passed = assess(baseline, current)
        report["baseline"] = baseline
    report["passed"] = passed
    print(json.dumps(report, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
