import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


HOST = os.environ.get("MM_AI_HOST", "127.0.0.1")
PORT = int(os.environ.get("MM_AI_PORT", "4050"))
MODEL = os.environ.get("MM_AI_MODEL", "meta/llama-4-maverick-17b-128e-instruct")
ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions"
SITE_NAME = "MatrixMarket"

SITE_CONTEXT = """
MatrixMarket is a live marketplace website focused on buyers, sellers, and admins.

Core storefront pages:
- index.html: the main home page with live seller products, smart filters, compare, wishlist, share filters, export CSV, sync tools, cart access, and featured products.
- shop.html: the broader shopping catalog.
- auto-parts.html: a category-focused marketplace page that automatically surfaces products matching auto-parts keywords such as car parts, brake, engine, tire, gearbox, radiator, and related terms.
- cart.html: customer cart management.
- checkout.html: final checkout, stock revalidation, totals, shipping, buyer information, purchase creation, and seller order queue updates.
- buyers-orders.html: order tracking, order history, support/complaint actions, and seller contact entry points.
- chat.html: buyer chat with sellers or support.
- settings.html: account management, wallet/top-up, session/account updates, and account deletion.

Seller pages and rules:
- seller-register.html and seller-login.html manage seller onboarding and sign-in.
- seller-dashboard.html shows seller metrics, status, queue overview, and shortcuts.
- seller-products.html lets sellers add, edit, restock, hide/show, delete, and export products.
- seller-orders.html is for seller order handling.
- seller-chat.html supports seller conversations with buyers.
- seller-withdrawal.html covers seller withdrawal actions.
- Sellers need an active approved subscription and payment status before posting products.
- Suspended sellers cannot post until restored.

Admin pages:
- admin-sellers.html, admin-products.html, admin-orders.html, admin-users.html, admin-communications.html, admin-logs.html, and related admin pages manage marketplace oversight.

Operational details:
- Delivery coverage shown on the main site includes Senegal and The Gambia.
- The site uses live sync concepts for products and inventory refresh.
- Cart and checkout data use browser storage keys such as cart, cartItems, checkoutCart, and checkoutMeta.
- Purchases are stored under purchases and seller order queues are stored under sellerOrderQueues.
- Support tickets are stored under supportTickets and admin notices under adminNotifications.
- Sellers are stored under sellers and current sessions often use currentUser or loggedInUser.
- Buyers can open support chat by going to chat.html?seller=Support.
- Checkout updates purchase history and seller order queues after successful orders.
- Seller wallet or subscription funds should not be used by seller accounts to buy products; the website blocks that path during checkout.
- Existing support copy in the site says seller subscription payments go to Wave or Comcash account number 6785316 and then require admin approval before activation.

How you should behave:
- You are the official MatrixMarket AI agent.
- Answer as a website assistant that knows the actual page flow and policies above.
- Be direct, practical, and trustworthy.
- If the user asks how to do something, name the correct page and explain the path step by step.
- If the answer depends on live account data you do not have, say what the user should open or check next.
- Do not invent backend states, payment outcomes, or admin decisions.
- Do not claim you changed the site or accessed browser storage unless that context was supplied in the request.
- Offer human support escalation when the issue sounds account-specific, payment-specific, or blocked.
""".strip()

AUTO_PARTS_CONTEXT = """
Auto Parts specialist mode:
- You are the dedicated MatrixMarket Auto Parts AI for auto-parts.html and auto-parts-agent.html.
- Stay focused on the auto parts page, vehicle parts, car systems, common vehicle types, and buyer questions related to automotive products.
- You may answer automotive knowledge questions about common car categories such as sedans, hatchbacks, coupes, SUVs, crossovers, pickups, vans, wagons, EVs, hybrids, diesel vehicles, luxury vehicles, performance cars, and off-road vehicles.
- You may answer general knowledge about vehicle systems and parts such as engines, transmissions, brakes, suspension, steering, cooling, radiators, exhaust, filters, spark plugs, alternators, batteries, drivetrains, tyres/tires, lighting, body panels, sensors, belts, hoses, and maintenance components.
- Explain what a part does, common symptoms of failure, common buying considerations, and what details a buyer should confirm before purchase.
- For fitment questions, do not invent exact compatibility. Ask for make, model, year, engine size, trim, drivetrain, or VIN when those details are needed.
- If catalog data is supplied, use it to talk about the currently visible products on the auto parts page. Do not invent live listings beyond the supplied catalog summary.
- If the user asks something unrelated to auto parts, vehicles, or the auto-parts page, politely say this assistant is limited to the auto parts page and automotive questions.
- For safety-critical repairs, braking, steering, suspension, or engine diagnosis, encourage checking with a qualified mechanic when uncertainty could cause harm.
""".strip()


def env_api_key():
    return os.environ.get("NVIDIA_API_KEY") or os.environ.get("MM_NVIDIA_API_KEY") or ""


def json_bytes(payload):
    return json.dumps(payload).encode("utf-8")


def trim_messages(messages):
    safe = []
    for row in messages[-12:]:
        if not isinstance(row, dict):
            continue
        role = str(row.get("role", "")).strip().lower()
        content = str(row.get("content", "")).strip()
        if role not in {"user", "assistant", "system"}:
            continue
        if not content:
            continue
        safe.append({"role": role, "content": content[:4000]})
    return safe


