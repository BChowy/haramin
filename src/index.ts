interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ASSEMBLYAI_API_KEY: string;
  ASSEMBLYAI_LLM_MODEL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
}

type Json = Record<string, unknown>;

const TARGET_LANGUAGES: Record<string, string> = {
  en: "English",
  ur: "Urdu",
  id: "Indonesian",
  fr: "French",
  tr: "Turkish",
  ms: "Malay",
  bn: "Bengali",
  fa: "Persian",
  ha: "Hausa",
  sw: "Swahili",
  ru: "Russian",
  es: "Spanish",
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function visitorId(request: Request, url: URL): string | null {
  const value = request.headers.get("x-visitor-id") || url.searchParams.get("visitor_id");
  return value && /^[a-zA-Z0-9_-]{12,100}$/.test(value) ? value : null;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}

async function readBody(request: Request): Promise<Json> {
  try {
    return (await request.json()) as Json;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function lessonExists(env: Env, lessonId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare("SELECT 1 FROM lessons WHERE id = ?").bind(lessonId).first());
}

async function translate(env: Env, text: string, targetLanguage: string): Promise<string> {
  const targetName = TARGET_LANGUAGES[targetLanguage];
  if (!targetName) throw new Error("Unsupported target language");
  const messages = [
    {
      role: "system",
      content: `Translate Arabic religious lesson transcripts into ${targetName}. Return only the faithful translation, without commentary or a preamble. Preserve names and honorifics.`,
    },
    { role: "user", content: text },
  ];
  const useDeepSeek = Boolean(env.DEEPSEEK_API_KEY);
  const response = await fetch(
    useDeepSeek
      ? "https://api.deepseek.com/chat/completions"
      : "https://llm-gateway.assemblyai.com/v1/chat/completions",
    {
    method: "POST",
    headers: {
      authorization: useDeepSeek ? `Bearer ${env.DEEPSEEK_API_KEY}` : env.ASSEMBLYAI_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: useDeepSeek
        ? env.DEEPSEEK_MODEL || "deepseek-flash"
        : env.ASSEMBLYAI_LLM_MODEL || "alibaba/qwen3.5-4b-32k-fast",
      ...(useDeepSeek ? { thinking: { type: "disabled" } } : {}),
      temperature: 0,
      max_tokens: 1000,
      messages,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `${useDeepSeek ? "DeepSeek" : "AssemblyAI"} translation failed (${response.status}): ${detail.slice(0, 300)}`,
    );
  }
  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const translated = result.choices?.[0]?.message?.content?.trim();
  if (!translated) throw new Error(`${useDeepSeek ? "DeepSeek" : "AssemblyAI"} returned an empty translation`);
  return translated;
}

async function createSession(
  env: Env,
  lessonId: string,
  visitor: string,
  targetLanguage: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO live_sessions (id, lesson_id, visitor_id, target_language) VALUES (?, ?, ?, ?)",
  )
    .bind(id, lessonId, visitor, targetLanguage)
    .run();
  return id;
}

async function persistFinalTurn(
  env: Env,
  sessionId: string,
  lessonId: string,
  targetLanguage: string,
  message: Json,
): Promise<{ segmentId: string; text: string; translatedText: string; startMs: number; endMs: number }> {
  const text = String(message.transcript || "").trim();
  if (!text) throw new Error("Empty final transcript");
  const turnOrder = Number(message.turn_order ?? Date.now());
  const words = Array.isArray(message.words) ? (message.words as Json[]) : [];
  const startMs = Number(words[0]?.start ?? message.audio_start ?? 0);
  const endMs = Number(words.at(-1)?.end ?? message.audio_end ?? startMs);
  const segmentId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO transcript_segments
      (id, session_id, lesson_id, turn_order, source_language, text, start_ms, end_ms)
     VALUES (?, ?, ?, ?, 'ar', ?, ?, ?)`,
  )
    .bind(segmentId, sessionId, lessonId, turnOrder, text, startMs, endMs)
    .run();

  const stored = await env.DB.prepare(
    "SELECT id, text, start_ms, end_ms FROM transcript_segments WHERE session_id = ? AND turn_order = ?",
  )
    .bind(sessionId, turnOrder)
    .first<{ id: string; text: string; start_ms: number; end_ms: number }>();
  if (!stored) throw new Error("Unable to persist transcript segment");

  const existing = await env.DB.prepare(
    "SELECT text FROM translations WHERE segment_id = ? AND target_language = ?",
  )
    .bind(stored.id, targetLanguage)
    .first<{ text: string }>();
  const translatedText = existing?.text || (await translate(env, stored.text, targetLanguage));
  if (!existing) {
    await env.DB.prepare(
      "INSERT INTO translations (id, segment_id, target_language, text) VALUES (?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), stored.id, targetLanguage, translatedText)
      .run();
  }
  return {
    segmentId: stored.id,
    text: stored.text,
    translatedText,
    startMs: stored.start_ms,
    endMs: stored.end_ms,
  };
}

async function openLiveSession(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return error("WebSocket upgrade required", 426);
  }
  if (!env.ASSEMBLYAI_API_KEY) return error("AssemblyAI is not configured", 503);
  const lessonId = url.searchParams.get("lesson_id") || "";
  const targetLanguage = url.searchParams.get("target_language") || "";
  const visitor = visitorId(request, url);
  if (!validId(lessonId) || !(targetLanguage in TARGET_LANGUAGES) || !visitor) {
    return error("Invalid lesson, target language, or visitor ID");
  }
  if (!(await lessonExists(env, lessonId))) return error("Lesson not found", 404);

  const tokenResponse = await fetch("https://streaming.assemblyai.com/v3/token?expires_in_seconds=60", {
    headers: { authorization: env.ASSEMBLYAI_API_KEY },
  });
  if (!tokenResponse.ok) return error("Unable to authorize transcription", 502);
  const tokenResult = (await tokenResponse.json()) as { token?: string };
  if (!tokenResult.token) return error("AssemblyAI did not return a streaming token", 502);

  const sessionId = await createSession(env, lessonId, visitor, targetLanguage);
  const upstreamUrl = new URL("wss://streaming.assemblyai.com/v3/ws");
  upstreamUrl.searchParams.set("sample_rate", "16000");
  upstreamUrl.searchParams.set("encoding", "pcm_s16le");
  upstreamUrl.searchParams.set("speech_model", "universal-3-6-pro");
  upstreamUrl.searchParams.set("language_code", "ar");
  upstreamUrl.searchParams.set("min_turn_silence", "300");
  upstreamUrl.searchParams.set("max_turn_silence", "1200");
  upstreamUrl.searchParams.set("token", tokenResult.token);

  const upstream = new WebSocket(upstreamUrl.toString());
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  let upstreamReady = false;
  let intentionallyClosed = false;

  const send = (payload: unknown) => {
    try {
      server.send(JSON.stringify(payload));
    } catch {
      // The attendee has already left the page.
    }
  };

  upstream.addEventListener("open", () => {
    upstreamReady = true;
    send({ type: "ready", sessionId });
  });

  upstream.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: Json;
    try {
      message = JSON.parse(event.data) as Json;
    } catch {
      return;
    }
    if (message.type === "Begin") {
      ctx.waitUntil(
        env.DB.prepare(
          "UPDATE live_sessions SET assemblyai_session_id = ?, status = 'active' WHERE id = ?",
        )
          .bind(String(message.id || ""), sessionId)
          .run(),
      );
      return;
    }
    if (message.type === "Error") {
      console.error("AssemblyAI stream error", {
        sessionId,
        error: message.error,
        message: message.message,
        code: message.code,
      });
      send({
        type: "error",
        message: String(message.error || message.message || "تعذّر إرسال الصوت إلى خدمة التفريغ."),
      });
      return;
    }
    if (message.type !== "Turn") return;
    const transcript = String(message.transcript || "").trim();
    if (!message.end_of_turn) {
      send({ type: "interim", text: transcript });
      return;
    }
    if (!transcript) return;
    send({ type: "finalizing", text: transcript });
    ctx.waitUntil(
      persistFinalTurn(env, sessionId, lessonId, targetLanguage, message)
        .then((result) => send({ type: "final", ...result, targetLanguage }))
        .catch((reason: unknown) => {
          console.error("Final turn failed", reason);
          const detail = reason instanceof Error ? reason.message : "";
          const needsProvider = detail.includes("does not have access to this LLM Gateway model");
          send({
            type: "translation_error",
            text: transcript,
            message: needsProvider
              ? "حساب AssemblyAI لا يتيح الترجمة. أضف مفتاح DeepSeek إلى إعدادات الخادم."
              : "تعذّرت الترجمة. تحقق من إعدادات مزود الترجمة ثم أعد المحاولة.",
          });
        }),
    );
  });

  upstream.addEventListener("error", (event) => {
    if (!intentionallyClosed) {
      console.error("AssemblyAI WebSocket error", {
        sessionId,
        eventType: event.type,
        readyState: upstream.readyState,
      });
    }
    send({ type: "error", message: "تعذّر الاتصال بخدمة التفريغ الصوتي." });
  });

  upstream.addEventListener("close", (event) => {
    const closeDetails = {
      sessionId,
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      intentionallyClosed,
    };
    if (intentionallyClosed) console.log("AssemblyAI WebSocket closed", closeDetails);
    else console.error("AssemblyAI WebSocket closed", closeDetails);
    ctx.waitUntil(
      env.DB.prepare("UPDATE live_sessions SET status = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(intentionallyClosed ? "completed" : "disconnected", sessionId)
        .run(),
    );
    send({
      type: "closed",
      reconnect: !intentionallyClosed,
      code: event.code,
      message: event.reason || "انقطع الاتصال بخدمة التفريغ الصوتي.",
    });
    try {
      server.close(1000, "Upstream closed");
    } catch {
      // Already closed.
    }
  });

  server.addEventListener("message", async (event) => {
    if (!upstreamReady) return;
    try {
      const data = event.data;
      if (typeof data === "string") {
        upstream.send(data);
      } else if (data instanceof ArrayBuffer) {
        upstream.send(data.slice(0));
      } else if (ArrayBuffer.isView(data)) {
        upstream.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      } else if (data instanceof Blob) {
        upstream.send(await data.arrayBuffer());
      } else {
        throw new Error(`Unsupported WebSocket payload: ${Object.prototype.toString.call(data)}`);
      }
    } catch {
      send({ type: "error", message: "تعذّر إرسال الصوت. حاول إعادة الاتصال." });
    }
  });

  server.addEventListener("close", () => {
    intentionallyClosed = true;
    try {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: "Terminate" }));
    } catch {
      upstream.close(1000, "Client closed");
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function transcriptHistory(env: Env, url: URL): Promise<Response> {
  const lessonId = url.searchParams.get("lesson_id") || "";
  const targetLanguage = url.searchParams.get("target_language") || "";
  if (!validId(lessonId) || !(targetLanguage in TARGET_LANGUAGES)) return error("Invalid query");
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.text, s.start_ms, s.end_ms, s.created_at, t.text AS translated_text
       FROM transcript_segments s
       JOIN translations t ON t.segment_id = s.id AND t.target_language = ?
      WHERE s.lesson_id = ?
      ORDER BY s.created_at DESC
      LIMIT 100`,
  )
    .bind(targetLanguage, lessonId)
    .all();
  return json({ segments: results.reverse() });
}

async function manualTranslation(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request);
  const lessonId = body.lesson_id;
  const targetLanguage = body.target_language;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const visitor = request.headers.get("x-visitor-id");
  if (!validId(lessonId) || typeof targetLanguage !== "string" || !(targetLanguage in TARGET_LANGUAGES)) {
    return error("Invalid lesson or language");
  }
  if (!visitor || !/^[a-zA-Z0-9_-]{12,100}$/.test(visitor)) return error("Invalid visitor ID");
  if (!text || text.length > 8000) return error("Text must be between 1 and 8000 characters");
  if (!(await lessonExists(env, lessonId))) return error("Lesson not found", 404);
  const sessionId = await createSession(env, lessonId, visitor, targetLanguage);
  const translatedText = await translate(env, text, targetLanguage);
  const segmentId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO transcript_segments
        (id, session_id, lesson_id, turn_order, source_language, text, start_ms, end_ms)
       VALUES (?, ?, ?, 0, 'ar', ?, 0, 0)`,
    ).bind(segmentId, sessionId, lessonId, text),
    env.DB.prepare(
      "INSERT INTO translations (id, segment_id, target_language, text) VALUES (?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), segmentId, targetLanguage, translatedText),
    env.DB.prepare(
      "UPDATE live_sessions SET status = 'completed', ended_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(sessionId),
  ]);
  return json({ segment: { id: segmentId, text, translated_text: translatedText } }, 201);
}

async function notesRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const visitor = visitorId(request, url);
  if (!visitor) return error("Invalid visitor ID");
  const id = url.pathname.split("/")[3] || "";

  if (request.method === "GET") {
    const lessonId = url.searchParams.get("lesson_id");
    const query = lessonId
      ? env.DB.prepare("SELECT * FROM notes WHERE visitor_id = ? AND lesson_id = ? ORDER BY updated_at DESC").bind(visitor, lessonId)
      : env.DB.prepare("SELECT * FROM notes WHERE visitor_id = ? ORDER BY updated_at DESC").bind(visitor);
    const { results } = await query.all();
    return json({ notes: results });
  }

  if (request.method === "DELETE") {
    if (!validId(id)) return error("Invalid note ID");
    await env.DB.prepare("DELETE FROM notes WHERE id = ? AND visitor_id = ?").bind(id, visitor).run();
    return new Response(null, { status: 204 });
  }

  if (request.method !== "POST" && request.method !== "PUT") return error("Method not allowed", 405);
  const body = await readBody(request);
  const lessonId = body.lesson_id;
  const noteDate = body.note_date;
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  const noteBody = typeof body.body === "string" ? body.body.trim() : "";
  const kind = body.kind === "translation" ? "translation" : "note";
  if (!validId(lessonId) || typeof noteDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(noteDate)) {
    return error("Invalid lesson or note date");
  }
  if (!noteBody || noteBody.length > 100000) return error("Note must be between 1 and 100000 characters");
  if (!(await lessonExists(env, lessonId))) return error("Lesson not found", 404);

  if (request.method === "PUT") {
    if (!validId(id)) return error("Invalid note ID");
    const result = await env.DB.prepare(
      `UPDATE notes SET lesson_id = ?, note_date = ?, title = ?, body = ?, kind = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND visitor_id = ?`,
    )
      .bind(lessonId, noteDate, title, noteBody, kind, id, visitor)
      .run();
    if (!result.meta.changes) return error("Note not found", 404);
    return json({ id });
  }

  const noteId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO notes (id, visitor_id, lesson_id, note_date, title, body, kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(noteId, visitor, lessonId, noteDate, title, noteBody, kind)
    .run();
  return json({ id: noteId }, 201);
}

async function api(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/live") return openLiveSession(request, env, ctx, url);
    if (url.pathname === "/api/transcripts" && request.method === "GET") return transcriptHistory(env, url);
    if (url.pathname === "/api/translate" && request.method === "POST") return manualTranslation(request, env);
    if (url.pathname === "/api/notes" || url.pathname.startsWith("/api/notes/")) {
      return notesRoute(request, env, url);
    }
    if (url.pathname === "/api/health") return json({ ok: true, assemblyaiConfigured: Boolean(env.ASSEMBLYAI_API_KEY) });
    return error("Not found", 404);
  } catch (reason) {
    console.error("API request failed", reason);
    const message = reason instanceof Error && reason.message === "Invalid JSON body" ? reason.message : "Internal server error";
    return error(message, message === "Invalid JSON body" ? 400 : 500);
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
