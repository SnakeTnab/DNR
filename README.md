# DNR Auto-Submit (FR-TNAB-DWP1)

Automatisation complète des **DNR Investigations** d'Amazon Logistics : récupère le rapport
plusieurs fois par jour, applique un mapping par défaut sur tous les cases, et envoie l'email
automatiquement à `dnr-investigations@eulmdxdasboard.amzl.amazon.dev` — sans toucher au mailto.

Repo : https://github.com/SnakeTnab/DNR

## Architecture

```
┌────────────────────────────┐         ┌──────────────────────────┐
│  Tampermonkey (navigateur) │         │  Backend FastAPI (Render) │
│  ─────────────────────────  │  POST   │  ───────────────────────  │
│  1. Poll API getData/30min │ ───────▶│  1. Valide le payload     │
│  2. Fetch S3 du DNR.html   │  X-API  │  2. Construit l'email     │
│  3. Parse + applique map   │   Key   │  3. SMTP Gmail authentifié │
│  4. Génère payload base64  │         │     → dnr-investigations@ │
│  5. POST data au backend   │ ◀───────│  4. Renvoie succès        │
└────────────────────────────┘   200   └──────────────────────────┘
       (logistics.amazon.fr)             (dnr-auto-backend.onrender.com)
```

Le Tampermonkey doit tourner dans un onglet ouvert sur `logistics.amazon.fr` (auth session).
Le backend tourne 24/7 et fait juste le relais SMTP via Gmail.

## Structure du repo

```
DNR/
├── README.md
├── .gitignore
├── render.yaml              ← config Render (déploiement auto)
├── tampermonkey/
│   └── dnr-auto.user.js     ← à coller dans Tampermonkey
└── backend/
    ├── main.py              ← FastAPI app
    ├── requirements.txt
    └── .env.example         ← template de config locale
```

## Étape 1 — Pousser le code sur GitHub

Depuis ton dossier local contenant les fichiers (PowerShell ou Git Bash sur Windows 11) :

```powershell
# Décompresser/déplacer les fichiers dans un dossier de travail
cd C:\Users\<toi>\Documents\DNR  # ou autre

# Initialiser le repo
git init
git branch -M main
git add .
git commit -m "feat: initial DNR auto-submit (Tampermonkey + FastAPI backend)"

# Lier au repo GitHub
git remote add origin https://github.com/SnakeTnab/DNR.git
git push -u origin main
```

> Si le repo GitHub contient déjà un README initial créé par GitHub, fais d'abord
> `git pull --rebase origin main` avant le `git push`. Ou en force si tu veux écraser :
> `git push -u origin main --force`.

## Étape 2 — Déployer le backend sur Render

1. Aller sur [dashboard.render.com](https://dashboard.render.com/)
2. **New +** → **Blueprint** (pas Web Service — Blueprint lit `render.yaml`)
3. Connecter ton compte GitHub si pas déjà fait → choisir `SnakeTnab/DNR`
4. Render détecte `render.yaml` à la racine et affiche le service `dnr-auto-backend`
5. **Configurer les secrets** dans le formulaire qui apparaît :

   | Variable      | Valeur                                                                |
   |---------------|-----------------------------------------------------------------------|
   | `SMTP_USER`   | ton.adresse@gmail.com                                                 |
   | `SMTP_PASS`   | mot de passe d'application Gmail (16 caractères, voir étape 3)        |
   | `FROM_EMAIL`  | ton.adresse@gmail.com (même que `SMTP_USER` en général)               |
   | `API_KEY`     | une longue chaîne aléatoire (voir étape 3)                            |

6. **Apply** → Render build et déploie (~3-5 min)
7. Noter l'URL finale, ex. `https://dnr-auto-backend.onrender.com`
8. Tester : `curl https://dnr-auto-backend.onrender.com/health`
   → doit renvoyer `"smtp_configured": true` et `"api_key_configured": true`

> ⚠️ Plan **Free** : le service s'endort après 15 min d'inactivité. Au prochain appel, ~30s de
> cold-start. Le Tampermonkey gère un timeout de 60s donc ça passe. Pour 100% fiable et plus
> rapide : plan **Starter** à 7$/mois (pas de sleep).

## Étape 3 — Préparer les credentials Gmail

### 3.1 Activer la 2FA sur Gmail (obligatoire)

https://myaccount.google.com/security → "Validation en deux étapes" → activer (SMS ou app
Authenticator). Sans 2FA, Google interdit les mots de passe d'application depuis 2022.

### 3.2 Générer un mot de passe d'application

