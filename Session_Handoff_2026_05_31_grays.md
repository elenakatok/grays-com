# Session Handoff — May 31, 2026 (Grays.com game)

**Project:** mygames.live — Grays.com Negotiation Game
**Author:** Elena Katok
**Status:** Pre-flight complete. Firebase project linked, repo pushed, emulators verified. Ready for Phase 1 (preparation flow).

---

## What was accomplished today

### 1. Project scaffolded — 38 files

Full scaffold matching the classroom's stack, per Game Engine Architecture Section 4a.

**Stack versions (locked to match classroom):**

| Layer | Version |
|-------|---------|
| React | 19.2.6 |
| react-router-dom | 7.15.1 |
| Vite | 8.0.12 |
| TypeScript (frontend) | ~6.0.2 |
| Firebase JS SDK | ^12.13.0 |
| firebase-functions | ^5.0.0 |
| firebase-admin | ^12.0.0 |
| jsonwebtoken | ^9.0.3 |
| TypeScript (functions) | ^5.3.3 |
| Node runtime | 20 (pinned) |

**Folder layout created:**

```
grays-com/
├── frontend/src/
│   ├── engine/         ConfirmationGate, AttendanceCodeEntry, WaitingRoom, usePresence
│   ├── pages/          Play, Configure, InstructorDashboard, StandaloneLogin (stubs)
│   ├── App.tsx         Routes: /play  /configure  /dashboard  /
│   └── firebase.ts     Firestore + RTDB + Auth, emulator connections in DEV
├── functions/src/
│   ├── engine/         verifyToken, reportResult, classroomPublicKey
│   ├── matching.ts     Grays.com algorithm (extras distributed, not dropped)
│   ├── finalize.ts     Z-score computation (Chris surplus / Kelly surplus)
│   └── index.ts        verifyToken, triggerMatching, finalizeInstance Cloud Functions
├── firestore.rules     Locked: allow read, write: if false
├── database.rules.json Locked: .read false, .write false
├── firebase.json       All six emulators on remapped ports (see below)
├── .firebaserc         grays-mygames-live
├── .env.example        All Firebase web config vars + CLASSROOM_PUBLIC_KEY (PEM) + CLASSROOM_CALLBACK_SECRET + CLASSROOM_CALLBACK_URL
└── README.md
```

**Architectural decision carried through:** Engine pieces are inlined in `frontend/src/engine/` and `functions/src/engine/` — no separate `@mygames/game-engine` package yet. Easy to extract when a second game needs them.

---

### 2. Firebase project linked

**Project ID:** `grays-mygames-live`
`.firebaserc` points to this project. Not the classroom project (`mygames-classroom-aec1b`).

Firebase services to be enabled before first deploy (already exist in the console project, not yet configured from CLI):
- Firestore, Realtime Database, Cloud Functions, Hosting, Authentication, App Check

---

### 3. Classroom public key wired in

The classroom signs game-launch JWTs with RS256, key id `classroom-v1`. The public half was provided as a JWKS:

```json
{
  "kty": "RSA",
  "n": "2lO4IdqNX7pzR67cp9c_ckt...",
  "e": "AQAB",
  "use": "sig",
  "alg": "RS256",
  "kid": "classroom-v1"
}
```

Converted to PEM using `node crypto.createPublicKey({ key: jwk, format: 'jwk' }).export(...)` and stored as a constant in:

```
functions/src/engine/classroomPublicKey.ts
```

`verifyClassroomToken()` in `verifyToken.ts`:
- Checks `kid === 'classroom-v1'` before calling `jwt.verify()` (belt-and-suspenders)
- Accepts an optional `publicKey` override parameter for testing / key rotation
- Defaults to the baked-in constant — no secret needed for a public key

**Smoke test:** `verifyClassroomToken('not.a.jwt')` correctly throws `"Unexpected key id: (none)"` — the `kid` check fires before the signature check, as expected.

**`.env.example`** documents the PEM in single-line escaped format (the format dotenv requires for multi-line values). The key is public and committed to the repo; only `CLASSROOM_CALLBACK_SECRET` is a real secret.

---

### 4. GitHub repo pushed

**Repo:** https://github.com/elenakatok/grays-com
**Branch:** `main`

| Commit | Description |
|--------|-------------|
| `5807a23` | Initial scaffold for Grays.com game (38 files) |
| `c5f7569` | Fix functions emulator port: 5002 → 5004 |

Remote URL confirmed before push: `https://github.com/elenakatok/grays-com.git`

---

### 5. Smoke test results

**Vite dev server:** HTTP 200 on `http://localhost:5175/`
(5173 and 5174 already taken by the classroom stack; Vite auto-incremented.)

**Firebase emulators:** All six services started cleanly.

