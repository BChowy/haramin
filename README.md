# مجالس الحرمين

The existing Arabic lesson site is served unchanged as Cloudflare static assets. A small Cloudflare Worker handles live Arabic transcription, translation, and persistence:

```text
Browser microphone (16 kHz mono PCM16)
  -> /api/live WebSocket (Cloudflare Worker)
  -> AssemblyAI Universal-3.6 Pro Realtime
  -> finalized Turn messages only
  -> AssemblyAI LLM Gateway translation
  -> D1 transcript_segments + translations
  -> live captions in the existing lesson profile UI
```

Interim turns are displayed but never stored or translated. Final turns are stored with lesson, session, turn order, and millisecond timestamps before their translations are saved. Notes are scoped to a stable anonymous browser visitor ID and lesson. The AssemblyAI API key is used only by the Worker.

## Local development

Requirements: Node.js 20+ and a Cloudflare account.

```bash
npm install
npx wrangler login
npx wrangler d1 create haramin
```

Copy the returned D1 `database_id` into `wrangler.toml`. Then create local secrets from the safe template:

```bash
cp .env.example .dev.vars
```

Set your real AssemblyAI key in `.dev.vars`, then initialize the local database and run the site:

```bash
npm run db:migrate:local
npm run dev
```

Open the local URL printed by Wrangler. Browser microphone access works on `localhost`; deployed environments must use HTTPS.

## D1 setup and migrations

Create the database once:

```bash
npx wrangler d1 create haramin
```

After placing its ID in `wrangler.toml`, apply migrations locally or remotely:

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

Migration `0001_live_translation_notes.sql` creates and indexes:

- `lessons`
- `live_sessions`
- `transcript_segments`
- `translations`
- `notes`

It also seeds the lesson IDs already used by the existing static UI so foreign-key validation is active from the first request.

## AssemblyAI configuration

Obtain an API key from AssemblyAI. For local development, put it only in `.dev.vars`:

```dotenv
ASSEMBLYAI_API_KEY=your_real_key
ASSEMBLYAI_LLM_MODEL=alibaba/qwen3.5-4b-32k-fast
DEEPSEEK_API_KEY=your_real_deepseek_key
DEEPSEEK_MODEL=deepseek-flash
```

For production, upload the secret through Wrangler; do not add it to `wrangler.toml` or client JavaScript:

```bash
npx wrangler secret put ASSEMBLYAI_API_KEY
npx wrangler secret put DEEPSEEK_API_KEY
```

When `DEEPSEEK_API_KEY` is configured, finalized Arabic segments are translated directly through DeepSeek using `DEEPSEEK_MODEL` (default: `deepseek-flash`). Without it, the Worker uses the AssemblyAI LLM Gateway model configured by `ASSEMBLYAI_LLM_MODEL`. Both API keys must remain Worker secrets and must never be added to browser JavaScript or committed files.

## Validation and deployment

Run all checks:

```bash
npm run lint
npm run typecheck
npm run build
```

Apply the remote migration before the first production deployment:

```bash
npm run db:migrate:remote
npx wrangler deploy
```

The Worker serves the existing `/`, `/dashboard/`, and static asset routes through its assets binding. API traffic is handled under `/api/*`.
