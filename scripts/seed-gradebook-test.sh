#!/usr/bin/env bash
#
# Seeds a fixed, deterministic "Completed" Grays.com game instance on BOTH
# emulator Firestores, so the gradebook-push flow
#   finalizeInstance → pushResultsToClassroom → receiveGameResult
# can be exercised end-to-end and re-run at will.
#
# Idempotent: every write uses a fixed ID and full-document overwrite
# semantics (Firestore REST PATCH without updateMask = replace). Re-running
# this script against the same running emulators produces the same shape,
# never duplicates.
#
# Does NOT start, stop, or restart any emulator — it only talks to whatever
# is already listening on the ports below.
#
# Requires (already running, unmodified by this script):
#   grays-com functions emulator   :5004   (project grays-mygames-live)
#   grays-com Firestore emulator   :8081
#   classroom functions emulator   :5001   (project mygames-classroom-aec1b) — not called directly
#   classroom Firestore emulator   :8080
#   classroom Auth emulator        :9099
#
# grays-com side: reuses the existing seedSimulatedGame dev endpoint (the
# same one DevLauncher's "Completed" button calls) rather than hand-writing
# participant/group documents — so the shape finalizeInstance reads is
# guaranteed to match the real Completed-seed path.
#
# classroom side: reuses the admin@test.com / "Strategic Negotiation" course
# entities that scripts/seed-emulator.sh establishes. NOTE: seed-emulator.sh
# itself currently fails on this machine — `UID=$(...)` collides with bash's
# readonly $UID builtin, so it crashes right after creating the Auth user but
# before writing any Firestore docs. We do not patch that file (out of
# scope); instead this script re-creates the same entities (same email,
# fields, course title/code) directly, with a fixed course_id instead of a
# fresh random UUID each run, and reuses the admin@test.com auth user if it
# already exists (sign-in instead of sign-up) so it tolerates that script's
# partial prior run too.
#
# Usage: bash scripts/seed-gradebook-test.sh

set -euo pipefail

INSTANCE_ID="seed-grays-completed-01"
N_STUDENTS=10
FIXED_TS="2026-06-16T00:00:00Z"

GRAYS_PROJECT="grays-mygames-live"
CLASSROOM_PROJECT="mygames-classroom-aec1b"

GRAYS_FUNCTIONS="http://127.0.0.1:5004/${GRAYS_PROJECT}/us-central1"
GRAYS_FS="http://127.0.0.1:8081/v1/projects/${GRAYS_PROJECT}/databases/(default)/documents"
CLASSROOM_FS="http://127.0.0.1:8080/v1/projects/${CLASSROOM_PROJECT}/databases/(default)/documents"
CLASSROOM_AUTH="http://127.0.0.1:9099"

ADMIN_EMAIL="admin@test.com"
ADMIN_PASSWORD="password123"
FIXED_COURSE_ID="seed-course-strategic-negotiation-01"

OWNER_HDR=(-H "Authorization: Bearer owner")

# ── [1/4] grays-com: seed the Completed instance via the real dev endpoint ──

echo "▶ [1/4] Seeding grays-com '${INSTANCE_ID}' → Completed (n=${N_STUDENTS}) via seedSimulatedGame…"
SEED_RESP=$(curl -s -X POST "${GRAYS_FUNCTIONS}/seedSimulatedGame" \
  -H "Content-Type: application/json" \
  -d "{\"game_instance_id\":\"${INSTANCE_ID}\",\"stage\":\"completed\",\"n\":${N_STUDENTS}}")
echo "  ${SEED_RESP}"
echo "${SEED_RESP}" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('ok') else 1)" \
  || { echo "✗ seedSimulatedGame did not return ok:true — aborting."; exit 1; }

# ── [2/4] classroom: ensure admin instructor + course exist (fixed IDs) ─────

echo "▶ [2/4] Ensuring classroom admin instructor + course exist…"

SIGNIN=$(curl -s -X POST \
  "${CLASSROOM_AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=test-key" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\",\"returnSecureToken\":true}")
INSTRUCTOR_UID=$(python3 -c "import sys,json; print(json.loads('''${SIGNIN}''').get('localId',''))" 2>/dev/null || true)

if [ -z "$INSTRUCTOR_UID" ]; then
  echo "  No existing ${ADMIN_EMAIL} — creating…"
  SIGNUP=$(curl -s -X POST \
    "${CLASSROOM_AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=test-key" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\",\"returnSecureToken\":true}")
  INSTRUCTOR_UID=$(python3 -c "import sys,json; print(json.loads('''${SIGNUP}''')['localId'])")
fi
echo "  → instructor uid: ${INSTRUCTOR_UID}"

curl -s -X PATCH "${CLASSROOM_FS}/instructors/${INSTRUCTOR_UID}" "${OWNER_HDR[@]}" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"instructor_id\": {\"stringValue\": \"${INSTRUCTOR_UID}\"},
      \"name\":          {\"stringValue\": \"Test Admin\"},
      \"email\":         {\"stringValue\": \"${ADMIN_EMAIL}\"},
      \"role\":          {\"stringValue\": \"admin\"},
      \"created_at\":    {\"timestampValue\": \"${FIXED_TS}\"},
      \"created_by\":    {\"nullValue\": null}
    }
  }" > /dev/null