def build_system_prompt(user_context=None, page_context=None):
    lines = [SITE_CONTEXT]
    if isinstance(page_context, dict):
        scope = str(page_context.get("scope", "")).strip().lower()
        page_name = str(page_context.get("page", "")).strip().lower()
        if scope == "auto-parts" or page_name in {"auto-parts.html", "auto-parts-agent.html"}:
            lines.append(AUTO_PARTS_CONTEXT)
    if isinstance(user_context, dict):
        role = str(user_context.get("role", "")).strip()
        name = str(user_context.get("name", "")).strip()
        email = str(user_context.get("email", "")).strip()
        details = []
        if role:
            details.append("role=" + role)
        if name:
            details.append("name=" + name)
        if email:
            details.append("email=" + email)
        if details:
            lines.append("Current session context: " + ", ".join(details) + ".")
    if isinstance(page_context, dict):
        page = str(page_context.get("page", "")).strip()
        referrer = str(page_context.get("referrer", "")).strip()
        if page or referrer:
            lines.append("Page context: page=" + (page or "unknown") + (", referrer=" + referrer if referrer else "") + ".")
        category_focus = str(page_context.get("categoryFocus", "")).strip()
        if category_focus:
            lines.append("Category focus: " + category_focus + ".")
        visible_count = page_context.get("visibleCount")
        if isinstance(visible_count, int):
            lines.append("Visible catalog count on this page: " + str(visible_count) + ".")
        catalog = page_context.get("catalogSummary")
        if isinstance(catalog, list) and catalog:
            trimmed = []
            for row in catalog[:25]:
                if not isinstance(row, dict):
                    continue
                trimmed.append({
                    "name": str(row.get("name", "")).strip()[:120],
                    "category": str(row.get("category", "")).strip()[:80],
                    "seller": str(row.get("seller", "")).strip()[:80],
                    "price": str(row.get("price", "")).strip()[:40],
                    "stock": str(row.get("stock", "")).strip()[:40]
                })
            if trimmed:
                lines.append("Current auto-parts page catalog summary: " + json.dumps(trimmed, ensure_ascii=True) + ".")
    return "\n\n".join(lines)


def call_nvidia(messages, user_context=None, page_context=None):
    api_key = env_api_key()
    if not api_key:
        raise RuntimeError("Missing NVIDIA API key. Set NVIDIA_API_KEY or MM_NVIDIA_API_KEY before starting the server.")

    payload = {
        "model": MODEL,
        "messages": [{"role": "system", "content": build_system_prompt(user_context, page_context)}] + trim_messages(messages),
        "max_tokens": 700,
        "temperature": 0.35,
        "top_p": 0.9,
        "frequency_penalty": 0.0,
        "presence_penalty": 0.0,
        "stream": False
    }

    request = Request(
        ENDPOINT,
        data=json_bytes(payload),
        headers={
            "Authorization": "Bearer " + api_key,
            "Accept": "application/json",
            "Content-Type": "application/json"
        },
        method="POST"
    )

    try:
        with urlopen(request, timeout=90) as response:
            raw = response.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        message = body.strip() or ("HTTP " + str(exc.code))
        raise RuntimeError("NVIDIA API error: " + message) from exc
    except URLError as exc:
        raise RuntimeError("Could not reach NVIDIA API: " + str(exc.reason)) from exc

    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("NVIDIA API returned no choices.")
    message = choices[0].get("message") or {}
    content = str(message.get("content", "")).strip()
    if not content:
        raise RuntimeError("NVIDIA API returned an empty response.")
    return content


class MatrixMarketAIHandler(BaseHTTPRequestHandler):
    server_version = "MatrixMarketAI/1.0"

    def _send_json(self, status, payload):
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self):
        self._send_json(204, {})

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {
                "ok": True,
                "site": SITE_NAME,
                "model": MODEL,
                "endpoint": ENDPOINT,
                "keyConfigured": bool(env_api_key())
            })
            return

        self._send_json(404, {"ok": False, "error": "Route not found."})

    def do_POST(self):
        if self.path != "/api/ai/chat":
            self._send_json(404, {"ok": False, "error": "Route not found."})
            return

        payload = self._read_json()
        messages = payload.get("messages") or []
        if not isinstance(messages, list) or not messages:
            self._send_json(400, {"ok": False, "error": "messages is required and must be a non-empty array."})
            return

        try:
            reply = call_nvidia(
                messages=messages,
                user_context=payload.get("userContext") or {},
                page_context=payload.get("pageContext") or {}
            )
        except Exception as exc:
            self._send_json(500, {"ok": False, "error": str(exc)})
            return

        self._send_json(200, {"ok": True, "reply": reply})

    def log_message(self, format_, *args):
        return


def main():
    server = ThreadingHTTPServer((HOST, PORT), MatrixMarketAIHandler)
    print(f"MatrixMarket AI server running at http://{HOST}:{PORT}")
    print("Set NVIDIA_API_KEY or MM_NVIDIA_API_KEY before using the chat page.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