https://myaccount.google.com/apppasswords → créer une entrée "DNR Backend"
→ Google affiche 16 caractères style `abcd efgh ijkl mnop`
→ **copier immédiatement**, il ne sera plus jamais affiché.

### 3.3 Générer une API_KEY pour le backend

Dans Git Bash ou PowerShell :

```bash
# Git Bash
openssl rand -hex 32

# PowerShell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Tu obtiens une chaîne de 64 caractères hexa, ex. `a7f3b2c1...` — c'est cette clé qui ira à la
fois dans Render (`API_KEY`) et dans le Tampermonkey.

### 3.4 Choix de l'adresse expéditeur

Amazon voit l'email arriver depuis l'adresse mise dans `FROM_EMAIL`. Trois cas :

- **Gmail perso (`@gmail.com`)** : `SMTP_USER` = `FROM_EMAIL` = ton adresse Gmail. Simple, mais
  Amazon verra que ça vient d'un Gmail perso, pas l'adresse pro habituelle de la station.
- **Google Workspace (`@tondomaine.fr`)** : pareil, mais l'expéditeur est pro. Idéal.
- **Tu envoyais avant depuis une autre adresse pro** : configurer Gmail "Envoyer en tant que"
  (Paramètres → Comptes → Envoyer des e-mails en tant que → ajouter l'adresse pro et la
  valider par mail). Ensuite mettre cette adresse pro dans `FROM_EMAIL`. Gmail enverra avec le
  bon `From:` mais via le SMTP Google.

Si tu envoyais déjà manuellement depuis cette adresse Gmail, garde-la — le moins de
changement, le moins de risque qu'Amazon trouve l'email louche.

## Étape 4 — Installer le Tampermonkey

1. Ouvrir l'extension Tampermonkey → **Create a new script**
2. Coller le contenu de `tampermonkey/dnr-auto.user.js` (remplacer le template par défaut)
3. **Ctrl+S** pour sauvegarder
4. Ouvrir n'importe quelle page sur `logistics.amazon.fr`
5. Cliquer sur l'icône Tampermonkey → trouver "DNR Auto-Submit FR-TNAB-DWP1" dans la liste
   → cliquer sur les options du menu :
   - **⚙ Configurer Backend URL** → `https://dnr-auto-backend.onrender.com/dnr/submit`
   - **🔑 Configurer API Key** → coller la même `API_KEY` que sur Render
6. Recharger la page (F5)
7. **▶ Run now** pour tester immédiatement

## Étape 5 — Vérifier le bon fonctionnement

### Mode preview (recommandé pour le premier test)

Avant de laisser tourner en mode "envoie pour de vrai", utilise l'endpoint `/dnr/preview` qui
décode le payload et renvoie ce qui *serait* envoyé, sans toucher au SMTP :

1. Ouvrir le script dans Tampermonkey
2. Chercher la ligne `BACKEND_URL: GM_getValue('backend_url', 'https://dnr-backend.onrender.com/dnr/submit')`
3. La changer temporairement en `.../dnr/preview` via le menu Tampermonkey
4. **▶ Run now** → ouvrir la console (F12) pour voir le retour du backend
5. Vérifier que `decoded_payload.data` contient bien tes 7 cases avec le bon mapping
6. Quand tout est OK, remettre `/dnr/submit` pour activer l'envoi réel

### Vérification post-envoi

- **Console navigateur (F12)** : `[DNR-Auto] ✅ Envoyé X cases ...`
- **Boîte "Envoyés" Gmail** : tu verras l'email partir vers `dnr-investigations@...`
- **Notification Tampermonkey** : `✅ X case(s) envoyée(s)`
- **Logs Render** (dashboard → Logs) : `INFO ✅ Envoyé X cases (TNAB-DWP1) à dnr-investigations@...`

## Personnaliser le mapping

Le mapping `Delivery Scan → réponses` est défini dans `SCAN_MAPPING` au début de
`dnr-auto.user.js` (lignes ~40-100). Format :

```js
DELIVERED_TO_MAIL_SLOT: {
  completion: 'SAFE_PLACE',      // 1er select
  location:   'MAILBOX',         // 2e select
  additional: 'MAILBOX',         // 3e select
  property:   'APARTMENT_BLOCK', // 4e select
},
```

Valeurs valides (extraites du HTML Amazon) — pour `completion` puis `location` associée :

