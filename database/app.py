import os
from pathlib import Path
 
from dotenv import load_dotenv
from flask import Flask, redirect, render_template, request, url_for

BASE_DIR = Path(__file__).resolve().parent
for candidate in (BASE_DIR, *BASE_DIR.parents):
    if (candidate / "templates").is_dir() and (candidate / "static").is_dir():
        BASE_DIR = candidate
        break
 
load_dotenv(BASE_DIR / ".env")
 
app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
)
 
URL_VARS = ("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL")
KEY_VARS = (
    "SUPABASE_ANON_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "VITE_SUPABASE_ANON_KEY",
)
 
 
def first_env(names):
    for name in names:
        value = os.environ.get(name)
        if value:
            return value.strip()
    return ""
 
 
def supabase_config():

    return {
        "supabase_url": first_env(URL_VARS),
        "supabase_anon_key": first_env(KEY_VARS),
        "supabase_bucket": os.environ.get("SUPABASE_BUCKET", "mapping-files"),
    }
 
 

AUTH_COOKIE = "sb-session"
 
 
def signed_in():
    return bool(request.cookies.get(AUTH_COOKIE))
 
 
@app.route("/")
def index():
    if not signed_in():
        return redirect(url_for("login"))
    return render_template("index.html", **supabase_config())
 
 
@app.route("/login")
def login():
    if signed_in():
        return redirect(url_for("index"))
    return render_template("login.html", **supabase_config())
 
 
@app.after_request
def no_cache_in_debug(response):
    if app.debug:
        response.headers["Cache-Control"] = "no-store"
    return response
 
 
if __name__ == "__main__":
    print("  project root : " + str(BASE_DIR))
    print("  templates    : " + app.template_folder)
    print("  static       : " + app.static_folder)
 

    tpl_dir = Path(app.template_folder)
    found = sorted(f.name for f in tpl_dir.glob("*")) if tpl_dir.is_dir() else []
    print("  templates found: " + (", ".join(found) if found else "(none)"))
    for needed in ("index.html", "login.html"):
        if needed not in found:
            print("  ERROR: templates/" + needed + " is missing.")
 
    static_dir = Path(app.static_folder)
    if not (static_dir / "supabase-sync.js").is_file():
        print("  ERROR: static/supabase-sync.js is missing.")
    if not (static_dir / "style.css").is_file():
        print("  ERROR: static/style.css is missing.")
 
    missing = []
    if not first_env(URL_VARS):
        missing.append("SUPABASE_URL")
    if not first_env(KEY_VARS):
        missing.append("SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY")
    if missing:
        print("\n  WARNING: missing in .env -> " + ", ".join(missing))
        print("  Looked for: " + str(BASE_DIR / ".env"))
        print("  The pages will load but Supabase will fail with "
              "'supabaseUrl is required'.")
        print("  Copy .env.example to .env and fill it in.\n")
 

    app.run(
        debug=os.environ.get("FLASK_DEBUG", "1") == "1",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", 5000)),
    )
 