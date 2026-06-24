"""
DNR Auto-Submit Backend
========================
Reçoit le payload base64 généré par le script Tampermonkey et l'envoie par email
SMTP authentifié vers l'adresse Amazon `dnr-investigations@eulmdxdasboard.amzl.amazon.dev`.

Endpoints
---------
- POST /dnr/submit  : envoie l'email (auth via header X-API-Key)
- GET  /health      : healthcheck (config SMTP exposée)
- GET  /            : info de version

Variables d'environnement (.env)
--------------------------------
- SMTP_HOST       : ex. smtp.gmail.com
- SMTP_PORT       : ex. 587
- SMTP_USER       : login SMTP (ex. ton adresse Gmail/Outlook)
- SMTP_PASS       : mot de passe d'application
- FROM_EMAIL      : adresse expéditeur (par défaut = SMTP_USER)
- TO_EMAIL        : adresse Amazon (par défaut = dnr-investigations@...)
- API_KEY         : clé partagée avec le Tampermonkey
- LOG_TO_FILE     : si "1", log aussi dans /tmp/dnr_sent.log
"""

import base64
import json
import logging
import os
import smtplib
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# -----------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("dnr-backend")

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")
FROM_EMAIL = os.getenv("FROM_EMAIL", SMTP_USER)
TO_EMAIL = os.getenv("TO_EMAIL", "dnr-investigations@eulmdxdasboard.amzl.amazon.dev")
API_KEY = os.getenv("API_KEY", "")
LOG_TO_FILE = os.getenv("LOG_TO_FILE", "0") == "1"
APP_VERSION = "1.0.0"

# -----------------------------------------------------------------------------
# FastAPI
# -----------------------------------------------------------------------------
app = FastAPI(title="DNR Auto-Submit Backend", version=APP_VERSION)

# CORS : autoriser le Tampermonkey (qui tourne sur logistics.amazon.fr)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://logistics.amazon.fr"],
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


# -----------------------------------------------------------------------------
# Schémas
# -----------------------------------------------------------------------------
class DNRSubmitRequest(BaseModel):
    dsp: str = Field(..., examples=["TNAB"])
    station: str = Field(..., examples=["DWP1"])
    data_b64: str = Field(..., description="Payload base64 généré côté navigateur")
    tracking_ids: List[str] = Field(..., min_length=1)
    report_creation_date: Optional[str] = None
    report_name: Optional[str] = None
    cases_count: Optional[int] = None


class DNRSubmitResponse(BaseModel):
    success: bool
    sent_at: str
    count: int
    tracking_ids: List[str]
    to: str
    from_: str = Field(..., alias="from")
    subject: str

    model_config = {"populate_by_name": True}


# -----------------------------------------------------------------------------
# Auth
# -----------------------------------------------------------------------------
def verify_api_key(x_api_key: Optional[str] = Header(default=None)):
    if not API_KEY:
        log.error("API_KEY n'est pas configurée côté backend")
        raise HTTPException(status_code=500, detail="API_KEY not configured")
    if not x_api_key or x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


# -----------------------------------------------------------------------------
# Email building & send
# -----------------------------------------------------------------------------
def build_email(dsp: str, station: str, data_b64: str) -> EmailMessage:
    """Construit l'email exactement comme le ferait le HTML d'Amazon."""
    msg = EmailMessage()
    msg["Subject"] = f"{dsp}-{station}"
    msg["From"] = FROM_EMAIL
    msg["To"] = TO_EMAIL

    # Le HTML Amazon construit le body ainsi :
    #   `PLEASE DO NOT MODIFY...THANK YOU.\n\n` + regenerateData()
    # où regenerateData() retourne :
    #   `\n\n---###START###---<base64>---###END###---\n\n\n`
    body = (
        "PLEASE DO NOT MODIFY OR ADD ANY DETAILS IN THIS EMAIL. "
        "JUST CLICK 'Send' TO SHARE RELEVANT FEEDBACK WITH AMZL. THANK YOU."
        "\n\n"
        f"\n\n---###START###---{data_b64}---###END###---\n\n\n"
    )
    msg.set_content(body, subtype="plain", charset="utf-8")
    return msg


def send_email(msg: EmailMessage) -> None:
    """Envoi SMTP authentifié (STARTTLS)."""
    if not SMTP_USER or not SMTP_PASS:
        raise RuntimeError("SMTP_USER ou SMTP_PASS non configurés")

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as server:
        server.ehlo()
        server.starttls()
        server.ehlo()
        server.login(SMTP_USER, SMTP_PASS)
        server.send_message(msg)