| Emulator | Port | Note |
|----------|------|------|
| Auth | 9100 | ✅ |
| Functions | 5004 | ✅ (remapped from 5002 — see Known Issues) |
| Firestore | 8081 | ✅ |
| Realtime Database | 9001 | ✅ |
| Hosting | 5003 | ✅ |
| Emulator UI | 4001 | ✅ |

**Three Cloud Functions loaded without error:**
- `verifyToken` — http://127.0.0.1:5004/grays-mygames-live/us-central1/verifyToken
- `triggerMatching` — http://127.0.0.1:5004/grays-mygames-live/us-central1/triggerMatching
- `finalizeInstance` — http://127.0.0.1:5004/grays-mygames-live/us-central1/finalizeInstance

Hub remapped to 4401, logging to 4501 (4400/4500 taken by classroom emulators).

---

## Emulator ports for this game

When running grays-com alongside the classroom emulators, use these ports. They are in `firebase.json`.

| Service | Port | Classroom equivalent |
|---------|------|---------------------|
| Auth | 9100 | 9099 |
| Functions | 5004 | 5001 |
| Firestore | 8081 | 8080 |
| Realtime Database | 9001 | (not used) |
| Hosting | 5003 | 5002 |
| Emulator UI | 4001 | 4000 |
| Vite dev server | 5175 | 5173 |

**Note on Functions port:** The architecture doc originally mapped grays-com Functions to 5002, but the classroom's hosting emulator owns 5002 when both stacks run together. Remapped to 5004. `firebase.json` is already updated; no further action needed.

---

## Known issues / tech debt

| Issue | Priority | Notes |
|-------|----------|-------|
| **`firebase-functions` behind latest** | High — fix before first deploy | `npm warn` flagged during install. Run `npm install --save firebase-functions@latest` in `functions/` and check for breaking changes before deploying. |
| **Node 20 pinned, host runs 26** | Medium — deploy-time only | `functions/package.json` pins `"node": "20"`. The emulator runs on the host's Node 26 with a warning. No dev impact; Firebase production will enforce Node 20 correctly. Upgrade to Node 22 before the Node 20 deprecation deadline (Oct 2025 — already past; migrate soon). |
| **`CLASSROOM_CALLBACK_SECRET` not yet set in grays Firebase project** | ✅ Done — 2026-05-31 | Set in both Firebase projects (`CALLBACK_SECRET_GRAYS_COM` in classroom Secret Manager, `CLASSROOM_CALLBACK_SECRET` in grays Secret Manager). Saved in password manager. Will be picked up on next deploy. |
| **Firestore / RTDB rules locked** | Expected — loosen per feature | Both databases start at `allow read, write: if false`. Rules get written feature-by-feature as Firestore collections are defined. |
| **Stub pages not yet wired** | Expected | `Play.tsx`, `Configure.tsx`, `InstructorDashboard.tsx`, `StandaloneLogin.tsx` are stubs. Phase 1 wires them. |
| **Standalone instructor auth not yet built** | Medium — needed for standalone mode | `functions/src/index.ts` sets up Firebase Auth but no email/password instructor login page exists yet. Can be deferred until after Phase 1 prep flow is done; the classroom launch path works without it. |

---

## Where Phase 1 picks up

**Next task:** Role assignment Cloud Function — Step 6 of the spec's §9 build tasks, first step of Prep Phase (§2 Phase 1 Step 1).

### Phase 1 build tasks (from `Grays_com_Game_Specification_v1.md` §9)

**Remaining setup:**
- [ ] **Step 5:** Standalone instructor auth (Firebase Auth, email + password) — can follow prep flow

