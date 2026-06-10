/** Wish wall: anonymous submissions with SVG CAPTCHA + admin delete. */

let _wishCaptchaId = null;
let _wishLoaded = false;
const WISH_ADMIN_KEY = "wishAdminToken";

function _wishEl(id) { return document.getElementById(id); }

function _getAdminToken() {
    return sessionStorage.getItem(WISH_ADMIN_KEY) || "";
}

function _showWishMsg(text, isError) {
    const el = _wishEl("wishMsg");
    el.textContent = text;
    el.className = "wish-msg " + (isError ? "is-error" : "is-ok");
    el.style.display = "block";
}

function _clearWishMsg() {
    _wishEl("wishMsg").style.display = "none";
}

// SVG comes from our own backend; injecting it as markup is safe and required
// to render the image. User-supplied content is never injected this way.
function loadCaptcha() {
    const box = _wishEl("wishCaptchaBox");
    box.textContent = "...";
    fetch(WISH_CAPTCHA_ENDPOINT)
        .then(r => r.json())
        .then(d => {
            _wishCaptchaId = d.captcha_id;
            box.innerHTML = d.svg;
        })
        .catch(() => { box.textContent = "加载失败"; });
}

function _formatWishTime(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function _renderWishCard(wish) {
    const card = document.createElement("div");
    card.className = "wish-card";

    const textEl = document.createElement("div");
    textEl.className = "wish-card-text";
    textEl.textContent = wish.text || "";  // textContent => XSS-safe
    card.appendChild(textEl);

    const meta = document.createElement("div");
    meta.className = "wish-card-meta";

    const nickEl = document.createElement("span");
    nickEl.className = "wish-card-nick";
    nickEl.textContent = wish.nick || "匿名";  // textContent => XSS-safe
    meta.appendChild(nickEl);

    const right = document.createElement("span");
    const timeEl = document.createElement("span");
    timeEl.textContent = _formatWishTime(wish.ts);
    right.appendChild(timeEl);

    if (_getAdminToken()) {
        const del = document.createElement("span");
        del.className = "wish-card-del";
        del.textContent = "  删除";
        del.addEventListener("click", () => deleteWish(wish.id));
        right.appendChild(del);
    }
    meta.appendChild(right);

    card.appendChild(meta);

    if (wish.reply) {
        const replyEl = document.createElement("div");
        replyEl.className = "wish-card-reply";

        const label = document.createElement("span");
        label.className = "wish-card-reply-label";
        label.textContent = "管理员回复：";
        replyEl.appendChild(label);

        const text = document.createElement("span");
        text.className = "wish-card-reply-text";
        text.textContent = wish.reply;
        replyEl.appendChild(text);

        if (wish.reply_ts) {
            const time = document.createElement("span");
            time.className = "wish-card-reply-time";
            time.textContent = " · " + _formatWishTime(wish.reply_ts);
            replyEl.appendChild(time);
        }
        card.appendChild(replyEl);
    }

    if (_getAdminToken()) {
        const form = document.createElement("div");
        form.className = "wish-reply-form";

        const input = document.createElement("input");
        input.type = "text";
        input.className = "wish-reply-input";
        input.maxLength = 200;
        input.placeholder = "管理员回复...";
        input.value = wish.reply || "";
        form.appendChild(input);

        const btn = document.createElement("button");
        btn.className = "pc-btn";
        btn.style.cssText = "padding:4px 12px;font-size:12px;";
        btn.textContent = wish.reply ? "更新回复" : "回复";
        btn.addEventListener("click", () => replyWish(wish.id, input.value, btn));
        form.appendChild(btn);

        card.appendChild(form);
    }

    return card;
}

function loadWishes() {
    _wishEl("wishLoading").style.display = "flex";
    _wishEl("wishEmpty").style.display = "none";
    fetch(WISHES_ENDPOINT)
        .then(r => r.json())
        .then(d => {
            _wishEl("wishLoading").style.display = "none";
            const list = _wishEl("wishList");
            list.innerHTML = "";
            const wishes = (d && d.wishes) || [];
            if (!wishes.length) {
                _wishEl("wishEmpty").style.display = "block";
                return;
            }
            wishes.forEach(w => list.appendChild(_renderWishCard(w)));
        })
        .catch(() => {
            _wishEl("wishLoading").style.display = "none";
            _showWishMsg("加载心愿失败，请稍后重试", true);
        });
}

function submitWish() {
    _clearWishMsg();
    const text = _wishEl("wishText").value.trim();
    const nick = _wishEl("wishNick").value.trim();
    const answer = _wishEl("wishCaptchaInput").value.trim();
    if (!text) { _showWishMsg("心愿内容不能为空", true); return; }
    if (!answer) { _showWishMsg("请填写验证码", true); return; }

    const btn = _wishEl("wishSubmitBtn");
    btn.disabled = true;
    fetch(WISHES_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            text: text,
            nick: nick,
            captcha_id: _wishCaptchaId,
            captcha_answer: answer,
        }),
    })
        .then(async r => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || "提交失败");
            return data;
        })
        .then(() => {
            _wishEl("wishText").value = "";
            _wishEl("wishCaptchaInput").value = "";
            _showWishMsg("提交成功，感谢你的心愿 ✨", false);
            loadCaptcha();
            loadWishes();
        })
        .catch(err => {
            _showWishMsg(err.message || "提交失败", true);
            loadCaptcha();  // captcha is one-time; always refresh after a try
        })
        .finally(() => { btn.disabled = false; });
}