curl -s -X PATCH "${CLASSROOM_FS}/courses/${FIXED_COURSE_ID}" "${OWNER_HDR[@]}" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"course_id\":   {\"stringValue\": \"${FIXED_COURSE_ID}\"},
      \"title\":       {\"stringValue\": \"Strategic Negotiation\"},
      \"code\":        {\"stringValue\": \"NST2026\"},
      \"description\": {\"stringValue\": \"Welcome to the course\"},
      \"mode\":        {\"stringValue\": \"standalone\"},
      \"archived\":    {\"booleanValue\": false},
      \"created_at\":  {\"timestampValue\": \"${FIXED_TS}\"}
    }
  }" > /dev/null

CI_ID="${FIXED_COURSE_ID}_${INSTRUCTOR_UID}"
curl -s -X PATCH "${CLASSROOM_FS}/course_instructors/${CI_ID}" "${OWNER_HDR[@]}" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"course_id\":     {\"stringValue\": \"${FIXED_COURSE_ID}\"},
      \"instructor_id\": {\"stringValue\": \"${INSTRUCTOR_UID}\"},
      \"role\":          {\"stringValue\": \"owner\"},
      \"invited_by\":    {\"nullValue\": null},
      \"invited_at\":    {\"timestampValue\": \"${FIXED_TS}\"}
    }
  }" > /dev/null

echo "  → course_id: ${FIXED_COURSE_ID} (Strategic Negotiation / NST2026)"

# ── [3/4] classroom: write the game_instances doc (game_id MUST be grays_com) ─

echo "▶ [3/4] Writing classroom game_instances/${INSTANCE_ID} (game_id=grays_com)…"

curl -s -X PATCH "${CLASSROOM_FS}/game_instances/${INSTANCE_ID}" "${OWNER_HDR[@]}" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"game_instance_id\": {\"stringValue\": \"${INSTANCE_ID}\"},
      \"game_id\":          {\"stringValue\": \"grays_com\"},
      \"course_id\":        {\"stringValue\": \"${FIXED_COURSE_ID}\"},
      \"session_id\":       {\"nullValue\": null},
      \"game_config_id\":   {\"nullValue\": null},
      \"title\":            {\"stringValue\": \"Grays.com Negotiation (seed test)\"},
      \"status\":           {\"stringValue\": \"completed\"},
      \"created_at\":       {\"timestampValue\": \"${FIXED_TS}\"}
    }
  }" > /dev/null

# ── [4/4] classroom: mirror grays-com participants so gradebook rows render ──

echo "▶ [4/4] Mirroring grays-com participants into classroom 'participants' (course_id=${FIXED_COURSE_ID})…"

PARTICIPANTS_TMP=$(mktemp)
trap 'rm -f "$PARTICIPANTS_TMP"' EXIT
curl -s "${GRAYS_FS}/game_instances/${INSTANCE_ID}/participants?pageSize=200" "${OWNER_HDR[@]}" -o "$PARTICIPANTS_TMP"
# NOTE: data comes from a file path argument, not stdin — `python3 -` already
# uses stdin to read this heredoc as the program source, so piping the JSON
# in via stdin here would clobber the program text instead of feeding json.load.
MIRRORED_COUNT=$(python3 - "$FIXED_COURSE_ID" "$CLASSROOM_FS" "$FIXED_TS" "$PARTICIPANTS_TMP" <<'PY'
import sys, json, urllib.request

course_id, classroom_fs, fixed_ts, participants_path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with open(participants_path) as fh:
    data = json.load(fh)
count = 0
for d in data.get("documents", []):
    f = d.get("fields", {})
    pid = f.get("participant_id", {}).get("stringValue")
    if not pid:
        continue
    name = (f.get("display_name", {}).get("stringValue")
            or f.get("name", {}).get("stringValue")
            or pid)
    body = {
        "fields": {
            "participant_id": {"stringValue": pid},
            "course_id": {"stringValue": course_id},
            "name": {"stringValue": name},
            "email": {"stringValue": ""},
            "phone": {"stringValue": ""},
            "external_id": {"stringValue": ""},
            "login_code": {"stringValue": pid.upper().replace("-", "")[:8]},
            "source": {"stringValue": "seed-gradebook-test"},
            "active": {"booleanValue": True},
            "created_at": {"timestampValue": fixed_ts},
        }
    }
    req = urllib.request.Request(
        f"{classroom_fs}/participants/{pid}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer owner"},
        method="PATCH",
    )
    urllib.request.urlopen(req).read()
    count += 1
print(count)
PY
)
echo "  → mirrored ${MIRRORED_COUNT} participant docs"

# ── Summary ───────────────────────────────────────────────────────────────

echo
echo "✓ Done."
echo "  Instance ID: ${INSTANCE_ID}"
echo "  grays-com  (Firestore :8081, project ${GRAYS_PROJECT}):"
echo "    game_instances/${INSTANCE_ID} — Completed stage, ${N_STUDENTS} participants via seedSimulatedGame"
echo "  classroom  (Firestore :8080, project ${CLASSROOM_PROJECT}):"
echo "    game_instances/${INSTANCE_ID} — game_id=grays_com, course_id=${FIXED_COURSE_ID}"
echo "    courses/${FIXED_COURSE_ID} — Strategic Negotiation (NST2026), instructor ${INSTRUCTOR_UID} (${ADMIN_EMAIL})"
echo "    participants/* — ${MIRRORED_COUNT} mirrored from grays-com so gradebook rows show names"