def log_to_file(record: dict) -> None:
    if not LOG_TO_FILE:
        return
    try:
        with open("/tmp/dnr_sent.log", "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:
        log.warning("Impossible d'écrire dans le log file: %s", e)


def validate_payload(data_b64: str) -> dict:
    """Vérifie que le payload base64 est bien du JSON valide avec la bonne structure."""
    try:
        decoded = base64.b64decode(data_b64).decode("utf-8")
        parsed = json.loads(decoded)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Payload base64 invalide: {e}")

    if not isinstance(parsed, dict) or "data" not in parsed or "version" not in parsed:
        raise HTTPException(
            status_code=400,
            detail='Payload doit être {"version":1,"data":[...]}',
        )
    if not isinstance(parsed["data"], list) or len(parsed["data"]) == 0:
        raise HTTPException(status_code=400, detail="data vide ou pas une liste")
    return parsed


# -----------------------------------------------------------------------------
# Endpoints
# -----------------------------------------------------------------------------
@app.get("/")
def root():
    return {
        "service": "DNR Auto-Submit Backend",
        "version": APP_VERSION,
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": APP_VERSION,
        "smtp_configured": bool(SMTP_USER and SMTP_PASS),
        "api_key_configured": bool(API_KEY),
        "from": FROM_EMAIL,
        "to": TO_EMAIL,
        "smtp_host": SMTP_HOST,
        "smtp_port": SMTP_PORT,
    }


@app.post("/dnr/preview")
def preview_dnr(req: DNRSubmitRequest, _: None = Depends(verify_api_key)):
    """Dry-run : décode le payload et renvoie ce qui SERAIT envoyé, sans toucher au SMTP.

    Utile pour valider le mapping côté Tampermonkey avant de passer en mode production.
    """
    parsed = validate_payload(req.data_b64)
    msg = build_email(req.dsp, req.station, req.data_b64)
    return {
        "would_send": True,
        "subject": msg["Subject"],
        "from": FROM_EMAIL,
        "to": TO_EMAIL,
        "body_preview": msg.get_content()[:500],
        "decoded_payload": parsed,
        "tracking_ids": req.tracking_ids,
        "count": len(req.tracking_ids),
    }


@app.post("/dnr/submit", response_model=DNRSubmitResponse, response_model_by_alias=True)
def submit_dnr(req: DNRSubmitRequest, request: Request, _: None = Depends(verify_api_key)):
    client_ip = request.client.host if request.client else "?"
    log.info(
        "POST /dnr/submit from %s | %s-%s | %d tracking_ids | report=%s",
        client_ip,
        req.dsp,
        req.station,
        len(req.tracking_ids),
        req.report_name,
    )

    # 1) Sanity check du payload
    parsed = validate_payload(req.data_b64)
    n_in_payload = len(parsed["data"])
    if n_in_payload != len(req.tracking_ids):
        log.warning(
            "Mismatch: payload contient %d entrées vs tracking_ids=%d",
            n_in_payload,
            len(req.tracking_ids),
        )

    # 2) Construire et envoyer l'email
    msg = build_email(req.dsp, req.station, req.data_b64)
    try:
        send_email(msg)
    except smtplib.SMTPAuthenticationError as e:
        log.error("SMTP auth failed: %s", e)
        raise HTTPException(status_code=502, detail=f"SMTP auth: {e}")
    except smtplib.SMTPException as e:
        log.error("SMTP error: %s", e)
        raise HTTPException(status_code=502, detail=f"SMTP error: {e}")
    except (OSError, ConnectionError) as e:
        log.error("SMTP connection error: %s", e)
        raise HTTPException(status_code=502, detail=f"SMTP connection: {e}")
    except Exception as e:
        log.exception("Erreur inattendue à l'envoi")
        raise HTTPException(status_code=500, detail=str(e))

    sent_at = datetime.now(timezone.utc).isoformat()
    record = {
        "sent_at": sent_at,
        "dsp": req.dsp,
        "station": req.station,
        "subject": msg["Subject"],
        "from": FROM_EMAIL,
        "to": TO_EMAIL,
        "count": len(req.tracking_ids),
        "tracking_ids": req.tracking_ids,
        "report_creation_date": req.report_creation_date,
        "report_name": req.report_name,
        "client_ip": client_ip,
    }
    log_to_file(record)
    log.info(
        "✅ Envoyé %d cases (%s-%s) à %s | from %s",
        len(req.tracking_ids),
        req.dsp,
        req.station,
        TO_EMAIL,
        FROM_EMAIL,
    )

    return DNRSubmitResponse(
        success=True,
        sent_at=sent_at,
        count=len(req.tracking_ids),
        tracking_ids=req.tracking_ids,
        to=TO_EMAIL,
        **{"from": FROM_EMAIL},
        subject=msg["Subject"],
    )
