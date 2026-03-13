const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const FormData = require("form-data");

const app = express();
app.use(express.json());

const CLICKUP_API_KEY   = process.env.CLICKUP_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID  = process.env.SLACK_CHANNEL_ID;
const SLACK_BOT_NAME    = process.env.SLACK_BOT_NAME || "Barrier Four";
const SLACK_BOT_ICON    = process.env.SLACK_BOT_ICON_URL;

// ── Health check ──────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("🎬 Trailer Agent running"));

// ── ClickUp webhook ───────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const { event, task_id } = req.body;
  if (event !== "taskCreated") return res.sendStatus(200);
  res.sendStatus(200);
  runPipeline(task_id).catch(console.error);
});

// ── Pipeline ──────────────────────────────────────────────────────────────
async function runPipeline(taskId) {
  console.log(`[${taskId}] Fetching ClickUp task...`);
  const task = await fetchClickUpTask(taskId);
  const brief = parseFields(task);

  console.log(`[${taskId}] Fetching SOW PDF from task comments...`);
  const sow = await fetchSOWFromComments(taskId);

  console.log(`[${taskId}] Generating 30s script...`);
  const script = await generateScript(brief, sow);

  console.log(`[${taskId}] Posting brief to ClickUp...`);
  await postClickUpComment(taskId, brief, script, sow);

  console.log(`[${taskId}] Sending Slack kickoff...`);
  await sendSlackKickoff(brief, script, sow);

  console.log(`[${taskId}] ✅ Done — ${brief.gameName}`);
}

// ── Fetch ClickUp task ────────────────────────────────────────────────────
async function fetchClickUpTask(taskId) {
  const res = await fetch(
    `https://api.clickup.com/api/v2/task/${taskId}?custom_fields=true`,
    { headers: { Authorization: CLICKUP_API_KEY } }
  );
  if (!res.ok) throw new Error(`ClickUp error: ${res.status}`);
  return res.json();
}

// ── Parse custom fields ───────────────────────────────────────────────────
function parseFields(task) {
  const cf = {};
  (task.custom_fields || []).forEach(f => { cf[f.name] = f.value || ""; });

  return {
    taskId:         task.id,
    taskUrl:        task.url,
    gameName:       task.name?.replace(/trailer mapping/i, "").trim() || task.name,
    clientName:     cf["Client Name"] || "",
    clientEmail:    cf["Email"] || "",
    studio:         cf["Client Name"] || "",
    genre:          cf["What genre best describes your game?"] || "",
    pitch:          cf["What is your game's one sentence pitch?"] || "",
    gameLink:       cf["Game Link"] || "",
    audience:       cf["Who is the desired audience for your game and the game trailer?"] || "",
    visualDos:      cf["Are there any visual do's or don'ts we should follow?"] || "",
    itemsToShow:    cf["Are there specific items the players in the trailer should be wearing?"] || "",
    locations:      cf["Are there specific locations, maps, or environments we should highlight?"] || "",
    storyBeats:     cf["Are there specific story beats or moments you want featured?"] || "",
    features:       cf["What are some of your game's unique qualities?"] || "",
    audienceFeel:   cf["How should the audience feel after watching this game trailer?"] || "",
    musicStyle:     cf["If not, what music style fits your game best?"] || cf["Does the game have its own soundtrack?"] || "",
    pacing:         cf["What pacing feels right for this trailer?"] || "",
    references:     cf["What should the pacing of the trailer be?"] || "",
    platform:       cf["Where will this trailer be used?"] || "",
    successMetrics: cf["How will you measure success for this trailer?"] || "",
    notes:          cf["Is there anything else we should know?"] || "",
  };
}

// ── Find + download SOW PDF from task comments ────────────────────────────
async function fetchSOWFromComments(taskId) {
  const res = await fetch(
    `https://api.clickup.com/api/v2/task/${taskId}/comment`,
    { headers: { Authorization: CLICKUP_API_KEY } }
  );
  if (!res.ok) throw new Error(`Comments fetch error: ${res.status}`);
  const { comments } = await res.json();

  // Find the first PDF attachment across all comments
  let pdfUrl = null, pdfName = null;
  for (const comment of (comments || [])) {
    for (const block of (comment.comment || [])) {
      if (block.type === "attachment" && block.attachment?.extension === "pdf") {
        pdfUrl  = block.attachment.url;
        pdfName = block.attachment.title;
        break;
      }
    }
    if (pdfUrl) break;
  }

  if (!pdfUrl) {
    console.warn("No SOW PDF found in task comments");
    return null;
  }

  console.log(`Found SOW: ${pdfName}`);

  // Download the PDF
  const pdfRes = await fetch(pdfUrl, { headers: { Authorization: CLICKUP_API_KEY } });
  if (!pdfRes.ok) throw new Error(`PDF download error: ${pdfRes.status}`);
  const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer()); // ← fixed for node-fetch v3
  const pdfBase64 = pdfBuffer.toString("base64");

  // Extract deliverables via Claude
  const aiRes = await callClaude({
    content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
      { type: "text", text: `Extract deliverables, package name, contract value, and deadline from this SOW/MSA.

The deliverables section typically has:
- A main deliverable title (e.g. "30-second Mixed Animation/Gameplay Trailer")
- Bullet point inclusions (e.g. "Creative concept development and storyboarding", "4K in-game capture")
- Specifications such as aspect ratios (e.g. 16:9, 1:1, 9:16)

Combine these into a clean deliverables list. Return ONLY JSON (no markdown):
{
  "docName": "document title",
  "packageName": "main deliverable title e.g. 30-second Mixed Animation/Gameplay Trailer",
  "deliverables": ["main title first, then each inclusion, then specs as one string e.g. 'Specs: 16:9, 1:1, 9:16'"],
  "totalValue": "contract value or null",
  "deadline": "final delivery date or null"
}` }
    ]
  });

  return { ...JSON.parse(aiRes.replace(/```json|```/g, "").trim()), pdfBuffer, pdfName };
}

