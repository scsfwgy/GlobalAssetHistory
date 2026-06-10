"""
Wish wall API blueprint — anonymous wishes with CAPTCHA + rate limiting.
"""
import logging

from flask import Blueprint, jsonify, request

from service.wishes import captcha
from service.wishes.wishes_service import (
    add_wish,
    check_rate_limit,
    delete_wish,
    list_wishes,
    reply_wish,
    verify_admin_token,
)

logger = logging.getLogger(__name__)

wishes_bp = Blueprint("wishes", __name__, url_prefix="/api/wishes")


def _client_ip() -> str:
    """Best-effort client IP. On Vercel the real IP is the first entry of
    X-Forwarded-For; remote_addr is the internal proxy."""
    fwd = request.headers.get("X-Forwarded-For", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.remote_addr or "unknown"


@wishes_bp.route("", methods=["GET"])
def get_wishes():
    """Return all wishes, newest first."""
    try:
        return jsonify({"wishes": list_wishes()})
    except Exception as e:
        logger.exception("Failed to list wishes: %s", e)
        return jsonify({"error": str(e)}), 500


@wishes_bp.route("/captcha", methods=["GET"])
def get_captcha():
    """Issue a new SVG CAPTCHA."""
    try:
        captcha_id, svg = captcha.generate()
        return jsonify({"captcha_id": captcha_id, "svg": svg})
    except Exception as e:
        logger.exception("Failed to generate captcha: %s", e)
        return jsonify({"error": str(e)}), 500


@wishes_bp.route("/verify-admin", methods=["POST"])
def verify_admin():
    """Check whether the supplied admin token is valid, so the frontend can
    give immediate feedback before enabling delete. Header: X-Admin-Token."""
    token = request.headers.get("X-Admin-Token", "")
    if verify_admin_token(token):
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "Token 无效"}), 403


@wishes_bp.route("", methods=["POST"])
def post_wish():
    """Submit a wish. Requires a valid one-time CAPTCHA and is rate-limited
    per IP. Body: {text, nick, captcha_id, captcha_answer}."""
    body = request.get_json(silent=True) or {}
    captcha_id = body.get("captcha_id", "")
    captcha_answer = body.get("captcha_answer", "")

    if not captcha.verify(captcha_id, captcha_answer):
        return jsonify({"error": "验证码错误或已过期"}), 400

    if not check_rate_limit(_client_ip()):
        return jsonify({"error": "提交过于频繁，请稍后再试"}), 429

    try:
        wish = add_wish(body.get("text", ""), body.get("nick"), _client_ip())
        return jsonify(wish), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("Failed to add wish: %s", e)
        return jsonify({"error": str(e)}), 500


@wishes_bp.route("/<wish_id>/reply", methods=["PATCH"])
def reply_to_wish(wish_id):
    """Admin-only reply/update. Requires header X-Admin-Token."""
    token = request.headers.get("X-Admin-Token", "")
    body = request.get_json(silent=True) or {}
    try:
        wish = reply_wish(wish_id, body.get("reply", ""), token)
    except PermissionError as e:
        return jsonify({"error": str(e)}), 403
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("Failed to reply to wish: %s", e)
        return jsonify({"error": str(e)}), 500
    if not wish:
        return jsonify({"error": "未找到该心愿"}), 404
    return jsonify(wish)


@wishes_bp.route("/<wish_id>", methods=["DELETE"])
def remove_wish(wish_id):
    """Admin-only delete. Requires header X-Admin-Token."""
    token = request.headers.get("X-Admin-Token", "")
    try:
        removed = delete_wish(wish_id, token)
    except PermissionError as e:
        return jsonify({"error": str(e)}), 403
    except Exception as e:
        logger.exception("Failed to delete wish: %s", e)
        return jsonify({"error": str(e)}), 500
    if not removed:
        return jsonify({"error": "未找到该心愿"}), 404
    return jsonify({"ok": True})