| `completion`     | `location` (selon completion)                                        |
|------------------|----------------------------------------------------------------------|
| `CUSTOMER_HHM`   | `CUSTOMER`, `CHILD`, `HHM`, `STAFF`                                  |
| `ALTERNATIVE`    | `NEIGHBOUR`, `STAFF`, `RECEPTIONIST`, `CONCIERGE`, `CARETAKER`, ...  |
| `SAFE_PLACE`     | `FRONT_DOOR`, `MAILBOX`, `PORCH`, `GARAGE`, `LOBBY`, `PARCEL_BOX`, … |
| `COMMERCIAL`     | `CUSTOMER`, `OWNER`, `EMPLOYEE`, `MANAGER`, `RECEPTIONIST`, …        |
| `LOCKER`         | `AMZN_LOCKER`                                                        |
| `PICKUP_POINT`   | `OWNER`, `EMPLOYEE`, `MANAGER`, …                                    |

Pour `property` : `HOUSE`, `APARTMENT`, `APARTMENT_BLOCK`, `TOWNHOUSE`, `SKYSCRAPER`,
`DUPLEX`, `OFFICE`, `SHOP`, `HOTEL`, etc.

Après modification : commit + push sur GitHub, OU édite directement dans Tampermonkey (mais
tu perdras l'édit au prochain pull). Le mieux est de garder le repo comme source de vérité.

## Menu Tampermonkey

| Commande                       | Effet                                                        |
|--------------------------------|--------------------------------------------------------------|
| **▶ Run now**                  | Force un cycle immédiat                                      |
| **🔁 Reset last sent**         | Oublie le dernier rapport envoyé → renvoie le même au prochain cycle |
| **⚙ Configurer Backend URL**   | Change l'URL du backend                                      |
| **🔑 Configurer API Key**      | Change la clé partagée                                       |
| **📊 Status**                  | Affiche dernier envoi, count, date, config                   |
| **🐛 Toggle DEBUG**            | Active les logs verbeux par case dans la console             |

## Sécurité

- **API_KEY** : protège le backend des appels non autorisés. Doit être long et aléatoire.
- **SMTP_PASS** : utilise toujours un **mot de passe d'application**, jamais ton vrai mdp Gmail.
- **`.env`** : jamais committer ce fichier, il est dans `.gitignore`. Le `.env.example` n'a que
  des placeholders, lui peut être versionné.
- **HTTPS only** : Render fournit HTTPS par défaut.
- **CORS** : restreint à `https://logistics.amazon.fr` côté backend.

## Idempotence et reprise

- Le Tampermonkey stocke `last_sent_creationDate` (GM storage) → ne renvoie pas le même rapport.
- Si Amazon publie une nouvelle version du DNR (mise à jour dans la journée), le `creationDate`
  change → nouveau cycle automatique.
- En cas d'erreur SMTP, `last_sent_creationDate` n'est **pas** mis à jour → retry au prochain
  cycle (30 min plus tard) sans intervention.

## Troubleshooting

**Le cycle se termine avec "Pas de rapport DNR cette semaine"**
→ Normal en début de semaine si Amazon n'a pas encore généré le rapport.

**Erreur "SMTP auth"**
→ Mauvais `SMTP_USER`/`SMTP_PASS`. Vérifier : 2FA activée + mot de passe d'application valide.

**Erreur "Backend HTTP 401"**
→ La clé du Tampermonkey ne matche pas `API_KEY` côté backend. Reconfigurer via le menu.

**Erreur "Index API status 401" ou "403"**
→ Session Amazon expirée. Recharger une page logistics.amazon.fr connectée.

**Tracking ID mappé avec "DEFAULT"**
→ Le `Delivery Scan` n'est pas dans `SCAN_MAPPING`. Voir la console pour la liste des scans
inconnus, puis ajouter une entrée dans le mapping et commit.

**Render "cold start"**
→ Premier appel après 15 min d'inactivité prend ~30s. Le timeout côté Tampermonkey est à 60s
donc ça passe. Pour éviter : passer en plan Starter, ou utiliser un cron externe (UptimeRobot)
qui ping `/health` toutes les 10 min.

## Endpoints du backend

| Méthode | Path          | Auth          | Description                                                    |
|---------|---------------|---------------|----------------------------------------------------------------|
| GET     | `/`           | —             | Info de version                                                |
| GET     | `/health`     | —             | Healthcheck (config SMTP exposée sans secrets)                 |
| POST    | `/dnr/preview`| `X-API-Key`   | Dry-run : décode et renvoie ce qui serait envoyé (pas d'envoi) |
| POST    | `/dnr/submit` | `X-API-Key`   | Envoi réel via SMTP                                            |

Documentation interactive auto-générée par FastAPI : `https://dnr-auto-backend.onrender.com/docs`

## License

Usage interne DSP. Ne pas redistribuer.