// ── Generate script via Claude ────────────────────────────────────────────
async function generateScript(d, sow) {
  const deliverableContext = sow
    ? `Confirmed deliverables from signed SOW (${sow.docName}):\n${sow.deliverables.map(i => `- ${i}`).join("\n")}`
    : "Deliverables: see SOW";

  const res = await callClaude({
    content: `You are a world-class game trailer scriptwriter. Generate a 30-second trailer script and creative brief.

GAME: ${d.gameName}
PITCH: ${d.pitch}
GENRE: ${d.genre}
AUDIENCE: ${d.audience}
VISUAL DO'S/DON'TS: ${d.visualDos}
ITEMS TO SHOW: ${d.itemsToShow}
LOCATIONS: ${d.locations}
STORY BEATS: ${d.storyBeats}
FEATURES: ${d.features}
AUDIENCE FEEL: ${d.audienceFeel}
MUSIC: ${d.musicStyle}
PACING: ${d.pacing}
REFERENCES: ${d.references}
PLATFORM: ${d.platform}
${deliverableContext}

RULES:
- Exactly 30 seconds
- CTA must be game-specific and evocative — no platform mentions, no URLs
- CTA should make the player want to jump in and start their dream life

Return ONLY JSON (no markdown):
{
  "tagline": "punchy one-liner",
  "logline": "2-3 sentence narrative arc",
  "script": "full timestamped 30s scene-by-scene script",
  "musicDirection": "tempo, mood, style, reference tracks",
  "editingNotes": "pacing, cuts, key moments",
  "callToAction": "game-specific CTA only"
}`
  });

  return JSON.parse(res.replace(/```json|```/g, "").trim());
}

// ── Post full brief as ClickUp comment ────────────────────────────────────
async function postClickUpComment(taskId, d, s, sow) {
  const body = `🎬 GENERATED TRAILER BRIEF
==========================
Game: ${d.gameName} | Genre: ${d.genre} | Duration: 30 seconds
Client: ${d.clientName} (${d.clientEmail})

🏷 TAGLINE:
${s.tagline}

📖 LOGLINE:
${s.logline}

🎥 SCRIPT (30s):
${s.script}

🎵 MUSIC DIRECTION:
${s.musicDirection}

✂️ EDITING NOTES:
${s.editingNotes}

📣 CALL TO ACTION:
${s.callToAction}

📦 DELIVERABLES${sow ? ` (from SOW: ${sow.docName})` : ""}${sow?.totalValue ? ` · ${sow.totalValue}` : ""}:
${sow ? sow.deliverables.map(d => `• ${d}`).join("\n") : "• See SOW"}
${sow?.deadline ? `\n⏱ Deadline: ${sow.deadline}` : ""}`;

  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    method: "POST",
    headers: { Authorization: CLICKUP_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ comment_text: body, notify_all: true })
  });
  if (!res.ok) throw new Error(`Comment failed: ${res.status}`);
}

// ── Send Slack kickoff with bot identity + PDF attachment ─────────────────
async function sendSlackKickoff(d, s, sow) {
  const deliverablesList = sow
    ? sow.deliverables.map(item => `• ${item}`).join("\n")
    : "• See SOW";

  const message = `<!channel> *NEW PROJECT KICKOFF*

*Client:* ${d.clientName} / ${d.studio}
*Package:* ${sow?.packageName || sow?.docName || "See SOW"}
*Deliverables:*
${deliverablesList}
*Deadline:* ${sow?.deadline ? `${sow.deadline} — see SOW for full schedule` : "See SOW"}
*Deposit:* Pending

*Signed agreement:* attached below
*Intake form:*
${d.taskUrl}
*${d.gameName} game link:*
${d.gameLink}`;

  // Step 1: Post the message with custom bot identity
  const msgRes = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      text: message,
      username: SLACK_BOT_NAME,
      icon_url: SLACK_BOT_ICON,
    })
  });
  const msgData = await msgRes.json();
  if (!msgData.ok) throw new Error(`Slack message failed: ${msgData.error}`);

  // Step 2: Upload the SOW PDF as a reply in the same thread (new 3-step API)
  if (sow?.pdfBuffer) {
    const filename = sow.pdfName || "SOW.pdf";

    // 2a: Get upload URL
    const urlRes = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ filename, length: sow.pdfBuffer.length.toString() })
    });
    const urlData = await urlRes.json();
    if (!urlData.ok) { console.warn(`PDF upload URL failed: ${urlData.error}`); return; }

    // 2b: Upload file to the provided URL
    await fetch(urlData.upload_url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: sow.pdfBuffer
    });

    // 2c: Complete the upload and attach to thread
    const completeRes = await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ id: urlData.file_id }],
        channel_id: SLACK_CHANNEL_ID,
        thread_ts: msgData.ts
      })
    });
    const completeData = await completeRes.json();
    if (!completeData.ok) console.warn(`PDF complete failed: ${completeData.error}`);
    else console.log("SOW PDF attached to Slack thread");
  }
}

// ── Claude helper ─────────────────────────────────────────────────────────
async function callClaude({ content }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content }]
    })
  });
  const data = await res.json();
  if (!data.content) throw new Error(`Anthropic API error: ${JSON.stringify(data)}`);
  return data.content.filter(b => b.type === "text").map(b => b.text).join("");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎬 Trailer Agent running on port ${PORT}`));
