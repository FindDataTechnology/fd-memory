// Continuation-scene types and the entry gate (add-continuation-eval tasks
// 2.2/2.3): fixtures are REAL production history (sanitized) plus HUMAN-
// authored continuation task and expected-background set — the set that makes
// "re-derivation" judgeable without the judge guessing. The validator is the
// eval's door: unreviewed or undersized scene sets never run.

export interface SceneObservation {
  session_id: string;
  event: string;
  tool?: string | null;
  summary: string;
  created_at: string;
}

export interface SceneHandoff {
  id: string;
  summary: string;
  next_steps: string;
  to_agent?: string | null;
  state: "open" | "claimed" | "cancelled";
  created_at: string;
}

export interface ScenePage {
  id: string;
  kind: "fact" | "experience";
  task: string; // fact: statement
  search_keys: string[];
  solution: string;
  boundary_envs?: string;
  confidence?: number | null;
  updated_at: string;
  supersedes: string[];
}

// L1 note pages (add-chat-memory-injection): the chat lane's write-back face —
// the digest arm must prove recall of note-shaped background too, because
// notes are what person-token MCP writes actually produce.
// Reference 薄索引页（add-unified-memory-and-outputs eval 场景）：tier/tags
// 与 digest 名份车道的测量对象。
export interface SceneReference {
  id: string;
  title: string;
  summary: string;
  source_ref: string;
  tags: string[];
  tier?: string;
  updated_at?: string;
}

export interface SceneNote {
  id: string;
  title: string;
  body: string;
  updated_at: string;
}

export interface ContinueScene {
  id: string;
  source: { root: string; project: string };
  review: "pending" | "reviewed";
  boundary_at: string;
  task: string;
  expected_background: string[];
  history: {
    observations: SceneObservation[];
    handoffs: SceneHandoff[];
    pages: ScenePage[];
    references?: SceneReference[];
    notes?: SceneNote[];
  };
}

export interface SceneValidation {
  ok: boolean;
  errors: string[];
}

const MIN_SCENES = 12;
const MIN_PROJECTS = 3;
// Note scenes are part of the fixture contract (add-chat-memory-injection):
// the set must keep proving the L1 recall lane, not only L2+handoffs.
const MIN_NOTE_SCENES = 3;

export function validateScenes(scenes: ContinueScene[]): SceneValidation {
  const errors: string[] = [];
  if (!Array.isArray(scenes) || scenes.length < MIN_SCENES) {
    errors.push(`场景数 ${scenes?.length ?? 0} < ${MIN_SCENES}，不足以出裁决`);
    return { ok: false, errors };
  }
  const projects = new Set<string>();
  let noteScenes = 0;
  for (const s of scenes) {
    if (s.review !== "reviewed") errors.push(`${s.id}: review != reviewed（未脱敏复核不得进入全量）`);
    if (!s.task || s.task.trim().length < 10) errors.push(`${s.id}: 续作任务缺失或过短`);
    if (!Array.isArray(s.expected_background) || s.expected_background.length < 2) errors.push(`${s.id}: 期望背景集合 <2 条，无法判重推导`);
    const notes = s.history?.notes ?? [];
    const refs = s.history?.references ?? [];
    if (!s.history?.pages?.length && !s.history?.handoffs?.length && !notes.length && !refs.length) errors.push(`${s.id}: 前史为空（无 L2 页、交接，也无 note）`);
    if (notes.length) {
      noteScenes += 1;
      for (const n of notes) {
        if (!n.id || !n.title || !n.body || !n.updated_at) {
          errors.push(`${s.id}: note 缺 id/title/body/updated_at`);
          break;
        }
      }
    }
    if (!s.source?.project) errors.push(`${s.id}: 缺来源 project 标注`);
    else projects.add(s.source.project);
    for (const o of s.history?.observations ?? []) {
      if (!o.session_id || !o.created_at) { errors.push(`${s.id}: 观测缺 session_id/created_at`); break; }
    }
  }
  if (projects.size < MIN_PROJECTS) errors.push(`覆盖 project 数 ${projects.size} < ${MIN_PROJECTS}`);
  if (noteScenes < MIN_NOTE_SCENES) errors.push(`note 场景数 ${noteScenes} < ${MIN_NOTE_SCENES}（L1 召回面须持续受验）`);
  return { ok: errors.length === 0, errors };
}
