"""Vercel serverless entry point — wraps the existing Flask app."""

import sys
from pathlib import Path

# Make 'backend/' importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app import app  # noqa: E402, F401
# Vercel's Python runtime looks for a top-level 'app' variable (Flask instance)
