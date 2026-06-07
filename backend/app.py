"""Standalone Flask app for Price Change feature."""
import logging
import os
from pathlib import Path

from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS

from routes.price_change import price_change_bp

app = Flask(__name__, static_folder=None)
CORS(app)
logging.basicConfig(level=logging.INFO)

app.register_blueprint(price_change_bp)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


@app.route("/api/health")
def health():
    return jsonify({"status": "ok"})


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
