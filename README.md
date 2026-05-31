# Grays.com Negotiation Game

A bilateral negotiation game for the [mygames.live](https://classroom.mygames.live) classroom platform.

Two roles negotiate the sale of the internet domain **Grays.com**: Chris (seller) and Kelly (buyer). Students prepare async before class, then negotiate face-to-face during the live session. The platform handles role assignment, preparation, partner matching, and outcome reconciliation.

Part of the **mygames.live** project by Elena Katok, UT Dallas Jindal School of Management.

---

## Architecture

This application is self-contained: its own Firebase project (`grays-mygames-live`), its own GitHub repo, deployed to `grays.mygames.live`.

It integrates with the classroom platform via a JWT launch contract (classroom → game) and a result callback (game → classroom). See `Game_Engine_Architecture_v1.md` for the full contract.

### Folder layout

```
grays-com/
├── frontend/          React + TypeScript + Vite (student and instructor UI)
│   └── src/
│       ├── engine/    Internal engine modules (confirmation gate, attendance, presence, JWT)
│       ├── pages/     Route-level page components
│       ├── components/ Game-specific UI components
│       └── lib/       Game-specific logic
├── functions/         Cloud Functions (Node 20 + TypeScript)
│   └── src/
│       ├── engine/    Server-side engine helpers (token verify, result callback)
│       ├── matching.ts  Grays.com matching algorithm
│       └── finalize.ts  Z-score computation and classroom callback
├── firestore.rules
├── firestore.indexes.json
├── database.rules.json
├── firebase.json
└── .env.example
```

---

## Local Development

### Prerequisites

- Node 20+
- Firebase CLI (`npm install -g firebase-tools`)
- A `.env.local` file in `frontend/` with the Firebase web config (copy from `.env.example`)
- A `.env` file in `functions/` with `CLASSROOM_PUBLIC_KEY`, `CLASSROOM_CALLBACK_SECRET`, `CLASSROOM_CALLBACK_URL`

### Run the emulators + dev server

```bash
# Terminal 1 — Firebase emulators (Firestore, Functions, Auth, RTDB)
firebase emulators:start

# Terminal 2 — Vite dev server
cd frontend
npm run dev
```

Open `http://localhost:5173` in your browser.

Emulator UI is at `http://localhost:4001`.

Ports are remapped to avoid collisions with the classroom emulators:
| Service    | Port |
|------------|------|
| Auth       | 9100 |
| Functions  | 5002 |
| Firestore  | 8081 |
| RTDB       | 9001 |
| Hosting    | 5003 |
| UI         | 4001 |

### Install dependencies

```bash
cd frontend && npm install
cd ../functions && npm install
```

---

## Entry Points

| URL | Description |
|-----|-------------|
| `/play?token=<JWT>` | Classroom-launched student or instructor view |
| `/configure?token=<JWT>` | Instructor configuration (called from classroom) |
| `/dashboard` | Instructor dashboard (standalone or from classroom JWT) |
| `/` | Standalone login (no classroom JWT) |

---

## Classroom Integration

When launched from the classroom, the game receives a signed RS256 JWT (key id `classroom-v1`) with:

```json
{
  "participant_id": "uuid",
  "name": "Alice Johnson",
  "game_instance_id": "uuid",
  "game_config_id": "uuid",
  "role": "student",
  "classroom_callback_url": "https://classroom.mygames.live/api/game-results"
}
```

The game verifies the JWT using the classroom's public key (stored in `CLASSROOM_PUBLIC_KEY`), then runs the game. When participants finish, the game pushes `GameResult` records back to `classroom_callback_url` using `CLASSROOM_CALLBACK_SECRET`.

---

## Standalone Mode

To run without the classroom (e.g., at another university):

1. Clone this repo
2. Create your own Firebase project
3. Copy `.env.example` → `frontend/.env.local` and fill in your Firebase config
4. Leave `CLASSROOM_*` variables blank — the game detects this and disables classroom callbacks
5. `firebase deploy`

Students log in with session codes issued by the game itself. Results are stored locally in Firestore; no callback is sent.

---

## Deployment

```bash
cd frontend && npm run build
firebase deploy
```

Deployed to `https://grays.mygames.live` (Firebase Hosting, project `grays-mygames-live`).

---

## Secrets

Production secrets are stored as Firebase Function secrets, not in `.env`:

```bash
firebase functions:secrets:set CLASSROOM_PUBLIC_KEY
firebase functions:secrets:set CLASSROOM_CALLBACK_SECRET
```

Never commit `.env`, `.env.local`, `.secret.local`, or any file containing real keys.
