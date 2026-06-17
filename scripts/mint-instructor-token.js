#!/usr/bin/env node
/**
 * mint-instructor-token.js — LOCAL DEV TOOL. Never use in production.
 *
 * Mints a signed RS256 classroom JWT for local testing of instructor and
 * student launch paths. Reads the classroom private key from the monorepo;
 * the key never leaves this machine.
 *
 * Usage:
 *   node scripts/mint-instructor-token.js [options]
 *
 *   --role=instructor|student   Role embedded in the JWT (default: instructor)
 *   --instance=<uuid>           game_instance_id (default: DevLauncher seed id)
 *   --expires=<minutes>         Token lifetime in minutes (default: 240)
 *   --help                      Print this message and exit
 *
 * Prerequisites:
 *   - functions/ dependencies installed  (npm install in games/grays-com/functions/)
 *   - grays-com emulators running        (firebase emulators:start in games/grays-com/)
 *   - grays-com dev server running       (npm run dev in games/grays-com/frontend/)
 *   - DevLauncher instance seeded        (http://localhost:5173/dev-launcher)
 *
 * Examples:
 *   node scripts/mint-instructor-token.js
 *   node scripts/mint-instructor-token.js --expires=60
 *   node scripts/mint-instructor-token.js --role=student --instance=aa000000-0000-0000-0000-000000000001
 */

'use strict'

const fs   = require('fs')
const path = require('path')
const jwt  = require(path.join(__dirname, '../functions/node_modules/jsonwebtoken'))

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/mint-instructor-token.js [--role=instructor|student] [--instance=<uuid>] [--expires=<minutes>]')
  process.exit(0)
}

function getArg(name, defaultVal) {
  const match = args.find(a => a.startsWith(`--${name}=`))
  return match ? match.slice(`--${name}=`.length) : defaultVal
}

const DEFAULT_INSTANCE = 'dd000000-0000-0000-0000-000000000000'
const role        = getArg('role', 'instructor')
const instanceId  = getArg('instance', DEFAULT_INSTANCE)
const expiresMins = parseInt(getArg('expires', '240'), 10)

if (role !== 'instructor' && role !== 'student') {
  console.error(`Error: --role must be "instructor" or "student", got "${role}"`)
  process.exit(1)
}
if (Number.isNaN(expiresMins) || expiresMins <= 0) {
  console.error('Error: --expires must be a positive integer (minutes)')
  process.exit(1)
}

// ── Key ──────────────────────────────────────────────────────────────────────

const privateKeyPath = path.join(__dirname, '../../../classroom/scripts/game-jwt-private.pem')
const privateKey = fs.readFileSync(privateKeyPath, 'utf8')

// ── Payload — must match ClassroomTokenPayload in verifyToken.ts ──────────────

const uid = role === 'instructor' ? 'dev-instructor-uid' : 'dev-student-uid'
const now = Math.floor(Date.now() / 1000)

const payload = {
  iss:                    'classroom.mygames.live',
  sub:                    uid,
  iat:                    now,
  exp:                    now + expiresMins * 60,
  participant_id:         uid,
  name:                   role === 'instructor' ? 'Dev Instructor' : 'Dev Student',
  course_id:              'dev-course-001',
  session_id:             'dev-session-001',
  game_instance_id:       instanceId,
  game_config_id:         '',
  role,
  classroom_callback_url: 'https://classroom.mygames.live/api/game-results',
  callback_secret_id:     'grays_com_v1',
}

// ── Sign ──────────────────────────────────────────────────────────────────────

const token = jwt.sign(payload, privateKey, {
  algorithm: 'RS256',
  keyid:     'classroom-v1',
})

// ── Output ────────────────────────────────────────────────────────────────────

const BASE        = 'http://localhost:5173'
const TOKEN_PARAM = `token=${token}`
const ID_PARAM    = `game_instance_id=${instanceId}`

const expiresAt  = new Date((now + expiresMins * 60) * 1000)
const expiresStr = expiresAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

console.log('\n── Classroom JWT minted ──────────────────────────────────────────────────────')
console.log(`   Role      : ${role}`)
console.log(`   Instance  : ${instanceId}`)
console.log(`   Expires   : ${expiresStr}  (${expiresMins} min from now)`)
console.log('')

if (role === 'instructor') {
  console.log('Dashboard:')
  console.log(`  ${BASE}/dashboard?${TOKEN_PARAM}&${ID_PARAM}`)
  console.log('')
  console.log('Settings:')
  console.log(`  ${BASE}/settings?${TOKEN_PARAM}&${ID_PARAM}`)
} else {
  console.log('Play:')
  console.log(`  ${BASE}/play?${TOKEN_PARAM}`)
}

console.log('──────────────────────────────────────────────────────────────────────────────\n')