function replyWish(wishId, text, btn) {
    const reply = (text || "").trim();
    if (!reply) { _showWishMsg("回复内容不能为空", true); return; }
    if (btn) btn.disabled = true;
    fetch(`${WISHES_ENDPOINT}/${encodeURIComponent(wishId)}/reply`, {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json",
            "X-Admin-Token": _getAdminToken(),
        },
        body: JSON.stringify({ reply }),
    })
        .then(async r => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || "回复失败");
            return data;
        })
        .then(() => {
            _showWishMsg("回复成功", false);
            loadWishes();
        })
        .catch(err => _showWishMsg(err.message || "回复失败", true))
        .finally(() => { if (btn) btn.disabled = false; });
}

function deleteWish(wishId) {
    fetch(`${WISHES_ENDPOINT}/${encodeURIComponent(wishId)}`, {
        method: "DELETE",
        headers: { "X-Admin-Token": _getAdminToken() },
    })
        .then(async r => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || "删除失败");
            return data;
        })
        .then(() => loadWishes())
        .catch(err => _showWishMsg(err.message || "删除失败", true));
}

function _initWishAdmin() {
    const toggle = _wishEl("wishAdminToggle");
    const row = _wishEl("wishAdminRow");
    const input = _wishEl("wishAdminToken");
    const hint = _wishEl("wishAdminHint");

    const refreshHint = () => {
        hint.textContent = _getAdminToken() ? "已启用删除/回复" : "";
    };
    input.value = _getAdminToken();
    refreshHint();

    toggle.addEventListener("click", () => {
        row.style.display = row.style.display === "none" ? "flex" : "none";
    });
    _wishEl("wishAdminSave").addEventListener("click", () => {
        const val = input.value.trim();
        if (!val) {
            sessionStorage.removeItem(WISH_ADMIN_KEY);
            refreshHint();
            loadWishes();
            return;
        }
        // Validate against the server before enabling delete, so a wrong token
        // gives immediate feedback instead of silently "saving".
        const saveBtn = _wishEl("wishAdminSave");
        saveBtn.disabled = true;
        hint.textContent = "校验中...";
        fetch(WISH_VERIFY_ADMIN_ENDPOINT, {
            method: "POST",
            headers: { "X-Admin-Token": val },
        })
            .then(r => {
                if (!r.ok) throw new Error("Token 无效");
                sessionStorage.setItem(WISH_ADMIN_KEY, val);
                hint.textContent = "已启用删除/回复";
                loadWishes();  // re-render to show admin actions
            })
            .catch(() => {
                sessionStorage.removeItem(WISH_ADMIN_KEY);
                input.value = "";
                hint.textContent = "Token 无效";
                loadWishes();
            })
            .finally(() => { saveBtn.disabled = false; });
    });
}

document.addEventListener("DOMContentLoaded", () => {
    _wishEl("wishSubmitBtn").addEventListener("click", submitWish);
    _wishEl("wishCaptchaBox").addEventListener("click", loadCaptcha);
    _initWishAdmin();

    // Lazy-load on first switch to the 心愿墙 tab.
    document.querySelectorAll('.tab-btn[data-tab="wishes"]').forEach(btn => {
        btn.addEventListener("click", () => {
            if (_wishLoaded) return;
            _wishLoaded = true;
            loadCaptcha();
            loadWishes();
        });
    });
});