**Phase 1 — Preparation flow:**
- [ ] **Step 6:** Role assignment Cloud Function — balanced (equal Chris/Kelly counts), persistent (once assigned, never changes). Called on first launch; returns existing role if already assigned.
- [ ] **Step 7:** Public information page — static content: domain name market, Washington Grays, Gray's Restaurant, negotiation setup. Both roles see the same page.
- [ ] **Step 8:** Private information pages — role-specific, secured so Chris never sees Kelly's info and vice versa. Chris sees switching cost ($15K). Kelly sees BATNA (WashingtonGrays.com, $10) and ceiling ($550K).
- [ ] **Step 9:** PDF downloads — static files on Firebase Hosting. Links from the private info page.
- [ ] **Step 10:** Knowledge check — one question for v1: "What is your role?" Radio buttons, retry on wrong answer. Track `knowledge_check_score` (1.0 if correct on first try) and `knowledge_check_attempts`.
- [ ] **Step 11:** Preparation questions form — 5 questions (first topic, estimated other's reservation price, question for other side, planned first offer, reason for offer). Save state per question to Firestore. Free text + number fields per spec.
- [ ] **Step 12:** Name entry screen — student enters display name (`nameChris` / `nameKelly` on the group record, `display_name` on participant).
- [ ] **Step 13:** "Hold for sync" screen — "Preparation complete. When class begins and the instructor releases matching, you'll see who you've been paired with." Gate held until instructor triggers Phase 2.
- [ ] **Step 14:** Firestore security rules — participants can read/write only their own record; role-specific fields enforced at the rules layer.

**Key data shape to establish in Step 6** (from spec §3):
```
GraysParticipant {
  participant_id, game_instance_id, role: "Chris" | "Kelly",
  display_name, prep_first_topic, prep_estimated_other_price,
  prep_question_for_other, prep_planned_first_offer, prep_planned_offer_reason,
  knowledge_check_score, knowledge_check_attempts, prep_completed_at,
  ...
}
```

**Role assignment rules:**
- Balanced: alternate Chris/Kelly as participants arrive; rebalance when new students are added
- Persistent: once a role is written to Firestore, it never changes (unless instructor manually reassigns)
- Strategy configurable (`game_config.role_balance_strategy`): "strictly_balanced" (default) or "random_with_rebalancing"

---

## Pre-flight checks for next session

Before starting Claude Code in this project, verify:

```bash
cd ~/projects/games-platform/games/grays-com

# 1. Confirm the right Git remote
git remote -v
# Should show: origin  https://github.com/elenakatok/grays-com.git (fetch)
# NOT the classroom repo URL

# 2. Confirm clean working tree on main
git status
# Should show: nothing to commit, working tree clean

# 3. Confirm latest commits are present
git log --oneline -5
# Should show c5f7569 (port fix) and 5807a23 (initial scaffold) at the top

# 4. Confirm emulators start on correct ports
firebase emulators:start --project grays-mygames-live
# Should show all six services on the ports in the table above
# Should NOT show any "port taken" errors (if classroom emulators are running,
# check that classroom uses 9099/5001/8080/5002/4000, not any of ours)
# Ctrl+C after confirming

# 5. Confirm Vite starts
cd frontend && npm run dev
# Should print a localhost URL (5175 if classroom dev server is already running; 5173 if not)
# curl that URL, confirm HTTP 200
# Ctrl+C after confirming
```

If the git remote shows the wrong URL, stop and fix before writing any code. A wrong remote means commits go to the wrong repo.

---

## Prompt to give Claude Code at the start of next session

```
Continuing work on the Grays.com negotiation game (Phase 3 of mygames.live).
Working directory: ~/projects/games-platform/games/grays-com

Read the handoff document first: Session_Handoff_2026_05_31_grays.md

Then read the game spec: ../../Grays_com_Game_Specification_v1.md (especially §2 Phase 1 and §3 data model)
And the engine architecture: ../../Game_Engine_Architecture_v1.md (especially §4a folder layout, §3 contract)

Today's goal: implement Phase 1 Step 6 — the role assignment Cloud Function.

Requirements:
- Balanced: equal-ish Chris/Kelly counts; if counts differ by >1, assign the new participant
  to the under-represented role
- Persistent: once a role is written to Firestore, it never changes
- Called when a participant first hits /play?token=<JWT>; the frontend passes the verified
  participant_id and game_instance_id to the function
- Returns the assigned (or existing) role
- Write the GraysParticipant document to Firestore with role set, prep status = "not_started"
- Write the Firestore security rule that lets participants read/write only their own
  GraysParticipant document

Work step by step. Confirm each piece compiles and passes a quick emulator test before
moving on. Don't start Step 7 (public information page) until Step 6 is solid.
```

---

## Key references

| Resource | Where |
|----------|-------|
| Game spec | `../../Grays_com_Game_Specification_v1.md` |
| Engine architecture | `../../Game_Engine_Architecture_v1.md` |
| Classroom architecture | `../../Classroom_Platform_Architecture_v2.md` |
| Local code | `~/projects/games-platform/games/grays-com/` |
| GitHub repo | https://github.com/elenakatok/grays-com |
| Firebase console (grays) | https://console.firebase.google.com → `grays-mygames-live` |
| Firebase console (classroom) | https://console.firebase.google.com → `mygames-classroom-aec1b` |
| Classroom public key | `functions/src/engine/classroomPublicKey.ts` |
| Classroom JWKS (live) | https://mygames-classroom-aec1b.web.app/.well-known/jwks.json |
| Classroom callback endpoint | `https://us-central1-mygames-classroom-aec1b.cloudfunctions.net/receiveGameResult` |
| Vite dev URL | http://localhost:5175 (when classroom dev server is running) |
| Emulator UI | http://localhost:4001 |
