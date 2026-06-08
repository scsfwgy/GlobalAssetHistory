"""Standalone Flask app for Price Change feature."""
import json
import logging
import os
import threading
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

from routes.price_change import price_change_bp
from routes.wishes import wishes_bp
from service.price_change import cache_store, diagnostics

app = Flask(__name__, static_folder=None)
CORS(app)
logging.basicConfig(level=logging.INFO)

app.register_blueprint(price_change_bp)
app.register_blueprint(wishes_bp)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

# Visit counter.
# Preferred: shared Redis INCR (atomic, cross-instance, survives cold starts).
# Fallback (no Redis configured, e.g. local dev): a local JSON file. Note the
# file fallback is per-instance and reset on serverless cold start — it is only
# reliable on a persistent single-process server.
_VISIT_KEY = "visit_count"
_COUNTER_PATH = Path("/tmp/visit_count.json") if os.path.exists("/tmp") else \
    Path(__file__).resolve().parent / "config" / "visit_count.json"
_counter_lock = threading.Lock()


def _read_counter() -> int:
    try:
        if _COUNTER_PATH.exists():
            return json.loads(_COUNTER_PATH.read_text()).get("count", 0)
    except Exception:
        pass
    return 0


def _write_counter(count: int) -> None:
    _COUNTER_PATH.parent.mkdir(parents=True, exist_ok=True)
    _COUNTER_PATH.write_text(json.dumps({"count": count}))


@app.route("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/api/diag")
def diag():
    """Live reachability of upstream data sources + Redis. Read-only; results
    are memoised for ~20s. Pass ?fresh=1 to force a fresh probe."""
    fresh = request.args.get("fresh") in ("1", "true", "yes")
    return jsonify(diagnostics.run_diagnostics(fresh=fresh))


@app.route("/api/visits")
def visits():
    # Shared Redis path — atomic, correct across instances.
    if cache_store.is_enabled():
        count = cache_store.cache_incr(_VISIT_KEY)
        if count is not None:
            return jsonify({"count": count})
        # Redis transiently unavailable — fall through to the file counter.
    with _counter_lock:
        count = _read_counter() + 1
        _write_counter(count)
    return jsonify({"count": count})


@app.route("/")
def index():
    return send_from_directory(str(FRONTEND_DIR), "price-change.html")


@app.route("/<path:filename>")
def frontend_files(filename):
    return send_from_directory(str(FRONTEND_DIR), filename)


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8730"))
    app.run(host=host, port=port, debug=True)
